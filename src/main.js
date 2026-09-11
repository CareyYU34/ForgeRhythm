import {
  bindCameraToggle,
  bindSoundUI,
  initSettingsPanel,
} from "./ui.js";
import {
  createAudioEngine,
  createDefaultZoneSound,
  SOUND_LIBRARY,
  ZONES,
} from "./audioEngine.js";
import {
  getVideoDrawRect,
  startWebcam,
  stopWebcam,
  syncCanvasToCameraFrame,
} from "./camera.js";
import {
  createInitialPoseState,
  createPredictWebcam,
  resetPoseState,
} from "./poseEngine/poseLoop.js";
import {
  initMidiLibraryPicker,
  initYouTube,
  getActiveTransport,
  setActiveTransport,
} from "./mediaPanel.js";
import { createPoseLandmarker } from "./poseEngine/Mediapipe/poseLandmarker.js";
import { createCalibrationEngine } from "./poseEngine/calibration.js";
import { buildCalibrationProfile } from "./poseEngine/calibrationProfile.js";
import { createAdaptiveMonitor } from "./poseEngine/adaptiveMonitor.js";

// ── 歌曲模式 ──
import { SONG_LIBRARY } from "./songMode/manifest.js";
import { TUNING } from "./songMode/tuning.js";
import { createSongUI } from "./songMode/songUI.js";
import { createSongSession } from "./songMode/songSession.js";
import { createHitRouter } from "./songMode/hitRouter.js";

const video = document.getElementById("webcam");
const canvas = document.getElementById("output");
const canvasCtx = canvas.getContext("2d");
const button = document.getElementById("toggle");
const frameEl = document.querySelector(".camera-frame");
const rackEl = document.getElementById("soundRack");
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const calibrateBtn = document.getElementById("calibrateBtn");

// ── 校準 Overlay 元素 ──
const calibOverlay = document.getElementById("calibOverlay");
const calibCancelBtn = document.getElementById("calibCancelBtn");
const calibScreenReady = document.getElementById("calibScreenReady");
const calibScreenZone = document.getElementById("calibScreenZone");
const calibScreenDone = document.getElementById("calibScreenDone");
const calibCountdownNum = document.getElementById("calibCountdownNum");
const calibReadyText = document.getElementById("calibReadyText");
const calibZoneLabel = document.getElementById("calibZoneLabel");
const calibStrikeProgress = document.getElementById("calibStrikeProgress");
const calibProgressFill = document.getElementById("calibProgressFill");
const calibStrikeCounter = document.getElementById("calibStrikeCounter");
const calibVisualImg = document.getElementById("calibVisualImg");

// ── 各階段示範圖片（檔案放在 public/ 資料夾） ──
const CALIB_VISUALS = {
  front_snapshot: "src/public/靜正面.png",
  outer_snapshot: "src/public/靜側面.png",
  right_front: "src/public/右正面.gif",
  left_front: "src/public/左正面.gif",
  right_outer: "src/public/右側面.gif",
  left_outer: "src/public/左側面.gif",
};

/** GIF 需要先清空 src 再賦值，才能從頭播放 */
function setCalibVisual(key) {
  const src = CALIB_VISUALS[key] ?? "";
  calibVisualImg.src = "";
  calibVisualImg.src = src;
}

const ZONE_LABEL_MAP = {
  right_front: "右大腿正面",
  left_front: "左大腿正面",
  right_outer: "右大腿外側",
  left_outer: "左大腿外側",
};

// ── 校準 Overlay 控制 ────────────────────────────────────────────────────────

function showCalibScreen(id) {
  [calibScreenReady, calibScreenZone, calibScreenDone].forEach((el) => {
    el.classList.toggle("is-hidden", el.id !== id);
  });
  // DONE 畫面時隱藏圖片區
  calibOverlay.classList.toggle("is-done", id === "calibScreenDone");
}

function updateCalibProgress(strikeCount, strikesPerZone) {
  const pct = strikesPerZone > 0 ? (strikeCount / strikesPerZone) * 100 : 0;
  calibProgressFill.style.width = `${pct}%`;
  calibStrikeCounter.textContent = `${strikeCount} / ${strikesPerZone}`;
}

