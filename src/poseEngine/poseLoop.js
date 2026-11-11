import {
  KNEE_THRESHOLDS_DEFAULT,
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
import { calcKneeRisingAdj, getZoneParams, TUNING } from "./calibrationProfile.js";
import { createHitEffectManager } from "./hitEffects.js";
import { createAccentPose } from "./accentPose.js";
import { perfLog } from "./perfLog.js";

import { PALETTE, lighten } from "./palette.js";

// ── 霓虹光管骨架 ──
// 只畫軀幹框、頭圈、四肢與手心；臉部細點、手指、腳掌不畫（太碎，看起來像散落的釘子）。
const NEON_TORSO = [
  [11, 12],
  [12, 24],
  [24, 23],
  [23, 11],
];
const NEON_LIMBS = [
  { side: "left", part: "arm", segs: [[11, 13], [13, 15]] },
  { side: "right", part: "arm", segs: [[12, 14], [14, 16]] },
  { side: "left", part: "leg", segs: [[23, 25], [25, 27]] },
  { side: "right", part: "leg", segs: [[24, 26], [26, 28]] },
];
// 由外而內三層：[線寬 × 肩寬, 透明度]。最後一層是白熱芯。
// 光暈用半透明寬線疊出來，不用 shadowBlur（每條線都要模糊一次，pose loop 吃不起）。
const NEON_LAYERS = [
  [0.42, 0.07],
  [0.22, 0.18],
  [0.075, 0.95],
];
// 打擊後該段光管變亮變粗，NEON_FLARE_MS 內退回
const NEON_FLARE_MS = 300;
// 肩膀看不到時的肩寬退回值（× 畫面寬）
const NEON_SCALE_FALLBACK = 0.2;

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

// 膝蓋短時間窗長度（秒）。≈ 舊版 30fps 下 5 幀（4 段 × 33ms），改以時間定義後不隨幀率變。
const KNEE_WINDOW_SEC = 0.14;

// ── 手擊遮罩膝蓋 ──
// 同側手落到大腿（strikeLandMs）或觸發（lastHitMs）後這段時間內，該側膝蓋不准觸發。
// 實測（poseLog 2026-10-30）：沒抬膝卻觸發的 17 次膝蓋打擊，有 15 次落在同側手打擊後
// 0–170ms，另 2 次是手落了地但沒觸發；另有幾次膝蓋在手還在半空下擊時就先掉了
// （strikeDescending 也算遮罩）。膝蓋節點跟著手上下動（手抬膝也抬、手拍膝就掉），
// 雙膝收攏時手落點貼近膝蓋，最嚴重。只擋同側：異側手膝組合不受影響。
// 遮罩期間膝蓋強制解除武裝，遮罩結束後要先回穩（windowDy ≤ release）才能再觸發，
// 避免遮罩一結束就把視窗裡殘留的下掉量打出去。
const KNEE_HAND_MASK_MS = 250;

// ── 身體尺度（肩寬）：膝蓋位移 / 速度的正規化分母 ──
// 慢速 EMA：肩寬只隨人離鏡頭遠近緩慢變化，不需要即時跟。
const BODY_SCALE_EMA_ALPHA = 0.1;
// 尚未量到肩寬時的退回值（校準紀錄 shoulderWidth 平均 ≈ 0.2）
const BODY_SCALE_FALLBACK = 0.2;
const LEFT_SHOULDER = 11;
const RIGHT_SHOULDER = 12;

/** 以肩寬更新 state.bodyScale；肩膀不可見的幀維持舊值（不參與 skipPoints，不中斷判斷） */
function updateBodyScale(state, landmarks, visThreshold) {
  const ls = landmarks[LEFT_SHOULDER];
  const rs = landmarks[RIGHT_SHOULDER];
  for (const p of [ls, rs]) {
    if (!isStrictlyNormalizedPoint(p)) return;
    if ((p.visibility ?? 1) < visThreshold) return;
  }
  const width = Math.hypot(ls.x - rs.x, ls.y - rs.y);
  if (width < 1e-3) return;
  state.bodyScale =
    state.bodyScale == null
      ? width
      : BODY_SCALE_EMA_ALPHA * width + (1 - BODY_SCALE_EMA_ALPHA) * state.bodyScale;
}

// 手部觸發區已固定為大腿正面，不再依進入方向分辨 front / outer / inner。
// 保留 zone 這一層抽象是因為膝蓋仍使用 "heel"，音色表的 key 格式維持 `${side}_${zoneId}`。
const HAND_ZONE = "front";

/**
 * 取得膝蓋閾值（預設值見 conditions.js:KNEE_THRESHOLDS_DEFAULT）：
 * profile 有 knee 欄位時用動態值覆蓋 windowDropHit/windowDropRelease，
 * windowDropStrongHit 隨 windowDropHit 等比縮放（adaptiveMonitor 只調 windowDropHit 一個旋鈕），
 * 其餘欄位使用靜態預設。
 */
function getKneeThresholds(profile, side) {
  const base = KNEE_THRESHOLDS_DEFAULT;
  if (!profile?.knee?.[side]) return base;
  const k = profile.knee[side];
  return {
    ...base,
    windowDropHit: k.windowDropHit,
    windowDropRelease: k.windowDropRelease,
    windowDropStrongHit:
      base.windowDropStrongHit * (k.windowDropHit / base.windowDropHit),
  };
}

function skipPoints(points, threshold) {
  for (const p of points) {
    if (!isStrictlyNormalizedPoint(p)) return true;
    if ((p.visibility ?? 1) < threshold) return true;
  }
  return false;
}

/** 每一側在 state 上的欄位名（逐側清除用） */
const SIDE_KEYS = {
  left: {
    prevHand: "prevLeftHand",
    cordon: "leftThighCordon",
    hand: "leftState",
    kneeHistory: "leftKneeHistory",
    knee: "leftKneeState",
    emaHip: "emaLeftHip",
    emaKnee: "emaLeftKnee",
  },
  right: {
    prevHand: "prevRightHand",
    cordon: "rightThighCordon",
    hand: "rightState",
    kneeHistory: "rightKneeHistory",
    knee: "rightKneeState",
    emaHip: "emaRightHip",
    emaKnee: "emaRightKnee",
  },
};

/**
 * 該側手這幀不能判斷（手掌或髖看不到）：清掉速度來源與 PF，並解除武裝。
 * 下擊段峰值、strikeDescending 一併歸零 —— 否則手消失前的殘值會讓手一出現就觸發，
 * 或讓 strikeDescending 卡在 true、把同側膝蓋一直遮罩住。
 * lastHitMs / strikeLandMs 保留：冷卻與膝蓋遮罩照時間自然過期。
 */
function clearHandTracking(state, side) {
  const k = SIDE_KEYS[side];
  state[k.prevHand] = null;
  state[k.cordon] = null;
  state[k.hand] = {
    ...state[k.hand],
    didHit: false,
    canHit: false,
    strokePeakPF: null,
    strokeSpeedMax: 0,
    strikeDescending: false,
    belowSinceMs: null,
  };
}

/** 該側膝蓋這幀看不到：清掉膝蓋 history 與 EMA，避免髒資料延續到下一幀 */
function clearKneeTracking(state, side) {
  const k = SIDE_KEYS[side];
  state[k.kneeHistory] = [];
  state[k.emaKnee] = null;
  state[k.knee] = { ...state[k.knee], didHit: false };
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
    leftKneeHistory: [],
    rightKneeHistory: [],
    bodyScale: null, // 肩寬 EMA（膝蓋特徵的正規化分母；null = 尚未量到，用 BODY_SCALE_FALLBACK）
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
    // 膝蓋觸發開關：false = 膝蓋完全不判斷、不產生任何打擊事件
    //（adaptiveMonitor 的膝蓋自適應也暫停，避免關閉期間門檻被調動）
    kneeTriggerEnabled: false,

    // ── 校準 profile（null = 未校準，不發聲）──
    calibrationProfile: null,
    _calibrationLogged: false, // main.js：本次校準結果是否已轉成 profile

    // ── Hip / Knee EMA 平滑儲存（null = 尚未初始化，下一幀直接採用原始值）──
    emaLeftHip: null,
    emaRightHip: null,
    emaLeftKnee: null,
    emaRightKnee: null,

    // ── 膝蓋靜止基準 y（adaptiveMonitor 動態追蹤；null = 尚未量到，退回 profile.kneeBaseline）──
    kneeRestY: null, // { left, right }
  };
}

