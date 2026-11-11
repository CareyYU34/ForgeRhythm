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
 * Flam（倚音）：音名加大括號，例如 "{snare}"、"hihat+{snare}"、"~{snare}/8t"。
 *        先響一個小聲的倚音（GRACE_GAIN），隔 FLAM_MS 再響主音（數值在 freePlayRouter）。
 *        打擊當下響的是倚音，所以主音比打擊晚 FLAM_MS；同一擊的其他音照常在打擊當下響。
 *        ⚠ 大括號只包音名，不包時值與 "~"；不能與鬼音括號一起用；rest 不能加大括號。
 *        ⚠ Flam 不改變擊數與時值：倚音是裝飾，不佔拍。
 *
 * 自動音：音名前加 "~"，例如 "~hihat"、"~hihat+snare/8t"。
 *        不用打：跟著前一擊，依使用者當下的速度自動響（freePlayRouter 排程）。
 *        用在使用者不容易打出來的節奏（例如三連音）：使用者只打拍點，
 *        拍與拍之間由自動音補上。使用者提早打下一擊，還沒響的自動音會取消。
 *        ⚠ groove／過門的第一個音不能是自動音；rest 不能加 "~"。
 *        ⚠ 自動音不算擊數：selector 用的密度只算要打的那幾擊。
 *
 * 開鈸：反拍的 hihat 會隨機變成 hihat_open（鬼音除外，規則見 hatOpener.js），譜上不用寫。
 *        標 openRound 的 groove 改成整輪（全部 hihat）一起開或一起不開。
 *        想固定開鈸就直接寫 "hihat_open"。開鈸後下一顆音（任何音，含自動音）一響就截斷，
 *        所以開鈸的長度就是到下一顆音的時值；想讓它響久一點，後面寫 rest。
 *        被 hihat 截斷時會自動疊上踏鈸聲，譜上不用寫 pedal。
 *
 * 休止：寫 "rest"，時值寫法同音名（"rest/16"、"rest/8."，沒寫 = unit）。
 *        rest 不是一擊、不用打：它的長度併進前一擊，只影響 BPM 換算與密度。
 *        所以 "kick/16 rest/8" 與 "kick/8." 完全等價，照譜面習慣寫即可。
 *        ⚠ groove 開頭的 rest 併進一輪的最後一擊；過門開頭的 rest 由 groove 接手（見 FILLS 的 steps）。
 *        ⚠ 過門的總拍數（含 rest）決定它佔掉幾輪（見 LOOPS），要補滿小節；
 *          比一輪短（兩小節一輪的 groove 接一小節過門）時，前面由 groove 補滿；
 *          過門結尾的 rest 就是用來補滿的，不會等待：fill 手速只看每秒幾擊，
 *          下一個 groove 在過門最後一擊當下就決定，照樣在使用者下一擊接上。
 *        ⚠ rest 不能跟音名用 "+" 連接。
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
 *   unit     最小單位是幾分音符（8、16，或三連 "8t"），也是 steps 時值的預設值
 *   special  （選填）true = 特殊節奏（shuffle 類）：不參與依速度挑選，
 *            只在計時器到時優先出現（見 freePlayRouter 的 SPECIAL_*）
 *   steps    一輪的內容；一輪的總拍數必須是整數拍（可以是兩小節，見 quarter 組）
 *   fill     過門 id；給陣列則隨機挑一個
 *            空陣列 [] = 沒有過門：輪數走完直接換下一個 groove，整段都是 groove
 *            ⚠ special 只配 shuffle 用的過門（fill2D／2E／2H／3D），一般 groove 不要用這幾個
 *   openRound （選填）true = 開鈸以「一輪」為單位：一輪開頭擲骰，開了整輪 hihat 全開，
 *            不會只開一兩個（見 hatOpener.js）。過門前由 groove 補的半輪不開。
 *
 * 每段幾輪不在這裡寫，所有 groove 共用 LOOPS。
 *
 * 下一個 groove 不在表裡指定：所有非 special 的 groove 都是候選，
 * 由 grooveSelector 依使用者的速度挑（密度由 steps 算出，不用標）。
 * BPM ＝ 手速 ÷ 密度：密度越低，同樣的手速 BPM 越高（4 分組）；密度越高 BPM 越低（16 分組）。
 *
 * 換段的第一擊一律加 crash（取代 hihat／hihat_open／ride／ride_bell，其他音照響；
 * 上一段最後一擊已有 crash 則不加）。規則在 grooveEngine.js，譜上不用寫。
 *
 * FILLS 每一項：
 *   unit   最小單位是幾分音符，也是 steps 時值的預設值
 *   steps  過門內容，只播一次
 *          開頭的 rest = 這幾拍繼續打 groove，過門從第一個音才開始（照譜面寫半小節過門）：
 *          "rest/2 snare snare" → groove 打前 2 拍，第 3 拍起換成過門。
 *          是取代不是疊加：過門開始後，groove 那幾拍的音（含 hihat）都不響。
 *          ⚠ groove 跨過界線的那一擊照響；界線之後的音與自動音不響。
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
  ride_bell: 53,
  splash: 55,
  tom1: 50,
  tom2: 47,
  floor: 43,
};

