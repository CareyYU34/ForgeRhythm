import {
  monitoringKneeKickConditions,
  monitoringTriggerConditions,
} from "./conditions.js";
import {
  handBasePointFromPoseLandmarks,
  isStrictlyNormalizedPoint,
  pickHandZoneByWindow,
  pushPointHistory,
  summarizeHandMotion,
  summarizeKneeMotion,
  thighLineDistance,
} from "./math.js";

function skipPoints(points, threshold) {
  for (const p of points) {
    if (!isStrictlyNormalizedPoint(p)) return true;
    if ((p.visibility ?? 1) < threshold) return true;
  }
  return false;
}

function clearTrackingHistory(state) {
  state.prevLeftHand = null;
  state.prevRightHand = null;
  state.prevLeftKnee = null;
  state.prevRightKnee = null;
  state.leftHandHistory = [];
  state.rightHandHistory = [];
  state.leftKneeHistory = [];
  state.rightKneeHistory = [];
  state.preSec = 0;
}

export function createInitialPoseState() {
  return {
    runningMode: "IMAGE",
    lastVideoTime: -1,
    preSec: 0,
    prevLeftHand: null,
    prevRightHand: null,
    leftHandHistory: [],
    rightHandHistory: [],
    lastLeftHandZone: "front",
    lastRightHandZone: "front",
    leftThighCordon: null,
    rightThighCordon: null,
    rightState: { canHit: true, lastHitMs: -Infinity },
    leftState: { canHit: true, lastHitMs: -Infinity },
    prevLeftKnee: null,
    prevRightKnee: null,
    leftKneeHistory: [],
    rightKneeHistory: [],
    visibilityThreshold: 0.75,
    leftKneeState: {
      canHit: true,
      lastHitMs: -Infinity,
      zoneId: "heel",
    },
    rightKneeState: {
      canHit: true,
      lastHitMs: -Infinity,
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

        // 先解出這一幀會用到的關鍵點，後面手部與膝蓋都共用這批資料。
        const poseLandmarks = result.landmarks[0];
        const leftHip = poseLandmarks[23];
        const rightHip = poseLandmarks[24];
        const leftKnee = poseLandmarks[25];
        const rightKnee = poseLandmarks[26];
        const leftHandBase = handBasePointFromPoseLandmarks(poseLandmarks, "L");
        const rightHandBase = handBasePointFromPoseLandmarks(poseLandmarks, "R");

        const pickedLeftHand = [leftHip, leftHandBase, leftKnee];
        const pickedRightHand = [rightHip, rightHandBase, rightKnee];

        // 只要關鍵點失真或可見度不足，就清掉 history，避免髒資料延續到下一幀。
        if (
          skipPoints(pickedLeftHand, state.visibilityThreshold) ||
          skipPoints(pickedRightHand, state.visibilityThreshold)
        ) {
          clearTrackingHistory(state);
          return;
        }

        drawPose(pickedLeftHand, canvasCtx, getVideoDrawRect);
        drawPose(pickedRightHand, canvasCtx, getVideoDrawRect);

        // 這一段保留原本手部命中判斷需要的單幀資料。
        const dtSec = Math.max(1e-4, videoTimeSec - state.preSec);
        const prevLeftHandPt = state.prevLeftHand;
        const prevRightHandPt = state.prevRightHand;

        state.leftThighCordon = thighLineDistance(pickedLeftHand);
        state.rightThighCordon = thighLineDistance(pickedRightHand);

        state.prevLeftHand = pickedLeftHand[1];
        state.prevRightHand = pickedRightHand[1];
        state.preSec = videoTimeSec;

        // Hand hit conditions
        // PF_HIT / PF_RELEASE: 手靠近大腿線到指定距離才觸發，離開後才能重新命中。
        // HAND_COOLDOWN_MS: 每次手部命中的冷卻時間，避免一個動作連續觸發多次。
        // HAND_SPEED_HIT: 單幀速度下限，避免很慢的滑過也被當成打擊。
        const PF_HIT = 0.15;
        const PF_RELEASE = 0.2;
        const HAND_COOLDOWN_MS = 160;
        const HAND_SPEED_HIT = 0.25;

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
          HAND_COOLDOWN_MS,
          rightHandSpeed,
          HAND_SPEED_HIT,
        );

        state.leftState = monitoringTriggerConditions(
          state.leftState,
          state.leftThighCordon,
          PF_HIT,
          PF_RELEASE,
          webTimeMs,
          HAND_COOLDOWN_MS,
          leftHandSpeed,
          HAND_SPEED_HIT,
        );

        // Hand zone conditions
        // HAND_HISTORY_SIZE: 取最近幾幀做方向分析，越大越穩但區域反應會稍慢。
        // HAND_FRONT_DOMINANT_RATIO: 垂直位移必須比水平位移明顯大，才分類成 front。
        // HAND_SIDE_DOMINANT_RATIO: 水平位移必須比垂直位移明顯大，才分類成 side。
        // HAND_MIN_ZONE_CONSISTENCY: 多數小段位移方向要一致，才承認這個分區結果。
        // HAND_MIN_WINDOW_DISTANCE: 短視窗總位移太小時，不更新分區，避免抖動翻區。
        // HAND_MIN_AVG_SPEED / HAND_MIN_PEAK_SPEED: 避免慢速小漂移誤改分區。
        const HAND_HISTORY_SIZE = 4;
        const HAND_FRONT_DOMINANT_RATIO = 1.2;
        const HAND_SIDE_DOMINANT_RATIO = 1.2;
        const HAND_MIN_ZONE_CONSISTENCY = 0.55;
        const HAND_MIN_WINDOW_DISTANCE = 0.035;
        const HAND_MIN_AVG_SPEED = 0.35;
        const HAND_MIN_PEAK_SPEED = 0.55;

        // 先把最新手部點放進 history，再把整段路徑摘要成可判讀的特徵。
        state.leftHandHistory = pushPointHistory(
          state.leftHandHistory,
          pickedLeftHand[1],
          videoTimeSec,
          HAND_HISTORY_SIZE,
        );
        state.rightHandHistory = pushPointHistory(
          state.rightHandHistory,
          pickedRightHand[1],
          videoTimeSec,
          HAND_HISTORY_SIZE,
        );

        const leftHandMetrics = summarizeHandMotion(state.leftHandHistory);
        const rightHandMetrics = summarizeHandMotion(state.rightHandHistory);

        const canUseLeftHandZone =
          leftHandMetrics &&
          leftHandMetrics.windowDistance >= HAND_MIN_WINDOW_DISTANCE &&
          (leftHandMetrics.avgSpeed >= HAND_MIN_AVG_SPEED ||
            leftHandMetrics.maxSpeed >= HAND_MIN_PEAK_SPEED);
        const canUseRightHandZone =
          rightHandMetrics &&
          rightHandMetrics.windowDistance >= HAND_MIN_WINDOW_DISTANCE &&
          (rightHandMetrics.avgSpeed >= HAND_MIN_AVG_SPEED ||
            rightHandMetrics.maxSpeed >= HAND_MIN_PEAK_SPEED);

        // 分區只在短視窗特徵夠明確時更新；模糊時保留上一個穩定結果。
        if (canUseLeftHandZone) {
          const nextZone = pickHandZoneByWindow(leftHandMetrics, "left", {
            frontDominantRatio: HAND_FRONT_DOMINANT_RATIO,
            sideDominantRatio: HAND_SIDE_DOMINANT_RATIO,
            minConsistency: HAND_MIN_ZONE_CONSISTENCY,
          });
          if (nextZone) state.lastLeftHandZone = nextZone;
        }

        if (canUseRightHandZone) {
          const nextZone = pickHandZoneByWindow(rightHandMetrics, "right", {
            frontDominantRatio: HAND_FRONT_DOMINANT_RATIO,
            sideDominantRatio: HAND_SIDE_DOMINANT_RATIO,
            minConsistency: HAND_MIN_ZONE_CONSISTENCY,
          });
          if (nextZone) state.lastRightHandZone = nextZone;
        }

        // Knee kick conditions
        // KNEE_HISTORY_SIZE: 用最近幾幀建立短時間窗，值越大越穩但反應會略慢。
        // WINDOW_DROP_HIT: 視窗內 y 軸累積下降量門檻，夠大才算真的往下踢。
        // WINDOW_DROP_RELEASE: 視窗內下降量回到這個值以下，才重新允許下一次觸發。
        // AVG_SPEED_HIT / PEAK_SPEED_HIT: 同時看平均速度與局部峰值速度，提升辨識穩定度。
        // WINDOW_MAX_DX: 視窗起點到終點的 x 位移上限，避免左右平移誤觸。
        // MAX_XY_RATIO: 視窗內橫向位移總量不能明顯大於縱向位移總量。
        // DOWN_FRAME_RATIO_HIT: 視窗內必須有足夠比例的 frame 持續往下，代表方向一致。
        // KNEE_COOLDOWN_MS: 每次膝蓋命中後的冷卻時間。
        const KNEE_HISTORY_SIZE = 5;
        const WINDOW_DROP_HIT = 0.028;
        const WINDOW_DROP_RELEASE = 0.012;
        const AVG_SPEED_HIT = 0.32;
        const PEAK_SPEED_HIT = 0.5;
        const WINDOW_MAX_DX = 0.02;
        const MAX_XY_RATIO = 0.85;
        const DOWN_FRAME_RATIO_HIT = 0.7;
        const KNEE_COOLDOWN_MS = 180;

        // 先把最新膝蓋點放進 history，再把這段短視窗摘要成可判斷的特徵。
        state.leftKneeHistory = pushPointHistory(
          state.leftKneeHistory,
          leftKnee,
          videoTimeSec,
          KNEE_HISTORY_SIZE,
        );
        state.rightKneeHistory = pushPointHistory(
          state.rightKneeHistory,
          rightKnee,
          videoTimeSec,
          KNEE_HISTORY_SIZE,
        );

        const leftKneeMetrics = summarizeKneeMotion(state.leftKneeHistory);
        const rightKneeMetrics = summarizeKneeMotion(state.rightKneeHistory);
        const kneeThresholds = {
          windowDropHit: WINDOW_DROP_HIT,
          windowDropRelease: WINDOW_DROP_RELEASE,
          avgSpeedHit: AVG_SPEED_HIT,
          peakSpeedHit: PEAK_SPEED_HIT,
          cooldownMs: KNEE_COOLDOWN_MS,
          windowMaxDx: WINDOW_MAX_DX,
          maxXyRatio: MAX_XY_RATIO,
          downFrameRatioHit: DOWN_FRAME_RATIO_HIT,
        };

        // 膝蓋改用短視窗特徵做判斷，不再只看前後兩點。
        if (leftKneeMetrics) {
          state.leftKneeState = monitoringKneeKickConditions(
            state.leftKneeState,
            leftKneeMetrics,
            webTimeMs,
            kneeThresholds,
          );
        }

        if (rightKneeMetrics) {
          state.rightKneeState = monitoringKneeKickConditions(
            state.rightKneeState,
            rightKneeMetrics,
            webTimeMs,
            kneeThresholds,
          );
        }

        // 手部命中仍由 PF + 速度負責，分區則改用短視窗方向結果。
        if (state.leftState.didHit) {
          console.log("LEFT HIT", {
            PF: state.leftThighCordon.PF,
            zoneId: state.lastLeftHandZone,
            handMetrics: leftHandMetrics,
          });
          playZone("left", state.lastLeftHandZone, zoneSound);
        }

        if (state.rightState.didHit) {
          console.log("RIGHT HIT", {
            PF: state.rightThighCordon.PF,
            zoneId: state.lastRightHandZone,
            handMetrics: rightHandMetrics,
          });
          playZone("right", state.lastRightHandZone, zoneSound);
        }

        // 膝蓋命中時一起印出摘要特徵，方便你後續觀察與調參。
        if (state.leftKneeState.didHit) {
          console.log("LEFT KNEE KICK", {
            windowDy: state.leftKneeState.windowDy,
            windowDx: state.leftKneeState.windowDx,
            avgDownSpeed: state.leftKneeState.avgDownSpeed,
            maxDownSpeed: state.leftKneeState.maxDownSpeed,
            downFrameRatio: state.leftKneeState.downFrameRatio,
            xyRatio: state.leftKneeState.xyRatio,
          });
          playZone("left", state.leftKneeState.zoneId, zoneSound);
        }

        if (state.rightKneeState.didHit) {
          console.log("RIGHT KNEE KICK", {
            windowDy: state.rightKneeState.windowDy,
            windowDx: state.rightKneeState.windowDx,
            avgDownSpeed: state.rightKneeState.avgDownSpeed,
            maxDownSpeed: state.rightKneeState.maxDownSpeed,
            downFrameRatio: state.rightKneeState.downFrameRatio,
            xyRatio: state.rightKneeState.xyRatio,
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
