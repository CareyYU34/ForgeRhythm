import { perfLog } from "./poseEngine/perfLog.js";

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

/**
 * 分部模式（partSession）背景用的額外鼓組取樣。
 *
 * ⚠ 絕對不可併入 SOUND_LIBRARY。
 *   SOUND_LIBRARY 同時餵給自由模式的鼓組選單（bindSoundUI）。混進去會讓
 *   這幾個「只給歌曲背景用」的音色出現在使用者的鼓組選項裡。
 *
 * ⚠ 但 buffer 與 SOUND_LIBRARY 共用同一個 buffers Map —— playMidi /
 *   scheduleMidi 都靠 MIDI_TO_SOUND_ID → buffers 查表，兩者的 buffer
 *   必須在同一個 map 才查得到（這點與 CUE_LIBRARY 的獨立 cueBuffers 不同：
 *   引導音要與鼓組發聲路徑完全隔離，鼓組取樣則同屬一條發聲路徑）。
 */
export const SONG_DRUM_LIBRARY = [
  { id: "cross_stick", label: "Cross Stick", url: "./assets/sounds/37_Cross-stick.wav" },
  {
    id: "pedal",
    label: "Pedal Hi-Hat",
    url: "./assets/sounds/44_Hi-Hat Pedal.wav",
  },
  {
    id: "ride",
    label: "Ride Cymbal",
    url: "./assets/sounds/51_59_Ride Cymbal.wav",
  },
  {
    id: "crash",
    label: "Crash Cymbal",
    url: "./assets/sounds/49_57_Crash Cymbal.wav",
  },
];

// 手部觸發區固定為大腿正面；heel 由膝蓋踢擊觸發。
export const ZONES = [
  { id: "front", label: "大腿正面" },
  { id: "heel", label: "腳跟" },
];

/**
 * MIDI 音高 → 鼓組取樣 id（SOUND_LIBRARY 或 SONG_DRUM_LIBRARY 皆可）。
 *
 * 歌曲模式的 sequencer 與背景排程器都回傳 MIDI 音高，需要這張表才能發聲。
 *   36/38/42 為原本的月亮 song mode 三音，走 SOUND_LIBRARY；
 *   37/44/51 為分部模式（中南美）新增，走 SONG_DRUM_LIBRARY；
 *   49 為節奏循環模式（grooveMode）過門用，同樣走 SONG_DRUM_LIBRARY。
 *
 * ⚠ 取樣 id 與 grooveMode/grooveTable.js 的 SOUNDS 音名一致（含大小寫），
 *   新增音色時兩邊用同一個名字。
 */
export const MIDI_TO_SOUND_ID = {
  36: "kick",
  38: "snare",
  42: "hihat",
  37: "cross_stick",
  44: "pedal",
  49: "crash",
  51: "ride",
};

/**
 * 歌曲模式「部位配對」：哪些鼓聲要求用膝蓋（heel）觸發。
 *
 * 大鼓（kick）刻意限膝蓋，其餘（snare / hihat）限手部（front）——
 * 讓身體打擊與鼓組在物理上對應，而不是「打哪裡都推進下一顆」。
 *
 * ⚠ 這是「膝蓋 → kick」對應的唯一來源，與 zoneSound 的自由模式對應無關。
 *   若日後想讓別的音也限膝蓋，只需在這裡加 id。
 */
export const KNEE_SOUND_IDS = new Set(["kick"]);

/**
 * 某個 MIDI 音高在部位配對下是否要求用膝蓋觸發。
 * 查不到對應鼓聲（不在 MIDI_TO_SOUND_ID）時視為「不要求膝蓋」。
 */
