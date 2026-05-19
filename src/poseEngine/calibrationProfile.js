/**
 * calibrationProfile.js
 *
 * 校準 JSON → 動態參數 Profile
 *
 * 職責：
 *   1. 接收 calibration.getSession() 輸出的 JSON
 *   2. 計算每個 zone (side × direction) 的動態打擊參數
 *   3. 輸出標準化的 CalibrationProfile 供 poseLoop / conditions 使用
 *   4. 評估校準品質，產生警告
 *
 * 設計原則：
 *   - poseLoop 和 conditions 不需要知道校準細節
 *   - 所有公式的「魔法數字」集中在 TUNING 物件，方便調參
 */

// ─── 可調參數（集中管理）─────────────────────────────────────────────────────

const TUNING = {
  // PF_HIT = restingPF × K1（手接近大腿多近才算打擊）
  K1: 2.0,

  // PF_RELEASE = restingPF × K2（手離開多遠才算釋放，允許下一次打擊）
  // 注意：實際使用時取所有 zone 中最大的 PF_RELEASE 作為統一門檻
  K2: 2.0,

  // SPEED_HIT = peakSpeed_mean × K3（速度門檻為校準打擊速度的百分比）
  K3: 0.30,

  // COOLDOWN_MS = durationMs_mean × K4（冷卻時間為校準打擊時長的百分比）
  K4: 0.80,

  // 冷卻時間的上下限（ms）
  MIN_COOLDOWN_MS: 80,
  MAX_COOLDOWN_MS: 400,

  // PF_HIT 不能超過 peakPF 平均值的這個比例（安全上限）
  PF_HIT_PEAK_CAP_RATIO: 0.60,

  // PF_HIT 的絕對下限：即使 restingPF × K1 算出來更低，也至少要這個值
  // 太低會導致聲音延遲（手已碰到大腿才觸發）
  PF_HIT_FLOOR: 0.15,

  // 校準品質判斷：strike 間的 restingPF 變異係數超過此值則警告
  RESTING_PF_CV_WARN: 0.35,

  // 校準品質判斷：peakHandSpeed 變異係數超過此值則警告
  PEAK_SPEED_CV_WARN: 0.50,

  // ── 膝蓋補償係數 ──────────────────────────────────────────────────────────
  // 膝蓋每上升 1 個 normalized 單位，PF_HIT / PF_RELEASE 門檻同步增加的量。
  // 目的：抵消提膝時大腿線旋轉造成的 PF 幾何漂移，避免誤觸發手部打擊。
  //
  // 推導：提膝 Δy ≈ 0.1 時，PF 漂移約 0.05~0.15（依大腿長度而定）。
  // K_KNEE = 1.8 → Δy=0.1 時補償 +0.18，安全覆蓋大多數體型。
  // 若發現補償過度（手打腿時沒聲音）可降低；補償不足仍誤觸發則提高。
  K_KNEE: 1.8,
};

// ─── 統計工具 ───────────────────────────────────────────────────────────────

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function cv(arr) {
  const m = mean(arr);
  if (m === 0) return 0;
  return stddev(arr) / m;
}

// ─── 核心：從單一 zone 的 strikes 計算動態參數 ──────────────────────────────

