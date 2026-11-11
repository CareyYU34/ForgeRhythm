/**
 * grooveMode/grooveSelector.js
 *
 * 職責：換段時，從候選 groove 裡挑下一個。純計算，沒有時鐘。
 * 候選已由上一層去掉 special（特殊節奏由 freePlayRouter 的計時器決定，不經過這裡）。
 *
 * ═══ 原則：比平常快 → 快歌或密的節奏 ═══
 *
 * 「比平常快／慢」由 tempoTracker 的狀態決定（平常／加快／放慢，含遲滯與鎖存，見 tempoTracker.js），
 * 這裡不看當下的倍數。「平常」是使用者自己的手速中位數，會跟著人變：
 * 每個人舒適的手速差很多，固定門檻（例如每秒 6 下才上 16 分）有人一輩子碰不到；
 * 用自己的中位數當中心，區間自動貼合每個人。
 *
 * ⚠ 加快一直維持，MAX_HOLD_MS 後「快」就變成「平常」，回到中間那檔。
 *   這是刻意的 —— 獎勵的是「比剛才快／慢」的變化，不是絕對速度。
 *
 * ═══ 兩檔（依密度＝每拍幾擊，由譜算出）═══
 *
 *     加快（faster） → 快檔：4 分組（密度 < TIER_QUARTER_MAX，音樂速度快 = 快歌）
 *                            與 16 分組（密度 ≥ TIER_DENSE_MIN，音樂中速但很密）
 *     其餘           → 中檔：8 分、rock16、ghost、disco……
 *
 * ⚠ 4 分不能放「慢」：真實的音樂裡 4 分為主的節奏是快歌在用的（龐克、快板搖滾、two-beat），
 *   慢歌反而打 16 分。手慢下來就留在中檔（慢速 8 beat）；放慢（slower）狀態下，
 *   計時到的 shuffle 才會出現（freePlayRouter 判斷，不經過這裡）。
 * ⚠ 16 分也不能放慢：手速只有平常的 0.85 倍時，hat16 換算只剩 40 BPM 左右。
 * 快檔裡 4 分與 16 分密度差很遠，檔內只往相近密度走，所以進了哪一組就留在那一組；
 * 下次再進快檔，多久沒出現（age）決定換哪一組。音樂速度不會在 4 分與 16 分之間來回大跳。
 *
 * ═══ 檔內怎麼挑 ═══
 *
 * 手速不變、換成密度 d 的 groove，音樂速度（BPM）＝ 60 × 手速 ÷ d。
 * 音樂速度是系統端的事（畫面只顯示手速），但相鄰兩段差太多聽起來會跳，所以：
 *   · 同一檔內 → 密度最接近的（同密度的其他 groove；沒有的話往最近的鄰居），
 *               與最接近的相差 TOLERANCE 內都算（相鄰的密度慢慢走，BPM 每次最多差 13%）
 *   · 換檔     → 目標檔的全部
 *   · 都排除 BPM 超出 [BPM_MIN, BPM_MAX] 的（安全範圍：避免換算出太離譜的速度）
 *   合格的裡面依「多久沒出現」加權隨機挑（pickStale），目前這個不會連續兩段。
 *   沒有合格的 → 退回：安全範圍內的同一檔 → 安全範圍內的全部 → 最接近範圍中心的那一檔。
 *
 * ═══ 量不到速度 ═══
 *
 * 手速為 null 或狀態為量測中（剛開始打）→ 在目前同密度的候選中挑
 * （密度不變，使用者照原本的手速打就對得上）；沒有同密度的（例如從 special 回來）→ 全部候選。
 *
 * ═══ 多久沒出現（age）═══
 *
 * age = 隔了幾次沒被選到（引擎計算；從沒出現過的最大，目前這個 = 0）。
 * 權重 = age²：越久沒出現越容易被選到，但不是固定順序，仍保留隨機。
 * 目前這個權重 0 → 有別的選擇時不會連續兩段一樣。
 */

import { TEMPO_STATE_LABEL } from "./tempoTracker.js";

/** 密度低於這個算 4 分組（1.25–1.625；quarterD 每個 8 分都有音，密度 2 算中檔） */
const TIER_QUARTER_MAX = 1.9;
/** 密度達到這個算 16 分組（funkB 3、funkA 3.25、hat16 4） */
const TIER_DENSE_MIN = 2.9;

/** 音樂速度的安全範圍：換算超出就不挑 */
export const BPM_MIN = 50;
export const BPM_MAX = 200;

/**
 * 同一檔內，密度相差在這個倍數內才換（對數）。
 * ln(1.13)：中檔相鄰兩檔密度最多差 12.5%（2.0 → 2.25），13% 讓每一檔都能往鄰檔走。
 */
