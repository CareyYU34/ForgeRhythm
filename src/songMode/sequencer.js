/**
 * songMode/sequencer.js
 *
 * ═══ 職責 ═══
 *
 *   打一下 → 發下一顆。就這樣。
 *
 * ═══ 時間紀律（規格書 §15）═══
 *
 *   ⚠ 本模組必須完全不知道時間的存在。
 *
 *   沒有時間參數、沒有 ratio、沒有 drift、沒有 resync、沒有填充音。
 *   前奏閘門刻意放在 hitRouter 而不是這裡 —— 那是發聲路徑上唯一與時間
 *   有關的判斷，讓它留在路由層，本模組才能保持純粹。
 *
 *   L1（兩小節區塊重對齊）要加回來時，這條紀律會讓「時間依賴在哪一層
 *   被重新引入」一目了然。屆時本模組只需新增 setCursor(index)，
 *   判斷邏輯仍然留在 hitRouter。
 *
 * ═══ 游標語意 ═══
 *
 *   cursor 指向「下一顆待發的 index」。前進量恆為 1。
 *
 * ═══ 已知代價（規格書 §14）═══
 *
 *   純序列沒有任何機制把游標拉回音樂。
 *   漏打一下，音色序列從此永久錯開一顆，且不會自我修正。
 *   唯一的復位手段是退出歌曲模式再重進（sequencer 會被重建）。
 *
 *   這是刻意的取捨：本版的目的是量測姿態輸入在無補償下的實際行為。
 */

export function createSequencer({ chart }) {
  const L = chart.onsetList;

  /** 下一顆待發的 index */
  let cursor = 0;

  const stats = { hits: 0, exhausted: 0 };

  return {
    /**
     * 發下一顆。
     *
     * @returns {{midi: number|null, name: string|null, cursorIndex: number, exhausted: boolean}}
     */
    hit() {
      if (cursor >= L.length) {
        stats.exhausted++;
        return {
          midi: null,
          name: null,
          cursorIndex: cursor,
          exhausted: true,
        };
      }

      const onset = L[cursor];
      cursor++;
      stats.hits++;

      return {
        midi: onset.midi,
        name: onset.name,
        cursorIndex: cursor,
        exhausted: false,
      };
    },

    /** 預覽接下來 n 顆（供預覽帶）。 */
    peek(n) {
      return L.slice(cursor, cursor + n);
    },

    getCursor() {
      return cursor;
    },

    getTotal() {
      return L.length;
    },

    getStats() {
      return { ...stats };
    },

    /** 游標歸零。本版無 UI 呼叫者，退出重進即可達成同樣效果。 */
    reset() {
      cursor = 0;
      stats.hits = 0;
      stats.exhausted = 0;
    },
  };
}
