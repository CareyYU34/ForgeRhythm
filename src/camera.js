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
  // ③ 效能優化：降低送進模型的輸入解析度。MediaPipe 內部會縮圖，但每幀「上傳 +
  //    縮放」的成本與來源像素數成正比；640×360 的像素量約為 1280×720 的 1/4，能明顯
  //    減輕低階機（尤其 WASM／CPU delegate 路徑）的前處理負擔，對大腿線／膝蓋這類粗
  //    動作判斷幾乎無影響。詳見 poseLandmarker.js 頂部的效能說明（①②③ 與 todo ④⑤）。
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 360 },
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