function computeZoneParams(strikes, zoneKey) {
  if (!strikes || strikes.length === 0) {
    return {
      PF_HIT: null,
      PF_RELEASE: null,
      SPEED_HIT: null,
      COOLDOWN_MS: null,
      isReliable: false,
      reason: `${zoneKey}: 無打擊資料`,
    };
  }

  const restingPFs = strikes.map((s) => s.restingPF);
  const peakPFs = strikes.map((s) => s.peakPF);
  const peakSpeeds = strikes.map((s) => s.peakHandSpeed);
  const durations = strikes.map((s) => s.durationMs);

  const restingMean = mean(restingPFs);
  const peakPFMean = mean(peakPFs);
  const peakSpeedMean = mean(peakSpeeds);
  const durationMean = mean(durations);

  // ── PF_HIT：取 restingPF × K1，但加上上限和下限保護 ──
  let PF_HIT = restingMean * TUNING.K1;

  // 上限：不能太接近 peakPF（否則幾乎抬不起手就觸發）
  const peakCap = peakPFMean * TUNING.PF_HIT_PEAK_CAP_RATIO;
  PF_HIT = Math.min(PF_HIT, peakCap);

  // 下限：避免太低導致延遲
  PF_HIT = Math.max(PF_HIT, TUNING.PF_HIT_FLOOR);

  // ── PF_RELEASE：用於統一門檻計算，這裡先算 per-zone 的值 ──
  const PF_RELEASE = restingMean * TUNING.K2;

  // ── SPEED_HIT ──
  const SPEED_HIT = peakSpeedMean * TUNING.K3;

  // ── COOLDOWN_MS ──
  const COOLDOWN_MS = Math.round(
    Math.max(
      TUNING.MIN_COOLDOWN_MS,
      Math.min(TUNING.MAX_COOLDOWN_MS, durationMean * TUNING.K4),
    ),
  );

  // ── 品質評估 ──
  const warnings = [];
  if (cv(restingPFs) > TUNING.RESTING_PF_CV_WARN) {
    warnings.push(
      `${zoneKey}: restingPF 變異過大 (CV=${(cv(restingPFs) * 100).toFixed(1)}%)`,
    );
  }
  if (cv(peakSpeeds) > TUNING.PEAK_SPEED_CV_WARN) {
    warnings.push(
      `${zoneKey}: peakHandSpeed 變異過大 (CV=${(cv(peakSpeeds) * 100).toFixed(1)}%)`,
    );
  }

  return {
    PF_HIT: round4(PF_HIT),
    PF_RELEASE: round4(PF_RELEASE),
    SPEED_HIT: round4(SPEED_HIT),
    COOLDOWN_MS,
    isReliable: warnings.length === 0,
    warnings,
    // 保留原始統計供 debug
    _stats: {
      restingMean: round4(restingMean),
      peakPFMean: round4(peakPFMean),
      peakSpeedMean: round4(peakSpeedMean),
      durationMean: Math.round(durationMean),
    },
  };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ─── 公開 API ───────────────────────────────────────────────────────────────

/**
 * 從校準 session 建立完整的 CalibrationProfile。
 *
 * @param {Object} session - calibration.getSession() 的回傳值
 * @returns {CalibrationProfile|null} 校準 profile，或 session 無效時回傳 null
 */
export function buildCalibrationProfile(session) {
  if (!session || !session.zones) return null;

  const SIDE_ZONE_MAP = {
    right_front: { side: "right", direction: "front" },
    left_front: { side: "left", direction: "front" },
    right_outer: { side: "right", direction: "outer" },
    left_outer: { side: "left", direction: "outer" },
  };

  const profile = {
    right: { front: null, outer: null },
    left: { front: null, outer: null },
    PF_RELEASE_UNIFIED: 0,
    isCalibrated: true,
    calibratedAt: session.timestamp ?? new Date().toISOString(),
    sessionId: session.sessionId ?? null,
    warnings: [],

    // ── 膝蓋 baseline y（normalized 座標）──────────────────────────────────
    // 來源：校準時 FRONT_SNAPSHOT 階段的 bodySnapshot 平均膝蓋位置。
    // poseLoop 用這個值計算「膝蓋上升量」，再動態補償 PF_HIT / PF_RELEASE。
    kneeBaseline: {
      left_y:  round4(session.bodySnapshot?.leftKnee?.y  ?? null),
      right_y: round4(session.bodySnapshot?.rightKnee?.y ?? null),
    },
  };

  // 計算每個 zone 的參數
  let maxRelease = 0;

  for (const [zoneKey, { side, direction }] of Object.entries(SIDE_ZONE_MAP)) {
    const zoneData = session.zones[zoneKey];
    const strikes = zoneData?.strikes ?? [];
    const params = computeZoneParams(strikes, zoneKey);

    profile[side][direction] = {
      PF_HIT: params.PF_HIT,
      SPEED_HIT: params.SPEED_HIT,
      COOLDOWN_MS: params.COOLDOWN_MS,
      isReliable: params.isReliable,
      _stats: params._stats,
    };

    // 收集 per-zone 的 PF_RELEASE，取最大值作為統一門檻
    if (params.PF_RELEASE != null && params.PF_RELEASE > maxRelease) {
      maxRelease = params.PF_RELEASE;
    }

    // 收集警告
    if (params.warnings) {
      profile.warnings.push(...params.warnings);
    }
  }

  // 統一 PF_RELEASE：取所有 zone 中最大的值
  profile.PF_RELEASE_UNIFIED = round4(maxRelease);

  return profile;
}

/**
 * 取得指定 side + direction 的動態參數。
 *
 * @param {CalibrationProfile} profile
 * @param {"right"|"left"} side
 * @param {"front"|"outer"} direction
 * @returns {{ PF_HIT: number, PF_RELEASE: number, SPEED_HIT: number, COOLDOWN_MS: number }}
 */
export function getZoneParams(profile, side, direction) {
  if (!profile) return null;

  const zone = profile[side]?.[direction];
  if (!zone || zone.PF_HIT == null) return null;

  return {
    PF_HIT: zone.PF_HIT,
    PF_RELEASE: profile.PF_RELEASE_UNIFIED,
    SPEED_HIT: zone.SPEED_HIT,
    COOLDOWN_MS: zone.COOLDOWN_MS,
  };
}

/**
 * 計算膝蓋上升所需的 PF 補償量。
 *
 * 當膝蓋 y 值低於 baseline（= 膝蓋往上提），大腿線旋轉會造成 PF 幾何漂移，
 * 導致手部打擊誤觸發。此函式回傳一個正偏移量，讓呼叫端動態拉高
 * PF_HIT 和 PF_RELEASE，使漂移的 PF 值無法穿越門檻。
 *
 * @param {CalibrationProfile} profile
 * @param {"right"|"left"} side
 * @param {number} currentKneeY - 當前幀膝蓋的 normalized y 座標
 * @returns {number} 應疊加到 PF_HIT / PF_RELEASE 的補償量（>= 0）
 */
export function calcKneeRisingAdj(profile, side, currentKneeY) {
  if (!profile) return 0;

  const baseline_y = profile.kneeBaseline?.[`${side}_y`];
  if (baseline_y == null || currentKneeY == null) return 0;

  // 提膝 = y 值變小（畫面座標向上）→ 差值為正
  const rise = baseline_y - currentKneeY;
  if (rise <= 0) return 0; // 膝蓋在 baseline 以下或等高，不補償

  return rise * TUNING.K_KNEE;
}

/**
 * 校準品質評估（獨立呼叫，用於 UI 提示）。
 *
 * @param {Object} session - calibration.getSession() 的回傳值
 * @returns {{ isGood: boolean, warnings: string[] }}
 */
export function evaluateCalibrationQuality(session) {
  if (!session || !session.zones) {
    return { isGood: false, warnings: ["無效的校準資料"] };
  }

  // 直接用 buildCalibrationProfile 的結果來判斷
  const profile = buildCalibrationProfile(session);
  if (!profile) {
    return { isGood: false, warnings: ["無法建立校準 profile"] };
  }

  return {
    isGood: profile.warnings.length === 0,
    warnings: profile.warnings,
  };
}

/**
 * 匯出 TUNING 常數，供外部 debug / UI 顯示。
 */
export { TUNING };