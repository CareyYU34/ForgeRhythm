/**
 * calibration.js
 *
 * 校準模組：負責在正式演奏前收集使用者的個人化打擊數據。
 *
 * 流程：
 *   1. 使用者按下「開始校準」
 *   2. FRONT_SNAPSHOT（6 秒）：
 *      「請將雙手自然放在大腿正面上」
 *      - 身體基準快照（hip / knee / shoulder 平均）
 *      - 左右正面 baselinePF 同時收斂
 *   3. STRIKING right_front → left_front（各 3 下）
 *   4. OUTER_SNAPSHOT（6 秒）：
 *      「請將雙手自然放在大腿側面上」
 *      - 左右側面 baselinePF 同時收斂
 *   5. STRIKING right_outer → left_outer（各 3 下）
 *   6. DONE
 *
 *   打擊偵測用兩態狀態機：Resting → Lifted → Landed
 *
 * 依賴：
 *   - math.js: thighLineDistance, handBasePointFromPoseLandmarks, isStrictlyNormalizedPoint
 */

import {
  thighLineDistance,
  handBasePointFromPoseLandmarks,
  isStrictlyNormalizedPoint,
} from "./math.js";

// ─── 常數 ─────────────────────────────────────────────────────────────────────

const CALIBRATION_ZONES = [
  "right_front",
  "left_front",
  "right_outer",
  "left_outer",
];

// right_outer が始まる index
const OUTER_ZONE_START_INDEX = 2;

const STRIKES_PER_ZONE = 3;

// 靜置快照秒數（正面 & 側面共用）
const SNAPSHOT_SEC = 6;
// 身體基準快照所需最少幀數（達到即可提前完成，後續繼續跑 baseline 收斂直到 6 秒）
const BODY_SNAPSHOT_FRAME_TARGET = 30;

// EMA 平滑 PF
const PF_SMOOTH_ALPHA = 0.35;

// Baseline 追蹤 alpha
const BASELINE_ALPHA_FAST = 0.15; // 靜置快照期間，快速收斂
const BASELINE_ALPHA_SLOW = 0.05; // 打擊偵測中，慢速微調，避免被動作拉偏

// 打擊偵測門檻
const LIFT_DELTA = 0.08;
const RETURN_DELTA_RATIO = 0.4;
const LIFTED_TIMEOUT_MS = 3000;

// Landmark 節點索引（MediaPipe Pose）
const LM = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY: 17,
  RIGHT_PINKY: 18,
  LEFT_INDEX: 19,
  RIGHT_INDEX: 20,
};

// ─── 校準階段列舉 ──────────────────────────────────────────────────────────────

const Phase = {
  IDLE: "idle",
  FRONT_SNAPSHOT: "front_snapshot", // 雙手放正面，採集身體快照 + 正面 baseline
  OUTER_SNAPSHOT: "outer_snapshot", // 雙手放側面，採集側面 baseline
  STRIKING: "striking",
  DONE: "done",
};

const StrikeState = {
  RESTING: "resting",
  LIFTED: "lifted",
};

// ─── 輔助函式 ──────────────────────────────────────────────────────────────────

function emaSmooth(prev, value, alpha) {
  return alpha * value + (1 - alpha) * prev;
}

function cloneLandmark(lm) {
  if (!lm) return null;
  return { x: lm.x, y: lm.y, z: lm.z ?? 0 };
}

function extractLandmark(landmarks, index) {
  return cloneLandmark(landmarks[index]);
}

function sideFromZone(zoneKey) {
  return zoneKey.startsWith("left") ? "left" : "right";
}

function pickSidePoints(landmarks, side) {
  if (side === "left") {
    return {
      hip: landmarks[LM.LEFT_HIP],
      knee: landmarks[LM.LEFT_KNEE],
      handBase: handBasePointFromPoseLandmarks(landmarks, "L"),
    };
  }
  return {
    hip: landmarks[LM.RIGHT_HIP],
    knee: landmarks[LM.RIGHT_KNEE],
    handBase: handBasePointFromPoseLandmarks(landmarks, "R"),
  };
}

function strikeSnapshot(landmarks, side) {
  if (side === "left") {
    return {
      hip: extractLandmark(landmarks, LM.LEFT_HIP),
      knee: extractLandmark(landmarks, LM.LEFT_KNEE),
      shoulder: extractLandmark(landmarks, LM.LEFT_SHOULDER),
      wrist: extractLandmark(landmarks, LM.LEFT_WRIST),
      indexFinger: extractLandmark(landmarks, LM.LEFT_INDEX),
      pinky: extractLandmark(landmarks, LM.LEFT_PINKY),
    };
  }
  return {
    hip: extractLandmark(landmarks, LM.RIGHT_HIP),
    knee: extractLandmark(landmarks, LM.RIGHT_KNEE),
    shoulder: extractLandmark(landmarks, LM.RIGHT_SHOULDER),
    wrist: extractLandmark(landmarks, LM.RIGHT_WRIST),
    indexFinger: extractLandmark(landmarks, LM.RIGHT_INDEX),
    pinky: extractLandmark(landmarks, LM.RIGHT_PINKY),
  };
}

