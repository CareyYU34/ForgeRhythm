export function monitoringTriggerConditions(
  State,
  ThighCordon,
  PF_HIT,
  PF_RELEASE,
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

  // ── 重新武裝：必須在冷卻早退「之前」判斷 ──
  // 原本這段寫在冷卻檢查之後，導致打擊後手往上回擺時，
  // 若 PF 穿越 PF_RELEASE 的那一刻仍在冷卻期內，這次穿越會被整個吞掉；
  // 等冷卻結束時手已在下擺、PF 早已低於 release，canHit 便再無機會回到 true，
  // 下一下直接漏掉。改為先記錄釋放狀態，冷卻只負責節流、不再影響武裝。
  if (PF > PF_RELEASE) {
    State.canHit = true;
  }

  if (nowMs - State.lastHitMs < COOLDOWN_MS) {
    return { ...State, didHit: false };
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
