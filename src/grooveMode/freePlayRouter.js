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
 * 換段時，以量到的基點與手速交給 grooveSelector 挑下一個 groove
 * （經由 engine.hit(pickNext) —— 引擎只給候選與密度，不知道時間）。
 *
 * ═══ 特殊節奏計時器（grooveTable 標 special 的 groove，shuffle 類）═══
 *
 * 特殊節奏不參與依速度挑選，只在計時器到時出現，而且優先於 selector：
 *   · 開始打擊後 SPECIAL_FIRST_MS 到期；到期後的下一次換段 → 在 special 中隨機挑一個。
 *   · 每出現一次，等待時間 × SPECIAL_SHRINK（不低於 SPECIAL_MIN_MS）
 *     → 打得越久，特殊節奏越常出現。
 *   · 計時從「離開特殊節奏」那一刻重新開始（特殊節奏本身的長度不算在等待裡）。
 *   · 閒置歸零時計時器一起歸零（等待時間回到 SPECIAL_FIRST_MS）。
 * ⚠ 時間判斷只在這一層：計時到了不會在 groove 中途硬切，只在引擎換段時（pickNext）生效。
 *
 * ═══ 自動音（譜上 "~"）═══
 *
 * 引擎回傳「自動音距離這一擊幾拍」，這裡用 tracker.getBeatMs() 換成毫秒，
 * 交給 audio.playMidiAt 排程。下一擊進來（或閒置歸零）時，還沒響的自動音全部取消 ——
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
 * 閉鈸或踏鈸響起時，還在響的開鈸在 HAT_CHOKE_MS 內淡出（audio.chokeOpenHats），
 * 就像踩合真的 hi-hat。真的截斷到開鈸時疊上踏鈸聲（chick）；譜上寫的 pedal 本身就是
 * 踏鈸，不再多疊。自動音的 choke 與 chick 落在排程時間點，自動音被取消時一併取消。
 * 段落第一擊若引擎回傳 closeHat（這段沒有能關鈸的音，見 grooveEngine 規則 7），
 * 這一擊也照同樣的方式截斷開鈸（真的截斷到才疊 chick），開鈸不會一路響過整段過門。
 *
 * ═══ 速度顯示（onTempo）═══
 *
 * 每一擊之後與閒置歸零時，把目前的速度交給 onTempo（畫面上的 BPM 顯示）：
 *   bpm         ＝ 60000 ÷ tracker.getBeatMs() —— 與自動音排程用的是同一個值，
 *                 groove 中跟著最近幾擊走，過門中退回基點
 *   baselineBpm ＝ tracker 的基點（選 groove 用）
 * 量不到為 null。事件驅動，不掛在任何 rAF loop 上。
 *
 * ═══ 重音預覽（getUpcomingAccent）═══
 *
 * 畫面每幀問「接下來 n 擊有沒有 crash」，用來把手部節點畫得抬更高
 * （poseEngine/accentPose.js）。閒置歸零也要算進去：已閒置超過 GROOVE_RESET_MS
 * 時，下一擊會從起始 groove 開始，所以預覽前先歸零（resetIfIdle 只歸零一次，
 * 起始 groove 隨機時，預覽與真正打下去的才會是同一個）。
 */

import { createGrooveEngine } from "./grooveEngine.js";
import { createTempoTracker } from "./tempoTracker.js";
import { selectNextGroove } from "./grooveSelector.js";
import { createHatOpener } from "./hatOpener.js";
import { SOUNDS } from "./grooveTable.js";
import { MIDI_TO_SOUND_ID } from "../audioEngine.js";

const isCrash = (midi) => MIDI_TO_SOUND_ID[midi] === "crash";

/** 這顆音會踩合 hi-hat，截斷還在響的開鈸 */
const closesHat = (note) => note.midi === SOUNDS.hihat || note.midi === SOUNDS.pedal;
const isPedal = (note) => note.midi === SOUNDS.pedal;

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

/** 超過這麼久沒打，回到起始 groove 第一格（ms）。約 120 BPM 下三拍。 */
export const GROOVE_RESET_MS = 1500;

/** 開始打擊後，第一次出現特殊節奏前的等待（ms） */
export const SPECIAL_FIRST_MS = 60000;
/** 每出現一次特殊節奏，下一次的等待乘上這個倍率 */
export const SPECIAL_SHRINK = 0.8;
/** 特殊節奏等待的下限（ms） */
export const SPECIAL_MIN_MS = 20000;