/**
 * 每一段的總小節數（4 拍一小節），進入 groove 時從中隨機挑一個（所有 groove 共用）。
 * 引擎換算成輪數（進位），過門（含開頭由 groove 打的部分）算在裡面：
 *   一輪 4 拍、過門 4 拍：3 = 2 輪 + 過門。
 *   一輪 8 拍（兩小節一輪）、過門 4 拍：3 或 4 都是 2 輪 = 1 輪 + 一小節 groove + 過門。
 * ⚠ 過門佔滿輪數時整段只有過門，groove 不會完整出現一輪（載入時會警告）。
 */
export const LOOPS = [3, 4];

/** 開始打擊時、以及閒置歸零後的起始 groove */
export const START_GROOVE = ["rock8A", "rock8B", "rock8C", "rock8D"];
 
/*
 * 註解的拍點記法：1 e & a = 一拍裡的四個 16 分位置。
 *   K = kick、S = snare，例如「K: 1 1a 2a」= kick 落在 1、1 的 a、2 的 a。
 * 三連音：1 t l = 一拍裡的三個 8 分三連位置（1 trip let），例如「K: 3l」= 3 的 let。
 *   P = hi-hat 踏板（pedal）。
 *
 * ═══ 三連 shuffle 組 ═══
 * 使用者每拍只打一下（拍點），拍內的三連音都是自動音 → 四個 groove 密度相同（每拍 1 擊）。
 * 標 special：計時器到時、而且手放慢下來（音樂速度 80–150）才出現（四個中隨機），
 * 不參與依速度挑選（見 freePlayRouter「特殊節奏計時器」）。
 */
/*
 * ═══ 命名 ═══
 * groove id = 組名 + A～D，組內由簡到繁。組別見 GROOVES 裡的分隔註解。
 */

