/**
 * grooveMode/grooveEngine.js
 *
 * 職責：依 grooveTable 決定「下一擊要發哪些音」。
 *
 * ═══ 規則 ═══
 *
 *   1. 從 START_GROOVE 開始（陣列則隨機），打一下走一格。
 *   2. 一輪走完 → 輪數 +1；輪數達到該 groove 的 loops → 進入過門。
 *      loops 是陣列時，每次進入該 groove 隨機挑一個輪數。
 *   3. 過門走完 → 從 next 挑下一個 groove，輪數歸零。
 *      上一層有傳 pickNext 就交給它挑（依速度，見 grooveSelector.js），否則隨機。
 *      若過門有 land（陣列則隨機），取代新 groove 的第一擊（例如 kick → kick+crash）。
 *   4. reset() → 回到 START_GROOVE 第一格（未落地的 land 一併丟棄）。
 *
 * ═══ 預覽（peek）═══
 *
 * 畫面要提前知道「接下來幾擊有沒有 crash」（重音抬手，見 poseEngine/accentPose.js），
 * 所以過門與 land 在進入 groove 時就先挑好（plannedFill / plannedLand），
 * peek 才看得到。過門結束後的 groove 由 pickNext 依當下速度決定，事先不知道 ——
 * peek 只回傳到 land 為止（回傳長度可能少於要求）。
 *
 * ═══ 刻意不知道時間 ═══
 *
 * 與 songMode/sequencer.js 同一個原則：本模組沒有時鐘。
 * 「多久沒打要歸零」是時間判斷，放在上一層 freePlayRouter，
 * 這裡只提供 reset()。不要在這裡加時間參數。
 * 譜上的時值（拍數）與密度是譜的內容，不是時間；換算成 BPM 是上一層的事。
 * 依速度挑 groove 也是上一層的事：這裡只把候選與密度交給 pickNext。
 */

import { SOUNDS, START_GROOVE, GROOVES, FILLS } from "./grooveTable.js";

/** 合法的「幾分音符」 */
const NOTE_VALUES = [1, 2, 4, 8, 16, 32];

/** rate 標籤與實際密度允許的相對誤差 */
const RATE_TOLERANCE = 0.2;

/**
 * "hihat+kick/8." → { names: ["hihat", "kick"], value: 8, dotted: true }
 * 沒寫時值 → value = null（用該項的 unit）
 */
function parseToken(token) {
  const [namePart, durPart] = token.split("/");
  const m = durPart === undefined ? null : /^(\d+)(\.?)$/.exec(durPart);
  return {
    names: namePart.split("+"),
    value: m ? Number(m[1]) : durPart === undefined ? null : NaN,
    dotted: m ? m[2] === "." : false,
  };
}

/** 幾分音符 → 拍數（四分音符 = 1 拍） */
const toBeats = (value, dotted) => (4 / value) * (dotted ? 1.5 : 1);

/** 休止符的音名 */
const REST = "rest";

/**
 * "kick hihat/16 rest kick+ride" → [{ notes: [36], beats }, ...]
 * rest 不是一擊：它的拍數併進前一擊（打一下走一格不變）。
 * 開頭的 rest 沒有前一擊 → 併進一輪的最後一擊（groove 循環時剛好接上）。
 */
function parseSteps(text, unit) {
  const steps = [];
  let leadingRestBeats = 0;
  for (const token of text.trim().split(/\s+/)) {
    const { names, value, dotted } = parseToken(token);
    const beats = toBeats(value ?? unit, dotted);
    if (names[0] === REST) {
      if (steps.length) steps[steps.length - 1].beats += beats;
      else leadingRestBeats += beats;
      continue;
    }
    steps.push({ notes: names.map((name) => SOUNDS[name]), beats });
  }
  if (steps.length) steps[steps.length - 1].beats += leadingRestBeats;
  return steps;
}

const pick = (v) => (Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v);
const asList = (v) => (Array.isArray(v) ? v : [v]);
const isInt = (x) => Math.abs(x - Math.round(x)) < 1e-6;

