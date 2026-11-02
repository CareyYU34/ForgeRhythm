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
 *        ⚠ 每一擊都一定會發聲（打一下走一格）。
 *
 * 鬼音：音名加括號，例如 "(snare)"、"hihat+(snare)"、"~(snare)/8t"。
 *        以較小的音量播放（freePlayRouter 的 GHOST_GAIN），其他規則與一般音相同。
 *        ⚠ 括號只包音名，不包時值與 "~"；rest 不能加括號。
 *
 * 自動音：音名前加 "~"，例如 "~hihat"、"~hihat+snare/8t"。
 *        不用打：跟著前一擊，依使用者當下的速度自動響（freePlayRouter 排程）。
 *        用在使用者不容易打出來的節奏（例如三連音）：使用者只打拍點，
 *        拍與拍之間由自動音補上。使用者提早打下一擊，還沒響的自動音會取消。
 *        ⚠ groove／過門的第一個音不能是自動音；rest 與 land 不能加 "~"。
 *        ⚠ 自動音不算擊數：rate 與 selector 用的密度都只算要打的那幾擊。
 *
 * 休止：寫 "rest"，時值寫法同音名（"rest/16"、"rest/8."，沒寫 = unit）。
 *        rest 不是一擊、不用打：它的長度併進前一擊，只影響 BPM 換算與密度。
 *        所以 "kick/16 rest/8" 與 "kick/8." 完全等價，照譜面習慣寫即可。
 *        ⚠ groove 開頭的 rest 併進一輪的最後一擊；過門不能以 rest 開頭。
 *        ⚠ 過門的時值（含 rest）不影響任何判斷：fill 手速只看每秒幾擊，
 *          下一個 groove 在過門最後一擊當下就決定。所以過門結尾的 rest
 *          只是讓譜面補滿一小節，下一個 groove 照樣在使用者下一擊接上。
 *        ⚠ rest 不能跟音名用 "+" 連接，land 也不能是 rest。
 *
 * 時值：音名後面接 "/幾分音符"，附點加 "."；沒寫 = 該項的 unit。
 *        "hihat+kick/8"  八分
 *        "snare/16"      十六分
 *        "kick/8."       附點八分（= 3 個十六分）
 *        "crash/4"       四分（含後面的休止）
 *        三連音加 "t"（不能與附點同時用）：
 *        "snare/8t"      8 分三連（一拍 3 下，各 1/3 拍）
 *        "snare/16t"     16 分三連 = 6 連音（一拍 6 下，各 1/6 拍）
 *        "kick/4t"       4 分三連（2/3 拍）—— shuffle 的長音：kick/4t hihat/8t
 *        ⚠ 一串連續的三連音結束時要落在半拍上（沒湊滿就接直拍會警告）。
 *        ⚠ 自由模式沒有節拍器，平均地打 8 分、16 分、三連聽起來都一樣；
 *          「三連感」來自音色以 3 個一組排列（kick／snare／重音的位置），
 *          時值只決定換算出來的 BPM。
 *        時值只用來換算速度（BPM），不影響「打一下走一格」。
 *        慣例：unit 設成該項最常出現的時值，只有例外才標。
 *
 * GROOVES 每一項：
 *   unit   最小單位是幾分音符（8、16，或三連 "8t"），也是 steps 時值的預設值
 *   rate   倍率（分類標籤）：每拍平均擊數 ÷ 2，以「8 分全打」= 1。
 *          unit 不是 8 時必填，例如切分 16 分 ≈ 1.25、16 分全打 = 2、8 分三連全打 = 1.5。
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
  hihat_open: 46,
  crash: 49,
  ride: 51,
  tom1: 50,
  tom2: 47,
  floor: 43,
};

/** 開始打擊時、以及閒置歸零後的起始 groove */
// ⚠ 試打 tripletShuffle 用，試完改回 ["basic", "double"]
export const START_GROOVE = ["tripletShuffle"];

/*
 * 註解的拍點記法：1 e & a = 一拍裡的四個 16 分位置。
 *   K = kick、S = snare，例如「K: 1 1a 2a」= kick 落在 1、1 的 a、2 的 a。
 * 三連音：1 t l = 一拍裡的三個 8 分三連位置（1 trip let），例如「K: 3l」= 3 的 let。
 *
 * ⚠ 三連的 groove 不要放進 START_GROOVE：tempoTracker 第一次取基點只會 ÷2 折，
 *   三連與直拍差 3:2，折不回來。（shuffle 每拍 2 擊與 basic 同密度，不受影響。）
 */