/**
 * @param {Object}   deps
 * @param {Object}   deps.audio         audioEngine（需 playMidi、playMidiAt、chokeOpenHats、now）
 * @param {Function} deps.playZone      原本的 audioEngine.playZone（位置對應用）
 * @param {Function} deps.getFreeStyle  取得當下打法："groove"｜"mapping"
 * @param {Function} [deps.onTempo]     速度更新：({ bpm, baselineBpm, grooveId, inFill }) → void
 */
export function createFreePlayRouter({ audio, playZone, getFreeStyle, onTempo }) {
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
  function playNotes(notes, closeHat) {
    if (closeHat || notes.some(closesHat)) {
      const t = audio.now();
      const { cut } = audio.chokeOpenHats(t, HAT_CHOKE_MS / 1000);
      // ⚠ 用 playMidiAt：chick 是這一擊的附帶聲音，不觸發打擊監聽。也不放進 scheduledAutos
      if (cut && !notes.some(isPedal)) audio.playMidiAt(SOUNDS.pedal, t, HAT_CHICK_GAIN);
    }
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

  function scheduleAutos(autos) {
    const beatMs = tracker.getBeatMs();
    if (!autos.length || beatMs === null) return;
    const t0 = audio.now();
    const schedule = (midi, when, gain) => {
      const src = audio.playMidiAt(midi, when, gain);
      if (src) scheduledAutos.push({ src, when });
    };
    for (const { notes, offsetBeats } of autos) {
      const when = t0 + (offsetBeats * beatMs) / 1000;
      if (notes.some(closesHat)) {
        const { cut, undo } = audio.chokeOpenHats(when, HAT_CHOKE_MS / 1000);
        scheduledChokes.push({ undo, when });
        if (cut && !notes.some(isPedal)) schedule(SOUNDS.pedal, when, HAT_CHICK_GAIN);
      }
      for (const note of notes) {
        if (note.midi === undefined) continue;
        // 與打擊當下一致：倚音落在自動音的時間點，主音晚 FLAM_MS
        if (note.flam) schedule(note.midi, when, GRACE_GAIN);
        schedule(note.midi, note.flam ? when + FLAM_MS / 1000 : when, gainOf(note));
      }
    }
  }

  function emitTempo(inFill) {
    if (!onTempo) return;
    const beatMs = tracker.getBeatMs();
    onTempo({
      bpm: beatMs ? 60000 / beatMs : null,
      baselineBpm: tracker.getBaselineBpm(),
      grooveId: engine.getPosition().grooveId,
      inFill,
    });
  }

  function resetIfIdle(nowMs) {
    if (idleResetDone || nowMs - lastHitMs <= GROOVE_RESET_MS) return;
    cancelAutos();
    engine.reset();
    tracker.reset();
    hatOpener.reset();
    specialWaitMs = SPECIAL_FIRST_MS;
    specialDueMs = null;
    idleResetDone = true;
    emitTempo(false);
  }

  /** 給 engine 的 pickNext：計時器到了 → 特殊節奏；否則補上量到的速度後交給 selector */
  function pickNext({ candidates, currentId, currentDensity }) {
    const specials = candidates.filter((c) => c.special);
    // 離開特殊節奏 → 從現在重新計時
    if (specials.some((c) => c.id === currentId)) specialDueMs = lastHitMs + specialWaitMs;
    else if (specials.length && lastHitMs >= specialDueMs) {
      specialWaitMs = Math.max(SPECIAL_MIN_MS, specialWaitMs * SPECIAL_SHRINK);
      specialDueMs = Infinity;
      const { id } = specials[Math.floor(Math.random() * specials.length)];
      console.debug(`[groove] 計時到 → 特殊節奏 ${id}（下次等待 ${(specialWaitMs / 1000).toFixed(0)} 秒）`);
      return id;
    }

    const baselineBpm = tracker.getBaselineBpm();
    const hitRate = tracker.getFillHitRate();
    const result = selectNextGroove({
      candidates: candidates.filter((c) => !c.special),
      currentId,
      currentDensity,
      baselineBpm,
      hitRate,
    });
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
      resetIfIdle(nowMs);
      if (tracker.isDuplicate(nowMs)) return;
      lastHitMs = nowMs;
      idleResetDone = false;
      if (specialDueMs === null) specialDueMs = nowMs + specialWaitMs;
      cancelAutos();

      // ⚠ 順序：先結算間隔，再走格（引擎可能在這一擊決定下一個 groove）
      tracker.hit(nowMs);
      const step = engine.hit(pickNext);
      tracker.setStep(step.beats, step.inFill);
      const { notes, autos } = hatOpener.apply(step);

      playNotes(notes, step.closeHat);
      // ⚠ 在 tracker.hit 之後：getBeatMs 要含這一擊剛結算的間隔
      scheduleAutos(autos);
      emitTempo(step.inFill);
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
