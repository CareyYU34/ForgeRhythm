import {
  monitoringKneeKickConditions,
  monitoringTriggerConditions,
} from "./conditions.js";
import {
  handBasePointFromPoseLandmarks,
  isStrictlyNormalizedPoint,
  pushPointHistory,
  summarizeKneeMotion,
  thighLineDistance,
} from "./math.js";
import { calcKneeRisingAdj, getZoneParams } from "./calibrationProfile.js";
import { createHitEffectManager } from "./hitEffects.js";
import { perfLog } from "./perfLog.js";

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

const KNEE_HISTORY_SIZE = 5;

// 手部觸發區已固定為大腿正面，不再依進入方向分辨 front / outer / inner。
// 保留 zone 這一層抽象是因為膝蓋仍使用 "heel"，音色表的 key 格式維持 `${side}_${zoneId}`。
const HAND_ZONE = "front";

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
    // 預設全身節點 + 隱藏鏡頭畫面（黑底），人體以節點呈現。
    drawPoseDebugEnabled: true,
    showCameraFeed: false,
    showPFOverlay: false,

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
  "showCameraFeed",
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
  return "#4dff88"; // 武裝區（綠）：PF 回到 PF_HIT 之上即重新武裝
}

// 安全地取得 zone 參數，沒有就回 null（避免 import 再一次）
function getZoneParamsIfAvailable(profile, side, zone) {
  try {
    return getZoneParams(profile, side, zone);
  } catch {
    return null;
  }
}

/**
 * 將 normalized 座標轉為 canvas px
 */
function toCanvasPx(pt, rect) {
  return {
    x: rect.x + pt.x * rect.width,
    y: rect.y + pt.y * rect.height,
  };
}

/**
 * 繪製單側的 PF 幾何線段：
 *   ① 大腿基準線（hip → knee）
 *   ② PF 線段（hand → F）
 *   ③ 垂足點 F（小圓點）
 *
 * 每幀都執行，不節流（座標需即時跟隨動作）。
 * 顏色沿用 pickPFColor 的紅/黃/綠，與數字 overlay 一致。
 */
function drawPFGeometry({ canvasCtx, hip, knee, hand, F, color, rect }) {
  if (!hip || !knee || !hand || !F) return;

  const hipPx = toCanvasPx(hip, rect);
  const kneePx = toCanvasPx(knee, rect);
  const handPx = toCanvasPx(hand, rect);
  const fPx = toCanvasPx(F, rect);

  canvasCtx.save();

  // ① 大腿基準線（hip → knee）：半透明白色細線
  canvasCtx.beginPath();
  canvasCtx.moveTo(hipPx.x, hipPx.y);
  canvasCtx.lineTo(kneePx.x, kneePx.y);
  canvasCtx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  canvasCtx.lineWidth = 1.5;
  canvasCtx.stroke();

  // ② PF 線段（hand → F）：以 PF 狀態顏色繪製
  canvasCtx.beginPath();
  canvasCtx.moveTo(handPx.x, handPx.y);
  canvasCtx.lineTo(fPx.x, fPx.y);
  canvasCtx.strokeStyle = color;
  canvasCtx.lineWidth = 2.5;
  canvasCtx.stroke();

  // ③ 垂足點 F：同色小圓點 + 黑色描邊增加辨識度
  canvasCtx.beginPath();
  canvasCtx.arc(fPx.x, fPx.y, 4, 0, Math.PI * 2);
  canvasCtx.fillStyle = color;
  canvasCtx.strokeStyle = "rgba(0, 0, 0, 0.6)";
  canvasCtx.lineWidth = 1;
  canvasCtx.fill();
  canvasCtx.stroke();

  canvasCtx.restore();
}

