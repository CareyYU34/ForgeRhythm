/**
 * hitEffects.js
 *
 * 打擊視覺效果模組。
 * 完全獨立於偵測邏輯，只負責「收到 hit 事件 → 在 canvas 上畫動畫」。
 *
 * 使用方式：
 *   const fx = createHitEffectManager();
 *   fx.pushHandHit({ side, zone, hip, hand, knee, strength });
 *   fx.pushKneeHit({ side, knee, strength });
 *   fx.draw(canvasCtx, nowMs);
 */

const HAND_DURATION_MS = 1100;
const KICK_DURATION_MS = 950;

// ── 色彩主題（左手 vs 右手 vs 膝蓋）────────────────────────────────────────

const SIDE_COLORS = {
  left: {
    primary: [0, 220, 255],
    secondary: [80, 255, 220],
  },
  right: {
    primary: [255, 60, 160],
    secondary: [255, 160, 60],
  },
  knee: {
    primary: [255, 230, 0],
    secondary: [255, 130, 0],
  },
};

// ── 工具 ──────────────────────────────────────────────────────────────────────

function toCanvas(pt, rect) {
  return {
    x: rect.x + pt.x * rect.width,
    y: rect.y + pt.y * rect.height,
  };
}

function isReasonableCanvasPx(px, rect) {
  const margin = 0.2;
  return (
    px.x >= rect.x - rect.width * margin &&
    px.x <= rect.x + rect.width * (1 + margin) &&
    px.y >= rect.y - rect.height * margin &&
    px.y <= rect.y + rect.height * (1 + margin)
  );
}

function rgba([r, g, b], a) {
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
function easeOutQuart(t) {
  return 1 - Math.pow(1 - t, 4);
}
function easeOut(t) {
  return 1 - (1 - t) * (1 - t);
}

// ── 爆炸粒子群 ───────────────────────────────────────────────────────────────

function createParticles(cx, cy, colors, count = 14) {
  const particles = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.8;
    const speed = 55 + Math.random() * 85;
    const radius = 2.5 + Math.random() * 3.5;
    const life = 0.6 + Math.random() * 0.4;
    const color = colors[Math.floor(Math.random() * colors.length)];
    particles.push({ angle, speed, radius, life, color, cx, cy });
  }
  return particles;
}

function drawParticles(ctx, particles, t) {
  for (const p of particles) {
    const localT = Math.min(1, t / p.life);
    if (localT >= 1) continue;
    const dist = easeOutCubic(localT) * p.speed;
    const alpha = (1 - localT) * 0.95;
    const x = p.cx + Math.cos(p.angle) * dist;
    const y = p.cy + Math.sin(p.angle) * dist;
    const r = p.radius * (1 - localT * 0.5);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = rgba(p.color, alpha);
    ctx.fill();
  }
}

// ── 衝擊同心環 ───────────────────────────────────────────────────────────────

function drawImpactRings(ctx, cx, cy, t, primaryColor, strength) {
  const NUM_RINGS = 3;
  for (let i = 0; i < NUM_RINGS; i++) {
    const delay = i * 0.18;
    const localT = Math.max(0, (t - delay) / (1 - delay));
    if (localT <= 0 || localT >= 1) continue;

    const maxR = 38 + i * 22 + strength * 32;
    const r = easeOutQuart(localT) * maxR;
    const alpha = (1 - localT) * (0.85 - i * 0.15);
    const lw = (2.5 - i * 0.5) * (1 - localT * 0.7);

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(primaryColor, alpha);
    ctx.lineWidth = Math.max(0.5, lw);
    ctx.stroke();
  }
}

// ── 閃光圓（衝擊瞬間）────────────────────────────────────────────────────────

function drawFlash(ctx, cx, cy, t, primaryColor, strength) {
  if (t > 0.25) return;
  const localT = t / 0.25;
  const r = (20 + strength * 18) * (1 - localT);
  const alpha = 0.75 * (1 - localT);

  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  grad.addColorStop(0, rgba(primaryColor, alpha));
  grad.addColorStop(1, rgba(primaryColor, 0));

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
}

// ── 能量線（從落點向外輻射）──────────────────────────────────────────────────

function drawEnergyLines(ctx, cx, cy, t, primaryColor, secondary, strength) {
  if (t > 0.55) return;
  const localT = t / 0.55;
  const NUM = 8;
  const MAX_LEN = 45 + strength * 40;

  ctx.save();
  for (let i = 0; i < NUM; i++) {
    const angle = (i / NUM) * Math.PI * 2;
    const offset = i % 2 === 0 ? 0 : 0.12;
    const lt = Math.max(0, localT - offset);
    const len = easeOut(lt) * MAX_LEN;
    const alpha = (1 - localT) * 0.9;

    const sx = cx + Math.cos(angle) * 8;
    const sy = cy + Math.sin(angle) * 8;
    const ex = cx + Math.cos(angle) * (8 + len);
    const ey = cy + Math.sin(angle) * (8 + len);

    const color = i % 3 === 0 ? secondary : primaryColor;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = 2 + (1 - localT) * 2.5;
    ctx.stroke();
  }
  ctx.restore();
}

