/**
 * songMode/cueTrack.js
 *
 * 職責：在譜面第一顆音符之前，給四個四分音符的引導音。
 *
 * ═══ 為什麼需要 ═══
 *
 * 本譜第一顆音符在 12.3 秒，前面是純前奏 —— 使用者沒有任何拍點參考。
 * 沒有 count-in 的話，開頭的打擊抖動會顯著大於中後段。
 *
 * ═══ 排程原理：一次性錨定 ═══
 *
 * 播放真正開始的瞬間，讀一次影片時間，換算到 AudioContext 時間軸，
 * 一次把四顆排完。
 *
 * ⚠ 這不是 lookahead scheduler。只有 4 顆且全在 12 秒內，一次排完即可。
 *
 * ═══ 精度取捨 ═══
 *
 *   四顆之間的間距  → 由 AudioContext 保證，誤差 < 1 ms
 *   四顆對影片的位置 → 繼承一次 getCurrentTime() 的量化誤差（約一個影格）
 *
 * 等距完美、整體平移一點點。使用者從四顆的間距學到速度，
 * 一個 20–40 ms 的共同平移不會破壞這件事。
 *
 * ═══ L1 改動 ═══
 *
 * 只換發聲方法：audio.scheduleClick（合成正弦）→ audio.scheduleCue（取樣）。
 * 時刻表計算、可行性判定、錨定原理、cancel() 全部一字不動。
 *
 * ⚠ 注入的是 getTransport 函式而非 transport 實例。
 *   原因：songSession 建立 cueTrack 的時機早於 transport 就緒，
 *   傳實例會拿到 null。
 */

import { TUNING } from "./tuning.js";

