

export function monitoringTriggerConditions(
  State,
  ThighCordon,
  PF_HIT,
  PF_RELEASE,
  nowMs,
  COOLDOWN_MS,
  handSpeed,
  SPEED_HIT
) {
  const PF = ThighCordon?.PF;
  if (PF == null) return { ...(State ?? {}), didHit: false };

  if (!State) State = {};
  if (State.lastHitMs == null) State.lastHitMs = -Infinity;
  if (State.canHit == null) State.canHit = true;

  if (nowMs - State.lastHitMs < COOLDOWN_MS) {
    return { ...State, didHit: false };
  }

  if (PF > PF_RELEASE) {
    State.canHit = true;
  }

  const ok = State.canHit && PF <= PF_HIT && (handSpeed ?? 0) >= SPEED_HIT;

  if (ok) {
    State.canHit = false;
    State.lastHitMs = nowMs;
    return { ...State, didHit: true };
  }

  return { ...State, didHit: false };
}

export function monitoringKneeKickConditions(
  state,
  metrics,
  nowMs,
  thresholds
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
