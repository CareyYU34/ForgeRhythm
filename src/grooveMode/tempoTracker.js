/**
 * grooveMode/tempoTracker.js
 *
 * 職責：量使用者的手速 —— 每秒打幾擊，並判斷「比平常快／慢」的狀態。只看打擊的時間點，不看譜。
 *
 * ═══ 只有這裡（與 freePlayRouter）知道時間 ═══
 *
 * grooveEngine 刻意不知道時間；本模組也不知道譜（不知道 groove、fill、拍數、小節）。
 * 手速換成 BPM（÷ 密度）、換成自動音的毫秒，都是 freePlayRouter 的事。
 *
 * ═══ 用法（每一擊） ═══
 *
 *     if (tracker.isDuplicate(now)) return;   // 雙手同時打 → 併成一擊
 *     tracker.hit(now);                       // 記下「上一擊 → 這一擊」的間隔，並更新狀態
 *     tracker.getHitRate();                   // 目前每秒幾擊
 *     tracker.getTempoState();                // 狀態（平常／加快／放慢）、平常的手速、倍數
 *
 * ⚠ hit 必須在 engine.hit 之前：fill 最後一擊的當下，引擎就要挑下一個 groove，
 *   那時這一擊的間隔必須已經算進手速與狀態。
 *
 * ═══ 量法 ═══
 *
 * 手速 ＝ 最近 RATE_WINDOW 個間隔的「擊數 ÷ 總時間」，groove、過門、換段都不分開算
 * （手速就是手速，跟正在打哪一段無關）。
 *   · 用總和比、不用中位數：左右手間隔不對稱（200／267ms 交替）會互相抵銷，
 *     偵測漏一擊只佔一小部分。
 *   · 離群值：以中位數為準，超出 [÷OUTLIER, ×OUTLIER] 的間隔不計（中途停頓等）。
 *
 * ═══ 狀態（selector 與特殊節奏計時器只看這個，不看當下的倍數）═══
 *
 *   measuring 量測中：剛開始打（不到 WARMUP_MS），或還量不到手速／平常
 *   normal    平常
 *   faster    加快：倍數（手速 ÷ 平常）> FAST_ENTER 持續 CONFIRM_MS
 *   slower    放慢：倍數 < SLOW_ENTER 持續 CONFIRM_MS
 *
 *   · 遲滯：加快要掉到 FAST_EXIT 以下、放慢要回到 SLOW_EXIT 以上（同樣持續 CONFIRM_MS）
 *     才離開 —— 在門檻附近晃的人不會每次換段結果都不同。
 *   · 鎖存：狀態只在打擊時改變，換段時讀狀態。只要真的加快了，什麼時候換段都接得到，
 *     不再看「換段剛好落在加快後的哪幾秒」的運氣。
 *
 * 平常的手速 ＝「平常狀態」下最近 TYPICAL_MS 的間隔中位數，換成每秒幾擊。
 *   · 加快／放慢期間凍結：那段的間隔不進平常的統計（另外收在 devIntervals），
 *     30 秒的視窗也暫停計時（normalClock 只累計平常狀態的間隔）。
 *     ⚠ 舊做法（最近 30 秒全部間隔的中位數）會被自己汙染：加快的間隔也算進去，
 *       而且打得快間隔多、權重反而大，約 13 秒中位數就跳上來，快檔只剩一小段時間有效。
 *   · 回到平常 → 加快／放慢期間的間隔丟掉，平常的手速維持進入前的值。
 *   · 加快／放慢維持超過 MAX_HOLD_MS → 視為「新的平常」：用那段期間的間隔重建平常，
 *     回到 normal。獎勵的是「比剛才快／慢」的變化，不是絕對速度 —— 多久會被吸收
 *     現在是明確的參數，而不是中位數順帶的副作用。
 *   ⚠ TYPICAL_MS 不能拉長：太長的話玩的前面幾分鐘門檻都是固定的，動態化就失去意義。
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
 * hit() 回傳剛結算的間隔與狀態變化，getHitRate() 附上用了幾個間隔 ——
 * 由 freePlayRouter 印成 [tempo] log，本模組不印。
 */

/** 兩擊相隔小於這個值視為同一擊（雙手同時打）（ms） */
export const MERGE_MS = 50;

/** 手速取最近幾個間隔（偶數：左右手各半，不對稱互相抵銷） */
const RATE_WINDOW = 8;

/** 平常的手速取「平常狀態」下最近多久的間隔（ms） */
const TYPICAL_MS = 30000;

/** 至少要有幾個間隔才算得出手速（剛開始打、閒置歸零後） */
const RATE_MIN = 3;

/** 離群倍率：間隔偏離中位數超過這個倍數就不計。只擋真正的停頓 */
const OUTLIER = 3;

/** 倍數（手速 ÷ 平常）高於這個 → 加快 */
export const FAST_ENTER = 1.2;
/** 加快中，倍數低於這個才離開（遲滯） */
export const FAST_EXIT = 1.08;
/** 倍數低於這個 → 放慢 */
export const SLOW_ENTER = 0.85;
/** 放慢中，倍數高於這個才離開（遲滯） */
export const SLOW_EXIT = 0.93;

/** 新狀態要持續這麼久才成立（ms）：擋掉偶發的幾下快打或停頓 */
export const CONFIRM_MS = 1500;
/** 開始打擊後這麼久內維持量測中（ms）：平常的手速還沒穩 */
export const WARMUP_MS = 4000;
/** 加快／放慢最多維持這麼久（ms），超過就當成新的平常 */
export const MAX_HOLD_MS = 30000;

/** 畫面與 log 用的狀態名稱 */
export const TEMPO_STATE_LABEL = {
  measuring: "量測中",
  normal: "平常",
  faster: "加快",
  slower: "放慢",
};

