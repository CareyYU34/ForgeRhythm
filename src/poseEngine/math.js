function footPoint(ABx, ABy, APx, APy) {
  const denom = ABx * ABx + ABy * ABy;
  if (denom < 1e-8) return 0;
  return (APx * ABx + APy * ABy) / denom;
}

export function isStrictlyNormalizedPoint(point) {
  if (!point) return false;

  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    point.x > 0 &&
    point.x < 1 &&
    point.y > 0 &&
    point.y < 1
  );
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
  if (side === "L") {
    const pinky = landmarks[17];
    const index = landmarks[19];
    if (
      !isStrictlyNormalizedPoint(pinky) ||
      !isStrictlyNormalizedPoint(index)
    ) {
      return null;
    }
    return avg2(pinky, index);
  }

  const pinky = landmarks[18];
  const index = landmarks[20];
  if (!isStrictlyNormalizedPoint(pinky) || !isStrictlyNormalizedPoint(index)) {
    return null;
  }
  return avg2(pinky, index);
}

export function pickLegZoneByEntry(prevHand, hand, side, AXIS_RATIO = 1.1) {
  if (!prevHand) return "front";

  const dx = hand.x - prevHand.x;
  const dy = hand.y - prevHand.y;

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);

  if (ay >= ax * AXIS_RATIO) {
    return "front";
  }

  if (side === "right") return dx < 0 ? "inner" : "outer";
  return dx > 0 ? "inner" : "outer";
}

export function pushPointHistory(history, point, timeSec, maxSize = 5) {
  if (!point || !Number.isFinite(timeSec)) return history ?? [];

  // 只保留短時間窗需要的最小資料，避免把整個 landmark 物件一路帶著走。
  const nextHistory = [
    ...(history ?? []),
    {
      x: point.x,
      y: point.y,
      t: timeSec,
    },
  ];

  if (nextHistory.length > maxSize) {
    nextHistory.splice(0, nextHistory.length - maxSize);
  }

  return nextHistory;
}

export function summarizeKneeMotion(history) {
  if (!history || history.length < 2) return null;

  // 這裡把 history 摘要成「可判斷的動作特徵」，讓上層邏輯只處理結論。
  const first = history[0];
  const last = history[history.length - 1];
  const windowDt = Math.max(1e-4, last.t - first.t);
  const windowDy = last.y - first.y;
  const windowDx = Math.abs(last.x - first.x);

  let sumAbsDy = 0;
  let sumAbsDx = 0;
  let downSegments = 0;
  let maxDownSpeed = 0;

  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1];
    const curr = history[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dt = Math.max(1e-4, curr.t - prev.t);

    sumAbsDx += Math.abs(dx);
    sumAbsDy += Math.abs(dy);

    if (dy > 0) {
      downSegments += 1;
      maxDownSpeed = Math.max(maxDownSpeed, dy / dt);
    }
  }

  const segmentCount = history.length - 1;
  const avgDownSpeed = Math.max(0, windowDy) / windowDt;
  const downFrameRatio = segmentCount > 0 ? downSegments / segmentCount : 0;
  const xyRatio = sumAbsDx / Math.max(sumAbsDy, 1e-4);

  return {
    windowDt,
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

export function summarizeHandMotion(history) {
  if (!history || history.length < 2) return null;

  // 把短時間窗內的手部路徑整理成方向與速度特徵，供上層命中與分區判斷使用。
  const first = history[0];
  const last = history[history.length - 1];
  const windowDt = Math.max(1e-4, last.t - first.t);
  const windowDxSigned = last.x - first.x;
  const windowDySigned = last.y - first.y;
  const windowDx = Math.abs(windowDxSigned);
  const windowDy = Math.abs(windowDySigned);
  const windowDistance = Math.hypot(windowDxSigned, windowDySigned);

  let sumAbsDx = 0;
  let sumAbsDy = 0;
  let maxSpeed = 0;
  let xDominantSegments = 0;
  let yDominantSegments = 0;
  let consistentXSegments = 0;
  let consistentYSegments = 0;

  for (let i = 1; i < history.length; i += 1) {
    const prev = history[i - 1];
    const curr = history[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dt = Math.max(1e-4, curr.t - prev.t);
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);

    sumAbsDx += absDx;
    sumAbsDy += absDy;
    maxSpeed = Math.max(maxSpeed, Math.hypot(dx, dy) / dt);

    if (absDx > absDy) xDominantSegments += 1;
    if (absDy > absDx) yDominantSegments += 1;
    if (dx !== 0 && Math.sign(dx) === Math.sign(windowDxSigned)) {
      consistentXSegments += 1;
    }
    if (dy !== 0 && Math.sign(dy) === Math.sign(windowDySigned)) {
      consistentYSegments += 1;
    }
  }

  const segmentCount = history.length - 1;
  const avgSpeed = windowDistance / windowDt;
  const xyRatio = sumAbsDx / Math.max(sumAbsDy, 1e-4);
  const xConsistency =
    segmentCount > 0 ? consistentXSegments / segmentCount : 0;
  const yConsistency =
    segmentCount > 0 ? consistentYSegments / segmentCount : 0;
  const xDominantRatio =
    segmentCount > 0 ? xDominantSegments / segmentCount : 0;
  const yDominantRatio =
    segmentCount > 0 ? yDominantSegments / segmentCount : 0;

  return {
    windowDt,
    windowDxSigned,
    windowDySigned,
    windowDx,
    windowDy,
    windowDistance,
    sumAbsDx,
    sumAbsDy,
    avgSpeed,
    maxSpeed,
    xyRatio,
    xConsistency,
    yConsistency,
    xDominantRatio,
    yDominantRatio,
  };
}

export function pickHandZoneByWindow(metrics, side, options = {}) {
  if (!metrics) return null;

  const {
    frontDominantRatio = 1.2,
    sideDominantRatio = 1.2,
    minConsistency = 0.55,
  } = options;
  const {
    sumAbsDx,
    sumAbsDy,
    windowDxSigned,
    xConsistency,
    yConsistency,
    yDominantRatio,
    xDominantRatio,
  } = metrics;

  // 先判斷是偏正面進入還是偏側向進入，模糊區則交給上層決定是否沿用舊值。
  const isFrontLike =
    sumAbsDy >= sumAbsDx * frontDominantRatio &&
    yConsistency >= minConsistency &&
    yDominantRatio >= 0.5;
  if (isFrontLike) return "front";

  const isSideLike =
    sumAbsDx >= sumAbsDy * sideDominantRatio &&
    xConsistency >= minConsistency &&
    xDominantRatio >= 0.5;
  if (!isSideLike) return null;

  if (side === "right") return windowDxSigned < 0 ? "inner" : "outer";
  return windowDxSigned > 0 ? "inner" : "outer";
}
