function footPoint(ABx, ABy, APx, APy) {
  const denom = ABx * ABx + ABy * ABy;
  if (denom < 1e-8) return 0;
  return (APx * ABx + APy * ABy) / denom;
}

function footPointCoordinate(A, ABx, ABy, t) {
  return { FX: A.x + t * ABx, FY: A.y + t * ABy };
}

function indexFootLineDistance(ABX, ABY, P, f) {
  const PFX = P.x - f.FX;
  const PFY = P.y - f.FY;
  const PF = Math.hypot(PFX, PFY);
  const thighLen = Math.hypot(ABX, ABY) || 1e-8;
  return PF / thighLen;
}

export function thighLineDistance(picked) {
  const hip = picked[0];
  const index = picked[1];
  const knee = picked[2];

  const ABX = knee.x - hip.x;
  const ABY = knee.y - hip.y;
  const APX = index.x - hip.x;
  const APY = index.y - hip.y;

  const T = footPoint(ABX, ABY, APX, APY);
  const t = Math.max(0, Math.min(1, T));
  const F = footPointCoordinate(hip, ABX, ABY, t);
  const PF = indexFootLineDistance(ABX, ABY, index, F);

  return { PF };
}

function avg2(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

export function handBasePointFromPoseLandmarks(landmarks, side) {
  if (side === 'L') {
    const pinky = landmarks[17];
    const index = landmarks[19];
    return avg2(pinky, index);
  }

  const pinky = landmarks[18];
  const index = landmarks[20];
  return avg2(pinky, index);
}

export function pickLegZoneByEntry(prevHand, hand, side, AXIS_RATIO = 1.1) {
  if (!prevHand) return 'front';

  const dx = hand.x - prevHand.x;
  const dy = hand.y - prevHand.y;

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  if (ay >= ax * AXIS_RATIO) {
    return 'front';
  }

  if (side === 'right') return dx < 0 ? 'inner' : 'outer';
  return dx > 0 ? 'inner' : 'outer';
}