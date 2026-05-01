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
      modelAssetPath: "./Model/pose_landmarker_heavy.task",//todo: 比較不同model的延遲
      delegate: "GPU",
    },
    runningMode,
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputSegmentationMasks: false,
  });
}
