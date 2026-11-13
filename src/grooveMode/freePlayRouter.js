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
 * tempoTracker 只量手速（每秒幾擊，不看譜，見 tempoTracker.js）。
 * 兩手相隔 MERGE_MS 內的打擊併成一擊（不走格、不發聲），否則雙手同時拍
 * 會走兩格，也會把速度量歪。
 *
 *     BPM ＝ 60 × 手速 ÷ 目前 groove 的密度（每拍幾擊，引擎由譜算出）
 *
 * 過門中用的是它所屬 groove 的密度（過門的譜不拿來換算）；換段那一擊起就是新 groove 的密度。
 * 換段時，把手速與速度狀態（tracker.getTempoState：平常／加快／放慢）交給 grooveSelector 挑下一個 groove
 * （經由 engine.hit(pickNext) —— 引擎只給候選與密度，不知道時間）。
 *
 * ═══ 速度 log（Chrome console 需開 Verbose，篩選 "[tempo]"；也寫進 pose log）═══
 *
 * 每一擊一行：剛結算的間隔、手速（用了幾個間隔）、密度與換算出的 BPM。
 * 另外印出：併擊（雙手同時打被併掉的那一下）、閒置歸零、速度狀態改變。
 * 數字跳動時對照這幾行就知道是哪個間隔造成的。選 groove 的 [groove] 行同樣處理。
 *
 * 同時經 trace() 寫進 perfLog：掛在該擊的 terminator.tempo（見 poseEngine/perfLog說明.md），
 * 匯出的 pose log 就帶著這些紀錄，不必另外複製 console。
 *
 * ═══ 特殊節奏計時器（grooveTable 標 special 的 groove，shuffle 類）═══
 *
 * 特殊節奏不參與依速度挑選，只在計時器到時出現，而且優先於 selector：
 *   · 開始打擊後 SPECIAL_FIRST_MS 到期 → 卡住等放慢：到期後任何一擊的倍數（手速 ÷ 平常，
 *     tempoTracker）≤ SPECIAL_RATIO_MAX 就鎖存「可以進」（specialReady），
 *     之後手速回升也不取消；下一次換段 → 在 special 中挑一個（越久沒出現的越優先）。
 *     shuffle 是放鬆、往後坐的感覺，用正常速度打會太趕；放慢手時換進來，音樂上也說得通。
 *     ⚠ 看當下的倍數、不看速度狀態：狀態要持續 CONFIRM_MS 才成立，放慢一下就鎖存才跟手。
 *     ⚠ 只在換段時切換（不在 groove 中途硬切）。
 *   · 安全網：換算的音樂速度要在 [SPECIAL_BPM_MIN, SPECIAL_BPM_MAX]，超出就延後到下次換段
 *     （鎖存保留）。⚠ 太快時三連的自動音擠在一起，聽起來很怪（實測）。
 *     ⚠ 舊做法是「速度狀態為 slower ＋ 音樂速度在範圍內」才派發：shuffle 每拍打一下時
 *       音樂速度 ＝ 每分鐘幾擊，平常 300 擊/分的人放慢後仍有 240 BPM，永遠進不來
 *       （11-11、11-13 log 延後 30 多次）。
 *     ⚠ 刻意沒有保底：一直不放慢就不會出現 shuffle（想聽就放慢手）。
 *   · 每出現一次，等待時間 × SPECIAL_SHRINK（不低於 SPECIAL_MIN_MS）
 *     → 打得越久，特殊節奏越常出現。
 *   · 計時從「離開特殊節奏」那一刻重新開始（特殊節奏本身的長度不算在等待裡）。
 *   · 閒置歸零時計時器一起歸零（等待時間回到 SPECIAL_FIRST_MS）。
 * ⚠ 時間判斷只在這一層：計時到了不會在 groove 中途硬切，只在引擎換段時（pickNext）生效。
 *
 * ═══ 自動音（譜上 "~"）═══
 *
 * 引擎回傳「自動音距離這一擊幾拍」與這一擊到下一擊共幾拍。預計下一擊在 1 ÷ 手速 秒後，
 * 自動音照拍數比例分配在這段時間裡（例如 shuffle 每拍打一下，三連的兩個自動音落在 1/3、2/3），
 * 交給 audio.playMidiAt 排程。只看手速，所以換段當下（密度改變）也排得對。
 * 下一擊進來（或閒置歸零）時，還沒響的自動音全部取消 ——
 * 使用者打得比預測早，不會跟他打的音疊在一起；打得晚，自動音照常響完、等他。
 * 量不到速度（剛開始打）時這一擊的自動音不響。
 *
 * ═══ Flam（譜上 "{snare}"）═══
 *
 * 倚音不能比打擊早響，所以倚音在打擊當下響、主音晚 FLAM_MS（自動音同理，
 * 以排程時間點為準）。同一擊的其他音不等主音，照常在打擊當下響。
 *
 * ═══ 開鈸（hatOpener）與 Choke ═══
 *
 * 引擎給的譜先經過 hatOpener，反拍的 hihat 可能變成 hihat_open（規則見 hatOpener.js）。
 * 開鈸後下一顆音（任何音，含新的開鈸與自動音）一響，還在響的開鈸就在 HAT_CHOKE_MS 內淡出
 * （audio.chokeOpenHats）—— 開鈸的長度就是到下一顆音的時值，不會疊在一起或一路響過過門。
 * ⚠ 截斷在發這一擊的音之前，所以這一擊自己的開鈸不會被截斷。
 * 只有被閉鈸（hihat）截斷時疊上踏鈸聲（chick），就像踩合真的 hi-hat；被 kick／snare 等
 * 截斷只淡出（每次都疊的話，16 分密的節奏會多出一堆 chick）；譜上寫的 pedal 本身就是踏鈸。
 * 自動音的 choke 與 chick 落在排程時間點，自動音被取消時一併取消。
 * 閒置歸零時，還在響的開鈸在 IDLE_HAT_FADE_MS 內淡出（停下不打時沒有「下一顆音」）。
 *
 * ⚠ 畫面上不顯示速度數字（手速或音樂速度都不顯示）：音樂速度是系統端的選擇，
 *   手速顯示出來也只讓人分心。畫面只顯示速度狀態（getTempoState，main.js 標籤）；
 *   要看速度變化請看 [tempo] log。
 *
 * ═══ 重音預覽（getUpcomingAccent）═══
 *
 * 畫面每幀問「接下來 n 擊有沒有 crash」，用來把手部節點畫得抬更高
 * （poseEngine/accentPose.js）。閒置歸零也要算進去：已閒置超過 GROOVE_RESET_MS
 * 時，下一擊會從起始 groove 開始，所以預覽前先歸零（resetIfIdle 只歸零一次，
 * 起始 groove 隨機時，預覽與真正打下去的才會是同一個）。
 */

