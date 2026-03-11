export function bindCameraToggle({
  button,
  state,
  getPoseLandmarker,
  startWebcam,
  stopWebcam,
}) {
  button.onclick = async () => {
    if (!getPoseLandmarker()) return;
    state.running = !state.running;
    button.textContent = state.running ? "關閉鏡頭" : "開啟鏡頭";

    if (state.running) {
      await startWebcam();
    } else {
      stopWebcam();
    }
  };
}