/** 載入時檢查整張表，寫錯只警告不中斷（壞掉的音名該擊不發聲）。 */
function validateTable() {
  const warn = (msg) => console.warn("[grooveTable]", msg);
  const checkUnit = (where, unit) => {
    if (!NOTE_VALUES.includes(unit)) warn(`${where}: unit 必須是 ${NOTE_VALUES.join("/")}`);
  };
  /**
   * 檢查 steps（withDuration=false 用於 land：不能寫時值、不能有 rest）
   * isFill=true：過門只播一次，開頭的 rest 沒有上一輪可以併 → 警告
   */
  const checkSteps = (where, text, withDuration = true, isFill = false) => {
    const tokens = text.trim().split(/\s+/);
    if (tokens.every((t) => parseToken(t).names[0] === REST)) warn(`${where}: 至少要有一擊`);
    tokens.forEach((token, i) => {
      const { names, value } = parseToken(token);
      if (names.includes(REST)) {
        if (names.length > 1) warn(`${where}: rest 不能與音名同時寫 "${token}"`);
        else if (!withDuration) warn(`${where}: land 不能是 rest`);
        else if (isFill && i === 0) warn(`${where}: 過門不能以 rest 開頭`);
      }
      for (const name of names) {
        if (name !== REST && !(name in SOUNDS)) warn(`${where}: 未知音名 "${name}"`);
      }
      if (value === null) return;
      if (!withDuration) warn(`${where}: land 不寫時值 "${token}"`);
      else if (!NOTE_VALUES.includes(value)) warn(`${where}: 時值不合法 "${token}"`);
    });
  };

  for (const s of asList(START_GROOVE)) {
    if (!GROOVES[s]) warn(`START_GROOVE "${s}" 不存在`);
  }
  for (const [id, g] of Object.entries(GROOVES)) {
    const where = `GROOVES.${id}`;
    checkUnit(where, g.unit);
    checkSteps(where, g.steps);
    for (const n of asList(g.loops)) {
      if (!(n >= 1)) warn(`${where}: loops 必須 ≥ 1`);
    }
    for (const f of asList(g.fill)) {
      if (!FILLS[f]) warn(`${where}: fill "${f}" 不存在`);
    }
    for (const n of asList(g.next)) {
      if (!GROOVES[n]) warn(`${where}: next "${n}" 不存在`);
    }

    const steps = parseSteps(g.steps, g.unit);
    const totalBeats = steps.reduce((sum, s) => sum + s.beats, 0);
    if (!isInt(totalBeats)) warn(`${where}: 一輪 ${totalBeats} 拍，不是整數拍`);
    // 實際倍率 = 每拍平均擊數 ÷ 2（8 分全打 = 1）
    const actualRate = steps.length / totalBeats / 2;
    if (g.rate === undefined) {
      if (g.unit === 16) warn(`${where}: unit 16 必須標 rate（實際 ${actualRate.toFixed(2)}）`);
    } else if (Math.abs(g.rate - actualRate) / actualRate > RATE_TOLERANCE) {
      warn(`${where}: rate 標 ${g.rate}，實際 ${actualRate.toFixed(2)}`);
    }
  }
  for (const [id, f] of Object.entries(FILLS)) {
    const where = `FILLS.${id}`;
    checkUnit(where, f.unit);
    checkSteps(where, f.steps, true, true);
    if (!["faster", "same", "slower"].includes(f.feel)) {
      warn(`${where}: feel 必須是 "faster"｜"same"｜"slower"`);
    }
    for (const land of f.land ? asList(f.land) : []) checkSteps(`${where}.land`, land, false);
  }
}