export const GROOVES = {
  // ─── shuffle：ride 三連，使用者每拍只打一下，其餘是自動音 ───
  // Ride 全程三連 shuffle。K: 1 3｜S: 2 4｜P: 2 4
  shuffleA: {
    unit: "8t",
    special: true,
    steps:
      "ride+kick/4 ride+snare+pedal/4t ~ride " +
      "ride+kick/4 ride+snare+pedal/4t ~ride",
    fill: ["fill2D", "fill2E", "fill2H", "fill3D"],
  },
  // Half-time：snare 落在第 3 拍。K: 1｜S: 3｜P: 3
  shuffleB: {
    unit: "8t",
    special: true,
    steps: "ride+kick/4 ride/4t ~ride " + "ride+snare+pedal/4 ride/4t ~ride",
    fill: ["fill2D", "fill2E", "fill2H", "fill3D"],
  },
  // 切分：第 1 拍沒有 kick。K: 2l 4l｜S: 1l 3｜P: 2 4
  shuffleC: {
    unit: "8t",
    special: true,
    steps:
      "ride/4t ~snare ride+pedal/4t ~ride+kick " +
      "ride+snare/4 ride+pedal/4t ~ride+kick",
    fill: ["fill2D", "fill2E", "fill2H", "fill3D"],
  },
  // 三連全響，每拍中間是鬼音。K: 1 2l 4l｜S: 3｜鬼音 S: 每拍的 t
  shuffleD: {
    unit: "8t",
    special: true,
    steps:
      "ride+kick ~(snare) ~ride ride ~(snare) ~ride+kick " +
      "ride+snare ~(snare) ~ride ride ~(snare) ~ride+kick",
    fill: ["fill2D", "fill2E", "fill2H", "fill3D"],
  },

  // ─── rock8：8 分 hi-hat，kick 落在 8 分上 ───
  // K: 1 3｜S: 2 4
  rock8A: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat " +
      "hihat+kick hihat hihat+snare hihat",
    fill: ["fill1A", "fill1B", "fill1C", "fill2A", "fill2G", "fill3A", "fill4A"],
  },
  // K: 1 1& 2& 3&｜S: 2 4
  rock8B: {
    unit: 8,
    steps:
      "hihat+kick hihat+kick hihat+snare hihat+kick " +
      "hihat hihat+kick hihat+snare hihat",
    fill: ["fill1A", "fill1B", "fill1C", "fill2A", "fill2G", "fill3A", "fill4A"],
  },
  // K: 1 2& 3｜S: 2 4
  rock8C: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat+kick " +
      "hihat+kick hihat hihat+snare hihat",
    fill: ["fill1A", "fill1B", "fill1C", "fill2A", "fill2G", "fill3A", "fill4A"],
  },
  // K: 1 3 3&｜S: 2 4
  rock8D: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat " +
      "hihat+kick hihat+kick hihat+snare hihat",
    fill: ["fill1A", "fill1B", "fill1C", "fill2A", "fill2G", "fill3A", "fill4A"],
  },

  // ─── rock16：8 分 hi-hat，kick 帶一兩個 16 分 ───
  // K: 1 2& 2a 3&｜S: 2 4
  rock16A: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat+kick/16 kick/16 " +
      "hihat hihat+kick hihat+snare hihat",
    fill: ["fill1B", "fill1C", "fill2A", "fill2F", "fill2G", "fill3A"],
  },
  // K: 1 3 3a｜S: 2 4
  rock16B: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat " +
      "hihat+kick hihat/16 kick/16 hihat+snare hihat",
    fill: ["fill1B", "fill1C", "fill2A", "fill2F", "fill2G", "fill3A"],
  },
  // K: 1 1a 3&｜S: 2 4
  rock16C: {
    unit: 8,
    steps:
      "hihat+kick hihat/16 kick/16 hihat+snare hihat " +
      "hihat hihat+kick hihat+snare hihat",
    fill: ["fill1B", "fill1C", "fill2A", "fill2F", "fill2G", "fill3A"],
  },
  // K: 1 1a 3 3e 4e｜S: 2 4
  rock16D: {
    unit: 16,
    steps:
      "hihat+kick/8 hihat kick hihat+snare/8 hihat/8 " +
      "hihat+kick kick hihat/8 hihat+snare kick hihat/8",
    fill: ["fill1B", "fill1C", "fill2A", "fill2F", "fill2G", "fill3A"],
  },

  // ─── funk：8 分 hi-hat，kick 密集的 16 分切分 ───
  // K: 1 1& 1a 2a 3e 3& 4e 4&｜S: 2 4
  funkA: {
    unit: 16,
    steps:
      "hihat+kick/8 hihat+kick kick hihat+snare/8 hihat kick " +
      "hihat kick hihat kick hihat+snare kick hihat+kick/8",
    fill: ["fill2B", "fill2C", "fill3B", "fill3C", "fill4C", "fill4D"],
  },
  // K: 1 1a 2& 2a 3e 3& 4e｜S: 2 4
  funkB: {
    unit: 16,
    steps:
      "hihat+kick/8 hihat kick hihat+snare/8 hihat+kick kick " +
      "hihat kick hihat+kick/8 hihat+snare kick hihat/8",
    fill: ["fill2B", "fill2C", "fill3B", "fill3C", "fill4C", "fill4D"],
  },
  // K: 1 1e 2& 2a 3 4&｜S: 2 4
  funkC: {
    unit: 8,
    steps:
      "hihat+kick/16 kick/16 hihat hihat+snare hihat+kick/16 kick/16 " +
      "hihat+kick hihat hihat+snare hihat+kick",
    fill: ["fill2B", "fill2C", "fill3B", "fill3C", "fill4C", "fill4D"],
  },
  // K: 1 2& 2a 3e 3& 4a｜S: 2 4
  funkD: {
    unit: 16,
    steps:
      "hihat+kick/8 hihat/8 hihat+snare/8 hihat+kick kick " +
      "hihat kick hihat+kick/8 hihat+snare/8 hihat kick",
    fill: ["fill2B", "fill2C", "fill3B", "fill3C", "fill4C", "fill4D"],
  },

  // ─── disco：四踩：kick 每拍都打，hi-hat（或開鈸）在反拍 ───
  // K: 1 2 3 4｜S: 2 4
  discoA: {
    unit: 8,
    steps: "kick ride kick+snare ride " + "kick ride kick+snare ride",
    fill: ["fill2B", "fill2C", "fill4A", "fill4B", "fill4C"],
  },
  // K: 1 2 3 4｜S: 2 4｜鬼音 S: 2a 3e 4a
  discoB: {
    unit: 16,
    steps:
      "kick/8 ride/8 kick+snare/8 ride (snare) " +
      "kick (snare) ride/8 kick+snare/8 ride (snare)",
    fill: ["fill2B", "fill2C", "fill4A", "fill4B", "fill4C"],
  },
  // K: 1 2 3 4｜S: 2 4｜P: 1 2 3 4｜開鈸在每拍的 &
  discoC: {
    unit: 8,
    steps:
      "kick+pedal hihat_open kick+snare+pedal hihat_open " +
      "kick+pedal hihat_open kick+snare+pedal hihat_open",
    fill: ["fill2B", "fill2C", "fill4A", "fill4B", "fill4C"],
  },
  // K: 1 2 3 4｜S: 1e 2 2a 3e 4｜P: 1 2 3 4｜開鈸在每拍的 &
  discoD: {
    unit: 16,
    steps:
      "kick+pedal snare hihat_open/8 kick+snare+pedal/8 hihat_open snare " +
      "kick+pedal snare hihat_open/8 kick+snare+pedal/8 hihat_open/8",
    fill: ["fill2B", "fill2C", "fill4A", "fill4B", "fill4C"],
  },

  // ─── ghost：8 分 hi-hat 加 snare 鬼音 ───
  // K: 1｜S: 2 4｜鬼音 S: 2a 3e
  ghostA: {
    unit: 8,
    steps:
      "hihat+kick hihat hihat+snare hihat/16 (snare)/16 " +
      "hihat/16 (snare)/16 hihat hihat+snare hihat",
    fill: ["fill1B", "fill2C", "fill2F", "fill3A", "fill3B"],
  },
  // K: 1 1& 3& 4&｜S: 2 4｜鬼音 S: 2a 3e
  ghostB: {
    unit: 8,
    steps:
      "hihat+kick hihat+kick hihat+snare hihat/16 (snare)/16 " +
      "hihat/16 (snare)/16 hihat+kick hihat+snare hihat+kick",
    fill: ["fill1B", "fill2C", "fill2F", "fill3A", "fill3B"],
  },
  // K: 1 1& 2& 3& 4&｜S: 2 4｜鬼音 S: 2a 3e
  ghostC: {
    unit: 8,
    steps:
      "hihat+kick hihat+kick hihat+snare hihat+kick/16 (snare)/16 " +
      "hihat/16 (snare)/16 hihat+kick hihat+snare hihat+kick",
    fill: ["fill1B", "fill2C", "fill2F", "fill3A", "fill3B"],
  },
  // K: 1 1a 2a 3&｜S: 2 4｜鬼音 S: 3e
  ghostD: {
    unit: 16,
    steps:
      "hihat+kick/8 hihat kick hihat+snare/8 hihat kick " +
      "hihat (snare) hihat+kick/8 hihat+snare/8 hihat/8",
    fill: ["fill1B", "fill2C", "fill2F", "fill3A", "fill3B"],
  },

  // ─── quarter：4 分為主，兩小節一輪（一輪 8 拍）───
  // 快歌用的節奏：密度低（每拍 1.25–2 擊），同樣的手速音樂速度比 rock8 高。
  // 手比平常快時由 selector 換進來（與 16 分組同屬快檔）。
  // hi-hat 的組（B／C／D）標 openRound：開鈸以一輪（兩小節）為單位，整輪全開（快歌的開鈸打法）。
  // 註解的拍點以「｜」分兩小節。
  // 沒有 hi-hat。K: 1 2& 3&｜1 3 3&　S: 2 4｜2 4
  quarterA: {
    unit: 8,
    steps: "kick/4 snare kick rest kick snare/4 " + "kick/4 snare/4 kick kick snare/4",
    fill: ["fill2A", "fill2G", "fill3A", "fill4A"],
  },
  // 4 分 hi-hat。K: 1 3 4&｜1& 3 3&　S: 2 4｜2 2& 4
  quarterB: {
    unit: 8,
    openRound: true,
    steps:
      "hihat+kick/4 hihat+snare/4 hihat+kick/4 hihat+snare kick " +
      "hihat kick hihat+snare snare hihat+kick kick hihat+snare/4",
    fill: ["fill2A", "fill2G", "fill3A", "fill4A"],
  },
  // 4 分 hi-hat。K: 1 2 2&｜1 2 2& 3 4　S: 3 4&｜1& 3 4&
  quarterC: {
    unit: 8,
    openRound: true,
    steps:
      "hihat+kick/4 hihat+kick kick hihat+snare/4 hihat snare " +
      "hihat+kick snare hihat+kick kick hihat+snare+kick/4 hihat+kick snare",
    fill: ["fill2A", "fill2G", "fill3A", "fill4A"],
  },
  // hi-hat+snare 與 kick 交錯，每個 8 分都有音（密度 2，與 rock8 同一檔）。
  // hi-hat+S: 1 2& 4｜1& 3 4　K: 1& 2 3 3& 4&｜1 2 2& 3& 4&
  quarterD: {
    unit: 8,
    openRound: true,
    steps:
      "hihat+snare kick kick hihat+snare kick kick hihat+snare kick " +
      "kick hihat+snare kick kick hihat+snare kick hihat+snare kick",
    fill: ["fill2A", "fill2G", "fill3A", "fill4A"],
  },

  // ─── hat16：16 分 hi-hat ───
  // K: 1 3｜S: 2 4
  hat16A: {
    unit: 16,
    steps:
      "hihat+kick hihat hihat hihat hihat+snare hihat hihat hihat " +
      "hihat+kick hihat hihat hihat hihat+snare hihat hihat hihat",
    fill: ["fill1C", "fill2F", "fill3C", "fill4C", "fill4D"],
  },
  // K: 1 2a 3｜S: 2 4
  hat16B: {
    unit: 16,
    steps:
      "hihat+kick hihat hihat hihat hihat+snare hihat hihat hihat+kick " +
      "hihat+kick hihat hihat hihat hihat+snare hihat hihat hihat",
    fill: ["fill1C", "fill2F", "fill3C", "fill4C", "fill4D"],
  },
  // K: 1 3 3&｜S: 2 4
  hat16C: {
    unit: 16,
    steps:
      "hihat+kick hihat hihat hihat hihat+snare hihat hihat hihat " +
      "hihat+kick hihat hihat+kick hihat hihat+snare hihat hihat hihat",
    fill: ["fill1C", "fill2F", "fill3C", "fill4C", "fill4D"],
  },
  // hi-hat 與鬼音交替（第 4 拍沒有 hi-hat）。K: 1 2 3 4｜S: 4｜鬼音 S: 每拍的 e a
  hat16D: {
    unit: 16,
    steps:
      "hihat+kick (snare) hihat (snare) hihat+kick (snare) hihat (snare) " +
      "hihat+kick (snare) hihat (snare) kick+snare (snare) hihat (snare)",
    fill: ["fill1C", "fill2F", "fill3C", "fill4C", "fill4D"],
  },
};

