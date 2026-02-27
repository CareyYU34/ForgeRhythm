function emaSmooth(prev, PF, alpha) {
  return alpha * PF + (1 - alpha) * prev;
}

function monitoringTriggerConditions(
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

  //冷卻
  if (nowMs - State.lastHitMs < COOLDOWN_MS) {
    return { ...State, didHit: false };
  }

  //reload
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
