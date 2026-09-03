/**
 * adaptiveMonitor.js
 *
 * 自適應參數監控模組。
 *
 * 職責：
 *   1. 冷啟動：偵測關鍵節點可見度達標後，自動套用預設 CalibrationProfile
 *   2. PF 自適應：追蹤每個 zone 的 PF 低谷值，感知打擊習慣漂移並更新 PF_HIT
 *      （v2 循環式估計器，見下方「PF 低谷估計架構」）
 *   3. Knee 自適應：偵測「有踢腿意圖但未觸發」，分別調整 windowDropHit / avgSpeedHit
 *   4. Visibility 自適應：根據節點歷史可見度，動態調整全域 visibilityThreshold
 *
 * 設計原則：
 *   - 完全獨立於 poseLoop，只透過 state 共享資料
 *   - poseLoop 不知道此模組存在，只讀寫 state 中的既有欄位
 *   - 所有可調參數集中在 MONITOR_TUNING
 *
 * 使用方式（main.js）：
 *   const monitor = createAdaptiveMonitor({ state });
 *   monitor.start();
 *   // onFrame callback 中：
 *   monitor.feedFrame(poseLandmarks, nowMs);
 *   // 正式校準完成後：
 *   monitor.reset();
 *
 * ─── PF 低谷估計架構（v2）─────────────────────────────────────────────────
 *
 * 舊版以 canHit === true 為採樣門控，但「手貼在大腿上」正是 canHit === false
 * 的狀態，導致模組看不到它要測量的目標；且採樣區間在打擊觸發（PF <= PF_HIT）
 * 那一刻被切斷，使可採樣的最低值 ≈ PF_HIT，而 PF_HIT = troughPF × K1，
 * 形成 troughPF ← PF_HIT ← troughPF 的自鎖正回饋，實測誤差達 100 倍。
 *
 * v2 拆為五個彼此無循環依賴的機制：
 *
 *   M1 循環式採樣  — 以 canHit false 期間為「谷底段」，取該段最小值為一個樣本。
 *                    此區間下限由人體幾何決定，與參數無關，回饋方向翻轉為負回饋。
 *   M2 有效性過濾  — PF > TROUGH_MAX_PF 的幀直接拒絕（不 clamp，避免製造假樣本）。
 *   M3 中位數估計  — 近 N 個循環最小值取中位數，具雙向移動能力且抗離群，
 *                    取代舊版的全域 running-min + 雙計時器重置。
 *   M4 變化率限制  — PF_HIT 每次更新至多變動 ±PF_HIT_MAX_STEP_RATIO，
 *                    使孤立異常樣本自動失效，且不需事先判斷「是否為異常」。
 *   M5 故障回退    — canHit 卡在 true 超過門檻 = 有動作但打不中，回退至 baseline；
 *                    時間窗內累犯達門檻則凍結該 zone 的自適應。
 */

import { DEFAULT_CALIBRATION_PROFILE } from "./calibrationProfile.js";
import { TUNING, computeReleaseFromHit } from "./calibrationProfile.js";

// ─── 可調參數 ────────────────────────────────────────────────────────────────