function onCalibStatus({
  phase,
  zone,
  strikeCount,
  strikesPerZone,
  countdown,
}) {
  const PHASES = calibration.PHASES;

  if (phase === PHASES.IDLE) {
    calibOverlay.classList.add("is-hidden");
    calibrateBtn.classList.remove("is-active");
    calibrateBtn.innerHTML = '<i class="fas fa-crosshairs"></i> 校準';
    return;
  }

  calibOverlay.classList.remove("is-hidden");

  if (phase === PHASES.FRONT_SNAPSHOT) {
    setCalibVisual("front_snapshot");
    showCalibScreen("calibScreenReady");
    calibCountdownNum.textContent = countdown ?? "";
    calibReadyText.textContent = "請將雙手自然放在大腿正面上";
    return;
  }

  if (phase === PHASES.OUTER_SNAPSHOT) {
    setCalibVisual("outer_snapshot");
    showCalibScreen("calibScreenReady");
    calibCountdownNum.textContent = countdown ?? "";
    calibReadyText.textContent = "請將雙手自然放在大腿側面上";
    return;
  }

  if (phase === PHASES.STRIKING) {
    if (strikeCount === 0) setCalibVisual(zone); // zone 切換時重播 GIF
    showCalibScreen("calibScreenZone");
    calibZoneLabel.textContent = `打擊 ${ZONE_LABEL_MAP[zone] ?? zone}`;
    updateCalibProgress(strikeCount, strikesPerZone);
    return;
  }

  if (phase === PHASES.DONE) {
    showCalibScreen("calibScreenDone");
    setTimeout(() => {
      calibOverlay.classList.add("is-hidden");
      calibrateBtn.classList.remove("is-active");
      calibrateBtn.innerHTML = '<i class="fas fa-crosshairs"></i> 校準';
    }, 1500);
    return;
  }
}

const state = {
  running: true,
  stream: null,
  poseLandmarker: null,
  outputGain: 7, // 預設輸出音量，範圍 0-10，對應 audio engine 中 0-1 的增益值
  // 歌曲模式「部位配對」模式（僅影響歌曲模式）：
  //   "off"      預設 —— 任何部位都推進下一顆（不要求手/腳對應）
  //   "standard" 大鼓限膝蓋、其餘限手部
  //   "allKnee"  全部音符都限膝蓋
  limbMode: "off",
  // 歌曲模式難度：「basic」預設（四分，只吃四分位置音符）／
  // 「advanced」進階（八分，吃全部音符）。於載入譜面時套用，
  // 播放中切換需重新選歌才生效。
  songDifficulty: "basic",
  ...createInitialPoseState(), // 包含 poseLoop 需要的初始狀態
};

const zoneSound = createDefaultZoneSound();

// ⚠ 必須保留整個 audioEngine 物件 ——
//   歌曲模式需要 playMidi / scheduleCue / cancelScheduled / now / isReady。
//   原本的解構寫法會讓這些方法拿不到。
const audioEngine = createAudioEngine(SOUND_LIBRARY);
const { initAudio, playZone, setOutputVolume } = audioEngine;

setOutputVolume(state.outputGain);

// ⚠ 引導音走獨立匯流排，與 outputGain 完全脫鉤。
//   使用者把打擊音量調小時，節拍器必須維持原音量。
audioEngine.setCueVolume(TUNING.CUE_BUS_GAIN);

const getRect = () => getVideoDrawRect({ video, canvas });
const syncCanvas = () => syncCanvasToCameraFrame({ frameEl, canvas });
const getPoseLandmarker = () => state.poseLandmarker;

// ── 校準引擎 ──
const calibration = createCalibrationEngine({ onStatusChange: onCalibStatus });

// ── 自適應監控引擎 ──
const monitor = createAdaptiveMonitor({ state });

// ── 歌曲模式 ────────────────────────────────────────────────────────────────
//
// ⚠ 建立順序：songUI → session → router，且必須在 createPredictWebcam 之前，
//   因為 router.route 要當作 playZone 參數注入。

const songUI = createSongUI({
  // 音符圖示需知道當前部位配對模式：allKnee 時全顯示腳
  getLimbMode: () => state.limbMode,
});

const songSession = createSongSession({
  state,
  audio: audioEngine,
  getTransport: getActiveTransport,
  setTransport: setActiveTransport,
  songUI,
  onNotice: (msg) => console.warn("[songMode]", msg),
});

const hitRouter = createHitRouter({
  session: songSession,
  audio: audioEngine,
  freePlayZone: playZone, // 自由模式仍走原本的 zoneSound 查表
  songUI,
  getTransport: getActiveTransport,
  // 讀取當下設定（可在遊玩中切換，故用 getter 而非快照）
  getLimbMode: () => state.limbMode,
});

