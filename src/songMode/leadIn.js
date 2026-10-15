/**
 * songMode/leadIn.js — 分部模式的前導預覽
 *
 * 職責：正式開始前，先把「選中分部的第一小節節奏」循環 LEADIN_LOOPS 次
 * 放出來，讓使用者聽出自己等一下要打什麼；最後一次疊上倒數，然後開始。
 *
 * ═══ 時間模型：負的媒體時間 ═══
 *
 * clockTransport 從「媒體時間 = originMs - 預覽總長」起跑（負值），預覽占滿
 * [origin - 預覽總長, origin) 這段負時間，到 origin（第一小節起點）接回正式譜面。
 *
 * 這樣做的好處是「什麼都不用特例」：
 *   - hitRouter 的前奏閘門本來就擋 nowMs < firstOnsetMs → 預覽期打擊自動變輕拍。
 *   - songSession/partSession 的 syncBlock 在 nowMs < firstOnsetMs 一律返回 false。
 *   - HUD 的 updateCountdown 吃 cue 清單 + firstOnsetMs，直接沿用顯示 4/3/2/1/開始。
 *
 * ═══ 排程原理：一次性錨定（同 cueTrack）═══
 *
 * transport "playing" 時讀一次牆鐘與媒體時間，把所有「還沒到」的預覽音一次排完。
 * 走 audio.scheduleMidi（背景匯流排、可被 cancelScheduled 取消），音高用「選中
 * 分部」本身 —— 使用者聽到的就是等一下要打的那個聲音。
 */

import { TUNING } from "./tuning.js";

export function createLeadIn({ chart, barGrid, audio, getTransport }) {
  const barMs = barGrid.getBarMs();
  const quarterMs = 60000 / chart.baseBpm;
  const beatsPerBar = barGrid.getBeatsPerBar();
  const originMs = barGrid.getOriginMs();
  const loops = Math.max(1, TUNING.LEADIN_LOOPS);
  const preambleMs = loops * barMs;
  const selectedMidi = chart.selectedMidi;

  // ── 第一小節的節奏樣式：選中分部落在 [origin, origin+bar) 的音符偏移 ──
  const pattern = chart.onsetList
    .filter((n) => n.time >= originMs && n.time < originMs + barMs)
    .map((n) => n.time - originMs);

  // 第一小節若沒有音符（罕見），退回「每拍一下」讓預覽仍有拍子可循。
  const previewOffsets = pattern.length
    ? pattern
    : Array.from({ length: beatsPerBar }, (_, k) => k * quarterMs);

  // ── 預覽音（媒體時間，皆為負）──
  const previewNotes = [];
  for (let L = 0; L < loops; L++) {
    for (const off of previewOffsets) {
      previewNotes.push(originMs - preambleMs + L * barMs + off);
    }
  }

  // ── 倒數 cue：最後一小節的每一拍（媒體時間，落在 [origin-bar, origin)）──
  //   格式與 cueTrack 一致：display = CUE_COUNT - beat + 1（4/4 → 4,3,2,1）。
  const countdownCues = [];
  for (let k = 0; k < beatsPerBar; k++) {
    countdownCues.push({
      t: originMs - barMs + k * quarterMs,
      accent: k === 0,
      beat: k + 1,
    });
  }

  return {
    /** clockTransport 起跑用的媒體時間（秒，負值） */
    getStartMediaSec() {
      return (originMs - preambleMs) / 1000;
    },

    getPreambleMs() {
      return preambleMs;
    },

    /** 餵給 songUI.setCues 顯示倒數 */
    getCountdownCues() {
      return countdownCues;
    },

    /**
     * 錨定並排程預覽音。時機：transport "playing"（含暫停後恢復）。
     * 只排「還沒響」的音（依當前媒體時間過濾），故恢復播放時不會重排已過的。
     */
    anchor() {
      const transport = getTransport?.();
      if (!transport || !audio.isReady()) return 0;

      audio.cancelScheduled();

      const a0 = audio.now();
      const t0 = transport.getCurrentTime() * 1000; // 媒體時間 ms（可為負）

      let scheduled = 0;
      for (const mt of previewNotes) {
        if (mt < t0) continue; // 已過去的預覽音不補排
        const when = a0 + (mt - t0) / 1000;
        const ok = audio.scheduleMidi(
          selectedMidi,
          when,
          TUNING.LEADIN_NOTE_GAIN,
        );
        if (ok) scheduled++;
      }
      return scheduled;
    },
  };
}
