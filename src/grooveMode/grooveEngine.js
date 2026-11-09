/**
 * grooveMode/grooveEngine.js
 *
 * 職責：依 grooveTable 決定「下一擊要發哪些音」。
 *
 * ═══ 規則 ═══
 *
 *   1. 從 START_GROOVE 開始（陣列則隨機），打一下走一格。
 *   2. 一輪走完 → 輪數 +1；只剩過門佔的長度時 → 進入過門。
 *      輪數 = 整段的總輪數（含過門），從 LOOPS 隨機挑：4、一輪 4 拍、過門 4 拍 → 3 輪 + 過門 = 4 小節。
 *      過門佔幾輪由它的總拍數（含 rest）換算，所以一輪 2 拍的 groove 接 4 拍過門也對得齊。
 *      過門開頭的 rest 不是休止，而是「這段由 groove 繼續打」：groove 從第一格走滿
 *      rest 的拍數後，直接切到過門的第一個音（grooveHead）。
 *      這幾擊仍算 groove（inFill = false），基點照常量。
 *      fill 是空陣列 → 沒有過門，輪數走完直接走規則 3 換 groove。
 *   3. 過門走完 → 換下一個 groove，輪數歸零。候選 = 整張 GROOVES（附 special 標記），
 *      上一層有傳 pickNext 就交給它挑（計時器與速度，見 freePlayRouter／grooveSelector），
 *      否則在非 special 中隨機。
 *   4. reset() → 回到 START_GROOVE 第一格（第一擊不加 crash）。
 *   5. 自動音（譜上 "~" 開頭）不用打：一擊會連同後面緊接的自動音一起走完，
 *      回傳自動音「距離這一擊幾拍」，由上一層換算成毫秒排程播放。
 *      ⚠ 引擎仍然不知道時間 —— 只給拍數。
 *   6. 換段（規則 2 沒有過門、或規則 3）後的第一擊加 crash：
 *      hihat／hihat_open／ride／ride_bell 換成一個 crash，其他音照響；沒有鈸就直接加上。
 *      上一段的最後一個音已有 crash → 不加（避免連兩下 crash）。
 *   7. 段落（過門、或換段後的 groove）的第一擊，符合任一條件 → 回傳 closeHat，
 *      由上一層截斷還在響的開鈸：
 *        · 這一擊有 crash（換段加的或譜上寫的）—— crash 取代了 hihat，等於重新起頭
 *        · 這一段完全沒有能關鈸的音（hihat／pedal）—— 否則上一段結尾的開鈸會一路響過整段
 *          （例如 disco 結尾的 hihat_open 響進過門）
 *
 * ═══ 預覽（peek）═══
 *
 * 畫面要提前知道「接下來幾擊有沒有 crash」（重音抬手，見 poseEngine/accentPose.js），
 * 所以過門在進入 groove 時就先挑好（plannedFill），peek 才看得到。
 * 換段後的 groove 由 pickNext 依當下速度決定，事先不知道 —— 但第一擊一定有 crash（規則 6），
 * peek 只回傳到那一擊為止（只有 crash，回傳長度可能少於要求）。
 *
 * ═══ 刻意不知道時間 ═══
 *
 * 與 songMode/sequencer.js 同一個原則：本模組沒有時鐘。
 * 「多久沒打要歸零」是時間判斷，放在上一層 freePlayRouter，
 * 這裡只提供 reset()。不要在這裡加時間參數。
 * 譜上的時值（拍數）與密度是譜的內容，不是時間；換算成 BPM 是上一層的事。
 * 依速度挑 groove 也是上一層的事：這裡只把候選、密度與 special 交給 pickNext。
 */

import { SOUNDS, START_GROOVE, LOOPS, GROOVES, FILLS } from "./grooveTable.js";

/** 合法的「幾分音符」 */
const NOTE_VALUES = [1, 2, 4, 8, 16, 32];

/**
 * 時值："8" → { value: 8, mod: "" }、"8." → 附點 mod "."、"8t" → 三連 mod "t"
 * 格式錯 → value = NaN
 */
function parseDur(text) {
  const m = /^(\d+)(\.|t)?$/.exec(text);
  return m ? { value: Number(m[1]), mod: m[2] ?? "" } : { value: NaN, mod: "" };
}

/** 自動音的前綴 */
const AUTO = "~";

