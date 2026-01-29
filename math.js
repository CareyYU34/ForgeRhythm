function footPoint(ABx, ABy, APx, APy) {
  const denom = ABx * ABx + ABy * ABy; //AB·AB = |AB|^2
  const T = (APx * ABx + APy * ABy) / denom; //t = (AP·AB) / (AB·AB)
  return T;
}

function footPointCoordinate(A, ABx, ABy, t) {
  const FX = A.x + t * ABx;
  const FY = A.y + t * ABy;
  return { FX, FY }; //F = A + t * AB
}

function indexFootLineDistance(ABX, ABY, P, f) {
  const PFX = P.x - f.FX;
  const PFY = P.y - f.FY;
  const PF = Math.hypot(PFX, PFY); //PF = P - F
  const thighLen = Math.hypot(ABX, ABY);
  return PF / thighLen; //normalize distance
}

function thighLineDistance(picked) {
  const hip = picked[0];
  const index = picked[1];
  const knee = picked[2];

  //A = hip, B = knee, P = index
  const ABX = knee.x - hip.x; //AB
  const ABY = knee.y - hip.y;
  const APX = index.x - hip.x; //AP
  const APY = index.y - hip.y;

  //t = (AP·AB) / (AB·AB)
  const T = footPoint(ABX, ABY, APX, APY);

  //F = A + t * AB
  const F = footPointCoordinate(hip, ABX, ABY, T);

  //PF = P - F
  const PF = indexFootLineDistance(ABX, ABY, index, F);

  return { T, PF };
}

function detectHandSpeed(p, p_prev, DT) {
  const DX = p.x - p_prev.x;
  const DY = p.y - p_prev.y;
  const dist = Math.hypot(DX, DY);
  return dist / DT;
}
function changePT(cordon, picked) {
  const hip = picked[0];
  const index = picked[1];
  const knee = picked[2];
  const T = cordon.T;

  const ABX = knee.x - hip.x;
  const ABY = knee.y - hip.y;
  const thighLen = Math.hypot(ABX, ABY);

  let PF_new;
  if (T <= 0) {
    //T < 0 => PT = knee
    PF_new = Math.hypot(index.x - knee.x, index.y - knee.y) / thighLen;
  } else {
    //T > 1 => PT = hip
    PF_new = Math.hypot(index.x - hip.x, index.y - hip.y) / thighLen;
  }

  return { T, PF: PF_new };
}

function monitoringTriggerConditions(
  prevPF,
  ThighCordon,
  HandSpeed,
  SPEED_HIT,
  SPEED_MAX,
  PF_WARN,
  PF_HIT,
  nowMs,
  lastHitMs,
  COOLDOWN_MS,
) {
  const PF = ThighCordon?.PF;
  if (PF == null) return { didHit: false, prevPF: prevPF, lastHitMs };
  // 0) 冷卻
  const inCooldown = nowMs - lastHitMs < COOLDOWN_MS;
  if (inCooldown) return { didHit: false, prevPF: PF, lastHitMs };

  // 1) 進入警戒區（gating）
  if (PF >= PF_WARN) return { didHit: false, prevPF: PF, lastHitMs };
  console.log("Warning Zone");

  // 2) edge trigger：只在「從外面進入命中區」那一刻成立
  const enteredHitZone = prevPF != null && prevPF > PF_HIT && PF <= PF_HIT;
  if (!enteredHitZone) return { didHit: false, prevPF: PF, lastHitMs };

  console.log("Hit Zone");

  // 3) 速度條件
  const speedOk = HandSpeed > SPEED_HIT && HandSpeed < SPEED_MAX;
  if (!speedOk) return { didHit: false, prevPF: PF, lastHitMs };

  // 4) 觸發
  console.log("Hit!");
  lastHitMs = nowMs;
  return { didHit: true, prevPF: PF, lastHitMs };
}