const predictWebcam = createPredictWebcam({
  video,
  canvas,
  canvasCtx,
  state,
  getVideoDrawRect: getRect,
  getPoseLandmarker,
  // ⚠ 這是整個整合的唯一接點。
  //   簽章與 playZone 完全一致，因此 poseEngine/ 一行都不用改。
  playZone: hitRouter.route,
  zoneSound,
  // 每幀 pose callback 裡會呼叫這個，把 landmarks 餵給校準引擎與監控引擎
  onFrame: (poseLandmarks, nowMs) => {
    calibration.feedFrame(poseLandmarks, nowMs);

    // ── 監控引擎每幀更新 ──
    monitor.feedFrame(poseLandmarks, nowMs);

    // 校準完成時：建立正式 profile 並重置監控狀態
    if (calibration.getPhase() === calibration.PHASES.DONE) {
      const session = calibration.getSession();
      if (session && !state._calibrationLogged) {
        state._calibrationLogged = true;
        console.log("[main] 校準完成，session:", session);

        // ── 建立動態參數 profile 並注入 state ──
        const profile = buildCalibrationProfile(session);
        state.calibrationProfile = profile;
        console.log("[main] 動態參數 profile:", profile);

        if (profile && profile.warnings.length > 0) {
          console.warn("[main] 校準品質警告：", profile.warnings);
        }

        // ── 通知監控引擎重置（以正式 profile 重新初始化低谷追蹤器）──
        monitor.reset();

        // 還原校準按鈕
        calibrateBtn.classList.remove("is-active");
        calibrateBtn.innerHTML = '<i class="fas fa-crosshairs"></i> 校準';
      }
    }
  },
});

const startCam = () => {
  // ⚠ 每次開鏡頭都重啟監控引擎，語意等同「重新開網頁」：
  //   start() 內部會 initTrackers() 重置追蹤器並重建冷啟動 / 可見度定時器。
  //   與 stopCam 的 monitor.stop() 對稱，避免關鏡頭後兩個定時器停擺。
  monitor.start();
  return startWebcam({
    video,
    state,
    startPredictLoop: predictWebcam,
    syncCanvas,
    initAudio,
  });
};

const stopCam = () => {
  // ⚠ 關鏡頭 = 沒有觸發源，歌曲模式必須一併退出，
  //   否則會留下「影片在播但打什麼都沒反應」的狀態。
  songSession.exit("camera-off");
  monitor.stop();
  stopWebcam({
    video,
    canvasCtx,
    state,
    resetPoseState: () => resetPoseState(state),
  });
};

// ─── HUD 迴圈 ───────────────────────────────────────────────────────────────
//
// ⚠ 刻意獨立於 poseLoop 的 rAF 迴圈。
//   那條迴圈綁在鏡頭上、職責是姿態偵測，不應該塞入 HUD 更新。
//
// 本迴圈做三件事：
//   1. 區塊對齊（唯一的每幀時間錨點）
//   2. 前導倒數
//   3. 節拍格線的換頁與指針
//
// 發聲路徑完全在事件驅動的 hitRouter.route 裡，不經過這裡 ——
// 但 route 也會呼叫一次 syncBlock，用來消除本迴圈 16 ms 空窗造成的競態。

function hudLoop() {
  requestAnimationFrame(hudLoop);
  if (!songSession.isPlaying()) return;

  const transport = getActiveTransport();
  if (!transport) return;

  const tMs = transport.getCurrentTime() * 1000;

  // ⚠ 對齊必須在讀取 sequencer 狀態之前，
  //   否則這一幀畫出來的格線會是對齊前的舊游標。
  if (songSession.syncBlock(tMs)) {
    songUI.invalidateBlock();
  }

  // 倒數自行依時間決定顯示 / 隱藏 / 「開始」，不受階段切換控制
  songUI.updateCountdown(tMs);

  const barGrid = songSession.getBarGrid();
  const chart = songSession.getChart();
  const sequencer = songSession.getSequencer();
  if (!barGrid || !chart || !sequencer) return;

  // ── 鼓面在播放一開始就出現 ──────────────────────────────────────────────
  //
  // 前奏 count-in 期間也顯示格線（先擺出第一小節），但「不跑」：
  //   - syncBlock 在第一顆 onset 前一律返回 false → 游標不推進、不對齊
  //   - 打擊被 hitRouter 的前奏閘門擋住 → 不吃掉譜面
  //   - updateBlockHead 的指針百分比夾限在 [0,100] → 停在最左，
  //     直到播放時間真正進入該小節才開始移動
  // 這樣「鼓面先出現、等對的時間才正常跑」兩件事同時成立。
  songUI.showRibbonPhase();

  const firstOnsetMs = songSession.getFirstOnsetMs();
  const blockIdx =
    tMs < firstOnsetMs
      ? barGrid.blockIndexAt(firstOnsetMs) // 前奏期固定先顯示第一小節
      : barGrid.blockIndexAt(tMs + TUNING.BLOCK_FLIP_LEAD_MS);

  songUI.ensureBlock({ chart, barGrid, blockIdx, sequencer });
  songUI.updateBlockHead(tMs, barGrid, blockIdx);
}

