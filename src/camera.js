export function syncCanvasToCameraFrame({ frameEl, canvas }) {
  if (!frameEl) return;
  const rect = frameEl.getBoundingClientRect();
  canvas.width = Math.round(rect.width);
  canvas.height = Math.round(rect.height);
}

export function getVideoDrawRect({ video, canvas }) {
  const cw = canvas.width;
  const ch = canvas.height;
  const vw = video.videoWidth;
  const vh = video.videoHeight;

  if (!cw || !ch || !vw || !vh) {
    return { x: 0, y: 0, width: cw, height: ch };
  }

  const scale = Math.max(cw / vw, ch / vh);
  const drawWidth = vw * scale;
  const drawHeight = vh * scale;
  return {
    x: (cw - drawWidth) / 2,
    y: (ch - drawHeight) / 2,
    width: drawWidth,
    height: drawHeight,
  };
}

export async function startWebcam({
  video,
  state,
  startPredictLoop,
  syncCanvas,
  initAudio,
}) {
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
      aspectRatio: 16 / 9,
      frameRate: { ideal: 30, max: 30 },
    },
    audio: false,
  });

  video.srcObject = state.stream;
  console.log("Webcam started");

  if (!state._boundLoadedData) {
    state._boundLoadedData = () => startPredictLoop();
    video.addEventListener("loadeddata", state._boundLoadedData);
  }

  if (!state._boundLoadedMeta) {
    state._boundLoadedMeta = () => syncCanvas();
    video.addEventListener("loadedmetadata", state._boundLoadedMeta);
  }

  if (!state._boundResize) {
    state._boundResize = () => syncCanvas();
    video.addEventListener("resize", state._boundResize);
    window.addEventListener("resize", state._boundResize);
  }

  await initAudio();
}

export function stopWebcam({ video, canvasCtx, state, resetPoseState }) {
  if (state.rafId) {
    cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  canvasCtx.clearRect(0, 0, canvasCtx.canvas.width, canvasCtx.canvas.height);

  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }

  video.srcObject = null;
  resetPoseState();
  console.log("Webcam stopped");
}
