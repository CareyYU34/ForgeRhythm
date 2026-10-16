/**
 * grooveMode/grooveTable.js
 *
 * 節奏循環模式的「譜表」—— 純資料，不含任何邏輯。
 * 新增／修改 groove 與 fill 只改這個檔案；播放規則在 grooveEngine.js。
 *
 * ═══ 寫法 ═══
 *
 * steps：以空白分隔的音名，一個音名 = 一擊。
 *        同時發聲用 "+" 連接，例如 "kick+ride"。
 *        ⚠ 每一擊都一定會發聲（打一下走一格），所以沒有休止符。
 *
 * GROOVES 每一項：
 *   steps  一輪的內容
 *   loops  這個 groove 連續循環幾輪後進入過門
 *   fill   過門 id；給陣列則隨機挑一個
 *   next   過門結束後換到哪個 groove；給陣列則隨機挑一個
 *          （可以包含自己 = 過門後回到同一個 groove）
 *
 * FILLS 每一項：
 *   steps  過門內容，只播一次
 *   land   （選填）過門結束後，直接取代「下一個 groove 第一擊」的音，
 *          例如 "kick+crash" → 下一擊從 kick 變成 kick+crash。
 *          ⚠ 是取代不是疊加：只寫 "crash" 就只有 crash，原本的 kick 不會響。
 *          ⚠ 收尾的 crash 要寫在這裡，不要寫進 steps 最後一格 ——
 *            寫在 steps 會早一拍（落在過門裡），land 才會落在新段落的第 1 拍。
 *
 * 音名只能用 SOUNDS 裡有的。有新取樣時，先到 audioEngine 的
 * MIDI_TO_SOUND_ID 加上 MIDI 對應，再到 SOUNDS 加音名。
 * 載入時 grooveEngine 會檢查整張表，寫錯的音名／id 會在 console 警告。
 */

/**
 * 音名 → MIDI 音高（必須存在於 audioEngine 的 MIDI_TO_SOUND_ID）。
 * ⚠ 音名與 audioEngine 的取樣 id 一致（含大小寫），兩邊同名。
 */
export const SOUNDS = {
  kick: 36,
  cross_stick: 37,
  snare: 38,
  hihat: 42,
  pedal: 44,
  crash: 49,
  ride: 51,
};

/** 開始打擊時、以及閒置歸零後的起始 groove */
export const START_GROOVE = ["basic", "double"];

export const GROOVES = {
  // 動 次 打 次
  basic: {
    steps: "kick hihat snare hihat",
    loops: 4,
    fill: ["snare4", "kickSnare"],
    next: ["basic", "double"],
  },
  // 動 次 打 次 動 動 打 次
  double: {
    steps: "kick hihat snare hihat kick kick snare hihat",
    loops: 2,
    fill: "snare4",
    next: ["basic", "ride"],
  },
  // 動 叮 打 叮（ride 取代 hihat）
  ride: {
    steps: "kick ride snare ride",
    loops: 4,
    fill: "kickSnare",
    next: "basic",
  },
};

export const FILLS = {
  // 打打打打 → 下一段第 1 拍 crash
  snare4: {
    steps: "snare snare snare snare",
    land: "crash",
  },
  // 動打動打 打打打打 → 下一段第 1 拍 crash
  kickSnare: {
    steps: "kick snare kick snare snare snare snare snare",
    land: "crash",
  },
};
