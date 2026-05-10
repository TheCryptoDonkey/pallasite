/**
 * Vector renderer for the game world.
 *
 * Pure Canvas 2D — line strokes, mostly. Per-wave procedural backgrounds with
 * an opt-in override hook for /backgrounds/wave-N.png if the consumer drops in
 * generated art.
 */

import type {
  GameState, Ship, Asteroid, Bullet, Coin, Particle, Ufo, Mine, PowerUp, ReplaySnapshot, Debris,
} from './types.js';
import {
  WORLD_W, WORLD_H, WARP_MS, waveName, waveSubtitle, ASTEROID_TYPE_CONFIG, POWERUP_CONFIG,
  REPLAY_SLOW_MS, REPLAY_SLOW_RATE, REPLAY_EXPLOSION_MS,
} from './types.js';

// ── Stars ─────────────────────────────────────────────────────────────────────

const STAR_COUNT = 110;
const stars: { x: number; y: number; r: number; flickerPhase: number; depth: number }[] = [];

(function initStars() {
  for (let i = 0; i < STAR_COUNT; i++) {
    const depth = Math.random();
    stars.push({
      x: Math.random() * WORLD_W,
      y: Math.random() * WORLD_H,
      r: 0.5 + depth * 1.6,
      flickerPhase: Math.random() * Math.PI * 2,
      depth,
    });
  }
})();