function drawPFOverlay({
  canvasCtx,
  leftHandPt,
  rightHandPt,
  leftHip,
  leftKnee,
  rightHip,
  rightKnee,
  leftF,
  rightF,
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
      HAND_ZONE,
    );
    _pfDisplayCache.rightColor = pickPFColor(
      rightPF,
      state.calibrationProfile,
      "right",
      HAND_ZONE,
    );
    _pfDisplayCache.lastUpdateMs = nowMs;
  }

  // ── PF 幾何線段（每幀繪製，不節流）──
  drawPFGeometry({
    canvasCtx,
    hip: leftHip,
    knee: leftKnee,
    hand: leftHandPt,
    F: leftF,
    color: _pfDisplayCache.leftColor,
    rect,
  });
  drawPFGeometry({
    canvasCtx,
    hip: rightHip,
    knee: rightKnee,
    hand: rightHandPt,
    F: rightF,
    color: _pfDisplayCache.rightColor,
    rect,
  });

  // ── 數字文字（節流後繪製）──
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
  onFrame,
  hitEffectManager,
}) {
  const _fx = hitEffectManager ?? createHitEffectManager();

  // ── 診斷：相機影格的拍攝時間（只在本地端掛，線上零開銷）──
  // requestVideoFrameCallback 在同一幀的 rAF 之前觸發，所以 pose loop 讀到的
  // _vf.last 就是當下 video.currentTime 那一格。captureTime 瀏覽器不一定提供（null）。
  const _vf = { last: null };
  if (
    perfLog.isLocal() &&
    typeof video.requestVideoFrameCallback === "function"
  ) {
    const onVideoFrame = (_now, meta) => {
      _vf.last = meta;
      video.requestVideoFrameCallback(onVideoFrame);
    };
    video.requestVideoFrameCallback(onVideoFrame);
  }

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
        // 診斷用時間點：推論完成、該格相機拍攝時間（perfLog 延遲時間軸）
        const detEndMs = performance.now();
        const capT = _vf.last?.captureTime ?? null;
        canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

        if (result.landmarks.length === 0) return;

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
        state.emaLeftHip = emaPoint(
          state.emaLeftHip,
          leftHip,
          HIP_KNEE_EMA_ALPHA,
        );
        state.emaRightHip = emaPoint(
          state.emaRightHip,
          rightHip,
          HIP_KNEE_EMA_ALPHA,
        );
        state.emaLeftKnee = emaPoint(
          state.emaLeftKnee,
          leftKnee,
          HIP_KNEE_EMA_ALPHA,
        );
        state.emaRightKnee = emaPoint(
          state.emaRightKnee,
          rightKnee,
          HIP_KNEE_EMA_ALPHA,
        );

        // 用平滑後的 hip/knee 取代原始值，供 thighLineDistance 計算；
        // handBase 仍使用原始值（手部自己有 PF_SMOOTH_ALPHA 平滑）。
        const smoothedLeftHand = [
          state.emaLeftHip,
          leftHandBase,
          state.emaLeftKnee,
        ];
        const smoothedRightHand = [
          state.emaRightHip,
          rightHandBase,
          state.emaRightKnee,
        ];

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
            // EMA 平滑後的 hip / knee，與 thighLineDistance 使用的來源一致
            leftHip: state.emaLeftHip ?? leftHip,
            leftKnee: state.emaLeftKnee ?? leftKnee,
            rightHip: state.emaRightHip ?? rightHip,
            rightKnee: state.emaRightKnee ?? rightKnee,
            // F 點來自 thighLineDistance 的新回傳值
            leftF: state.leftThighCordon?.F ?? null,
            rightF: state.rightThighCordon?.F ?? null,
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
        // 手部不再需要 history：zone 已固定為 front，速度用前後兩點即可算出。

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

          // ── 膝蓋上升補償量（每幀計算，用平滑後的 knee y）──
          // 提膝時 emaKnee.y < kneeBaseline.y，calcKneeRisingAdj 回傳正值。
          // 這個補償量疊加到 PF_HIT（同時也是重新武裝線），
          // 讓大腿線旋轉造成的 PF 幾何漂移無法穿越門檻，防止誤觸發。
          const leftKneeAdj = calcKneeRisingAdj(
            profile,
            "left",
            state.emaLeftKnee?.y ?? leftKnee.y,
          );
          const rightKneeAdj = calcKneeRisingAdj(
            profile,
            "right",
            state.emaRightKnee?.y ?? rightKnee.y,
          );

          // 註：重新武裝（PF > PF_HIT）與下擊段峰值速度追蹤都內建在
          // monitoringTriggerConditions 中，這裡只負責餵門檻與單幀手速。

          // ── 右手：動態門檻 hit 判斷（疊加膝蓋補償）──
          const rightParams = getZoneParams(profile, "right", HAND_ZONE);
          if (rightParams) {
            state.rightState = monitoringTriggerConditions(
              state.rightState,
              state.rightThighCordon,
              rightParams.PF_HIT + rightKneeAdj, // ← 提膝時門檻跟著升高
              webTimeMs,
              rightParams.COOLDOWN_MS,
              rightHandSpeed,
              rightParams.SPEED_HIT,
            );
          }

          // ── 左手：動態門檻 hit 判斷（疊加膝蓋補償）──
          const leftParams = getZoneParams(profile, "left", HAND_ZONE);
          if (leftParams) {
            state.leftState = monitoringTriggerConditions(
              state.leftState,
              state.leftThighCordon,
              leftParams.PF_HIT + leftKneeAdj, // ← 提膝時門檻跟著升高
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

          // ⚠ 提到判斷之前取好，diagnostics 也要記這份「當下的膝蓋標準」。
          const leftKneeThr = getKneeThresholds(profile, "left");
          const rightKneeThr = getKneeThresholds(profile, "right");

          if (leftKneeMetrics) {
            state.leftKneeState = monitoringKneeKickConditions(
              state.leftKneeState,
              leftKneeMetrics,
              webTimeMs,
              leftKneeThr,
            );
          }

          if (rightKneeMetrics) {
            state.rightKneeState = monitoringKneeKickConditions(
              state.rightKneeState,
              rightKneeMetrics,
              webTimeMs,
              rightKneeThr,
            );
          }

          // ── 診斷紀錄（本地端、演奏中才收）──
          // 放在本區塊末端，才拿得到本幀計算出的門檻與膝蓋補償量。
          if (perfLog.isActive()) {
            const r2 = (v) => (v == null ? null : +v.toFixed(4));

            // 觸發標準參考（靜態門檻，只記一次）。動態門檻（會被 adaptiveMonitor
            // 漂移的：手 PF_HIT、膝 windowDropHit/Release）逐幀記在下面。
            if (perfLog.needsStandards()) {
              const handStd = (p) =>
                p
                  ? {
                      PF_HIT: p.PF_HIT,
                      SPEED_HIT: p.SPEED_HIT,
                      COOLDOWN_MS: p.COOLDOWN_MS,
                    }
                  : null;
              perfLog.setStandards({
                note: "手 pfHit 逐幀記（含提膝補償，同時是重新武裝線）；手速門檻比對下擊段峰值 spPk；膝 kDropHit/kDropRel 逐幀記。其餘為靜態標準。",
                hand: { left: handStd(leftParams), right: handStd(rightParams) },
                knee: { left: leftKneeThr, right: rightKneeThr },
              });
            }

            perfLog.frame({
              t: Math.round(webTimeMs),
              det: Math.round(detEndMs - webTimeMs), // 推論耗時（ms）
              age: capT != null ? Math.round(detEndMs - capT) : null, // 相機拍到 → 推論完成（ms）

              // ── 手：實測 vs 當下門檻 ──
              pfL: r2(state.leftThighCordon?.PF),
              pfR: r2(state.rightThighCordon?.PF),
              spL: r2(leftHandSpeed),
              spR: r2(rightHandSpeed),
              spPkL: r2(state.leftState?.strokeSpeedMax),
              spPkR: r2(state.rightState?.strokeSpeedMax),
              armL: !!state.leftState?.canHit,
              armR: !!state.rightState?.canHit,
              pfHitL: leftParams ? r2(leftParams.PF_HIT + leftKneeAdj) : null,
              pfHitR: rightParams ? r2(rightParams.PF_HIT + rightKneeAdj) : null,
              spHitL: leftParams ? leftParams.SPEED_HIT : null,
              spHitR: rightParams ? rightParams.SPEED_HIT : null,
              kAdjL: r2(leftKneeAdj),
              kAdjR: r2(rightKneeAdj),

              // ── 膝：實測（湊齊 conditions.js 比對的所有量）──
              kneeDyL: r2(leftKneeMetrics?.windowDy),
              kneeDyR: r2(rightKneeMetrics?.windowDy),
              kneeSpL: r2(leftKneeMetrics?.avgDownSpeed),
              kneeSpR: r2(rightKneeMetrics?.avgDownSpeed),
              kneePkL: r2(leftKneeMetrics?.maxDownSpeed),
              kneePkR: r2(rightKneeMetrics?.maxDownSpeed),
              kneeDxL: r2(leftKneeMetrics?.windowDx),
              kneeDxR: r2(rightKneeMetrics?.windowDx),
              kneeXyL: r2(leftKneeMetrics?.xyRatio),
              kneeXyR: r2(rightKneeMetrics?.xyRatio),
              kneeDfrL: r2(leftKneeMetrics?.downFrameRatio),
              kneeDfrR: r2(rightKneeMetrics?.downFrameRatio),

              // ── 膝：動態門檻（adaptiveMonitor 會漂移）+ 武裝狀態 ──
              kDropHitL: r2(leftKneeThr?.windowDropHit),
              kDropHitR: r2(rightKneeThr?.windowDropHit),
              kDropRelL: r2(leftKneeThr?.windowDropRelease),
              kDropRelR: r2(rightKneeThr?.windowDropRelease),
              kArmL: !!state.leftKneeState?.canHit,
              kArmR: !!state.rightKneeState?.canHit,
            });
          }
        }

        // 未校準時：不執行手部 / 膝蓋打擊偵測，不發聲
        // ── 打擊派發：記錄 → 發聲 → 特效 ──
        // ⚠ perfLog.hit 必須在 playZone 之前：audioEngine 在 playZone 內呼叫
        //   perfLog.noteSound，只有「派發期」（hit → endDispatch）才會掛到這一擊。
        const animTimings = []; // 本幀有特效的打擊紀錄，畫完後補上動畫時機
        const dispatchHit = (side, zoneId, extra, timingExtra, pushFx) => {
          const rec = perfLog.isActive()
            ? perfLog.hit({
                side,
                zone: zoneId,
                t: Math.round(webTimeMs),
                ...extra,
                timing: {
                  capT,
                  frameT: webTimeMs,
                  detEndT: detEndMs,
                  trigT: performance.now(),
                  ...timingExtra,
                },
              })
            : null;
          playZone(side, zoneId, zoneSound);
          perfLog.endDispatch();
          if (zoneSound[`${side}_${zoneId}`] !== "none" && pushFx() && rec) {
            animTimings.push(rec.timing);
          }
        };

        // 手部命中：觸發區固定為大腿正面。
        for (const [side, handState, cordon, picked] of [
          ["left", state.leftState, state.leftThighCordon, pickedLeftHand],
          ["right", state.rightState, state.rightThighCordon, pickedRightHand],
        ]) {
          if (!handState.didHit) continue;
          const handSpeed = side === "left" ? leftHandSpeed : rightHandSpeed;
          dispatchHit(
            side,
            HAND_ZONE,
            {
              pf: cordon?.PF ?? null,
              speed: +(handState.hitStrokeSpeed ?? 0).toFixed(4), // 下擊段峰值（= 與 SPEED_HIT 比對的值）
            },
            { crossT: handState.hitCrossMs ?? null, gapMs: handState.hitGapMs ?? null },
            () =>
              _fx.pushHandHit({
                side,
                zone: HAND_ZONE,
                hip: picked[0],
                hand: picked[1],
                knee: picked[2],
                strength: Math.min(1, handSpeed * 2),
                getVideoDrawRect,
              }),
          );
        }

        for (const [side, kneeState, knee] of [
          ["left", state.leftKneeState, leftKnee],
          ["right", state.rightKneeState, rightKnee],
        ]) {
          if (!kneeState.didHit) continue;
          dispatchHit(side, kneeState.zoneId, {}, {}, () =>
            _fx.pushKneeHit({
              side,
              knee,
              strength: 0.85,
              getVideoDrawRect,
            }),
          );
        }

        _fx.draw(canvasCtx, webTimeMs);

        // 動畫時機：畫進 canvas 的時間 + 下一個 rAF 時間戳（≈ 這一幀被呈現到螢幕）
        if (animTimings.length) {
          const drawnT = performance.now();
          for (const tm of animTimings) tm.animDrawT = drawnT;
          requestAnimationFrame((ts) => {
            for (const tm of animTimings) tm.animShowT = ts;
          });
        }

        state.prevLeftKnee = leftKnee;
        state.prevRightKnee = rightKnee;
      });
    }

    state.rafId = requestAnimationFrame(predictWebcam);
  }

  return predictWebcam;
}