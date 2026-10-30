/**
 * poseEngine/accentPose.js
 *
 * 重音抬手：接下來幾擊有 crash 時，畫面上的手臂節點畫成「高舉預備 → 砸下」，
 * 讓使用者看起來像在用力揮下去。
 *
 * ═══ 只改「畫出來的位置」═══
 *
 * ⚠ 只作用在 drawPoseLandmarks 的像素座標副本上。
 *   打擊偵測（PF、手速）、打擊特效、PF overlay 用的全是 MediaPipe 原始座標，
 *   不受影響。不要把變換後的點寫回 landmarks 或 state。
 *
 * ═══ 做法：往固定的高舉姿勢拉，不是放大實際動作 ═══
 *
 * 實際打擊時手通常只離開大腿一點點，「把實際抬手量放大」小動作還是小動作
 * （v1 轉角 ×2 的教訓）。所以改成：手一離開大腿，就把手臂往一個固定的
 * 預備姿勢（WINDUP）拉 —— 上臂不動、前臂以手肘為軸往外翻到朝上（WINDUP_FORE_DEG）。
 *
 * 預備姿勢取自實測（poseLog 2026-10-30，一輕一重交替）：
 *   輕擊：前臂朝下、往鏡頭方向抬，腕只比打擊時高約 0.09（正規化 y）。
 *   重擊：肘幾乎不動（上臂垂在身側），前臂從朝下經外側翻到垂直朝上，
 *         腕高過肘一個前臂長（腕比打擊時高約 0.28）。
 *   ⚠ 不要再把上臂抬到水平（舊版）—— 實際重擊時上臂根本沒抬。
 *
 *   拉多少 = lift（0~1）= 手抬了多高（rise，見下）× 重音進度（平滑升降）
 *   lift = 0 → 實際位置；lift = 1 → 預備姿勢；中間依角度內插（往外側轉上去）。
 *
 * rise：腕到肩的垂直距離比「上一次打擊當下」縮短多少（× 臂長），
 *   過 RISE_DEAD 才開始算（大腿上的抖動不觸發），到 RISE_FULL 用滿。
 *   手一打回大腿 rise → 0，手臂從頭頂一路砸回實際位置 —— 這就是重音感，
 *   而且打下去那一刻顯示 = 實際，不會跳。
 *
 * 手掌節點（小指、食指、拇指）跟著前臂剛體轉動；肩膀上提量 SHOULDER_LIFT（目前 0 = 不動）。
 *
 * ⚠ 角度一律在像素座標算。landmark 的 x、y 各自以寬、高正規化，
 *   直接用正規化座標算角度會被畫面長寬比扭曲。
 * ⚠ 長度以打擊當下記下的上臂／前臂長為準：前臂朝向鏡頭時 2D 長度會縮短，
 *   用當下長度畫高舉姿勢會變成短短一截。
 *
 * ═══ 什麼時候作用 ═══
 *
 * 由上一層每幀告訴 apply()「左右手各要不要作用」（main.js 經 hitRouter 預覽
 * 接下來 ACCENT_LOOKAHEAD_HITS 擊）。進度開啟以 BLEND_ATTACK_MS、關閉以 BLEND_TAU_MS 平滑。
 * 本模組不知道 crash、groove 或譜面是什麼。
 *
 * ═══ 只作用在要打重音的那隻手 ═══
 *
 * 節奏循環／歌曲模式不知道下一擊是哪隻手打，上一層會給 { left: true, right: true }。
 * 這時由 canHit（poseLoop 的手部武裝狀態）挑手：
 *
 *   canHit 打下去變 false、手離開大腿（PF > PF_HIT）變回 true。
 *   兩手輪流打時，下一擊要打的手 = 「比較早變回 true」的那隻（另一隻剛打完還貼著大腿，
 *   或比較晚才抬起來）。
 *
 *   - 挑到之後鎖定，直到那隻手打下去（canHit true → false）或重音結束才重挑；
 *     否則另一隻手抬起來時會搶走效果。
 *   - 兩手都還沒武裝 → 先不作用，等第一隻變回 true 的手。
 *   - 超過 IDLE_HAND_MS 沒打過的手（例如單手打、另一手垂在旁邊，或只用膝蓋踏步）不挑。
 *
 * 位置對應模式下上一層只會給一隻手 true，直接用，不必挑。
 *
 * ═══ 提膝時不作用（膝蓋閘門）═══
 *
 * 節奏循環／部位不配對時，重音也可能由膝蓋打出。手放在大腿上提膝，
 * 手會被大腿頂上去 → rise 變大 → 誤畫成高舉。所以任一邊膝蓋抬起
 * （膝在髖下方的距離比基準縮短，× 軀幹長）就把兩手的 lift 壓掉：
 *   提膝 = 這一擊多半是膝蓋要打，兩手都不該高舉。
 * 基準 = 最近膝蓋最低的位置，以 KNEE_BASE_DECAY 慢慢往下修（人前後移動時跟著調）。
 * 閘門關得快、開得慢（KNEE_GATE_RELEASE_MS）：膝蓋往下踩、還沒判定命中前
 * 不會閃一下高舉。
 *
 * ═══ 重音提膝（膝蓋抬高 → 重踩）═══
 *
 * 上一層另外給 { leftKnee, rightKnee }（這一擊膝蓋可能打重音）。作用中時，
 * 膝蓋實際抬起量（同上，基準縮短多少 × 軀幹長）過 KNEE_RISE_DEAD 就把膝蓋
 * 往「高抬」位置拉：膝在髖下方 = KNEE_WINDUP_RATIO × 站姿基準（負 = 高過髖），到
 * KNEE_LIFT_FULL 用滿。正面鏡頭看提膝，就是膝蓋往髖靠近，所以只動 y。
 * 小腿（踝、腳跟、腳尖）跟著膝蓋整段平移。
 *
 * 高抬位置取自實測（poseLog 2026-10-30，一輕一重交替，站姿膝在髖下方 ≈ 0.215）：
 *   輕踩：膝抬到髖下方 ≈ 0.09（基準的 0.4 倍）。
 *   重踩：膝抬到髖上方 ≈ 0.06（基準的 -0.3 倍），x 幾乎不動。
 *   ⚠ 命中在下踩的第一、二幀就判定，那時膝蓋還在高處（重踩命中時膝 ≈ 與髖同高）。
 * 跟手一樣：膝蓋踩回去 rise → 0，顯示一路砸回實際位置，命中那刻不會跳。
 * 不需要挑邊：沒抬的膝蓋 rise = 0，本來就不作用。
 */