function drawStars(ctx: CanvasRenderingContext2D, t: number): void {
  ctx.save();
  for (const s of stars) {
    const flick = 0.5 + 0.5 * Math.sin(t * 0.001 + s.flickerPhase);
    ctx.globalAlpha = (0.25 + s.depth * 0.6) * (0.55 + flick * 0.45);
    ctx.fillStyle = '#cfd6ff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── Procedural background ────────────────────────────────────────────────────

interface BackgroundCache {
  wave: number;
  canvas: HTMLCanvasElement;
}

let bgCache: BackgroundCache | null = null;
const overrideImages: Map<number, HTMLImageElement | 'failed' | 'pending'> = new Map();

/** Kick off a background load for the given wave if not already requested. */
export function preloadBackground(wave: number): void {
  if (overrideImages.has(wave)) return;
  overrideImages.set(wave, 'pending');
  const img = new Image();
  img.onload = () => overrideImages.set(wave, img);
  img.onerror = () => overrideImages.set(wave, 'failed');
  img.src = `/backgrounds/wave-${wave}.webp`;
}

function tryLoadOverride(wave: number): HTMLImageElement | null {
  const cached = overrideImages.get(wave);
  if (cached === 'failed') return null;
  if (cached === 'pending') return null;
  if (cached) return cached;
  preloadBackground(wave);
  return null;
}

/** Seeded random for a stable background per wave. */
function seededRand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildProceduralBackground(wave: number): HTMLCanvasElement {
  const off = document.createElement('canvas');
  off.width = WORLD_W;
  off.height = WORLD_H;
  const ctx = off.getContext('2d')!;
  const rand = seededRand(wave * 1009 + 7);

  // Base black
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Nebula: rotate hue per wave, soft radial gradient
  const baseHue = (wave * 47 + 200) % 360;
  for (let i = 0; i < 3; i++) {
    const cx = rand() * WORLD_W;
    const cy = rand() * WORLD_H;
    const r = 250 + rand() * 350;
    const hue = (baseHue + (i - 1) * 25 + 360) % 360;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, `hsla(${hue}, 80%, 50%, 0.18)`);
    grad.addColorStop(0.5, `hsla(${hue}, 70%, 35%, 0.08)`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  }

  // 1-2 distant planets
  const planetCount = wave % 3 === 0 ? 2 : 1;
  for (let i = 0; i < planetCount; i++) {
    const cx = rand() * WORLD_W;
    const cy = WORLD_H * (0.18 + rand() * 0.65);
    const r = 60 + rand() * 90;
    const planetHue = (baseHue + 30 + i * 80) % 360;

    // Dark backside
    const back = ctx.createRadialGradient(
      cx + r * 0.3, cy - r * 0.3, r * 0.1,
      cx, cy, r,
    );
    back.addColorStop(0, `hsl(${planetHue}, 45%, 35%)`);
    back.addColorStop(0.7, `hsl(${planetHue}, 40%, 18%)`);
    back.addColorStop(1, `hsl(${planetHue}, 30%, 8%)`);
    ctx.fillStyle = back;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Atmosphere rim glow
    ctx.shadowColor = `hsla(${planetHue}, 90%, 60%, 0.6)`;
    ctx.shadowBlur = 30;
    ctx.strokeStyle = `hsla(${planetHue}, 80%, 55%, 0.4)`;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Faint surface bands
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    for (let b = 0; b < 4; b++) {
      const yPct = 0.2 + rand() * 0.6;
      const bandY = cy - r + yPct * 2 * r;
      const bandH = 4 + rand() * 12;
      ctx.fillStyle = `hsla(${planetHue}, 30%, 25%, 0.4)`;
      ctx.fillRect(cx - r, bandY, r * 2, bandH);
    }
    ctx.restore();
  }

  // Sprinkle of distant nebula points
  for (let i = 0; i < 20; i++) {
    const x = rand() * WORLD_W;
    const y = rand() * WORLD_H;
    const r = 1 + rand() * 2;
    const hue = (baseHue + rand() * 80 - 40 + 360) % 360;
    ctx.fillStyle = `hsla(${hue}, 90%, 70%, ${0.15 + rand() * 0.25})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  return off;
}

/**
 * Apply the current wave's background image as a body-level CSS background
 * so the area outside the (letterboxed) canvas on mobile / odd aspect ratios
 * still has something to look at. Keyed on (wave + override-availability) so
 * we re-apply once the override image finishes loading — keying on wave alone
 * meant the first-frame "no override yet, set ''" call was sticky.
 */
let lastBodyBgKey = '';
function syncBodyBackground(wave: number, hasOverride: boolean): void {
  const key = hasOverride ? `w${wave}` : '';
  if (key === lastBodyBgKey) return;
  lastBodyBgKey = key;
  if (typeof document === 'undefined') return;
  document.body.style.backgroundImage = key ? `url(/backgrounds/wave-${wave}.webp)` : '';
}

/** Render mode info from main.ts fit() — tells drawBackground whether to use
 *  in-world coords (retro) or canvas-pixel coords (modern fill). */
export interface RenderModeInfo {
  kind: 'retro' | 'modern';
  vw: number;
  vh: number;
  dpr: number;
  scale: number;
  tx: number;
  ty: number;
}
let renderMode: RenderModeInfo = { kind: 'retro', vw: 960, vh: 720, dpr: 1, scale: 1, tx: 0, ty: 0 };
export function setRenderMode(info: RenderModeInfo): void { renderMode = info; }

/** Title-screen background cycling: rotates through wave bgs every 30s,
 *  skipping the wave-25 finale image so the boss reveal stays for in-game. */
let titleBgStartedAt = 0;
const TITLE_BG_INTERVAL_MS = 30_000;
const TITLE_BG_MAX = 24;  // wave 25 (Event Horizon) excluded — saves the reveal

function drawBackground(ctx: CanvasRenderingContext2D, state: GameState, now: number): void {
  let wave: number;
  if (state.phase === 'title') {
    if (titleBgStartedAt === 0) titleBgStartedAt = now;
    const idx = Math.floor((now - titleBgStartedAt) / TITLE_BG_INTERVAL_MS) % TITLE_BG_MAX;
    wave = idx + 1;
    // Preload the next wave so the cycle is seamless
    preloadBackground(((idx + 1) % TITLE_BG_MAX) + 1);
  } else {
    wave = Math.max(1, state.wave);
    titleBgStartedAt = 0;  // reset so re-entering title starts the cycle from #1
  }
  const override = tryLoadOverride(wave);
  syncBodyBackground(wave, override !== null);

  if (renderMode.kind === 'modern') {
    // Modern fill: bg covers the entire canvas in canvas-pixel space, not the
    // 960×720 world rect. Save/restore the world transform around it so other
    // draw calls keep using world coords.
    ctx.save();
    ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
    if (override) {
      const breath = 1.025 + Math.sin(now * 0.00038) * 0.006;
      const coverScale = Math.max(renderMode.vw / override.width, renderMode.vh / override.height) * breath;
      const w = override.width * coverScale;
      const h = override.height * coverScale;
      const dx = (renderMode.vw - w) / 2 + Math.sin(now * 0.00029) * 12;
      const dy = (renderMode.vh - h) / 2 + Math.cos(now * 0.00021) * 7;
      ctx.drawImage(override, dx, dy, w, h);
    } else {
      // Procedural fallback also stretches to canvas — cheap solid black so
      // the canvas isn't the underlying body bg (which we deliberately hid).
      if (!bgCache || bgCache.wave !== wave) {
        bgCache = { wave, canvas: buildProceduralBackground(wave) };
      }
      ctx.drawImage(bgCache.canvas, 0, 0, renderMode.vw, renderMode.vh);
    }
    ctx.restore();
    return;
  }

  // Retro: draw bg in 960×720 world space (unchanged behaviour).
  if (override) {
    const breath = 1.025 + Math.sin(now * 0.00038) * 0.006;
    const w = WORLD_W * breath;
    const h = WORLD_H * breath;
    const dx = (WORLD_W - w) / 2 + Math.sin(now * 0.00029) * 9;
    const dy = (WORLD_H - h) / 2 + Math.cos(now * 0.00021) * 5;
    ctx.drawImage(override, dx, dy, w, h);
    return;
  }
  if (!bgCache || bgCache.wave !== wave) {
    bgCache = { wave, canvas: buildProceduralBackground(wave) };
  }
  ctx.drawImage(bgCache.canvas, 0, 0);
}

// ── Ship ──────────────────────────────────────────────────────────────────────

function drawShield(ctx: CanvasRenderingContext2D, ship: Ship, now: number): void {
  if (!ship.shieldUp || !ship.alive) return;
  const remaining = Math.max(0, ship.shieldExpiresAt - now);
  const fade = Math.min(1, remaining / 300);  // fade out in last 300ms
  const r = ship.radius * 2.2 + Math.sin(now * 0.012) * 1.5;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);

  // Outer glow ring
  const grad = ctx.createRadialGradient(0, 0, ship.radius * 1.2, 0, 0, r);
  grad.addColorStop(0, 'rgba(91, 157, 255, 0)');
  grad.addColorStop(0.7, `rgba(91, 157, 255, ${0.18 * fade})`);
  grad.addColorStop(1, `rgba(91, 157, 255, ${0.5 * fade})`);
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();

  // Hex pattern around the perimeter (six dots)
  ctx.strokeStyle = `rgba(91, 157, 255, ${0.85 * fade})`;
  ctx.lineWidth = 1.2;
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6 + now * 0.001;
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    ctx.fillStyle = `rgba(180, 220, 255, ${0.9 * fade})`;
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawShip(ctx: CanvasRenderingContext2D, ship: Ship, now: number): void {
  if (!ship.alive) return;
  // Hide ship entirely during hyperspace cloak — except when the warp is
  // malfunctioning, in which case render a red distortion at the departure
  // point so the player sees something is going wrong.
  if (ship.hyperspaceCloakMs > 0) {
    if (ship.hyperspaceMalfunction) drawHyperspaceMalfunction(ctx, ship, now);
    return;
  }
  const flickerOff = ship.invulnerableUntil > now && Math.floor(now / 80) % 2 === 0;
  if (flickerOff) return;

  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.rotate(ship.rot);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = '#58ff58';
  ctx.shadowColor = '#58ff58';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 8);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, -8);
  ctx.closePath();
  ctx.stroke();

  if (ship.thrusting && Math.floor(ship.thrustFrame) % 2 === 0) {
    ctx.strokeStyle = '#ffd84a';
    ctx.shadowColor = '#ffd84a';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(-6, 4);
    ctx.lineTo(-14, 0);
    ctx.lineTo(-6, -4);
    ctx.stroke();
  }

  ctx.restore();
}

/**
 * Pulsing red distortion drawn at the ship's departure point throughout the
 * cloak phase when the warp jump rolled a malfunction. Three concentric rings
 * collapse inward — the visual cue that the void is *taking* the ship rather
 * than relocating it. The shape distorts on each frame for a "broken signal"
 * feel.
 */
function drawHyperspaceMalfunction(ctx: CanvasRenderingContext2D, ship: Ship, now: number): void {
  const t = now * 0.012;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.strokeStyle = '#ff5050';
  ctx.shadowColor = '#ff5050';
  ctx.shadowBlur = 18;
  for (let ring = 0; ring < 3; ring++) {
    const phase = (t + ring * 0.55) % 1;
    const radius = 38 * (1 - phase);
    if (radius < 4) continue;
    const alpha = phase < 0.2 ? phase / 0.2 : 1 - (phase - 0.2) / 0.8;
    ctx.globalAlpha = Math.max(0.05, Math.min(1, alpha)) * 0.8;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const segments = 14;
    for (let i = 0; i <= segments; i++) {
      const a = (Math.PI * 2 * i) / segments;
      // Per-segment jitter so the ring looks corrupt
      const jitter = (Math.sin(t * 7 + ring * 3 + i * 1.7) * 0.5 + 0.5) * 4 - 2;
      const r = radius + jitter;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// ── Asteroid ──────────────────────────────────────────────────────────────────

function drawAsteroid(ctx: CanvasRenderingContext2D, a: Asteroid, now: number): void {
  if (!a.alive) return;
  const cfg = ASTEROID_TYPE_CONFIG[a.type];
  ctx.save();
  ctx.translate(a.pos.x, a.pos.y);
  ctx.rotate(a.rot);
  ctx.lineWidth = a.type === 'iron' ? 2.0 : 1.4;
  const lightness = 60 + a.hue * 0.2;
  ctx.strokeStyle = `hsl(${cfg.hueBase}, 70%, ${lightness}%)`;
  ctx.shadowColor = cfg.glow;
  ctx.shadowBlur = a.type === 'pallasite' ? 14 : 8;

  const n = a.shape.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const angle = (Math.PI * 2 * i) / n;
    const r = a.radius * a.shape[i];
    const x = Math.cos(angle) * r;
    const y = Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.stroke();

  // Iron: inner armour ring while hp > 1 — strips off after the first hit
  if (a.type === 'iron' && a.hp > 1) {
    ctx.lineWidth = 1.0;
    ctx.globalAlpha = 0.55;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n;
      const r = a.radius * a.shape[i] * 0.62;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Pallasite: olivine sparkle dots — animated, signals jackpot
  if (a.type === 'pallasite') {
    const count = a.size === 'large' ? 7 : a.size === 'medium' ? 4 : 2;
    for (let i = 0; i < count; i++) {
      const t = now * 0.001 + i * 0.7;
      const phase = (Math.sin(t * 1.3 + i) + 1) * 0.5;
      const angle = (Math.PI * 2 * i) / count + t * 0.4;
      const dist = a.radius * (0.3 + 0.4 * Math.sin(t + i));
      const x = Math.cos(angle) * dist;
      const y = Math.sin(angle) * dist;
      ctx.fillStyle = '#ffd84a';
      ctx.shadowColor = '#ffd84a';
      ctx.shadowBlur = 8;
      ctx.globalAlpha = 0.5 + phase * 0.5;
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // Chondrite: short crystal accents at every other vertex — brittle look
  if (a.type === 'chondrite') {
    ctx.lineWidth = 0.8;
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = '#cfeaff';
    for (let i = 0; i < n; i += 2) {
      const angle = (Math.PI * 2 * i) / n;
      const r = a.radius * a.shape[i];
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      ctx.beginPath();
      ctx.moveTo(x * 0.9, y * 0.9);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Hit-flash overlay (white pulse on damage)
  if (a.hitFlash > 0) {
    ctx.globalAlpha = a.hitFlash * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(0, 0, a.radius * 0.85, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ── UFO ───────────────────────────────────────────────────────────────────────

/**
 * Per-type colour palette. `primary` for outlines, `accent` for windows /
 * highlights, `shadow` for darker fills. Boss runs hot — reds with gold core.
 */
const UFO_PALETTE: Record<Ufo['type'], { primary: string; accent: string; shadow: string; cockpit: string }> = {
  cruiser: { primary: '#ff8a3a', accent: '#ffd1a3', shadow: '#5a2d10', cockpit: '#ffe9c0' },
  elite:   { primary: '#ff5050', accent: '#ffd0d0', shadow: '#3d0808', cockpit: '#ff9090' },
  tank:    { primary: '#ff3a3a', accent: '#ff9a9a', shadow: '#330808', cockpit: '#ff7070' },
  sniper:  { primary: '#7fffea', accent: '#bfffff', shadow: '#08322e', cockpit: '#cffffd' },
  boss:    { primary: '#ff5050', accent: '#ffd84a', shadow: '#1a0303', cockpit: '#ffd84a' },
};

/** Draws an engine glow trail behind a moving UFO (in the opposite direction of travel). */
function drawEngineGlow(ctx: CanvasRenderingContext2D, dir: 1 | -1, x: number, y: number, len: number, colour: string, intensity = 1): void {
  const grad = ctx.createLinearGradient(x, y, x - dir * len, y);
  grad.addColorStop(0, `${colour}cc`);
  grad.addColorStop(0.5, `${colour}55`);
  grad.addColorStop(1, `${colour}00`);
  ctx.save();
  ctx.fillStyle = grad;
  ctx.shadowColor = colour;
  ctx.shadowBlur = 14 * intensity;
  ctx.globalAlpha = intensity;
  ctx.beginPath();
  ctx.moveTo(x, y - 3);
  ctx.lineTo(x - dir * len, y);
  ctx.lineTo(x, y + 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawUfo(ctx: CanvasRenderingContext2D, u: Ufo, now: number): void {
  if (!u.alive) return;
  const r = u.radius;
  const col = UFO_PALETTE[u.type];

  ctx.save();
  ctx.translate(u.pos.x, u.pos.y);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = col.primary;
  ctx.shadowColor = col.primary;
  ctx.shadowBlur = 12;

  if (u.type === 'tank') {
    const w = r * 2.6;
    const h = r * 1.2;
    // Filled hex body — radial gradient gives metal weight
    const bodyGrad = ctx.createRadialGradient(0, -h * 0.2, h * 0.2, 0, 0, w * 0.55);
    bodyGrad.addColorStop(0, col.accent);
    bodyGrad.addColorStop(0.55, col.primary);
    bodyGrad.addColorStop(1, col.shadow);
    const hexPts: [number, number][] = [
      [-w * 0.5, 0], [-w * 0.32, -h * 0.5], [w * 0.32, -h * 0.5],
      [w * 0.5, 0], [w * 0.32, h * 0.5], [-w * 0.32, h * 0.5],
    ];
    ctx.beginPath();
    hexPts.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
    ctx.closePath();
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.stroke();

    // Armour plate seams
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-w * 0.4, -h * 0.18); ctx.lineTo(w * 0.4, -h * 0.18);
    ctx.moveTo(-w * 0.4, h * 0.18);  ctx.lineTo(w * 0.4, h * 0.18);
    ctx.stroke();

    // Bolt rivets at hex vertices — small filled dots
    ctx.fillStyle = col.shadow;
    ctx.shadowBlur = 0;
    for (const [x, y] of hexPts) {
      ctx.beginPath();
      ctx.arc(x * 0.92, y * 0.92, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 12;

    // Three gun barrels along the bottom — protruding
    ctx.lineWidth = 2;
    ctx.strokeStyle = col.shadow;
    for (const gx of [-w * 0.35, 0, w * 0.35]) {
      ctx.beginPath();
      ctx.rect(gx - 1.5, h * 0.5, 3, 6);
      ctx.fill();
      ctx.stroke();
      // Charge-glow before firing
      if (u.shootTimer < 400) {
        const charge = 1 - u.shootTimer / 400;
        ctx.fillStyle = col.accent;
        ctx.shadowColor = col.primary;
        ctx.shadowBlur = 10 + charge * 6;
        ctx.globalAlpha = charge;
        ctx.beginPath();
        ctx.arc(gx, h * 0.5 + 7, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 12;
      }
      ctx.fillStyle = col.shadow;
    }
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col.primary;

    // Top turret with antenna
    ctx.beginPath();
    ctx.rect(-w * 0.1, -h * 0.5 - 5, w * 0.2, 5);
    ctx.fillStyle = col.primary;
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.5 - 5);
    ctx.lineTo(0, -h * 0.5 - 11);
    ctx.stroke();

    // Central viewport — wider glowing band that pulses, much more visible
    // than the old 12% slit. Reads as the "scanner" of the heavy ship.
    const tankPulse = 0.7 + 0.3 * Math.sin(u.blink * 3);
    const viewportGrad = ctx.createLinearGradient(-w * 0.18, 0, w * 0.18, 0);
    viewportGrad.addColorStop(0, col.shadow);
    viewportGrad.addColorStop(0.5, col.cockpit);
    viewportGrad.addColorStop(1, col.shadow);
    ctx.fillStyle = viewportGrad;
    ctx.shadowColor = col.cockpit;
    ctx.shadowBlur = 10 + tankPulse * 4;
    ctx.globalAlpha = 0.7 + tankPulse * 0.3;
    ctx.beginPath();
    ctx.rect(-w * 0.18, -h * 0.34, w * 0.36, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 12;
    // Single bright running light dead-centre — the hunter's eye
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = col.cockpit;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(0, -h * 0.32 + 2, 1.4 + tankPulse * 0.6, 0, Math.PI * 2);
    ctx.fill();

    // HP dots — scaled up
    ctx.shadowBlur = 0;
    for (let i = 0; i < u.hp; i++) {
      const x = -7 + i * 7;
      ctx.fillStyle = col.primary;
      ctx.beginPath();
      ctx.arc(x, h * 0.5 + 13, 2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (u.type === 'sniper') {
    // Sniper — slim hunter saucer with a single huge cyclops sensor eye and
    // long swept fins. The eye dominates the silhouette so the player reads
    // "this thing is locked on me" at a glance.
    const len = r * 2.8;
    const halfW = r * 0.85;
    ctx.scale(u.dir, 1);

    // Twin engine ribbons trailing behind
    drawEngineGlow(ctx, 1, -len * 0.46,  halfW * 0.35, len * 0.45, col.primary, 0.8);
    drawEngineGlow(ctx, 1, -len * 0.46, -halfW * 0.35, len * 0.45, col.primary, 0.8);

    // Body — sleek elongated lozenge with metal gradient
    const bodyGrad = ctx.createLinearGradient(-len * 0.5, 0, len * 0.5, 0);
    bodyGrad.addColorStop(0,    col.shadow);
    bodyGrad.addColorStop(0.5,  col.primary);
    bodyGrad.addColorStop(0.85, col.accent);
    bodyGrad.addColorStop(1,    col.shadow);
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(len * 0.50,  0);
    ctx.bezierCurveTo(len * 0.45, -halfW, -len * 0.20, -halfW, -len * 0.46, -halfW * 0.35);
    ctx.lineTo(-len * 0.46, halfW * 0.35);
    ctx.bezierCurveTo(-len * 0.20, halfW, len * 0.45, halfW, len * 0.50, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Long swept fins — give the silhouette a clear "predator" outline
    ctx.lineWidth = 1.2;
    ctx.fillStyle = col.shadow;
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(-len * 0.15, dir * halfW * 0.6);
      ctx.lineTo(-len * 0.32, dir * halfW * 1.85);
      ctx.lineTo( len * 0.05, dir * halfW * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.lineWidth = 1.5;

    // Cyclops sensor eye — the focal point. Pulses brighter as shootTimer
    // approaches zero (about-to-fire signal).
    const charge = u.shootTimer < 1200 ? Math.max(0, 1 - u.shootTimer / 1200) : 0;
    const eyePulse = 0.65 + 0.35 * Math.sin(u.blink * 4) + charge * 0.4;
    // Outer eye socket
    ctx.fillStyle = col.shadow;
    ctx.beginPath();
    ctx.arc(len * 0.28, 0, halfW * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Glowing iris
    const irisGrad = ctx.createRadialGradient(len * 0.28, 0, 0, len * 0.28, 0, halfW * 0.5);
    irisGrad.addColorStop(0, '#ffffff');
    irisGrad.addColorStop(0.4, col.cockpit);
    irisGrad.addColorStop(1, col.primary);
    ctx.fillStyle = irisGrad;
    ctx.shadowColor = col.cockpit;
    ctx.shadowBlur = 10 + eyePulse * 8;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(len * 0.28, 0, halfW * 0.4 * eyePulse, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowColor = col.primary;
    ctx.shadowBlur = 12;

    // Charging laser sight — line extends as shootTimer approaches 0
    if (charge > 0) {
      const sightLen = len * 1.5 * charge;
      ctx.strokeStyle = col.primary;
      ctx.shadowColor = col.primary;
      ctx.shadowBlur = 6;
      ctx.lineWidth = 0.8;
      ctx.globalAlpha = 0.4 + charge * 0.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(len * 0.5, 0);
      ctx.lineTo(len * 0.5 + sightLen, 0);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      if (u.shootTimer < 400) {
        ctx.fillStyle = col.primary;
        ctx.beginPath();
        ctx.arc(len * 0.5 + sightLen, 0, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (u.type === 'boss') {
    const t = u.blink * 1.4;

    // Faint outer shield bubble
    ctx.strokeStyle = col.primary;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.18 + 0.12 * Math.sin(t * 2);
    ctx.shadowBlur = 30;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.35, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Outer rotating ring with 8 gun ports
    ctx.save();
    ctx.rotate(t);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.1, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8;
      const x = Math.cos(a) * r * 1.1;
      const y = Math.sin(a) * r * 1.1;
      ctx.fillStyle = col.primary;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col.cockpit;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Counter-rotating inner ring
    ctx.save();
    ctx.rotate(-t * 0.7);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = col.primary;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.85, 0, Math.PI * 2);
    ctx.stroke();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * 2 * i) / 6;
      const x1 = Math.cos(a) * r * 0.85;
      const y1 = Math.sin(a) * r * 0.85;
      ctx.beginPath();
      ctx.moveTo(x1 * 0.95, y1 * 0.95);
      ctx.lineTo(x1 * 1.05, y1 * 1.05);
      ctx.stroke();
    }
    ctx.restore();

    // Body — filled ellipse with gradient
    const bodyGrad = ctx.createRadialGradient(0, -r * 0.2, r * 0.1, 0, 0, r * 0.9);
    bodyGrad.addColorStop(0, col.primary);
    bodyGrad.addColorStop(0.6, col.shadow);
    bodyGrad.addColorStop(1, '#000');
    ctx.fillStyle = bodyGrad;
    ctx.lineWidth = 2;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.9, r * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Inner pulsing core
    const pulse = 0.7 + 0.3 * Math.sin(t * 3);
    ctx.fillStyle = `rgba(255,216,74,${pulse * 0.7})`;
    ctx.shadowColor = col.cockpit;
    ctx.shadowBlur = 30;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.28 * pulse, 0, Math.PI * 2);
    ctx.fill();
    // Bright eye dot
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.07, 0, Math.PI * 2);
    ctx.fill();

    // Top dome
    ctx.shadowColor = col.primary;
    ctx.shadowBlur = 12;
    ctx.fillStyle = col.shadow;
    ctx.beginPath();
    ctx.arc(0, -r * 0.2, r * 0.35, Math.PI, 0);
    ctx.fill();
    ctx.stroke();

    // HP bar above with segment markers (every 5 HP)
    const hpFrac = u.hp / 25;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(-r * 0.95, -r - 16, r * 1.9, 7);
    ctx.fillStyle = '#ff5050';
    ctx.fillRect(-r * 0.95, -r - 16, r * 1.9 * hpFrac, 7);
    // Segment ticks at every 5 HP
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let s = 1; s < 5; s++) {
      const x = -r * 0.95 + (r * 1.9) * (s / 5);
      ctx.beginPath();
      ctx.moveTo(x, -r - 16);
      ctx.lineTo(x, -r - 9);
      ctx.stroke();
    }
    // Border
    ctx.strokeStyle = col.primary;
    ctx.strokeRect(-r * 0.95, -r - 16, r * 1.9, 7);
  } else if (u.type === 'elite') {
    // Elite — fast stealth saucer with twin engine pods. Reads as kin to the
    // cruiser (saucer body) but lower, sleeker, more dangerous.
    const w = r * 2.6;
    const h = r * 1.05;
    ctx.scale(u.dir, 1);

    // Twin engine plumes at the rear pods — twice the heat of cruiser
    drawEngineGlow(ctx, 1, -w * 0.45,  h * 0.18, w * 0.4, col.primary, 0.85);
    drawEngineGlow(ctx, 1, -w * 0.45, -h * 0.18, w * 0.4, col.primary, 0.85);

    // Lower hull — flatter ellipse with under-belly gradient
    const hullGrad = ctx.createRadialGradient(0, h * 0.3, h * 0.15, 0, 0, w * 0.55);
    hullGrad.addColorStop(0, col.accent);
    hullGrad.addColorStop(0.55, col.primary);
    hullGrad.addColorStop(1, col.shadow);
    ctx.beginPath();
    ctx.ellipse(0, h * 0.05, w * 0.5, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = hullGrad;
    ctx.fill();
    ctx.stroke();

    // Forward swept canopy — bigger than cruiser's, runs front to mid
    const canopyGrad = ctx.createLinearGradient(0, -h * 0.5, 0, 0);
    canopyGrad.addColorStop(0, col.cockpit);
    canopyGrad.addColorStop(1, col.shadow);
    ctx.fillStyle = canopyGrad;
    ctx.shadowColor = col.cockpit;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.moveTo(w * 0.42, h * 0.0);
    ctx.bezierCurveTo(w * 0.42, -h * 0.55, -w * 0.25, -h * 0.55, -w * 0.25, h * 0.0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Canopy reflection — thin highlight stripe
    ctx.shadowBlur = 0;
    ctx.strokeStyle = `${col.accent}cc`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(w * 0.34, -h * 0.18);
    ctx.bezierCurveTo(w * 0.30, -h * 0.42, -w * 0.10, -h * 0.42, -w * 0.18, -h * 0.18);
    ctx.stroke();
    ctx.strokeStyle = col.primary;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = col.primary;
    ctx.shadowBlur = 12;

    // Twin engine pods — small bulges at the rear, glowing intakes
    const t = u.blink * 5;
    for (const py of [-h * 0.2, h * 0.2]) {
      ctx.fillStyle = col.shadow;
      ctx.beginPath();
      ctx.ellipse(-w * 0.42, py, w * 0.08, h * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // Glowing intake at the leading edge of the pod
      const intakePulse = 0.6 + 0.4 * Math.sin(t * 2 + (py > 0 ? 0 : Math.PI));
      ctx.fillStyle = col.cockpit;
      ctx.shadowColor = col.cockpit;
      ctx.shadowBlur = 8 + intakePulse * 6;
      ctx.globalAlpha = 0.7 + intakePulse * 0.3;
      ctx.beginPath();
      ctx.arc(-w * 0.36, py, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.shadowColor = col.primary;
    ctx.shadowBlur = 12;

    // Underside running lights — three pulsing dots
    for (let i = 0; i < 3; i++) {
      const x = -w * 0.18 + i * w * 0.18;
      const phase = (Math.sin(t + i * 1.6) + 1) / 2;
      ctx.globalAlpha = 0.4 + phase * 0.5;
      ctx.fillStyle = col.cockpit;
      ctx.shadowColor = col.cockpit;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(x, h * 0.38, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    // Cruiser — classic saucer with proper weight
    const w = r * 2.4;
    const h = r * 1.0;

    // Engine glow at trailing edge
    drawEngineGlow(ctx, u.dir, -u.dir * w * 0.5, 0, w * 0.4, col.primary, 0.6);

    // Hull — radial gradient gives a chrome-belly look
    const bodyGrad = ctx.createRadialGradient(0, -h * 0.4, h * 0.1, 0, h * 0.2, w * 0.55);
    bodyGrad.addColorStop(0, col.accent);
    bodyGrad.addColorStop(0.5, col.primary);
    bodyGrad.addColorStop(1, col.shadow);
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.5, h * 0.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = bodyGrad;
    ctx.fill();
    ctx.stroke();

    // Equator ridge — single horizontal seam
    ctx.lineWidth = 1;
    ctx.strokeStyle = col.shadow;
    ctx.beginPath();
    ctx.moveTo(-w * 0.48, 0); ctx.lineTo(w * 0.48, 0);
    ctx.stroke();
    ctx.strokeStyle = col.primary;
    ctx.lineWidth = 1.5;

    // Top dome with cockpit window
    const domeGrad = ctx.createRadialGradient(0, -h * 0.45, 0, 0, -h * 0.3, w * 0.2);
    domeGrad.addColorStop(0, col.cockpit);
    domeGrad.addColorStop(1, col.shadow);
    ctx.fillStyle = domeGrad;
    ctx.shadowColor = col.cockpit;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, -h * 0.3, w * 0.2, Math.PI, 0);
    ctx.fill();
    ctx.stroke();

    // Underside porthole lights — slow round-robin blink
    ctx.shadowBlur = 8;
    const t = u.blink * 4;
    for (let i = 0; i < 5; i++) {
      const x = -w * 0.35 + (i / 4) * w * 0.7;
      const phase = Math.sin(t + i * 1.4);
      ctx.fillStyle = phase > 0 ? col.cockpit : col.shadow;
      ctx.beginPath();
      ctx.arc(x, h * 0.38, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Hit-flash overlay (white pulse on damage)
  if (u.hitFlash > 0) {
    ctx.globalAlpha = u.hitFlash * 0.7;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.9, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
  void now;  // future-proof: reserved for animation timing
}

// ── Mines ─────────────────────────────────────────────────────────────────────

function drawMine(ctx: CanvasRenderingContext2D, m: Mine, now: number): void {
  if (!m.alive) return;
  const t = m.age * 0.001;
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.005);

  ctx.save();
  ctx.translate(m.pos.x, m.pos.y);

  // Faint gravity well rings (animated outward)
  ctx.lineWidth = 1;
  for (let i = 0; i < 3; i++) {
    const phase = ((t * 0.5 + i / 3) % 1);
    const r = m.gravityRange * phase;
    const alpha = (1 - phase) * 0.18;
    ctx.strokeStyle = `rgba(255, 80, 80, ${alpha})`;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Core (dark sphere with pulsing red)
  ctx.shadowColor = '#ff5050';
  ctx.shadowBlur = 14 + pulse * 8;
  ctx.fillStyle = '#1a0808';
  ctx.beginPath();
  ctx.arc(0, 0, m.radius, 0, Math.PI * 2);
  ctx.fill();

  // Pulsing red ring
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = `rgba(255, 80, 80, ${0.6 + pulse * 0.4})`;
  ctx.beginPath();
  ctx.arc(0, 0, m.radius, 0, Math.PI * 2);
  ctx.stroke();

  // Spike pattern
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI * 2 * i) / 6 + t * 0.3;
    const x1 = Math.cos(a) * (m.radius - 2);
    const y1 = Math.sin(a) * (m.radius - 2);
    const x2 = Math.cos(a) * (m.radius + 4);
    const y2 = Math.sin(a) * (m.radius + 4);
    ctx.strokeStyle = `rgba(255, 80, 80, ${0.7 + pulse * 0.3})`;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  // Hit flash
  if (m.hitFlash > 0) {
    ctx.globalAlpha = m.hitFlash;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, m.radius * 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ── Bullets ───────────────────────────────────────────────────────────────────

function drawBullet(ctx: CanvasRenderingContext2D, b: Bullet, friendly: boolean): void {
  if (!b.alive) return;
  const speed = Math.hypot(b.vel.x, b.vel.y);
  const len = Math.max(6, speed * 0.012);
  const ux = b.vel.x / speed;
  const uy = b.vel.y / speed;
  ctx.save();
  ctx.lineWidth = friendly ? 2.2 : 2.6;
  ctx.strokeStyle = friendly ? '#ff5050' : '#ffffff';
  ctx.shadowColor = friendly ? '#ff5050' : '#ff6a00';
  ctx.shadowBlur = friendly ? 10 : 14;
  ctx.beginPath();
  ctx.moveTo(b.pos.x - ux * len * 0.5, b.pos.y - uy * len * 0.5);
  ctx.lineTo(b.pos.x + ux * len * 0.5, b.pos.y + uy * len * 0.5);
  ctx.stroke();
  // Centre dot for enemy bullets — makes them feel hotter
  if (!friendly) {
    ctx.fillStyle = '#ffd84a';
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── Coin ──────────────────────────────────────────────────────────────────────

function drawCoin(ctx: CanvasRenderingContext2D, c: Coin, now: number): void {
  if (!c.alive || c.collected) return;
  const fadeIn = c.ttl > 7000 ? Math.min(1, (8000 - c.ttl) / 200) : 1;
  const fadeOut = c.ttl < 1500 ? c.ttl / 1500 : 1;
  const alpha = fadeIn * fadeOut;

  if (c.kind === 'sat') {
    const wobble = 1 + 0.08 * Math.sin(now * 0.008 + c.pos.x);
    ctx.save();
    ctx.translate(c.pos.x, c.pos.y);
    ctx.scale(wobble, 1 / wobble);
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#ffd84a';
    ctx.shadowColor = '#ffd84a';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, 0, c.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#ffd84a';
    ctx.font = `bold ${c.radius + 2}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('₿', 0, 0);
    ctx.restore();
    return;
  }

  // Dust shard — peridot crystal in green-gold, slowly tumbling. Diamond
  // outline + inner cross suggests a polished gem facet rather than a coin.
  const tumble = now * 0.003 + c.pos.x * 0.02;
  ctx.save();
  ctx.translate(c.pos.x, c.pos.y);
  ctx.rotate(tumble);
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#7fffb0';
  ctx.shadowColor = '#7fffb0';
  ctx.shadowBlur = 9;
  const r = c.radius * 0.95;
  // Diamond / rhombus outline
  ctx.beginPath();
  ctx.moveTo(0, -r);
  ctx.lineTo(r * 0.78, 0);
  ctx.lineTo(0, r);
  ctx.lineTo(-r * 0.78, 0);
  ctx.closePath();
  ctx.stroke();
  // Inner facet cross — refraction lines
  ctx.lineWidth = 0.9;
  ctx.globalAlpha = alpha * 0.6;
  ctx.beginPath();
  ctx.moveTo(0, -r * 0.6);
  ctx.lineTo(0, r * 0.6);
  ctx.moveTo(-r * 0.5, 0);
  ctx.lineTo(r * 0.5, 0);
  ctx.stroke();
  ctx.restore();
}

// ── Power-up ──────────────────────────────────────────────────────────────────

function drawPowerUp(ctx: CanvasRenderingContext2D, p: PowerUp, now: number): void {
  if (!p.alive || p.collected) return;
  const cfg = POWERUP_CONFIG[p.type];
  const fadeOut = p.ttl < 2000 ? p.ttl / 2000 : 1;
  const pulse = 0.85 + 0.25 * Math.sin(now * 0.008);
  const flash = (Math.sin(now * 0.012) + 1) * 0.5;  // 0..1 for blink overlay

  ctx.save();
  ctx.translate(p.pos.x, p.pos.y);
  ctx.globalAlpha = fadeOut;

  // Expanding tracer ring — pulses outward to draw the eye
  const trace = (now * 0.001) % 1.5;
  const tracePhase = (trace / 1.5) % 1;
  const traceR = p.radius + tracePhase * 24;
  ctx.strokeStyle = cfg.colour;
  ctx.shadowColor = cfg.colour;
  ctx.shadowBlur = 12;
  ctx.lineWidth = 1.4;
  ctx.globalAlpha = fadeOut * (1 - tracePhase) * 0.7;
  ctx.beginPath();
  ctx.arc(0, 0, traceR, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = fadeOut;

  // Outer halo — bigger, brighter
  ctx.shadowBlur = 20;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, p.radius * pulse, 0, Math.PI * 2);
  ctx.stroke();

  // Inner disc — semi-opaque fill
  ctx.fillStyle = `${cfg.colour}55`;
  ctx.shadowBlur = 14;
  ctx.beginPath();
  ctx.arc(0, 0, p.radius * 0.85, 0, Math.PI * 2);
  ctx.fill();

  // Hot core — bright centre
  ctx.fillStyle = `rgba(255,255,255,${0.4 + flash * 0.3})`;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(0, 0, p.radius * 0.4, 0, Math.PI * 2);
  ctx.fill();

  // Glyph — large + bold
  ctx.fillStyle = '#000';
  ctx.shadowBlur = 0;
  ctx.font = 'bold 18px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(cfg.glyph, 0, 0);

  ctx.restore();
}

// ── Particles ─────────────────────────────────────────────────────────────────

/**
 * Batched particle render. Caller wraps a single save/restore around the loop
 * so we don't push/pop the canvas state per particle. shadowBlur is omitted
 * entirely — at small sizes it costs ~10× the actual fill and makes no visible
 * difference. Particles below alpha 0.05 are skipped (invisible anyway).
 */
/**
 * Render line-segment debris from the ship explosion. One save/restore for
 * the lot; per-piece transform via translate + rotate. Fade with TTL.
 */
function drawDebris(ctx: CanvasRenderingContext2D, debris: ReadonlyArray<Debris>): void {
  if (debris.length === 0) return;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.6;
  ctx.shadowBlur = 0;
  for (const d of debris) {
    const alpha = Math.max(0, Math.min(1, d.ttl / d.maxTtl));
    if (alpha < 0.05) continue;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = d.colour;
    ctx.save();
    ctx.translate(d.pos.x, d.pos.y);
    ctx.rotate(d.rot);
    const half = d.length / 2;
    ctx.beginPath();
    ctx.moveTo(-half, 0);
    ctx.lineTo(half, 0);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawParticles(ctx: CanvasRenderingContext2D, particles: ReadonlyArray<Particle>): void {
  if (particles.length === 0) return;
  ctx.save();
  ctx.shadowBlur = 0;
  let lastColour: string | null = null;
  let lastAlpha = -1;
  for (const p of particles) {
    const alpha = p.ttl / p.maxTtl;
    if (alpha < 0.05) continue;
    // Avoid re-setting fillStyle / globalAlpha when consecutive particles match
    if (p.colour !== lastColour) { ctx.fillStyle = p.colour; lastColour = p.colour; }
    if (alpha !== lastAlpha) { ctx.globalAlpha = alpha; lastAlpha = alpha; }
    ctx.beginPath();
    ctx.arc(p.pos.x, p.pos.y, p.size * (0.5 + 0.5 * alpha), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ── HUD ───────────────────────────────────────────────────────────────────────

function pad(n: number, len: number): string {
  return n.toString().padStart(len, '0');
}

function drawHud(ctx: CanvasRenderingContext2D, s: GameState, now: number): void {
  ctx.save();
  ctx.font = '24px ui-monospace, monospace';
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#58ff58';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('SCORE', 24, 16);
  ctx.fillText(pad(s.score, 6), 24, 42);

  // Combo + buff chips — stacked under SCORE
  let chipY = 76;
  function drawChip(label: string, remaining: number, totalMs: number, colour: string): void {
    const fade = Math.min(1, remaining / 600);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = colour;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 10;
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.fillText(label, 24, chipY);
    const barW = 80;
    const frac = Math.min(1, remaining / totalMs);
    ctx.fillStyle = `rgba(255,255,255,0.15)`;
    ctx.fillRect(24, chipY + 22, barW, 3);
    ctx.fillStyle = colour;
    ctx.fillRect(24, chipY + 22, barW * frac, 3);
    ctx.restore();
    chipY += 32;
  }

  if (s.combo >= 2) {
    const remaining = Math.max(0, s.comboExpiresAt - now);
    const colour = s.combo >= 5 ? '#ffd84a' : s.combo >= 4 ? '#ff8a3a' : '#5b9dff';
    drawChip(`×${s.combo}  CHAIN`, remaining, 3000, colour);
  }
  if (now < s.rapidExpiresAt) {
    drawChip('⚡ RAPID', s.rapidExpiresAt - now, 8000, '#ff8a3a');
  }
  if (now < s.satboostExpiresAt) {
    drawChip('₿ ×2 SATS', s.satboostExpiresAt - now, 12000, '#ffd84a');
  }
  if (now < s.tridentExpiresAt) {
    drawChip('⋔ TRIDENT', s.tridentExpiresAt - now, 6000, '#ffd84a');
  }
  if (now < s.magnetExpiresAt) {
    drawChip('◎ MAGNET', s.magnetExpiresAt - now, 8000, '#5b9dff');
  }
  if (s.lurking) {
    // Persistent indicator — no countdown, so render a steady chip without
    // the time-bar (passing big remaining/total pair keeps the bar full).
    // Guest mode wording: there are no sats to forfeit, so the homage angle
    // alone stands. Nostr mode keeps the sat-loss reminder explicit.
    const label = s.session ? 'LURK · NO SATS' : 'LURK · 1979 RESPECT';
    drawChip(label, 1, 1, '#ff5050');
  }
  if (s.cheatedThisRun) {
    // Loud and persistent — once cheated, the run is tainted for sats and
    // any score publish carries the flag.
    drawChip('CHEATED · SATS VOID', 1, 1, '#ff5050');
  }

  // Sats column only appears in Nostr mode — guest runs are score-only.
  if (s.session) {
    ctx.fillStyle = '#ffd84a';
    ctx.textAlign = 'center';
    ctx.fillText('SATS', WORLD_W * 0.32, 16);
    ctx.fillText('₿ ' + pad(Math.floor(s.displaySats), 6), WORLD_W * 0.32, 42);
  }

  ctx.fillStyle = '#5b9dff';
  ctx.fillText('WAVE', WORLD_W * 0.62, 16);
  ctx.fillText(pad(s.wave, 2), WORLD_W * 0.62, 42);

  ctx.fillStyle = '#58ff58';
  ctx.textAlign = 'right';
  ctx.fillText('LIVES', WORLD_W - 24, 16);
  for (let i = 0; i < s.lives; i++) {
    const x = WORLD_W - 24 - i * 22;
    const y = 56;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-Math.PI / 2);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#58ff58';
    ctx.shadowColor = '#58ff58';
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.moveTo(8, 0);
    ctx.lineTo(-6, 5);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-6, -5);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

/**
 * Wave-clear cinematic. Sequence over the 4000ms `wavestart` phase (skippable
 * after 900ms via tap/key):
 *   0–400ms     silence — no banner
 *   400–700ms   fade in
 *   700–3500ms  hold (chime + name + lore visible, music ducked)
 *   3500–3800ms fade out
 *   3800–4000ms held black before action resumes
 */
function drawWaveBanner(ctx: CanvasRenderingContext2D, s: GameState, now: number): void {
  if (s.phase !== 'wavestart') return;
  const elapsed = now - s.phaseStart;
  const REVEAL_AT = 400;
  const FADE_IN = 300;
  const HOLD_END = 3500;
  const FADE_OUT = 300;
  if (elapsed < REVEAL_AT) return;
  const t = elapsed - REVEAL_AT;
  let alpha: number;
  if (t < FADE_IN) alpha = t / FADE_IN;
  else if (t < HOLD_END - REVEAL_AT) alpha = 1;
  else if (t < HOLD_END - REVEAL_AT + FADE_OUT) alpha = 1 - (t - (HOLD_END - REVEAL_AT)) / FADE_OUT;
  else return;
  alpha = Math.max(0, Math.min(1, alpha));

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Dim the wave-image background behind the cinematic so text stays readable
  // regardless of which specimen photo is loaded. Sits below all text.
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, WORLD_H / 2 - 130, WORLD_W, 240);
  ctx.globalAlpha = alpha;

  // Subtle horizontal accent line behind the title — a faint heraldic bar
  ctx.strokeStyle = '#5b9dff';
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 12;
  ctx.globalAlpha = alpha * 0.45;
  ctx.lineWidth = 1;
  const lineY = WORLD_H / 2 + 4;
  const reach = 220;
  ctx.beginPath();
  ctx.moveTo(WORLD_W / 2 - reach, lineY);
  ctx.lineTo(WORLD_W / 2 + reach, lineY);
  ctx.stroke();
  ctx.globalAlpha = alpha;

  // Wave number — bigger, more confident
  ctx.font = 'bold 72px ui-monospace, monospace';
  ctx.fillStyle = '#5b9dff';
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 22;
  ctx.fillText(`WAVE ${s.wave}`, WORLD_W / 2, WORLD_H / 2 - 30);

  // Pallasite specimen name — heraldic yellow
  ctx.font = 'bold 28px ui-monospace, monospace';
  ctx.fillStyle = '#ffd84a';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 14;
  ctx.letterSpacing = '0.18em' as unknown as string;
  ctx.fillText(waveName(s.wave), WORLD_W / 2, WORLD_H / 2 + 38);

  // One-line specimen lore — bright cream over a darker backing strip so it
  // reads against any wave image. Was soft purple, hard to read on warm bgs.
  const lore = waveSubtitle(s.wave);
  if (lore) {
    ctx.font = '16px ui-monospace, monospace';
    ctx.fillStyle = '#fff5d8';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 1;
    ctx.letterSpacing = '0.06em' as unknown as string;
    ctx.fillText(lore, WORLD_W / 2, WORLD_H / 2 + 72);
    ctx.shadowOffsetY = 0;
  }

  ctx.restore();
}

// ── Warp transition ───────────────────────────────────────────────────────────

interface WarpStar { angle: number; depth: number; speed: number; }
let warpStars: WarpStar[] | null = null;

function ensureWarpStars(): WarpStar[] {
  if (warpStars) return warpStars;
  warpStars = [];
  for (let i = 0; i < 90; i++) {
    warpStars.push({
      angle: Math.random() * Math.PI * 2,
      depth: Math.random() * 0.05,
      speed: 1 + Math.random() * 1.5,
    });
  }
  return warpStars;
}

function drawWarp(ctx: CanvasRenderingContext2D, s: GameState, now: number): void {
  ctx.save();
  // Black-fill the entire canvas first (in canvas-pixel coords) so modern-mode
  // letterbox gutters don't expose the body bg through the warp tunnel.
  if (renderMode.kind === 'modern') {
    ctx.save();
    ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, renderMode.vw, renderMode.vh);
    ctx.restore();
  }
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const elapsed = (now - s.phaseStart) / WARP_MS;  // 0..1 across phase
  const progress = Math.min(1, elapsed);
  const intensity = Math.sin(progress * Math.PI);  // ease in/out

  const list = ensureWarpStars();
  ctx.lineCap = 'round';
  for (const st of list) {
    st.depth += st.speed * 0.025 * (1 + intensity * 4);
    if (st.depth > 1) {
      st.depth = 0.02;
      st.angle = Math.random() * Math.PI * 2;
    }
    const reach = st.depth * Math.max(WORLD_W, WORLD_H) * 0.7;
    const reachPrev = Math.max(0.001, (st.depth - 0.04) * Math.max(WORLD_W, WORLD_H) * 0.7);
    const x1 = cx + Math.cos(st.angle) * reachPrev;
    const y1 = cy + Math.sin(st.angle) * reachPrev;
    const x2 = cx + Math.cos(st.angle) * reach;
    const y2 = cy + Math.sin(st.angle) * reach;

    const alpha = Math.min(1, st.depth * 4);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = '#ffffff';
    ctx.shadowColor = '#5b9dff';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 0.8 + st.depth * 2;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // Banner
  const bannerAlpha = progress < 0.3 ? progress / 0.3 : progress > 0.7 ? (1 - progress) / 0.3 : 1;
  ctx.globalAlpha = Math.max(0, bannerAlpha);
  ctx.font = 'bold 48px ui-monospace, monospace';
  ctx.fillStyle = '#5b9dff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 20;
  ctx.fillText(`PLOTTING WAVE ${s.warpTargetWave}`, cx, cy - 16);
  ctx.font = 'bold 22px ui-monospace, monospace';
  ctx.fillStyle = '#ffd84a';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 16;
  ctx.fillText(waveName(s.warpTargetWave), cx, cy + 18);
  // Specimen lore on the warp banner too — sets up the wave before it lands.
  const warpLore = waveSubtitle(s.warpTargetWave);
  if (warpLore) {
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = '#b48cff';
    ctx.shadowColor = '#b48cff';
    ctx.shadowBlur = 8;
    ctx.fillText(warpLore, cx, cy + 48);
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(180,140,255,0.7)';
    ctx.shadowBlur = 4;
    ctx.fillText('HOLD COURSE…', cx, cy + 76);
  } else {
    ctx.font = '18px ui-monospace, monospace';
    ctx.fillStyle = '#b48cff';
    ctx.shadowColor = '#b48cff';
    ctx.fillText('HOLD COURSE…', cx, cy + 50);
  }

  ctx.restore();
}

// ── Death replay ─────────────────────────────────────────────────────────────

/**
 * Map replay wall-clock elapsed → captured-game-time. The replay plays the
 * first `spanMs - REPLAY_SLOW_MS` of footage at 1.0x, then the final
 * REPLAY_SLOW_MS at REPLAY_SLOW_RATE (0.4x) for cinematic emphasis on the
 * killing moment. Returns clamped game-time.
 */
function replayGameTime(spanMs: number, wallElapsed: number): number {
  const slowGameTime = Math.min(REPLAY_SLOW_MS, spanMs);
  const fastGameTime = Math.max(0, spanMs - slowGameTime);
  const fastWall = fastGameTime;  // 1.0x
  if (wallElapsed < fastWall) return wallElapsed;
  const slowWall = (wallElapsed - fastWall);
  // Allow gameTime to exceed spanMs by up to REPLAY_EXPLOSION_MS — that tail
  // is the synthetic explosion bloom (drawn outside the snapshot stream).
  return Math.min(spanMs + REPLAY_EXPLOSION_MS, fastGameTime + slowWall * REPLAY_SLOW_RATE);
}

function pickSnapshot(snapshots: ReplaySnapshot[], gameTime: number): ReplaySnapshot {
  const baseT = snapshots[0].t;
  const targetT = baseT + gameTime;
  // Snapshots are time-ordered; reverse-scan for the latest <= target.
  for (let i = snapshots.length - 1; i >= 0; i--) {
    if (snapshots[i].t <= targetT) return snapshots[i];
  }
  return snapshots[0];
}

function drawReplay(ctx: CanvasRenderingContext2D, state: GameState, now: number): void {
  const dr = state.deathReplay;
  if (!dr || dr.snapshots.length === 0) return;

  drawBackground(ctx, state, now);
  drawStars(ctx, now);

  const wallElapsed = now - dr.startedAt;
  const gameTime = replayGameTime(dr.spanMs, wallElapsed);
  const snap = pickSnapshot(dr.snapshots, gameTime);

  for (const a of snap.asteroids) drawAsteroid(ctx, a, now);
  for (const m of snap.mines) drawMine(ctx, m, now);
  for (const u of snap.ufos) drawUfo(ctx, u, now);
  for (const b of snap.bullets) drawBullet(ctx, b, true);
  for (const b of snap.enemyBullets) drawBullet(ctx, b, false);
  // Reuse the live ship draw for thrust flame consistency. Shield/cloak skipped
  // (the replay isn't a re-sim, just a playback). Stop drawing the ship once
  // we've crossed the impact frame — the explosion has consumed it, debris is
  // animating; an intact ship floating in the middle of the boom looks wrong.
  if (snap.ship.alive && gameTime < dr.spanMs) {
    const fauxShip: Ship = {
      pos: snap.ship.pos, vel: { x: 0, y: 0 }, radius: 12, alive: true,
      rot: snap.ship.rot, rotVel: 0, thrusting: snap.ship.thrusting,
      invulnerableUntil: 0, thrustFrame: now / 80,
      hyperspaceReadyAt: 0, hyperspaceCloakMs: 0, hyperspaceMalfunction: false,
      shieldUp: false, shieldExpiresAt: 0, shieldReadyAt: 0,
    };
    drawShip(ctx, fauxShip, now);
  }

  // Real death-explosion: particles + ship debris that updateGame re-spawns
  // when replay-time crosses the impact frame. Same composition as killShip
  // during live play so the cinematic matches exactly. The synthetic ring
  // overlay is gone — particles + debris carry the moment.
  drawParticles(ctx, state.particles);
  drawDebris(ctx, state.debris);

  // Red vignette — softer at the centre, stronger at the edges
  const grad = ctx.createRadialGradient(WORLD_W / 2, WORLD_H / 2, 180, WORLD_W / 2, WORLD_H / 2, 620);
  grad.addColorStop(0, 'rgba(255, 80, 80, 0)');
  grad.addColorStop(1, 'rgba(120, 0, 0, 0.42)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // Slow-mo indicator — small "0.4x" mark when in the slow segment
  const slowGameTime = Math.min(REPLAY_SLOW_MS, dr.spanMs);
  const fastGameTime = Math.max(0, dr.spanMs - slowGameTime);
  const inSlow = gameTime > fastGameTime;

  ctx.save();
  ctx.fillStyle = '#ff5050';
  ctx.shadowColor = '#ff5050';
  ctx.shadowBlur = 14;
  ctx.font = 'bold 16px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('· REPLAY · ANY KEY TO SKIP ·', WORLD_W / 2, WORLD_H - 36);
  if (inSlow) {
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd84a';
    ctx.shadowColor = '#ffd84a';
    ctx.fillText('×0.4', WORLD_W - 24, WORLD_H - 36);
  }
  ctx.restore();
}

// ── Main render ───────────────────────────────────────────────────────────────

export function render(canvas: HTMLCanvasElement, state: GameState, now: number): void {
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (state.phase === 'warp') {
    drawWarp(ctx, state, now);
    return;
  }

  if (state.phase === 'deathreplay') {
    drawReplay(ctx, state, now);
    return;
  }

  drawBackground(ctx, state, now);
  drawStars(ctx, now);

  // Ghost-render offsets — when modern mode crops the world (cover-scale in
  // portrait), the on-screen wrap distance is the visible window, not the
  // 960×720 world. Drawing every entity at ±visibleWorld offsets makes the
  // wrap appear seamless at the visible edges. Game logic still wraps at
  // WORLD_W/WORLD_H so collisions stay consistent — these are render-only.
  const ghostXs: number[] = [0];
  const ghostYs: number[] = [0];
  if (renderMode.kind === 'modern') {
    const visW = renderMode.vw / renderMode.scale;
    const visH = renderMode.vh / renderMode.scale;
    if (visW < WORLD_W - 1) ghostXs.push(-visW, visW);
    if (visH < WORLD_H - 1) ghostYs.push(-visH, visH);
  }

  for (const dx of ghostXs) {
    for (const dy of ghostYs) {
      const isGhost = dx !== 0 || dy !== 0;
      if (isGhost) { ctx.save(); ctx.translate(dx, dy); }
      for (const a of state.asteroids) drawAsteroid(ctx, a, now);
      for (const m of state.mines) drawMine(ctx, m, now);
      for (const u of state.ufos) drawUfo(ctx, u, now);
      for (const b of state.bullets) drawBullet(ctx, b, true);
      for (const b of state.enemyBullets) drawBullet(ctx, b, false);
      for (const c of state.coins) drawCoin(ctx, c, now);
      for (const p of state.powerups) drawPowerUp(ctx, p, now);
      drawParticles(ctx, state.particles);
      drawDebris(ctx, state.debris);
      drawShield(ctx, state.ship, now);
      drawShip(ctx, state.ship, now);
      if (isGhost) ctx.restore();
    }
  }

  drawHud(ctx, state, now);
  drawWaveBanner(ctx, state, now);
}
