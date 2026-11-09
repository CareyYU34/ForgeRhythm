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
 * 一小節的 BPM ＝ 60000 × Σ拍數 ÷ Σ毫秒，取 groove 最近累積滿 BEAT_LIVE_BEATS 拍的間隔
 *   （見下方「每拍毫秒」為什麼不能逐擊算）。
 *
 * 基點 BPM ＝ 這段 groove 結束（進入 fill）時「最後一小節」的 BPM；不足一小節沿用上一次。
 *   過門中顯示它、自動音也用它（過門的手速不照譜，不拿來換算）。
 *
 * ⚠ 基點直接跟著手走，沒有「只接受慢慢漂移」也沒有「第一次太快折半」（舊做法）：
 *   那兩條是為了讓 BPM 穩在原處，實測「手快了 BPM 卻不上去」，第一次量到 163 被折成 81。
 *   現在的原則是手速就是速度（見 grooveSelector），BPM 太快／太慢由 selector 換密度處理。
 *
 * fill 手速 ＝ 每秒幾擊，不看 fill 的譜（只給 log 參考）。
 *
 * 離群值（只用在 fill 手速）：以中位數為準，超出 [÷OUTLIER, ×OUTLIER] 的間隔不計
 *   （中途停頓等）。
 *
 * ═══ 每拍毫秒（getBeatMs）═══
 *
 * 給自動音排程與畫面顯示用（譜上的拍數 → 毫秒），要跟得上使用者「現在」的速度：
 * 這段 groove 最近的間隔累積滿 BEAT_LIVE_BEATS 拍 → 這些間隔的 Σ毫秒 ÷ Σ拍數；
 * 否則（剛換段、過門中）退回基點。過門的手速不照譜，不拿來換算。
 *
 * ⚠ 不能用「最近幾個間隔的中位數」（舊做法，實測會跳 30–50 BPM）：
 *   · 使用者多半用固定手速打，不照譜上的 8 分／16 分變化間隔 ——
 *     同樣 230ms，落在 0.5 拍算 130 BPM、落在 0.25 拍算 65 BPM，逐擊跟著譜跳；
 *   · 左右手間隔不對稱（200／267ms 交替）加上 30fps 量化，同為 8 分也差 ±15%；
 *   · 偵測漏一擊 → 間隔加倍。
 *   累積滿一小節再算總和比：8 分／16 分的比例固定、左右手互相抵銷、漏一擊只佔一小部分。
 *
 * ═══ 除錯 ═══
 *
 * hit() 回傳剛結算的間隔（含基點有沒有更新、為什麼），getBeatInfo() 回傳
 * 每拍毫秒的來源與取樣 —— 由 freePlayRouter 印成 [tempo] log，本模組不印。
 */

/** 兩擊相隔小於這個值視為同一擊（雙手同時打）（ms） */
export const MERGE_MS = 50;

/** 離群倍率（fill 手速）：間隔偏離中位數超過這個倍數就不計。只擋真正的停頓 */
const OUTLIER = 3;

/** getBeatMs：即時值取這段 groove 最近累積滿幾拍的間隔（一小節） */
const BEAT_LIVE_BEATS = 4;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * 最近累積滿 BEAT_LIVE_BEATS 拍的間隔：{ beatMs, n }；不足一小節回傳 null
 * @param {Array<{ms: number, beats: number}>} intervals
 */
function lastBar(intervals) {
  let beats = 0, ms = 0, n = 0;
  for (let i = intervals.length - 1; i >= 0 && beats < BEAT_LIVE_BEATS - 1e-6; i--) {
    beats += intervals[i].beats;
    ms += intervals[i].ms;
    n++;
  }
  return beats >= BEAT_LIVE_BEATS - 1e-6 ? { beatMs: ms / beats, n } : null;
}

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

  /**
   * ① 結算「上一擊 → 這一擊」的間隔
   * @returns {?{ ms, beats, inFill, baseline?: { measured, prev, next } }}
   *   剛結算的間隔（除錯用）；第一擊回傳 null。baseline = 這一擊觸發了基點更新
   */
  function hit(nowMs) {
    let settled = null;
    if (lastMs !== null && pending) {
      const iv = { ms: nowMs - lastMs, beats: pending.beats };
      settled = { ...iv, inFill: pending.inFill };
      if (pending.inFill) {
        if (!fillIntervals.length) {
          // groove → fill：這段 groove 結束，基點 = 最後一小節
          const bar = lastBar(grooveIntervals);
          const bpm = bar && 60000 / bar.beatMs;
          const prev = baselineBpm;
          if (bpm !== null) baselineBpm = bpm;
          settled.baseline = { measured: bpm, prev, next: baselineBpm };
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
    return settled;
  }

  /** ③ 記下這一擊的時值與段落，等下一擊來結算 */
  function setStep(beats, inFill) {
    pending = { beats, inFill };
  }

  /** 上一段 groove 最後一小節的 BPM；還量不到回傳 null */
  function getBaselineBpm() {
    return baselineBpm;
  }

  /**
   * 每拍毫秒與它的來源（除錯用；getBeatMs 只取 beatMs）
   * @returns {{ beatMs: ?number, source: "live"|"baseline"|"none", samples: number }}
   *   samples = 即時值用了幾個間隔
   */
  function getBeatInfo() {
    const bar = fillIntervals.length ? null : lastBar(grooveIntervals);
    if (bar) return { beatMs: bar.beatMs, source: "live", samples: bar.n };
    if (baselineBpm) return { beatMs: 60000 / baselineBpm, source: "baseline", samples: 0 };
    return { beatMs: null, source: "none", samples: 0 };
  }

  /** 目前一拍幾毫秒（自動音排程用）；量不到回傳 null */
  function getBeatMs() {
    return getBeatInfo().beatMs;
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

  return { isDuplicate, hit, setStep, reset, getBaselineBpm, getBeatMs, getBeatInfo, getFillHitRate };
}
