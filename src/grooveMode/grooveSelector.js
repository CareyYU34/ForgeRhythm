/**
 * grooveMode/grooveSelector.js
 *
 * 職責：fill 結束時，依使用者的速度從候選 groove 裡挑下一個。純計算，沒有時鐘。
 *
 * ═══ 規則 ═══
 *
 * 用 fill 期間的手速 H（每秒幾擊）套進每個候選 groove 的密度 d（每拍幾擊），
 * 算出「接這個 groove 會是多少 BPM」：
 *
 *     implied = 60 × H ÷ d
 *
 * 誤差 = |ln(implied ÷ 基點 BPM)|（用對數比，快一倍與慢一半的誤差一樣大）。
 * 挑誤差最小的；密度相同的 groove 誤差相同 → 在其中隨機，保留變化。
 *
 * ═══ 遲滯 ═══
 *
 * 候選中若有「與目前 groove 同密度」的，要換到別的密度，誤差必須好過它
 * 超過 margin 才換 —— 避免速度在兩檔中間時來回跳。margin 依 fill 的 feel 調整：
 *   feel 與換的方向一致（faster → 換更密、slower → 換更疏）→ MARGIN_ALIGNED（容易換）
 *   feel 為 "same"                                         → MARGIN_SAME（不容易換）
 *   其他                                                   → MARGIN_DEFAULT
 * feel 只是先驗：使用者的手速沒變，標籤再怎麼說也不會換。
 *
 * ⚠ 遲滯只在「留下來本身還可以」（同密度的誤差 < STAY_OK）時生效。
 *   留下來已經偏很多時，只要有更好的就換 —— 否則允許清單一次跳不到目標密度時
 *   （例如 8 分 groove 的 next 最密只到切分 16 分），會卡在原地；
 *   現在則是每次 fill 往目標移一檔，逐步變密／變疏。
 *
 * ═══ 量不到速度 ═══
 *
 * 基點或手速為 null（剛開始、fill 太短）→ 在候選中隨機（＝舊行為）。
 */

/** 誤差差距門檻（對數）。ln(1.15) ≈ 換過去要好 15% 以上 */
export const MARGIN_DEFAULT = Math.log(1.15);
export const MARGIN_ALIGNED = Math.log(1.07);
export const MARGIN_SAME = Math.log(1.25);

/** 留在同密度的誤差小於這個值，才套用遲滯 */
export const STAY_OK = Math.log(1.3);

/** 密度相差在這個比例內視為同一檔 */
const SAME_DENSITY = Math.log(1.05);

const pickRandom = (xs) => xs[Math.floor(Math.random() * xs.length)];

/**
 * @param {Object}   p
 * @param {Array<{id: string, density: number}>} p.candidates  允許的下一個 groove
 * @param {number}   p.currentDensity  fill 之前那個 groove 的密度
 * @param {string}   p.feel            fill 的 feel："faster"｜"same"｜"slower"
 * @param {?number}  p.baselineBpm     基點 BPM
 * @param {?number}  p.hitRate         fill 期間手速（每秒幾擊）
 * @returns {{ id: string, impliedBpm: ?number, reason: string }}
 */
export function selectNextGroove({ candidates, currentDensity, feel, baselineBpm, hitRate }) {
  if (candidates.length === 1) {
    return { id: candidates[0].id, impliedBpm: null, reason: "只有一個候選" };
  }
  if (!baselineBpm || !hitRate) {
    return { id: pickRandom(candidates).id, impliedBpm: null, reason: "量不到速度，隨機" };
  }

  const scored = candidates.map((c) => {
    const impliedBpm = (60 * hitRate) / c.density;
    return { ...c, impliedBpm, err: Math.abs(Math.log(impliedBpm / baselineBpm)) };
  });
  const sameDensity = (a, b) => Math.abs(Math.log(a / b)) < SAME_DENSITY;
  const bestOf = (xs) => xs.reduce((a, b) => (b.err < a.err ? b : a));

  const best = bestOf(scored);
  const stay = scored.filter((c) => sameDensity(c.density, currentDensity));

  let target = best;
  let reason = "最接近基點";
  if (stay.length && !sameDensity(best.density, currentDensity)) {
    const denser = best.density > currentDensity;
    const aligned = (denser && feel === "faster") || (!denser && feel === "slower");
    const margin = aligned ? MARGIN_ALIGNED : feel === "same" ? MARGIN_SAME : MARGIN_DEFAULT;
    const bestStay = bestOf(stay);
    if (bestStay.err < STAY_OK && best.err + margin >= bestStay.err) {
      target = bestStay;
      reason = "差距不夠大，維持同密度";
    } else {
      reason = denser ? "變快 → 換更密" : "變慢 → 換更疏";
    }
  }

  // 與 target 同密度的候選隨機挑一個
  const pickedFrom = scored.filter((c) => sameDensity(c.density, target.density));
  const picked = pickRandom(pickedFrom);
  return { id: picked.id, impliedBpm: picked.impliedBpm, reason };
}