export const GROOVES = {
  // ─── 8 分（rate 1 附近）────────────────────────────────

  // 動 次 打 次
  basic: {
    unit: 8,
    steps: "hihat+kick hihat hihat+snare hihat",
    loops: 4,
    fill: ["snare4", "kickSnare", "tomsDown8"],
    next: ["basic", "double", "offbeat", "syncA", "shuffle"],
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
    fill: ["kickSnare", "syncTom", "tripletToms"],
    next: ["basic", "offbeat", "shuffle"],
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
      "hihat+kick/8. hihat+kick/16 rest hihat+snare hihat+kick/8. hihat+kick/16 rest hihat+snare",
    loops: [2, 4],
    fill: ["slowToms", "tomsDown8"],
    next: ["basic", "offbeat"],
  },

  // ─── 三連音 ─────────────────────────────────────────

  // shuffle：長短長短（4 分三連 + 8 分三連）。每拍 2 擊 → 與 basic 同密度，手速不變就能互換。
  // K: 1 3 3l｜S: 2 4
  shuffle: {
    unit: "8t",
    rate: 1,
    steps:
      "hihat+kick/4t hihat hihat+snare/4t hihat " +
      "hihat+kick/4t hihat+kick hihat+snare/4t hihat",
    loops: [2, 4],
    fill: ["tripletToms", "kickSnare"],
    next: ["shuffle", "basic", "triplet"],
  },
  // 12/8 感：8 分三連全打（ride）。每拍 3 擊（rate 1.5，與 syncB 同密度）。
  // K: 1 3 3l｜S: 2 4
  triplet: {
    unit: "8t",
    rate: 1.5,
    steps:
      "ride+kick ride ride ride+snare ride ride " +
      "ride+kick ride ride+kick ride+snare ride ride",
    loops: 2,
    fill: ["tripletToms", "sextTom"],
    next: ["triplet", "shuffle", "syncB", "full16"],
  },
  // 三連 shuffle 練習譜（第 7–10 小節的前三小節；第四小節是過門 tripletBar）。
  // 使用者每拍只打一下（拍點），拍內的三連音全部是自動音 → 每拍 1 擊（rate 0.5）。
  // P = hi-hat 踏板（pedal，譜表下方的 ✕）。第 1、3 拍是一般四分音符，不是三連。
  //   第 1 小節  HH 1 2 2l 3 4 4l｜S: 2 4｜K: 1 3｜P: 2 4
  //   第 2 小節  HH 1 2 2l 3 4 4l｜S: 3   ｜K: 1  ｜P: 3
  //   第 3 小節  HH 1 2 2l 3 4 4l｜S: 1l 3｜K: 2l 4l｜P: 2 4
  tripletShuffle: {
    unit: "8t",
    rate: 0.5,
    steps:
      "ride+kick/4  ride+snare+pedal/4t ~ride  " +
      "ride+kick/4  ride+snare+pedal/4t ~ride  ",
    // "hihat+kick/4  hihat/4t ~hihat  " +
    // "hihat+snare+pedal/4  hihat/4t ~hihat  " +
    // "hihat/4t ~snare  hihat+pedal/4t ~hihat+kick  " +
    // "hihat+snare/4  hihat+pedal/4t ~hihat+kick",
    loops: 10,
    fill: "tripletBar",
    next: ["tripletShuffle", "basic"],
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
    next: ["funkA", "syncA", "syncB", "full16", "offbeat", "triplet"],
  },
  // 密集切分：kick 落在 e 與 a。K: 1 1a 2e 3 3e 4a｜S: 2 4
  syncB: {
    unit: 16,
    rate: 1.5,
    steps:
      "hihat+kick/8 hihat kick hihat+snare kick hihat/8 hihat+kick kick hihat/8 hihat+snare/8 hihat kick",
    loops: 2,
    fill: ["half16", "toms16"],
    next: ["syncB", "funkA", "full16", "syncA", "basic", "triplet"],
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
    steps: "snare+snare snare+snare snare+snare snare+snare rest/2",
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
    steps: "snare tom1 tom2 floor snare tom1 tom2 floor rest/2",
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
  // 8 分三連下行：每顆鼓一拍三下（一小節）
  tripletToms: {
    unit: "8t",
    feel: "same",
    steps: "snare snare snare tom1 tom1 tom1 tom2 tom2 tom2 floor floor floor",
    land: "kick+crash",
  },
  // 練習譜第 4 小節：8 分三連，HH 在 1 與 l、S 在每拍的 t（另有 S 3）、K 1 2l 4l。
  // 使用者每拍只打拍點，t l 是自動音。
  tripletBar: {
    unit: "8t",
    feel: "same",
    steps:
      "hihat+kick ~snare ~hihat  hihat ~snare ~hihat+kick  " +
      "hihat+snare ~snare ~hihat  hihat ~snare ~hihat+kick",
  },
  // 6 連音（3+3）繞鼓兩拍 —— 很密，只放在過門
  sextTom: {
    unit: "16t",
    feel: "faster",
    steps: "snare tom1 tom2 snare tom1 tom2 tom1 tom2 floor tom1 tom2 floor rest/2",
    land: ["kick+crash", "crash"],
  },
};