export function createGrooveEngine() {
  validateTable();

  const grooveSteps = {};
  for (const [id, g] of Object.entries(GROOVES)) grooveSteps[id] = parseSteps(g.steps, g.unit);
  const fillSteps = {};
  for (const [id, f] of Object.entries(FILLS)) fillSteps[id] = parseSteps(f.steps, f.unit);
  /** 每個 groove 的密度：每拍平均擊數 */
  const density = {};
  for (const [id, steps] of Object.entries(grooveSteps)) {
    density[id] = steps.length / steps.reduce((sum, s) => sum + s.beats, 0);
  }

  let grooveId, fillId, step, loopCount, loopTarget;
  /** 待取代下一擊的音（過門的 land），落地後清空 */
  let pendingLand;
  /** 這個 groove 循環完要進的過門、與過門結束時的 land（進入 groove 時先挑好，peek 用） */
  let plannedFill, plannedLand;

  /** land 設定 → 一擊的音："kick+crash" → [36, 49]；沒寫 land → []（不取代） */
  const landNotes = (land) => (land ? pick(land).split("+").map((name) => SOUNDS[name]) : []);

  /** 進入某個 groove：輪數歸零並挑這次要循環幾輪、之後的過門與 land */
  function enterGroove(id) {
    grooveId = id;
    loopCount = 0;
    loopTarget = pick(GROOVES[id].loops);
    plannedFill = pick(GROOVES[id].fill);
    plannedLand = landNotes(FILLS[plannedFill]?.land);
  }

  function reset() {
    enterGroove(pick(START_GROOVE)); // 陣列則隨機
    fillId = null; // 非 null = 正在過門
    step = 0;
    pendingLand = [];
  }
  reset();

  /**
   * 走一格，回傳這一擊的內容：
   *   notes   要發的 MIDI 音高陣列（可能含 undefined = 寫錯的音名）
   *   beats   這一擊的時值（拍數）—— 給上一層換算速度用
   *   inFill  這一擊是否屬於過門
   *
   * @param {Function} [pickNext]  過門結束時挑下一個 groove：
   *   pickNext({ candidates: [{ id, density }], currentDensity, feel }) → groove id
   *   沒傳則隨機。
   */
  function hit(pickNext) {
    const inFill = fillId !== null;
    const steps = inFill ? fillSteps[fillId] : grooveSteps[grooveId];
    const { beats } = steps[step];
    const notes = pendingLand.length ? pendingLand : steps[step].notes;
    pendingLand = [];
    step++;

    if (step >= steps.length) {
      step = 0;
      if (fillId) {
        // 過門結束 → 換 groove；land（一擊的內容，進入 groove 時已挑好）留給新 groove 的第一擊
        const { feel } = FILLS[fillId];
        pendingLand = plannedLand;
        fillId = null;
        const next = GROOVES[grooveId].next;
        enterGroove(
          pickNext
            ? pickNext({
                candidates: asList(next).map((id) => ({ id, density: density[id] })),
                currentDensity: density[grooveId],
                feel,
              })
            : pick(next),
        );
      } else if (++loopCount >= loopTarget) {
        fillId = plannedFill;
      }
    }
    return { notes, beats, inFill };
  }

  /**
   * 預覽接下來 n 擊的音（不改變狀態）。
   * 過門結束後的 groove 尚未決定，只看到 land 為止，回傳長度可能少於 n。
   *
   * @returns {number[][]} 每擊的 MIDI 音高陣列
   */
  function peek(n) {
    const out = [];
    let f = fillId, s = step, lc = loopCount, land = pendingLand;
    while (out.length < n) {
      const steps = f ? fillSteps[f] : grooveSteps[grooveId];
      out.push(land.length ? land : steps[s].notes);
      land = [];
      if (++s < steps.length) continue;
      s = 0;
      if (f) {
        if (plannedLand.length && out.length < n) out.push(plannedLand);
        break;
      }
      if (++lc >= loopTarget) f = plannedFill;
    }
    return out;
  }

  /** 除錯用：目前位置 */
  function getPosition() {
    return { grooveId, fillId, step, loopCount, loopTarget };
  }

  return { hit, peek, reset, getPosition };
}