/**
 * "hihat+kick/8." → { names: ["hihat", "kick"], dur: { value: 8, mod: "." }, auto: false }
 * 沒寫時值 → dur = null（用該項的 unit）；"~" 開頭 → auto = true
 */
function parseToken(token) {
  const auto = token.startsWith(AUTO);
  const [namePart, durPart] = (auto ? token.slice(AUTO.length) : token).split("/");
  return {
    names: namePart.split("+"),
    dur: durPart === undefined ? null : parseDur(durPart),
    auto,
  };
}

/** 時值 → 拍數（四分音符 = 1 拍）。附點 ×1.5、三連 ×2/3 */
const toBeats = ({ value, mod }) => (4 / value) * (mod === "." ? 1.5 : mod === "t" ? 2 / 3 : 1);

/** unit（8、16 或 "8t"）→ 時值 */
const unitDur = (unit) => parseDur(String(unit));

/** 休止符的音名 */
const REST = "rest";

/**
 * "(snare)" → { name: "snare", ghost: true, flam: false }
 * "{snare}" → { name: "snare", ghost: false, flam: true }
 * "snare"   → { name: "snare", ghost: false, flam: false }
 * 括號互相包（"({snare})"）不拆，name 會是未知音名 → validateTable 警告。
 */
function parseNote(text) {
  const ghost = /^\((.*)\)$/.exec(text);
  if (ghost) return { name: ghost[1], ghost: true, flam: false };
  const flam = /^\{(.*)\}$/.exec(text);
  if (flam) return { name: flam[1], ghost: false, flam: true };
  return { name: text, ghost: false, flam: false };
}

/** 音名 → 一顆音 { midi, ghost, flam }（midi 可能是 undefined = 寫錯的音名） */
function toNote(text) {
  const { name, ghost, flam } = parseNote(text);
  return { midi: SOUNDS[name], ghost, flam };
}

/**
 * "kick hihat/16 rest kick+(ride)" → { steps: [{ notes: [{ midi: 36, ghost: false, flam: false }], beats, auto }, ...], leadingRestBeats }
 * rest 不是一擊：它的拍數併進前一擊（打一下走一格不變）。
 * 開頭的 rest 沒有前一擊 → 拍數另外回傳（leadingRestBeats），groove 與過門的處理不同。
 * auto = 自動音（"~"）：仍是一格，但不用打，跟著前一擊自動響。
 * offbeat = 不落在拍點上（8 分的 &、16 分的 e／a、三連的後兩下；rest 也佔位置）。
 */
function parseTokens(text, unit) {
  const steps = [];
  let leadingRestBeats = 0;
  let position = 0;
  for (const token of text.trim().split(/\s+/)) {
    const { names, dur, auto } = parseToken(token);
    const beats = toBeats(dur ?? unitDur(unit));
    const offbeat = !isInt(position);
    position += beats;
    if (names[0] === REST) {
      if (steps.length) steps[steps.length - 1].beats += beats;
      else leadingRestBeats += beats;
      continue;
    }
    steps.push({ notes: names.map(toNote), beats, auto, offbeat });
  }
  return { steps, leadingRestBeats };
}

/** groove 的一輪：開頭的 rest 併進最後一擊（循環時剛好接上） */
function parseSteps(text, unit) {
  const { steps, leadingRestBeats } = parseTokens(text, unit);
  if (steps.length) steps[steps.length - 1].beats += leadingRestBeats;
  return steps;
}

/**
 * groove 從第一格起的 headBeats 拍（一輪不夠長就循環），接在過門前面。
 * 跨過界線的那一擊照響，拍數截到界線；界線之後的音（含自動音）不響 —— 那裡已經是過門。
 */
function grooveHead(steps, headBeats) {
  const head = [];
  let position = 0;
  for (let i = 0; headBeats - position > 1e-6; i = (i + 1) % steps.length) {
    const beats = Math.min(steps[i].beats, headBeats - position);
    head.push({ ...steps[i], beats, fromGroove: true });
    position += steps[i].beats;
  }
  return head;
}

/** 換段第一擊被 crash 取代的鈸 */
const CRASH_REPLACES = new Set([SOUNDS.hihat, SOUNDS.hihat_open, SOUNDS.ride, SOUNDS.ride_bell]);
const CRASH_NOTE = { midi: SOUNDS.crash, ghost: false, flam: false };
const hasCrash = (notes) => notes.some((n) => n.midi === SOUNDS.crash);