// ── 使用者偏好欄位：不應該在鏡頭重開時被重置 ──
// 只留「顯示 / 開關」類偏好。visibilityThreshold、calibrationProfile 不留：
// 兩者都會被 adaptiveMonitor 一路漂移（可見度閾值、PF_HIT、膝蓋門檻），
// 重開鏡頭要和重新整理網頁一樣從頭來（冷啟動重新套預設 profile）。
const USER_PREFERENCE_KEYS = [
  "drawPoseDebugEnabled",
  "showCameraFeed",
  "showPFOverlay",
  "kneeTriggerEnabled",
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
  if (pf < params.PF_HIT + TUNING.PF_HIT_SLACK) return "#ff4d4d"; // 打擊區（紅）
  return "#4dff88"; // 武裝區（綠）：PF 回到判定線之上即重新武裝
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

/** perfLog 用：把 accentPose 的診斷狀態攤平成逐幀欄位（acc* = 手，accK* = 膝） */
function accentDebugFields(dbg, r2) {
  const fields = {
    accOn: dbg.target ? +!!dbg.target.left + "" + +!!dbg.target.right : null, // "10" = 左手要、右手不要
    accPick: dbg.pick ? +!!dbg.pick.left + "" + +!!dbg.pick.right : null,
    accKOn: dbg.target ? +!!dbg.target.leftKnee + "" + +!!dbg.target.rightKnee : null,
    accGate: r2(dbg.gate),
  };
  for (const [s, side] of [
    ["L", "left"],
    ["R", "right"],
  ]) {
    const h = dbg.hand[side];
    const k = dbg.knee[side];
    fields[`accBlend${s}`] = h ? r2(h.blend) : null;
    fields[`accVis${s}`] = h ? h.vis : null;
    fields[`accRise${s}`] = h ? r2(h.rise) : null;
    fields[`accLift${s}`] = h ? r2(h.lift) : null;
    fields[`accKBlend${s}`] = k ? r2(k.blend) : null;
    fields[`accKRise${s}`] = k ? r2(k.rise) : null;
    fields[`accKLift${s}`] = k ? r2(k.lift) : null;
  }
  return fields;
}

const neonRgba = ([r, g, b], a) => `rgba(${r},${g},${b},${Math.min(1, a).toFixed(3)})`;
const mixColor = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

/**
 * 霓虹光管骨架。顏色全部取自 palette.js（與 hitEffects 同一份）。
 *
 * @param {Function} [adjustPoints]  畫之前改像素座標副本（重音抬手，見 accentPose.js）。
 *   ⚠ 只影響畫面，landmarks 本身不動。
 * @param {Object} [flareMs]  { "left-arm": 打擊時間, "right-leg": ... }，打到的那段光管閃一下
 * @param {number} [nowMs]
 */
function drawPoseLandmarks(
  landmarks,
  canvasCtx,
  getVideoDrawRect,
  visibilityThreshold,
  adjustPoints,
  flareMs = {},
  nowMs = 0,
) {
  const rect = getVideoDrawRect();
  const points = landmarks.map((landmark) => ({
    x: rect.x + landmark.x * rect.width,
    y: rect.y + landmark.y * rect.height,
    visibility: landmark.visibility ?? 1,
  }));
  adjustPoints?.(points);

  const ok = (...ids) =>
    ids.every((i) => points[i] && points[i].visibility >= visibilityThreshold);

  // 線寬以肩寬為尺度：人離鏡頭遠近不同，光管粗細跟著身體比例走
  const S = ok(11, 12)
    ? Math.hypot(points[11].x - points[12].x, points[11].y - points[12].y)
    : rect.width * NEON_SCALE_FALLBACK;

  const flare = {};
  for (const key in flareMs) {
    flare[key] = Math.max(0, 1 - (nowMs - flareMs[key]) / NEON_FLARE_MS) ** 2;
  }

  const stroke = (a, b) => {
    canvasCtx.beginPath();
    canvasCtx.moveTo(points[a].x, points[a].y);
    canvasCtx.lineTo(points[b].x, points[b].y);
    canvasCtx.stroke();
  };

  // 頭圈：兩耳中點為圓心
  const head = ok(7, 8)
    ? {
        x: (points[7].x + points[8].x) / 2,
        y: (points[7].y + points[8].y) / 2,
        r: Math.hypot(points[7].x - points[8].x, points[7].y - points[8].y) * 0.62,
      }
    : null;

  canvasCtx.save();
  canvasCtx.lineCap = "round";
  canvasCtx.lineJoin = "round";
  // 疊加混色：光暈重疊處變亮，像真的光
  canvasCtx.globalCompositeOperation = "lighter";

  NEON_LAYERS.forEach(([width, alpha], li) => {
    const core = li === NEON_LAYERS.length - 1;

    canvasCtx.lineWidth = S * width;
    canvasCtx.strokeStyle = neonRgba(
      core ? lighten(PALETTE.body, 0.6) : PALETTE.body,
      alpha,
    );
    for (const [a, b] of NEON_TORSO) if (ok(a, b)) stroke(a, b);
    if (head) {
      canvasCtx.beginPath();
      canvasCtx.arc(head.x, head.y, head.r, 0, Math.PI * 2);
      canvasCtx.stroke();
    }

    for (const limb of NEON_LIMBS) {
      const fl = flare[`${limb.side}-${limb.part}`] ?? 0;
      // 膝蓋觸發時腿轉成膝蓋色，和 kick 特效對上
      const color =
        limb.part === "leg" && fl > 0
          ? mixColor(PALETTE[limb.side], PALETTE.knee, fl)
          : PALETTE[limb.side];
      canvasCtx.lineWidth = S * width * (1 + 0.45 * fl);
      canvasCtx.strokeStyle = core
        ? neonRgba(lighten(color, 0.55 + 0.4 * fl), alpha)
        : neonRgba(color, alpha * (1 + 2.2 * fl));
      for (const [a, b] of limb.segs) if (ok(a, b)) stroke(a, b);
    }
  });

  // 手心：手部打擊點（pinky + index 中點，與 handBasePointFromPoseLandmarks 一致）
  for (const [side, pinky, index] of [
    ["left", 17, 19],
    ["right", 18, 20],
  ]) {
    if (!ok(pinky, index)) continue;
    const hx = (points[pinky].x + points[index].x) / 2;
    const hy = (points[pinky].y + points[index].y) / 2;
    const fl = flare[`${side}-arm`] ?? 0;
    canvasCtx.fillStyle = neonRgba(PALETTE[side], 0.25 + 0.3 * fl);
    canvasCtx.beginPath();
    canvasCtx.arc(hx, hy, S * (0.17 + 0.08 * fl), 0, Math.PI * 2);
    canvasCtx.fill();
    canvasCtx.fillStyle = "rgba(255,255,255,0.95)";
    canvasCtx.beginPath();
    canvasCtx.arc(hx, hy, S * 0.06, 0, Math.PI * 2);
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
  getAccentTarget,
}) {
  const _fx = hitEffectManager ?? createHitEffectManager();
  // 重音抬手：getAccentTarget() → { left, right }（各手是否放大）；沒傳就不放大
  const _accent = createAccentPose();
  // 霓虹骨架閃光：{ "left-arm": 打擊時間 }。純畫面用，不放進 state。
  // 打擊派發在畫骨架之後，所以閃光從下一幀開始（差一幀，看不出來）。
  const _flareMs = {};

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
            getAccentTarget &&
              ((points) =>
                _accent.apply(
                  points,
                  getAccentTarget(),
                  webTimeMs,
                  state.visibilityThreshold,
                  { left: state.leftState, right: state.rightState },
                )),
            _flareMs,
            webTimeMs,
          );
        }

        // 關鍵點失真或可見度不足 → 逐側、逐部位清掉 history，避免髒資料延續到下一幀。
        //   膝蓋只看膝點；手要膝 + 髖 + 手掌都在（PF 以髖→膝的大腿線為基準）。
        // ⚠ 不能整幀 return：舊版三點綁在一起，手掌一出畫面（舉手、被身體擋住），
        //   雙膝 history 每幀被清空、永遠湊不滿視窗 → 膝蓋跟著觸發不了。
        const vis = state.visibilityThreshold;
        const hipOk = {
          left: !skipPoints([leftHip], vis),
          right: !skipPoints([rightHip], vis),
        };
        const kneeOk = {
          left: !skipPoints([leftKnee], vis),
          right: !skipPoints([rightKnee], vis),
        };
        const handOk = {
          left: kneeOk.left && hipOk.left && !skipPoints([leftHandBase], vis),
          right: kneeOk.right && hipOk.right && !skipPoints([rightHandBase], vis),
        };
        for (const side of ["left", "right"]) {
          if (!hipOk[side]) state[SIDE_KEYS[side].emaHip] = null;
          if (!kneeOk[side]) clearKneeTracking(state, side);
          if (!handOk[side]) clearHandTracking(state, side);
        }
        if (!kneeOk.left && !kneeOk.right) return; // 兩邊都沒有可判斷的部位

        // ── Hip / Knee EMA 平滑（同 PF 的 EMA 邏輯，減少 landmark 抖動對 PF 的影響）──
        if (hipOk.left) {
          state.emaLeftHip = emaPoint(state.emaLeftHip, leftHip, HIP_KNEE_EMA_ALPHA);
        }
        if (hipOk.right) {
          state.emaRightHip = emaPoint(state.emaRightHip, rightHip, HIP_KNEE_EMA_ALPHA);
        }
        if (kneeOk.left) {
          state.emaLeftKnee = emaPoint(state.emaLeftKnee, leftKnee, HIP_KNEE_EMA_ALPHA);
        }
        if (kneeOk.right) {
          state.emaRightKnee = emaPoint(state.emaRightKnee, rightKnee, HIP_KNEE_EMA_ALPHA);
        }

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
          if (handOk.left) drawPose(pickedLeftHand, canvasCtx, getVideoDrawRect);
          if (handOk.right) drawPose(pickedRightHand, canvasCtx, getVideoDrawRect);
        }

        // 這一段保留原本手部命中判斷需要的單幀資料。
        // 手不能判斷的一側：cordon / prevHand 已由 clearHandTracking 清為 null。
        const dtSec = Math.max(1e-4, videoTimeSec - state.preSec);
        const prevLeftHandPt = state.prevLeftHand;
        const prevRightHandPt = state.prevRightHand;

        if (handOk.left) {
          state.leftThighCordon = thighLineDistance(smoothedLeftHand);
          state.prevLeftHand = pickedLeftHand[1];
        }
        if (handOk.right) {
          state.rightThighCordon = thighLineDistance(smoothedRightHand);
          state.prevRightHand = pickedRightHand[1];
        }
        state.preSec = videoTimeSec;

        // ── PF 值顯示（overlay debug）──
        if (state.showPFOverlay) {
          drawPFOverlay({
            canvasCtx,
            leftHandPt: handOk.left ? pickedLeftHand[1] : null,
            rightHandPt: handOk.right ? pickedRightHand[1] : null,
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
        const leftHandSpeed =
          handOk.left && prevLeftHandPt
          ? Math.hypot(
              pickedLeftHand[1].x - prevLeftHandPt.x,
              pickedLeftHand[1].y - prevLeftHandPt.y,
            ) / dtSec
          : 0;

        const rightHandSpeed =
          handOk.right && prevRightHandPt
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
        // 看不到的一側 history 已由 clearKneeTracking 清空，不推入失真點。
        if (kneeOk.left) {
          state.leftKneeHistory = pushPointHistory(
            state.leftKneeHistory,
            leftKnee,
            videoTimeSec,
            KNEE_WINDOW_SEC,
          );
        }
        if (kneeOk.right) {
          state.rightKneeHistory = pushPointHistory(
            state.rightKneeHistory,
            rightKnee,
            videoTimeSec,
            KNEE_WINDOW_SEC,
          );
        }

        // 肩寬同樣在 guard 外更新，校準完成那一刻就已有可用的尺度。
        updateBodyScale(state, poseLandmarks, state.visibilityThreshold);
        const bodyScale = state.bodyScale ?? BODY_SCALE_FALLBACK;

        if (state.calibrationProfile) {
          const profile = state.calibrationProfile;

          // ── 膝蓋上升補償量（每幀計算，用平滑後的 knee y）──
          // 提膝時 emaKnee.y < 基準 y，calcKneeRisingAdj 回傳正值。
          // 這個補償量疊加到 PF_HIT（同時也是重新武裝線），
          // 讓大腿線旋轉造成的 PF 幾何漂移無法穿越門檻，防止誤觸發。
          // 基準優先用 adaptiveMonitor 追蹤的實際靜止膝位（kneeRestY）：預設 profile 的
          // kneeBaseline 是別人的鏡頭構圖，實測差 0.12–0.15 → 補償恆為 0.2–0.28，
          // 手在半空就觸發、抬手也回不到武裝線（poseLog 2026-10-30）。
          // 膝蓋看不到的一側手也不判斷（handOk 含膝），補償量用不到 → 0
          const leftKneeAdj = kneeOk.left
            ? calcKneeRisingAdj(
                profile,
                "left",
                state.emaLeftKnee?.y ?? leftKnee.y,
                state.kneeRestY?.left,
              )
            : 0;
          const rightKneeAdj = kneeOk.right
            ? calcKneeRisingAdj(
                profile,
                "right",
                state.emaRightKnee?.y ?? rightKnee.y,
                state.kneeRestY?.right,
              )
            : 0;

          // 註：重新武裝（PF > PF_HIT）與下擊段峰值速度追蹤都內建在
          // monitoringTriggerConditions 中，這裡只負責餵門檻與單幀手速。

          // ── 右手：動態門檻 hit 判斷（疊加膝蓋補償）──
          const rightParams = getZoneParams(profile, "right", HAND_ZONE);
          if (rightParams) {
            state.rightState = monitoringTriggerConditions(
              state.rightState,
              state.rightThighCordon,
              rightParams.PF_HIT + TUNING.PF_HIT_SLACK + rightKneeAdj, // ← 提膝時門檻跟著升高
              webTimeMs,
              rightParams.COOLDOWN_MS,
              rightHandSpeed,
              rightParams.SPEED_HIT * TUNING.SPEED_HIT_SCALE,
            );
          }

          // ── 左手：動態門檻 hit 判斷（疊加膝蓋補償）──
          const leftParams = getZoneParams(profile, "left", HAND_ZONE);
          if (leftParams) {
            state.leftState = monitoringTriggerConditions(
              state.leftState,
              state.leftThighCordon,
              leftParams.PF_HIT + TUNING.PF_HIT_SLACK + leftKneeAdj, // ← 提膝時門檻跟著升高
              webTimeMs,
              leftParams.COOLDOWN_MS,
              leftHandSpeed,
              leftParams.SPEED_HIT * TUNING.SPEED_HIT_SCALE,
            );
          }

          // ==============================================================================
          // Knee kick conditions
          // ── Knee kick hit 判斷（history 已在 guard 外累積，這裡只做判斷）──
          const leftKneeMetrics = summarizeKneeMotion(
            state.leftKneeHistory,
            bodyScale,
          );
          const rightKneeMetrics = summarizeKneeMotion(
            state.rightKneeHistory,
            bodyScale,
          );

          // ⚠ 提到判斷之前取好，diagnostics 也要記這份「當下的膝蓋標準」。
          const leftKneeThr = getKneeThresholds(profile, "left");
          const rightKneeThr = getKneeThresholds(profile, "right");

          // 膝蓋觸發關閉：不判斷、不產生事件。
          // ⚠ 必須主動清 didHit，否則上一幀殘留的 didHit 會在下面被派發出去。
          //   history 照常累積（在 guard 外），重新開啟時立刻有可用的視窗。
          if (!state.kneeTriggerEnabled) {
            state.leftKneeState = { ...state.leftKneeState, didHit: false };
            state.rightKneeState = { ...state.rightKneeState, didHit: false };
          } else {
            // 手擊遮罩（見 KNEE_HAND_MASK_MS）：遮罩中先把武裝拿掉再判斷，
            // 判斷照跑（特徵照記、回穩照樣重新武裝），只是這幀不可能觸發。
            const judgeKnee = (kneeState, handState, metrics, thr) => {
              const lastHandMs = Math.max(
                handState?.lastHitMs ?? -Infinity,
                handState?.strikeLandMs ?? -Infinity,
              );
              const handMasked =
                !!handState?.strikeDescending ||
                webTimeMs - lastHandMs < KNEE_HAND_MASK_MS;
              const next = monitoringKneeKickConditions(
                handMasked ? { ...kneeState, canHit: false } : kneeState,
                metrics,
                webTimeMs,
                thr,
              );
              return { ...next, handMasked };
            };

            if (leftKneeMetrics) {
              state.leftKneeState = judgeKnee(
                state.leftKneeState,
                state.leftState,
                leftKneeMetrics,
                leftKneeThr,
              );
            }

            if (rightKneeMetrics) {
              state.rightKneeState = judgeKnee(
                state.rightKneeState,
                state.rightState,
                rightKneeMetrics,
                rightKneeThr,
              );
            }
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
                note: "手 pfHit 逐幀記（含提膝補償，同時是重新武裝線）；手速門檻比對下擊段峰值 spPk；膝 kDropHit/kDropRel/kDropStr 逐幀記（單位 = 肩寬 kScale）。其餘為靜態標準。",
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
              pfHitL: leftParams ? r2(leftParams.PF_HIT + TUNING.PF_HIT_SLACK + leftKneeAdj) : null,
              pfHitR: rightParams ? r2(rightParams.PF_HIT + TUNING.PF_HIT_SLACK + rightKneeAdj) : null,
              spHitL: leftParams ? r2(leftParams.SPEED_HIT * TUNING.SPEED_HIT_SCALE) : null,
              spHitR: rightParams ? r2(rightParams.SPEED_HIT * TUNING.SPEED_HIT_SCALE) : null,
              kAdjL: r2(leftKneeAdj),
              kAdjR: r2(rightKneeAdj),
              kRestYL: r2(state.kneeRestY?.left), // 提膝補償的膝蓋基準 y
              kRestYR: r2(state.kneeRestY?.right),

              // ── 膝：實測（湊齊 conditions.js 比對的所有量；位移/速度單位 = 肩寬）──
              kScale: r2(bodyScale),
              kneeDyL: r2(leftKneeMetrics?.windowDy),
              kneeDyR: r2(rightKneeMetrics?.windowDy),
              kneePkL: r2(leftKneeMetrics?.maxDownSpeed),
              kneePkR: r2(rightKneeMetrics?.maxDownSpeed),
              kneeXyL: r2(leftKneeMetrics?.xyRatio),
              kneeXyR: r2(rightKneeMetrics?.xyRatio),
              kneeDfrL: r2(leftKneeMetrics?.downFrameRatio),
              kneeDfrR: r2(rightKneeMetrics?.downFrameRatio),

              // ── 原始節點座標（normalized，x 往右、y 往下為正；未平滑）──
              // 用來看髖、膝、踝之間的位置關係：膝蓋晃動是整個身體一起動還是只有膝蓋節點在動、
              // 腿打直 / 彎曲時各節點怎麼變。踝在 history 判斷中沒有用到，只為了看腿的形狀。
              hipXL: r2(leftHip?.x),
              hipYL: r2(leftHip?.y),
              hipXR: r2(rightHip?.x),
              hipYR: r2(rightHip?.y),
              kneeXL: r2(leftKnee?.x),
              kneeYL: r2(leftKnee?.y),
              kneeXR: r2(rightKnee?.x),
              kneeYR: r2(rightKnee?.y),
              ankleXL: r2(poseLandmarks[27]?.x),
              ankleYL: r2(poseLandmarks[27]?.y),
              ankleXR: r2(poseLandmarks[28]?.x),
              ankleYR: r2(poseLandmarks[28]?.y),
              // 肘（13/14）、腕（15/16）：看真實的重擊揮臂軌跡（重音抬手 accentPose 的參考）
              elbowXL: r2(poseLandmarks[13]?.x),
              elbowYL: r2(poseLandmarks[13]?.y),
              elbowXR: r2(poseLandmarks[14]?.x),
              elbowYR: r2(poseLandmarks[14]?.y),
              wristXL: r2(poseLandmarks[15]?.x),
              wristYL: r2(poseLandmarks[15]?.y),
              wristXR: r2(poseLandmarks[16]?.x),
              wristYR: r2(poseLandmarks[16]?.y),
              // 重音抬手／提膝（accentPose）：上一層要不要作用 → 挑手 → 進度、抬起量、lift。
              // lift 1 = 畫成完整預備姿勢；null = 沒算到（進度 ≈ 0 或節點看不到，看 accVis）
              ...accentDebugFields(_accent.debug, r2),
              // 膝蓋節點可見度：抖動是否發生在模型「不確定」的時候
              kneeVisL: r2(leftKnee?.visibility),
              kneeVisR: r2(rightKnee?.visibility),

              // ── 膝：動態門檻（adaptiveMonitor 會漂移）+ 武裝狀態 ──
              kDropHitL: r2(leftKneeThr?.windowDropHit),
              kDropHitR: r2(rightKneeThr?.windowDropHit),
              kDropRelL: r2(leftKneeThr?.windowDropRelease),
              kDropRelR: r2(rightKneeThr?.windowDropRelease),
              kDropStrL: r2(leftKneeThr?.windowDropStrongHit),
              kDropStrR: r2(rightKneeThr?.windowDropStrongHit),
              // 膝蓋觸發關閉時判斷不跑，canHit 是凍結的舊值 → 記 null
              kOn: !!state.kneeTriggerEnabled,
              kArmL: state.kneeTriggerEnabled ? !!state.leftKneeState?.canHit : null,
              kArmR: state.kneeTriggerEnabled ? !!state.rightKneeState?.canHit : null,
              // 本幀是否被同側手擊遮罩（遮罩中不會觸發）
              kMaskL: state.kneeTriggerEnabled ? !!state.leftKneeState?.handMasked : null,
              kMaskR: state.kneeTriggerEnabled ? !!state.rightKneeState?.handMasked : null,
            });
          }
        }

        // 未校準時：不執行手部 / 膝蓋打擊偵測，不發聲
        // ── 打擊派發：記錄 → 發聲 → 特效 ──
        // ⚠ perfLog.hit 必須在 playZone 之前：audioEngine 在 playZone 內呼叫
        //   perfLog.noteSound，只有「派發期」（hit → endDispatch）才會掛到這一擊。
        const animTimings = []; // 本幀有特效的打擊紀錄，畫完後補上動畫時機
        const dispatchHit = (side, zoneId, extra, timingExtra, pushFx) => {
          // 骨架閃光跟著特效走：有畫特效的那一擊，對應的手臂／腿才閃
          const flareKey = `${side}-${zoneId === HAND_ZONE ? "arm" : "leg"}`;
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
          if (zoneSound[`${side}_${zoneId}`] !== "none" && pushFx()) {
            _flareMs[flareKey] = webTimeMs;
            if (rec) animTimings.push(rec.timing);
          }
        };

        // 手部命中：觸發區固定為大腿正面。
        for (const [side, handState, cordon, picked] of [
          ["left", state.leftState, state.leftThighCordon, pickedLeftHand],
          ["right", state.rightState, state.rightThighCordon, pickedRightHand],
        ]) {
          if (!handState.didHit) continue;
          _accent.noteHit(side, poseLandmarks, getVideoDrawRect());
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
      });
    }

    state.rafId = requestAnimationFrame(predictWebcam);
  }

  // 鏡頭重開時清掉本迴圈閉包內跨幀累積的畫面狀態（state 由 resetPoseState 負責）
  predictWebcam.reset = () => {
    _accent.reset();
    for (const key in _flareMs) delete _flareMs[key];
  };

  return predictWebcam;
}