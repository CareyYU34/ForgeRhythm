/**
 * grooveMode/freePlayRouter.js
 *
 * 職責：自由模式的發聲分流 —— 依 freeStyle 選擇「節奏循環」或「位置對應」。
 *
 * ═══ 接點位置 ═══
 *
 * 本模組取代 hitRouter 的 freePlayZone 參數（main.js 接線），簽章同樣是
 *
 *     route(side, zoneId, zoneSound)
 *
 * ⚠ 因此 poseEngine/ 與 hitRouter 都不用改。歌曲／分部模式播放中時，
 *   hitRouter 根本不會呼叫到這裡。
 *
 * ═══ 兩種打法 ═══
 *
 *   "groove"  節奏循環（預設）—— 不看部位，任何一擊（手或膝蓋）都交給
 *             grooveEngine 走下一格（groove／fill 內容見 grooveTable.js）。
 *   "mapping" 位置對應        —— 依 zoneSound 查表，打哪裡響哪個音。
 *
 * ═══ 閒置歸零 ═══
 *
 * 距離上一擊超過 GROOVE_RESET_MS 沒有打擊，引擎 reset() 回到起始 groove
 * 第一格。停下來再開始打時一定從頭起，不會接在上次中斷的位置。
 *
 * ⚠ 歸零是「下一擊進來時」才判斷（比較時間差），不需要計時器，
 *   也不需要掛在任何 rAF loop 上。時間判斷只在這一層，grooveEngine 不知道時間。
 */

import { createGrooveEngine } from "./grooveEngine.js";

/** 超過這麼久沒打，回到起始 groove 第一格（ms）。約 120 BPM 下三拍。 */
export const GROOVE_RESET_MS = 1500;

/**
 * @param {Object}   deps
 * @param {Object}   deps.audio         audioEngine（需 playMidi）
 * @param {Function} deps.playZone      原本的 audioEngine.playZone（位置對應用）
 * @param {Function} deps.getFreeStyle  取得當下打法："groove"｜"mapping"
 */
export function createFreePlayRouter({ audio, playZone, getFreeStyle }) {
  const engine = createGrooveEngine();
  let lastHitMs = -Infinity;

  return {
    route(side, zoneId, zoneSound) {
      if (getFreeStyle() !== "groove") {
        playZone(side, zoneId, zoneSound);
        return;
      }

      const nowMs = performance.now();
      if (nowMs - lastHitMs > GROOVE_RESET_MS) engine.reset();
      lastHitMs = nowMs;

      for (const midi of engine.hit()) {
        if (midi !== undefined) audio.playMidi(midi, 1);
      }
    },
  };
}
