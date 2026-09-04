/**
 * songMode/sequencer.js
 *
 * ═══ 職責 ═══
 *
 *   打一下 → 發下一顆。就這樣。
 *
 * ═══ 時間紀律 ═══
 *
 *   ⚠ 本模組必須完全不知道時間的存在。
 *
 *   沒有時間參數、沒有 ratio、沒有 drift、沒有 resync、沒有填充音。
 *
 *   L1 已上線，但這條紀律沒有鬆動：setCursor(index) 只接受一個 index，
 *   不接受時間、不讀時鐘。「現在該對齊到哪一顆」的判斷完全在
 *   songSession.syncBlock，由 hitRouter 與 main.js 的 hudLoop 共同呼叫。
 *
 *   前奏閘門一樣留在 hitRouter。發聲路徑上的兩個時間判斷
 *   （前奏閘門、區塊對齊）都在路由層，本模組才能保持純粹。
 *
 * ═══ 游標語意 ═══
 *
 *   cursor 指向「下一顆待發的 index」。
 *   打擊時前進量恆為 1；區塊邊界則由 setCursor 直接指定。
 *
 * ═══ skipped / rewound ═══
 *
 *   這兩個計數是 L1 最有價值的量測輸出：
 *
 *     skipped —— 對齊時被跳過的顆數，直接量化「使用者跟不上多少」
 *     rewound —— 對齊時被拉回的顆數，量化「打太快多少」
 *
 *   由 setCursor 自行依差值累加，呼叫端不必記帳，也就不會漏記。
 */

export function createSequencer({ chart }) {
  const L = chart.onsetList;

  /** 下一顆待發的 index */
  let cursor = 0;

  const stats = { hits: 0, exhausted: 0, skipped: 0, rewound: 0 };

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

    /**
     * 直接指定游標位置（區塊對齊用）。
     *
     * ⚠ 本方法不得新增任何時間參數或時鐘讀取。
     *   若日後發現「需要在這裡看一下時間」，代表判斷寫錯層了。
     *
     * @param {number} index 目標 index，會被 clamp 到 [0, L.length]
     * @returns {number} 實際位移量（正 = 跳過，負 = 拉回，0 = 無變化）
     */
    setCursor(index) {
      const target = Math.max(0, Math.min(L.length, Math.trunc(index)));
      const delta = target - cursor;

      if (delta > 0) stats.skipped += delta;
      else if (delta < 0) stats.rewound += -delta;

      cursor = target;
      return delta;
    },

    /** 預覽接下來 n 顆。 */
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
      stats.skipped = 0;
      stats.rewound = 0;
    },
  };
}
