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

  const {
    windowDy,
    windowDx,
    sumAbsDx,
    sumAbsDy,
    avgDownSpeed,
    maxDownSpeed,
    downFrameRatio,
    xyRatio,
  } = metrics;

  const {
    windowDropHit,
    windowDropRelease,
    avgSpeedHit,
    peakSpeedHit,
    cooldownMs,
    windowMaxDx,
    maxXyRatio,
    downFrameRatioHit,
  } = thresholds;

  // 冷卻期間仍保留最新特徵，方便觀察 log，但不允許命中。
  if (nowMs - state.lastHitMs < cooldownMs) {
    return {
      ...state,
      didHit: false,
      windowDy,
      windowDx,
      sumAbsDx,
      sumAbsDy,
      avgDownSpeed,
      maxDownSpeed,
      downFrameRatio,
      xyRatio,
    };
  }

  // 動作回到較平穩狀態後，重新開放下一次命中。
  if (windowDy <= windowDropRelease) {
    state.canHit = true;
  }

  // 用短時間窗特徵一起判斷，避免單幀跳點或左右平移誤觸。
  const ok =
    state.canHit &&
    windowDy >= windowDropHit &&
    (avgDownSpeed >= avgSpeedHit || maxDownSpeed >= peakSpeedHit) &&
    windowDx <= windowMaxDx &&
    xyRatio <= maxXyRatio &&
    downFrameRatio >= downFrameRatioHit;

  if (ok) {
    state.canHit = false;
    state.lastHitMs = nowMs;

    return {
      ...state,
      didHit: true,
      windowDy,
      windowDx,
      sumAbsDx,
      sumAbsDy,
      avgDownSpeed,
      maxDownSpeed,
      downFrameRatio,
      xyRatio,
    };
  }

  return {
    ...state,
    didHit: false,
    windowDy,
    windowDx,
    sumAbsDx,
    sumAbsDy,
    avgDownSpeed,
    maxDownSpeed,
    downFrameRatio,
    xyRatio,
  };
}
