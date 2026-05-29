import {
  PoseLandmarker,
  FilesetResolver,
} from "https://cdn.skypack.dev/@mediapipe/tasks-vision@0.10.11";

export async function createPoseLandmarker(runningMode = "IMAGE") {
  const fileset = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.11/wasm",
  );

  return PoseLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: "./Model/pose_landmarker_full.task", //todo: 比較不同model的延遲
      delegate: "GPU",
    },
    runningMode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.25,
    minTrackingConfidence: 0.35,
    outputSegmentationMasks: false,
  });
}