/**
 * 往前看幾擊。1 = 上一擊打下去之後才開始（那隻手此時多半已在半空，
 * 以 BLEND_ATTACK_MS 快速淡入成高舉）。
 */
export const ACCENT_LOOKAHEAD_HITS = 1;

/**
 * 重音進度平滑的時間常數（ms）：開快、關慢。
 * ⚠ 開啟必須很快：重音在「上一擊」打下去才開始，過門接 crash 的間隔只有 150~400 ms，
 *   而交替打（左右手、左右膝）時，要打 crash 的那一側在上一擊落下時多半已經抬到頂。
 *   實測（poseLog 2026-10-30 17:35）舊版開啟 80 ms：到頂時進度才 0.2~0.6，
 *   等進度上來手／膝已經在往下打，lift 最高只有 0.05~0.66。
 */
const BLEND_ATTACK_MS = 20;
const BLEND_TAU_MS = 80;

/** rise 低於這個（× 臂長）不作用：手還貼在大腿上 */
const RISE_DEAD = 0.03;
/**
 * rise 到這個（× 臂長）就拉到完整預備姿勢。越小 → 手稍微抬一下就舉滿。
 * 實測快打（過門）每下只抬 0.07~0.19，舊值 0.22 永遠到不了滿。
 */
const RISE_FULL = 0.1;

/** 預備姿勢：前臂朝上、往外偏幾度（負 = 往內、朝頭的方向）。實測重擊 ≈ 0（垂直朝上） */
const WINDUP_FORE_DEG = 0;
/** 肩膀上提量（× 臂長，lift = 1 時） */
const SHOULDER_LIFT = 0;

/**
 * 這麼久沒打過的手，兩手都可能時不挑（ms）。
 * 例如只用膝蓋踏步、兩手舉在胸前：手離大腿很遠（rise 很大）又一直武裝，
 * 舊版仍會挑一隻畫成高舉，膝蓋打 crash 時手跟著舉起來。
 */
const IDLE_HAND_MS = 1500;

/** 還沒打過時的落點：腕在肩下方 DEFAULT_DROP × 臂長 */
const DEFAULT_DROP = 0.85;

