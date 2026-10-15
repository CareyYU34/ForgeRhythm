import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.skypack.dev/@mediapipe/tasks-vision@0.10.11";

// ─────────────────────────────────────────────────────────────────────────────
// 效能優化（低階／無獨顯 PC 打擊延遲）
//
// 延遲主因：單幀推論時間 > 幀間隔（~33ms），導致每次判斷都在處理「過時的畫面」，
// 聲音慢半拍。整條 pipeline 中推論（detectForVideo）佔 ~99% 成本，優化集中於此。
//
// 本檔負責三個槓桿中的兩個：
//   ① 模型層級：full(9.4MB) → lite(5.7MB)，CPU 路徑約快 1.8–2×；判斷都是大腿線／
//      膝蓋等大動作，lite 精度足夠。
//   ② delegate 自動退回：優先 GPU；在以軟體模擬 WebGL（SwiftShader）的無顯卡機上，
//      GPU delegate 常初始化失敗、甚至比 CPU 慢，此時退回 CPU delegate（純 WASM）。
//   （③ 降低輸入解析度在 camera.js 的 getUserMedia 約束處理。）
//
// TODO(perf-④ 效能分層 + 自動偵測)：開機量測前 ~30 幀平均推論耗時，自動在
//   high(full+GPU) / balanced(lite+GPU) / low(lite+CPU) 間選檔，並在設定面板留手動
//   覆寫（存 localStorage）。目前先硬選 full + delegate 自動退回；分層做完後
//   modelTier 由偵測器決定，這裡的 DEFAULT_MODEL_TIER 僅作 fallback。
//
// TODO(perf-⑤ 推論節流「永遠只處理最新幀」)：若最低檔仍追不上，於
//   poseLoop.createPredictWebcam 加「單幀預算」——推論尚未回來就跳過該輪 rAF、不排隊，
//   寧可低 fps 判斷即時畫面，也不要高 fps 判斷過時畫面，以消除延遲累積。
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_PATHS = {
  lite: "./Model/pose_landmarker_lite.task",
  full: "./Model/pose_landmarker_full.task",
  heavy: "./Model/pose_landmarker_heavy.task",
};

// 預設模型層級：改回 full —— 手部 17–20 點（小指／食指）座標比 lite 穩，PF 判斷較準。
// 畫面改為黑底只畫節點後，輸入解析度維持 640×360 即可。低階機若推論跟不上，
// 待 todo ④（自動退回 lite）/ ⑤（只處理最新幀）補上。要臨時比較延遲，改這個字串即可。
const DEFAULT_MODEL_TIER = "full";

export async function createPoseLandmarker(
  runningMode = "IMAGE",
  { modelTier = DEFAULT_MODEL_TIER } = {},
) {
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.11/wasm",
  );

  const modelAssetPath = MODEL_PATHS[modelTier] ?? MODEL_PATHS.lite;

  const buildOptions = (delegate) => ({
    baseOptions: { modelAssetPath, delegate },
    runningMode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.25,
    minTrackingConfidence: 0.35,
    outputSegmentationMasks: false,
  });

  // ② 優先 GPU；初始化失敗時退回 CPU delegate，避免整個 pose engine 起不來。
  try {
    return await PoseLandmarker.createFromOptions(fileset, buildOptions("GPU"));
  } catch (err) {
    console.warn(
      "[poseLandmarker] GPU delegate 初始化失敗，退回 CPU delegate：",
      err,
    );
    return await PoseLandmarker.createFromOptions(fileset, buildOptions("CPU"));
  }
}
