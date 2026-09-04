/**
 * songMode/hitRouter.js
 *
 * 職責：把姿態偵測產生的打擊，依當前模式分流。
 *
 * ═══ 這是整個整合的接點 ═══
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
 * 發聲路徑上有兩個與時間有關的判斷，兩個都在本模組：
 *
 *   1. 前奏閘門       —— 第一顆 onset 之前不推進游標
 *   2. 區塊對齊的觸發 —— 呼叫 session.syncBlock（判斷邏輯在 songSession）
 *
 * 兩者都刻意不下沉到 sequencer，sequencer 才能保持「完全不知道時間存在」。
 *
 * ═══ 已知瑕疵（本版接受）═══
 *
 * poseLoop 在觸發 hitEffects 前會檢查 zoneSound[key] !== "none"。
 * 歌曲模式繞過 zoneSound，所以使用者若把某區設成靜音，該區在歌曲模式下
 * 仍會發聲但不會有打擊特效。不影響發聲正確性，本版不處理。
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

      // ⚠ 本次呼叫只讀一次時鐘。
      //   兩次讀取可能落在不同區塊，會讓閘門與對齊各自用不同的時間，
      //   在小節線附近造成間歇性錯音。
      const transport = getTransport?.();
      const nowMs = (transport?.getCurrentTime() ?? 0) * 1000;

      // ── 前奏閘門 ───────────────────────────────────────────────────────
      //
      // 純序列不看時間，因此「譜面範圍外」的保護不會自動存在。
      // 若不擋，使用者在 12 秒前奏隨手打三下就會吃掉譜面開頭三顆。
      //
      // 發輕的節拍器音而非靜音：使用者能確認系統有反應，
      // 同時聽得出「這一下不算數」。
      //
      // ⚠ 必須在 syncBlock 之前。syncBlock 內雖然也擋了前奏期，
      //   但依賴那一層會讓「前奏期不推進游標」橫跨兩個模組。
      if (nowMs < session.getFirstOnsetMs()) {
        audio.scheduleCue(audio.now() + 0.001, {
          id: TUNING.CUE_SAMPLE_ID_NORMAL,
          gain: TUNING.PREROLL_CUE_GAIN,
        });
        return; // ⚠ 不推進游標
      }

      // ── 區塊對齊 ───────────────────────────────────────────────────────
      //
      // ⚠ 為什麼打擊路徑上也要呼叫一次：
      //   換頁由 hudLoop（rAF，約 16 ms 一次）驅動，打擊是事件驅動的。
      //   落在那個空窗內的打擊會從「尚未對齊的舊游標」取音，
      //   症狀是偶爾響錯一顆，且極難重現。
      //
      //   syncBlock 是冪等的，同一區塊內重複呼叫會在第一個判斷就返回，
      //   成本是一次整數比較。
      if (session.syncBlock(nowMs)) {
        // 這一下打擊剛好跨過區塊邊界，格線需要重畫
        songUI.invalidateBlock();
      }

      // ── 派發：打一下走一顆 ──────────────────────────────────────────────
      const res = sequencer.hit();
      if (res.midi !== null) audio.playMidi(res.midi, 1);

      songUI.onHitResult(res, sequencer);
    },
  };
}
