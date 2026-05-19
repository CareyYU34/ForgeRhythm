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
import { calcKneeRisingAdj, getZoneParams } from "./calibrationProfile.js";
import { createHitEffectManager } from "./hitEffects.js";

const POSE_CONNECTIONS = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 7],
  [0, 4],
  [4, 5],
  [5, 6],
  [6, 8],
  [9, 10],
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [25, 27],
  [27, 29],
  [29, 31],
  [24, 26],
  [26, 28],
  [28, 30],
  [30, 32],
  [27, 31],
  [28, 32],
];

// ── 將 knee / hand 相關常數從幀循環內移至模組頂層，避免每幀重建物件 ──

// Hip / Knee EMA 平滑係數（0 = 完全不動，1 = 無平滑）
const HIP_KNEE_EMA_ALPHA = 0.6;

/** EMA 平滑單一座標軸 */
function emaPoint(prev, curr, alpha) {
  if (!prev) return { x: curr.x, y: curr.y };
  return {
    x: alpha * curr.x + (1 - alpha) * prev.x,
    y: alpha * curr.y + (1 - alpha) * prev.y,
  };
}

const HAND_HISTORY_SIZE = 5;
const KNEE_HISTORY_SIZE = 5;
const HAND_FRONT_DOMINANT_RATIO = 1.2;
const HAND_SIDE_DOMINANT_RATIO = 1.2;
const HAND_MIN_ZONE_CONSISTENCY = 0.55;

// 硬編碼靜態預設值（未校準時使用）
const KNEE_THRESHOLDS_DEFAULT = {
  windowDropHit: 0.028,
  windowDropRelease: 0.012,
  avgSpeedHit: 0.32,
  peakSpeedHit: 0.5,
  cooldownMs: 180,
  windowMaxDx: 0.02,
  maxXyRatio: 0.85,
  downFrameRatioHit: 0.7,
};

/**
 * 取得膝蓋閾值：已校準時用動態值覆蓋 windowDropHit/windowDropRelease，
 * 其餘欄位仍使用靜態預設。
 */
function getKneeThresholds(profile, side) {
  const base = KNEE_THRESHOLDS_DEFAULT;
  if (!profile?.knee?.[side]) return base;
  const k = profile.knee[side];
  return {
    ...base,
    windowDropHit: k.windowDropHit,
    windowDropRelease: k.windowDropRelease,
  };
}

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
  // Hip / Knee EMA：遮蔽失真後重置，避免殘留舊值拉偏下一輪平滑
  state.emaLeftHip = null;
  state.emaRightHip = null;
  state.emaLeftKnee = null;
  state.emaRightKnee = null;
}

export function createInitialPoseState() {
  return {
    runningMode: "IMAGE",
    lastVideoTime: -1, // 上一幀的 video.currentTime（秒）
    preSec: 0, // 上一幀的時間戳（秒）
    prevLeftHand: null, // 上一幀的左手關鍵點（用於速度計算）
    prevRightHand: null, // 上一幀的右手關鍵點（用於速度計算）
    leftHandHistory: [], // 最近幾幀的左手關鍵點歷史（用於 zone 鎖定）
    rightHandHistory: [], // 最近幾幀的右手關鍵點歷史（用於 zone 鎖定）
    lastLeftHandZone: "front", // 上次穩定的左手 zone（用於 zone 鎖定失敗時的 fallback）
    lastRightHandZone: "front", // 上次穩定的右手 zone（用於 zone 鎖定失敗時的 fallback）
    leftThighCordon: null, // 左大腿PF數據（用於 hit 判斷）
    rightThighCordon: null, // 右大腿PF數據（用於 hit 判斷）
    rightState: { canHit: false, lastHitMs: -Infinity },
    leftState: { canHit: false, lastHitMs: -Infinity },
    prevLeftKnee: null,
    prevRightKnee: null,
    leftKneeHistory: [],
    rightKneeHistory: [],
    visibilityThreshold: 0.75, // landmark 可見度閾值，低於這個值的點會被視為失真點，觸發重置機制
    leftKneeState: {
      canHit: false,
      lastHitMs: -Infinity,
      zoneId: "heel",
    },
    rightKneeState: {
      canHit: false,
      lastHitMs: -Infinity,
      zoneId: "heel",
    },
    drawPoseDebugEnabled: false,
    showPFOverlay: false,

    // ── 方向鎖定（zone locking）──
    rightLockedZone: null,
    rightZoneLocked: false,
    leftLockedZone: null,
    leftZoneLocked: false,

    // ── 校準 profile（null = 未校準，不發聲）──
    calibrationProfile: null,

    // ── Hip / Knee EMA 平滑儲存（null = 尚未初始化，下一幀直接採用原始值）──
    emaLeftHip: null,
    emaRightHip: null,
    emaLeftKnee: null,
    emaRightKnee: null,
  };
}