export const TOLERANCE = Math.log(1.13);

/** 密度相差在這個比例內視為同一檔 */
const SAME_DENSITY = Math.log(1.05);

/** 安全範圍中心（幾何平均）：全部超出範圍時挑最接近的 */
const BPM_CENTER = Math.sqrt(BPM_MIN * BPM_MAX);

const densityGap = (a, b) => Math.abs(Math.log(a / b));
export const inRange = (bpm) => bpm >= BPM_MIN && bpm <= BPM_MAX;

const TIER_LABEL = { mid: "中檔", fast: "快檔" };
const tierOf = (density) => (density < TIER_QUARTER_MAX || density >= TIER_DENSE_MIN ? "fast" : "mid");

/**
 * 依 age 加權隨機挑一個（權重 age²，見上方說明）。
 * 全部權重都是 0（只剩目前這個）→ 平均隨機。
 * @param {Array<{age: number}>} xs
 */
export function pickStale(xs) {
  const weights = xs.map((x) => x.age * x.age);
  const total = weights.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return xs[Math.floor(Math.random() * xs.length)];
  let r = Math.random() * total;
  for (let i = 0; i < xs.length; i++) {
    r -= weights[i];
    if (r < 0) return xs[i];
  }
  return xs[xs.length - 1];
}

/**
 * @param {Object}   p
 * @param {Array<{id: string, density: number, age: number}>} p.candidates
 *                                    可以換過去的 groove（不含 special），age 見上方說明
 * @param {number}   p.currentDensity  目前 groove 的密度
 * @param {?number}  p.hitRate         目前手速（每秒幾擊）
 * @param {Object}   p.tempo           tempoTracker.getTempoState()：{ state, ratio }（ratio 只給 reason 用）
 * @returns {{ id: string, impliedBpm: ?number, tier: ?string, reason: string }}
 *   impliedBpm = 換過去後的音樂速度；tier = 目標檔（"mid"｜"fast"）
 */
export function selectNextGroove({ candidates, currentDensity, hitRate, tempo }) {
  if (candidates.length === 1) {
    return { id: candidates[0].id, impliedBpm: null, tier: null, reason: "只有一個候選" };
  }
  if (!hitRate || tempo.state === "measuring") {
    const same = candidates.filter((c) => densityGap(c.density, currentDensity) < SAME_DENSITY);
    const { id } = pickStale(same.length ? same : candidates);
    return { id, impliedBpm: null, tier: null, reason: same.length ? "量不到速度，同密度" : "量不到速度，全部候選" };
  }

  const ratio = tempo.ratio;
  const tier = tempo.state === "faster" ? "fast" : "mid";
  const stay = tier === tierOf(currentDensity);
  const scored = candidates.map((c) => {
    const impliedBpm = (60 * hitRate) / c.density;
    return { ...c, impliedBpm, tier: tierOf(c.density), err: Math.abs(Math.log(impliedBpm / BPM_CENTER)) };
  });
  const ok = scored.filter((c) => inRange(c.impliedBpm));
  const inTier = ok.filter((c) => c.tier === tier);

  let pool = inTier;
  if (stay) {
    const others = inTier.filter((c) => c.age > 0);
    const nearest = Math.min(...others.map((c) => densityGap(c.density, currentDensity)));
    pool = others.filter((c) => densityGap(c.density, currentDensity) <= nearest + TOLERANCE);
  }
  const ratioText = ratio === null ? "-" : ratio.toFixed(2);
  let reason =
    `${TIER_LABEL[tier]}（${TEMPO_STATE_LABEL[tempo.state]}，手速為平常的 ${ratioText} 倍）` +
    (stay ? "，相近密度" : "，換檔");
  if (!pool.length && inTier.length) {
    pool = inTier;
    reason += " → 相近密度沒有，檔內全部";
  }
  if (!pool.length) {
    const sameTier = ok.filter((c) => c.tier === tierOf(currentDensity));
    pool = sameTier.length ? sameTier : ok;
    reason += ` → ${TIER_LABEL[tier]}都超出 BPM 範圍，${sameTier.length ? "留在原檔" : "範圍內全部"}`;
  }
  if (!pool.length) {
    const bestErr = Math.min(...scored.map((c) => c.err));
    pool = scored.filter((c) => c.err <= bestErr + TOLERANCE);
    reason += " → 全部超出範圍，最接近中心";
  }

  const picked = pickStale(pool);
  return { id: picked.id, impliedBpm: picked.impliedBpm, tier, reason };
}