// ── 手部命中特效（衝擊點：閃光 + 能量線 + 同心環 + 粒子）────────────────────

function drawHandHit(ctx, ef, t) {
  const { handPx, strength, side } = ef;
  const colors = SIDE_COLORS[side] ?? SIDE_COLORS.right;
  const primary = colors.primary;
  const secondary = colors.secondary;

  ctx.save();
  drawFlash(ctx, handPx.x, handPx.y, t, primary, strength);
  drawEnergyLines(ctx, handPx.x, handPx.y, t, primary, secondary, strength);
  drawImpactRings(ctx, handPx.x, handPx.y, t, primary, strength);
  drawParticles(ctx, ef.particles, t);
  ctx.restore();
}

// ── 膝蓋踢 ───────────────────────────────────────────────────────────────────

function drawKick(ctx, ef, t) {
  const { kneePx, strength } = ef;
  const colors = SIDE_COLORS.knee;
  const primary = colors.primary;
  const secondary = colors.secondary;

  const decay = (1 - t) * (1 - t);
  const NUM = Math.round(10 + strength * 6);
  const MAX_LEN = 65 + strength * 75;

  ctx.save();
  ctx.shadowColor = rgba(primary, 0.7);
  ctx.shadowBlur = 14;

  for (let i = 0; i < NUM; i++) {
    const frac = i / (NUM - 1);
    const angle = (frac - 0.5) * Math.PI * (110 / 180);
    const speed = 0.5 + frac * 0.5;
    const progress = Math.min(1, t * 1.9 * speed);
    const arcLen = progress * MAX_LEN;
    const alpha = Math.max(0, (1 - progress * 1.05) * strength * 0.95);
    const lw = 2 + decay * strength * 2.5;

    const sx = kneePx.x + Math.sin(angle) * 10;
    const sy = kneePx.y;
    const ex = sx + Math.sin(angle) * arcLen;
    const ey = sy - Math.cos(angle) * arcLen;

    const mx = (sx + ex) / 2 + Math.sin(angle + 0.4) * arcLen * 0.2;
    const my = (sy + ey) / 2 - 10;

    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, ex, ey);

    const color = i % 3 === 0 ? secondary : primary;
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = lw;
    ctx.stroke();
  }

  ctx.shadowBlur = 0;

  drawFlash(ctx, kneePx.x, kneePx.y, t, primary, strength);
  drawImpactRings(ctx, kneePx.x, kneePx.y, t, primary, strength);
  drawParticles(ctx, ef.particles, t);

  ctx.restore();
}

// ── 公開 API ──────────────────────────────────────────────────────────────────

export function createHitEffectManager() {
  const effects = [];

  function pushHandHit({
    side,
    zone,
    hip,
    hand,
    knee,
    strength,
    getVideoDrawRect,
  }) {
    if (!hand) return;
    const rect = getVideoDrawRect();
    const handPx = toCanvas(hand, rect);

    if (!isReasonableCanvasPx(handPx, rect)) return;

    const str = Math.max(0.35, Math.min(1, strength ?? 0.85));
    const colors = SIDE_COLORS[side] ?? SIDE_COLORS.right;

    effects.push({
      type: "hand",
      side,
      zone,
      handPx,
      strength: str,
      particles: createParticles(handPx.x, handPx.y, [colors.primary, colors.secondary], 16),
      startMs: performance.now(),
      durationMs: HAND_DURATION_MS,
    });
  }

  function pushKneeHit({ side, knee, strength, getVideoDrawRect }) {
    if (!knee) return;
    const rect = getVideoDrawRect();
    const cx = rect.x + knee.x * rect.width;
    const cy = rect.y + knee.y * rect.height;

    if (!isReasonableCanvasPx({ x: cx, y: cy }, rect)) return;

    const str = Math.max(0.35, Math.min(1, strength ?? 0.85));

    effects.push({
      type: "kick",
      side,
      kneePx: { x: cx, y: cy },
      strength: str,
      particles: createParticles(cx, cy, [SIDE_COLORS.knee.primary, SIDE_COLORS.knee.secondary], 18),
      startMs: performance.now(),
      durationMs: KICK_DURATION_MS,
    });
  }

  function draw(ctx, nowMs) {
    if (effects.length === 0) return;

    for (let i = effects.length - 1; i >= 0; i--) {
      const ef = effects[i];
      const t = (nowMs - ef.startMs) / ef.durationMs;

      if (t >= 1) {
        effects.splice(i, 1);
        continue;
      }

      ctx.save();
      if (ef.type === "hand") drawHandHit(ctx, ef, t);
      else if (ef.type === "kick") drawKick(ctx, ef, t);
      ctx.restore();
    }
  }

  return { pushHandHit, pushKneeHit, draw };
}