// ── 使用者偏好欄位：不應該在鏡頭重開時被重置 ──
const USER_PREFERENCE_KEYS = [
  "drawPoseDebugEnabled",
  "visibilityThreshold",
  "calibrationProfile",
  "showPFOverlay",
];

export function resetPoseState(state) {
  // 先把使用者偏好抽出來保留
  const preserved = {};
  for (const key of USER_PREFERENCE_KEYS) {
    if (key in state) preserved[key] = state[key];
  }
  // 重置為初始狀態，再把偏好蓋回去
  Object.assign(state, createInitialPoseState(), preserved);
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

// PF 數值的節流快取：每 ~100ms 才更新一次顯示字串，避免視覺抖動
let _pfDisplayCache = {
  leftText: "",
  rightText: "",
  leftColor: "#fff",
  rightColor: "#fff",
  lastUpdateMs: 0,
};
const PF_DISPLAY_UPDATE_INTERVAL_MS = 100;

function pickPFColor(pf, profile, side, zone) {
  if (pf == null) return "#888";
  if (!profile) return "#fff"; // 未校準
  const params = zone ? getZoneParamsIfAvailable(profile, side, zone) : null;
  if (!params) return "#fff";
  if (pf < params.PF_HIT) return "#ff4d4d"; // 打擊區（紅）
  if (pf < params.PF_RELEASE) return "#ffcc33"; // 過渡區（黃）
  return "#4dff88"; // 釋放區（綠）
}

// 安全地取得 zone 參數，沒有就回 null（避免 import 再一次）
function getZoneParamsIfAvailable(profile, side, zone) {
  try {
    return getZoneParams(profile, side, zone);
  } catch {
    return null;
  }
}

function drawPFOverlay({
  canvasCtx,
  leftHandPt,
  rightHandPt,
  getVideoDrawRect,
  state,
  nowMs,
}) {
  const rect = getVideoDrawRect();
  const leftPF = state.leftThighCordon?.PF;
  const rightPF = state.rightThighCordon?.PF;

  // 節流：每 100ms 更新一次「顯示字串 + 顏色」
  if (nowMs - _pfDisplayCache.lastUpdateMs >= PF_DISPLAY_UPDATE_INTERVAL_MS) {
    _pfDisplayCache.leftText = leftPF != null ? leftPF.toFixed(2) : "—";
    _pfDisplayCache.rightText = rightPF != null ? rightPF.toFixed(2) : "—";
    _pfDisplayCache.leftColor = pickPFColor(
      leftPF,
      state.calibrationProfile,
      "left",
      state.leftLockedZone ?? state.lastLeftHandZone,
    );
    _pfDisplayCache.rightColor = pickPFColor(
      rightPF,
      state.calibrationProfile,
      "right",
      state.rightLockedZone ?? state.lastRightHandZone,
    );
    _pfDisplayCache.lastUpdateMs = nowMs;
  }

  canvasCtx.save();
  canvasCtx.font = "bold 18px system-ui, sans-serif";
  canvasCtx.textBaseline = "bottom";
  canvasCtx.lineWidth = 4;
  canvasCtx.strokeStyle = "rgba(0, 0, 0, 0.75)";

  const OFFSET_X = 18;
  const OFFSET_Y = -18;

  const drawLabel = (handPt, text, color) => {
    if (!handPt) return;
    // 錨點：手部基準點在 canvas 上的實際像素座標
    const anchorX = rect.x + handPt.x * rect.width;
    const anchorY = rect.y + handPt.y * rect.height;

    canvasCtx.save();
    // 把原點搬到錨點、再做 X 軸翻轉，抵銷外層 CSS 的 scaleX(-1)
    canvasCtx.translate(anchorX, anchorY);
    canvasCtx.scale(-1, 1);
    // 在抵銷翻轉後的座標系裡畫文字，OFFSET_X 用正值表示「視覺上的右方」
    canvasCtx.strokeText(text, OFFSET_X, OFFSET_Y);
    canvasCtx.fillStyle = color;
    canvasCtx.fillText(text, OFFSET_X, OFFSET_Y);
    canvasCtx.restore();
  };

  drawLabel(leftHandPt, _pfDisplayCache.leftText, _pfDisplayCache.leftColor);
  drawLabel(rightHandPt, _pfDisplayCache.rightText, _pfDisplayCache.rightColor);
  canvasCtx.restore();
}

function drawPoseLandmarks(
  landmarks,
  canvasCtx,
  getVideoDrawRect,
  visibilityThreshold,
) {
  const rect = getVideoDrawRect();
  const points = landmarks.map((landmark) => ({
    x: rect.x + landmark.x * rect.width,
    y: rect.y + landmark.y * rect.height,
    visibility: landmark.visibility ?? 1,
  }));

  canvasCtx.save();
  canvasCtx.lineWidth = 3;
  canvasCtx.strokeStyle = "rgba(255, 255, 255, 0.75)";

  for (const [startIndex, endIndex] of POSE_CONNECTIONS) {
    const start = points[startIndex];
    const end = points[endIndex];
    if (!start || !end) continue;
    if (
      start.visibility < visibilityThreshold ||
      end.visibility < visibilityThreshold
    ) {
      continue;
    }

    canvasCtx.beginPath();
    canvasCtx.moveTo(start.x, start.y);
    canvasCtx.lineTo(end.x, end.y);
    canvasCtx.stroke();
  }

  canvasCtx.fillStyle = "rgba(255, 64, 64, 0.95)";
  for (const point of points) {
    if (point.visibility < visibilityThreshold) continue;
    canvasCtx.beginPath();
    canvasCtx.arc(point.x, point.y, 10, 0, Math.PI * 2);
    canvasCtx.fill();
  }

  canvasCtx.restore();
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
  onHit,
  onFrame,
  hitEffectManager,
}) {
  const _fx = hitEffectManager ?? createHitEffectManager();
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
        const frameHits = [];

        // 先解出這一幀會用到的關鍵點，後面手部與膝蓋都共用這批資料。
        const poseLandmarks = result.landmarks[0];
        onFrame?.(poseLandmarks, webTimeMs);
        const leftHip = poseLandmarks[23];
        const rightHip = poseLandmarks[24];
        const leftKnee = poseLandmarks[25];
        const rightKnee = poseLandmarks[26];
        const leftHandBase = handBasePointFromPoseLandmarks(poseLandmarks, "L");
        const rightHandBase = handBasePointFromPoseLandmarks(
          poseLandmarks,
          "R",
        );

        const pickedLeftHand = [leftHip, leftHandBase, leftKnee];
        const pickedRightHand = [rightHip, rightHandBase, rightKnee];

        if (state.drawPoseDebugEnabled) {
          drawPoseLandmarks(
            poseLandmarks,
            canvasCtx,
            getVideoDrawRect,
            state.visibilityThreshold,
          );
        }

        // 只要關鍵點失真或可見度不足，就清掉 history，避免髒資料延續到下一幀。
        if (
          skipPoints(pickedLeftHand, state.visibilityThreshold) ||
          skipPoints(pickedRightHand, state.visibilityThreshold)
        ) {
          clearTrackingHistory(state);
          return;
        }

        // ── Hip / Knee EMA 平滑（同 PF 的 EMA 邏輯，減少 landmark 抖動對 PF 的影響）──
        state.emaLeftHip  = emaPoint(state.emaLeftHip,  leftHip,  HIP_KNEE_EMA_ALPHA);
        state.emaRightHip = emaPoint(state.emaRightHip, rightHip, HIP_KNEE_EMA_ALPHA);
        state.emaLeftKnee  = emaPoint(state.emaLeftKnee,  leftKnee,  HIP_KNEE_EMA_ALPHA);
        state.emaRightKnee = emaPoint(state.emaRightKnee, rightKnee, HIP_KNEE_EMA_ALPHA);

        // 用平滑後的 hip/knee 取代原始值，供 thighLineDistance 計算；
        // handBase 仍使用原始值（手部自己有 PF_SMOOTH_ALPHA 平滑）。
        const smoothedLeftHand  = [state.emaLeftHip,  leftHandBase,  state.emaLeftKnee];
        const smoothedRightHand = [state.emaRightHip, rightHandBase, state.emaRightKnee];

        if (!state.drawPoseDebugEnabled) {
          drawPose(pickedLeftHand, canvasCtx, getVideoDrawRect);
          drawPose(pickedRightHand, canvasCtx, getVideoDrawRect);
        }

        // 這一段保留原本手部命中判斷需要的單幀資料。
        const dtSec = Math.max(1e-4, videoTimeSec - state.preSec);
        const prevLeftHandPt = state.prevLeftHand;
        const prevRightHandPt = state.prevRightHand;

        state.leftThighCordon = thighLineDistance(smoothedLeftHand);
        state.rightThighCordon = thighLineDistance(smoothedRightHand);
        state.prevLeftHand = pickedLeftHand[1];
        state.prevRightHand = pickedRightHand[1];
        state.preSec = videoTimeSec;

        // ── PF 值顯示（overlay debug）──
        if (state.showPFOverlay) {
          drawPFOverlay({
            canvasCtx,
            leftHandPt: pickedLeftHand[1],
            rightHandPt: pickedRightHand[1],
            getVideoDrawRect,
            state,
            nowMs: webTimeMs,
          });
        }

        // 手部速度（單幀）
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

        // Hand hit conditions
        // ── 動態參數：從 calibrationProfile 取得 per-zone 門檻 ──
        // 未校準時 calibrationProfile 為 null，跳過整段手部打擊偵測。
        // 先把最新手部點放進 history（每次打擊循環開始時 history 已被清空）。
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

        // 膝蓋改用短視窗特徵做判斷，不再只看前後兩點，先把最新膝蓋點放進 history，再把這段短視窗摘要成可判斷的特徵。
        // 原本在 if (state.calibrationProfile) 內，導致 calibration 完成後初期 history 為空，無法正確判斷膝蓋動作。現在改成只要有足夠的膝蓋點就嘗試判斷，提升穩定度。
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

        if (state.calibrationProfile) {
          const profile = state.calibrationProfile;
          const PF_RELEASE_UNIFIED = profile.PF_RELEASE_UNIFIED;

          // ── 膝蓋上升補償量（每幀計算，用平滑後的 knee y）──
          // 提膝時 emaKnee.y < kneeBaseline.y，calcKneeRisingAdj 回傳正值。
          // 這個補償量會同步疊加到 PF_HIT 和 PF_RELEASE，
          // 讓大腿線旋轉造成的 PF 幾何漂移無法穿越門檻，防止誤觸發。
          const leftKneeAdj  = calcKneeRisingAdj(profile, "left",  state.emaLeftKnee?.y  ?? leftKnee.y);
          const rightKneeAdj = calcKneeRisingAdj(profile, "right", state.emaRightKnee?.y ?? rightKnee.y);

          // ── 右手：Release reset → 清 history + 解鎖 zone ──
          const rightPF = state.rightThighCordon?.PF;
          // 右手 release 判斷也要加上補償量，確保 release 條件與 hit 條件一致
          if (rightPF != null && rightPF > PF_RELEASE_UNIFIED + rightKneeAdj) {
            if (!state.rightState.canHit) {
              // 剛從打擊狀態回到釋放狀態，清空 history 開始新循環
              state.rightHandHistory = [];
              state.rightZoneLocked = false;
              state.rightLockedZone = null;
            } // ── 右手：方向鎖定檢查點（PF 穿越 release 的那一幀）──
          } else if (rightPF != null && !state.rightZoneLocked) {
            const metrics = summarizeHandMotion(state.rightHandHistory);
            const lockedZone = metrics
              ? pickHandZoneByWindow(metrics, "right", {
                  frontDominantRatio: HAND_FRONT_DOMINANT_RATIO,
                  sideDominantRatio: HAND_SIDE_DOMINANT_RATIO,
                  minConsistency: HAND_MIN_ZONE_CONSISTENCY,
                })
              : null;
            state.rightLockedZone = lockedZone ?? state.lastRightHandZone;
            state.rightZoneLocked = true;
          }

          // ── 左手：Release reset → 清 history + 解鎖 zone ──
          const leftPF = state.leftThighCordon?.PF;
          // 左手 release 判斷同樣加上補償量
          if (leftPF != null && leftPF > PF_RELEASE_UNIFIED + leftKneeAdj) {
            if (!state.leftState.canHit) {
              state.leftHandHistory = [];
              state.leftZoneLocked = false;
              state.leftLockedZone = null;
            } // ── 左手：方向鎖定檢查點 ──
          } else if (leftPF != null && !state.leftZoneLocked) {
            const metrics = summarizeHandMotion(state.leftHandHistory);
            const lockedZone = metrics
              ? pickHandZoneByWindow(metrics, "left", {
                  frontDominantRatio: HAND_FRONT_DOMINANT_RATIO,
                  sideDominantRatio: HAND_SIDE_DOMINANT_RATIO,
                  minConsistency: HAND_MIN_ZONE_CONSISTENCY,
                })
              : null;
            state.leftLockedZone = lockedZone ?? state.lastLeftHandZone;
            state.leftZoneLocked = true;
          }

          // ── 右手：動態門檻 hit 判斷（疊加膝蓋補償）──
          const rightZone = state.rightLockedZone ?? state.lastRightHandZone;
          const rightParams = getZoneParams(profile, "right", rightZone);
          if (rightParams) {
            state.rightState = monitoringTriggerConditions(
              state.rightState,
              state.rightThighCordon,
              rightParams.PF_HIT     + rightKneeAdj, // ← 提膝時門檻跟著升高
              rightParams.PF_RELEASE + rightKneeAdj, // ← 確保 release 條件一致
              webTimeMs,
              rightParams.COOLDOWN_MS,
              rightHandSpeed,
              rightParams.SPEED_HIT,
            );
          }

          // ── 左手：動態門檻 hit 判斷（疊加膝蓋補償）──
          const leftZone = state.leftLockedZone ?? state.lastLeftHandZone;
          const leftParams = getZoneParams(profile, "left", leftZone);
          if (leftParams) {
            state.leftState = monitoringTriggerConditions(
              state.leftState,
              state.leftThighCordon,
              leftParams.PF_HIT     + leftKneeAdj, // ← 提膝時門檻跟著升高
              leftParams.PF_RELEASE + leftKneeAdj, // ← 確保 release 條件一致
              webTimeMs,
              leftParams.COOLDOWN_MS,
              leftHandSpeed,
              leftParams.SPEED_HIT,
            );
          }

          // ==============================================================================
          // Knee kick conditions
          // ── Knee kick hit 判斷（history 已在 guard 外累積，這裡只做判斷）──
          const leftKneeMetrics = summarizeKneeMotion(state.leftKneeHistory);
          const rightKneeMetrics = summarizeKneeMotion(state.rightKneeHistory);

          if (leftKneeMetrics) {
            state.leftKneeState = monitoringKneeKickConditions(
              state.leftKneeState,
              leftKneeMetrics,
              webTimeMs,
              getKneeThresholds(profile, "left"),
            );
          }

          if (rightKneeMetrics) {
            state.rightKneeState = monitoringKneeKickConditions(
              state.rightKneeState,
              rightKneeMetrics,
              webTimeMs,
              getKneeThresholds(profile, "right"),
            );
          }
        }

        // 未校準時：不執行手部 / 膝蓋打擊偵測，不發聲
        // 手部命中：使用鎖定的 zone 播放音效，觸發後解鎖。
        if (state.leftState.didHit) {
          const zone = state.leftLockedZone ?? state.lastLeftHandZone;
          playZone("left", zone, zoneSound);
          frameHits.push({ side: "left", zoneId: zone, source: "hand" });
          if (zoneSound[`left_${zone}`] !== "none") {
            _fx.pushHandHit({
              side: "left",
              zone,
              hip: pickedLeftHand[0],
              hand: pickedLeftHand[1],
              knee: pickedLeftHand[2],
              strength: Math.min(1, leftHandSpeed * 2),
              getVideoDrawRect,
            });
          }
          state.lastLeftHandZone = zone;
          state.leftZoneLocked = false;
          state.leftLockedZone = null;
        }

        if (state.rightState.didHit) {
          const zone = state.rightLockedZone ?? state.lastRightHandZone;
          playZone("right", zone, zoneSound);
          frameHits.push({ side: "right", zoneId: zone, source: "hand" });
          if (zoneSound[`right_${zone}`] !== "none") {
            _fx.pushHandHit({
              side: "right",
              zone,
              hip: pickedRightHand[0],
              hand: pickedRightHand[1],
              knee: pickedRightHand[2],
              strength: Math.min(1, rightHandSpeed * 2),
              getVideoDrawRect,
            });
          }
          state.lastRightHandZone = zone;
          state.rightZoneLocked = false;
          state.rightLockedZone = null;
        }

        if (state.leftKneeState.didHit) {
          playZone("left", state.leftKneeState.zoneId, zoneSound);
          frameHits.push({
            side: "left",
            zoneId: state.leftKneeState.zoneId,
            source: "knee",
          });
          if (zoneSound[`left_${state.leftKneeState.zoneId}`] !== "none") {
            _fx.pushKneeHit({
              side: "left",
              knee: leftKnee,
              strength: 0.85,
              getVideoDrawRect,
            });
          }
        }

        if (state.rightKneeState.didHit) {
          playZone("right", state.rightKneeState.zoneId, zoneSound);
          frameHits.push({
            side: "right",
            zoneId: state.rightKneeState.zoneId,
            source: "knee",
          });
          if (zoneSound[`right_${state.rightKneeState.zoneId}`] !== "none") {
            _fx.pushKneeHit({
              side: "right",
              knee: rightKnee,
              strength: 0.85,
              getVideoDrawRect,
            });
          }
        }

        if (frameHits.length > 0) {
          onHit?.(frameHits);
        }

        _fx.draw(canvasCtx, webTimeMs);

        state.prevLeftKnee = leftKnee;
        state.prevRightKnee = rightKnee;
      });
    }

    state.rafId = requestAnimationFrame(predictWebcam);
  }

  return predictWebcam;
}