/** 膝蓋抬起低於這個（× 軀幹長）不壓：站著的晃動 */
const KNEE_RISE_DEAD = 0.04;
/** 膝蓋抬起到這個（× 軀幹長）完全壓掉。實測快速踏步每下只抬 0.10~0.15 */
const KNEE_RISE_FULL = 0.1;
/** 膝蓋基準每秒往下修多少（× 軀幹長） */
const KNEE_BASE_DECAY = 0.1;
/** 膝蓋閘門重新打開的時間常數（ms）；關閉是立即的 */
const KNEE_GATE_RELEASE_MS = 250;
/** 重音提膝：膝蓋抬到這個（× 軀幹長）就拉到完整高抬位置（快速踏步每下只抬 0.10~0.15） */
const KNEE_LIFT_FULL = 0.1;
/** 重音提膝：高抬位置的膝在髖下方多少（× 站姿基準；負 = 高過髖）。實測重踩 ≈ -0.3 */
const KNEE_WINDUP_RATIO = -0.3;

/** MediaPipe Pose：肩、肘、腕、手掌（小指、食指、拇指） */
const ARM_INDEX = {
  left: { shoulder: 11, elbow: 13, wrist: 15, hand: [17, 19, 21], other: 12 },
  right: { shoulder: 12, elbow: 14, wrist: 16, hand: [18, 20, 22], other: 11 },
};
/** MediaPipe Pose：髖、膝、小腿（踝、腳跟、腳尖） */
const LEG_INDEX = {
  left: { hip: 23, knee: 25, shin: [27, 29, 31] },
  right: { hip: 24, knee: 26, shin: [28, 30, 32] },
};

const DEG = Math.PI / 180;
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (t) => t * t * (3 - 2 * t);
const lerp = (a, b, t) => a + (b - a) * t;
/**
 * 角度內插，優先往 dir 方向轉（-1 = 角度變小，+1 = 變大）。
 * 手放在身體內側時，最短路徑會從胸前橫過去；改走外側才像把手甩上去。
 * 反方向只差一點（< 120°）時仍走最短，避免繞一大圈。
 */
function lerpAngle(from, to, t, dir) {
  let d = wrapPi(to - from);
  if (Math.sign(d) !== dir && Math.abs(d) > 120 * DEG) d -= Math.sign(d) * 2 * Math.PI;
  return from + d * t;
}
const angleOf = (from, to) => Math.atan2(to.y - from.y, to.x - from.x);
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);

