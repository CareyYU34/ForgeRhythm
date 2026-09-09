/**
 * songMode/chartLoader.js
 *
 * 職責：純資料轉換。Tone.js 格式的 MIDI JSON → onset 序列。
 * 狀態：無狀態（nearestIndex / firstIndexAtOrAfter 為純函式）。
 *
 * ═══ ticks / ppq / timeSignatures ═══
 *
 * L1 已啟用這三項資料，消費者是 songMode/barGrid.js。
 * 它們不再是「保留但不使用」—— 刪掉會直接讓區塊對齊失效。
 *
 * ═══ baseBpm 的重要性 ═══
 *
 * ⚠ 引導音的時間完全由 baseBpm 推算，L1 之後連小節格線也是。
 *   BPM 錯了，四顆 click 的間距錯、區塊邊界也錯。
 *   因此 BPM 缺失時必須推估並在 UI 上明示「推估」，不可靜默使用預設值。
 */

import { TUNING } from "./tuning.js";

// ─── 統計 / 數值工具 ────────────────────────────────────────────────────────

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 浮點數近似最大公因數（歐幾里得法 + 容差） */
function approxGcd(a, b, tol) {
  a = Math.abs(a);
  b = Math.abs(b);
  let guard = 0;
  while (b > tol && guard++ < 64) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a;
}

/**
 * 從 onset 間隔推估 BPM。
 *
 * 只在 JSON 未提供 BPM 時呼叫。取 10%–90% 的間隔求近似 GCD，
 * 再挑出落在 50–200 且最接近 100 的倍數。
 */
function estimateBpmFromOnsets(onsetTimes) {
  const gaps = [];
  for (let i = 1; i < onsetTimes.length; i++) {
    const g = onsetTimes[i] - onsetTimes[i - 1];
    if (g > 20) gaps.push(g);
  }
  if (gaps.length === 0) return 120;

  const sorted = [...gaps].sort((x, y) => x - y);
  const lo = Math.floor(sorted.length * 0.1);
  const hi = Math.max(lo + 1, Math.ceil(sorted.length * 0.9));
  const core = sorted.slice(lo, hi);

  let g = core[0];
  for (const v of core) g = approxGcd(g, v, TUNING.BPM_ESTIMATE_TOL_MS);
  if (!Number.isFinite(g) || g < 30) g = core[0];

  let best = null;
  for (let k = 1; k <= 8; k++) {
    const bpm = 60000 / (g * k);
    if (bpm < 50 || bpm > 200) continue;
    const score = Math.abs(Math.log(bpm / 100));
    if (!best || score < best.score) best = { bpm, score };
  }
  return best ? best.bpm : 120;
}

/** 同時刻音符合併。⚠ 會吃掉齊奏音，見 TUNING.ONSET_DEDUPE_MS 的註解。 */
function dedupeNotes(notes, tolMs) {
  const out = [];
  for (const n of notes) {
    if (out.length === 0 || n.time - out[out.length - 1].time > tolMs) {
      out.push(n);
    }
  }
  return out;
}

// ─── 主入口 ─────────────────────────────────────────────────────────────────

/**
 * @param {Object} json Tone.js Midi 匯出的 JSON
 * @param {Object} [options]
 * @param {"basic"|"advanced"} [options.difficulty="advanced"]
 *   難度分級（決定吃哪些音符）：
 *     "advanced"（進階，八分）→ 不過濾，吃譜面全部音符（原行為）。
 *     "basic"   （預設，四分）→ 只吃落在四分位置（ticks % ppq === 0）的音符。
 *   ⚠ 函式層預設為 "advanced"，故舊呼叫端（未帶 options）行為不變；
 *     App 端的「預設難度」由 state.songDifficulty 決定，見 songSession。
 * @returns {Object} chart
 */
