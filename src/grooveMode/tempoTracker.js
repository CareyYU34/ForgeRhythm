/**
 * grooveMode/tempoTracker.js
 *
 * 職責：量使用者的打擊速度 —— groove 期間的「基點 BPM」與 fill 期間的「手速」。
 *
 * ═══ 只有這裡（與 freePlayRouter）知道時間 ═══
 *
 * grooveEngine 刻意不知道時間；本模組也不知道譜，只收「上一擊的時值（拍數）
 * 與它屬於 groove 還是 fill」。兩邊由 freePlayRouter 接起來。
 *
 * ═══ 用法（每一擊，順序不能錯） ═══
 *
 *     if (tracker.isDuplicate(now)) return;   // 雙手同時打 → 併成一擊
 *     tracker.hit(now);                       // ① 先結算「上一擊 → 這一擊」的間隔
 *     const step = engine.hit(...);           // ② 引擎走一格（可能在這裡決定下一個 groove）
 *     tracker.setStep(step.beats, step.inFill); // ③ 記下這一擊的時值，等下一擊來結算
 *
 * ⚠ ① 必須在 ② 之前：fill 最後一擊的當下，引擎就要挑下一個 groove，
 *   那時 fill 的間隔必須已經記進來。
 *
 * ═══ 量法 ═══
 *
 * 基點 BPM ＝ 60000 × Σ拍數 ÷ Σ毫秒，以「整段 groove」計（跳過開頭 WARMUP 個間隔）。
 *   不逐擊算：這個模式下節奏的快慢是使用者決定的，平均手速打切分 groove 時，
 *   單擊的 BPM 會亂跳，整段的總拍數 ÷ 總時間才穩，也順便平均掉 30fps 的量化誤差。
 *   每段 groove 結束（進入 fill）時更新一次；太短（間隔數不足）沿用上一次。
 *
 * ⚠ 基點只接受「慢慢漂移」（不能省）：新量到的值與舊基點相差 ≤ DRIFT 才採用，
 *   否則保留舊基點。量到的 BPM 是「依譜解讀」的結果 ——
 *     · 使用者在 groove 中途手速加倍，8 分的譜會量出兩倍 BPM；
 *     · 往目標密度移動時，中間那一檔 groove 本來就對不準（例如 213 BPM）。
 *   這些若被當成新基點，加速會被吸收掉，selector 就永遠換不到該換的密度。
 *   第一次（沒有舊基點）→ 太快的往下折到 FOLD_MAX 以下，
 *   例如 8 分打到 240 → 120（＝ 當成 16 分解讀）。
 *   只往下折：慢的不往上折，因為沒有比 8 分更疏的 groove 能對應。
 *
 * fill 手速 ＝ 每秒幾擊，不看 fill 的譜（下一個 groove 要用的是使用者「手」的速度，
 *   再由上一層依候選 groove 的密度換算成 BPM）。
 *
 * 離群值：每段以「每拍毫秒」的中位數為準，超出 [÷OUTLIER, ×OUTLIER] 的間隔不計
 *   （中途停頓等）。
 */

/** 兩擊相隔小於這個值視為同一擊（雙手同時打）（ms） */
export const MERGE_MS = 50;

/** 每段 groove 開頭不計入基點的間隔數（起手通常不穩） */
const WARMUP = 2;

/** 基點至少要有幾個有效間隔才更新 */
const MIN_BASELINE_INTERVALS = 4;

/**
 * 離群倍率：每拍毫秒偏離中位數超過這個倍數就不計。
 * ⚠ 不能小於 2 太多：使用者用平均手速打 8 分／16 分混合的譜時，
 *   8 分那幾擊的「每拍毫秒」本來就是中位數的一半，2 倍會被誤刪而讓基點偏慢。
 *   只擋真正的停頓。
 */
const OUTLIER = 3;

/** 新基點與舊基點相差在這個倍數內才採用（慢慢漂移） */
const DRIFT = 1.2;

/** 第一次取基點時，超過這個 BPM 就 ÷2 直到低於它 */
const FOLD_MAX = 140;

/** 第一次：太快的往下折 */
function fold(bpm) {
  while (bpm >= FOLD_MAX) bpm /= 2;
  return bpm;
}

/** 新的基點：第一次太快的往下折；之後只接受慢慢漂移 */
function nextBaseline(measured, prev) {
  if (prev === null) return fold(measured);
  return Math.abs(Math.log(measured / prev)) <= Math.log(DRIFT) ? measured : prev;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 去掉離群值後的 BPM；間隔不足回傳 null */
function bpmOf(intervals, minCount) {
  if (intervals.length < minCount) return null;
  const mid = median(intervals.map((iv) => iv.ms / iv.beats));
  const kept = intervals.filter((iv) => {
    const r = iv.ms / iv.beats / mid;
    return r <= OUTLIER && r >= 1 / OUTLIER;
  });
  if (kept.length < minCount) return null;
  const beats = kept.reduce((s, iv) => s + iv.beats, 0);
  const ms = kept.reduce((s, iv) => s + iv.ms, 0);
  return (60000 * beats) / ms;
}

export function createTempoTracker() {
  let lastMs, pending;
  /** 目前這段 groove／fill 的間隔：{ ms, beats } */
  let grooveIntervals, fillIntervals;
  let baselineBpm;

  function reset() {
    lastMs = null;
    pending = null; // 上一擊的 { beats, inFill }，等下一擊來結算
    grooveIntervals = [];
    fillIntervals = [];
    baselineBpm = null;
  }
  reset();

  function isDuplicate(nowMs) {
    return lastMs !== null && nowMs - lastMs < MERGE_MS;
  }

  /** ① 結算「上一擊 → 這一擊」的間隔 */
  function hit(nowMs) {
    if (lastMs !== null && pending) {
      const iv = { ms: nowMs - lastMs, beats: pending.beats };
      if (pending.inFill) {
        if (!fillIntervals.length) {
          // groove → fill：這段 groove 結束，更新基點
          const bpm = bpmOf(grooveIntervals.slice(WARMUP), MIN_BASELINE_INTERVALS);
          if (bpm !== null) baselineBpm = nextBaseline(bpm, baselineBpm);
        }
        fillIntervals.push(iv);
      } else {
        if (fillIntervals.length) {
          // fill → groove：新的一段 groove 開始
          grooveIntervals = [];
          fillIntervals = [];
        }
        grooveIntervals.push(iv);
      }
    }
    lastMs = nowMs;
  }

  /** ③ 記下這一擊的時值與段落，等下一擊來結算 */
  function setStep(beats, inFill) {
    pending = { beats, inFill };
  }

  /** 最近一段 groove 的基點 BPM；還量不到回傳 null */
  function getBaselineBpm() {
    return baselineBpm;
  }

  /** 目前這段 fill 的手速（每秒幾擊）；fill 還沒開始或不足一個間隔回傳 null */
  function getFillHitRate() {
    if (!fillIntervals.length) return null;
    // 手速不看譜：每個間隔都當 1 拍算，bpmOf 的結果 ÷ 60 = 每秒幾擊
    const bpm = bpmOf(
      fillIntervals.map((iv) => ({ ms: iv.ms, beats: 1 })),
      1,
    );
    return bpm === null ? null : bpm / 60;
  }

  return { isDuplicate, hit, setStep, reset, getBaselineBpm, getFillHitRate };
}
