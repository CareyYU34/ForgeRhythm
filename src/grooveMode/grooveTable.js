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
 *        ⚠ 每一擊都一定會發聲（打一下走一格），所以沒有休止符；
 *          休止的長度併進前一擊的時值（見下）。
 *
 * 時值：音名後面接 "/幾分音符"，附點加 "."；沒寫 = 該項的 unit。
 *        "hihat+kick/8"  八分
 *        "snare/16"      十六分
 *        "kick/8."       附點八分（= 3 個十六分）
 *        "crash/4"       四分（含後面的休止）
 *        時值只用來換算速度（BPM），不影響「打一下走一格」。
 *
 * GROOVES 每一項：
 *   unit   最小單位是幾分音符（8 或 16），也是 steps 時值的預設值
 *   rate   倍率（分類標籤）：每拍平均擊數 ÷ 2，以「8 分全打」= 1。
 *          unit 為 16 時必填，例如切分 16 分 ≈ 1.25、16 分全打 = 2。
 *          ⚠ 引擎選 groove 用的是由時值算出來的實際密度，不是這個標籤；
 *            載入時兩者差超過 20% 會在 console 警告（附上實際值）。
 *   steps  一輪的內容；一輪的總拍數必須是整數拍
 *   loops  連續循環幾輪後進入過門；給陣列則每次進入此 groove 時隨機挑一個
 *   fill   過門 id；給陣列則隨機挑一個
 *   next   過門結束後換到哪個 groove；給陣列則隨機挑一個
 *          （可以包含自己 = 過門後回到同一個 groove）
 *
 * FILLS 每一項：
 *   unit   最小單位是幾分音符，也是 steps 時值的預設值
 *   feel   這個過門容易讓人打擊 "faster" 變快／"same" 維持／"slower" 變慢
 *          （銜接下一個 groove 時的判斷參考，不是強制變速）
 *   steps  過門內容，只播一次
 *   land   （選填）過門結束後，直接取代「下一個 groove 第一擊」的音，
 *          例如 "kick+crash" → 下一擊從 kick 變成 kick+crash。給陣列則隨機挑一個。
 *          ⚠ land 是一擊的內容，不寫時值（時值跟著被取代的那一擊）。
 *          ⚠ 是取代不是疊加：只寫 "crash" 就只有 crash，原本的 kick 不會響。
 *          ⚠ 收尾的 crash 要寫在這裡，不要寫進 steps 最後一格 ——
 *            寫在 steps 會早一拍（落在過門裡），land 才會落在新段落的第 1 拍。
 *
 * 音名只能用 SOUNDS 裡有的。有新取樣時，先到 audioEngine 的
 * MIDI_TO_SOUND_ID 加上 MIDI 對應，再到 SOUNDS 加音名。
 * 載入時 grooveEngine 會檢查整張表，寫錯的音名／id／時值會在 console 警告。
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
  tom1: 50,
  tom2: 47,
  floor: 43,
};

/** 開始打擊時、以及閒置歸零後的起始 groove */
export const START_GROOVE = ["basic", "double"];

/*
 * 註解的拍點記法：1 e & a = 一拍裡的四個 16 分位置。
 *   K = kick、S = snare，例如「K: 1 1a 2a」= kick 落在 1、1 的 a、2 的 a。
 */