import { createGrooveEngine } from "./grooveEngine.js";
import { createTempoTracker, MERGE_MS, MAX_HOLD_MS, TEMPO_STATE_LABEL } from "./tempoTracker.js";
import { selectNextGroove, pickStale } from "./grooveSelector.js";
import { createHatOpener } from "./hatOpener.js";
import { SOUNDS } from "./grooveTable.js";
import { MIDI_TO_SOUND_ID } from "../audioEngine.js";
import { perfLog } from "../poseEngine/perfLog.js";

const isCrash = (midi) => MIDI_TO_SOUND_ID[midi] === "crash";

/** 被這一擊截斷的開鈸要疊上踏鈸聲（chick）：有閉鈸、而且譜上沒寫 pedal（pedal 本身就是踏鈸） */
const wantsChick = (notes) =>
  notes.some((note) => note.midi === SOUNDS.hihat) && !notes.some((note) => note.midi === SOUNDS.pedal);

/** 鬼音（譜上括號）的音量倍率 */
export const GHOST_GAIN = 0.3;

const gainOf = (note) => (note.ghost ? GHOST_GAIN : 1);

/** Flam（譜上大括號）倚音的音量倍率 */
export const GRACE_GAIN = 0.4;

/**
 * Flam 倚音到主音的間隔（ms）。真實的 flam 約 20–40ms：太短聽起來像一聲加厚，
 * 太長變成兩下（drag）。
 * ⚠ 打擊當下響的是倚音（不能提早響），所以主音比打擊晚這麼多。
 */
