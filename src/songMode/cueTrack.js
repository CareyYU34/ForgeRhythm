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
 * ═══ 精度取捨（規格書 §9.4）═══
 *
 *   四顆之間的間距  → 由 AudioContext 保證，誤差 < 1 ms
 *   四顆對影片的位置 → 繼承一次 getCurrentTime() 的量化誤差（約一個影格）
 *
 * 等距完美、整體平移一點點。使用者從四顆的間距學到速度，
 * 一個 20–40 ms 的共同平移不會破壞這件事。
 *
 * ═══ 相對於順序鼓 v3 的差異 ═══
 *
 * 只改資料來源：video.currentTime → getTransport().getCurrentTime()。
 * 其餘邏輯一字不改。
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
   * 規則：從第一顆 onset 往前推 CUE_COUNT 個四分音符。
   *
   * ⚠ 刻意不使用 ppq / timeSignature 做小節線計算。
   *   本譜第一顆 onset 在 ticks 7680 = 第 16 拍 = 第 5 小節第 1 拍，
   *   「往前推四個四分音符」的結果恰好等於「第 4 小節整小節」——
   *   用不著小節線邏輯就能得到正確答案。
   */
  const quarterMs = 60000 / chart.baseBpm;
  const firstOnsetMs = chart.onsetList[0].time;

  // 第 k 顆在第一顆 onset 之前 (CUE_COUNT - k + 1) 個四分音符處。
  // k = 1 → 前 4 拍；k = CUE_COUNT → 前 1 拍。
  // ⚠ 最後一顆必須在第一顆 onset 之「前」一整拍，不可與它同時。
  const cues = [];
  for (let k = 1; k <= TUNING.CUE_COUNT; k++) {
    cues.push({
      t: firstOnsetMs - (TUNING.CUE_COUNT - k + 1) * quarterMs,
      accent: k === 1,
      beat: k,
    });
  }

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

      for (const c of list) {
        const when = a0 + (c.t - t0) / 1000;

        // 過期或落在保護帶內 → 丟棄，不補發。
        // 一顆遲到的引導音會落在錯的拍點上，比不發更糟。
        if (when <= a0 + TUNING.CUE_SCHEDULE_GUARD_S) continue;

        const ok = audio.scheduleClick(when, {
          freq: c.accent ? TUNING.CUE_ACCENT_HZ : TUNING.CUE_NORMAL_HZ,
          gain: c.accent ? TUNING.CUE_ACCENT_GAIN : TUNING.CUE_NORMAL_GAIN,
          decayMs: TUNING.CUE_DECAY_MS,
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
