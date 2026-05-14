/**
 * Vector renderer for the game world.
 *
 * Pure Canvas 2D — line strokes, mostly. Per-wave procedural backgrounds with
 * an opt-in override hook for /backgrounds/wave-N.png if the consumer drops in
 * generated art.
 */

import type {
  GameState, Ship, Asteroid, AsteroidType, Bullet, Coin, Particle, Ufo, Mine, PowerUp, ReplaySnapshot, Debris,
} from './types.js';
import {
  WORLD_W, WORLD_H, WARP_MS, waveName, waveSubtitle, waveTagline, POWERUP_CONFIG,
  REPLAY_SLOW_MS, REPLAY_SLOW_RATE, REPLAY_EXPLOSION_MS, COMBO_MAX,
} from './types.js';
import { getCachedGhost, ghostScoreAt, ghostPoseAt } from './ghost.js';
import { getActiveSeed } from './seed.js';
import { getAsteroidStyle, shouldReduceMotion } from './a11y.js';
import { getActiveSkin } from './skins.js';
import { getMemberImage } from './sanctum-avatars.js';
import { getFlavour } from './flavour.js';
import { getVisualStyle, isWebGLOverlayReady, callWebGLOverlay } from './visual-style.js';

// ── Stars ─────────────────────────────────────────────────────────────────────

const STAR_COUNT = 110;
const stars: { x: number; y: number; r: number; flickerPhase: number; depth: number; vx: number; vy: number }[] = [];

(function initStars() {
  for (let i = 0; i < STAR_COUNT; i++) {
    const depth = Math.random();
    // Parallax drift — deeper stars move faster (closer to camera).
    // vx/vy are in world-units per second; px/s. Angle picked once;
    // direction has a slight downward bias so the field reads as
    // "rain of sats falling past the camera" rather than directionless.
    const speed = 6 + depth * 28;
    const ang = Math.PI / 2 + (Math.random() - 0.5) * 1.4;  // mostly downward, ±40°
    stars.push({
      x: Math.random() * WORLD_W,
      y: Math.random() * WORLD_H,
      r: 0.5 + depth * 1.6,
      flickerPhase: Math.random() * Math.PI * 2,
      depth,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
    });
  }
})();

// (Bitcoin starfield overlay removed — felt cluttered. Bitcoin debris
//  now comes from broken council asteroids via drawCoin's 600bn
//  branch, which gives the bitcoin motif a clearer purpose tied to
//  the gameplay loop instead of competing as a background layer.)

