/**
 * grooveMode/grooveEngine.js
 *
 * 職責：依 grooveTable 決定「下一擊要發哪些音」。
 *
 * ═══ 規則 ═══
 *
 *   1. 從 START_GROOVE 開始（陣列則隨機），打一下走一格。
 *   2. 一輪走完 → 輪數 +1；輪數達到該 groove 的 loops → 進入過門。
 *   3. 過門走完 → 依 next 換 groove（陣列則隨機），輪數歸零。
 *      若過門有 land，取代新 groove 的第一擊（例如 kick → kick+crash）。
 *   4. reset() → 回到 START_GROOVE 第一格（未落地的 land 一併丟棄）。
 *
 * ═══ 刻意不知道時間 ═══
 *
 * 與 songMode/sequencer.js 同一個原則：本模組沒有時鐘。
 * 「多久沒打要歸零」是時間判斷，放在上一層 freePlayRouter，
 * 這裡只提供 reset()。不要在這裡加時間參數。
 */

import { SOUNDS, START_GROOVE, GROOVES, FILLS } from "./grooveTable.js";

/** "kick hihat kick+ride" → [[36], [42], [36, 51]] */
function parseSteps(text) {
  return text
    .trim()
    .split(/\s+/)
    .map((step) => step.split("+").map((name) => SOUNDS[name]));
}

const pick = (v) => (Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v);
const asList = (v) => (Array.isArray(v) ? v : [v]);

/** 載入時檢查整張表，寫錯只警告不中斷（壞掉的音名該擊不發聲）。 */
function validateTable() {
  const warn = (msg) => console.warn("[grooveTable]", msg);
  const checkSteps = (where, text) => {
    for (const step of text.trim().split(/\s+/)) {
      for (const name of step.split("+")) {
        if (!(name in SOUNDS)) warn(`${where}: 未知音名 "${name}"`);
      }
    }
  };

  for (const s of asList(START_GROOVE)) {
    if (!GROOVES[s]) warn(`START_GROOVE "${s}" 不存在`);
  }
  for (const [id, g] of Object.entries(GROOVES)) {
    checkSteps(`GROOVES.${id}`, g.steps);
    if (!(g.loops >= 1)) warn(`GROOVES.${id}: loops 必須 ≥ 1`);
    for (const f of asList(g.fill)) {
      if (!FILLS[f]) warn(`GROOVES.${id}: fill "${f}" 不存在`);
    }
    for (const n of asList(g.next)) {
      if (!GROOVES[n]) warn(`GROOVES.${id}: next "${n}" 不存在`);
    }
  }
  for (const [id, f] of Object.entries(FILLS)) {
    checkSteps(`FILLS.${id}`, f.steps);
    if (f.land) checkSteps(`FILLS.${id}.land`, f.land);
  }
}

export function createGrooveEngine() {
  validateTable();

  const grooveSteps = {};
  for (const [id, g] of Object.entries(GROOVES)) grooveSteps[id] = parseSteps(g.steps);
  const fillSteps = {};
  const fillLand = {};
  for (const [id, f] of Object.entries(FILLS)) {
    fillSteps[id] = parseSteps(f.steps);
    // land 是「一擊」的內容，取代下一節的第一個音：
    // "kick+crash" → [36, 49]；沒寫 land → []（不取代）
    fillLand[id] = f.land ? parseSteps(f.land).flat() : [];
  }

  let grooveId, fillId, step, loopCount;
  /** 待取代下一擊的音（過門的 land），落地後清空 */
  let pendingLand;

  function reset() {
    grooveId = pick(START_GROOVE); // 陣列則隨機
    fillId = null; // 非 null = 正在過門
    step = 0;
    loopCount = 0;
    pendingLand = [];
  }
  reset();

  /** 走一格，回傳這一擊要發的 MIDI 音高陣列（可能含 undefined = 寫錯的音名） */
  function hit() {
    const steps = fillId ? fillSteps[fillId] : grooveSteps[grooveId];
    const notes = pendingLand.length ? pendingLand : steps[step];
    pendingLand = [];
    step++;

    if (step >= steps.length) {
      step = 0;
      if (fillId) {
        // 過門結束 → 換 groove；land 留給新 groove 的第一擊
        pendingLand = fillLand[fillId];
        fillId = null;
        grooveId = pick(GROOVES[grooveId].next);
        loopCount = 0;
      } else if (++loopCount >= GROOVES[grooveId].loops) {
        fillId = pick(GROOVES[grooveId].fill);
      }
    }
    return notes;
  }

  /** 除錯用：目前位置 */
  function getPosition() {
    return { grooveId, fillId, step, loopCount };
  }

  return { hit, reset, getPosition };
}
