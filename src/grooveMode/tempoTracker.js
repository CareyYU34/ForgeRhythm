/**
 * grooveMode/tempoTracker.js
 *
 * 職責：量使用者的手速 —— 每秒打幾擊。只看打擊的時間點，不看譜。
 *
 * ═══ 只有這裡（與 freePlayRouter）知道時間 ═══
 *
 * grooveEngine 刻意不知道時間；本模組也不知道譜（不知道 groove、fill、拍數、小節）。
 * 手速換成 BPM（÷ 密度）、換成自動音的毫秒，都是 freePlayRouter 的事。
 *
 * ═══ 用法（每一擊） ═══
 *
 *     if (tracker.isDuplicate(now)) return;   // 雙手同時打 → 併成一擊
 *     tracker.hit(now);                       // 記下「上一擊 → 這一擊」的間隔
 *     tracker.getHitRate();                   // 目前每秒幾擊
 *     tracker.getTypicalRate();               // 平常每秒幾擊（最近 30 秒中位數）
 *
 * ⚠ hit 必須在 engine.hit 之前：fill 最後一擊的當下，引擎就要挑下一個 groove，
 *   那時這一擊的間隔必須已經算進手速。
 *
 * ═══ 量法 ═══
 *
 * 手速 ＝ 最近 RATE_WINDOW 個間隔的「擊數 ÷ 總時間」，groove、過門、換段都不分開算
 * （手速就是手速，跟正在打哪一段無關）。
 *   · 用總和比、不用中位數：左右手間隔不對稱（200／267ms 交替）會互相抵銷，
 *     偵測漏一擊只佔一小部分。
 *   · 離群值：以中位數為準，超出 [÷OUTLIER, ×OUTLIER] 的間隔不計（中途停頓等）。
 *
 * 平常的手速 ＝ 最近 TYPICAL_MS 內所有間隔的中位數換成每秒幾擊。
 *   selector 拿「手速 ÷ 平常」決定給疏、中、密哪一檔（見 grooveSelector）。
 *   ⚠ 30 秒不能拉長：太長的話玩的前面幾分鐘門檻都是固定的，動態化就失去意義。
 *   閒置歸零（reset）時一起清掉，重新開始打就重新量。
 *
 * ⚠ 舊做法是「譜上的拍數 ÷ 時間」算 BPM，被小節綁住：
 *   · 要累積滿一小節才算得準，兩小節一輪、兩小節擊數不同的 groove 會每小節跳 40%；
 *   · 過門的譜跟手不一致，只能凍結在「基點」；
 *   · 換段時密度改變，前一小節的速度不適用，自動音排錯（shuffle 第一小節三連音不見）。
 *   改成只看手速後這些都不存在：BPM ＝ 手速 ÷ 目前 groove 的密度，換段當下就換算好。
 *
 * ═══ 除錯 ═══
 *
 * hit() 回傳剛結算的間隔，getHitRate() 附上用了幾個間隔 ——
 * 由 freePlayRouter 印成 [tempo] log，本模組不印。
 */

/** 兩擊相隔小於這個值視為同一擊（雙手同時打）（ms） */
export const MERGE_MS = 50;

/** 手速取最近幾個間隔（偶數：左右手各半，不對稱互相抵銷） */
const RATE_WINDOW = 8;

/** 平常的手速取最近多久的間隔（ms） */
const TYPICAL_MS = 30000;

/** 至少要有幾個間隔才算得出手速（剛開始打、閒置歸零後） */
const RATE_MIN = 3;

/** 離群倍率：間隔偏離中位數超過這個倍數就不計。只擋真正的停頓 */
const OUTLIER = 3;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function createTempoTracker() {
  let lastMs;
  /** 最近的間隔（ms），最多 RATE_WINDOW 個 */
  let intervals;
  /** 最近 TYPICAL_MS 內的間隔：{ at（這一擊的時間）, ms } */
  let history;

  function reset() {
    lastMs = null;
    intervals = [];
    history = [];
  }
  reset();

  function isDuplicate(nowMs) {
    return lastMs !== null && nowMs - lastMs < MERGE_MS;
  }

  /**
   * 記下「上一擊 → 這一擊」的間隔
   * @returns {?number} 剛結算的間隔（ms，除錯用）；第一擊回傳 null
   */
  function hit(nowMs) {
    const ms = lastMs === null ? null : nowMs - lastMs;
    if (ms !== null) {
      intervals.push(ms);
      if (intervals.length > RATE_WINDOW) intervals.shift();
      history.push({ at: nowMs, ms });
      while (nowMs - history[0].at > TYPICAL_MS) history.shift();
    }
    lastMs = nowMs;
    return ms;
  }

  /**
   * 目前每秒幾擊
   * @returns {{ rate: ?number, samples: number }} 量不到時 rate = null；samples = 用了幾個間隔
   */
  function getHitRate() {
    if (intervals.length < RATE_MIN) return { rate: null, samples: 0 };
    const mid = median(intervals);
    const kept = intervals.filter((ms) => ms <= mid * OUTLIER && ms >= mid / OUTLIER);
    if (kept.length < RATE_MIN) return { rate: null, samples: 0 };
    const total = kept.reduce((s, ms) => s + ms, 0);
    return { rate: (1000 * kept.length) / total, samples: kept.length };
  }

  /** 平常每秒幾擊（最近 TYPICAL_MS 內的間隔中位數）；不足 RATE_MIN 個間隔回傳 null */
  function getTypicalRate() {
    if (history.length < RATE_MIN) return null;
    return 1000 / median(history.map((h) => h.ms));
  }

  return { isDuplicate, hit, reset, getHitRate, getTypicalRate };
}