async function bootstrap() {
  // ⚠ beforeLoad：按下 YT「載入」時先退出歌曲模式。
  //   兩者共用 player-card，不退出會讓 transport 被覆寫而留下孤兒排程。
  initYouTube({ beforeLoad: () => songSession.exit("switch") });
  initMidiLibraryPicker();

  // ── 歌曲清單 ──
  songUI.renderLibrary(SONG_LIBRARY, (song) => songSession.enter(song));
  songUI.bindExit(() => songSession.exit("manual"));

  state.poseLandmarker = await createPoseLandmarker(state.runningMode);

  bindSoundUI({
    rackEl,
    soundLibrary: SOUND_LIBRARY,
    zones: ZONES,
    zoneSound,
  });

  // 設定工具面板
  initSettingsPanel({
    toggleBtn: settingsToggle,
    panelEl: settingsPanel,
    outputGain: state.outputGain,
    visibilityThreshold: state.visibilityThreshold,
    limbMode: state.limbMode,
    advancedDifficulty: state.songDifficulty === "advanced",
    playbackSpeed: document.getElementById("playbackSpeed")?.value ?? "1",
    drawPoseDebugEnabled: state.drawPoseDebugEnabled,
    showPFOverlay: state.showPFOverlay,
    onOutputGainChange: (value) => {
      state.outputGain = value;
      setOutputVolume(value);
    },
    onLimbModeChange: (value) => {
      state.limbMode = value;
    },
    // 難度切換於「下次載入譜面」時生效（重新選歌）。
    onAdvancedDifficultyChange: (value) => {
      state.songDifficulty = value ? "advanced" : "basic";
    },
    // 播放速度：轉發到影片控制列的 #playbackSpeed，重用其既有 change 處理
    //（handlePlaybackSpeed → activeTransport.setPlaybackRate），兩邊自動同步。
    onPlaybackSpeedChange: (value) => {
      const videoSpeed = document.getElementById("playbackSpeed");
      if (videoSpeed) {
        videoSpeed.value = value;
        videoSpeed.dispatchEvent(new Event("change"));
      }
    },
    onVisibilityThresholdChange: (value) => {
      state.visibilityThreshold = value;
    },
    // 讓設定面板即時反映 adaptiveMonitor 在背景漂移後的可見度閾值。
    // 上界由 adaptiveMonitor 的 VIS_MAX（0.75）保證，此處直接讀真實值。
    getLiveVisibilityThreshold: () => state.visibilityThreshold,
    onDrawPoseDebugChange: (value) => {
      state.drawPoseDebugEnabled = value;
    },
    onShowPFOverlayChange: (value) => {
      state.showPFOverlay = value;
    },
  });

  // 影片控制列速度變更時，反向同步到設定面板的速度選單，維持兩邊一致。
  document.getElementById("playbackSpeed")?.addEventListener("change", () => {
    const s = document.getElementById("settingsPlaybackSpeed");
    const v = document.getElementById("playbackSpeed");
    if (s && v && s.value !== v.value) s.value = v.value;
  });

  bindCameraToggle({
    button,
    state,
    getPoseLandmarker,
    startWebcam: startCam,
    stopWebcam: stopCam,
  });

  button.textContent = "關閉鏡頭";

  // ── 啟動鏡頭（startCam 內部會啟動監控引擎）──
  await startCam();

  // ── HUD 迴圈 ──
  requestAnimationFrame(hudLoop);

  // 校準按鈕（topbar）
  calibrateBtn.addEventListener("click", () => {
    const phase = calibration.getPhase();

    if (
      phase === calibration.PHASES.IDLE ||
      phase === calibration.PHASES.DONE
    ) {
      state._calibrationLogged = false;
      state.calibrationProfile = null;
      calibration.start();
      calibrateBtn.classList.add("is-active");
      calibrateBtn.innerHTML = '<i class="fas fa-crosshairs"></i> 校準中';
    } else {
      calibration.abort();
    }
  });

  // Overlay 內的取消按鈕
  calibCancelBtn.addEventListener("click", () => {
    calibration.abort();
  });
}

bootstrap();
