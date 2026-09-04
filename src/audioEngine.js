export const SOUND_LIBRARY = [
  {
    id: "snare",
    label: "小鼓 Snare",
    url: "./assets/sounds/38_Standard Snare 1_v1.wav",
  },
  {
    id: "kick",
    label: "大鼓 Kick",
    url: "./assets/sounds/36_Standard Kick 3.wav",
  },
  {
    id: "hihat",
    label: "Hi-hat",
    url: "./assets/sounds/42_Hi-Hat Closed Soft.wav",
  },
  {
    id: "none",
    label: "靜音",
  },
];

/**
 * 引導音取樣。
 *
 * ⚠ 絕對不可併入 SOUND_LIBRARY。
 *   那張表同時餵給 bindSoundUI 的音色選單與 MIDI_TO_SOUND_ID 查表，
 *   混進去會讓節拍器出現在使用者的鼓組選項裡。
 *
 * ⚠ buffer 也存在獨立的 cueBuffers，與鼓組的 buffers 分開，
 *   避免 playMidi 誤查到。
 *
 * 實測規格（兩檔一致）：
 *   48 kHz / 16-bit / 立體聲，檔案長 0.170 s，實際發聲僅前 51 ms
 *   峰值 −14.6 dBFS（線性 0.186）
 *   hi 主頻約 1900 Hz，能量 83% 落在 1.5–3 kHz
 *   lo 主頻約 940 Hz + 泛音，分佈較寬
 */
export const CUE_LIBRARY = [
  {
    id: "cue_hi",
    label: "引導音（重音）",
    url: "./assets/cue/metronome_hi.wav",
  },
  {
    id: "cue_lo",
    label: "引導音（一般）",
    url: "./assets/cue/metronome_lo.wav",
  },
];

// 手部觸發區固定為大腿正面；heel 由膝蓋踢擊觸發。
export const ZONES = [
  { id: "front", label: "大腿正面" },
  { id: "heel", label: "腳跟" },
];

/**
 * MIDI 音高 → SOUND_LIBRARY 的 id。
 *
 * 歌曲模式的 sequencer 回傳 MIDI 音高，需要這張表才能發聲。
 * 三個音高剛好對應既有的三個取樣，不需要新增檔案。
 */
export const MIDI_TO_SOUND_ID = {
  36: "kick",
  38: "snare",
  42: "hihat",
};

export function createDefaultZoneSound() {
  const zoneSound = {};
  for (const side of ["left", "right"]) {
    for (const z of ZONES) {
      const key = `${side}_${z.id}`;
      if (z.id === "front" && side === "left") zoneSound[key] = "hihat";
      if (z.id === "front" && side === "right") zoneSound[key] = "snare";

      if (z.id === "heel") zoneSound[key] = "kick";
    }
  }
  return zoneSound;
}