export const FLAM_MS = 30;

/** 開鈸被踩合時的淡出時間（ms）。太短會有爆音，太長聽不出踩合。 */
export const HAT_CHOKE_MS = 40;

/** 截斷開鈸時疊上的踏鈸聲（chick）音量倍率 */
export const HAT_CHICK_GAIN = 0.7;

/** 閒置歸零時，還在響的開鈸的淡出時間（ms）。不是踩合，慢慢收掉，不疊 chick。 */
export const IDLE_HAT_FADE_MS = 300;

/** 超過這麼久沒打，回到起始 groove 第一格（ms）。約 120 BPM 下三拍。 */
export const GROOVE_RESET_MS = 1500;

/** 開始打擊後，第一次出現特殊節奏前的等待（ms） */
export const SPECIAL_FIRST_MS = 60000;
/** 每出現一次特殊節奏，下一次的等待乘上這個倍率 */
export const SPECIAL_SHRINK = 0.8;
/** 特殊節奏等待的下限（ms） */
export const SPECIAL_MIN_MS = 20000;
/** 計時到之後，倍數（手速 ÷ 平常）≤ 這個值就鎖存「可以進特殊節奏」 */
export const SPECIAL_RATIO_MAX = 0.8;
/** 特殊節奏的音樂速度範圍（BPM，安全網）：換算超出就延後到下次換段 */
export const SPECIAL_BPM_MIN = 80;
export const SPECIAL_BPM_MAX = 150;

/**
 * @param {Object}   deps
 * @param {Object}   deps.audio         audioEngine（需 playMidi、playMidiAt、chokeOpenHats、now）
 * @param {Function} deps.playZone      原本的 audioEngine.playZone（位置對應用）
 * @param {Function} deps.getFreeStyle  取得當下打法："groove"｜"mapping"
 */
