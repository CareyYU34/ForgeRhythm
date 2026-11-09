/**
 * grooveMode/grooveSelector.js
 *
 * 職責：換段時，從候選 groove 裡挑下一個。純計算，沒有時鐘。
 * 候選已由上一層去掉 special（特殊節奏由 freePlayRouter 的計時器決定，不經過這裡）。
 *
 * ═══ 原則：手速就是速度 ═══
 *
 * BPM 跟著使用者的手走：手快 BPM 就上、手慢就下。selector 不把 BPM 拉回某個基準，
 * 只在 BPM 超出 [BPM_MIN, BPM_MAX] 時換密度，把它帶回範圍內。
 *
 * ⚠ 舊做法（挑「換算 BPM 最接近基點」的 groove）會在手變快時換更密的 groove 抵銷掉，
 *   實測「手快了 BPM 卻不上去」，耳朵聽到的速度感也一樣 —— 不要改回去。
 *
 * ═══ 規則 ═══
 *
 * 手速不變、換成密度 d 的 groove，BPM 會變成
 *
 *     implied = 目前 BPM × 目前密度 ÷ d
 *
 *   · 目前 BPM 在範圍內 → 合格 = 同密度的其他 groove（BPM 不跳，只換花樣）；
 *     同密度沒有別的（funkA、funkB 這類單獨一檔）→ 密度相差 TOLERANCE 內、且 implied 也在範圍內的
 *     ⚠ 不能一律開放鄰檔：每次換段都可能往鄰檔移一格，加上 age 偏好沒去過的檔，
 *       密度會隨機漂移，每移一格 BPM 跳 10% 左右。實測手速 ×2.2 時 BPM 只 90 → 150，
 *       又變回「手快了 BPM 上不太去」。
 *   · 超出範圍 → 合格 = implied 在範圍內、且與範圍中心（幾何平均）誤差不超過
 *     「最小誤差 + TOLERANCE」的；全部都超出範圍則挑最接近中心的那一檔
 *     （回到中心附近，不會貼著邊界來回換）
 *   從合格的裡面依「多久沒出現」加權隨機挑（pickStale）。
 *
 * ═══ 量不到速度 ═══
 *
 * 目前 BPM 為 null（剛開始、間隔不足一小節）→ 在目前同密度的候選中挑
 * （密度不變，使用者照原本的手速打就對得上）；沒有同密度的（例如從 special 回來）→ 全部候選。
 *
 * ═══ 多久沒出現（age）═══
 *
 * age = 隔了幾次沒被選到（引擎計算；從沒出現過的最大，目前這個 = 0）。
 * 權重 = age²：越久沒出現越容易被選到，但不是固定順序，仍保留隨機。
 * 目前這個權重 0 → 有別的選擇時不會連續兩段一樣。
 */

/** BPM 的舒適範圍：超出才換密度 */
export const BPM_MIN = 60;
export const BPM_MAX = 180;

/**
 * 密度相差在這個倍數內算「相近」（對數）。
 * ln(1.13)：目前相鄰兩檔密度最多差 12.5%（2.0 → 2.25），13% 讓每一檔都能與鄰檔輪替；
 * hat16（4.0）與下一檔差 23%，要 BPM 超出範圍才會換過去或換出來。
 */
export const TOLERANCE = Math.log(1.13);

/** 密度相差在這個比例內視為同一檔 */
const SAME_DENSITY = Math.log(1.05);

/** 範圍中心（幾何平均）：超出範圍時往這裡拉 */
const BPM_CENTER = Math.sqrt(BPM_MIN * BPM_MAX);

const densityGap = (a, b) => Math.abs(Math.log(a / b));
const inRange = (bpm) => bpm >= BPM_MIN && bpm <= BPM_MAX;

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
 * @param {?number}  p.currentBpm      目前 BPM（這段 groove 結尾一小節）
 * @returns {{ id: string, impliedBpm: ?number, reason: string }}
 */
export function selectNextGroove({ candidates, currentDensity, currentBpm }) {
  if (candidates.length === 1) {
    return { id: candidates[0].id, impliedBpm: null, reason: "只有一個候選" };
  }
  if (!currentBpm) {
    const same = candidates.filter((c) => densityGap(c.density, currentDensity) < SAME_DENSITY);
    const { id } = pickStale(same.length ? same : candidates);
    return { id, impliedBpm: null, reason: same.length ? "量不到速度，同密度" : "量不到速度，全部候選" };
  }

  const scored = candidates.map((c) => {
    const impliedBpm = (currentBpm * currentDensity) / c.density;
    return { ...c, impliedBpm, err: Math.abs(Math.log(impliedBpm / BPM_CENTER)) };
  });

  let pool = [];
  let reason = "範圍內，同密度";
  if (inRange(currentBpm)) {
    pool = scored.filter((c) => densityGap(c.density, currentDensity) < SAME_DENSITY && c.age > 0);
    if (!pool.length) {
      pool = scored.filter((c) => densityGap(c.density, currentDensity) <= TOLERANCE && inRange(c.impliedBpm));
      reason = "範圍內，同密度只有自己 → 相近密度";
    }
  }
  if (!pool.length) {
    const ok = scored.filter((c) => inRange(c.impliedBpm));
    const base = ok.length ? ok : scored;
    const bestErr = Math.min(...base.map((c) => c.err));
    pool = base.filter((c) => c.err <= bestErr + TOLERANCE);
    reason = currentBpm > BPM_MAX ? "太快 → 換更密" : currentBpm < BPM_MIN ? "太慢 → 換更疏" : "相近密度都超出範圍";
  }

  const picked = pickStale(pool);
  return { id: picked.id, impliedBpm: picked.impliedBpm, reason };
}
