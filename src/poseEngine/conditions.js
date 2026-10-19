export function monitoringTriggerConditions(
  State,
  ThighCordon,
  PF_HIT,
  nowMs,
  COOLDOWN_MS,
  handSpeed,
  SPEED_HIT,
) {
  const PF = ThighCordon?.PF;
  if (PF == null) return { ...(State ?? {}), didHit: false };

  if (!State) State = {};
  if (State.lastHitMs == null) State.lastHitMs = -Infinity;
  if (State.canHit == null) State.canHit = true;
  if (State.strokePeakPF == null) State.strokePeakPF = PF;
  if (State.strokeSpeedMax == null) State.strokeSpeedMax = 0;

  // ── 下擊段峰值速度：必須在冷卻早退「之前」更新 ──
  // 舊版只看「越過 PF_HIT 那一幀」的瞬間速度，但那時手已貼近大腿、正在減速，
  // PF_HIT 越低或幀率越低，量到的速度越低 → 使用者只能越打越用力（大腿紅腫）。
  // 改為取「本次下擊段」的最大手速：PF 創新高 = 手還在往上抬，視為下擊尚未開始，
  // 歸零重算；PF 開始往下後的每一幀才累積最大值。懸停抖動會不斷創小新高而歸零，
  // 慢慢放下的手峰值也低 → 都不會被當成打擊。
  if (PF > State.strokePeakPF) {
    State.strokePeakPF = PF;
    State.strokeSpeedMax = 0;
  } else {
    State.strokeSpeedMax = Math.max(State.strokeSpeedMax, handSpeed ?? 0);
  }

  // ── 重新武裝：PF 回到 PF_HIT 之上即可（已移除獨立的 PF_RELEASE）──
  // 舊版 release = PF_HIT × 3.75，PF_HIT 被調高時 release 撞到抬手可達上限，
  // 手抬不到就永遠 rearm 不了（該側靜音）、也限制了連打速度。
  // 現在由 COOLDOWN_MS 防連發抖動，下擊段峰值速度防懸停抖動（見上）。
  // 必須在冷卻早退「之前」判斷，否則冷卻中的回擺穿越會被吞掉、下一下漏掉。
  // belowSinceMs（診斷用）：本次下擊 PF「首次 ≤ PF_HIT」的幀時間。
  // 觸發時間 − 它 = 越線後被速度門檻 / 冷卻擋住多久才觸發。
  if (PF > PF_HIT) {
    State.canHit = true;
    State.belowSinceMs = null;
  } else if (State.belowSinceMs == null) {
    State.belowSinceMs = nowMs;
  }

  if (nowMs - State.lastHitMs < COOLDOWN_MS) {
    return { ...State, didHit: false };
  }

  const ok = State.canHit && PF <= PF_HIT && State.strokeSpeedMax >= SPEED_HIT;

  if (ok) {
    State.canHit = false;
    // 供診斷紀錄：這一擊實際比對的峰值、越線時間、與上一擊的間隔
    State.hitStrokeSpeed = State.strokeSpeedMax;
    State.hitCrossMs = State.belowSinceMs;
    State.hitGapMs = nowMs - State.lastHitMs;
    State.lastHitMs = nowMs;
    // 下一次下擊從這一點重新起算（手往上抬會一路創新高並歸零）
    State.strokePeakPF = PF;
    State.strokeSpeedMax = 0;
    return { ...State, didHit: true };
  }

  return { ...State, didHit: false };
}

// ── 膝蓋門檻預設值（poseLoop 與 adaptiveMonitor 共用這一份）──
// 位移單位 = 肩寬（windowDy / bodyScale），速度單位 = 肩寬 / 秒。
// 由舊版「原始 normalized 座標」門檻 ÷ 0.2（校準紀錄 shoulderWidth 平均 ≈ 0.2）換算，
// 30fps 下行為與舊版一致：
//   舊 windowDropHit 0.028 → 0.14、windowDropRelease 0.012 → 0.06、peakSpeedHit 0.5 → 2.5
//   舊 avgSpeedHit 0.32（× 舊 5 幀窗 0.133s）→ windowDropStrongHit 0.21
// 已移除：
//   windowMaxDx — 與 xyRatio 同為排除水平移動，且用絕對座標受遠近影響，改由 xyRatio 負責。
//   avgSpeedHit — 時間窗改為固定秒數後 avgDownSpeed = windowDy / 常數，與 windowDy 同一個量；
//                 原本的「平均速度夠快」路徑改寫成 windowDy ≥ windowDropStrongHit。
export const KNEE_THRESHOLDS_DEFAULT = Object.freeze({
  windowDropHit: 0.14, // 必要條件：時間窗內至少下落這麼多（adaptiveMonitor 近失調整的對象）
  windowDropRelease: 0.06, // 低於它才重新武裝
  windowDropStrongHit: 0.21, // 下落夠大 → 不必看峰值速度（隨 windowDropHit 等比縮放）
  peakSpeedHit: 2.5, // 下落中等時，需單段峰值速度夠快（俐落的一踩）
  cooldownMs: 180,
  maxXyRatio: 0.85,
  downFrameRatioHit: 0.7,
});

export function monitoringKneeKickConditions(
  state,
  metrics,
  nowMs,
  thresholds,
) {
  if (!metrics) {
    return { ...(state ?? {}), didHit: false };
  }

  if (!state) state = {};
  if (state.lastHitMs == null) state.lastHitMs = -Infinity;
  if (state.canHit == null) state.canHit = true;

  const { windowDy, maxDownSpeed, downFrameRatio, xyRatio } = metrics;

  const {
    windowDropHit,
    windowDropRelease,
    windowDropStrongHit,
    peakSpeedHit,
    cooldownMs,
    maxXyRatio,
    downFrameRatioHit,
  } = thresholds;

  // 回傳時一併帶上最新特徵，方便觀察 log（adaptiveMonitor 的近失追蹤也讀這裡的 windowDy）。
  const features = { windowDy, maxDownSpeed, downFrameRatio, xyRatio };

  // 冷卻期間仍保留最新特徵，但不允許命中。
  if (nowMs - state.lastHitMs < cooldownMs) {
    return { ...state, didHit: false, ...features };
  }

  // 動作回到較平穩狀態後，重新開放下一次命中。
  if (windowDy <= windowDropRelease) {
    state.canHit = true;
  }

  // 用短時間窗特徵一起判斷，避免單幀跳點或左右平移誤觸。
  // 速度：下落夠大（≈ 平均速度夠快）或單段峰值夠快，二擇一。
  const ok =
    state.canHit &&
    windowDy >= windowDropHit &&
    (windowDy >= windowDropStrongHit || maxDownSpeed >= peakSpeedHit) &&
    xyRatio <= maxXyRatio &&
    downFrameRatio >= downFrameRatioHit;

  if (ok) {
    state.canHit = false;
    state.lastHitMs = nowMs;
    return { ...state, didHit: true, ...features };
  }

  return { ...state, didHit: false, ...features };
}