export function createFreePlayRouter({ audio, playZone, getFreeStyle }) {
  const engine = createGrooveEngine();
  const tracker = createTempoTracker();
  const hatOpener = createHatOpener();
  let lastHitMs = -Infinity;
  /** 已排程、可能還沒響的自動音：{ src, when } */
  let scheduledAutos = [];
  /** 自動音排程的 choke：{ undo, when } */
  let scheduledChokes = [];
  /** 這段閒置已歸零過（預覽與打擊共用，避免歸零兩次） */
  let idleResetDone = false;
  /** 特殊節奏：目前的等待長度、到期時間（null = 還沒開始計時；Infinity = 正在特殊節奏中） */
  let specialWaitMs = SPECIAL_FIRST_MS;
  let specialDueMs = null;
  /** 計時到之後已經放慢過（鎖存，派發或閒置歸零才清掉） */
  let specialReady = false;

  /** 取消還沒開始響的自動音（已經在響的讓它響完，不切尾音）與它們的 choke */
  function cancelAutos() {
    const t = audio.now();
    for (const { src, when } of scheduledAutos) {
      if (when > t) src.stop();
    }
    for (const { undo, when } of scheduledChokes) {
      if (when > t) undo();
    }
    scheduledAutos = [];
    scheduledChokes = [];
  }

  /** 打擊當下發聲：一般音立刻響；Flam 立刻響倚音、FLAM_MS 後響主音 */
  function playNotes(notes) {
    // 任何音都截斷還在響的開鈸（見檔頭「開鈸與 Choke」）；在發音之前，這一擊自己的開鈸不受影響
    const t = audio.now();
    const { cut } = audio.chokeOpenHats(t, HAT_CHOKE_MS / 1000);
    // ⚠ 用 playMidiAt：chick 是這一擊的附帶聲音，不觸發打擊監聽。也不放進 scheduledAutos
    if (cut && wantsChick(notes)) audio.playMidiAt(SOUNDS.pedal, t, HAT_CHICK_GAIN);
    for (const note of notes) {
      if (note.midi === undefined) continue;
      if (!note.flam) {
        audio.playMidi(note.midi, gainOf(note));
        continue;
      }
      audio.playMidi(note.midi, GRACE_GAIN);
      // ⚠ 主音不放進 scheduledAutos：它屬於這一擊，下一擊進來時不取消
      audio.playMidiAt(note.midi, audio.now() + FLAM_MS / 1000, gainOf(note));
    }
  }

  /** 目前的速度：手速、目前 groove 的密度與換算出的 BPM（量不到為 null） */
  function tempoNow() {
    const { rate, samples } = tracker.getHitRate();
    const { density } = engine.getPosition();
    return { rate, samples, density, bpm: rate === null ? null : (60 * rate) / density };
  }

  /** 自動音照拍數比例分配在「這一擊 → 預計的下一擊」之間（見檔頭「自動音」） */
  function scheduleAutos(autos, stepBeats) {
    const { rate } = tracker.getHitRate();
    if (!autos.length || rate === null) return;
    const t0 = audio.now();
    const schedule = (midi, when, gain) => {
      const src = audio.playMidiAt(midi, when, gain);
      if (src) scheduledAutos.push({ src, when });
    };
    for (const { notes, offsetBeats } of autos) {
      const when = t0 + offsetBeats / stepBeats / rate;
      // ⚠ 依序排：前一個自動音的開鈸已經登記，這裡才截得到
      const { cut, undo } = audio.chokeOpenHats(when, HAT_CHOKE_MS / 1000);
      scheduledChokes.push({ undo, when });
      if (cut && wantsChick(notes)) schedule(SOUNDS.pedal, when, HAT_CHICK_GAIN);
      for (const note of notes) {
        if (note.midi === undefined) continue;
        // 與打擊當下一致：倚音落在自動音的時間點，主音晚 FLAM_MS
        if (note.flam) schedule(note.midi, when, GRACE_GAIN);
        schedule(note.midi, note.flam ? when + FLAM_MS / 1000 : when, gainOf(note));
      }
    }
  }

  let hitNo = 0;
  /** 印一行 log，同時寫進 pose log（text = 這一行，data = 結構化數值） */
  function trace(text, data = {}) {
    console.debug(text);
    perfLog.tempo({ text, ...data });
  }
  const fmt = (x, digits = 0) => (x === null || x === undefined ? "-" : x.toFixed(digits));

  /** 每一擊的速度 log（見檔頭「速度 log」）；intervalMs = 剛結算的間隔（第一擊 null） */
  function logTempo(intervalMs, step, grooveId) {
    const section = step.inFill ? "過門" : grooveId;
    const { rate, samples, density, bpm } = tempoNow();
    const { state, typicalRate, thawed } = tracker.getTempoState();
    const ivText = intervalMs === null ? "第一擊" : `間隔 ${fmt(intervalMs)}ms`;
    const rateText = rate === null ? "手速 -" : `手速 ${fmt(rate * 60)} 擊/分（近 ${samples} 個間隔）`;
    trace(
      `[tempo] #${hitNo} ${section}｜${ivText}｜${rateText}｜平常 ${fmt(typicalRate && typicalRate * 60)}` +
        `（${TEMPO_STATE_LABEL[state]}${thawed ? "・解凍" : ""}）｜密度 ${fmt(density, 2)} → 音樂 ${fmt(bpm)} BPM`,
      {
        kind: "hit",
        hitNo,
        grooveId,
        inFill: step.inFill,
        intervalMs,
        hitRate: rate,
        samples,
        typicalRate,
        tempoState: state,
        thawed,
        density,
        bpm,
      },
    );
  }

  const CHANGE_REASON = { warmedUp: "量測完成", ratio: "持續達門檻" };

  /** 速度狀態改變（tracker.hit 回傳的 change；"thaw" 狀態不變，只是平常解凍） */
  function logStateChange({ from, to, reason }) {
    const { typicalRate, ratio } = tracker.getTempoState();
    const head =
      reason === "thaw"
        ? `[tempo] ${TEMPO_STATE_LABEL[from]}已維持 ${MAX_HOLD_MS / 1000} 秒 → 平常解凍，開始跟著移動（`
        : `[tempo] 狀態 ${TEMPO_STATE_LABEL[from]} → ${TEMPO_STATE_LABEL[to]}（${CHANGE_REASON[reason]}；`;
    trace(
      head +
        `手速為平常的 ${fmt(ratio, 2)} 倍，平常 ${fmt(typicalRate && typicalRate * 60)} 擊/分）`,
      { kind: "state", from, to, reason, ratio, typicalRate },
    );
  }

  function resetIfIdle(nowMs) {
    if (idleResetDone || nowMs - lastHitMs <= GROOVE_RESET_MS) return;
    cancelAutos();
    audio.chokeOpenHats(audio.now(), IDLE_HAT_FADE_MS / 1000);
    engine.reset();
    tracker.reset();
    hatOpener.reset();
    specialWaitMs = SPECIAL_FIRST_MS;
    specialDueMs = null;
    specialReady = false;
    idleResetDone = true;
    trace(`[tempo] 閒置 ${fmt(nowMs - lastHitMs)}ms → 歸零`, { kind: "idleReset", idleMs: nowMs - lastHitMs });
    hitNo = 0;
  }

  /** 每一擊（tracker.hit 之後）：計時已到、還沒鎖存，而且倍數 ≤ SPECIAL_RATIO_MAX → 鎖存 */
  function checkSpecialReady(nowMs) {
    if (specialReady || specialDueMs === null || nowMs < specialDueMs) return;
    const { state, ratio, typicalRate } = tracker.getTempoState();
    if (state === "measuring" || ratio === null || ratio > SPECIAL_RATIO_MAX) return;
    specialReady = true;
    trace(`[groove] 計時已到，手速為平常的 ${fmt(ratio, 2)} 倍（≤ ${SPECIAL_RATIO_MAX}）→ 下次換段進特殊節奏`, {
      kind: "specialReady",
      ratio,
      typicalRate,
    });
  }

  /** 給 engine 的 pickNext：計時器到了 → 特殊節奏；否則補上量到的速度後交給 selector */
  function pickNext({ candidates, currentId, currentDensity }) {
    const { rate } = tracker.getHitRate();
    const tempo = tracker.getTempoState();
    const { typicalRate, ratio } = tempo;
    const specials = candidates.filter((c) => c.special);
    // 離開特殊節奏 → 從現在重新計時
    if (specials.some((c) => c.id === currentId)) specialDueMs = lastHitMs + specialWaitMs;
    else if (specials.length && lastHitMs >= specialDueMs) {
      // 放慢過（鎖存）才派發，音樂速度是安全網（見檔頭「特殊節奏計時器」）
      const bpmOf = (c) => (60 * rate) / c.density;
      const fit =
        specialReady && rate !== null
          ? specials.filter((c) => bpmOf(c) >= SPECIAL_BPM_MIN && bpmOf(c) <= SPECIAL_BPM_MAX)
          : [];
      if (fit.length) {
        specialWaitMs = Math.max(SPECIAL_MIN_MS, specialWaitMs * SPECIAL_SHRINK);
        specialDueMs = Infinity;
        specialReady = false;
        const picked = pickStale(fit); // 越久沒出現的越優先
        trace(
          `[groove] 計時到且放慢過（目前手速為平常的 ${fmt(ratio, 2)} 倍）→ 特殊節奏 ${picked.id}` +
            `（音樂 ${fmt(bpmOf(picked))} BPM，下次等待 ${(specialWaitMs / 1000).toFixed(0)} 秒）`,
          { kind: "special", id: picked.id, ratio, impliedBpm: bpmOf(picked), nextWaitMs: specialWaitMs },
        );
        return picked.id;
      }
      const why = !specialReady
        ? `還沒放慢到平常的 ${SPECIAL_RATIO_MAX} 倍以下（目前 ${fmt(ratio, 2)} 倍）`
        : rate === null
          ? "量不到速度"
          : `音樂速度會是 ${specials.map((c) => fmt(bpmOf(c))).join("/")} BPM，超出 ${SPECIAL_BPM_MIN}–${SPECIAL_BPM_MAX}`;
      trace(`[groove] 計時到，但${why} → 延後到下次換段`, {
        kind: "specialDeferred",
        ratio,
        hitRate: rate,
        typicalRate,
        tempoState: tempo.state,
      });
    }

    // 目前的音樂速度：手速 ÷ 目前（即將離開的）groove 的密度（只給 log 對照）
    const currentBpm = rate === null ? null : (60 * rate) / currentDensity;
    const result = selectNextGroove({
      candidates: candidates.filter((c) => !c.special),
      currentDensity,
      hitRate: rate,
      tempo,
    });
    // 除錯（Chrome console 需開 Verbose 才看得到；也寫進 pose log）
    trace(
      `[groove] ${currentId}｜手速 ${fmt(rate && rate * 60)}／平常 ${fmt(typicalRate && typicalRate * 60)} 擊/分` +
        `｜→ ${result.id}（${result.reason}；音樂 ${fmt(currentBpm)} → ${fmt(result.impliedBpm)} BPM）`,
      { kind: "select", from: currentId, hitRate: rate, typicalRate, tempoState: tempo.state, currentBpm, ...result },
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
      resetIfIdle(nowMs);
      if (tracker.isDuplicate(nowMs)) {
        trace(`[tempo] 併擊：距上一擊 ${fmt(nowMs - lastHitMs)}ms（< ${MERGE_MS}ms），不走格`, {
          kind: "merged",
          gapMs: nowMs - lastHitMs,
        });
        return;
      }
      lastHitMs = nowMs;
      idleResetDone = false;
      if (specialDueMs === null) specialDueMs = nowMs + specialWaitMs;
      cancelAutos();

      // ⚠ 順序：先結算間隔，再走格（引擎可能在這一擊決定下一個 groove）
      const { intervalMs, change } = tracker.hit(nowMs);
      if (change) logStateChange(change);
      checkSpecialReady(nowMs);
      const grooveId = engine.getPosition().grooveId; // 這一擊所屬的 groove（engine.hit 可能換段）
      const step = engine.hit(pickNext);
      hitNo++;
      logTempo(intervalMs, step, grooveId);
      const { notes, autos } = hatOpener.apply(step);

      playNotes(notes);
      // ⚠ 在 tracker.hit 之後：手速要含這一擊剛結算的間隔
      scheduleAutos(autos, step.beats);
    },

    /**
     * 畫面顯示用的速度狀態（只讀，不歸零）。
     * @returns {?string} null = 不是節奏循環；"idle" = 還沒打或已閒置（下一擊會歸零）；
     *   其餘為 tempoTracker 的狀態（"measuring"｜"normal"｜"faster"｜"slower"）
     */
    getTempoState(nowMs) {
      if (getFreeStyle() !== "groove") return null;
      if (nowMs - lastHitMs > GROOVE_RESET_MS) return "idle";
      return tracker.getTempoState().state;
    },

    /**
     * 接下來 n 擊內是否有 crash（左右手、左右膝各一個布林）。
     *   節奏循環：不知道下一擊是哪隻手或膝蓋 → 全部相同。
     *   位置對應：該部位設成 crash 就是。
     */
    getUpcomingAccent(n, zoneSound) {
      if (getFreeStyle() !== "groove") {
        return {
          left: zoneSound.left_front === "crash",
          right: zoneSound.right_front === "crash",
          leftKnee: zoneSound.left_heel === "crash",
          rightKnee: zoneSound.right_heel === "crash",
        };
      }
      resetIfIdle(performance.now());
      const on = engine.peek(n).some((notes) => notes.some(isCrash));
      return { left: on, right: on, leftKnee: on, rightKnee: on };
    },
  };
}
