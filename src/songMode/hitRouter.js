/**
 * songMode/hitRouter.js
 *
 * 職責：把姿態偵測產生的打擊，依當前模式分流。
 *
 * ═══ 這是整個整合的接點（規格書 §8）═══
 *
 * main.js 原本傳給 createPredictWebcam 的是 audioEngine 的 playZone，
 * 改為傳本模組的 route。簽章完全一致：
 *
 *     route(side, zoneId, zoneSound)
 *
 * ⚠ 因此 poseEngine/ 整個資料夾一行都不用改。
 *   如果實作到一半發現非改 poseLoop 不可，代表接點選錯了 —— 回頭看這裡。
 *
 * ═══ 時間紀律 ═══
 *
 * ⚠ 前奏閘門刻意放在本模組，不放在 sequencer。
 *   那是整個發聲路徑上唯一與時間有關的判斷，讓它留在路由層，
 *   sequencer 才能保持「完全不知道時間存在」。
 *   L1 加回區塊重對齊時，新的時間依賴也會加在這裡，位置一目了然。
 *
 * ═══ 已知瑕疵（本版接受，規格書 §8.4）═══
 *
 * poseLoop 在觸發 hitEffects 前會檢查 zoneSound[key] !== "none"。
 * 歌曲模式繞過 zoneSound，所以使用者若把某區設成靜音，該區在歌曲模式下
 * 仍會發聲但不會有打擊特效。不影響發聲正確性，第一版不處理。
 */

import { TUNING } from "./tuning.js";

/**
 * @param {Object}   deps
 * @param {Object}   deps.session      songSession 實例
 * @param {Object}   deps.audio        擴充後的 audioEngine（整個物件）
 * @param {Function} deps.freePlayZone 原本的 playZone，自由模式用
 * @param {Object}   deps.songUI       歌曲模式的 UI 更新介面
 * @param {Function} deps.getTransport 取得當前 active transport
 */
export function createHitRouter({
  session,
  audio,
  freePlayZone,
  songUI,
  getTransport,
}) {
  return {
    /**
     * 簽章必須與 audioEngine.playZone 完全一致 ——
     * poseLoop 以三個參數呼叫，且不知道自己呼叫的是誰。
     */
    route(side, zoneId, zoneSound) {
      // ── 非歌曲模式：原路發聲 ──
      if (!session.isPlaying()) {
        freePlayZone(side, zoneId, zoneSound);
        return;
      }

      const sequencer = session.getSequencer();
      if (!sequencer) {
        freePlayZone(side, zoneId, zoneSound);
        return;
      }

      // ── 前奏閘門 ───────────────────────────────────────────────────────
      //
      // 純序列不看時間，因此「譜面範圍外」的保護不會自動存在。
      // 若不擋，使用者在 12 秒前奏隨手打三下就會吃掉譜面開頭三顆，
      // 而且因為沒有相位鎖，這個錯位會跟著他一整首歌。
      //
      // 發輕 click 而非靜音：使用者能確認系統有反應，
      // 同時聽得出「這一下不算數」。
      const transport = getTransport?.();
      const nowMs = (transport?.getCurrentTime() ?? 0) * 1000;

      if (nowMs < session.getFirstOnsetMs()) {
        audio.scheduleClick(audio.now() + 0.001, {
          freq: TUNING.PREROLL_CLICK_HZ,
          gain: TUNING.PREROLL_CLICK_GAIN,
          decayMs: TUNING.CUE_DECAY_MS,
        });
        return; // ⚠ 不推進游標
      }

      // ── 派發：打一下走一顆 ──────────────────────────────────────────────
      const res = sequencer.hit();
      if (res.midi !== null) audio.playMidi(res.midi, 1);

      songUI.onHitResult(res, sequencer);
    },
  };
}
