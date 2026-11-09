/**
 * grooveMode/grooveSelector.js
 *
 * 職責：換段時，依使用者的速度從候選 groove 裡挑下一個。純計算，沒有時鐘。
 * 候選已由上一層去掉 special（特殊節奏由 freePlayRouter 的計時器決定，不經過這裡）。
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
 * 同密度有別的 groove 時不挑目前這個，避免連續好幾段都一樣。
 *
 * ═══ 遲滯 ═══
 *
 * 候選中若有「與目前 groove 同密度」的，要換到別的密度，誤差必須好過它
 * 超過 MARGIN 才換 —— 避免速度在兩檔中間時來回跳。
 *
 * ⚠ 遲滯只在「留下來本身還可以」（同密度的誤差 < STAY_OK）時生效。
 *   留下來已經偏很多時，只要有更好的就換。
 *
 * ═══ 量不到速度 ═══
 *
 * 基點或手速為 null（剛開始、fill 太短、沒有過門）→ 在目前同密度的候選中隨機
 * （密度不變，使用者照原本的手速打就對得上）；沒有同密度的（例如從 special 回來）→ 全部隨機。
 */

/** 換到別的密度，誤差要好過留下來多少（對數）。ln(1.15) ≈ 換過去要好 15% 以上 */
export const MARGIN = Math.log(1.15);

/** 留在同密度的誤差小於這個值，才套用遲滯 */
export const STAY_OK = Math.log(1.3);

/** 密度相差在這個比例內視為同一檔 */
const SAME_DENSITY = Math.log(1.05);

const pickRandom = (xs) => xs[Math.floor(Math.random() * xs.length)];
const sameDensity = (a, b) => Math.abs(Math.log(a / b)) < SAME_DENSITY;

/** 從 xs 隨機挑一個；有其他選擇時不挑 currentId */
function pickOther(xs, currentId) {
  const others = xs.filter((c) => c.id !== currentId);
  return pickRandom(others.length ? others : xs);
}

/**
 * @param {Object}   p
 * @param {Array<{id: string, density: number}>} p.candidates  可以換過去的 groove（不含 special）
 * @param {string}   p.currentId       目前（這段）的 groove
 * @param {number}   p.currentDensity  目前 groove 的密度
 * @param {?number}  p.baselineBpm     基點 BPM
 * @param {?number}  p.hitRate         fill 期間手速（每秒幾擊）
 * @returns {{ id: string, impliedBpm: ?number, reason: string }}
 */
export function selectNextGroove({ candidates, currentId, currentDensity, baselineBpm, hitRate }) {
  if (candidates.length === 1) {
    return { id: candidates[0].id, impliedBpm: null, reason: "只有一個候選" };
  }
  if (!baselineBpm || !hitRate) {
    const same = candidates.filter((c) => sameDensity(c.density, currentDensity));
    const id = pickOther(same.length ? same : candidates, currentId).id;
    return { id, impliedBpm: null, reason: same.length ? "量不到速度，同密度隨機" : "量不到速度，隨機" };
  }

  const scored = candidates.map((c) => {
    const impliedBpm = (60 * hitRate) / c.density;
    return { ...c, impliedBpm, err: Math.abs(Math.log(impliedBpm / baselineBpm)) };
  });
  const bestOf = (xs) => xs.reduce((a, b) => (b.err < a.err ? b : a));

  const best = bestOf(scored);
  const stay = scored.filter((c) => sameDensity(c.density, currentDensity));

  let target = best;
  let reason = "最接近基點";
  if (stay.length && !sameDensity(best.density, currentDensity)) {
    const bestStay = bestOf(stay);
    if (bestStay.err < STAY_OK && best.err + MARGIN >= bestStay.err) {
      target = bestStay;
      reason = "差距不夠大，維持同密度";
    } else {
      reason = best.density > currentDensity ? "變快 → 換更密" : "變慢 → 換更疏";
    }
  }

  // 與 target 同密度的候選隨機挑一個
  const picked = pickOther(
    scored.filter((c) => sameDensity(c.density, target.density)),
    currentId,
  );
  return { id: picked.id, impliedBpm: picked.impliedBpm, reason };
}
