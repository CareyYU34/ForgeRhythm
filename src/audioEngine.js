export const SOUND_LIBRARY = [
  {
    id: "snare",
    label: "小鼓 Snare",
    url: "./sounds/38_Standard Snare 1_v1.wav",
  },
  {
    id: "kick",
    label: "大鼓 Kick",
    url: "./sounds/36_Standard Kick 3.wav",
  },
  {
    id: "hihat",
    label: "Hi-hat",
    url: "./sounds/42_Hi-Hat Closed Soft.wav",
  },
  {
    id: "none",
    label: "靜音",
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
  let masterGain = null;
  let ready = false;

  /**
   * 已排程但尚未播完的節點。
   *
   * ⚠ 只收「排程」的節點（scheduleClick），不收立即觸發的打擊音。
   *   打擊音一旦觸發就該響完，不應被暫停切斷。
   */
  const pending = new Set();

  async function loadBuffer(id, url) {
    const res = await fetch(url);
    const arr = await res.arrayBuffer();
    const buf = await audioCtx.decodeAudioData(arr);
    buffers.set(id, buf);
  }

  async function initAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: "interactive",
      });
      masterGain = audioCtx.createGain();
      masterGain.gain.value = 1; //fallback value
      masterGain.connect(audioCtx.destination);
    }

    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }

    await Promise.all(
      soundLibrary.filter((s) => s.url).map((s) => loadBuffer(s.id, s.url)),
    );

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
   * 邏輯與 playZone 相同，差別只在「用 midi 查」而非「用 zone key 查」。
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
   * 排程一顆合成 click（引導音 / 前奏跟拍回饋音）。
   *
   * 用合成音而非取樣的理由：與三個鼓組取樣在音色上完全分離，
   * 使用者不會把引導音誤認為譜面內容；且不必新增檔案。
   *
   * @param {number} when  AudioContext 時間軸上的絕對秒數
   * @param {Object} opts  { freq, gain, decayMs }
   * @returns {OscillatorNode|null} 過期則回傳 null
   *
   * ⚠ 刻意不做 Math.max(when, currentTime) 的夾限。
   *   夾限會把過期排程壓成立即發聲，讓引導音落在錯的拍點上 ——
   *   那比不發更糟。過期一律丟棄。
   *
   * ⚠ gain 的數值必須考慮 masterGain（等於 state.outputGain，預設 7）。
   *   詳見 songMode/tuning.js 的「音量定標」。
   */
  function scheduleClick(when, opts = {}) {
    if (!audioCtx || !masterGain) return null;

    const freq = opts.freq ?? 1000;
    const gain = opts.gain ?? 0.045;
    const decay = (opts.decayMs ?? 40) / 1000;

    if (when < audioCtx.currentTime) return null;

    const osc = audioCtx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, when);

    const g = audioCtx.createGain();
    // 2ms 起振避免爆音，之後指數衰減。
    // ⚠ exponentialRampToValueAtTime 的目標值不可為 0。
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(gain, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + decay);

    osc.connect(g);
    g.connect(masterGain);
    osc.start(when);
    osc.stop(when + decay + 0.01);

    track(osc);
    return osc;
  }

  /**
   * 取消所有已排程但尚未播完的 click。
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
    // ── 歌曲模式新增 ──
    playMidi,
    scheduleClick,
    cancelScheduled,
    now,
    isReady,
  };
}
