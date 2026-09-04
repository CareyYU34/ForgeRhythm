/**
 * songMode/barGrid.js — L1 新增
 *
 * 職責：把譜面的 ticks / ppq / timeSignatures 轉成「兩小節區塊」的時間格線。
 * 狀態：建構時算完，之後全部是純函式查詢。
 *
 * ═══ 為什麼不放進 chartLoader ═══
 *
 * chartLoader 是純資料轉換層。本模組的 blockTicks 依賴 TUNING.BLOCK_BARS，
 * 那是介面層的參數 —— 混進去會讓資料層反向依賴 tuning。
 *
 * ═══ 地基假設 ═══
 *
 * ⚠ 整個模組建立在「tick 與 time 同源」之上：
 *
 *     ms = ticks × (quarterMs / ppq)
 *
 *   本譜已驗證成立（ppq 480、第一顆 ticks 7680、78 BPM → 12307.7 ms，
 *   與 onsetList[0].time 吻合）。但譜面若經過非等比編輯，兩者會脫鉤，
 *   格線整體平移，症狀是「對齊間歇性亂跳」—— 極難除錯。
 *
 *   因此建構時必做一致性斷言，失敗即降級為時間格線並發出警告。
 *   請不要因為「反正現在的譜是對的」就把斷言拿掉。
 *
 * ⚠ 假設單一速度。chartLoader 已對多段速度發出警告，但 L1 之後後果更嚴重：
 *   不只引導音的間距錯，整條格線與游標對齊都會錯。
 */

import { TUNING } from "./tuning.js";

export function createBarGrid({ chart }) {
  const warnings = [];

  const quarterMs = 60000 / chart.baseBpm;
  const firstOnset = chart.onsetList[0];
  const firstOnsetMs = firstOnset.time;

  // ── 拍號 ──
  const ts = chart.timeSignatures?.[0]?.timeSignature;
  const num = Number.isFinite(ts?.[0]) && ts[0] > 0 ? ts[0] : 4;
  const den = Number.isFinite(ts?.[1]) && ts[1] > 0 ? ts[1] : 4;

  /** 一小節有幾個「四分音符」（4/4 → 4，6/8 → 3） */
  const quartersPerBar = (num * 4) / den;

  /** 一小節有幾個「記譜拍」（畫格線用，4/4 → 4，6/8 → 6） */
  const beatsPerBar = num;

  const barMs = quartersPerBar * quarterMs;
  const blockMs = TUNING.BLOCK_BARS * barMs;
  const beatsPerBlock = beatsPerBar * TUNING.BLOCK_BARS;

  // ── 區塊原點 ───────────────────────────────────────────────────────────
  //
  // 以「第一顆 onset 所在小節」為第 0 塊的起點。
  // 這比從 ticks 0 起算通用 —— 譜面不必保證第一顆落在偶數小節。

  let degraded = false;
  let originMs;

  const ppq = Number.isFinite(chart.ppq) && chart.ppq > 0 ? chart.ppq : null;
  const hasTicks = Number.isFinite(firstOnset.ticks);

  if (ppq && hasTicks) {
    const msPerTick = quarterMs / ppq;
    const ticksPerBar = ppq * quartersPerBar;
    const originTicks = Math.floor(firstOnset.ticks / ticksPerBar) * ticksPerBar;

    // ── 一致性斷言 ──
    const predictedMs = firstOnset.ticks * msPerTick;
    const drift = Math.abs(predictedMs - firstOnsetMs);

    if (drift <= TUNING.BAR_GRID_ASSERT_MS) {
      originMs = originTicks * msPerTick;
    } else {
      degraded = true;
      warnings.push(
        `譜面的 ticks 與 time 不同源（第一顆推算 ${predictedMs.toFixed(1)} ms、` +
          `實際 ${firstOnsetMs.toFixed(1)} ms，差 ${drift.toFixed(1)} ms）。` +
          `已降級為時間格線；若第一顆音符不在小節第一拍，區塊邊界會錯位。`,
      );
    }
  } else {
    degraded = true;
    warnings.push(
      "譜面缺少 ticks 或 ppq，已降級為時間格線；" +
        "若第一顆音符不在小節第一拍，區塊邊界會錯位。",
    );
  }

  if (degraded) {
    // 降級：假設第一顆 onset 所在小節的起點可由時間整除推得
    originMs = firstOnsetMs - (firstOnsetMs % barMs);
  }

  return {
    /**
     * 指定時刻落在第幾塊。
     *
     * ⚠ 可為負數（第 0 塊之前，也就是前奏期）。呼叫端不得假設非負。
     */
    blockIndexAt(tMs) {
      return Math.floor((tMs - originMs) / blockMs);
    },

    blockStartMs(i) {
      return originMs + i * blockMs;
    },

    blockEndMs(i) {
      return originMs + (i + 1) * blockMs;
    },

    getBlockMs() {
      return blockMs;
    },

    getBarMs() {
      return barMs;
    },

    getBeatsPerBlock() {
      return beatsPerBlock;
    },

    getBeatsPerBar() {
      return beatsPerBar;
    },

    getOriginMs() {
      return originMs;
    },

    isDegraded() {
      return degraded;
    },

    getWarnings() {
      return warnings;
    },
  };
}
