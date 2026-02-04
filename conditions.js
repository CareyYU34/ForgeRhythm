function emaSmooth(prev, PF, alpha) {
  return alpha * PF + (1 - alpha) * prev;
}

function monitoringTriggerConditions(
  State,
  ThighCordon,
  dtSec,
  PF_WARN,
  PF_HIT,
  DPF_HIT,
  nowMs,
  COOLDOWN_MS,
) {
  const PF_EMA_ALPHA = 0.5;
  const PF_raw = ThighCordon.PF;
  if (PF_raw == null) return { ...State, didHit: false };
  
  //初始化
  if (State.pfEma == null) {
    State.pfEma = PF_raw;
    State.prevPfEma = PF_raw;
    State.armed = PF_raw >= PF_WARN;
    State.lastHitMs = -Infinity;
    return { ...State, didHit: false };
  }

  //EMA 平滑
  State.prevPfEma = State.pfEma;
  State.pfEma = emaSmooth(State.pfEma, PF_raw, PF_EMA_ALPHA);

  //離開警戒區才重新上膛
  if (State.pfEma >= PF_WARN) State.armed = true;

  //冷卻機制
  if (nowMs - State.lastHitMs < COOLDOWN_MS) return { ...State, didHit: false };

  //進入警戒區
  const inWarnZone = State.pfEma < PF_WARN;
  if (!inWarnZone) return { ...State, didHit: false };

  //進入打擊區
  const inHitZone = State.pfEma <= PF_HIT;
  if (!inHitZone) return { ...State, didHit: false };

  //速度檢測
  const dt = Math.max(1e-4, dtSec);
  const dpf = (State.prevPfEma - State.pfEma) / dt; //正值 = 靠近
  State.dpf = dpf;

  const approachingFast = dpf >= DPF_HIT;

  if (State.armed && approachingFast) {
    State.armed = false;
    State.lastHitMs = nowMs;
    return { ...State, didHit: true };
  }

  return { ...State, didHit: false };
}