export const FILLS = {
  // ─── 過門 1 拍：前面由 groove 繼續打 ───
  // 前 3 拍繼續打 groove。S: 4 4e 4&
  fill1A: {
    unit: 16,
    steps: "rest/2. snare snare snare/8",
  },
  // 前 3 拍繼續打 groove。S: 4 4e 4a｜T1: 4&
  fill1B: {
    unit: 16,
    steps: "rest/2. snare snare tom1 snare",
  },
  // 前 3 拍繼續打 groove。S: 4｜T1: 4e｜F: 4& 4a
  fill1C: {
    unit: 16,
    steps: "rest/2. snare tom1 floor floor",
  },
  // ─── 過門 2 拍：前面由 groove 繼續打 ───
  // 前 2 拍繼續打 groove。K: 3 4｜S: 3 3e 3& 4｜F: 4e 4&
  fill2A: {
    unit: 16,
    steps: "rest/2 kick+snare snare snare/8 kick+snare floor floor/8",
  },
  // 前 2 拍繼續打 groove。第 3 拍開鈸+K，3e 踏鈸收｜T2: 4 4e｜F: 4& 4a
  fill2B: {
    unit: 16,
    steps: "rest/2 hihat_open+kick pedal/8. tom2 tom2 floor floor",
  },
  // 前 2 拍繼續打 groove。第 3 拍開鈸｜T1: 3& 3a｜鬼音 S: 4 4a｜F: 4e 4&
  fill2C: {
    unit: 16,
    steps: "rest/2 hihat_open/8 tom1 tom1 (snare) floor floor (snare)",
  },
  // 前 2 拍繼續打 groove。8 分三連 S: 3 3t 3l｜T2: 4 4t｜S: 4l
  fill2D: {
    unit: "8t",
    steps: "rest/2 snare ~snare ~snare tom2 ~tom2 ~snare",
  },
  // 前 2 拍繼續打 groove。8 分三連 ride: 3 3t 3l｜第 4 拍 ride bell
  fill2E: {
    unit: "8t",
    steps: "rest/2 ride ~ride ~ride ride_bell/4",
  },
  // 前 2 拍繼續打 groove。K: 3 4｜S: 3 3e｜T1: 3& 3a｜T2: 4 4e｜F: 4& 4a
  fill2F: {
    unit: 16,
    steps: "rest/2 kick+snare snare tom1 tom1 kick+tom2 tom2 floor floor",
  },
  // 前 2 拍繼續打 groove。K: 3｜S: 3 3a｜T1: 3e｜T2: 3&｜第 4 拍 crash+K+F
  fill2G: {
    unit: 16,
    steps: "rest/2 kick+snare tom1 tom2 snare crash+kick+floor/4",
  },
  // shuffle 用（ride 三連、自動音）。前 2 拍繼續打 groove。K: 3｜S: 3l 4 4t 4l｜P: 4 → 下一段第 1 拍 crash
  fill2H: {
    unit: "8t",
    steps: "rest/2 ride+kick/4t ~snare snare+pedal ~snare ~snare",
  },

  // ─── 過門 3 拍：前面由 groove 繼續打 ───
  // 第 1 拍繼續打 groove。S: 2 3｜K: 2& 4 4&｜F: 3& 3a｜開鈸: 4&（下一段第 1 拍 crash 收）
  fill3A: {
    unit: 16,
    steps: "rest/4 snare/8 kick/8 snare/8 floor floor kick/8 hihat_open+kick/8",
  },
  // 第 1 拍繼續打 groove。第 2 拍 crash+S、2& hi-hat、2a S｜T1+K: 3｜S: 3e 3& 3a｜K+S: 4｜S: 4e｜F: 4&
  fill3B: {
    unit: 16,
    steps:
      "rest/4 crash+snare/8 hihat snare tom1+kick snare snare snare kick+snare snare floor/8",
  },
  // 前 1 拍半繼續打 groove。K: 2& 2a｜6 連音 S: 第 3 拍前 5 下｜T1: 第 3 拍最後 1 下、第 4 拍前 3 下｜T2、F、F: 第 4 拍後 3 下
  fill3C: {
    unit: 16,
    steps:
      "rest/4 rest/8 kick kick snare/16t snare/16t snare/16t snare/16t snare/16t tom1/16t tom1/16t tom1/16t tom1/16t tom2/16t floor/16t floor/16t",
  },
  // shuffle 用（ride 三連、自動音）。第 1 拍繼續打 groove。S: 2l 3 3t 3l｜第 4 拍 crash+kick+pedal（已有 crash，下一段第一擊不再加）
  fill3D: {
    unit: "8t",
    steps: "rest/4 ride+pedal/4t ~snare snare ~snare ~snare crash+kick+pedal/4",
  },

  // ─── 過門 4 拍：整小節都是過門 ───
  // 整小節。crash+K: 1 1a 2& 3（3 為四分）
  fill4A: {
    unit: 8,
    steps: "crash+kick/8. crash+kick/16 rest crash+kick crash+kick/4 rest/4",
  },
  // 整小節。第 1 拍 crash+K、第 2 拍開鈸（四分）｜S: 3 3e 3a 4e 4a｜P: 3
  fill4B: {
    unit: 16,
    steps:
      "crash+kick/4 hihat_open/4 snare+pedal snare rest snare rest snare rest snare",
  },
  // 整小節 16 分。K: 1 2 3 4｜開鈸: 1 2& 3&｜其餘 16 分都是 S
  fill4C: {
    unit: 16,
    steps:
      "hihat_open+kick snare snare snare snare+kick snare hihat_open snare snare+kick snare hihat_open snare snare+kick snare snare snare",
  },
  // 整小節。第 1 拍 crash+K+S、T1: 1& 1a｜T2: 2e 2&｜F flam: 3 3&｜S: 4 4e 4& 4a
  fill4D: {
    unit: 16,
    steps:
      "crash+kick+snare/8 tom1 tom1 rest tom2 tom2/8 {floor}/8 {floor}/8 snare snare snare snare",
  },
};
