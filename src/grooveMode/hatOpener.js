/**
 * grooveMode/hatOpener.js
 *
 * 職責：決定這一擊（與跟著它的自動音）的閉鈸要不要變成開鈸。
 *
 * ═══ 機率 ═══
 *
 * 機率 = 距離上次開鈸的拍數 × OPEN_RATE_PER_BEAT。開了就歸零。
 * 間隔因此比固定機率平均：剛開過幾乎不會再開，隔越久越容易開。
 *
 * ⚠ 累積的是譜上的拍數，不是時間 —— 否則打得越慢、每小節開鈸越多。
 *   所以本模組和 grooveEngine 一樣沒有時鐘。
 *
 * ═══ 誰能開 ═══
 *
 * 一般 groove：只有反拍（engine 的 offbeat）的 hihat，鬼音除外，每個各自擲骰。
 * 標 openRound 的 groove（4 分組）：一輪（兩小節）開頭擲一次骰，開了就整輪的 hihat
 *   全部開（正拍也開，鬼音除外），不會只開一兩個；沒開就整輪都不開。
 *   過門前由 groove 補的半輪不算完整一輪（engine 的 fullRound = false），整個半輪都不開。
 * 其他音照常累積拍數。譜上明寫的 hihat_open 不擲骰，但同樣歸零。
 *
 * 開鈸響多久不在這裡決定：下一顆音一出來就截斷（freePlayRouter）。
 *
 * ⚠ 自動音在排程時就決定並歸零。如果使用者提早打下一擊把它取消，
 *   這次開鈸不會響，機率一樣從零開始。
 */

import { SOUNDS } from "./grooveTable.js";

/**
 * 每拍增加的開鈸機率。
 * 8 分 hihat、只有反拍能開時，平均約 2 小節開一次。
 * 整輪開（一輪 8 拍）：第一輪約 16%、第二輪約 32%。
 */
export const OPEN_RATE_PER_BEAT = 0.02;

const isOpenable = (note) => note.midi === SOUNDS.hihat && !note.ghost;
const openAll = (notes) => notes.map((note) => (isOpenable(note) ? { ...note, midi: SOUNDS.hihat_open } : note));

export function createHatOpener() {
  let beatsSinceOpen = 0;
  /** 目前這一輪整輪開鈸（openRound 的 groove） */
  let roundOpen = false;

  const roll = () => Math.random() < beatsSinceOpen * OPEN_RATE_PER_BEAT;

  /** ⚠ 回傳新陣列：notes 是 engine 解析好的譜，下一輪還要用，不能改到 */
  function resolve(notes, offbeat, openRound) {
    if (notes.some((note) => note.midi === SOUNDS.hihat_open)) {
      beatsSinceOpen = 0;
      return notes;
    }
    if (!notes.some(isOpenable)) return notes;
    if (openRound) {
      if (!roundOpen) return notes;
    } else if (!offbeat || !roll()) return notes;
    beatsSinceOpen = 0;
    return openAll(notes);
  }

  return {
    /**
     * 處理 engine.hit 的回傳值，回傳換過開鈸的 { notes, autos }。
     * 依發聲順序走：這一擊 → 各個自動音 → 走完到下一擊的剩餘拍數。
     */
    apply({ notes, offbeat, autos, beats, openRound, roundStart, fullRound }) {
      if (!openRound) roundOpen = false;
      else if (roundStart) roundOpen = fullRound && roll(); // 半輪不開，也不擲骰
      const resolvedNotes = resolve(notes, offbeat, openRound);
      let position = 0;
      const resolvedAutos = autos.map((auto) => {
        beatsSinceOpen += auto.offsetBeats - position;
        position = auto.offsetBeats;
        return { ...auto, notes: resolve(auto.notes, auto.offbeat, openRound) };
      });
      beatsSinceOpen += beats - position;
      return { notes: resolvedNotes, autos: resolvedAutos };
    },

    reset() {
      beatsSinceOpen = 0;
      roundOpen = false;
    },
  };
}