const isDeviating = (state) => state === "faster" || state === "slower";

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 依倍數與目前狀態，決定該往哪個狀態走（含遲滯） */
function targetState(state, ratio) {
  if (state === "faster" && ratio >= FAST_EXIT) return "faster";
  if (state === "slower" && ratio <= SLOW_EXIT) return "slower";
  if (ratio > FAST_ENTER) return "faster";
  if (ratio < SLOW_ENTER) return "slower";
  return "normal";
}

export function createTempoTracker() {
  let lastMs;
  let startMs;
  /** 最近的間隔（ms），最多 RATE_WINDOW 個 */
  let intervals;
  /** 平常狀態下的間隔：{ at（normalClock 時間）, ms } */
  let history;
  /** 只累計平常狀態間隔的時鐘（ms）：加快／放慢期間暫停，平常的視窗不會被耗掉 */
  let normalClock;
  /** 加快／放慢期間的間隔（ms），最多保留 TYPICAL_MS 的總長 */
  let devIntervals;
  let state;
  /** 加快／放慢期間凍結的平常手速（每秒幾擊） */
  let frozenTypical;
  /** 等待成立的新狀態與開始時間 */
  let pending;
  let pendingSinceMs;
  /** 進入加快／放慢的時間 */
  let holdSinceMs;

  function reset() {
    lastMs = null;
    startMs = null;
    intervals = [];
    history = [];
    normalClock = 0;
    devIntervals = [];
    state = "measuring";
    frozenTypical = null;
    pending = null;
    pendingSinceMs = null;
    holdSinceMs = null;
  }
  reset();

  function isDuplicate(nowMs) {
    return lastMs !== null && nowMs - lastMs < MERGE_MS;
  }

  function pushNormal(ms) {
    normalClock += ms;
    history.push({ at: normalClock, ms });
    while (normalClock - history[0].at > TYPICAL_MS) history.shift();
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

  /** 平常每秒幾擊：加快／放慢中是凍結值；否則為平常狀態間隔的中位數（不足 RATE_MIN 個為 null） */
  function getTypicalRate() {
    if (isDeviating(state)) return frozenTypical;
    if (history.length < RATE_MIN) return null;
    return 1000 / median(history.map((h) => h.ms));
  }

  function enter(next, nowMs, typicalRate) {
    if (isDeviating(next)) {
      // 加快 ↔ 放慢直接切換時，平常維持原本凍結的值
      if (!isDeviating(state)) frozenTypical = typicalRate;
      holdSinceMs = nowMs;
    } else {
      // 回到平常：加快／放慢期間的間隔不算進平常，平常維持進入前的值
      frozenTypical = null;
      holdSinceMs = null;
    }
    devIntervals = [];
    state = next;
    pending = null;
  }

  /** 加快／放慢太久 → 用那段期間的間隔重建平常 */
  function acceptNewNormal() {
    history = [];
    normalClock = 0;
    for (const ms of devIntervals) pushNormal(ms);
    devIntervals = [];
    frozenTypical = null;
    holdSinceMs = null;
    state = "normal";
    pending = null;
  }

  /** 每一擊後更新狀態；回傳 { from, to, reason }，沒有變化回傳 null */
  function updateState(nowMs) {
    const from = state;
    if (isDeviating(state) && nowMs - holdSinceMs >= MAX_HOLD_MS) {
      acceptNewNormal();
      return { from, to: state, reason: "maxHold" };
    }
    const { rate } = getHitRate();
    const typicalRate = getTypicalRate();
    if (rate === null || typicalRate === null || nowMs - startMs < WARMUP_MS) return null;
    if (state === "measuring") {
      state = "normal";
      return { from, to: state, reason: "warmedUp" };
    }

    const next = targetState(state, rate / typicalRate);
    if (next === state) {
      pending = null;
      return null;
    }
    if (pending !== next) {
      pending = next;
      pendingSinceMs = nowMs;
      return null;
    }
    if (nowMs - pendingSinceMs < CONFIRM_MS) return null;
    enter(next, nowMs, typicalRate);
    return { from, to: state, reason: "ratio" };
  }

  /**
   * 記下「上一擊 → 這一擊」的間隔，並更新狀態
   * @returns {{ intervalMs: ?number, change: ?{from: string, to: string, reason: string} }}
   *   intervalMs = 剛結算的間隔（ms，除錯用；第一擊為 null）；
   *   change = 這一擊造成的狀態變化（reason："warmedUp"｜"ratio"｜"maxHold"），沒有為 null
   */
  function hit(nowMs) {
    const ms = lastMs === null ? null : nowMs - lastMs;
    if (startMs === null) startMs = nowMs;
    if (ms !== null) {
      intervals.push(ms);
      if (intervals.length > RATE_WINDOW) intervals.shift();
      if (isDeviating(state)) {
        devIntervals.push(ms);
        let total = devIntervals.reduce((s, x) => s + x, 0);
        while (total > TYPICAL_MS) total -= devIntervals.shift();
      } else pushNormal(ms);
    }
    lastMs = nowMs;
    return { intervalMs: ms, change: updateState(nowMs) };
  }

  /**
   * @returns {{ state: string, typicalRate: ?number, ratio: ?number }}
   *   state = "measuring"｜"normal"｜"faster"｜"slower"；
   *   typicalRate = 平常每秒幾擊；ratio = 手速 ÷ 平常（量不到為 null）
   */
  function getTempoState() {
    const { rate } = getHitRate();
    const typicalRate = getTypicalRate();
    return { state, typicalRate, ratio: rate && typicalRate ? rate / typicalRate : null };
  }

  return { isDuplicate, hit, reset, getHitRate, getTempoState };
}
