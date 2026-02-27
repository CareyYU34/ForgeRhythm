/** PF計算 **/
function footPoint(ABx, ABy, APx, APy) {
  const denom = ABx * ABx + ABy * ABy; // |AB|^2
  if (denom < 1e-8) return 0;
  return (APx * ABx + APy * ABy) / denom; // t
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

function thighLineDistance(picked) {
  const hip = picked[0];
  const index = picked[1];
  const knee = picked[2];

  //A = hip, B = knee, P = index
  const ABX = knee.x - hip.x;
  const ABY = knee.y - hip.y;
  const APX = index.x - hip.x;
  const APY = index.y - hip.y;
  //t = (AP·AB) / (AB·AB)
  const T = footPoint(ABX, ABY, APX, APY);
  const t = Math.max(0, Math.min(1, T));
  //F = A + t * AB
  const F = footPointCoordinate(hip, ABX, ABY, t);
  //PF = P - F
  const PF = indexFootLineDistance(ABX, ABY, index, F);

  return { PF };
}

/** 手部平均點 **/
function avg2(a, b) {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    z: ((a.z ?? 0) + (b.z ?? 0)) / 2,
    visibility: Math.min(a.visibility ?? 1, b.visibility ?? 1),
  };
}

function handBasePointFromPoseLandmarks(landmarks, side /* "L" or "R" */) {
  if (side === "L") {
    const pinky = landmarks[17];
    const index = landmarks[19];
    return avg2(pinky, index);
  } else {
    const pinky = landmarks[18];
    const index = landmarks[20];
    return avg2(pinky, index);
  }
}

/** Zone判斷 **/

function pickLegZoneByEntry(prevHand, hand, side, AXIS_RATIO = 1.1) {
  if (!prevHand) return "front";

  const dx = hand.x - prevHand.x;
  const dy = hand.y - prevHand.y;

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  // 主要沿垂直（你說的：某個軸變化最大）
  if (ay >= ax * AXIS_RATIO) {
    return "front"; // 上下都算 front（你要更細可再拆 up/down）
  }

  // 主要沿水平：依左右腿決定 outer/inner
  if (side === "right") return dx < 0 ? "inner" : "outer";
  return dx > 0 ? "inner" : "outer";
}