export const GROOVES = {
  // ─── 8 分（rate 1 附近）────────────────────────────────

  // 動 次 打 次
  basic: {
    unit: 8,
    steps: "hihat+kick hihat hihat+snare hihat",
    loops: 4,
    fill: ["snare4", "kickSnare", "tomsDown8"],
    next: ["basic", "double", "offbeat", "syncA"],
  },
  // 動 次 打 次 動 動 打 次
  double: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat hihat+kick hihat+kick hihat+snare hihat",
    loops: 2,
    fill: ["snare4", "tomsDown8", "kickTom"],
    next: ["basic", "ride", "syncA", "funkA"],
  },
  // 動 叮 打 叮（ride 取代 hihat）
  ride: {
    unit: 8,
    steps: "ride+kick ride ride+snare ride",
    loops: 4,
    fill: ["kickSnare", "syncTom"],
    next: ["basic", "offbeat"],
  },
  // 8 分切分：kick 落在反拍。K: 1 2& 3&｜S: 2 4
  offbeat: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat+kick hihat hihat+kick hihat+snare hihat",
    loops: [2, 4],
    fill: ["tomsDown8", "kickTom", "slowToms"],
    next: ["basic", "offbeat", "syncA", "dotted"],
  },
  // 附點 3+3+2（tresillo）：每拍擊數比 8 分全打少 → 適合變慢時接。K: 1 1a 3 3a｜S: 2& 4&
  dotted: {
    unit: 8,
    rate: 0.75,
    steps:
      "hihat+kick/8. hihat+kick/8. hihat+snare hihat+kick/8. hihat+kick/8. hihat+snare",
    loops: [2, 4],
    fill: ["slowToms", "tomsDown8"],
    next: ["basic", "offbeat"],
  },

  // ─── 16 分切分（rate 1.1～1.5）────────────────────────

  // 8 分 hihat 中夾一個 16 分 kick。K: 1 1a 3｜S: 2 4
  syncA: {
    unit: 16,
    rate: 1.125,
    steps:
      "hihat+kick/8 hihat kick hihat+snare/8 hihat/8 hihat+kick/8 hihat/8 hihat+snare/8 hihat/8",
    loops: [2, 4],
    fill: ["syncTom", "half16"],
    next: ["syncA", "funkA", "syncB", "basic"],
  },
  // funk：kick 落在 a。K: 1 1a 2a 3&｜S: 2 4
  funkA: {
    unit: 16,
    rate: 1.25,
    steps:
      "hihat+kick/8 hihat kick hihat+snare/8 hihat kick hihat/8 hihat+kick/8 hihat+snare/8 hihat/8",
    loops: [2, 4],
    fill: ["toms16", "syncTom"],
    next: ["funkA", "syncA", "syncB", "full16", "offbeat"],
  },
  // 密集切分：kick 落在 e 與 a。K: 1 1a 2e 3 3e 4a｜S: 2 4
  syncB: {
    unit: 16,
    rate: 1.5,
    steps:
      "hihat+kick/8 hihat kick hihat+snare kick hihat/8 hihat+kick kick hihat/8 hihat+snare/8 hihat kick",
    loops: 2,
    fill: ["half16", "toms16"],
    next: ["syncB", "funkA", "full16", "syncA", "basic"],
  },

  // ─── 16 分全打（rate 2）──────────────────────────────

  // K: 1 3 3&｜S: 2 4
  full16: {
    unit: 16,
    rate: 2,
    steps:
      "hihat+kick hihat hihat hihat hihat+snare hihat hihat hihat " +
      "hihat+kick hihat hihat+kick hihat hihat+snare hihat hihat hihat",
    loops: 2,
    fill: ["toms16", "half16"],
    next: ["full16", "syncB", "funkA", "basic"],
  },
};

export const FILLS = {
  // 打打打打 → 下一段第 1 拍 crash
  snare4: {
    unit: 8,
    feel: "same",
    steps: "snare+snare snare+snare snare+snare snare+snare",
    land: "crash",
  },
  // 動打動打 打打打打 → 下一段第 1 拍 crash
  kickSnare: {
    unit: 8,
    feel: "same",
    steps: "kick snare kick snare snare snare snare snare",
    land: "crash",
  },
  // 8 分下行：snare → tom1 → tom2 → floor，各兩下（一小節）
  tomsDown8: {
    unit: 8,
    feel: "same",
    steps: "snare snare tom1 tom1 tom2 tom2 floor floor",
    land: ["kick+crash", "crash"],
  },
  // kick 與 floor 交替，最後 snare 帶上 tom
  kickTom: {
    unit: 8,
    feel: "same",
    steps: "kick floor kick floor snare snare tom1 tom2",
    land: "kick+crash",
  },
  // 16 分下行，每顆鼓一拍四下（一小節）—— 從 8 分接過來會讓人加速
  toms16: {
    unit: 16,
    feel: "faster",
    steps:
      "snare snare snare snare tom1 tom1 tom1 tom1 " +
      "tom2 tom2 tom2 tom2 floor floor floor floor",
    land: "kick+crash",
  },
  // 16 分繞鼓兩圈（兩拍），短而密
  half16: {
    unit: 16,
    feel: "faster",
    steps: "snare tom1 tom2 floor snare tom1 tom2 floor",
    land: ["kick+crash", "crash"],
  },
  // 切分 tom：S 1、T1 1& 1a、T2 2（附點）、F 2a 3、K 3&、F 4、K 4&
  syncTom: {
    unit: 16,
    feel: "same",
    steps: "snare/8 tom1 tom1 tom2/8. floor floor/8 kick/8 floor/8 kick/8",
    land: "crash",
  },
  // 四分音符一拍一下 —— 擊數變少，讓人放慢
  slowToms: {
    unit: 4,
    feel: "slower",
    steps: "tom1+crash tom2 floor kick+floor",
    land: "kick+crash",
  },
};