export function createCueTrack({ chart, audio, getTransport }) {
  /**
   * 引導音時刻表（music time，ms）。
   *
   * 規則：把「第一小節四拍的節奏」原樣往前搬一個小節，當作 count-in。
   *
   * ═══ 為什麼不再用 baseBpm 等距 ═══
   *
   * baseBpm 是 MIDI 匯出的名目速度（本譜 77.9999），據此算出的四拍是
   * 完美等距。但譜面若經人工與影片對齊（狀況 A），真實拍點會微幅偏離
   * 名目 BPM 格線 —— 此時等距的引導音會與影片的真實節奏產生落差。
   *
   * 改法：直接讀 JSON 已合併過的 ticks↔time，插值出第一小節每一拍的
   * 真實時間，以及該小節的真實長度，再整組平移一個小節放到開始前。
   *
   * ⚠ 退化性：資料落在整齊 BPM 格線上時（如本譜現況），本法算出的
   *   結果與舊的 baseBpm 等距完全相同 —— 這是設計目標，不是巧合。
   *
   * ⚠ 需要 ppq + 每顆 onset 的 ticks 才能定位「小節四分格」。任一缺失
   *   或無法插值時，退回 buildCuesFromBpm（與 L1 之前一字不差）。
   *   （barGrid 有完整的小節線推導，但那是給區塊對齊用的，不是給這裡。）
   */
  const quarterMs = 60000 / chart.baseBpm;
  const firstOnset = chart.onsetList[0];
  const firstOnsetMs = firstOnset.time;

  /**
   * ticks → 真實時間（ms）的分段線性插值。
   *
   * 資料點取自 onsetList（已與影片合併，time 為真實媒體時間）。
   * 只在 [firstTick, firstTick + CUE_COUNT*ppq] 範圍內查詢 —— 全部落在
   * 第一顆 onset 之後、被實際音符夾住的區段，不需外插進無音符的前奏。
   *
   * @returns {number|null} 資料不足以插值時回傳 null（觸發 baseBpm 退化）
   */
  const tickPts = chart.onsetList
    .filter((n) => Number.isFinite(n.ticks))
    .map((n) => ({ tick: n.ticks, time: n.time }));

  function timeAtTick(tick) {
    const P = tickPts;
    if (P.length < 2) return null;

    // lower bound：第一個 tick >= 目標的資料點
    let lo = 0;
    let hi = P.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (P[mid].tick < tick) lo = mid + 1;
      else hi = mid;
    }
    if (lo < P.length && P[lo].tick === tick) return P[lo].time;

    // 取夾住目標的兩點做線性插值；落在端點外時以最近兩點的斜率外插
    let a;
    let b;
    if (lo === 0) {
      a = P[0];
      b = P[1];
    } else if (lo >= P.length) {
      a = P[P.length - 2];
      b = P[P.length - 1];
    } else {
      a = P[lo - 1];
      b = P[lo];
    }
    if (b.tick === a.tick) return a.time;
    const r = (tick - a.tick) / (b.tick - a.tick);
    return a.time + r * (b.time - a.time);
  }

  /**
   * 讀真實拍點：第 k 顆對應第一小節第 k 拍（tick = firstTick + (k-1)*ppq），
   * 整組往前平移「第一小節的真實長度」放到開始前一小節。
   *
   * beat / accent 語意與舊版一致：
   *   k = 1 → 前 4 拍（重音，倒數顯示「4」）；k = CUE_COUNT → 前 1 拍（顯示「1」）。
   * ⚠ 最後一顆恰好落在第一顆 onset 之「前」一整拍，不會與它同時。
   */
  function buildCuesFromTicks() {
    const ppq = chart.ppq;
    const firstTick = firstOnset.ticks;
    if (!Number.isFinite(ppq) || !Number.isFinite(firstTick)) return null;

    const beatTimes = [];
    for (let k = 1; k <= TUNING.CUE_COUNT; k++) {
      const t = timeAtTick(firstTick + (k - 1) * ppq);
      if (t === null) return null;
      beatTimes.push(t);
    }

    // 第一小節的真實長度 = 整組引導音往前平移的量
    const barEnd = timeAtTick(firstTick + TUNING.CUE_COUNT * ppq);
    if (barEnd === null) return null;
    const barDurationMs = barEnd - firstOnsetMs;

    return beatTimes.map((bt, i) => ({
      t: bt - barDurationMs,
      accent: i === 0,
      beat: i + 1,
    }));
  }

  /** baseBpm 等距退化路徑（與 L1 之前完全相同）。 */
  function buildCuesFromBpm() {
    const cues = [];
    for (let k = 1; k <= TUNING.CUE_COUNT; k++) {
      cues.push({
        t: firstOnsetMs - (TUNING.CUE_COUNT - k + 1) * quarterMs,
        accent: k === 1,
        beat: k,
      });
    }
    return cues;
  }

  const cues = buildCuesFromTicks() ?? buildCuesFromBpm();

  /** 第一顆塞不下就整組不發 */
  const feasible = cues.length > 0 && cues[0].t >= 0;
  const list = feasible ? cues : [];

  let lastScheduled = 0;

  return {
    /** 引導音時刻表（供 UI 顯示） */
    getCues() {
      return list;
    },

    getQuarterMs() {
      return quarterMs;
    },

    getFirstOnsetMs() {
      return firstOnsetMs;
    },

    isFeasible() {
      return feasible;
    },

    /** 上一次錨定實際排出去幾顆 */
    getLastScheduled() {
      return lastScheduled;
    },

    /**
     * 錨定並排程。
     *
     * 呼叫時機：每次播放實際開始（transport 的 "playing" 事件）。
     * 這自然涵蓋了「從頭播放」「暫停後恢復」「seek 後恢復」三種情況。
     *
     * @returns {number} 實際排出去的顆數
     */
    anchor() {
      lastScheduled = 0;
      const transport = getTransport?.();
      if (!feasible || !transport || !audio.isReady()) return 0;

      // ⚠ 必須先取消。"playing" 事件可能重複觸發（例如緩衝回復），
      //   不取消會造成同一顆被排兩次。
      audio.cancelScheduled();

      // ── 錨點：兩個時鐘各讀一次，之後全部靠 AudioContext ──
      const a0 = audio.now();
      const t0 = transport.getCurrentTime() * 1000;

      // ⚠ 倍速換算：cues 的 c.t 是「媒體時間」。在 r 倍速下，媒體時間差
      //   (c.t - t0) 只佔 (c.t - t0) / r 的牆鐘時間，而 AudioContext 走的
      //   是牆鐘。少除這個 r，引導音會在高倍速時晚響、低倍速時早響。
      //   變速發生在 count-in 期間時，songSession 會收到 "ratechange" 並
      //   重新呼叫 anchor()，重讀一次 rate。
      const rate = transport.getPlaybackRate?.() || 1;

      for (const c of list) {
        const when = a0 + (c.t - t0) / 1000 / rate;

        // 過期或落在保護帶內 → 丟棄，不補發。
        // 一顆遲到的引導音會落在錯的拍點上，比不發更糟。
        if (when <= a0 + TUNING.CUE_SCHEDULE_GUARD_S) continue;

        const ok = audio.scheduleCue(when, {
          id: c.accent
            ? TUNING.CUE_SAMPLE_ID_ACCENT
            : TUNING.CUE_SAMPLE_ID_NORMAL,
          gain: c.accent ? TUNING.CUE_ACCENT_GAIN : TUNING.CUE_NORMAL_GAIN,
        });
        if (ok) lastScheduled++;
      }

      return lastScheduled;
    },

    /** 暫停 / seek 時呼叫 */
    cancel() {
      audio.cancelScheduled();
      lastScheduled = 0;
    },
  };
}
