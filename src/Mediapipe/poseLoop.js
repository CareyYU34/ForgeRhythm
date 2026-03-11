import {
  monitoringKneeKickConditions,
  monitoringTriggerConditions,
} from "./conditions.js";
import {
  handBasePointFromPoseLandmarks,
  pickLegZoneByEntry,
  thighLineDistance,
} from "./math.js";

function skipPoints(points, threshold) {
  for (const p of points) {
    if (p.visibility < threshold) return true;
  }
  return false;
}

export function createInitialPoseState() {
  return {
    runningMode: "IMAGE",
    lastVideoTime: -1,
    preSec: 0,
    prevLeftHand: null,
    prevRightHand: null,
    leftThighCordon: null,
    rightThighCordon: null,
    rightState: { canHit: true, lastHitMs: -Infinity },
    leftState: { canHit: true, lastHitMs: -Infinity },
    prevLeftKnee: null,
    prevRightKnee: null,
    visibilityThreshold: 0.75,
    leftKneeState: {
      canHit: true,
      lastHitMs: -Infinity,
      highY: null,
      zoneId: "heel",
    },
    rightKneeState: {
      canHit: true,
      lastHitMs: -Infinity,
      highY: null,
      zoneId: "heel",
    },
  };
}

export function resetPoseState(state) {
  Object.assign(state, createInitialPoseState());
}

function drawPose(pointBundle, canvasCtx, getVideoDrawRect) {
  const p = pointBundle[1];
  if (!p) return;

  const rect = getVideoDrawRect();
  const px = rect.x + p.x * rect.width;
  const py = rect.y + p.y * rect.height;

  canvasCtx.beginPath();
  canvasCtx.arc(px, py, 15, 0, Math.PI * 2);
  canvasCtx.fillStyle = "red";
  canvasCtx.fill();
}