/** 能關鈸（踩合 hi-hat）的音 */
const CLOSES_HAT = new Set([SOUNDS.hihat, SOUNDS.pedal]);
const anyClosesHat = (steps) => steps.some((s) => s.notes.some((n) => CLOSES_HAT.has(n.midi)));

/** 換段第一擊：鈸換成一個 crash，其他音照響；沒有鈸就直接加上。⚠ 回傳新陣列，不改到譜 */
function withCrash(notes) {
  if (hasCrash(notes)) return notes;
  return [CRASH_NOTE, ...notes.filter((n) => !CRASH_REPLACES.has(n.midi))];
}

const pick = (v) => (Array.isArray(v) ? v[Math.floor(Math.random() * v.length)] : v);
const asList = (v) => (Array.isArray(v) ? v : [v]);
const isInt = (x) => Math.abs(x - Math.round(x)) < 1e-6;

const sumBeats = (steps) => steps.reduce((sum, s) => sum + s.beats, 0);

/** 要打的擊數（不含自動音） */
const countHits = (steps) => steps.filter((s) => !s.auto).length;

/** 載入時檢查整張表，寫錯只警告不中斷（壞掉的音名該擊不發聲）。 */
function validateTable() {
  const warn = (msg) => console.warn("[grooveTable]", msg);
  const checkUnit = (where, unit) => {
    const { value, mod } = unitDur(unit);
    if (!NOTE_VALUES.includes(value) || mod === ".") {
      warn(`${where}: unit 必須是 ${NOTE_VALUES.join("/")}（三連加 t，例如 "8t"）`);
    }
  };
  const checkSteps = (where, text) => {
    const tokens = text.trim().split(/\s+/);
    const sounding = tokens.map(parseToken).filter((t) => t.names[0] !== REST);
    if (!sounding.some((t) => !t.auto)) warn(`${where}: 至少要有一擊（不含自動音）`);
    // 自動音跟著前一擊響；第一個音沒有前一擊（一擊不會跨到上一輪／上一段）
    else if (sounding[0].auto) warn(`${where}: 第一個音不能是自動音`);
    tokens.forEach((token) => {
      const { names, dur, auto } = parseToken(token);
      if (names.includes(REST)) {
        if (auto) warn(`${where}: rest 不能加 "${AUTO}" "${token}"`);
        if (names.length > 1) warn(`${where}: rest 不能與音名同時寫 "${token}"`);
      }
      for (const text of names) {
        const { name, ghost, flam } = parseNote(text);
        if (name === REST) {
          if (ghost || flam) warn(`${where}: rest 不能加括號 "${token}"`);
        } else if (!(name in SOUNDS)) warn(`${where}: 未知音名 "${name}"`);
      }
      if (dur !== null && !NOTE_VALUES.includes(dur.value)) warn(`${where}: 時值不合法 "${token}"`);
    });
  };
  /**
   * 一串連續的三連音（含三連的 rest）結束時要落在半拍上 ——
   * 否則是三連沒湊滿就接直拍，總拍數不一定出錯，但節奏是歪的。
   */
  const checkTuplets = (where, text, unit) => {
    let pos = 0;
    let inRun = false;
    const endRun = () => {
      if (inRun && !isInt(pos * 2)) warn(`${where}: 三連音沒湊滿（停在第 ${+pos.toFixed(3)} 拍）`);
    };
    for (const token of text.trim().split(/\s+/)) {
      const dur = parseToken(token).dur ?? unitDur(unit);
      if (Number.isNaN(dur.value)) return; // 時值寫錯，checkSteps 已警告
      const tuplet = dur.mod === "t";
      if (!tuplet) endRun();
      inRun = tuplet;
      pos += toBeats(dur);
    }
    endRun();
  };

  for (const n of asList(LOOPS)) {
    if (!(n >= 1)) warn(`LOOPS: ${n} 必須 ≥ 1`);
  }
  for (const s of asList(START_GROOVE)) {
    if (!GROOVES[s]) warn(`START_GROOVE "${s}" 不存在`);
  }
  for (const [id, g] of Object.entries(GROOVES)) {
    const where = `GROOVES.${id}`;
    checkUnit(where, g.unit);
    checkSteps(where, g.steps);
    checkTuplets(where, g.steps, g.unit);
    for (const f of asList(g.fill)) {
      if (!FILLS[f]) warn(`${where}: fill "${f}" 不存在`);
    }

    const steps = parseSteps(g.steps, g.unit);
    const totalBeats = sumBeats(steps);
    for (const f of asList(g.fill)) {
      if (!FILLS[f]) continue;
      const parsed = parseTokens(FILLS[f].steps, FILLS[f].unit);
      const fillBeats = sumBeats(parsed.steps) + parsed.leadingRestBeats;
      for (const n of asList(LOOPS)) {
        if (fillBeats - n * totalBeats > 1e-6) warn(`${where}: LOOPS ${n} 比過門 "${f}" 短`);
      }
    }
    if (!isInt(totalBeats)) warn(`${where}: 一輪 ${totalBeats} 拍，不是整數拍`);
  }
  if (Object.values(GROOVES).every((g) => g.special)) {
    warn("GROOVES 至少要有一個非 special 的 groove");
  }
  for (const [id, f] of Object.entries(FILLS)) {
    const where = `FILLS.${id}`;
    checkUnit(where, f.unit);
    checkSteps(where, f.steps);
    checkTuplets(where, f.steps, f.unit);
  }
}

