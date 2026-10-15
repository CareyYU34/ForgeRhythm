/**
 * songMode/backingTrack.js
 *
 * 職責：分部模式的「背景伴奏」—— 把譜面中「沒被選中」的分部（chart.backingList）
 * 依時間自動排程發聲。使用者選來打的那個分部不在這裡，於是背景聽起來就是
 * 「缺了那一軌」，由使用者用身體打擊填補。
 *
 * ═══ 為什麼是獨立的 setInterval，而不是塞進既有迴圈 ═══
 *
 * 專案有兩條 rAF 迴圈，職責刻意分離（見 CLAUDE.md）：
 *   pose loop —— 打擊 → 發聲
 *   HUD loop  —— 每幀時間錨點
 * 背景排程是第三種職責（依時間把伴奏排進音訊時間軸），同樣不該混進上面兩條。
 * 它用自己的 setInterval，只透過 transport 時鐘與 audio 溝通。
 *
 * ═══ lookahead 排程原理 ═══
 *
 * 每個 tick 讀一次媒體時間，把落在 [now, now+LOOKAHEAD] 內、尚未排出的背景音
 * 以 audio.scheduleMidi 排到 AudioContext 的絕對時刻。索引指標只前進不後退。
 *
 *   audioWhen = anchorAudio + onset.time/1000
 *
 *   anchorAudio = 「媒體時間 0 對應的 AudioContext 秒數」。因為 clockTransport
 *   鎖 1.0 倍速、且它的時鐘本來就是 AudioContext 牆鐘，這個換算是固定位移。
 *
 * ⚠ 已排出的節點由 audio 端 track() 進 pending，暫停 / seek 時
 *   audio.cancelScheduled() 一次清掉，不會有殘響照原時刻冒出來。
 */

import { TUNING } from "./tuning.js";

export function createBackingTrack({ chart, audio, getTransport }) {
  /** 背景音清單（依時間排序、未去重），來自 chartLoader.buildPartChart */
  const list = Array.isArray(chart?.backingList) ? chart.backingList : [];

  let timerId = null;
  /** 下一顆待排的索引（只前進） */
  let index = 0;
  /** 媒體時間 0 對應的 AudioContext 秒數 */
  let anchorAudio = 0;

  /** lower bound：第一顆 time >= tMs 的索引 */
  function firstIndexAtOrAfter(tMs) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].time < tMs) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 依當前媒體時間重新錨定並重設索引。
   * start（含暫停後恢復）與 seek 都走這裡 —— 兩個時鐘各讀一次，之後靠位移。
   */
  function resync() {
    const transport = getTransport?.();
    if (!transport) return;
    const mediaSec = transport.getCurrentTime();
    anchorAudio = audio.now() - mediaSec;
    // 已過去的背景音不補排（seek 回頭時尤其重要）
    index = firstIndexAtOrAfter(mediaSec * 1000);
  }

  function tick() {
    const transport = getTransport?.();
    if (!transport) return;
    const horizonMs = transport.getCurrentTime() * 1000 + TUNING.BACKING_LOOKAHEAD_MS;
    while (index < list.length && list[index].time <= horizonMs) {
      const o = list[index];
      const when = anchorAudio + o.time / 1000;
      audio.scheduleMidi(o.midi, when, TUNING.BACKING_NOTE_GAIN);
      index++;
    }
  }

  return {
    /** transport "playing" 時呼叫（含從頭播放與暫停後恢復） */
    start() {
      resync();
      if (timerId === null) {
        timerId = setInterval(tick, TUNING.BACKING_TICK_MS);
      }
      tick(); // 立刻排一批，不等第一個 interval
    },

    /** transport "pause" 時呼叫（cancelScheduled 由呼叫端負責，與引導音一致） */
    stop() {
      if (timerId !== null) {
        clearInterval(timerId);
        timerId = null;
      }
    },

    /** transport "seeking" 時呼叫：重新錨定 + 重設索引（interval 若在跑則續跑） */
    seek() {
      resync();
    },

    /** 背景是否已全部排完（供 partSession 判斷「歌曲結束」） */
    isExhausted() {
      return index >= list.length;
    },

    getTotal() {
      return list.length;
    },

    /** 退出時徹底清乾淨 */
    destroy() {
      this.stop();
      index = 0;
    },
  };
}