const MONITOR_TUNING = {
  // 冷啟動
  COLD_START_FRAMES: 30, // 關鍵節點連續可見幀數門檻
  COLD_START_CHECK_INTERVAL: 100, // 每 100ms 檢查一次（ms）

  // PF 低谷追蹤 ── 循環式採樣（M1）
  TROUGH_CYCLE_MIN_FRAMES: 3, // 循環有效幀數下限，低於則丟棄該循環
  TROUGH_CYCLE_MAX_MS: 5000, // 循環開啟過久時暫結並產出樣本（ms）

  // PF 低谷追蹤 ── 樣本有效性（M2）
  TROUGH_MAX_PF: 0.3, // 低谷候選的絕對上界，超出直接拒絕（非 clamp）

  // PF 低谷追蹤 ── 中位數估計器（M3）
  TROUGH_SAMPLE_SIZE: 7, // 樣本環形 buffer 容量
  TROUGH_MIN_SAMPLES: 3, // 少於此數量不更新 PF_HIT

  // PF_HIT 變化率限制（M4）
  PF_HIT_MAX_STEP_RATIO: 0.15, // 每次更新的最大變動比例
  PF_HIT_MIN_ABS_STEP: 0.01, // 每次更新的最小絕對步長

  // 故障回退與升級凍結（M5）
  FALLBACK_STUCK_MS: 3500, // canHit 持續為 true 的回退門檻（正式校準後，ms）
  FALLBACK_STUCK_MS_COLD: 7000, // 冷啟動階段的回退門檻（ms）
  FALLBACK_ESCALATE_WINDOW_MS: 60000, // 升級判定的時間窗（ms）
  FALLBACK_ESCALATE_COUNT: 3, // 窗內回退達此次數則凍結該 zone

  // Knee 自適應
  NEAR_MISS_RATIO: 0.7, // 達到門檻幾成視為近失
  NEAR_MISS_THRESHOLD: 3, // 累積幾次近失才調整
  KNEE_ADJUST_COOLDOWN_MS: 3000, // 兩次調整間的冷卻期（ms）
  KNEE_ADJUST_FACTOR: 0.9, // 每次調整的乘數（降低 10%）
  KNEE_ADJUST_MIN_RATIO: 0.5, // 相對初始值的最低比例

  // Visibility 自適應
  VIS_HISTORY_FRAMES: 150, // visibility 歷史 buffer 大小（約 5s @ 30fps）
  VIS_EVAL_INTERVAL_MS: 2000, // 每次評估間隔（ms）
  VIS_DROP_MEDIAN_RATIO: 0.85, // 中位數低於 threshold × 此比例觸發降低
  VIS_DROP_MIN_PRESENCE: 0.2, // 節點至少有幾成幀出現才考慮降閾值
  VIS_RAISE_MEDIAN_RATIO: 1.15, // 中位數高於 threshold × 此比例視為穩定
  VIS_RAISE_STABLE_COUNT: 3, // 連續幾次評估穩定才提升
  VIS_STEP_DOWN: 0.03, // 每次降低的幅度
  VIS_STEP_UP: 0.02, // 每次提升的幅度
  VIS_MIN: 0.4, // visibilityThreshold 下限
  VIS_MAX: 0.9, // visibilityThreshold 上限
  VIS_ANKLE_PRESENCE_RATIO: 0.5, // 踝節點低於此比例時不計入關鍵節點判斷
};

// ─── 節點索引 ────────────────────────────────────────────────────────────────

// 冷啟動 & Visibility 監控的計算節點
const CRITICAL_LANDMARK_INDICES = [23, 24, 25, 26, 17, 19, 18, 20]; //（髖、膝、手中心）
// 穩定性關聯節點（踝）
const ANKLE_LANDMARK_INDICES = [27, 28]; //（左踝、右踝）
// 全部監控節點
const ALL_MONITORED_INDICES = [
  ...CRITICAL_LANDMARK_INDICES,
  ...ANKLE_LANDMARK_INDICES,
];

// ─── zone → side / direction 映射 ───────────────────────────────────────────

const ZONE_MAP = {
  right_front: { side: "right", direction: "front" },
  left_front: { side: "left", direction: "front" },
};

// ─── 初始低谷值（來自預設 profile 的 restingMean）────────────────────────────
// 與 DEFAULT_CALIBRATION_PROFILE 的 _stats.restingMean 對應

const DEFAULT_TROUGH_PF = {
  right_front: 0.0969,
  left_front: 0.0905,
};

// ─── 預設 peakPFMean（用於 PF_HIT 上限計算，來自同一份校準資料）──────────────

const DEFAULT_PEAK_PF_MEAN = {
  right_front: 1.029,
  left_front: 1.4433,
};

// ─── Knee 初始門檻（與 poseLoop 中的 KNEE_THRESHOLDS_DEFAULT 對應）───────────

const KNEE_DEFAULT_THRESHOLDS = {
  windowDropHit: 0.028,
  windowDropRelease: 0.012,
  avgSpeedHit: 0.32,
};

// ─── 工具函式 ────────────────────────────────────────────────────────────────

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/** 取陣列中位數 */
function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 環形 buffer 推入新值，超過 maxSize 從前端移除 */
function pushToBuffer(buf, value, maxSize) {
  buf.push(value);
  if (buf.length > maxSize) buf.shift();
}

// ─── 建立 PF 低谷追蹤器（per zone）─────────────────────────────────────────

function createTroughTracker(zoneKey, nowMs) {
  return {
    // 當前估計值（M3 中位數結果）
    troughPF: DEFAULT_TROUGH_PF[zoneKey] ?? 0.15,
    // M3：循環最小值環形 buffer
    samples: [],
    // M1：循環邊緣偵測
    // poseLoop 中 canHit 初始為 false，故循環一開始即為開啟狀態
    prevCanHit: false,
    cycleOpen: true,
    cycleMin: Infinity,
    cycleFrames: 0,
    cycleStartMs: nowMs,
    // M5：故障偵測與升級凍結
    canHitTrueSinceMs: null,
    fallbackTimestamps: [],
    frozen: false,
  };
}

