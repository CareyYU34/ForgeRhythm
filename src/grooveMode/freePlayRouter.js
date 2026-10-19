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
 *
 * ═══ 速度量測 ═══
 *
 * tempoTracker 量 groove 的基點 BPM 與 fill 的手速（見 tempoTracker.js）。
 * 兩手相隔 MERGE_MS 內的打擊併成一擊（不走格、不發聲），否則雙手同時拍
 * 會走兩格，也會把速度量歪。
 *
 * fill 結束時，以量到的基點與手速交給 grooveSelector 挑下一個 groove
 * （經由 engine.hit(pickNext) —— 引擎只給候選與密度，不知道時間）。
 */

import { createGrooveEngine } from "./grooveEngine.js";
import { createTempoTracker } from "./tempoTracker.js";
import { selectNextGroove } from "./grooveSelector.js";

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
  const tracker = createTempoTracker();
  let lastHitMs = -Infinity;

  /** 給 engine 的 pickNext：補上量到的速度後交給 selector */
  function pickNext({ candidates, currentDensity, feel }) {
    const baselineBpm = tracker.getBaselineBpm();
    const hitRate = tracker.getFillHitRate();
    const result = selectNextGroove({ candidates, currentDensity, feel, baselineBpm, hitRate });
    // 除錯（Chrome console 需開 Verbose 才看得到）
    console.debug(
      `[groove] 基點 ${baselineBpm?.toFixed(1) ?? "-"} BPM｜fill 手速 ${hitRate?.toFixed(2) ?? "-"} 擊/秒` +
        `｜→ ${result.id}（${result.impliedBpm?.toFixed(1) ?? "-"} BPM，${result.reason}）`,
    );
    return result.id;
  }

  return {
    route(side, zoneId, zoneSound) {
      if (getFreeStyle() !== "groove") {
        playZone(side, zoneId, zoneSound);
        return;
      }

      const nowMs = performance.now();
      if (nowMs - lastHitMs > GROOVE_RESET_MS) {
        engine.reset();
        tracker.reset();
      }
      if (tracker.isDuplicate(nowMs)) return;
      lastHitMs = nowMs;

      // ⚠ 順序：先結算間隔，再走格（引擎可能在這一擊決定下一個 groove）
      tracker.hit(nowMs);
      const { notes, beats, inFill } = engine.hit(pickNext);
      tracker.setStep(beats, inFill);

      for (const midi of notes) {
        if (midi !== undefined) audio.playMidi(midi, 1);
      }
    },
  };
}