export function loadChart(json, options = {}) {
  const warnings = [];
  const difficulty = options.difficulty === "basic" ? "basic" : "advanced";

  // ── 音符收集：支援單軌與多軌 ──
  let raw = [];
  if (Array.isArray(json?.tracks)) {
    for (const tr of json.tracks) {
      if (Array.isArray(tr?.notes)) raw = raw.concat(tr.notes);
    }
  } else if (Array.isArray(json?.notes)) {
    raw = json.notes;
  }

  let notes = raw
    .filter((n) => Number.isFinite(n?.time) && Number.isFinite(n?.midi))
    .map((n) => ({
      time: n.time * 1000, // 秒 → ms
      midi: n.midi,
      name: n.name ?? String(n.midi),
      velocity: Number.isFinite(n.velocity) ? n.velocity : 1,
      // ⚠ barGrid 的地基。缺了會讓區塊格線降級。
      ticks: Number.isFinite(n?.ticks) ? n.ticks : null,
    }))
    .sort((a, b) => a.time - b.time);

  if (notes.length === 0) {
    throw new Error("譜面沒有可用的音符（需要 tracks[].notes 或 notes）");
  }

  // ── 難度過濾：預設（四分）只保留落在四分位置的音符 ────────────────────────
  //
  // 四分音符 = ppq 個 ticks，故「四分位置」= tick 為 ppq 的整數倍（與拍號
  // 分母無關）。下游 sequencer / barGrid / cueTrack / songUI 全讀同一份
  // onsetList，於是在此過濾即可讓「觸發、對齊、UI」一起降到四分密度。
  //
  // ⚠ 保險：ticks 缺失或譜面沒有足夠的四分位置音符時，過濾會把譜面掏空。
  //   此時放棄過濾、退回進階（全部音符），並警告 —— 空譜比難度未生效更糟。
  let difficultyApplied = difficulty;
  if (difficulty === "basic") {
    const ppq = Number.isFinite(json?.header?.ppq) ? json.header.ppq : 480;
    const kept = notes.filter(
      (n) => !Number.isFinite(n.ticks) || n.ticks % ppq === 0,
    );
    if (kept.length >= 2) {
      if (kept.length < notes.length) {
        warnings.push(
          `難度「預設（四分）」：已濾除 ${notes.length - kept.length} 顆非四分位置音符。`,
        );
      }
      notes = kept;
    } else {
      difficultyApplied = "advanced";
      warnings.push(
        "難度「預設（四分）」無法套用（四分位置音符不足），改用進階（全部音符）。",
      );
    }
  }

  const onsetList = dedupeNotes(notes, TUNING.ONSET_DEDUPE_MS);
  if (onsetList.length < notes.length) {
    warnings.push(
      `已合併 ${notes.length - onsetList.length} 顆同時刻音符（齊奏會被吃掉）。`,
    );
  }

  // ── BPM ──
  const header = json?.header ?? {};
  const firstTempo = Array.isArray(header.tempos)
    ? header.tempos.find((t) => Number.isFinite(t?.bpm) && t.bpm > 0)
    : null;

  let baseBpm = Number(header.bpm);
  if (!Number.isFinite(baseBpm) || baseBpm <= 0) baseBpm = firstTempo?.bpm;

  let bpmEstimated = false;
  if (!Number.isFinite(baseBpm) || baseBpm <= 0) {
    baseBpm = estimateBpmFromOnsets(onsetList.map((n) => n.time));
    bpmEstimated = true;
    warnings.push(
      `譜面未提供 BPM，已從音符間隔推估為 ${baseBpm.toFixed(1)}。` +
        `引導音的間距與區塊格線都依賴這個值，請確認是否正確。`,
    );
  }

  if (Array.isArray(header.tempos) && header.tempos.length > 1) {
    warnings.push(
      `譜面有 ${header.tempos.length} 段速度變化，只使用第一段（${baseBpm.toFixed(1)}）` +
        `計算引導音與小節格線。中後段的區塊邊界會逐漸偏移。`,
    );
  }

  // ── 間隔統計 ──
  const gaps = [];
  for (let i = 1; i < onsetList.length; i++) {
    const g = onsetList[i].time - onsetList[i - 1].time;
    if (g > 10) gaps.push(g);
  }
  const medianGap = median(gaps) || 60000 / baseBpm;

  // ── 音高統計（UI 顯示用）──
  const midiCount = {};
  for (const n of onsetList) midiCount[n.midi] = (midiCount[n.midi] || 0) + 1;

  return {
    onsetList,
    baseBpm,
    bpmEstimated,
    difficulty: difficultyApplied,
    medianGap,
    midiCount,
    warnings,
    duration: onsetList[onsetList.length - 1].time,

    // ── barGrid 的資料來源。⚠ 請勿刪除。 ──
    ppq: Number.isFinite(header.ppq) ? header.ppq : 480,
    timeSignatures: Array.isArray(header.timeSignatures)
      ? header.timeSignatures
      : [{ ticks: 0, timeSignature: [4, 4] }],

    /**
     * 二分搜尋：距離指定時間「最近」的 onset index。
     *
     * ⚠ 目前無消費者，保留供 L2 長停頓重對齊 —— 那個情境要的確實是
     *   「最近的」（使用者停很久後從某處接回來）。
     *
     * ⚠ 不可用於區塊邊界對齊。邊界上它可能回傳「上一區塊的最後一顆」，
     *   造成游標往回跳、剛打過的音再響一次。那裡要用
     *   firstIndexAtOrAfter。
     */
    nearestIndex(t) {
      const L = onsetList;
      let lo = 0;
      let hi = L.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (L[mid].time < t) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(L[lo - 1].time - t) <= Math.abs(L[lo].time - t)) {
        return lo - 1;
      }
      return lo;
    },

    /**
     * 二分搜尋（lower bound）：第一個滿足 time >= t 的 onset index。
     *
     * 全部小於 t 時回傳 onsetList.length —— 這正是「譜面已結束」的
     * 游標值，songSession 的對齊因此不需要額外的邊界處理。
     *
     * 消費者：songSession.syncBlock、songUI.renderBlock
     */
    firstIndexAtOrAfter(t) {
      const L = onsetList;
      let lo = 0;
      let hi = L.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (L[mid].time < t) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    },
  };
}