function drawStars(ctx: CanvasRenderingContext2D, t: number): void {
  // Plain star points — same on all flavours. The previous 600bn
  // bitcoin overlay felt cluttered; bitcoins now spawn from broken
  // council asteroids instead (see drawCoin's 600bn branch).
  ctx.save();
  for (const s of stars) {
    const flick = 0.5 + 0.5 * Math.sin(t * 0.001 + s.flickerPhase);
    ctx.globalAlpha = (0.25 + s.depth * 0.6) * (0.55 + flick * 0.45);
    {
      ctx.fillStyle = '#cfd6ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
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
/** Resolve the background URL for a wave. 600bn flavour overrides
 *  wave 1 to use the bespoke sanctum-space.webp (Hubble + JWST style
 *  ember nebula + golden spiral galaxy) instead of the campaign's
 *  wave-1 deep-space shot. */
function backgroundUrlForWave(wave: number): string {
  if (wave === 1 && getFlavour() === '600bn') return '/backgrounds/sanctum-space.webp';
  return `/backgrounds/wave-${wave}.webp`;
}

export function preloadBackground(wave: number): void {
  if (overrideImages.has(wave)) return;
  overrideImages.set(wave, 'pending');
  const img = new Image();
  img.onload = () => overrideImages.set(wave, img);
  img.onerror = () => overrideImages.set(wave, 'failed');
  img.src = backgroundUrlForWave(wave);
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
  document.body.style.backgroundImage = key ? `url(${backgroundUrlForWave(wave)})` : '';
}

/** Safe-area insets in CSS pixels. Zero on desktop and Android without notch;
 *  non-zero on iPhone X+ where the canvas extends under the Dynamic Island /
 *  rounded corners (we use viewport-fit=cover so the canvas does cover them). */
export interface SafeInsets { top: number; right: number; bottom: number; left: number; }
const ZERO_INSETS: SafeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

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
  insets: SafeInsets;
}
let renderMode: RenderModeInfo = { kind: 'retro', vw: 960, vh: 720, dpr: 1, scale: 1, tx: 0, ty: 0, insets: ZERO_INSETS };
export function setRenderMode(info: RenderModeInfo): void { renderMode = info; }
export function getRenderModeKind(): 'retro' | 'modern' { return renderMode.kind; }

/**
 * Effective wrap distance for collisions. In modern portrait mode the canvas
 * shows a cropped slice of the 960×720 world and we ghost-render entities at
 * ±visW so the wrap appears seamless to the player. Collisions must use the
 * same shorter wrap distance — otherwise a bullet aimed at a visible ghost
 * asteroid passes through it because the real entity sits one full visW away
 * in world coordinates. Returns world dimensions for retro/landscape, where
 * the visible band already covers the world.
 */
export function getCollisionWrap(): { w: number; h: number } {
  if (renderMode.kind !== 'modern') return { w: WORLD_W, h: WORLD_H };
  const visW = renderMode.vw / renderMode.scale;
  const visH = renderMode.vh / renderMode.scale;
  return {
    w: Math.min(WORLD_W, visW),
    h: Math.min(WORLD_H, visH),
  };
}

/**
 * Visible world bounds for the current render mode. Used by entity spawn
 * logic that wants to enter/exit the visible band cleanly: in modern
 * portrait the world is wider than the band, so spawning at world-edge
 * (x=-radius) hides the entity off-screen for seconds AND the +visW ghost
 * pops it into the middle of the visible band immediately. UFOs and other
 * "drift across the screen" entities should spawn at the band edge instead.
 *
 * Retro mode returns the full world rect (band == world). Modern landscape
 * with visW>=WORLD_W also returns the full world (no horizontal crop).
 * Modern portrait crop on iPhone returns the narrower visible band.
 */
export function getVisibleBoundsW(): { left: number; right: number; top: number; bottom: number } {
  if (renderMode.kind !== 'modern') return { left: 0, right: WORLD_W, top: 0, bottom: WORLD_H };
  const visLeft = -renderMode.tx / renderMode.scale;
  const visRight = (renderMode.vw - renderMode.tx) / renderMode.scale;
  const visTop = -renderMode.ty / renderMode.scale;
  const visBot = (renderMode.vh - renderMode.ty) / renderMode.scale;
  return {
    left: Math.max(0, visLeft),
    right: Math.min(WORLD_W, visRight),
    top: Math.max(0, visTop),
    bottom: Math.min(WORLD_H, visBot),
  };
}

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
      // Wave images vary wildly in luminosity — wave 15 (Itzawisis) and
      // wave 25 (Event Horizon) in particular wash out the asteroid line
      // art on phones. A flat black overlay knocks the brightest cases
      // back without making the dim ones look starved. 0.32 was tuned by
      // eye against wave 15 + 25.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.fillRect(0, 0, renderMode.vw, renderMode.vh);
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
    // Same darkening as modern — bright wave images need a knock-back so
    // the asteroid outlines don't disappear into the bg.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.32)';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
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

function drawShip(ctx: CanvasRenderingContext2D, ship: Ship, now: number, idleSway = false): void {
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

  const skin = getActiveSkin().palette;

  const shipTier = getVisualStyle('ship');
  // MESH ship draws on the WebGL overlay; skip the 2D path entirely
  // once the overlay's loaded so the player sees the 3D mesh alone.
  if (shipTier === 'mesh' && isWebGLOverlayReady()) return;
  // MESH falls back to SHADED rendering while the overlay is loading,
  // and SHADED itself is the lit gradient hull.
  const shipShaded = shipTier !== 'vector';

  ctx.save();
  // Idle sway — gentle bob + tilt applied in screen space (before the rotate)
  // so it reads as a wobble around the resting frame, not a roll along the
  // ship's own axis. Title and wavestart only — never during play.
  const swayDy = idleSway ? Math.sin(now * 0.0008) * 2 : 0;
  const swayRot = idleSway ? Math.sin(now * 0.0006) * 0.05 : 0;
  ctx.translate(ship.pos.x, ship.pos.y + swayDy);
  // SHADED tier: drop shadow under the ship, BEFORE the rotate so the
  // shadow stays put on the "floor" regardless of the ship's facing.
  if (shipShaded) {
    const sg = ctx.createRadialGradient(2, 5, 2, 2, 5, 16);
    sg.addColorStop(0, 'rgba(0,0,0,0.45)');
    sg.addColorStop(0.6, 'rgba(0,0,0,0.18)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(2, 5, 16, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.rotate(ship.rot + swayRot);
  // Visual recoil kick on fire — slides the ship back along its facing while
  // the offset decays. Pure render effect, doesn't affect physics or aim.
  if (ship.recoilOffset > 0) ctx.translate(-ship.recoilOffset, 0);
  // Build the ship hull path once — both VECTOR and SHADED tiers use it.
  const hullPath = (): void => {
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-10, 8);
    ctx.lineTo(-6, 0);
    ctx.lineTo(-10, -8);
    ctx.closePath();
  };
  if (shipShaded) {
    // SHADED hull — gradient fill (camera-fixed lit direction via
    // counter-rotate of the gradient endpoints) + brighter stroke.
    ctx.save();
    hullPath();
    ctx.clip();
    // Counter-rotate the lighting gradient so the lit edge stays upper-
    // left in screen space rather than rotating with the ship.
    ctx.rotate(-(ship.rot + swayRot));
    const lit = ctx.createLinearGradient(-12, -10, 12, 10);
    lit.addColorStop(0, skin.ship);
    lit.addColorStop(0.55, skin.shipShadow);
    lit.addColorStop(1, 'rgba(0,0,0,0.45)');
    ctx.fillStyle = lit;
    ctx.fillRect(-30, -30, 60, 60);
    ctx.restore();
  }
  ctx.lineWidth = shipShaded ? 1.8 : 1.6;
  ctx.strokeStyle = skin.ship;
  ctx.shadowColor = skin.shipShadow;
  ctx.shadowBlur = shipShaded ? 14 : 12;
  hullPath();
  ctx.stroke();

  if (ship.thrusting && Math.floor(ship.thrustFrame) % 2 === 0) {
    // Additive radial bloom at the rear of the ship -- makes the flame
    // feel like it's burning rather than just drawn. Sits below the
    // flame line so the line stays sharp at the edges.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bloom = ctx.createRadialGradient(-10, 0, 0, -10, 0, 24);
    bloom.addColorStop(0, skin.bloomCore);
    bloom.addColorStop(0.5, skin.bloomMid);
    bloom.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bloom;
    ctx.beginPath();
    ctx.arc(-10, 0, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = skin.thrust;
    ctx.shadowColor = skin.thrustShadow;
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
 * Translucent leader-ghost ship. Daily-mode only — outside daily we don't
 * race a ship-overlay (the leader was on a different RNG, so their path
 * across the field is decorative noise). Cyan / 35% alpha so it reads
 * clearly as "not the player" without competing with the player's outline.
 */
function drawGhostShip(ctx: CanvasRenderingContext2D, s: GameState): void {
  if (s.phase !== 'playing') return;
  const seed = getActiveSeed();
  if (!seed) return;
  const ghost = getCachedGhost(seed);
  if (!ghost || !ghost.poseSamples) return;
  const t = s.runTimeMs;
  if (t > ghost.durationMs + 1000) return;
  const pose = ghostPoseAt(ghost, t);
  if (!pose || !pose.alive) return;

  drawGhostShipAt(ctx, pose.x, pose.y, pose.rot, pose.thrusting, 0.35);
}

/** Title-screen attract loop. Plays back the cached top ghost on a
 *  continuous loop while the user reads the title menu. Higher alpha
 *  than the in-game overlay because there's no live ship competing for
 *  attention. Restart-keyed off `now` so the loop is purely time-driven —
 *  no state mutation. */
let attractStartedAt = 0;
function drawGhostAttract(ctx: CanvasRenderingContext2D, s: GameState, now: number): void {
  if (s.phase !== 'title') {
    attractStartedAt = 0;
    return;
  }
  const ghost = getCachedGhost(getActiveSeed()) ?? getCachedGhost(null);
  if (!ghost || !ghost.poseSamples) return;
  if (attractStartedAt === 0) attractStartedAt = now;
  const loopMs = Math.max(2000, ghost.durationMs);
  const t = (now - attractStartedAt) % loopMs;
  const pose = ghostPoseAt(ghost, t);
  if (!pose) return;
  drawGhostShipAt(ctx, pose.x, pose.y, pose.rot, pose.thrusting, 0.55);
}

function drawGhostShipAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rot: number,
  thrusting: boolean,
  alpha: number,
  colour: string = '#8ee0ff',
): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.moveTo(14, 0);
  ctx.lineTo(-10, 8);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, -8);
  ctx.closePath();
  ctx.stroke();
  if (thrusting) {
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

// ── Asteroid 3D textures ─────────────────────────────────────────────
// Two-tier texture pipeline:
//   1. Photoreal — 1024×1024 gpt-image-2 surface shots (stony craters,
//      iron Widmanstätten, chondrite chondrules, pallasite olivine).
//      Lazy-loaded as HTMLImageElement on 600bn flavour boot. Preferred
//      when available.
//   2. Procedural fallback — canvas-baked radial-shaded textures with
//      synthetic features. Renders instantly while the photoreal
//      decodes; also covers the case where the webp 404s.
//
// drawAsteroid uses whichever is ready; once the photoreal lands the
// procedural is invisible. Cost per frame: one drawImage per asteroid
// (cheap, same as the council portrait pipeline). Only activates on
// 600bn flavour — the campaign keeps its canonical line-art look.

const asteroidPhotoreal: Map<AsteroidType, HTMLImageElement> = new Map();
const asteroidPhotorealStarted = new Set<AsteroidType>();

/** Lazy-load the per-type photoreal surface webp on first request.
 *  Returns null until the image has decoded; drawAsteroid then falls
 *  back to the procedural canvas in the meantime. */
function getAsteroidPhotoreal(type: AsteroidType): HTMLImageElement | null {
  if (!asteroidPhotorealStarted.has(type)) {
    asteroidPhotorealStarted.add(type);
    const img = new Image();
    img.onload = () => { asteroidPhotoreal.set(type, img); };
    // onerror just leaves the map unset → procedural fallback stays.
    img.src = `/backgrounds/asteroid-${type}.webp`;
  }
  return asteroidPhotoreal.get(type) ?? null;
}

/** Boot hook — kick all four photoreal loads at module init on 600bn
 *  so the textures decode in parallel with other asset loads, well
 *  before the first asteroid is drawn. No-op on main flavour (those
 *  asteroids use the canonical line-art look). */
function maybePreloadAsteroidPhotoreal(): void {
  if (typeof window === 'undefined') return;
  if (getFlavour() !== '600bn') return;
  for (const t of ['stony', 'iron', 'chondrite', 'pallasite'] as const) {
    void getAsteroidPhotoreal(t);
  }
}
maybePreloadAsteroidPhotoreal();

const ASTEROID_TEXTURE_SIZE = 128;
const asteroidTextureCache = new Map<AsteroidType, HTMLCanvasElement>();

/** Mulberry32 PRNG — deterministic so each type's texture is stable
 *  across runs. Seeded per type so stony/iron/etc. each get their own
 *  stable feature pattern. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bakeAsteroidTexture(type: AsteroidType): HTMLCanvasElement {
  const cached = asteroidTextureCache.get(type);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = ASTEROID_TEXTURE_SIZE;
  c.height = ASTEROID_TEXTURE_SIZE;
  const x = c.getContext('2d');
  if (!x) return c;

  const cx = ASTEROID_TEXTURE_SIZE / 2;
  const cy = ASTEROID_TEXTURE_SIZE / 2;
  const r = ASTEROID_TEXTURE_SIZE / 2;

  // Per-type palette + features. The 3D shading is achieved by a
  // radial gradient with the light source offset to the upper-left
  // — bright at (cx - 30%r, cy - 30%r), dark at the opposite corner.
  // Then small features overlaid for the mineral character.
  const palettes: Record<AsteroidType, { lit: string; mid: string; shadow: string; rim: string }> = {
    stony:     { lit: '#c4b298', mid: '#7a6856', shadow: '#2a2218', rim: '#1a1410' },
    iron:      { lit: '#7a4e36', mid: '#3a1f12', shadow: '#1a0a06', rim: '#0a0402' },
    chondrite: { lit: '#d8b070', mid: '#7c5828', shadow: '#2c1c08', rim: '#180e04' },
    pallasite: { lit: '#a6b070', mid: '#3a4a18', shadow: '#1a200a', rim: '#0a1004' },
  };
  const p = palettes[type];
  const rng = makePrng(
    type === 'stony' ? 0x57071 :
    type === 'iron' ? 0x12041 :
    type === 'chondrite' ? 0xC4014 :
    /* pallasite */ 0xA1148,
  );

  // Base 3D sphere shading — radial gradient from a lit upper-left to
  // a deep shadow lower-right. Stops at three points sell the volume.
  const lightR = r * 0.18;
  const lightCx = cx - r * 0.32;
  const lightCy = cy - r * 0.32;
  const grad = x.createRadialGradient(lightCx, lightCy, lightR * 0.3, lightCx, lightCy, r * 1.4);
  grad.addColorStop(0, p.lit);
  grad.addColorStop(0.45, p.mid);
  grad.addColorStop(1, p.shadow);
  x.fillStyle = grad;
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.fill();

  // Specular highlight — small bright disc above the lit center for
  // a wet/metallic suggestion. Heavier on iron/pallasite (metallic),
  // softer on stony/chondrite (rocky).
  const specular = type === 'iron' || type === 'pallasite' ? 0.55 : 0.32;
  const specR = r * 0.22;
  const specGrad = x.createRadialGradient(lightCx, lightCy, 0, lightCx, lightCy, specR);
  specGrad.addColorStop(0, `rgba(255, 240, 210, ${specular})`);
  specGrad.addColorStop(1, 'rgba(255, 240, 210, 0)');
  x.fillStyle = specGrad;
  x.beginPath();
  x.arc(lightCx, lightCy, specR, 0, Math.PI * 2);
  x.fill();

  // Type-specific surface features.
  if (type === 'stony') {
    // Craters — 14 small dark dimples scattered, each with a rim
    // highlight on the lit side. Reads as cratered grey rock.
    for (let i = 0; i < 14; i++) {
      const a = rng() * Math.PI * 2;
      const dist = rng() * r * 0.78;
      const px = cx + Math.cos(a) * dist;
      const py = cy + Math.sin(a) * dist;
      const cr = 2 + rng() * 5;
      // Dimple shadow
      x.fillStyle = `rgba(20, 14, 8, ${0.45 + rng() * 0.3})`;
      x.beginPath();
      x.arc(px, py, cr, 0, Math.PI * 2);
      x.fill();
      // Rim highlight on the lit side
      x.fillStyle = 'rgba(220, 200, 170, 0.35)';
      x.beginPath();
      x.arc(px - cr * 0.4, py - cr * 0.4, cr * 0.6, 0, Math.PI * 2);
      x.fill();
    }
  } else if (type === 'iron') {
    // Widmanstätten-style criss-cross hint + a few bright iron flecks.
    x.save();
    x.strokeStyle = 'rgba(200, 130, 70, 0.18)';
    x.lineWidth = 0.8;
    for (let i = 0; i < 6; i++) {
      const a = rng() * Math.PI * 2;
      const len = r * (0.5 + rng() * 0.6);
      x.beginPath();
      x.moveTo(cx + Math.cos(a) * -len, cy + Math.sin(a) * -len);
      x.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      x.stroke();
    }
    x.restore();
    // Iron flecks — small bright orange-red dots on the lit side.
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2;
      const dist = rng() * r * 0.7;
      const px = cx + Math.cos(a) * dist;
      const py = cy + Math.sin(a) * dist;
      const fr = 1 + rng() * 2.5;
      x.fillStyle = `rgba(255, ${130 + Math.floor(rng() * 60)}, 60, ${0.55 + rng() * 0.35})`;
      x.shadowColor = '#ff6a20';
      x.shadowBlur = 4;
      x.beginPath();
      x.arc(px, py, fr, 0, Math.PI * 2);
      x.fill();
    }
    x.shadowBlur = 0;
  } else if (type === 'chondrite') {
    // Chondrules — round embedded grains in mixed warm colours.
    const chondruleColours = ['#d8a040', '#b8804a', '#e0c060', '#9a6830', '#c89858', '#8a5a25'];
    for (let i = 0; i < 16; i++) {
      const a = rng() * Math.PI * 2;
      const dist = rng() * r * 0.78;
      const px = cx + Math.cos(a) * dist;
      const py = cy + Math.sin(a) * dist;
      const cr = 1.5 + rng() * 3.5;
      const col = chondruleColours[Math.floor(rng() * chondruleColours.length)];
      x.fillStyle = col;
      x.beginPath();
      x.arc(px, py, cr, 0, Math.PI * 2);
      x.fill();
      // Tiny shadow on the lower-right
      x.fillStyle = 'rgba(20, 12, 4, 0.4)';
      x.beginPath();
      x.arc(px + cr * 0.3, py + cr * 0.3, cr * 0.35, 0, Math.PI * 2);
      x.fill();
    }
  } else if (type === 'pallasite') {
    // Olivine crystals — bright green-gold inclusions with glow,
    // embedded in the dark iron base. This is the gem-grade variety.
    for (let i = 0; i < 12; i++) {
      const a = rng() * Math.PI * 2;
      const dist = rng() * r * 0.75;
      const px = cx + Math.cos(a) * dist;
      const py = cy + Math.sin(a) * dist;
      const cr = 2.5 + rng() * 4;
      // Gold/green olivine glow
      x.shadowColor = '#cfff70';
      x.shadowBlur = 6;
      x.fillStyle = `rgba(${180 + Math.floor(rng() * 50)}, ${220 + Math.floor(rng() * 30)}, ${100 + Math.floor(rng() * 60)}, 0.85)`;
      x.beginPath();
      x.arc(px, py, cr, 0, Math.PI * 2);
      x.fill();
      // Bright crystalline core
      x.shadowBlur = 0;
      x.fillStyle = 'rgba(255, 250, 200, 0.9)';
      x.beginPath();
      x.arc(px - cr * 0.25, py - cr * 0.25, cr * 0.35, 0, Math.PI * 2);
      x.fill();
    }
    x.shadowBlur = 0;
  }

  // Subtle rim darkening — sells the silhouette by making the edge
  // ~80% as dark as the shadow stop. Drawn last so features don't
  // override it at the rim.
  const rimGrad = x.createRadialGradient(cx, cy, r * 0.78, cx, cy, r);
  rimGrad.addColorStop(0, 'rgba(0, 0, 0, 0)');
  rimGrad.addColorStop(1, p.rim);
  x.fillStyle = rimGrad;
  x.beginPath();
  x.arc(cx, cy, r, 0, Math.PI * 2);
  x.fill();

  asteroidTextureCache.set(type, c);
  return c;
}

// ── Asteroid ──────────────────────────────────────────────────────────────────

function drawAsteroid(ctx: CanvasRenderingContext2D, a: Asteroid, now: number): void {
  if (!a.alive) return;
  const style = getAsteroidStyle(a.type);
  // MESH-tier asteroids are rendered by the WebGL overlay below. Skip
  // the 2D path entirely so the player sees one mesh per rock instead
  // of a 2D copy underneath. Falls back to SHADED 2D if the overlay
  // hasn't finished loading yet (or the player has the renderer turned
  // off via prefers-reduced-motion / WebGL unavailable).
  const asteroidTier = getVisualStyle('asteroid');
  if (asteroidTier === 'mesh' && isWebGLOverlayReady() && !a.isVein) return;
  // SHADED-tier asteroids get the "tumbling through space" treatment:
  // drop shadow under, camera-fixed rim light + terminator shading on
  // top, neutral outline (no per-type tint). Council members carry
  // their portrait inside the polygon; everything else (textured
  // filler) uses the photoreal rock surface. 'mesh' falls back to
  // shaded when the overlay isn't ready.
  const asteroidShaded = !a.isVein && asteroidTier !== 'vector';
  const is600bnFiller = asteroidShaded && !a.councilMember;
  ctx.save();
  ctx.translate(a.pos.x, a.pos.y);
  // 600bn drop shadow — drawn in the translated-but-NOT-rotated
  // frame so the shadow stays put on the "floor" regardless of how
  // the rock tumbles. Soft radial gradient offset down-right.
  if (is600bnFiller) {
    const sx = a.radius * 0.18;
    const sy = a.radius * 0.24;
    const sr = a.radius * 1.05;
    const sg = ctx.createRadialGradient(sx, sy, a.radius * 0.2, sx, sy, sr);
    sg.addColorStop(0, 'rgba(0,0,0,0.48)');
    sg.addColorStop(0.6, 'rgba(0,0,0,0.22)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(sx, sy, sr, 0, Math.PI * 2);
    ctx.fill();
  }
  // Vein halo — outer pulsing gold ring drawn BEFORE the rotate so the
  // halo doesn't spin with the asteroid. Reads as a fixed corona around
  // a slowly-rotating prize. Heavy bloom + sin-driven scale.
  if (a.isVein) {
    const pulse = 0.85 + 0.15 * Math.sin(now * 0.005);
    const haloR = a.radius * 1.55 * pulse;
    ctx.save();
    ctx.shadowColor = '#ffd84a';
    ctx.shadowBlur = 28;
    ctx.strokeStyle = `rgba(255, 216, 74, ${0.45 * pulse})`;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.arc(0, 0, haloR, 0, Math.PI * 2);
    ctx.stroke();
    // Inner glow disc
    const grad = ctx.createRadialGradient(0, 0, a.radius * 0.4, 0, 0, a.radius * 1.3);
    grad.addColorStop(0, `rgba(255, 216, 74, ${0.18 * pulse})`);
    grad.addColorStop(1, 'rgba(255, 216, 74, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, a.radius * 1.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.rotate(a.rot);
  // SHADED tier drops the per-type tint on every non-vein asteroid
  // (fillers AND council members) — the texture/portrait inside
  // carries the visual identity; an outline tint just fights it.
  if (asteroidShaded) {
    ctx.lineWidth = 1.0;
    ctx.strokeStyle = 'rgba(50, 40, 32, 0.85)';
    ctx.shadowColor = 'rgba(0,0,0,0)';
    ctx.shadowBlur = 0;
  } else {
    ctx.lineWidth = a.type === 'iron' ? 2.0 : (a.isVein ? 2.4 : 1.4);
    const lightness = 60 + a.hue * 0.2;
    ctx.strokeStyle = a.isVein ? '#ffd84a' : `hsl(${style.hueBase}, 70%, ${lightness}%)`;
    ctx.shadowColor = a.isVein ? '#ffd84a' : style.glow;
    ctx.shadowBlur = a.isVein ? 22 : (a.type === 'pallasite' ? 14 : 8);
  }

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

  // 600bn non-council asteroids get a photoreal surface texture
  // clipped inside the lumpy polygon — gives the field filler rocks
  // the "awesome 3D tumbling through space" look. Photoreal first;
  // canvas-baked fallback while the webp decodes. Council members
  // skip this branch (their portrait fill comes below). Main flavour
  // keeps the canonical line-art look untouched.
  if (is600bnFiller) {
    const photoreal = getAsteroidPhotoreal(a.type);
    const tex = photoreal ?? bakeAsteroidTexture(a.type);
    ctx.save();
    // Re-trace polygon path for the clip (the prior stroke consumed
    // the previous path).
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const angle = (Math.PI * 2 * i) / n;
      const r = a.radius * a.shape[i] * 0.96;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    // Texture draws in the rotated frame so it tumbles with the rock.
    const d = a.radius * 2.05;
    ctx.drawImage(tex, -d / 2, -d / 2, d, d);
    // Camera-fixed rim light + terminator shading. Counter-rotate
    // so light direction stays "upper-left" regardless of tumble —
    // that's what makes the rock read as a solid 3D body rather
    // than a flat textured disc spinning in place.
    ctx.rotate(-a.rot);
    const lr = a.radius * 1.15;
    const litGrd = ctx.createRadialGradient(-a.radius * 0.4, -a.radius * 0.45, a.radius * 0.1, -a.radius * 0.4, -a.radius * 0.45, lr);
    litGrd.addColorStop(0, 'rgba(255, 240, 220, 0.55)');
    litGrd.addColorStop(0.45, 'rgba(255, 240, 220, 0.18)');
    litGrd.addColorStop(1, 'rgba(255, 240, 220, 0)');
    ctx.fillStyle = litGrd;
    ctx.globalCompositeOperation = 'screen';
    ctx.beginPath();
    ctx.arc(0, 0, lr, 0, Math.PI * 2);
    ctx.fill();
    const shadeGrd = ctx.createRadialGradient(a.radius * 0.5, a.radius * 0.55, a.radius * 0.1, a.radius * 0.5, a.radius * 0.55, a.radius * 1.4);
    shadeGrd.addColorStop(0, 'rgba(0,0,0,0.55)');
    shadeGrd.addColorStop(0.5, 'rgba(0,0,0,0.25)');
    shadeGrd.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadeGrd;
    ctx.globalCompositeOperation = 'multiply';
    ctx.beginPath();
    ctx.arc(0, 0, a.radius * 1.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 600bn council-textured asteroids — clip the member portrait inside
  // the lumpy outline. Renders at every size; texture is pre-baked to
  // a 128px canvas so drawImage is cheap. Plus a HP-proportional
  // shimmer aura (council mass scale gives large 5-7 HP) so the player
  // can read "this rock has more left in it" without an HP bar.
  if (a.councilMember) {

    const img = getMemberImage(a.councilMember.name);
    if (img) {
      ctx.save();
      // Re-trace polygon path for the clip — closePath consumed by
      // the prior stroke. Slightly inset so the stroked outline stays
      // visible on top of the texture.
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i) / n;
        const r = a.radius * a.shape[i] * 0.96;
        const x = Math.cos(angle) * r;
        const y = Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.clip();
      const d = a.radius * 2.1;
      ctx.drawImage(img, -d / 2, -d / 2, d, d);
      ctx.restore();
    }
  }

  // Iron: inner armour ring while hp > 1 — strips off after the first hit.
  // Skipped on SHADED tier (textured + council faces don't need it).
  if (a.type === 'iron' && a.hp > 1 && !asteroidShaded) {
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

  // Vein: radial gold lines from centre, like cracks of light bleeding
  // out of the rock. Layered before the sparkle so the dots sit on top.
  if (a.isVein) {
    ctx.save();
    ctx.lineWidth = 1.2;
    const veinCount = 8;
    for (let i = 0; i < veinCount; i++) {
      const angle = (Math.PI * 2 * i) / veinCount + Math.sin(now * 0.001 + i) * 0.08;
      const lit = 0.6 + 0.4 * Math.sin(now * 0.004 + i * 0.7);
      ctx.strokeStyle = `rgba(255, 240, 160, ${0.55 * lit})`;
      ctx.shadowColor = '#fff5d8';
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * a.radius * 0.85, Math.sin(angle) * a.radius * 0.85);
      ctx.stroke();
    }
    ctx.restore();
  }

  // Pallasite: olivine sparkle dots — animated, signals jackpot.
  // Suppressed on SHADED so the photoreal surface / council portrait
  // reads cleanly.
  if (a.type === 'pallasite' && !asteroidShaded) {
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

  // Chondrite: short crystal accents at every other vertex — brittle look.
  // Suppressed on SHADED (texture already reads as brittle stone).
  if (a.type === 'chondrite' && !asteroidShaded) {
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

/** Render the 600bn UFO swap — a rotating coin-style badge with the
 *  canonical $600B 4-line wordmark, gold disc + black text for max
 *  contrast against the night background. Bigger visual than the
 *  standard cruiser footprint (1.6× radius) — the hit-box stays at
 *  u.radius so the asymmetry only helps the player. */
function drawSixHundredBnLogoUfo(ctx: CanvasRenderingContext2D, u: Ufo, now: number): void {
  // Visual radius — boosted so the badge reads big and clear. Hit-
  // box still uses u.radius which is smaller; shooting the visible
  // disc lands the shot reliably.
  const visR = u.radius * 1.6;
  ctx.save();
  ctx.translate(u.pos.x, u.pos.y);

  // Outer ember corona — pulsing, fixed (doesn't rotate with the badge).
  const pulse = 0.7 + 0.3 * Math.sin(now * 0.004);
  const corona = ctx.createRadialGradient(0, 0, visR * 0.5, 0, 0, visR * 1.75);
  corona.addColorStop(0, `rgba(255, 138, 58, ${0.45 * pulse})`);
  corona.addColorStop(1, 'rgba(255, 138, 58, 0)');
  ctx.fillStyle = corona;
  ctx.beginPath();
  ctx.arc(0, 0, visR * 1.75, 0, Math.PI * 2);
  ctx.fill();

  // Badge body — gold disc, like a struck coin. Radial highlight for
  // a hint of dimensionality.
  const bodyGrad = ctx.createRadialGradient(-visR * 0.3, -visR * 0.3, visR * 0.15, 0, 0, visR);
  bodyGrad.addColorStop(0, '#fff5d8');
  bodyGrad.addColorStop(0.45, '#ffd84a');
  bodyGrad.addColorStop(1, '#c08020');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(0, 0, visR, 0, Math.PI * 2);
  ctx.fill();

  // Outer rim — dark contrast band.
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#3a1a08';
  ctx.shadowColor = '#ff8a3a';
  ctx.shadowBlur = 18;
  ctx.stroke();

  // Inner concentric ring — like a coin's rim line.
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = 'rgba(58, 26, 8, 0.7)';
  ctx.shadowBlur = 0;
  ctx.beginPath();
  ctx.arc(0, 0, visR * 0.88, 0, Math.PI * 2);
  ctx.stroke();

  // 4-line sacred number, rotating with the badge. Black on gold
  // for maximum legibility — the previous gold-on-black was too low
  // contrast at flight distance.
  ctx.rotate(now * 0.0008);
  const size = Math.floor(visR * 0.38);
  ctx.font = `bold ${size}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a0a04';
  const lineH = size * 0.95;
  ctx.fillText('600', 0, -lineH * 1.5);
  ctx.fillText('000', 0, -lineH * 0.5);
  ctx.fillText('000', 0,  lineH * 0.5);
  ctx.fillText('000', 0,  lineH * 1.5);

  // Hit-flash overlay (unrotated so the flash is round).
  if (u.hitFlash > 0) {
    ctx.rotate(-now * 0.0008);
    ctx.globalAlpha = u.hitFlash * 0.65;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(0, 0, visR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

function drawUfo(ctx: CanvasRenderingContext2D, u: Ufo, now: number): void {
  if (!u.alive) return;
  // MESH-tier ships also cover UFOs — the WebGL overlay draws a 3D
  // saucer above this canvas. Skip the 2D path when ready.
  if (getVisualStyle('ship') === 'mesh' && isWebGLOverlayReady()) return;
  const r = u.radius;
  // 600bn flavour swap — UFO renders as the canonical 4-line sacred
  // number ($600B logo), rotating slowly. The hitbox + behaviour are
  // unchanged; just the silhouette is replaced.
  if (getFlavour() === '600bn') {
    drawSixHundredBnLogoUfo(ctx, u, now);
    return;
  }
  // Per-phase boss palette override — escalates from baseline red+gold
  // through enraged orange-red into a critical hot-white core. Non-boss
  // and phase-1 boss use the static lookup.
  let col = UFO_PALETTE[u.type];
  if (u.type === 'boss' && u.bossPhase !== 1) {
    if (u.bossPhase === 2) {
      col = { primary: '#ff2a2a', accent: '#ff8c4a', shadow: '#1a0303', cockpit: '#ffd84a' };
    } else {
      // Phase 3 — critical. Bright core, white cockpit, slight strobe on
      // the primary via a sine on `now` so the boss visibly thrashes.
      const strobe = 0.85 + 0.15 * Math.sin(now * 0.018);
      col = {
        primary: `rgba(255, ${Math.round(80 * strobe)}, ${Math.round(80 * strobe)}, 1)`,
        accent: '#fff5d8',
        shadow: '#2a0606',
        cockpit: '#ffffff',
      };
    }
  }

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

  // Hit-flash overlay (white pulse on damage). Boss runs hotter — every shot
  // that lands on the climactic fight should read as a frame of pure white,
  // not a tinted overlay. Other UFOs stay at the muted 0.7 cap so a barrage
  // doesn't strobe the screen.
  if (u.hitFlash > 0) {
    const flashAlpha = u.type === 'boss' ? u.hitFlash : u.hitFlash * 0.7;
    ctx.globalAlpha = flashAlpha;
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = u.type === 'boss' ? 26 : 18;
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
  // MESH falls back to SHADED for bullets — the WebGL overlay doesn't
  // render bullets yet (asteroid + ship only in the first MESH cut).
  const bulletShaded = getVisualStyle('bullet') !== 'vector';
  ctx.save();

  if (bulletShaded) {
    // SHADED tier — additive trail with linear gradient + head halo +
    // beefier core line. The gradient costs a per-bullet allocation but
    // the bullet count stays low (~20 active on screen) so the budget
    // is comfortable. Lighter composite op = the trail blooms over
    // backgrounds without smearing dark.
    const trailLen = len * 5.5;
    const tx = b.pos.x - ux * trailLen;
    const ty = b.pos.y - uy * trailLen;
    const grad = ctx.createLinearGradient(b.pos.x, b.pos.y, tx, ty);
    const headHex = friendly ? '255,90,90' : '255,200,90';
    grad.addColorStop(0, `rgba(${headHex},0.85)`);
    grad.addColorStop(0.5, `rgba(${headHex},0.35)`);
    grad.addColorStop(1, `rgba(${headHex},0)`);
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = grad;
    ctx.lineWidth = friendly ? 2.6 : 3.0;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.pos.x, b.pos.y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    // Head halo — radial gradient bloom that reads as the bullet's
    // burning core.
    const halo = ctx.createRadialGradient(b.pos.x, b.pos.y, 0, b.pos.x, b.pos.y, 8);
    halo.addColorStop(0, `rgba(${headHex},0.9)`);
    halo.addColorStop(0.6, `rgba(${headHex},0.3)`);
    halo.addColorStop(1, `rgba(${headHex},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(b.pos.x, b.pos.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // Solid white core line for snap.
    ctx.strokeStyle = '#ffffff';
    ctx.shadowColor = friendly ? '#ff5050' : '#ff8a3a';
    ctx.shadowBlur = friendly ? 12 : 16;
    ctx.lineWidth = friendly ? 1.4 : 1.8;
    ctx.beginPath();
    ctx.moveTo(b.pos.x - ux * len * 0.5, b.pos.y - uy * len * 0.5);
    ctx.lineTo(b.pos.x + ux * len * 0.5, b.pos.y + uy * len * 0.5);
    ctx.stroke();
    if (!friendly) {
      ctx.fillStyle = '#ffd84a';
      ctx.beginPath();
      ctx.arc(b.pos.x, b.pos.y, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  // VECTOR tier — flat trail + crisp core. Per-bullet cheap.
  const trailLen = len * 3.5;
  ctx.strokeStyle = friendly ? 'rgba(255,90,90,0.30)' : 'rgba(255,170,40,0.30)';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(b.pos.x, b.pos.y);
  ctx.lineTo(b.pos.x - ux * trailLen, b.pos.y - uy * trailLen);
  ctx.stroke();

  ctx.lineWidth = friendly ? 2.2 : 2.6;
  ctx.strokeStyle = friendly ? '#ff5050' : '#ffffff';
  ctx.shadowColor = friendly ? '#ff5050' : '#ff6a00';
  ctx.shadowBlur = friendly ? 10 : 14;
  ctx.beginPath();
  ctx.moveTo(b.pos.x - ux * len * 0.5, b.pos.y - uy * len * 0.5);
  ctx.lineTo(b.pos.x + ux * len * 0.5, b.pos.y + uy * len * 0.5);
  ctx.stroke();
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

  // 600bn flavour — every drop renders as a bitcoin coin (outlined gold
  // circle + ₿). 'dust' kind keeps its score-only economy (no sat
  // credit) but visually reads as a ₿ shard so the council-break
  // debris feels themed. Sat-coin drops use the same look — already
  // matches.
  const isBtcAesthetic = getFlavour() === '600bn';

  if (c.kind === 'sat' || isBtcAesthetic) {
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

  // Dust shard — shape varies by source asteroid so the screen reads as
  // four distinct loot families instead of four colour-tints of the same
  // diamond. Stony (the baseline) keeps the original peridot-green facet
  // so the "fiat-vibe" score-only signal stays dominant on screen — only
  // the rarer rocks get distinct silhouettes.
  const tumble = now * 0.003 + c.pos.x * 0.02;
  const sourceType = c.sourceType ?? 'stony';
  const style = getAsteroidStyle(sourceType);
  // Stony intentionally overrides to peridot green; the others use the
  // asteroid's glow colour for at-a-glance recognition.
  const dustColour = sourceType === 'stony' ? '#7fffb0' : style.glow;
  const r = c.radius * 0.95;
  ctx.save();
  ctx.translate(c.pos.x, c.pos.y);
  ctx.rotate(tumble);
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = dustColour;
  ctx.shadowColor = dustColour;
  ctx.shadowBlur = 9;
  drawDustShape(ctx, sourceType, r, alpha);
  ctx.restore();
}

/**
 * Per-source-type shard shape. Kept as plain stroke paths so they read at
 * tiny radii and match the vector aesthetic of everything else.
 */
function drawDustShape(ctx: CanvasRenderingContext2D, type: AsteroidType, r: number, alpha: number): void {
  switch (type) {
    case 'stony':
      // Diamond facet — the canonical fiat-vibe peridot shard.
      ctx.beginPath();
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.78, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.78, 0);
      ctx.closePath();
      ctx.stroke();
      ctx.lineWidth = 0.9;
      ctx.globalAlpha = alpha * 0.6;
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.6);
      ctx.lineTo(0, r * 0.6);
      ctx.moveTo(-r * 0.5, 0);
      ctx.lineTo(r * 0.5, 0);
      ctx.stroke();
      return;
    case 'iron': {
      // Hex nut — flat sides, a small bolt-mark in the middle so it reads
      // as machined metal at a glance.
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(ang) * r;
        const y = Math.sin(ang) * r;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.lineWidth = 0.9;
      ctx.globalAlpha = alpha * 0.6;
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    case 'chondrite': {
      // Three-fragment cluster — fits the lore that chondrites split into
      // three on break. Three small triangles arranged in a triad.
      const off = r * 0.55;
      const tri = (cx: number, cy: number): void => {
        ctx.beginPath();
        ctx.moveTo(cx, cy - r * 0.42);
        ctx.lineTo(cx + r * 0.36, cy + r * 0.22);
        ctx.lineTo(cx - r * 0.36, cy + r * 0.22);
        ctx.closePath();
        ctx.stroke();
      };
      tri(0, -off * 0.4);
      tri(-off * 0.6, off * 0.4);
      tri(off * 0.6, off * 0.4);
      return;
    }
    case 'pallasite': {
      // Six-point star — premium silhouette, signals jackpot rarity even
      // if it lands as dust (in guest mode pallasite drops dust, in Nostr
      // mode it usually drops sat coins instead).
      ctx.beginPath();
      const points = 12;
      for (let i = 0; i < points; i++) {
        const ang = (i / points) * Math.PI * 2 - Math.PI / 2;
        const radius = i % 2 === 0 ? r : r * 0.45;
        const x = Math.cos(ang) * radius;
        const y = Math.sin(ang) * radius;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
      return;
    }
  }
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
  // MESH falls back to SHADED for particles (WebGL pass doesn't handle
  // particles in the first cut — they're fast/transient enough that
  // the additive 2D bloom path reads well already).
  const particleShaded = getVisualStyle('particle') !== 'vector';
  ctx.save();
  ctx.shadowBlur = 0;
  if (particleShaded) {
    // SHADED tier — additive blend so overlapping bursts brighten
    // rather than just covering each other; ~1.4× sprite radius so
    // bursts feel chunkier. Soft falloff via two-stop radial gradient
    // per unique colour (cached across consecutive same-colour
    // particles, which is the common case for an explosion ring).
    ctx.globalCompositeOperation = 'lighter';
    let lastColour: string | null = null;
    let lastAlpha = -1;
    let lastSize = -1;
    let cachedGrad: CanvasGradient | null = null;
    let cachedGradSize = 0;
    for (const p of particles) {
      const alpha = p.ttl / p.maxTtl;
      if (alpha < 0.05) continue;
      const r = p.size * (0.7 + 0.6 * alpha);
      if (p.colour !== lastColour || Math.abs(r - cachedGradSize) > 0.5) {
        // Rebuild the gradient — only happens on colour OR size shift.
        // The size-shift threshold (0.5 px) avoids rebuilding for every
        // sub-pixel falloff step during a fade.
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
        g.addColorStop(0, p.colour);
        g.addColorStop(0.55, p.colour.startsWith('rgba')
          ? p.colour.replace(/[\d.]+\)$/, '0.35)')
          : p.colour + '5a');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        cachedGrad = g;
        cachedGradSize = r;
        lastColour = p.colour;
        ctx.fillStyle = g;
      }
      if (alpha !== lastAlpha) { ctx.globalAlpha = alpha; lastAlpha = alpha; }
      if (r !== lastSize) lastSize = r;
      ctx.save();
      ctx.translate(p.pos.x, p.pos.y);
      ctx.fillStyle = cachedGrad ?? p.colour;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    return;
  }
  // VECTOR tier — flat alpha-blended disc per particle, batched.
  let lastColour: string | null = null;
  let lastAlpha = -1;
  for (const p of particles) {
    const alpha = p.ttl / p.maxTtl;
    if (alpha < 0.05) continue;
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
  // Render HUD in screen-pixel space so SCORE / SATS / WAVE / LIVES are
  // always visible regardless of how the world is cropped or zoomed. Using
  // world coords would push SCORE off the visible band's left edge in
  // portrait, and LIVES off the right.
  const w = renderMode.kind === 'modern' ? renderMode.vw : WORLD_W;
  if (renderMode.kind === 'modern') {
    ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
  }
  // Notch / Dynamic Island awareness — push the HUD inside the safe area so
  // labels don't sit under the cutout on iPhone X+ in modern fullscreen mode.
  // Retro letterboxes the canvas inside the inscribed 4:3 area, so insets
  // are zero there by design.
  const insets = renderMode.insets;
  const topY = 16 + insets.top;
  const leftX = 24 + insets.left;
  const rightX = w - 24 - insets.right;
  const showSats = s.session && !s.cheatedThisRun;

  ctx.font = '24px ui-monospace, monospace';
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#58ff58';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('SCORE', leftX, topY);
  ctx.fillText(pad(s.score, 6), leftX, topY + 26);

  // Sats column stacks under SCORE on the left rail. Was previously at
  // x=w*0.32 alongside SCORE, which pushed WAVE off-centre and crowded the
  // top row on narrow viewports. Stacking lets WAVE claim the centre.
  // Hidden in guest mode (no sats to track) and once a cheat fires this run
  // (the SATS VOID chip below signals the run is unranked anyway).
  if (showSats) {
    ctx.fillStyle = '#ffd84a';
    ctx.fillText('SATS', leftX, topY + 60);
    ctx.fillText('₿ ' + pad(Math.floor(s.displaySats), 6), leftX, topY + 86);
  }

  // WAVE — top-centre, the focal point. Specimen name underneath pulls the
  // pallasite lore into the running HUD instead of leaving it only in the
  // wavestart cinematic. Boss arena (wave 25) gets its own treatment.
  // 600bn flavour overrides the HUD wave label so the centre column
  // reads as the canonical $600B wave rather than a numbered campaign
  // entry. Keeps the column position + font sizes identical so layout
  // stays stable.
  const is600bn = getFlavour() === '600bn';
  ctx.fillStyle = is600bn ? '#ffd84a' : '#5b9dff';
  ctx.shadowColor = is600bn ? '#ff8a3a' : '#5b9dff';
  ctx.shadowBlur = 8;
  ctx.textAlign = 'center';
  if (is600bn) {
    ctx.fillText('$600B', w / 2, topY);
    ctx.fillText('WAVE', w / 2, topY + 26);
  } else {
    ctx.fillText('WAVE', w / 2, topY);
    ctx.fillText(pad(s.wave, 2), w / 2, topY + 26);
  }
  ctx.shadowBlur = 0;
  ctx.font = 'bold 13px ui-monospace, monospace';
  ctx.fillStyle = '#fff5d8';
  ctx.letterSpacing = '0.18em' as unknown as string;
  ctx.fillText(is600bn ? 'THE SIGNAL' : waveName(s.wave).toUpperCase(), w / 2, topY + 56);
  ctx.letterSpacing = '0em' as unknown as string;

  ctx.font = '24px ui-monospace, monospace';
  ctx.fillStyle = '#58ff58';
  ctx.shadowColor = '#58ff58';
  ctx.shadowBlur = 0;
  ctx.textAlign = 'right';
  ctx.fillText('LIVES', rightX, topY);
  for (let i = 0; i < s.lives; i++) {
    const x = rightX - i * 22;
    const y = topY + 40;
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

  // Combo + buff chips — left rail, stacked below the SCORE/SATS column.
  // The starting Y depends on whether SATS is showing so chips don't overlap.
  ctx.textAlign = 'left';
  let chipY = topY + (showSats ? 124 : 60);
  function drawChip(label: string, remaining: number, totalMs: number, colour: string): void {
    const fade = Math.min(1, remaining / 600);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.fillStyle = colour;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 10;
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.fillText(label, leftX, chipY);
    const barW = 80;
    const frac = Math.min(1, remaining / totalMs);
    ctx.fillStyle = `rgba(255,255,255,0.15)`;
    ctx.fillRect(leftX, chipY + 22, barW, 3);
    ctx.fillStyle = colour;
    ctx.fillRect(leftX, chipY + 22, barW * frac, 3);
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
  // Lurking + cheated indicators removed — both states already fire
  // toasts when they're entered (toastNow in updateLurkState and
  // cheatJumpToWave), so the persistent red chips were duplicate noise.
  drawGhostChip(ctx, s);

  ctx.restore();
}

/**
 * Top-right "leader chip" — only renders during 'playing' phase, only when a
 * top ghost is cached (set by the title-screen prefetch). Shows the leader's
 * score interpolated to the current run-time, and the live gap as +/-N.
 *
 * Sits at viewport-right, just under the LIVES icon row, offset by the
 * top/right safe-area insets so it stays clear of the notch on iPhone X+.
 * Stays out of the way of HUD chips on the left rail and the WAVE banner on
 * wavestart.
 */
function drawGhostChip(ctx: CanvasRenderingContext2D, s: GameState): void {
  if (s.phase !== 'playing') return;
  const ghost = getCachedGhost(getActiveSeed());
  if (!ghost) return;
  const t = s.runTimeMs;
  // Once the player passes the leader's run-length, hide the chip — there's
  // no honest gap to show past that point.
  if (t > ghost.durationMs + 2000) return;
  const leaderScore = ghostScoreAt(ghost, t);
  if (leaderScore <= 0) return;
  const gap = s.score - leaderScore;
  // drawGhostChip is invoked inside drawHud, which has already reset the
  // transform to screen-pixel space in modern mode. Use viewport width
  // instead of world width so the chip stays glued to the actual top-right.
  const w = renderMode.kind === 'modern' ? renderMode.vw : WORLD_W;
  const insets = renderMode.insets;
  const x = w - 24 - insets.right;
  let y = 86 + insets.top;

  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'top';

  ctx.font = '13px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(160,160,160,0.9)';
  ctx.shadowBlur = 0;
  ctx.fillText('LEADER', x, y);
  y += 16;

  ctx.font = 'bold 18px ui-monospace, monospace';
  ctx.fillStyle = '#5b9dff';
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 6;
  ctx.fillText(leaderScore.toLocaleString(), x, y);
  y += 22;

  const ahead = gap >= 0;
  const colour = ahead ? '#58ff58' : '#ff8a3a';
  const gapStr = (ahead ? '+' : '−') + Math.abs(gap).toLocaleString();
  ctx.font = 'bold 15px ui-monospace, monospace';
  ctx.fillStyle = colour;
  ctx.shadowColor = colour;
  ctx.shadowBlur = 6;
  ctx.fillText(gapStr, x, y);

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
  // Strip is sized to fit four lines: WAVE N, specimen name, factual subtitle,
  // tactical tagline. Bumped from 240 to 270 when the tagline was added.
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, WORLD_H / 2 - 130, WORLD_W, 270);
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

  // Wave number — bigger, more confident. 600bn flavour swaps the
  // 'WAVE N' label for the canonical sacred-number wordmark.
  const isBnWave = getFlavour() === '600bn' && s.wave === 1;
  if (isBnWave) {
    ctx.font = 'bold 64px ui-monospace, monospace';
    ctx.fillStyle = '#ffd84a';
    ctx.shadowColor = '#ff8a3a';
    ctx.shadowBlur = 26;
    ctx.fillText('THE $600B WAVE', WORLD_W / 2, WORLD_H / 2 - 30);
  } else {
    ctx.font = 'bold 72px ui-monospace, monospace';
    ctx.fillStyle = '#5b9dff';
    ctx.shadowColor = '#5b9dff';
    ctx.shadowBlur = 22;
    ctx.fillText(`WAVE ${s.wave}`, WORLD_W / 2, WORLD_H / 2 - 30);
  }

  // Sub-name — pallasite specimen for campaign waves, council label
  // for the 600bn flavour.
  ctx.font = 'bold 28px ui-monospace, monospace';
  ctx.fillStyle = '#ffd84a';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 14;
  ctx.letterSpacing = '0.18em' as unknown as string;
  ctx.fillText(isBnWave ? 'COUNCIL OF 600' : waveName(s.wave), WORLD_W / 2, WORLD_H / 2 + 38);

  // One-line lore — pallasite history for campaign, 600B canon for
  // the Sanctum wave.
  const lore = isBnWave
    ? 'Madeira to Prague · The signal carries the stone'
    : waveSubtitle(s.wave);
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

  // Tactical tagline — 600bn gets the anchor line.
  const tagline = isBnWave
    ? 'We stack. We build. We meme. We repeat.'
    : waveTagline(s.wave);
  if (tagline) {
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = isBnWave ? '#ffb060' : '#7da5d4';
    ctx.shadowColor = isBnWave ? '#ff8a3a' : '#5b9dff';
    ctx.shadowBlur = 6;
    ctx.letterSpacing = '0.10em' as unknown as string;
    ctx.fillText(tagline, WORLD_W / 2, WORLD_H / 2 + 102);
  }

  ctx.restore();
}

// ── Warp transition ───────────────────────────────────────────────────────────

type WarpColour = 'white' | 'olive' | 'silver' | 'gold' | 'cyan' | 'magenta';
const WARP_PALETTE: Record<WarpColour, string> = {
  white:   '#ffffff',
  olive:   '#a3d958',  // olivine
  silver:  '#dde6f0',  // nickel-iron
  gold:    '#ffd84a',
  cyan:    '#5be0ff',
  magenta: '#ff5cb0',
};

interface WarpStar { angle: number; depth: number; speed: number; curl: number; colour: WarpColour; }
let warpStars: WarpStar[] | null = null;
function ensureWarpStars(): WarpStar[] {
  if (warpStars) return warpStars;
  warpStars = [];
  for (let i = 0; i < 220; i++) {
    const r = Math.random();
    const colour: WarpColour =
      r < 0.42 ? 'white'
      : r < 0.62 ? 'olive'
      : r < 0.78 ? 'silver'
      : r < 0.90 ? 'gold'
      : r < 0.96 ? 'cyan'
      : 'magenta';
    warpStars.push({
      angle: Math.random() * Math.PI * 2,
      depth: Math.random() * 0.05,
      speed: 0.8 + Math.random() * 1.8,
      curl: (Math.random() - 0.5) * 0.7,  // signed → mix of CW and CCW spiral arms
      colour,
    });
  }
  return warpStars;
}

interface WarpRibbon { phase: number; amp: number; speed: number; hue: number; thickness: number; offsetY: number; }
let warpRibbons: WarpRibbon[] | null = null;
function ensureWarpRibbons(): WarpRibbon[] {
  if (warpRibbons) return warpRibbons;
  warpRibbons = [];
  // Ribbon hues span the warp palette so layered drifting bands create
  // chromatic interference patterns when they overlap (composite=lighter).
  const hues = [80, 50, 200, 320, 165];
  for (let i = 0; i < hues.length; i++) {
    warpRibbons.push({
      phase: Math.random() * Math.PI * 2,
      amp: 80 + Math.random() * 100,
      speed: 0.0003 + Math.random() * 0.0006,
      hue: hues[i],
      thickness: 70 + Math.random() * 80,
      offsetY: (i + 0.5) * (WORLD_H / hues.length),
    });
  }
  return warpRibbons;
}

interface WarpFlare { startedAt: number; durMs: number; }
interface WarpAsteroid { startedAt: number; durMs: number; angle: number; spinSpeed: number; vertices: number[]; }
let warpFlares: WarpFlare[] = [];
let warpAsteroids: WarpAsteroid[] = [];
let lastFlareSpawnAt = -Infinity;
let lastAsteroidSpawnAt = -Infinity;
let warpRunId = -1;  // tracks which warp instance we're in; reset transients on new warp

function spawnWarpAsteroid(now: number): void {
  const verts: number[] = [];
  const n = 8 + Math.floor(Math.random() * 5);
  for (let i = 0; i < n; i++) verts.push(0.7 + Math.random() * 0.5);
  warpAsteroids.push({
    startedAt: now,
    durMs: 1100 + Math.random() * 700,
    angle: Math.random() * Math.PI * 2,
    spinSpeed: (Math.random() - 0.5) * 4,
    vertices: verts,
  });
}

/**
 * Inter-wave warp cutscene. Layered build (back to front):
 *   0. Black + nebula glow keyed off the destination wave's hue
 *   1. Hyperspace ENGAGE flash — sudden white punch in first 80ms
 *   2. Camera-shake-and-rotate wrapper around the motion layers:
 *      a. Chromatic ribbons drifting horizontally (additive)
 *      b. 220 spiral tunnel streaks, multi-coloured, additive
 *      c. Vector asteroid silhouettes hurtling outward at parallax
 *      d. Periodic warp flares (centre shockwaves)
 *   3. Destination specimen disc — chromatic-aberration "lensed" while small,
 *      sharpens as it grows ease-in-cubic to fill the screen
 *   4. ARRIVAL flash — final iris burst that bleeds into the wave bg
 * No text — the wavestart banner that follows handles the wave name + lore.
 */
function drawWarp(ctx: CanvasRenderingContext2D, s: GameState, now: number): void {
  // Reset per-warp transients when a new warp begins (phaseStart is the warp ID)
  if (s.phaseStart !== warpRunId) {
    warpRunId = s.phaseStart;
    warpFlares = [];
    warpAsteroids = [];
    lastFlareSpawnAt = now - 500;  // first flare fires almost immediately
    lastAsteroidSpawnAt = now;
  }

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
  const reachMax = Math.max(WORLD_W, WORLD_H) * 0.75;

  // ── Layer 0: nebula glow keyed off the destination wave's hue
  const nebulaHue = (s.warpTargetWave * 47 + 200) % 360;
  const nebulaGlow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(WORLD_W, WORLD_H));
  nebulaGlow.addColorStop(0, `hsla(${nebulaHue}, 80%, 38%, ${0.45 * intensity})`);
  nebulaGlow.addColorStop(0.45, `hsla(${nebulaHue}, 60%, 22%, ${0.20 * intensity})`);
  nebulaGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = nebulaGlow;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);

  // ── Layer 1: hyperspace ENGAGE punch — fades over first 8% of phase
  if (progress < 0.08) {
    const punchAlpha = (1 - progress / 0.08) * 0.85;
    ctx.fillStyle = `rgba(255,250,240,${punchAlpha})`;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  }

  // ── Camera shake + slow rotation (sin/cos noise, scales with intensity)
  const shakeX = Math.sin(now * 0.072) * intensity * 1.6 + Math.sin(now * 0.219) * intensity * 0.6;
  const shakeY = Math.cos(now * 0.083) * intensity * 1.6 + Math.cos(now * 0.183) * intensity * 0.6;
  const cameraRot = (progress - 0.5) * 0.45 + Math.sin(progress * Math.PI * 3) * 0.05;

  ctx.save();
  ctx.translate(cx + shakeX, cy + shakeY);
  ctx.rotate(cameraRot);
  ctx.translate(-cx, -cy);

  // ── Layer 2a: chromatic ribbons — large translucent sin curves drifting
  const ribbons = ensureWarpRibbons();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (const rib of ribbons) {
    const t = now * rib.speed + rib.phase;
    const baseY = rib.offsetY + Math.sin(t * 0.5) * rib.amp * 0.3;
    ctx.beginPath();
    const steps = 20;
    for (let i = 0; i <= steps; i++) {
      const x = (i / steps) * WORLD_W;
      const y = baseY + Math.sin(t + i * 0.55) * rib.amp;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = rib.thickness;
    ctx.strokeStyle = `hsla(${rib.hue}, 75%, 55%, ${0.10 * intensity})`;
    ctx.stroke();
  }

  // ── Layer 2b: spiral tunnel streaks (curl per star → swirl)
  // Tunnel fades after the disc takes over so focal depth lands on the arrival.
  const tunnelFade = 1 - Math.max(0, progress - 0.55) * 1.2;
  const stars = ensureWarpStars();
  for (const st of stars) {
    st.depth += st.speed * 0.025 * (1 + intensity * 5);
    if (st.depth > 1) {
      st.depth = 0.02;
      st.angle = Math.random() * Math.PI * 2;
    }
    const reach = st.depth * reachMax;
    const reachPrev = Math.max(0.001, (st.depth - 0.05) * reachMax);
    // Curl: angle wobbles with depth → curved spiral path instead of pure radial
    const curlNow = st.curl * st.depth;
    const curlPrev = st.curl * Math.max(0, st.depth - 0.05);
    const x1 = cx + Math.cos(st.angle + curlPrev) * reachPrev;
    const y1 = cy + Math.sin(st.angle + curlPrev) * reachPrev;
    const x2 = cx + Math.cos(st.angle + curlNow) * reach;
    const y2 = cy + Math.sin(st.angle + curlNow) * reach;
    const alpha = Math.min(1, st.depth * 4) * Math.max(0, tunnelFade);
    if (alpha < 0.02) continue;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = WARP_PALETTE[st.colour];
    ctx.lineWidth = 0.7 + st.depth * 2.4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';

  // ── Layer 2c: vector asteroid silhouettes hurtling past at parallax
  if (progress > 0.15 && progress < 0.70 && now - lastAsteroidSpawnAt > 650 + Math.random() * 350) {
    spawnWarpAsteroid(now);
    lastAsteroidSpawnAt = now;
  }
  warpAsteroids = warpAsteroids.filter(a => now - a.startedAt < a.durMs);
  for (const a of warpAsteroids) {
    const t = (now - a.startedAt) / a.durMs;
    if (t < 0 || t >= 1) continue;
    const distance = t * reachMax * 1.4;
    const px = cx + Math.cos(a.angle) * distance;
    const py = cy + Math.sin(a.angle) * distance;
    const size = 25 + t * 220;
    const spin = a.spinSpeed * t;
    const alpha = Math.min(1, t * 3) * Math.max(0, 1 - (t - 0.7) * 3.3);
    if (alpha < 0.02) continue;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(spin);
    ctx.globalAlpha = alpha * 0.55;
    ctx.strokeStyle = '#a3d958';
    ctx.lineWidth = 1.6;
    ctx.shadowColor = '#a3d958';
    ctx.shadowBlur = 14;
    ctx.beginPath();
    for (let i = 0; i < a.vertices.length; i++) {
      const angle = (i / a.vertices.length) * Math.PI * 2;
      const r = a.vertices[i] * size;
      const x = Math.cos(angle) * r;
      const y = Math.sin(angle) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;

  // ── Layer 2d: warp flares — periodic shockwave rings from the centre
  if (progress < 0.85 && now - lastFlareSpawnAt > 600) {
    warpFlares.push({ startedAt: now, durMs: 900 });
    lastFlareSpawnAt = now;
  }
  warpFlares = warpFlares.filter(f => now - f.startedAt < f.durMs);
  ctx.globalCompositeOperation = 'lighter';
  for (const f of warpFlares) {
    const t = (now - f.startedAt) / f.durMs;
    if (t < 0 || t >= 1) continue;
    const r = t * reachMax * 1.2;
    const a = (1 - t) * 0.5;
    const grad = ctx.createRadialGradient(cx, cy, r * 0.85, cx, cy, r * 1.05);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.6, `rgba(255,255,255,${a * 0.7})`);
    grad.addColorStop(0.9, `rgba(255,216,74,${a})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.05, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  ctx.restore();  // unwrap camera shake + rotation

  // ── Layer 3: destination specimen disc (stable; no camera shake on focal)
  if (progress > 0.30) {
    const t = Math.min(1, (progress - 0.30) / 0.62);
    const growth = t * t * t;  // ease-in-cubic
    const minR = 12;
    const maxR = Math.max(WORLD_W, WORLD_H) * 0.95;
    const r = minR + (maxR - minR) * growth;
    const rotate = progress * Math.PI * 0.6 + Math.sin(progress * Math.PI * 4) * 0.05;
    const target = tryLoadOverride(s.warpTargetWave);

    // Chromatic-aberration "lensing" fake: render the bg image multiple times
    // with offset positions while small, sharpening as we arrive.
    const aberration = (1 - t) * 9;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.clip();
    if (target) {
      ctx.rotate(rotate);
      const imgScale = (r * 2.4) / Math.min(target.width, target.height);
      const w = target.width * imgScale;
      const h = target.height * imgScale;
      if (aberration > 1) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55;
        ctx.drawImage(target, -w / 2 - aberration, -h / 2, w, h);
        ctx.drawImage(target, -w / 2 + aberration, -h / 2, w, h);
        ctx.drawImage(target, -w / 2, -h / 2 - aberration * 0.7, w, h);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1 - aberration / 12;
        ctx.drawImage(target, -w / 2, -h / 2, w, h);
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(target, -w / 2, -h / 2, w, h);
      }
    } else {
      const grad = ctx.createRadialGradient(0, -r * 0.3, r * 0.1, 0, 0, r);
      grad.addColorStop(0, `hsl(${nebulaHue}, 60%, 55%)`);
      grad.addColorStop(0.6, `hsl(${nebulaHue}, 55%, 30%)`);
      grad.addColorStop(1, `hsl(${nebulaHue}, 50%, 12%)`);
      ctx.fillStyle = grad;
      ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    ctx.restore();

    // Rim glow drawn after clip release so the bloom sits outside the disc
    ctx.save();
    ctx.translate(cx, cy);
    const rimAlpha = Math.min(1, 0.55 + intensity * 0.45);
    ctx.strokeStyle = `rgba(255,216,74,${rimAlpha})`;
    ctx.shadowColor = '#ffd84a';
    ctx.shadowBlur = 28 + r * 0.06;
    ctx.lineWidth = 1.8 + r * 0.005;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ── Layer 4: ARRIVAL flash
  if (progress > 0.86) {
    const flashT = (progress - 0.86) / 0.14;
    const flashAlpha = Math.sin(flashT * Math.PI);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(WORLD_W, WORLD_H));
    grad.addColorStop(0, `rgba(255,250,235,${flashAlpha * 0.95})`);
    grad.addColorStop(0.4, `rgba(255,216,74,${flashAlpha * 0.45})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
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
      shieldUp: false, shieldExpiresAt: 0, shieldReadyAt: 0, recoilOffset: 0,
      lastHyperspaceAt: 0,
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

  // Camera shake from accumulated trauma. trauma² gives a quadratic feel —
  // small hits barely shake, big hits punch. Reduced-motion zeros amplitude.
  let shakeX = 0, shakeY = 0;
  const trauma = state.cameraTrauma;
  if (trauma > 0 && !shouldReduceMotion()) {
    const amp = trauma * trauma * 14;
    shakeX = (Math.sin(now * 0.073) + Math.sin(now * 0.127) * 0.6) * amp;
    shakeY = (Math.cos(now * 0.091) + Math.cos(now * 0.151) * 0.6) * amp;
  }

  // Ghost-render offsets so wraps look seamless at visible-band edges.
  // We only spend the 3-pass cost when there's actually an entity near a
  // wrap edge — in most frames every asteroid is mid-band, so a single pass
  // is correct and 3× cheaper. When something approaches an edge we flip to
  // full 3-pass for that axis so the wrap-copy can fade in smoothly. Cheap
  // to detect: ~30 entities × a couple of comparisons each.
  const ghostXs: number[] = [0];
  const ghostYs: number[] = [0];
  if (renderMode.kind === 'modern') {
    const visW = renderMode.vw / renderMode.scale;
    const visH = renderMode.vh / renderMode.scale;
    const cropX = visW < WORLD_W - 1;
    const cropY = visH < WORLD_H - 1;
    if (cropX || cropY) {
      const visLeftW = -renderMode.tx / renderMode.scale;
      const visRightW = (renderMode.vw - renderMode.tx) / renderMode.scale;
      const visTopW = -renderMode.ty / renderMode.scale;
      const visBotW = (renderMode.vh - renderMode.ty) / renderMode.scale;
      // Margin chosen for *visual lead time*, not entity radius. With
      // M=50 the previous build gave the player ~160ms warning before an
      // asteroid popped at the wrap edge (max asteroid speed ~315 px/s),
      // which read as "that hit came out of nowhere" and "my bullet
      // disappeared". M=150 gives ~480ms of visible wrap-ghost — well
      // above human reaction time — so the wrap looks continuous instead
      // of teleporty. Cheap: probe stays O(entities), and the 3-pass cost
      // only kicks in when something is actually within the buffer.
      const M = 150;
      let needX = false, needY = false;
      const probe = (x: number, y: number): void => {
        if (cropX && !needX && (x < visLeftW + M || x > visRightW - M)) needX = true;
        if (cropY && !needY && (y < visTopW + M || y > visBotW - M)) needY = true;
      };
      for (const a of state.asteroids) { probe(a.pos.x, a.pos.y); if (needX && needY) break; }
      if (!(needX && needY)) {
        for (const u of state.ufos) { probe(u.pos.x, u.pos.y); if (needX && needY) break; }
      }
      if (!(needX && needY)) {
        for (const m of state.mines) { probe(m.pos.x, m.pos.y); if (needX && needY) break; }
      }
      // Bullets too — player shots and UFO shots BOTH wrap on collide
      // (game.ts circlesHit uses wrap-aware delta), so the visual must
      // wrap too or a bullet appears to vanish into the edge and an
      // incoming enemy shot pops in with no telegraph.
      if (!(needX && needY)) {
        for (const b of state.bullets) { probe(b.pos.x, b.pos.y); if (needX && needY) break; }
      }
      if (!(needX && needY)) {
        for (const b of state.enemyBullets) { probe(b.pos.x, b.pos.y); if (needX && needY) break; }
      }
      // Ship near edge counts too — its ghost is visible to the player.
      if (!(needX && needY)) probe(state.ship.pos.x, state.ship.pos.y);
      if (needX) ghostXs.push(-visW, visW);
      if (needY) ghostYs.push(-visH, visH);
    }
  }

  // Shake wraps the entity layer only — HUD stays steady so readouts don't
  // judder during impacts.
  ctx.save();
  ctx.translate(shakeX, shakeY);

  for (const dx of ghostXs) {
    for (const dy of ghostYs) {
      const isGhost = dx !== 0 || dy !== 0;
      if (isGhost) { ctx.save(); ctx.translate(dx, dy); }
      for (const a of state.asteroids) drawAsteroid(ctx, a, now);
      for (const m of state.mines) drawMine(ctx, m, now);
      // UFOs and mines don't wrap — they traverse the world (or sit
      // stationary) without crossing the wrap cycle. Drawing them in
      // ghost passes paints a phantom copy at ±visW that the player
      // reads as a duplicate UFO, especially during the spawn approach
      // where the real UFO is just off the visible band.
      if (!isGhost) {
        for (const u of state.ufos) drawUfo(ctx, u, now);
      }
      for (const b of state.bullets) drawBullet(ctx, b, true);
      for (const b of state.enemyBullets) drawBullet(ctx, b, false);
      for (const c of state.coins) drawCoin(ctx, c, now);
      for (const p of state.powerups) drawPowerUp(ctx, p, now);
      drawGhostShip(ctx, state);
      drawGhostAttract(ctx, state, now);
      drawShield(ctx, state.ship, now);
      const idleSway = state.phase === 'title' || state.phase === 'wavestart';
      drawShip(ctx, state.ship, now, idleSway);
      if (isGhost) ctx.restore();
    }
  }

  // Particles + debris draw once at world coords — they're transient and
  // never near the wrap edge long enough for a ghost copy to register
  // before they fade. Pulling them out of the ghost loop saves up to N
  // particle-arcs per pass on a death-explosion frame (80+ particles ×
  // 3 passes = 240+ arcs reduced to 80).
  drawParticles(ctx, state.particles);
  drawDebris(ctx, state.debris);

  ctx.restore();

  // Hyperspace-malfunction chromatic split — red+cyan vignettes nudged
  // opposite directions sell the "something's wrong" frame. Cheap (two
  // gradient draws), and visually distinct from any other in-world effect.
  if (state.ship.hyperspaceCloakMs > 0 && state.ship.hyperspaceMalfunction && !shouldReduceMotion()) {
    drawChromaticSplit(ctx, now);
  }

  // 5x combo screen tint -- a faint warm wash that signals "we're at the
  // cap" without obscuring play. Only when combo is at COMBO_MAX; below
  // that the bass-pulse stem alone carries the intensity.
  if (state.combo >= COMBO_MAX) {
    const alpha = shouldReduceMotion() ? 0.04 : 0.08;
    ctx.save();
    ctx.fillStyle = `rgba(255,80,40,${alpha})`;
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    ctx.restore();
  }

  drawHud(ctx, state, now);
  drawWaveBanner(ctx, state, now);
  drawBonusBanner(ctx, state, now);

  // WebGL mesh overlay — runs only if any category is currently on
  // 'mesh' tier AND the overlay module has finished loading. Lives on
  // a separate canvas (#game3d) absolutely positioned above #game so
  // the call here is just "feed it the entity list and let it paint."
  // While the overlay is still loading the renderer is a no-op and
  // the 2D path renders shaded fallbacks (see drawAsteroid).
  if (isWebGLOverlayReady()) {
    // Ship tier drives both the player ship AND the UFOs — they're
    // both "vehicles" and grouping them keeps the settings UI to four
    // categories rather than introducing a fifth row.
    const shipTier = getVisualStyle('ship');
    callWebGLOverlay({
      asteroids: getVisualStyle('asteroid') === 'mesh' ? state.asteroids : [],
      ufos: shipTier === 'mesh' ? state.ufos : [],
      ship: shipTier === 'mesh' ? state.ship : null,
      dpr: renderMode.dpr,
      scale: renderMode.scale,
      tx: renderMode.tx,
      ty: renderMode.ty,
    });
  }
}

/** BONUS banner — large 'B · O · N · U · S' intro for the first ~3s,
 *  then a persistent countdown timer + sub-phase label (HYPER BLITZ
 *  vs EVENT HORIZON PRELUDE) at the top of the canvas for the rest
 *  of the 60s window. */
function drawBonusBanner(ctx: CanvasRenderingContext2D, s: GameState, now: number): void {
  if (s.phase !== 'bonus') return;
  const elapsed = now - s.bonusStartedAt;
  const remaining = Math.max(0, 60_000 - elapsed);
  const subPhase = elapsed < 45_000 ? 'HYPER BLITZ' : 'EVENT HORIZON PRELUDE';

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Intro banner — first 2.6s, fade out over 600ms.
  if (elapsed < 2600) {
    let alpha = 1;
    if (elapsed < 250) alpha = elapsed / 250;
    else if (elapsed > 2000) alpha = 1 - (elapsed - 2000) / 600;
    alpha = Math.max(0, Math.min(1, alpha));
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, WORLD_H / 2 - 90, WORLD_W, 180);
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 88px ui-monospace, monospace';
    ctx.fillStyle = '#ffd84a';
    ctx.shadowColor = '#ffd84a';
    ctx.shadowBlur = 28;
    // Letter-by-letter drop — each letter eases in 80ms after the prior
    // so the headline reads like an arcade attract sequence.
    const letters = ['B', 'O', 'N', 'U', 'S'];
    const spacing = 90;
    const baseX = WORLD_W / 2 - spacing * 2;
    for (let i = 0; i < letters.length; i++) {
      const dropAt = 200 + i * 80;
      if (elapsed < dropAt) continue;
      const dt = Math.min(1, (elapsed - dropAt) / 200);
      const yOff = (1 - dt) * -40;
      ctx.fillText(letters[i], baseX + i * spacing, WORLD_H / 2 + yOff);
    }
    ctx.shadowBlur = 12;
    ctx.font = 'bold 18px ui-monospace, monospace';
    ctx.fillStyle = '#8cffb4';
    ctx.shadowColor = '#8cffb4';
    ctx.fillText('60 SECONDS · INVULNERABLE · NO HYPERSPACE COOLDOWN', WORLD_W / 2, WORLD_H / 2 + 56);
  }

  // Persistent countdown header — top of the canvas, visible the whole
  // 60s. Switches sub-phase label at the 45s mark.
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(WORLD_W / 2 - 200, 14, 400, 44);
  ctx.globalAlpha = 1;
  ctx.font = 'bold 22px ui-monospace, monospace';
  ctx.fillStyle = '#ffd84a';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 16;
  const secs = (remaining / 1000).toFixed(1);
  ctx.fillText(`B·O·N·U·S · ${secs}s`, WORLD_W / 2, 30);
  ctx.shadowBlur = 6;
  ctx.font = '12px ui-monospace, monospace';
  ctx.fillStyle = elapsed < 45_000 ? '#8cffb4' : '#ff8a3a';
  ctx.shadowColor = ctx.fillStyle as string;
  ctx.fillText(subPhase, WORLD_W / 2, 50);
  ctx.restore();
}

/**
 * Cheap RGB-split overlay for hyperspace-malfunction frames. Two full-screen
 * radial gradients — red pushed left, cyan pushed right — pulsing with the
 * malfunction ring cadence so it reads as one effect, not two.
 */
function drawChromaticSplit(ctx: CanvasRenderingContext2D, now: number): void {
  const t = (now * 0.012) % 1;
  const amp = 6 + Math.sin(now * 0.04) * 2;
  const alpha = 0.18 + 0.10 * t;
  const cx = WORLD_W / 2, cy = WORLD_H / 2;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const red = ctx.createRadialGradient(cx - amp, cy, 100, cx - amp, cy, 600);
  red.addColorStop(0, 'rgba(255,80,80,0)');
  red.addColorStop(1, `rgba(255,60,60,${alpha})`);
  ctx.fillStyle = red;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  const cyan = ctx.createRadialGradient(cx + amp, cy, 100, cx + amp, cy, 600);
  cyan.addColorStop(0, 'rgba(80,255,255,0)');
  cyan.addColorStop(1, `rgba(60,200,255,${alpha})`);
  ctx.fillStyle = cyan;
  ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  ctx.restore();
}