function generateSessionId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `cal_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// ─── 身體基準快照累加器 ──────────────────────────────────────────────────────

function createBodyAccumulator() {
  return {
    count: 0,
    sums: {
      leftHip: { x: 0, y: 0, z: 0 },
      rightHip: { x: 0, y: 0, z: 0 },
      leftKnee: { x: 0, y: 0, z: 0 },
      rightKnee: { x: 0, y: 0, z: 0 },
      leftShoulder: { x: 0, y: 0, z: 0 },
      rightShoulder: { x: 0, y: 0, z: 0 },
    },
  };
}

function accumulateBodyFrame(acc, landmarks) {
  const pairs = [
    ["leftHip", LM.LEFT_HIP],
    ["rightHip", LM.RIGHT_HIP],
    ["leftKnee", LM.LEFT_KNEE],
    ["rightKnee", LM.RIGHT_KNEE],
    ["leftShoulder", LM.LEFT_SHOULDER],
    ["rightShoulder", LM.RIGHT_SHOULDER],
  ];
  for (const [key, idx] of pairs) {
    const lm = landmarks[idx];
    if (!lm) continue;
    acc.sums[key].x += lm.x;
    acc.sums[key].y += lm.y;
    acc.sums[key].z += lm.z ?? 0;
  }
  acc.count += 1;
}

function finalizeBodySnapshot(acc) {
  const n = acc.count;
  if (n === 0) return null;

  const avg = {};
  for (const [key, sums] of Object.entries(acc.sums)) {
    avg[key] = { x: sums.x / n, y: sums.y / n, z: sums.z / n };
  }

  return {
    ...avg,
    thighLengthL: Math.hypot(
      avg.leftKnee.x - avg.leftHip.x,
      avg.leftKnee.y - avg.leftHip.y,
    ),
    thighLengthR: Math.hypot(
      avg.rightKnee.x - avg.rightHip.x,
      avg.rightKnee.y - avg.rightHip.y,
    ),
    shoulderWidth: Math.hypot(
      avg.rightShoulder.x - avg.leftShoulder.x,
      avg.rightShoulder.y - avg.leftShoulder.y,
    ),
    sampleFrames: n,
  };
}

// ─── 雙側 Baseline 追蹤器 ────────────────────────────────────────────────────

function createSideBaseline() {
  return { smoothedPF: 0, baselinePF: 0, initialized: false };
}

function updateSideBaseline(store, rawPF, alpha) {
  if (!store.initialized) {
    store.smoothedPF = rawPF;
    store.baselinePF = rawPF;
    store.initialized = true;
  } else {
    store.smoothedPF = emaSmooth(store.smoothedPF, rawPF, PF_SMOOTH_ALPHA);
    store.baselinePF = emaSmooth(store.baselinePF, store.smoothedPF, alpha);
  }
}

// ─── 校準引擎主體 ──────────────────────────────────────────────────────────────

/**
 * @param {Object} [options]
 * @param {function} [options.onStatusChange]
 *   payload: { phase, zone, strikeCount, strikesPerZone, countdown }
 */
export function createCalibrationEngine({ onStatusChange } = {}) {
  // ── 共用狀態 ──
  let phase = Phase.IDLE;
  let currentZoneIndex = 0;
  let strikeCount = 0;
  let session = null;

  // ── 快照狀態 ──
  let snapshotStartMs = 0;
  let lastCountdownSec = -1;
  let bodyAcc = createBodyAccumulator();
  let bodySnapshotDone = false;

  // 雙側 baseline（快照期間同時收斂左右）
  let baselineLeft = createSideBaseline();
  let baselineRight = createSideBaseline();

  // ── 打擊偵測狀態機 ──
  let strikeState = StrikeState.RESTING;
  let smoothedPF = 0;
  let baselinePF = 0;
  let baselineInitialized = false;
  let peakPF = 0;
  let peakHandSpeed = 0;
  let liftStartMs = 0;
  let prevHandPoint = null;
  let prevTimeSec = 0;

  // ── 狀態廣播 ──

  function emitStatus(extra = {}) {
    if (typeof onStatusChange !== "function") return;
    onStatusChange({
      phase,
      zone: CALIBRATION_ZONES[currentZoneIndex] ?? null,
      strikeCount,
      strikesPerZone: STRIKES_PER_ZONE,
      countdown: null,
      ...extra,
    });
  }

  // ── 內部工具 ──

  function currentZoneKey() {
    return CALIBRATION_ZONES[currentZoneIndex] ?? null;
  }

  function resetStrikeDetection() {
    strikeState = StrikeState.RESTING;
    smoothedPF = 0;
    baselinePF = 0;
    baselineInitialized = false;
    peakPF = 0;
    peakHandSpeed = 0;
    liftStartMs = 0;
    prevHandPoint = null;
    prevTimeSec = 0;
  }

  /** 進入打擊階段，從對應 side 的 baseline 儲存繼承初始值 */
  function enterStriking(nowMs) {
    resetStrikeDetection();

    const zone = currentZoneKey();
    const side = sideFromZone(zone);
    const store = side === "left" ? baselineLeft : baselineRight;

    if (store.initialized) {
      smoothedPF = store.smoothedPF;
      baselinePF = store.baselinePF;
      baselineInitialized = true;
      console.log(`[校準] ${zone} 繼承 baseline: ${baselinePF.toFixed(4)}`);
    }

    phase = Phase.STRIKING;
    emitStatus({ countdown: null });
  }

  function initSession() {
    const zones = {};
    for (const z of CALIBRATION_ZONES) {
      zones[z] = { strikes: [] };
    }
    session = {
      sessionId: generateSessionId(),
      timestamp: new Date().toISOString(),
      bodySnapshot: null,
      zones,
    };
  }

  // ── 快照通用：對左右兩側同時更新 baseline EMA ──

  function updateBothSideBaselines(landmarks) {
    for (const side of ["left", "right"]) {
      const { hip, knee, handBase } = pickSidePoints(landmarks, side);
      if (
        !isStrictlyNormalizedPoint(hip) ||
        !isStrictlyNormalizedPoint(knee) ||
        !handBase
      )
        continue;

      const { PF: rawPF } = thighLineDistance([hip, handBase, knee]);
      const store = side === "left" ? baselineLeft : baselineRight;
      updateSideBaseline(store, rawPF, BASELINE_ALPHA_FAST);
    }
  }

  // ── 每幀處理邏輯 ──

  function handleFrontSnapshot(landmarks, nowMs) {
    // 身體基準快照：30 幀後即視為完成，後續只繼續收斂 baseline
    if (!bodySnapshotDone) {
      accumulateBodyFrame(bodyAcc, landmarks);
      if (bodyAcc.count >= BODY_SNAPSHOT_FRAME_TARGET) {
        session.bodySnapshot = finalizeBodySnapshot(bodyAcc);
        bodySnapshotDone = true;
      }
    }

    updateBothSideBaselines(landmarks);

    const elapsed = (nowMs - snapshotStartMs) / 1000;
    const remaining = Math.ceil(SNAPSHOT_SEC - elapsed);

    if (remaining !== lastCountdownSec && remaining > 0) {
      lastCountdownSec = remaining;
      emitStatus({ countdown: remaining });
    }

    if (elapsed >= SNAPSHOT_SEC) {
      console.log(
        "[校準] front snapshot 完成",
        "left:",
        baselineLeft.baselinePF.toFixed(4),
        "right:",
        baselineRight.baselinePF.toFixed(4),
      );
      currentZoneIndex = 0; // right_front
      strikeCount = 0;
      enterStriking(nowMs);
    }
  }

  function handleOuterSnapshot(landmarks, nowMs) {
    updateBothSideBaselines(landmarks);

    const elapsed = (nowMs - snapshotStartMs) / 1000;
    const remaining = Math.ceil(SNAPSHOT_SEC - elapsed);

    if (remaining !== lastCountdownSec && remaining > 0) {
      lastCountdownSec = remaining;
      emitStatus({ countdown: remaining });
    }

    if (elapsed >= SNAPSHOT_SEC) {
      console.log(
        "[校準] outer snapshot 完成",
        "left:",
        baselineLeft.baselinePF.toFixed(4),
        "right:",
        baselineRight.baselinePF.toFixed(4),
      );
      currentZoneIndex = OUTER_ZONE_START_INDEX; // right_outer
      strikeCount = 0;
      enterStriking(nowMs);
    }
  }

  function handleStriking(landmarks, nowMs) {
    const zone = currentZoneKey();
    if (!zone) return;

    const side = sideFromZone(zone);
    const { hip, knee, handBase } = pickSidePoints(landmarks, side);

    if (
      !isStrictlyNormalizedPoint(hip) ||
      !isStrictlyNormalizedPoint(knee) ||
      !handBase
    )
      return;

    const { PF: rawPF } = thighLineDistance([hip, handBase, knee]);

    // 防禦性初始化
    if (!baselineInitialized) {
      smoothedPF = rawPF;
      baselinePF = rawPF;
      baselineInitialized = true;
      prevHandPoint = handBase;
      prevTimeSec = nowMs / 1000;
      return;
    }

    smoothedPF = emaSmooth(smoothedPF, rawPF, PF_SMOOTH_ALPHA);

    const currentTimeSec = nowMs / 1000;
    const dtSec = Math.max(1e-4, currentTimeSec - prevTimeSec);
    const handSpeed = prevHandPoint
      ? Math.hypot(handBase.x - prevHandPoint.x, handBase.y - prevHandPoint.y) /
        dtSec
      : 0;
    prevHandPoint = handBase;
    prevTimeSec = currentTimeSec;

    const returnDelta = LIFT_DELTA * RETURN_DELTA_RATIO;

    if (strikeState === StrikeState.RESTING) {
      baselinePF = emaSmooth(baselinePF, smoothedPF, BASELINE_ALPHA_SLOW);

      if (smoothedPF > baselinePF + LIFT_DELTA) {
        strikeState = StrikeState.LIFTED;
        liftStartMs = nowMs;
        peakPF = smoothedPF;
        peakHandSpeed = handSpeed;
      }
    } else if (strikeState === StrikeState.LIFTED) {
      if (smoothedPF > peakPF) peakPF = smoothedPF;
      if (handSpeed > peakHandSpeed) peakHandSpeed = handSpeed;

      if (smoothedPF < baselinePF + returnDelta) {
        // Landed：記錄打擊
        session.zones[zone].strikes.push({
          strikeIndex: strikeCount,
          restingPF: baselinePF,
          peakPF,
          landedPF: smoothedPF,
          peakHandSpeed,
          durationMs: nowMs - liftStartMs,
          landmarks: strikeSnapshot(landmarks, side),
        });

        strikeCount += 1;
        emitStatus();

        strikeState = StrikeState.RESTING;
        peakPF = 0;
        peakHandSpeed = 0;
        liftStartMs = 0;

        if (strikeCount >= STRIKES_PER_ZONE) {
          strikeCount = 0;

          // left_front（index 1）完成後 → 進入 OUTER_SNAPSHOT
          if (currentZoneIndex === 1) {
            baselineLeft = createSideBaseline();
            baselineRight = createSideBaseline();
            snapshotStartMs = nowMs;
            lastCountdownSec = -1;
            phase = Phase.OUTER_SNAPSHOT;
            emitStatus({ countdown: SNAPSHOT_SEC });
            return;
          }

          const nextIndex = currentZoneIndex + 1;
          if (nextIndex >= CALIBRATION_ZONES.length) {
            phase = Phase.DONE;
            emitStatus();
          } else {
            currentZoneIndex = nextIndex;
            enterStriking(nowMs);
          }
        }

        return;
      }

      // 超時
      if (nowMs - liftStartMs > LIFTED_TIMEOUT_MS) {
        console.log("[校準] 抬手超時，取消本次偵測");
        strikeState = StrikeState.RESTING;
        peakPF = 0;
        peakHandSpeed = 0;
        liftStartMs = 0;
      }
    }
  }

  // ── 公開 API ──

  return {
    start() {
      initSession();
      snapshotStartMs = performance.now();
      lastCountdownSec = -1;
      bodyAcc = createBodyAccumulator();
      bodySnapshotDone = false;
      baselineLeft = createSideBaseline();
      baselineRight = createSideBaseline();
      currentZoneIndex = 0;
      strikeCount = 0;
      resetStrikeDetection();
      phase = Phase.FRONT_SNAPSHOT;
      emitStatus({ countdown: SNAPSHOT_SEC });
    },

    feedFrame(landmarks, nowMs) {
      if (!landmarks || phase === Phase.IDLE || phase === Phase.DONE) return;

      if (phase === Phase.FRONT_SNAPSHOT) {
        handleFrontSnapshot(landmarks, nowMs);
        return;
      }
      if (phase === Phase.OUTER_SNAPSHOT) {
        handleOuterSnapshot(landmarks, nowMs);
        return;
      }
      if (phase === Phase.STRIKING) {
        handleStriking(landmarks, nowMs);
      }
    },

    getPhase() {
      return phase;
    },

    getCurrentZone() {
      return phase === Phase.STRIKING ? currentZoneKey() : null;
    },

    getStrikeCount() {
      return strikeCount;
    },

    getSession() {
      return session;
    },

    abort() {
      phase = Phase.IDLE;
      session = null;
      bodyAcc = createBodyAccumulator();
      bodySnapshotDone = false;
      baselineLeft = createSideBaseline();
      baselineRight = createSideBaseline();
      resetStrikeDetection();
      currentZoneIndex = 0;
      strikeCount = 0;
      emitStatus();
    },

    PHASES: Phase,
    ZONES: CALIBRATION_ZONES,
    STRIKES_PER_ZONE,
  };
}