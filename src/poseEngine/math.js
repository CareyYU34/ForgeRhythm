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

  // F 點以 normalized 座標回傳，供 PF 幾何視覺化使用
  return { PF, F: { x: F.FX, y: F.FY } };
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