export function createAudioEngine(soundLibrary = SOUND_LIBRARY) {
  let audioCtx = null;
  const buffers = new Map();
  /** 引導音專用 buffer，與 buffers 分開 */
  const cueBuffers = new Map();

  let masterGain = null;
  /**
   * 引導音匯流排。
   *
   * ⚠ 直連 destination，刻意不經過 masterGain。
   *   引導音是「系統對使用者說話」，不該被打擊音量（state.outputGain）
   *   牽動 —— 使用者把鼓聲調小時，節拍器必須維持原音量。
   */
  let cueGain = null;
  let cueBusGain = 1;

  let ready = false;

  /**
   * 已排程但尚未播完的節點。
   *
   * ⚠ 只收「排程」的節點（scheduleCue），不收立即觸發的打擊音。
   *   打擊音一旦觸發就該響完，不應被暫停切斷。
   */
  const pending = new Set();

  async function loadInto(map, id, url) {
    const res = await fetch(encodeURI(url));
    if (!res.ok) throw new Error(`${url}（HTTP ${res.status}）`);
    const arr = await res.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(arr);
    map.set(id, buf);
  }

  async function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      });

      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1; //fallback value
      masterGain.connect(audioCtx.destination);

      cueGain = audioCtx.createGain();
      cueGain.gain.value = cueBusGain;
      cueGain.connect(audioCtx.destination);
    }

    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }

    // 鼓組與引導音平行載入，兩者皆完成才算就緒
    await Promise.all([
      ...soundLibrary
        .filter((s) => s.url)
        .map((s) => loadInto(buffers, s.id, s.url)),
      ...CUE_LIBRARY.map((c) => loadInto(cueBuffers, c.id, c.url)),
    ]);

    ready = true;
  }

  /** 排程節點的生命週期追蹤，供 cancelScheduled 使用 */
  function track(node) {
    pending.add(node);
    node.onended = () => pending.delete(node);
  }

  function playZone(side, zoneId, zoneSound) {
    if (!audioCtx || !masterGain) return;
    const key = `${side}_${zoneId}`;
    const id = zoneSound[key];
    const buf = buffers.get(id);
    if (!buf) return;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(masterGain);
    src.start(audioCtx.currentTime);
  }

  /**
   * 依 MIDI 音高立即觸發（歌曲模式的打擊用）。
   *
   * ⚠ 刻意不加入 pending —— 打擊音一旦觸發就該響完，不受暫停切斷。
   *
   * @returns {boolean} 是否成功發聲
   */
  function playMidi(midi, gain = 1) {
    if (!audioCtx || !masterGain) return false;
    const id = MIDI_TO_SOUND_ID[midi];
    const buf = id ? buffers.get(id) : null;
    if (!buf) return false;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    if (gain === 1) {
      src.connect(masterGain);
    } else {
      const g = audioCtx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(masterGain);
    }

    src.start(audioCtx.currentTime);
    return true;
  }

  /**
   * 排程一顆引導音（前導拍 / 前奏跟拍回饋音）。
   *
   * 取樣而非合成音：節拍器取樣是寬頻瞬態、能量落在 1.5–3 kHz，
   * 在有伴奏的混音裡遠比純正弦波容易聽見；且音色與三個鼓組取樣
   * 完全分離，使用者不會誤認為譜面內容。
   *
   * @param {number} when  AudioContext 時間軸上的絕對秒數
   * @param {Object} opts  { id, gain } —— gain 為 cue 匯流排內的相對值
   * @returns {AudioBufferSourceNode|null} 過期或取樣不存在則回傳 null
   *
   * ⚠ 刻意不做 Math.max(when, currentTime) 的夾限。
   *   夾限會把過期排程壓成立即發聲，讓引導音落在錯的拍點上 ——
   *   那比不發更糟。過期一律丟棄。
   */
  function scheduleCue(when, opts = {}) {
    if (!audioCtx || !cueGain) return null;

    const buf = cueBuffers.get(opts.id);
    if (!buf) return null;

    if (when < audioCtx.currentTime) return null;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    const gain = opts.gain ?? 1;
    if (gain === 1) {
      src.connect(cueGain);
    } else {
      const g = audioCtx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(cueGain);
    }

    src.start(when);

    // ⚠ 必須 track，否則 cancelScheduled 取消不到，
    //   暫停後引導音仍會照原定時刻響出來。
    track(src);
    return src;
  }

  /**
   * 取消所有已排程但尚未播完的引導音。
   *
   * ⚠ 暫停與 seek 時必須呼叫。AudioContext 的時間軸不會因為影片暫停
   *   而停止 —— 不取消的話，暫停後引導音仍會照原定時刻響出來。
   */
  function cancelScheduled() {
    for (const node of pending) {
      try {
        node.stop();
      } catch {
        /* 已停止 */
      }
    }
    pending.clear();
  }

  function setOutputVolume(gainValue = 1) {
    if (!masterGain) return;
    masterGain.gain.value = Math.max(0, gainValue);
  }

  /** 引導音匯流排總增益。與 setOutputVolume 完全獨立。 */
  function setCueVolume(gainValue = 1) {
    cueBusGain = Math.max(0, gainValue);
    if (cueGain) cueGain.gain.value = cueBusGain;
  }

  /** 目前的 AudioContext 時間（秒） */
  function now() {
    return audioCtx ? audioCtx.currentTime : 0;
  }

  function isReady() {
    return ready;
  }

  return {
    initAudio,
    playZone,
    setOutputVolume,
    // ── 歌曲模式 ──
    playMidi,
    scheduleCue,
    setCueVolume,
    cancelScheduled,
    now,
    isReady,
  };
}
