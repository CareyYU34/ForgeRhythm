import { bindCameraToggle } from './appController.js';
import {
  createAudioEngine,
  createDefaultZoneSound,
  SOUND_LIBRARY,
  ZONES,
} from './audioEngine.js';
import {
  getVideoDrawRect,
  startWebcam,
  stopWebcam,
  syncCanvasToCameraFrame,
} from './camera.js';
import {
  createInitialPoseState,
  createPredictWebcam,
  resetPoseState,
} from './Mediapipe/poseLoop.js';
import { initMidiLibraryPicker } from './midiLibrary.js';
import { getHitLabel, initHitDisplay } from './hitDisplay.js';
import { createPoseLandmarker } from './Mediapipe/poseLandmarker.js';
import { bindSoundUI, initSettingsPanel } from './settingsPanel.js';
import { initYouTube } from './youtube.js';

const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const canvasCtx = canvas.getContext('2d');
const button = document.getElementById('toggle');
const frameEl = document.querySelector('.camera-frame');
const rackEl = document.getElementById('soundRack');
const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel = document.getElementById('settingsPanel');
const hitDisplayEl = document.getElementById('hitDisplay');

const state = {
  running: true,
  stream: null,
  poseLandmarker: null,
  outputGain: 7,
  ...createInitialPoseState(),
};

const zoneSound = createDefaultZoneSound();
const { initAudio, playZone, setOutputVolume } = createAudioEngine(SOUND_LIBRARY);
const { replaceHits } = initHitDisplay(hitDisplayEl, 1);
setOutputVolume(state.outputGain);

const getRect = () => getVideoDrawRect({ video, canvas });
const syncCanvas = () => syncCanvasToCameraFrame({ frameEl, canvas });
const getPoseLandmarker = () => state.poseLandmarker;

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

  initSettingsPanel({
    toggleBtn: settingsToggle,
    panelEl: settingsPanel,
    outputGain: state.outputGain,
    visibilityThreshold: state.visibilityThreshold,
    drawPoseDebugEnabled: state.drawPoseDebugEnabled,
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
  });

  bindCameraToggle({
    button,
    state,
    getPoseLandmarker,
    startWebcam: startCam,
    stopWebcam: stopCam,
  });

  button.textContent = '關閉鏡頭';
  await startCam();
}

bootstrap();