// ─── 建立 Knee 近失追蹤器（per side）───────────────────────────────────────

function createKneeNearMissTracker() {
  return {
    nearMissDropCount: 0, // windowDropHit 近失次數
    nearMissSpeedCount: 0, // avgSpeedHit 近失次數
    lastAdjustMs: -Infinity,
    // 記錄初始值，供 min ratio 保護使用
    initWindowDropHit: KNEE_DEFAULT_THRESHOLDS.windowDropHit,
    initAvgSpeedHit: KNEE_DEFAULT_THRESHOLDS.avgSpeedHit,
  };
}

// ─── 主模組 ──────────────────────────────────────────────────────────────────

/**
 * @param {{ state: Object }} options
 */
export function createAdaptiveMonitor({ state }) {
  // ── 內部監控狀態 ──
  let troughTrackers = {}; // { [zoneKey]: TroughTracker }
  let kneeTrackers = {}; // { left: KneeTracker, right: KneeTracker }
  let visBuffers = {}; // { [landmarkIndex]: number[] }
  let visStableCount = 0; // Visibility 提升的連續穩定次數

  // 冷啟動
  let coldStartConsecutive = 0;
  let coldStartDone = false;
  let coldStartIntervalId = null;

  // 是否已完成正式校準（決定 M5 回退門檻與 baseline 來源）
  let formalCalibrated = false;

  // 定期評估 timer
  let visEvalIntervalId = null;

  // ── 初始化所有監控狀態 ──

  function initTrackers(nowMs = performance.now()) {
    troughTrackers = {};
    for (const zoneKey of Object.keys(ZONE_MAP)) {
      troughTrackers[zoneKey] = createTroughTracker(zoneKey, nowMs);
    }

    kneeTrackers = {
      left: createKneeNearMissTracker(),
      right: createKneeNearMissTracker(),
    };

    visBuffers = {};
    for (const idx of ALL_MONITORED_INDICES) {
      visBuffers[idx] = [];
    }
    visStableCount = 0;

    coldStartConsecutive = 0;
    coldStartDone = false;
    formalCalibrated = false;
  }

  // ── 冷啟動偵測 ──

  function checkColdStart() {
    // 若已有正式校準 profile，不覆蓋
    if (state.calibrationProfile !== null) {
      coldStartDone = true;
      return;
    }

    // 從最近的 visibility buffer 判斷關鍵節點是否都達標
    const threshold = state.visibilityThreshold ?? 0.75;
    const allVisible = CRITICAL_LANDMARK_INDICES.every((idx) => {
      const buf = visBuffers[idx];
      if (!buf || buf.length === 0) return false;
      // 只看最新 1 幀
      return buf[buf.length - 1] >= threshold;
    });

    if (allVisible) {
      coldStartConsecutive += 1;
    } else {
      coldStartConsecutive = 0;
    }

    if (coldStartConsecutive >= MONITOR_TUNING.COLD_START_FRAMES) {
      state.calibrationProfile = DEFAULT_CALIBRATION_PROFILE;
      coldStartDone = true;
      console.log("[adaptiveMonitor] 冷啟動完成，套用預設 profile");
      clearInterval(coldStartIntervalId);
      coldStartIntervalId = null;

      // 冷啟動完成後，以預設 profile 的 kneeBaseline 同步初始化 knee profile
      ensureKneeProfile();
    }
  }

  // ── 確保 calibrationProfile 中有 knee 欄位 ──

  function ensureKneeProfile() {
    if (!state.calibrationProfile) return;
    if (state.calibrationProfile.knee) return;

    state.calibrationProfile = {
      ...state.calibrationProfile,
      knee: {
        left: {
          windowDropHit: KNEE_DEFAULT_THRESHOLDS.windowDropHit,
          windowDropRelease: KNEE_DEFAULT_THRESHOLDS.windowDropRelease,
        },
        right: {
          windowDropHit: KNEE_DEFAULT_THRESHOLDS.windowDropHit,
          windowDropRelease: KNEE_DEFAULT_THRESHOLDS.windowDropRelease,
        },
      },
    };
  }

  // ── 取得 zone 的 canHit 狀態 ──

  function readCanHit(zoneKey) {
    const { side } = ZONE_MAP[zoneKey];
    const stateKey = side === "left" ? "leftState" : "rightState";
    return !!state[stateKey]?.canHit;
  }

  // ── 取得 zone 的 baseline 低谷值（M5 回退目標）──

  function getBaselineTrough(zoneKey) {
    const { side, direction } = ZONE_MAP[zoneKey];
    const restingMean =
      state.calibrationProfile?.[side]?.[direction]?._stats?.restingMean;
    if (typeof restingMean === "number" && restingMean > 0) return restingMean;
    return DEFAULT_TROUGH_PF[zoneKey] ?? 0.15;
  }

  // ── M1：循環開啟 / 關閉 ──

  function openCycle(tracker, nowMs) {
    tracker.cycleOpen = true;
    tracker.cycleMin = Infinity;
    tracker.cycleFrames = 0;
    tracker.cycleStartMs = nowMs;
  }

  function closeCycle(zoneKey, tracker, nowMs, provisional = false) {
    if (!tracker.cycleOpen) return;
    tracker.cycleOpen = false;

    const enoughFrames =
      tracker.cycleFrames >= MONITOR_TUNING.TROUGH_CYCLE_MIN_FRAMES;
    const validMin =
      Number.isFinite(tracker.cycleMin) &&
      tracker.cycleMin <= MONITOR_TUNING.TROUGH_MAX_PF;

    if (enoughFrames && validMin) {
      emitTroughSample(zoneKey, tracker, tracker.cycleMin, provisional);
      return;
    }

    console.debug(
      `[adaptiveMonitor] ${zoneKey} 樣本拒絕: ${
        enoughFrames ? "無有效低谷幀" : "幀數不足"
      } cycleMin=${
        Number.isFinite(tracker.cycleMin) ? tracker.cycleMin.toFixed(4) : "n/a"
      } frames=${tracker.cycleFrames}`,
    );
  }

  // ── M3：樣本推入 buffer 並更新中位數估計 ──

  function emitTroughSample(zoneKey, tracker, sample, provisional) {
    pushToBuffer(tracker.samples, sample, MONITOR_TUNING.TROUGH_SAMPLE_SIZE);

    console.log(
      `[adaptiveMonitor] ${zoneKey} 樣本產出${provisional ? "（暫結）" : ""}: ` +
        `${sample.toFixed(4)} frames=${tracker.cycleFrames} buffer=${tracker.samples.length}/${MONITOR_TUNING.TROUGH_SAMPLE_SIZE}`,
    );

    // 樣本不足時維持既有估計值，不更新 PF_HIT
    if (tracker.samples.length < MONITOR_TUNING.TROUGH_MIN_SAMPLES) return;

    const prevTrough = tracker.troughPF;
    tracker.troughPF = round4(median(tracker.samples));

    applyPFHitUpdate(zoneKey, { prevTrough });
  }

  // ── M1 + M2：PF 低谷採樣（每幀呼叫）──

  function updateTroughSampling(zoneKey, currentPF, nowMs) {
    const tracker = troughTrackers[zoneKey];
    if (!tracker || tracker.frozen) return;

    const canHit = readCanHit(zoneKey);
    const prevCanHit = tracker.prevCanHit;
    tracker.prevCanHit = canHit;

    // ── 循環邊緣偵測 ──
    // true → false：打擊觸發，手進入大腿附近，開啟谷底段
    if (prevCanHit && !canHit) {
      openCycle(tracker, nowMs);
    }
    // false → true：手抬離大腿（PF > PF_RELEASE），關閉並產出樣本
    else if (!prevCanHit && canHit) {
      closeCycle(zoneKey, tracker, nowMs);
    }

    if (!tracker.cycleOpen) return;

    // ── M2：僅有效幀計入（超界者拒絕，不 clamp）──
    if (currentPF <= MONITOR_TUNING.TROUGH_MAX_PF) {
      if (currentPF < tracker.cycleMin) tracker.cycleMin = currentPF;
      tracker.cycleFrames += 1;
    }

    // ── 暫結：循環開啟過久（手長時間擱在大腿上）──
    if (nowMs - tracker.cycleStartMs > MONITOR_TUNING.TROUGH_CYCLE_MAX_MS) {
      closeCycle(zoneKey, tracker, nowMs, true);
      openCycle(tracker, nowMs);
    }
  }

  // ── M5：故障回退與升級凍結（每幀呼叫）──

  function checkStuckFallback(zoneKey, nowMs) {
    const tracker = troughTrackers[zoneKey];
    if (!tracker || tracker.frozen) return;
    if (!state.calibrationProfile) return;

    // canHit 為 false 代表手在大腿附近，屬正常狀態（含使用者休息）
    if (!readCanHit(zoneKey)) {
      tracker.canHitTrueSinceMs = null;
      return;
    }

    if (tracker.canHitTrueSinceMs == null) {
      tracker.canHitTrueSinceMs = nowMs;
      return;
    }

    const threshold = formalCalibrated
      ? MONITOR_TUNING.FALLBACK_STUCK_MS
      : MONITOR_TUNING.FALLBACK_STUCK_MS_COLD;

    const stuckMs = nowMs - tracker.canHitTrueSinceMs;
    if (stuckMs < threshold) return;

    performFallback(zoneKey, tracker, nowMs, stuckMs);
  }

  function performFallback(zoneKey, tracker, nowMs, stuckMs) {
    const prevTrough = tracker.troughPF;
    const baseline = getBaselineTrough(zoneKey);

    // 清空樣本並還原估計值
    tracker.samples = [];
    tracker.troughPF = baseline;
    tracker.cycleOpen = false;
    tracker.cycleMin = Infinity;
    tracker.cycleFrames = 0;
    tracker.cycleStartMs = nowMs;
    tracker.canHitTrueSinceMs = null;

    // 升級判定：只保留時間窗內的回退記錄
    tracker.fallbackTimestamps = tracker.fallbackTimestamps.filter(
      (t) => nowMs - t <= MONITOR_TUNING.FALLBACK_ESCALATE_WINDOW_MS,
    );
    tracker.fallbackTimestamps.push(nowMs);
    const count = tracker.fallbackTimestamps.length;

    // 回退為復原動作，跳過 rate limit 直接賦值
    applyPFHitUpdate(zoneKey, { skipRateLimit: true, prevTrough });

    if (count >= MONITOR_TUNING.FALLBACK_ESCALATE_COUNT) {
      tracker.frozen = true;
    }

    console.warn(
      `[adaptiveMonitor] ${zoneKey} 故障回退: canHit 卡住 ${(stuckMs / 1000).toFixed(1)}s，` +
        `troughPF ${prevTrough.toFixed(4)} → ${baseline.toFixed(4)}（第 ${count} 次）` +
        (tracker.frozen ? " ── 已凍結該 zone 自適應，需重新校準" : "") +
        (formalCalibrated ? "" : " ── 冷啟動階段，建議執行正式校準"),
    );
  }

  /**
   * 更新單一 zone 的 PF_HIT / PF_RELEASE。
   * 事件驅動：僅在產出新樣本、reset() 或 M5 回退時呼叫，不再每幀執行。
   *
   * @param {string} zoneKey
   * @param {{ skipRateLimit?: boolean, prevTrough?: number }} [opts]
   *        skipRateLimit — reset() 與 M5 回退屬「外部強制指定」，不受 M4 約束
   */
  function applyPFHitUpdate(zoneKey, opts = {}) {
    if (!state.calibrationProfile) return;

    const zone = ZONE_MAP[zoneKey];
    const tracker = troughTrackers[zoneKey];
    if (!zone || !tracker) return;

    const { side, direction } = zone;
    const current = state.calibrationProfile[side]?.[direction];
    if (!current) return;

    const peakPFMean =
      current._stats?.peakPFMean ?? DEFAULT_PEAK_PF_MEAN[zoneKey] ?? 1.0;
    const peakCap = peakPFMean * TUNING.PF_HIT_PEAK_CAP_RATIO;

    // ── 目標值：clamp(troughPF × K1, PF_HIT_FLOOR, peakCap) ──
    let target = tracker.troughPF * TUNING.K1;
    target = Math.min(target, peakCap);
    target = Math.max(target, TUNING.PF_HIT_FLOOR);

    const prevPFHit =
      typeof current.PF_HIT === "number" ? current.PF_HIT : target;

    // ── M4：變化率限制 ──
    let newPFHit = target;
    let limited = false;

    if (!opts.skipRateLimit) {
      const maxStep = Math.max(
        Math.abs(prevPFHit) * MONITOR_TUNING.PF_HIT_MAX_STEP_RATIO,
        MONITOR_TUNING.PF_HIT_MIN_ABS_STEP,
      );
      if (target > prevPFHit + maxStep) {
        newPFHit = prevPFHit + maxStep;
        limited = true;
      } else if (target < prevPFHit - maxStep) {
        newPFHit = prevPFHit - maxStep;
        limited = true;
      }
      // 限速後仍須遵守上下限
      newPFHit = Math.min(Math.max(newPFHit, TUNING.PF_HIT_FLOOR), peakCap);
    }

    newPFHit = round4(newPFHit);

    // PF_RELEASE 等比跟隨 PF_HIT，維持固定的遲滯比例。
    // 使用與 calibrationProfile 相同的公式來源，避免兩邊漂移。
    const newRelease = computeReleaseFromHit(newPFHit, peakPFMean);

    if (current.PF_HIT === newPFHit && current.PF_RELEASE === newRelease) {
      return;
    }

    // 寫入（淺拷貝避免直接 mutate）
    state.calibrationProfile = {
      ...state.calibrationProfile,
      [side]: {
        ...state.calibrationProfile[side],
        [direction]: {
          ...current,
          PF_HIT: newPFHit,
          PF_RELEASE: newRelease,
        },
      },
    };

    const prevTroughStr =
      typeof opts.prevTrough === "number"
        ? `${opts.prevTrough.toFixed(4)} → `
        : "";

    console.log(
      `[adaptiveMonitor] ${zoneKey} 估計更新: troughPF ${prevTroughStr}${tracker.troughPF.toFixed(4)}, ` +
        `PF_HIT ${prevPFHit.toFixed(4)} → ${newPFHit.toFixed(4)}` +
        (limited ? `（受限速截斷，target=${target.toFixed(4)}）` : "") +
        (opts.skipRateLimit ? "（跳過限速）" : ""),
    );
  }

  // ── Knee 近失追蹤（每幀呼叫）──

  function updateKneeNearMiss(side, nowMs) {
    if (!state.calibrationProfile) return;

    const tracker = kneeTrackers[side];
    if (!tracker) return;

    // 成功觸發時重置近失計數
    const kneeStateKey = side === "left" ? "leftKneeState" : "rightKneeState";
    if (state[kneeStateKey]?.didHit) {
      tracker.nearMissDropCount = 0;
      tracker.nearMissSpeedCount = 0;
      return;
    }

    // 冷卻期間跳過
    if (nowMs - tracker.lastAdjustMs < MONITOR_TUNING.KNEE_ADJUST_COOLDOWN_MS)
      return;

    // 取得當前 knee history 的摘要（由 poseLoop 已維護在 state 中）
    const historyKey = side === "left" ? "leftKneeHistory" : "rightKneeHistory";
    const history = state[historyKey];
    if (!history || history.length < 2) return;

    // 取得當前使用中的門檻值
    const currentKneeProfile = state.calibrationProfile.knee?.[side];
    const currentDropHit =
      currentKneeProfile?.windowDropHit ??
      KNEE_DEFAULT_THRESHOLDS.windowDropHit;
    const currentSpeedHit = KNEE_DEFAULT_THRESHOLDS.avgSpeedHit; // avgSpeedHit 不存在 profile，取預設

    // 計算 knee motion 特徵（直接從 history 取最新窗口）
    const last = history[history.length - 1];
    const first = history[0];
    const windowDt = Math.max(1e-4, last.t - first.t);
    const windowDy = last.y - first.y;
    const avgDownSpeed = Math.max(0, windowDy) / windowDt;

    const didTrigger = state[kneeStateKey]?.didHit === false; // 確認本幀沒觸發

    // 近失判定 A：位移接近但未達門檻
    const nearDrop =
      windowDy >= currentDropHit * MONITOR_TUNING.NEAR_MISS_RATIO &&
      windowDy < currentDropHit;

    // 近失判定 B：速度接近但未達門檻
    const nearSpeed =
      avgDownSpeed >= currentSpeedHit * MONITOR_TUNING.NEAR_MISS_RATIO &&
      avgDownSpeed < currentSpeedHit;

    if (nearDrop) tracker.nearMissDropCount += 1;
    if (nearSpeed) tracker.nearMissSpeedCount += 1;

    // 觸發調整
    let adjusted = false;

    if (tracker.nearMissDropCount >= MONITOR_TUNING.NEAR_MISS_THRESHOLD) {
      const minAllowed =
        tracker.initWindowDropHit * MONITOR_TUNING.KNEE_ADJUST_MIN_RATIO;
      const newDropHit = Math.max(
        minAllowed,
        round4(currentDropHit * MONITOR_TUNING.KNEE_ADJUST_FACTOR),
      );
      // windowDropRelease 等比縮放
      const ratio =
        KNEE_DEFAULT_THRESHOLDS.windowDropRelease /
        KNEE_DEFAULT_THRESHOLDS.windowDropHit;
      const newDropRelease = round4(newDropHit * ratio);

      console.log(
        `[adaptiveMonitor] ${side} knee windowDropHit 調整: ${currentDropHit.toFixed(4)} → ${newDropHit.toFixed(4)}`,
      );

      ensureKneeProfile();
      state.calibrationProfile = {
        ...state.calibrationProfile,
        knee: {
          ...state.calibrationProfile.knee,
          [side]: {
            ...state.calibrationProfile.knee[side],
            windowDropHit: newDropHit,
            windowDropRelease: newDropRelease,
          },
        },
      };

      tracker.nearMissDropCount = 0;
      adjusted = true;
    }

    if (tracker.nearMissSpeedCount >= MONITOR_TUNING.NEAR_MISS_THRESHOLD) {
      // avgSpeedHit 調整：直接記錄在 tracker（poseLoop 讀取時需另行支援，見備註）
      const minAllowed =
        tracker.initAvgSpeedHit * MONITOR_TUNING.KNEE_ADJUST_MIN_RATIO;
      const newSpeedHit = Math.max(
        minAllowed,
        round4(currentSpeedHit * MONITOR_TUNING.KNEE_ADJUST_FACTOR),
      );

      console.log(
        `[adaptiveMonitor] ${side} knee avgSpeedHit 調整: ${currentSpeedHit.toFixed(4)} → ${newSpeedHit.toFixed(4)}`,
      );

      ensureKneeProfile();
      state.calibrationProfile = {
        ...state.calibrationProfile,
        knee: {
          ...state.calibrationProfile.knee,
          [side]: {
            ...state.calibrationProfile.knee[side],
            avgSpeedHit: newSpeedHit,
          },
        },
      };

      tracker.nearMissSpeedCount = 0;
      adjusted = true;
    }

    if (adjusted) {
      tracker.lastAdjustMs = nowMs;
    }
  }

  // ── Visibility 自適應評估（定期呼叫）──

  function evaluateVisibility() {
    const threshold = state.visibilityThreshold ?? 0.75;
    let shouldDrop = false;
    let allStable = true;

    // 踝節點的可見度比例（判斷是否計入主節點判斷）
    const anklePresence = {};
    for (const idx of ANKLE_LANDMARK_INDICES) {
      const buf = visBuffers[idx] ?? [];
      if (buf.length === 0) {
        anklePresence[idx] = 0;
        continue;
      }
      anklePresence[idx] = buf.filter((v) => v > 0).length / buf.length;
    }

    for (const idx of CRITICAL_LANDMARK_INDICES) {
      const buf = visBuffers[idx] ?? [];
      if (buf.length === 0) {
        allStable = false;
        continue;
      }

      const med = median(buf);
      const presence = buf.filter((v) => v > 0).length / buf.length;

      // 跳過踝相關節點（踝自身不是 CRITICAL，此處只處理 CRITICAL）
      // 若此節點是膝蓋（25/26），且對應踝節點可見度很低，不計入降低觸發
      let skipDrop = false;
      if (
        idx === 25 &&
        anklePresence[27] < MONITOR_TUNING.VIS_ANKLE_PRESENCE_RATIO
      )
        skipDrop = true;
      if (
        idx === 26 &&
        anklePresence[28] < MONITOR_TUNING.VIS_ANKLE_PRESENCE_RATIO
      )
        skipDrop = true;

      if (
        !skipDrop &&
        med < threshold * MONITOR_TUNING.VIS_DROP_MEDIAN_RATIO &&
        presence >= MONITOR_TUNING.VIS_DROP_MIN_PRESENCE
      ) {
        shouldDrop = true;
      }

      if (med < threshold * MONITOR_TUNING.VIS_RAISE_MEDIAN_RATIO) {
        allStable = false;
      }
    }

    if (shouldDrop) {
      const newThreshold = Math.max(
        MONITOR_TUNING.VIS_MIN,
        round4(
          (state.visibilityThreshold ?? 0.75) - MONITOR_TUNING.VIS_STEP_DOWN,
        ),
      );
      if (newThreshold !== state.visibilityThreshold) {
        console.log(
          `[adaptiveMonitor] visibilityThreshold 降低: ${state.visibilityThreshold?.toFixed(2)} → ${newThreshold}`,
        );
        state.visibilityThreshold = newThreshold;
      }
      visStableCount = 0;
      return;
    }

    if (allStable) {
      visStableCount += 1;
      if (visStableCount >= MONITOR_TUNING.VIS_RAISE_STABLE_COUNT) {
        const newThreshold = Math.min(
          MONITOR_TUNING.VIS_MAX,
          round4(
            (state.visibilityThreshold ?? 0.75) + MONITOR_TUNING.VIS_STEP_UP,
          ),
        );
        if (newThreshold !== state.visibilityThreshold) {
          console.log(
            `[adaptiveMonitor] visibilityThreshold 提升: ${state.visibilityThreshold?.toFixed(2)} → ${newThreshold}`,
          );
          state.visibilityThreshold = newThreshold;
        }
        visStableCount = 0;
      }
    } else {
      visStableCount = 0;
    }
  }

  // ── 公開 API ─────────────────────────────────────────────────────────────

  return {
    /**
     * 啟動監控。bootstrap 時呼叫。
     */
    start() {
      initTrackers();

      // 冷啟動定時檢查（每幀 feedFrame 更新 buffer，這裡只做判斷）
      if (!coldStartIntervalId) {
        coldStartIntervalId = setInterval(() => {
          if (!coldStartDone) checkColdStart();
        }, MONITOR_TUNING.COLD_START_CHECK_INTERVAL);
      }

      // Visibility 定期評估
      if (!visEvalIntervalId) {
        visEvalIntervalId = setInterval(() => {
          evaluateVisibility();
        }, MONITOR_TUNING.VIS_EVAL_INTERVAL_MS);
      }
    },

    /**
     * 停止監控（鏡頭關閉時呼叫）。
     */
    stop() {
      clearInterval(coldStartIntervalId);
      clearInterval(visEvalIntervalId);
      coldStartIntervalId = null;
      visEvalIntervalId = null;
    },

    /**
     * 重置所有監控狀態。
     * 正式校準完成後呼叫，以新 profile 重新初始化低谷追蹤器。
     */
    reset() {
      const nowMs = performance.now();
      initTrackers(nowMs);
      coldStartDone = true; // 正式校準完成，不再執行冷啟動
      formalCalibrated = true;

      // 確保 knee profile 欄位存在
      ensureKneeProfile();

      // 以新 profile 的 restingMean 為起點，直接賦值 PF_HIT（跳過 M4 限速）
      for (const zoneKey of Object.keys(ZONE_MAP)) {
        const tracker = troughTrackers[zoneKey];
        if (!tracker) continue;
        tracker.troughPF = round4(getBaselineTrough(zoneKey));
        tracker.cycleStartMs = nowMs;
        applyPFHitUpdate(zoneKey, { skipRateLimit: true });
      }

      console.log("[adaptiveMonitor] 重置完成（正式校準後）");
    },

    /**
     * 每幀由 main.js 的 onFrame callback 呼叫。
     * 收集 landmark visibility，並執行 PF 低谷更新與 Knee 近失追蹤。
     *
     * @param {Object[]} poseLandmarks - MediaPipe 的 landmarks 陣列
     * @param {number}   nowMs         - performance.now() 時間戳
     */
    feedFrame(poseLandmarks, nowMs) {
      if (!poseLandmarks) return;

      // ── 收集 visibility ──
      for (const idx of ALL_MONITORED_INDICES) {
        const lm = poseLandmarks[idx];
        const vis = lm?.visibility ?? 0;
        pushToBuffer(visBuffers[idx], vis, MONITOR_TUNING.VIS_HISTORY_FRAMES);
      }

      // 冷啟動前不執行 PF / Knee 更新
      if (!state.calibrationProfile) return;

      // ── PF 低谷追蹤 ──
      const leftPF = state.leftThighCordon?.PF;
      const rightPF = state.rightThighCordon?.PF;

      if (leftPF != null) updateTroughSampling("left_front", leftPF, nowMs);
      if (rightPF != null) updateTroughSampling("right_front", rightPF, nowMs);

      // 故障偵測：canHit 卡在 true 代表「有動作但打不中」
      checkStuckFallback("left_front", nowMs);
      checkStuckFallback("right_front", nowMs);

      // ── Knee 近失追蹤 ──
      updateKneeNearMiss("left", nowMs);
      updateKneeNearMiss("right", nowMs);
    },
  };
}