export function createPredictWebcam({
  video,
  canvas,
  canvasCtx,
  state,
  getVideoDrawRect,
  getPoseLandmarker,
  playZone,
  zoneSound,
}) {
  async function predictWebcam() {
    const poseLandmarker = getPoseLandmarker();
    if (!poseLandmarker) return;

    if (state.runningMode !== "VIDEO") {
      state.runningMode = "VIDEO";
      await poseLandmarker.setOptions({ runningMode: "VIDEO" });
    }

    const videoTimeSec = video.currentTime;
    const webTimeMs = performance.now();

    if (videoTimeSec !== state.lastVideoTime) {
      state.lastVideoTime = video.currentTime;
      poseLandmarker.detectForVideo(video, webTimeMs, (result) => {
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

        if (result.landmarks.length === 0) return;

        const leftHip = result.landmarks[0][23];
        const rightHip = result.landmarks[0][24];
        const leftKnee = result.landmarks[0][25];
        const rightKnee = result.landmarks[0][26];
        console.log("left Knee:", leftKnee);
        const leftHandBase = handBasePointFromPoseLandmarks(
          result.landmarks[0],
          "L",
        );
        const rightHandBase = handBasePointFromPoseLandmarks(
          result.landmarks[0],
          "R",
        );

        const pickedLeftHand = [leftHip, leftHandBase, leftKnee];
        const pickedRightHand = [rightHip, rightHandBase, rightKnee];

        if (
          skipPoints(pickedLeftHand, state.visibilityThreshold) ||
          skipPoints(pickedRightHand, state.visibilityThreshold)
        ) {
          return;
        }

        drawPose(pickedLeftHand, canvasCtx, getVideoDrawRect);
        drawPose(pickedRightHand, canvasCtx, getVideoDrawRect);

        const dtSec = Math.max(1e-4, videoTimeSec - state.preSec);
        const prevLeftHandPt = state.prevLeftHand;
        const prevRightHandPt = state.prevRightHand;

        state.leftThighCordon = thighLineDistance(pickedLeftHand);
        state.rightThighCordon = thighLineDistance(pickedRightHand);

        state.prevLeftHand = pickedLeftHand[1];
        state.prevRightHand = pickedRightHand[1];
        state.preSec = videoTimeSec;

        //Leg hit conditions
        const PF_HIT = 0.3;
        const PF_RELEASE = 0.4;
        const COOLDOWN_MS = 160;
        const SPEED_HIT = 0.25;

        const leftHandSpeed = prevLeftHandPt
          ? Math.hypot(
              pickedLeftHand[1].x - prevLeftHandPt.x,
              pickedLeftHand[1].y - prevLeftHandPt.y,
            ) / dtSec
          : 0;

        const rightHandSpeed = prevRightHandPt
          ? Math.hypot(
              pickedRightHand[1].x - prevRightHandPt.x,
              pickedRightHand[1].y - prevRightHandPt.y,
            ) / dtSec
          : 0;

        state.rightState = monitoringTriggerConditions(
          state.rightState,
          state.rightThighCordon,
          PF_HIT,
          PF_RELEASE,
          webTimeMs,
          COOLDOWN_MS,
          rightHandSpeed,
          SPEED_HIT,
        );

        state.leftState = monitoringTriggerConditions(
          state.leftState,
          state.leftThighCordon,
          PF_HIT,
          PF_RELEASE,
          webTimeMs,
          COOLDOWN_MS,
          leftHandSpeed,
          SPEED_HIT,
        );

        //Knee kick conditions
        const KNEE_DROP_HIT = 0.02;//膝盖下降的最小距离
        const KNEE_DROP_RELEASE = 0.008;
        const KNEE_SPEED_HIT = 0.35;
        const KNEE_COOLDOWN_MS = 180;
        const KNEE_MAX_DX = 0.02; //最大位移量

        const leftKneeDx = state.prevLeftKnee
          ? Math.abs(leftKnee.x - state.prevLeftKnee.x)
          : 0;
        const rightKneeDx = state.prevRightKnee
          ? Math.abs(rightKnee.x - state.prevRightKnee.x)
          : 0;

        if (state.prevLeftKnee && leftKneeDx <= KNEE_MAX_DX) {
          state.leftKneeState = monitoringKneeKickConditions(
            state.leftKneeState,
            leftKnee.y,
            state.prevLeftKnee.y,
            dtSec,
            webTimeMs,
            KNEE_DROP_HIT,
            KNEE_DROP_RELEASE,
            KNEE_SPEED_HIT,
            KNEE_COOLDOWN_MS,
          );
        }

        if (state.prevRightKnee && rightKneeDx <= KNEE_MAX_DX) {
          state.rightKneeState = monitoringKneeKickConditions(
            state.rightKneeState,
            rightKnee.y,
            state.prevRightKnee.y,
            dtSec,
            webTimeMs,
            KNEE_DROP_HIT,
            KNEE_DROP_RELEASE,
            KNEE_SPEED_HIT,
            KNEE_COOLDOWN_MS,
          );
        }

        if (state.leftState.didHit) {
          const zoneId = pickLegZoneByEntry(
            prevLeftHandPt,
            pickedLeftHand[1],
            "left",
          );
          console.log("LEFT HIT", { PF: state.leftThighCordon.PF, zoneId });
          playZone("left", zoneId, zoneSound);
        }

        if (state.rightState.didHit) {
          const zoneId = pickLegZoneByEntry(
            prevRightHandPt,
            pickedRightHand[1],
            "right",
          );
          console.log("RIGHT HIT", { PF: state.rightThighCordon.PF, zoneId });
          playZone("right", zoneId, zoneSound);
        }

        if (state.leftKneeState.didHit) {
          console.log("LEFT KNEE KICK", {
            drop: state.leftKneeState.drop,
            speed: state.leftKneeState.kneeDownSpeed,
          });
          playZone("left", state.leftKneeState.zoneId, zoneSound);
        }

        if (state.rightKneeState.didHit) {
          console.log("RIGHT KNEE KICK", {
            drop: state.rightKneeState.drop,
            speed: state.rightKneeState.kneeDownSpeed,
          });
          playZone("right", state.rightKneeState.zoneId, zoneSound);
        }

        state.prevLeftKnee = leftKnee;
        state.prevRightKnee = rightKnee;
      });
    }

    state.rafId = requestAnimationFrame(predictWebcam);
  }

  return predictWebcam;
}
