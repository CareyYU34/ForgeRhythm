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
 *        ⚠ groove／過門的第一個音不能是自動音；rest 與 land 不能加 "~"。
 *        ⚠ 自動音不算擊數：rate 與 selector 用的密度都只算要打的那幾擊。
 *
 * 開鈸：反拍的 hihat 會隨機變成 hihat_open（鬼音除外，規則見 hatOpener.js），譜上不用寫。
 *        想固定開鈸就直接寫 "hihat_open"。hihat 或 pedal 響起時會截斷還在響的開鈸，
 *        hihat 截斷時會自動疊上踏鈸聲，譜上不用寫 pedal。
 *
 * 休止：寫 "rest"，時值寫法同音名（"rest/16"、"rest/8."，沒寫 = unit）。
 *        rest 不是一擊、不用打：它的長度併進前一擊，只影響 BPM 換算與密度。
 *        所以 "kick/16 rest/8" 與 "kick/8." 完全等價，照譜面習慣寫即可。
 *        ⚠ groove 開頭的 rest 併進一輪的最後一擊；過門開頭的 rest 由 groove 接手（見 FILLS 的 steps）。
 *        ⚠ 過門的總拍數（含 rest）決定它佔掉幾輪（見 GROOVES 的 loops），要補滿小節；
 *          過門結尾的 rest 就是用來補滿的，不會等待：fill 手速只看每秒幾擊，
 *          下一個 groove 在過門最後一擊當下就決定，照樣在使用者下一擊接上。
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
 *   loops  這一段總共幾輪，過門（含開頭由 groove 打的部分）算在裡面；給陣列則每次進入此 groove 時隨機挑一個
 *          例如一輪 4 拍、過門 4 拍：loops 4 = 3 輪 + 過門。
 *          一輪 2 拍、過門 4 拍：loops 4 = 2 輪 + 過門（過門佔 2 輪的長度）。
 *          ⚠ 過門佔滿 loops 時整段只有過門，groove 不會完整出現一輪。
 *   fill   過門 id；給陣列則隨機挑一個
 *   next   過門結束後換到哪個 groove；給陣列則隨機挑一個
 *          （可以包含自己 = 過門後回到同一個 groove）
 *
 * FILLS 每一項：
 *   unit   最小單位是幾分音符，也是 steps 時值的預設值
 *   feel   這個過門容易讓人打擊 "faster" 變快／"same" 維持／"slower" 變慢
 *          （銜接下一個 groove 時的判斷參考，不是強制變速）
 *   steps  過門內容，只播一次
 *          開頭的 rest = 這幾拍繼續打 groove，過門從第一個音才開始（照譜面寫半小節過門）：
 *          "rest/2 snare snare" → groove 打前 2 拍，第 3 拍起換成過門。
 *          是取代不是疊加：過門開始後，groove 那幾拍的音（含 hihat）都不響。
 *          ⚠ groove 跨過界線的那一擊照響；界線之後的音與自動音不響。
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
export const START_GROOVE = [
  "tripletBackbeat",
  "tripletHalfTime",
  "tripletSync",
  "tripletGhost",
];
 
/*
 * 註解的拍點記法：1 e & a = 一拍裡的四個 16 分位置。
 *   K = kick、S = snare，例如「K: 1 1a 2a」= kick 落在 1、1 的 a、2 的 a。
 * 三連音：1 t l = 一拍裡的三個 8 分三連位置（1 trip let），例如「K: 3l」= 3 的 let。
 *   P = hi-hat 踏板（pedal）。
 *
 * ⚠ 三連全打的 groove 不要放進 START_GROOVE：tempoTracker 第一次取基點只會 ÷2 折，
 *   三連與直拍差 3:2，折不回來。（每拍 1 擊、其餘自動音的不受影響。）
 *
 * ═══ 三連 shuffle 組 ═══
 * 使用者每拍只打一下（拍點），拍內的三連音都是自動音 → 四個 groove 密度相同（每拍 1 擊），
 * 手速不變就能互換。fill、next 都共用，由 selector 在同密度中隨機。
 */
const SHUFFLE_FILLS = ["shuffleHalfBar", "shuffleCrash"];
const SHUFFLE_NEXT = ["tripletBackbeat", "tripletHalfTime", "tripletSync", "tripletGhost"];
/** 一段 4 或 8 小節（含過門那一小節） */
const SHUFFLE_LOOPS = [4];

export const GROOVES = {
  // Ride 全程三連 shuffle。K: 1 3｜S: 2 4｜P: 2 4
  tripletBackbeat: {
    unit: "8t",
    rate: 1,
    steps:
      "ride+kick/4 ride+snare+pedal/4t ~ride " +
      "ride+kick/4 ride+snare+pedal/4t ~ride",
    loops: SHUFFLE_LOOPS,
    fill: SHUFFLE_FILLS,
    next: SHUFFLE_NEXT,
  },
  // Half-time：snare 落在第 3 拍。K: 1｜S: 3｜P: 3
  tripletHalfTime: {
    unit: "8t",
    rate: 1,
    steps:
      "ride+kick/4 ride/4t ~ride " +
      "ride+snare+pedal/4 ride/4t ~ride",
    loops: SHUFFLE_LOOPS,
    fill: SHUFFLE_FILLS,
    next: SHUFFLE_NEXT,
  },
  // 切分：第 1 拍沒有 kick。K: 2l 4l｜S: 1l 3｜P: 2 4
  tripletSync: {
    unit: "8t",
    rate: 1,
    steps:
      "ride/4t ~snare ride+pedal/4t ~ride+kick " +
      "ride+snare/4 ride+pedal/4t ~ride+kick",
    loops: SHUFFLE_LOOPS,
    fill: SHUFFLE_FILLS,
    next: SHUFFLE_NEXT,
  },
  // 三連全響，每拍中間是鬼音。K: 1 2l 4l｜S: 3｜鬼音 S: 每拍的 t
  tripletGhost: {
    unit: "8t",
    rate: 1,
    steps:
      "ride+kick ~(snare) ~ride ride ~(snare) ~ride+kick " +
      "ride+snare ~(snare) ~ride ride ~(snare) ~ride+kick",
    loops: SHUFFLE_LOOPS,
    fill: SHUFFLE_FILLS,
    next: SHUFFLE_NEXT,
  },
};

export const FILLS = {
  // 前 2 拍繼續打 groove。K: 3｜S: 3l 4 4t 4l｜P: 4 → 下一段第 1 拍 crash
  shuffleHalfBar: {
    unit: "8t",
    feel: "same",
    steps: "rest/2 ride+kick/4t ~snare snare+pedal ~snare ~snare",
  },
  // 第 1 拍繼續打 groove。S: 2l 3 3t 3l｜第 4 拍 crash+kick+pedal（已有 crash，不用 land）
  shuffleCrash: {
    unit: "8t",
    feel: "same",
    steps: "rest/4 ride+pedal/4t ~snare snare ~snare ~snare crash+kick+pedal/4",
  },
};
