export function emaSmooth(prev, PF, alpha) {
  return alpha * PF + (1 - alpha) * prev;
}

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
  kneeY,
  prevKneeY,
  dtSec,
  nowMs,
  KNEE_DROP_HIT,
  KNEE_DROP_RELEASE,
  KNEE_SPEED_HIT,
  COOLDOWN_MS
) {
  if (kneeY == null || prevKneeY == null || !dtSec) {
    return { ...(state ?? {}), didHit: false };
  }

  if (!state) state = {};
  if (state.lastHitMs == null) state.lastHitMs = -Infinity;
  if (state.canHit == null) state.canHit = true;
  if (state.highY == null) state.highY = kneeY;

  state.highY = Math.min(state.highY, kneeY);

  const kneeDownSpeed = (kneeY - prevKneeY) / dtSec;
  const drop = kneeY - state.highY;

  if (nowMs - state.lastHitMs < COOLDOWN_MS) {
    return {
      ...state,
      didHit: false,
      kneeDownSpeed,
      drop,
    };
  }

  if (drop <= KNEE_DROP_RELEASE) {
    state.canHit = true;
  }

  const ok =
    state.canHit && drop >= KNEE_DROP_HIT && kneeDownSpeed >= KNEE_SPEED_HIT;

  if (ok) {
    state.canHit = false;
    state.lastHitMs = nowMs;
    state.highY = kneeY;

    return {
      ...state,
      didHit: true,
      kneeDownSpeed,
      drop,
    };
  }

  return {
    ...state,
    didHit: false,
    kneeDownSpeed,
    drop,
  };
}