import {
  getHitLabel,
  initHitDisplay,
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
import { initMidiLibraryPicker, initYouTube } from "./mediaPanel.js";
import { createPoseLandmarker } from "./poseEngine/Mediapipe/poseLandmarker.js";
import { createCalibrationEngine } from "./poseEngine/calibration.js";
import { buildCalibrationProfile } from "./poseEngine/calibrationProfile.js";

const video = document.getElementById("webcam");
const canvas = document.getElementById("output");
const canvasCtx = canvas.getContext("2d");
const button = document.getElementById("toggle");
const frameEl = document.querySelector(".camera-frame");
const rackEl = document.getElementById("soundRack");
const settingsToggle = document.getElementById("settingsToggle");
const settingsPanel = document.getElementById("settingsPanel");
const hitDisplayEl = document.getElementById("hitDisplay");
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
const calibRestInfo = document.getElementById("calibRestInfo");
const calibRestCountdown = document.getElementById("calibRestCountdown");
const calibStrikeProgress = document.getElementById("calibStrikeProgress");
const calibProgressFill = document.getElementById("calibProgressFill");
const calibStrikeCounter = document.getElementById("calibStrikeCounter");

const ZONE_LABEL_MAP = {
  right_front: "右大腿正面",
  left_front: "左大腿正面",
  right_outer: "右大腿外側",
  left_outer: "左大腿外側",
};

// ── 校準 Overlay 控制 ────────────────────────────────────────────────────────

/** 切換只顯示指定的 screen，其他都隱藏 */
function showCalibScreen(id) {
  [calibScreenReady, calibScreenZone, calibScreenDone].forEach((el) => {
    el.classList.toggle("is-hidden", el.id !== id);
  });
}

/** 更新打擊進度條與計數器 */
function updateCalibProgress(strikeCount, strikesPerZone) {
  const pct = strikesPerZone > 0 ? (strikeCount / strikesPerZone) * 100 : 0;
  calibProgressFill.style.width = `${pct}%`;
  calibStrikeCounter.textContent = `${strikeCount} / ${strikesPerZone}`;
}

/** 根據校準引擎的 status 更新整個 overlay */
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

  // 正面靜置快照：身體基準 + 正面 baseline 收斂
  if (phase === PHASES.FRONT_SNAPSHOT) {
    showCalibScreen("calibScreenReady");
    calibCountdownNum.classList.remove("is-scanning");
    calibCountdownNum.textContent = countdown ?? "";
    calibReadyText.textContent = "請將雙手自然放在大腿正面上";
    return;
  }

  // 側面靜置快照：側面 baseline 收斂
  if (phase === PHASES.OUTER_SNAPSHOT) {
    showCalibScreen("calibScreenReady");
    calibCountdownNum.classList.remove("is-scanning");
    calibCountdownNum.textContent = countdown ?? "";
    calibReadyText.textContent = "請將雙手自然放在大腿側面上";
    return;
  }

  if (phase === PHASES.STRIKING) {
    showCalibScreen("calibScreenZone");
    calibZoneLabel.textContent = `打擊 ${ZONE_LABEL_MAP[zone] ?? zone}`;
    // 進度條模式
    calibRestInfo.classList.add("is-hidden");
    calibStrikeProgress.classList.remove("is-hidden");
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
  ...createInitialPoseState(), // 包含 poseLoop 需要的初始狀態
};

const zoneSound = createDefaultZoneSound();
const { initAudio, playZone, setOutputVolume } =
  createAudioEngine(SOUND_LIBRARY);
const { replaceHits } = initHitDisplay(hitDisplayEl, 1);
setOutputVolume(state.outputGain);

const getRect = () => getVideoDrawRect({ video, canvas });
const syncCanvas = () => syncCanvasToCameraFrame({ frameEl, canvas });
const getPoseLandmarker = () => state.poseLandmarker;

// ── 校準引擎 ──
const calibration = createCalibrationEngine({ onStatusChange: onCalibStatus });

const predictWebcam = createPredictWebcam({
  video,
  canvas,
  canvasCtx,
  state,
  getVideoDrawRect: getRect,
  getPoseLandmarker,
  playZone,
  zoneSound,
  onHit: (hits) => {
    replaceHits(
      (hits ?? []).map(({ side, zoneId, source }) => ({
        side,
        zoneId,
        source,
        label: getHitLabel(side, zoneId),
      })),
    );
  },
  // 每幀 pose callback 裡會呼叫這個，把 landmarks 餵給校準引擎
  onFrame: (poseLandmarks, nowMs) => {
    calibration.feedFrame(poseLandmarks, nowMs);

    // 校準完成時：下載 JSON + 還原按鈕
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

        // 下載 JSON 檔案
        const json = JSON.stringify(session, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${session.sessionId}.json`;
        a.click();
        URL.revokeObjectURL(url);

        // 還原校準按鈕
        calibrateBtn.classList.remove("is-active");
        calibrateBtn.innerHTML = '<i class="fas fa-crosshairs"></i> 校準';
      }
    }
  },
});

const startCam = () =>
  startWebcam({
    video,
    state,
    startPredictLoop: predictWebcam,
    syncCanvas,
    initAudio,
  });

const stopCam = () =>
  stopWebcam({
    video,
    canvasCtx,
    state,
    resetPoseState: () => resetPoseState(state),
  });

async function bootstrap() {
  initYouTube();
  initMidiLibraryPicker();

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
    drawPoseDebugEnabled: state.drawPoseDebugEnabled,
    showPFOverlay: state.showPFOverlay,
    onOutputGainChange: (value) => {
      state.outputGain = value;
      setOutputVolume(value);
    },
    onVisibilityThresholdChange: (value) => {
      state.visibilityThreshold = value;
    },
    onDrawPoseDebugChange: (value) => {
      state.drawPoseDebugEnabled = value;
    },
    onShowPFOverlayChange: (value) => {
      state.showPFOverlay = value;
    },
  });

  bindCameraToggle({
    button,
    state,
    getPoseLandmarker,
    startWebcam: startCam,
    stopWebcam: stopCam,
  });

  button.textContent = "關閉鏡頭";
  await startCam();

  // 校準按鈕（topbar）
  calibrateBtn.addEventListener("click", () => {
    const phase = calibration.getPhase();

    if (
      phase === calibration.PHASES.IDLE ||
      phase === calibration.PHASES.DONE
    ) {
      state._calibrationLogged = false;
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