export function createGrooveEngine() {
  validateTable();

  const grooveSteps = {};
  for (const [id, g] of Object.entries(GROOVES)) grooveSteps[id] = parseSteps(g.steps, g.unit);
  const fillSteps = {};
  for (const [id, f] of Object.entries(FILLS)) fillSteps[id] = parseTokens(f.steps, f.unit);
  /**
   * 每個 groove 的密度：每拍平均擊數（不含自動音）。
   * selector 拿使用者的手速換算 BPM，要的是「手」每拍打幾下，不是每拍響幾聲。
   */
  const density = {};
  for (const [id, steps] of Object.entries(grooveSteps)) {
    density[id] = countHits(steps) / sumBeats(steps);
  }
  /** 換段的候選：整張表（special 何時用由上一層決定） */
  const candidates = Object.keys(GROOVES).map((id) => ({
    id,
    density: density[id],
    special: !!GROOVES[id].special,
  }));
  const regularIds = candidates.filter((c) => !c.special).map((c) => c.id);
  /** 這一段有沒有能關鈸的音（規則 7）；過門只看它自己的音，不含開頭由 groove 打的部分 */
  const grooveCloses = {};
  for (const [id, steps] of Object.entries(grooveSteps)) grooveCloses[id] = anyClosesHat(steps);
  const fillCloses = {};
  for (const [id, f] of Object.entries(fillSteps)) fillCloses[id] = anyClosesHat(f.steps);

  let grooveId, fillId, step, loopCount, loopTarget;
  /** 下一擊是換段的第一擊 → 加 crash（規則 6） */
  let crashNext;
  /** 下一擊是換段的第一擊（規則 7 用；crashNext 在上一段已有 crash 時是 false，不能共用） */
  let newSegment;
  /** 這個 groove 循環完要進的過門與實際要走的格子（進入 groove 時先挑好，peek 用） */
  let plannedFill, plannedFillSteps;

  /**
   * 進入某個 groove：輪數歸零並挑之後的過門、過門之前要循環幾輪。
   * 輪數已被過門佔滿（loopTarget = 0）→ 直接從過門開始。
   */
  function enterGroove(id) {
    grooveId = id;
    loopCount = 0;
    plannedFill = pick(GROOVES[id].fill);
    const { steps = [], leadingRestBeats = 0 } = fillSteps[plannedFill] ?? {};
    plannedFillSteps = [...grooveHead(grooveSteps[id], leadingRestBeats), ...steps];
    // ⚠ 三連的拍數加總有浮點誤差，4.0000001 拍不能算成佔 2 輪
    const fillRounds = Math.ceil((sumBeats(steps) + leadingRestBeats) / sumBeats(grooveSteps[id]) - 1e-6);
    loopTarget = Math.max(0, pick(LOOPS) - fillRounds);
    fillId = loopTarget === 0 ? plannedFill : null; // 非 null = 正在過門
  }

  function reset() {
    enterGroove(pick(START_GROOVE)); // 陣列則隨機
    step = 0;
    crashNext = false;
    newSegment = false;
  }
  reset();

  /**
   * 走一格，回傳這一擊的內容：
   *   notes   要發的音：[{ midi, ghost, flam }]（midi 可能是 undefined = 寫錯的音名；
 *           ghost = 鬼音；flam = 前面帶一個倚音，倚音與主音的間隔由上一層決定）
   *   beats   這一擊到下一擊的拍數（含後面的自動音）—— 給上一層換算速度用
   *   inFill  這一擊是否屬於過門（過門開頭由 groove 打的幾擊不算）
   *   offbeat 這一擊是否不落在拍點上
   *   autos   跟著這一擊的自動音：[{ notes, offsetBeats, offbeat }]，offsetBeats = 距離這一擊幾拍
   *   closeHat 這一擊要截斷還在響的開鈸（規則 7）
   *
   * @param {Function} [pickNext]  換段時挑下一個 groove：
   *   pickNext({ candidates: [{ id, density, special }], currentId, currentDensity }) → groove id
   *   沒傳則在非 special 中隨機。
   */
  function hit(pickNext) {
    const steps = fillId !== null ? plannedFillSteps : grooveSteps[grooveId];
    const inFill = fillId !== null && !steps[step].fromGroove;
    let { beats } = steps[step];
    const { offbeat } = steps[step];
    const notes = crashNext ? withCrash(steps[step].notes) : steps[step].notes;
    const fillStart = inFill && (step === 0 || steps[step - 1].fromGroove);
    const closeHat =
      ((newSegment || fillStart) && hasCrash(notes)) ||
      (newSegment && !grooveCloses[grooveId]) ||
      (fillStart && !fillCloses[fillId]);
    crashNext = false;
    newSegment = false;
    step++;

    /** 這段結束 → 換 groove；新段第一擊加 crash（這段最後一個音已有 crash 則不加） */
    const enterNext = () => {
      crashNext = !hasCrash(steps[steps.length - 1].notes);
      newSegment = true;
      enterGroove(
        pickNext
          ? pickNext({ candidates, currentId: grooveId, currentDensity: density[grooveId] })
          : pick(regularIds),
      );
    };

    // 緊接的自動音一起走完（不會跨段：每段第一個音不是自動音，見 validateTable）
    const autos = [];
    while (step < steps.length && steps[step].auto) {
      autos.push({ notes: steps[step].notes, offsetBeats: beats, offbeat: steps[step].offbeat });
      beats += steps[step].beats;
      step++;
    }

    if (step >= steps.length) {
      step = 0;
      if (fillId) {
        enterNext();
      } else if (++loopCount >= loopTarget) {
        // 沒有過門 → 直接換 groove（量不到 fill 手速，selector 會在同密度中隨機）
        if (plannedFill) fillId = plannedFill;
        else enterNext();
      }
    }
    return { notes, beats, inFill, offbeat, autos, closeHat };
  }

  /**
   * 預覽接下來 n 擊的音（不改變狀態）。自動音不用打，跳過不算。
   * 換段後的 groove 尚未決定，只看到它第一擊的 crash 為止，回傳長度可能少於 n。
   *
   * @returns {number[][]} 每擊的 MIDI 音高陣列（不分鬼音）
   */
  function peek(n) {
    const out = [];
    let f = fillId, s = step, lc = loopCount, crash = crashNext;
    while (out.length < n) {
      const steps = f ? plannedFillSteps : grooveSteps[grooveId];
      if (!steps[s].auto) {
        out.push(crash ? withCrash(steps[s].notes) : steps[s].notes);
        crash = false;
      }
      if (++s < steps.length) continue;
      s = 0;
      if (!f) {
        if (++lc < loopTarget) continue;
        if (plannedFill) {
          f = plannedFill;
          continue;
        }
      }
      // 這段結束：下一個 groove 尚未決定，但第一擊一定有 crash
      if (out.length < n && !hasCrash(steps[steps.length - 1].notes)) out.push([CRASH_NOTE]);
      break;
    }
    return out.map((notes) => notes.map((n) => n.midi));
  }

  /** 除錯用：目前位置 */
  function getPosition() {
    return { grooveId, fillId, step, loopCount, loopTarget };
  }

  return { hit, peek, reset, getPosition };
}