export function midiRequiresKnee(midi) {
  return KNEE_SOUND_IDS.has(MIDI_TO_SOUND_ID[midi]);
}

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

  /**
   * 背景分部匯流排（分部模式）。
   *
   * ⚠ 與 masterGain 分開，語意同 cueGain：背景是「系統在放伴奏」，
   *   不該被使用者的打擊音量（state.outputGain → masterGain）牽動 ——
   *   使用者把自己的打擊調小時，背景伴奏必須維持原音量。
   */
  let backingGain = null;
  let backingBusGain = 1;

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

      backingGain = audioCtx.createGain();
      backingGain.gain.value = backingBusGain;
      backingGain.connect(audioCtx.destination);
    }

    if (audioCtx.state === "suspended") {
      await audioCtx.resume().catch(() => {});
    }

    // 鼓組（含分部模式的額外鼓組）與引導音平行載入，全部完成才算就緒。
    // ⚠ SONG_DRUM_LIBRARY 與 soundLibrary 同載入 buffers（同一條發聲路徑），
    //   但不進 SOUND_LIBRARY，故不會出現在自由模式的鼓組選單。
    await Promise.all([
      ...soundLibrary
        .filter((s) => s.url)
        .map((s) => loadInto(buffers, s.id, s.url)),
      ...SONG_DRUM_LIBRARY.map((s) => loadInto(buffers, s.id, s.url)),
      ...CUE_LIBRARY.map((c) => loadInto(cueBuffers, c.id, c.url)),
    ]);

    ready = true;
  }

  /**
   * 診斷：記下打擊聲「何時真正從喇叭出來」，掛到 perfLog 當前派發中的那一擊。
   * 只在 perfLog 錄製中才計算；非打擊派發期（節拍器等）perfLog 會自己忽略。
   *
   *   outT    以 getOutputTimestamp() 換算：該 context 時刻對應的實際輸出時間
   *   outEstT 呼叫時間 + baseLatency + outputLatency（瀏覽器不給 timestamp 時的備案）
   *
   * @param {string} kind  "zone" | "midi" | "cue"
   * @param {number} when  src.start() 的 AudioContext 秒數
   */
  function noteHitSound(kind, when) {
    if (!perfLog.isActive()) return;
    const callT = performance.now();
    const baseMs = (audioCtx.baseLatency ?? 0) * 1000;
    const outMs = (audioCtx.outputLatency ?? 0) * 1000;
    let outT = null;
    const ts = audioCtx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0) {
      // ⚠ start(t) 的 t 若已過去，實際在下一個 render quantum 才開始，取兩者較晚者
      const startCtx = Math.max(when, audioCtx.currentTime);
      outT = ts.performanceTime + (startCtx - ts.contextTime) * 1000;
    }
    perfLog.noteSound({
      kind,
      callT,
      outT,
      outEstT: callT + Math.max(0, (when - audioCtx.currentTime) * 1000) + baseMs + outMs,
      baseLatencyMs: Math.round(baseMs * 10) / 10,
      outputLatencyMs: Math.round(outMs * 10) / 10,
      ctxState: audioCtx.state,
    });
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
    noteHitSound("zone", audioCtx.currentTime);
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
    noteHitSound("midi", audioCtx.currentTime);
    return true;
  }

  /**
   * 依 MIDI 音高在絕對音訊時刻排程發聲（分部模式的背景伴奏用）。
   *
   * 與 playMidi 的差異：
   *   - 走 backingGain 匯流排（不受使用者打擊音量牽動）。
   *   - 在 when（AudioContext 絕對秒數）觸發，不是立即。
   *   - ⚠ 必須 track() 進 pending，否則暫停 / seek 時 cancelScheduled
   *     取消不到，背景會照原定時刻繼續響出來（與引導音同理）。
   *
   * ⚠ 過期（when < now）一律丟棄、不夾限。夾限會把過期音壓成立即發聲、
   *   落在錯的拍點上 —— 與 scheduleCue 的取捨一致。
   *
   * @param {number} midi
   * @param {number} when AudioContext 時間軸上的絕對秒數
   * @param {number} [gain=1]
   * @returns {AudioBufferSourceNode|null}
   */
  function scheduleMidi(midi, when, gain = 1) {
    if (!audioCtx || !backingGain) return null;
    const id = MIDI_TO_SOUND_ID[midi];
    const buf = id ? buffers.get(id) : null;
    if (!buf) return null;
    if (when < audioCtx.currentTime) return null;

    const src = audioCtx.createBufferSource();
    src.buffer = buf;

    if (gain === 1) {
      src.connect(backingGain);
    } else {
      const g = audioCtx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(backingGain);
    }

    src.start(when);
    track(src);
    return src;
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
    // 打擊路徑上的提示音（前奏期 / 部位不符）也記；HUD loop 排的節拍器不在派發期，perfLog 會忽略
    noteHitSound("cue", when);

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

  /** 背景分部匯流排總增益。與 setOutputVolume / setCueVolume 完全獨立。 */
  function setBackingVolume(gainValue = 1) {
    backingBusGain = Math.max(0, gainValue);
    if (backingGain) backingGain.gain.value = backingBusGain;
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
    scheduleMidi,
    scheduleCue,
    setCueVolume,
    setBackingVolume,
    cancelScheduled,
    now,
    isReady,
  };
}