function rotateAround(p, c, rad) {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function createAccentPose() {
  /** 各手的重音進度 0~1（平滑） */
  const blend = { left: 0, right: 0 };
  /** 各手上一次打擊當下：上臂長、前臂長、腕在肩下方多少（× 臂長） */
  const ref = { left: null, right: null };
  let lastMs = null;

  /** 各手上一幀的 canHit、最近一次變回 true 的時間 */
  const prevArmed = { left: false, right: false };
  const armedSince = { left: null, right: null };
  /** 兩手都可能時鎖定的那隻手（null = 尚未挑） */
  let chosen = null;

  /** 各膝蓋的基準（膝在髖下方多少，× 軀幹長）；閘門 0~1（1 = 不壓） */
  const kneeBase = { left: null, right: null };
  let kneeGate = 1;
  /** 本幀各膝蓋抬起量（× 軀幹長；null = 本幀量不到）與軀幹長（px） */
  const kneeRise = { left: null, right: null };
  let torsoPx = null;
  /** 各膝蓋的重音進度 0~1（平滑） */
  const kneeBlend = { left: 0, right: 0 };

  /**
   * 診斷（perfLog 讀）：上一次 apply 的內部狀態。
   * lift 1 = 完整預備姿勢；null = 本幀沒算到（進度 ≈ 0 或節點看不到）。
   */
  const debug = {
    target: null, // 上一層給的 { left, right, leftKnee, rightKnee }
    pick: null, // 挑手後實際作用的手
    gate: 1,
    hand: { left: null, right: null },
    knee: { left: null, right: null },
  };

  /** 更新膝蓋閘門。軀幹看不到時沿用上一幀；單邊膝蓋看不到就不看那邊。 */
  function updateKneeGate(points, dt, visibilityThreshold) {
    kneeRise.left = kneeRise.right = torsoPx = null;
    const ok = (p) => p && p.visibility >= visibilityThreshold;
    const [ls, rs, lh, rh] = [11, 12, 23, 24].map((i) => points[i]);
    if (![ls, rs, lh, rh].every(ok)) return kneeGate;
    const torso = (lh.y + rh.y - ls.y - rs.y) / 2;
    if (torso <= 0) return kneeGate;
    torsoPx = torso;

    let rise = 0;
    for (const side of ["left", "right"]) {
      const H = points[LEG_INDEX[side].hip];
      const K = points[LEG_INDEX[side].knee];
      if (!ok(K)) continue;
      const low = (K.y - H.y) / torso;
      const base = kneeBase[side];
      kneeBase[side] = base === null ? low : Math.max(low, base - (KNEE_BASE_DECAY * dt) / 1000);
      kneeRise[side] = kneeBase[side] - low;
      rise = Math.max(rise, kneeRise[side]);
    }

    const target =
      1 - smoothstep(clamp01((rise - KNEE_RISE_DEAD) / (KNEE_RISE_FULL - KNEE_RISE_DEAD)));
    kneeGate =
      target < kneeGate
        ? target
        : kneeGate + (target - kneeGate) * (1 - Math.exp(-dt / KNEE_GATE_RELEASE_MS));
    return kneeGate;
  }

  /**
   * 兩手都要作用時，用 canHit 挑出要打重音的那隻手。
   * @param {{left:boolean, right:boolean}|null} target
   * @param {{left:Object, right:Object}} hands  poseLoop 的 leftState / rightState
   */
  function pickSide(target, hands, nowMs) {
    for (const side of ["left", "right"]) {
      const armed = !!hands?.[side]?.canHit;
      if (armed && !prevArmed[side]) armedSince[side] = nowMs;
      // 鎖定的手打下去了 → 這一擊結束，重挑
      if (!armed && prevArmed[side] && chosen === side) chosen = null;
      prevArmed[side] = armed;
    }

    if (!target?.left || !target?.right) {
      chosen = null;
      return target; // 只有一隻手（位置對應）或都不用
    }

    if (chosen === null) {
      const idle = (side) => nowMs - (hands[side].lastHitMs ?? -Infinity) > IDLE_HAND_MS;
      const armed = ["left", "right"].filter((side) => prevArmed[side] && !idle(side));
      if (armed.length) {
        chosen = armed.reduce((a, b) => (armedSince[b] < armedSince[a] ? b : a));
      }
    }
    return { left: chosen === "left", right: chosen === "right" };
  }

  /** 手部打擊時呼叫：記下這一刻的手臂當作之後的落點與長度基準 */
  function noteHit(side, landmarks, rect) {
    const idx = ARM_INDEX[side];
    const px = (i) => ({
      x: rect.x + landmarks[i].x * rect.width,
      y: rect.y + landmarks[i].y * rect.height,
    });
    const S = px(idx.shoulder);
    const E = px(idx.elbow);
    const W = px(idx.wrist);
    const upperLen = dist(S, E);
    const foreLen = dist(E, W);
    ref[side] = { upperLen, foreLen, drop: (W.y - S.y) / (upperLen + foreLen) };
  }

  /**
   * 原地修改 points（drawPoseLandmarks 的像素座標副本）。
   *
   * @param {{x:number, y:number, visibility:number}[]} points
   * @param {{left:boolean, right:boolean, leftKnee:boolean, rightKnee:boolean}|null} target
   *   各手／各膝蓋要不要作用（兩手都 true = 由 canHit 挑）
   * @param {number} nowMs
   * @param {number} visibilityThreshold
   * @param {{left:Object, right:Object}} hands  poseLoop 的 leftState / rightState（讀 canHit、lastHitMs）
   */
  function apply(points, target, nowMs, visibilityThreshold, hands) {
    const dt = lastMs === null ? Infinity : nowMs - lastMs;
    lastMs = nowMs;
    // 開快關慢（見 BLEND_ATTACK_MS）
    const kUp = 1 - Math.exp(-dt / BLEND_ATTACK_MS);
    const kDown = 1 - Math.exp(-dt / BLEND_TAU_MS);
    const approach = (cur, on) => cur + ((on ? 1 : 0) - cur) * (on ? kUp : kDown);
    const eff = pickSide(target, hands, nowMs);
    const gate = updateKneeGate(points, dt, visibilityThreshold);
    debug.gate = gate;
    debug.target = target;
    debug.pick = eff;

    for (const side of ["left", "right"]) {
      blend[side] = approach(blend[side], eff?.[side]);
      debug.hand[side] = null;
      if (blend[side] < 1e-3) continue;
      debug.hand[side] = { blend: blend[side], rise: null, lift: null, vis: false };

      const idx = ARM_INDEX[side];
      const S = points[idx.shoulder];
      const E = points[idx.elbow];
      const W = points[idx.wrist];
      const O = points[idx.other];
      if (!S || !E || !W || !O) continue;
      if (
        S.visibility < visibilityThreshold ||
        E.visibility < visibilityThreshold ||
        W.visibility < visibilityThreshold
      ) {
        continue;
      }
      debug.hand[side].vis = true;

      const curUpper = dist(S, E);
      const curFore = dist(E, W);
      const r = ref[side];
      const upperLen = r ? Math.max(r.upperLen, curUpper) : curUpper;
      const foreLen = r ? Math.max(r.foreLen, curFore) : curFore;
      const armLen = upperLen + foreLen;

      // 手抬多高 → 往預備姿勢拉多少
      const drop = (W.y - S.y) / armLen;
      const rise = (r?.drop ?? DEFAULT_DROP) - drop;
      const lift =
        smoothstep(clamp01((rise - RISE_DEAD) / (RISE_FULL - RISE_DEAD))) * blend[side] * gate;
      debug.hand[side].rise = rise;
      debug.hand[side].lift = lift;
      if (lift < 1e-3) continue;

      // 往外 = 遠離另一邊肩膀的方向
      const out = S.x >= O.x ? 1 : -1;
      const windFore = -Math.PI / 2 + out * WINDUP_FORE_DEG * DEG;

      // 上臂角度不動（實測重擊時肘幾乎不動），只修長度
      const newUpper = angleOf(S, E);
      const fore = angleOf(E, W);
      // 前臂往外翻上去：右側（out = 1）角度變小（下 → 外 → 上），左側相反
      const newFore = lerpAngle(fore, windFore, lift, -out);

      S.y -= SHOULDER_LIFT * armLen * lift;
      const L1 = lerp(curUpper, upperLen, lift);
      const L2 = lerp(curFore, foreLen, lift);
      const newE = { x: S.x + Math.cos(newUpper) * L1, y: S.y + Math.sin(newUpper) * L1 };
      const newW = { x: newE.x + Math.cos(newFore) * L2, y: newE.y + Math.sin(newFore) * L2 };

      // 手掌跟著前臂：先繞舊腕轉，再平移到新腕
      const dFore = wrapPi(newFore - fore);
      for (const i of idx.hand) {
        const p = points[i];
        if (!p) continue;
        const q = rotateAround(p, W, dFore);
        p.x = q.x + (newW.x - W.x);
        p.y = q.y + (newW.y - W.y);
      }
      E.x = newE.x;
      E.y = newE.y;
      W.x = newW.x;
      W.y = newW.y;
    }

    // ── 重音提膝：膝蓋往髖拉高，小腿跟著平移 ──
    for (const side of ["left", "right"]) {
      kneeBlend[side] = approach(kneeBlend[side], target?.[`${side}Knee`]);
      debug.knee[side] = null;
      if (kneeBlend[side] < 1e-3) continue;
      debug.knee[side] = { blend: kneeBlend[side], rise: kneeRise[side], lift: null };
      if (kneeRise[side] === null) continue;

      const lift =
        smoothstep(clamp01((kneeRise[side] - KNEE_RISE_DEAD) / (KNEE_LIFT_FULL - KNEE_RISE_DEAD))) *
        kneeBlend[side];
      debug.knee[side].lift = lift;
      if (lift < 1e-3) continue;

      const idx = LEG_INDEX[side];
      const H = points[idx.hip];
      const K = points[idx.knee];
      const curLow = (K.y - H.y) / torsoPx;
      const windLow = KNEE_WINDUP_RATIO * kneeBase[side];
      const dy = (lerp(curLow, Math.min(curLow, windLow), lift) - curLow) * torsoPx;
      for (const i of [idx.knee, ...idx.shin]) {
        if (points[i]) points[i].y += dy;
      }
    }
  }

  return { noteHit, apply, debug };
}
