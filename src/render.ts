/**
 * Vector renderer for the game world.
 *
 * Pure Canvas 2D — line strokes, mostly. Per-wave procedural backgrounds with
 * an opt-in override hook for /backgrounds/wave-N.png if the consumer drops in
 * generated art.
 */

import type {
  GameState, Ship, Asteroid, AsteroidType, Bullet, Coin, Particle, Ufo, Mine, PowerUp, ReplaySnapshot, Debris, Shockwave, HyperspaceEffect,
} from './types.js';
import {
  WORLD_W, WORLD_H, WARP_MS, WAVE_CLEAR_GRACE_MS, waveName, waveSubtitle, waveTagline, POWERUP_CONFIG,
  REPLAY_SLOW_MS, REPLAY_SLOW_RATE, REPLAY_EXPLOSION_MS, COMBO_MAX,
  intertitleForWave, INTERTITLE_MS,
} from './types.js';
import { getCachedGhost, ghostScoreAt, ghostPoseAt } from './ghost.js';
import { getActiveSeed } from './seed.js';
import { getAsteroidStyle, shouldReduceMotion } from './a11y.js';
import { getActiveSkin } from './skins.js';
import { getMemberImage } from './sanctum-avatars.js';
import { getFlavour } from './flavour.js';
import { getVisualStyle, getTheme, isWebGLOverlayReady, callWebGLOverlay } from './visual-style.js';
import { DEPTH_CONFIGS } from './parallax.js';
import { getRadarVisible, getRadarLandscape, getRadarTilt } from './radar.js';
import { buildSeamlessStarfield, drawParallaxStarfield } from './starfield.js';
import { isSanctumMode } from './mode.js';
import { arenaActive, arenaCage, type ArenaCage } from './arena.js';
import { deathmatchActive, deathmatchWorldH, deathmatchWorldW } from './deathmatch.js';

interface WorldBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boundsIntersectCircle(bounds: WorldBounds | undefined, x: number, y: number, r: number): boolean {
  if (!bounds) return true;
  return x + r >= bounds.x0 && x - r <= bounds.x1 && y + r >= bounds.y0 && y - r <= bounds.y1;
}

function boundsIntersectRect(bounds: WorldBounds | undefined, x0: number, y0: number, x1: number, y1: number): boolean {
  if (!bounds) return true;
  return x1 >= bounds.x0 && x0 <= bounds.x1 && y1 >= bounds.y0 && y0 <= bounds.y1;
}

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
  if (wave === 1 && (getFlavour() === '600bn' || isSanctumMode())) return '/backgrounds/sanctum-space.webp';
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

/** Drop a cached wave-N image so the next preloadBackground / drawBackground
 *  resolves the URL afresh. Used by startGame when a Sanctum-mode run is
 *  entered on a host where the boot-time preload cached the standard
 *  wave-1.webp before lockInMode('sanctum') ran — without this, the cache
 *  returns wave-1.webp even though backgroundUrlForWave would now hand back
 *  sanctum-space.webp. */
export function invalidateBackgroundCache(wave: number): void {
  overrideImages.delete(wave);
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
  /** Portrait-modern follow camera active: render() applies a per-frame
   *  horizontal camera translate that tracks the ship. Unset (falsy) for
   *  landscape-modern and retro, which keep the static contain transform. */
  follow?: boolean;
  /** Defender preview mode (`?defender=1`). When true, the bg pipeline
   *  swaps the wave webp for a multi-layer parallax starfield, and the
   *  radar is forced on regardless of the user's landscape preference. */
  defender?: boolean;
  /** Which players[] slot the follow camera should track. Defaults to 0
   *  (solo / couch / spectate / portrait-follow-as-P1). In multiplayer
   *  this is the local peer slot so the camera frames the local ship. */
  localSlot?: number;
}
let renderMode: RenderModeInfo = { kind: 'retro', vw: WORLD_W, vh: WORLD_H, dpr: 1, scale: 1, tx: 0, ty: 0, insets: ZERO_INSETS };
export function setRenderMode(info: RenderModeInfo): void { renderMode = info; }

// ── Portrait follow camera ────────────────────────────────────────────────────

/** Smoothed camera-centre X in world coords. Render-only state: the sim never
 *  reads it, so it cannot affect B3 determinism. */
let camX = WORLD_W / 2;
let camY = WORLD_H / 2;
/** False until the camera has been seeded onto the ship for the current run. */
let camInit = false;
/** Timestamp of the previous follow frame, for frame-rate-independent easing. */
let camPrevNow = 0;

/** Wrap a world X into [0, WORLD_W). */
function wrapInto(x: number): number {
  return ((x % WORLD_W) + WORLD_W) % WORLD_W;
}

/** Shortest signed delta from -> to on the WORLD_W ring (-WORLD_W/2 .. WORLD_W/2).
 *  The world wraps, so the camera must chase the ship the short way round. */
function wrapDelta(from: number, to: number): number {
  let d = (to - from) % WORLD_W;
  if (d < -WORLD_W / 2) d += WORLD_W;
  if (d > WORLD_W / 2) d -= WORLD_W;
  return d;
}

function renderWorldW(): number {
  return deathmatchActive() ? deathmatchWorldW() : WORLD_W;
}

function renderWorldH(): number {
  return deathmatchActive() ? deathmatchWorldH() : WORLD_H;
}

function clampCamera(v: number, strip: number, world: number): number {
  if (strip >= world) return world / 2;
  return Math.max(strip / 2, Math.min(world - strip / 2, v));
}

/** Phases the follow camera tracks the ship through. Menus, game-over, the
 *  warp tunnel and the death replay keep the static contain transform. */
function isFollowPhase(phase: GameState['phase']): boolean {
  return phase === 'playing' || phase === 'wavestart'
    || phase === 'bonus' || phase === 'paused';
}

/** Re-assert the clean centred world transform for UI overlays (wave banner,
 *  intertitle, countdown, bonus banner) laid out in WORLD coords, dropping any
 *  screen-shake translate so the banners stay rock-steady during impacts. */
function applyOverlayTransform(ctx: CanvasRenderingContext2D): void {
  const t = renderMode;
  if (t.kind === 'modern') {
    // Follow mode shows the world at full height; lay banners out at that
    // scale, centred horizontally on the viewport, so they read full-size
    // rather than shrunk into the old contain band.
    const s = t.follow ? t.vh / WORLD_H : t.scale;
    const txc = t.vw / 2 - (WORLD_W / 2) * s;
    const tyc = t.vh / 2 - (WORLD_H / 2) * s;
    ctx.setTransform(t.dpr * s, 0, 0, t.dpr * s, t.dpr * txc, t.dpr * tyc);
  } else {
    ctx.setTransform(t.dpr, 0, 0, t.dpr, 0, 0);
  }
}

/** Hide the on-canvas HUD and banners for render() calls. The watch
 *  live tiles use this so the small preview shows only the entity
 *  layer; score / wave / sats sit in the tile's own chrome instead. */
let hudHidden = false;
export function setHudHidden(hidden: boolean): void { hudHidden = hidden; }
export function getRenderModeKind(): 'retro' | 'modern' { return renderMode.kind; }

/** Visible viewport width expressed in WORLD coords after applyOverlayTransform
 *  has been applied. In portrait/follow modern mode the world is scaled to fit
 *  the viewport height, so the visible WORLD-X span is narrower than WORLD_W —
 *  long banner strings need to know this to shrink themselves to fit instead
 *  of spilling off both edges. Retro is always letterboxed to WORLD_W. */
function overlayWorldWidth(): number {
  const t = renderMode;
  if (t.kind === 'modern') {
    const s = t.follow ? t.vh / WORLD_H : t.scale;
    return t.vw / s;
  }
  return WORLD_W;
}

/** Shrink the font size until `text` measures within `maxWorldPx`. Returns
 *  the chosen px so the caller can use it for layout (line spacing). The
 *  caller passes a fontTemplate that takes a pixel size and returns a full
 *  CSS font string, so weight/family stay under its control. */
function fitFontToWidth(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontTemplate: (px: number) => string,
  initialPx: number,
  maxWorldPx: number,
  minPx = 9,
): number {
  let px = initialPx;
  ctx.font = fontTemplate(px);
  while (px > minPx && ctx.measureText(text).width > maxWorldPx) {
    px -= 1;
    ctx.font = fontTemplate(px);
  }
  return px;
}

/** Title-screen background cycling: rotates through wave bgs every 30s,
 *  skipping the wave-25 finale image so the boss reveal stays for in-game. */
let titleBgStartedAt = 0;
const TITLE_BG_INTERVAL_MS = 30_000;
const TITLE_BG_MAX = 24;  // wave 25 (Event Horizon) excluded — saves the reveal

/** Arena containment void: a flat dark field that replaces the wave
 *  backdrop. Mirrors drawBackground's modern/retro split, modern fills the
 *  whole canvas in device space, retro fills the 1280x720 world rect. */
function drawArenaVoid(ctx: CanvasRenderingContext2D): void {
  if (renderMode.kind === 'modern') {
    ctx.save();
    ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, renderMode.vw, renderMode.vh);
    ctx.restore();
  } else {
    ctx.fillStyle = '#04060e';
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  }
}

/** Arena cage floor: a faint world-anchored grid clipped to the current
 *  cage ellipse, so the playable area reads as a measured space. As the
 *  cage shrinks the grid simply shows cropped smaller. Under the entities. */
function drawArenaGrid(ctx: CanvasRenderingContext2D, cage: ArenaCage, now: number): void {
  const STEP = 80;
  const l = cage.cx - cage.rx, r = cage.cx + cage.rx;
  const t = cage.cy - cage.ry, b = cage.cy + cage.ry;
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cage.cx, cage.cy, cage.rx, cage.ry, 0, 0, Math.PI * 2);
  ctx.clip();
  ctx.strokeStyle = `rgba(96, 156, 200, ${0.085 + 0.025 * Math.sin(now * 0.0014)})`;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = Math.ceil(l / STEP) * STEP; x <= r; x += STEP) {
    ctx.moveTo(x, t);
    ctx.lineTo(x, b);
  }
  for (let y = Math.ceil(t / STEP) * STEP; y <= b; y += STEP) {
    ctx.moveTo(l, y);
    ctx.lineTo(r, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Arena cage wall: a glowing, breathing ellipse. The ring stays calm cyan
 *  except for a hot arc that tracks the ship and flushes red as the ship
 *  closes on the wall, so the shrinking cage telegraphs its danger. The
 *  ellipse geometry itself already breathes; this adds the glow. Drawn
 *  over the entity layer. */
function drawArenaWalls(
  ctx: CanvasRenderingContext2D, state: GameState, cage: ArenaCage, now: number,
): void {
  const breath = 0.5 + 0.5 * Math.sin(now * 0.0022);
  ctx.save();
  ctx.lineCap = 'round';

  // Base ring — calm cyan, gently shimmering.
  ctx.strokeStyle = `rgba(96, 206, 232, ${0.5 + 0.2 * breath})`;
  ctx.shadowColor = 'rgb(96, 206, 232)';
  ctx.shadowBlur = 14 + breath * 8;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(cage.cx, cage.cy, cage.rx, cage.ry, 0, 0, Math.PI * 2);
  ctx.stroke();

  // Danger arc — when the ship nears the wall a hot segment of the ring,
  // centred on the nearest point, flushes red. norm is 0 at the cage
  // centre and 1 at the wall.
  const ship = state.players[0].ship;
  if (ship.alive) {
    const ex = (ship.pos.x - cage.cx) / cage.rx;
    const ey = (ship.pos.y - cage.cy) / cage.ry;
    const norm = Math.hypot(ex, ey);
    const heat = Math.max(0, Math.min(1, (norm - 0.62) / 0.38));
    if (heat > 0) {
      const ang = Math.atan2(ey, ex);
      const span = 0.5 + 0.7 * heat;
      const rr = Math.round(120 + heat * 135);
      const gg = Math.round(180 - heat * 150);
      const bb = Math.round(210 - heat * 170);
      ctx.strokeStyle = `rgba(${rr}, ${gg}, ${bb}, ${0.55 + 0.4 * heat})`;
      ctx.shadowColor = `rgb(${rr}, ${gg}, ${bb})`;
      ctx.shadowBlur = 16 + heat * 26;
      ctx.lineWidth = 3 + heat * 4;
      ctx.beginPath();
      ctx.ellipse(cage.cx, cage.cy, cage.rx, cage.ry, 0, ang - span, ang + span);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/** Lazy-loaded photoreal Defender tile (originals/defender-tile.png →
 *  public/backgrounds/defender-tile.webp). 3072×1024 with seam-safe
 *  edges generated by the gpt-image-2 prompt in tools/. If the asset
 *  hasn't loaded yet, drawDefenderBackground falls back to the solid
 *  void + starfields alone. */
let defenderTile: HTMLImageElement | 'pending' | 'failed' | null = null;
function loadDefenderTile(): HTMLImageElement | null {
  if (defenderTile === 'failed') return null;
  if (defenderTile === 'pending') return null;
  if (defenderTile) return defenderTile;
  defenderTile = 'pending';
  const img = new Image();
  img.onload = () => { defenderTile = img; };
  img.onerror = () => { defenderTile = 'failed'; };
  img.src = '/backgrounds/defender-tile.webp';
  return null;
}

let deathmatchDeepSpace: HTMLImageElement | 'pending' | 'failed' | null = null;
function loadDeathmatchDeepSpace(): HTMLImageElement | null {
  if (deathmatchDeepSpace === 'failed') return null;
  if (deathmatchDeepSpace === 'pending') return null;
  if (deathmatchDeepSpace) return deathmatchDeepSpace;
  deathmatchDeepSpace = 'pending';
  const img = new Image();
  img.onload = () => { deathmatchDeepSpace = img; };
  img.onerror = () => { deathmatchDeepSpace = 'failed'; };
  img.src = '/backgrounds/deathmatch-deep-space.png';
  return null;
}

type SolarSpriteKind =
  | 'sol' | 'mercury' | 'venus' | 'earth' | 'moon' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'pluto' | 'belt'
  | 'charon' | 'phobos' | 'deimos' | 'io' | 'europa' | 'ganymede' | 'callisto'
  | 'titan' | 'enceladus' | 'rhea' | 'iapetus' | 'mimas' | 'hyperion';
const SOLAR_SPRITE_KINDS: readonly SolarSpriteKind[] = [
  'sol', 'mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'pluto', 'belt',
  'charon', 'phobos', 'deimos', 'io', 'europa', 'ganymede', 'callisto',
  'titan', 'enceladus', 'rhea', 'iapetus', 'mimas', 'hyperion',
];
const solarSprites: Map<SolarSpriteKind, HTMLImageElement | 'pending' | 'failed'> = new Map();

function loadSolarSprite(kind: SolarSpriteKind): HTMLImageElement | null {
  const cached = solarSprites.get(kind);
  if (cached === 'failed' || cached === 'pending') return null;
  if (cached) return cached;
  solarSprites.set(kind, 'pending');
  const img = new Image();
  img.onload = () => { solarSprites.set(kind, img); };
  img.onerror = () => { solarSprites.set(kind, 'failed'); };
  img.src = `/backgrounds/solar/${kind}.png`;
  return null;
}

function preloadSolarSprites(): void {
  if (typeof Image === 'undefined') return;
  for (const kind of SOLAR_SPRITE_KINDS) loadSolarSprite(kind);
}

preloadSolarSprites();

function drawSolarSprite(
  ctx: CanvasRenderingContext2D,
  kind: SolarSpriteKind,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha = 1,
): boolean {
  const img = loadSolarSprite(kind);
  if (!img || img.width <= 0 || img.height <= 0) return false;
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  ctx.restore();
  return true;
}

function drawSolarSpritePreserveAspect(
  ctx: CanvasRenderingContext2D,
  kind: SolarSpriteKind,
  x: number,
  y: number,
  diameter: number,
  alpha = 1,
): boolean {
  const img = loadSolarSprite(kind);
  if (!img || img.width <= 0 || img.height <= 0) return false;
  const aspect = img.width / Math.max(1, img.height);
  const w = aspect >= 1 ? diameter * aspect : diameter;
  const h = aspect >= 1 ? diameter : diameter / Math.max(0.1, aspect);
  ctx.save();
  ctx.globalAlpha *= alpha;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
  ctx.restore();
  return true;
}

function drawCoverImage(ctx: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

function drawCoverImageBounds(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  worldW: number,
  worldH: number,
  bounds: WorldBounds | undefined,
): void {
  if (!bounds) {
    drawCoverImage(ctx, img, 0, 0, worldW, worldH);
    return;
  }
  const scale = Math.max(worldW / img.width, worldH / img.height);
  const drawW = img.width * scale;
  const drawH = img.height * scale;
  const drawX = (worldW - drawW) / 2;
  const drawY = (worldH - drawH) / 2;
  const sx = (bounds.x0 - drawX) / scale;
  const sy = (bounds.y0 - drawY) / scale;
  const sw = (bounds.x1 - bounds.x0) / scale;
  const sh = (bounds.y1 - bounds.y0) / scale;
  ctx.drawImage(img, sx, sy, sw, sh, bounds.x0, bounds.y0, bounds.x1 - bounds.x0, bounds.y1 - bounds.y0);
}

/** Two lazy-built starfield layers for the Defender preview. The base
 *  tile (defenderTile, ~3:1 ultra-wide image) is the "very distant"
 *  layer; these two add mid-distance and near-field depth on top. */
let defenderMid: HTMLCanvasElement | null = null;
let defenderNear: HTMLCanvasElement | null = null;

function getDefenderLayers(): [HTMLCanvasElement, HTMLCanvasElement] {
  if (!defenderMid) {
    defenderMid = buildSeamlessStarfield({ width: WORLD_W, height: WORLD_H, seed: 600_000_002, stars: 140 });
  }
  if (!defenderNear) {
    defenderNear = buildSeamlessStarfield({ width: WORLD_W, height: WORLD_H, seed: 600_000_003, stars: 60 });
  }
  return [defenderMid, defenderNear];
}

/** Defender preview bg: photoreal seamless tile + two parallax
 *  starfields. The tile lives behind the starfields and scrolls at
 *  ~10% camera speed (very distant); the starfields then layer mid
 *  and near depth on top. Honours the world transform that the follow
 *  camera has already applied, so absolute positions in the draw
 *  calls implicitly read at `(world-coord - camX) * scale` in device
 *  space. */
function drawDefenderBackground(ctx: CanvasRenderingContext2D): void {
  // Solid void base — covers everything the follow camera might pan to,
  // including the wrap-seam copies past x=0 and x=WORLD_W.
  ctx.fillStyle = '#03060e';
  ctx.fillRect(-WORLD_W, -WORLD_H, WORLD_W * 3, WORLD_H * 3);

  // Distant photoreal tile. 3072x1024 source means the tile is ~2.4x the
  // world width — covers the whole viewport when scaled to height plus
  // generous lateral overdraw. We blit it twice so the wrap reads
  // continuously regardless of where camX lands.
  const tile = loadDefenderTile();
  if (tile && tile.width > 0) {
    // Scale to world height; preserve aspect for the tile's width
    const tileH = WORLD_H;
    const tileW = tile.width * (WORLD_H / tile.height);
    // Distant parallax: tile shifts at 10% camera speed. World-coord
    // x = camX * 0.90 places the tile so it appears to move at 0.10x.
    // Centre vertically.
    const baseX = camX * 0.90;
    // Two blits cover the wraparound seam. norm = baseX mod tileW
    // (positive). Draw at (baseX - norm) and (baseX - norm + tileW).
    const norm = ((baseX % tileW) + tileW) % tileW;
    const leftX = baseX - norm;
    ctx.drawImage(tile, leftX, 0, tileW, tileH);
    ctx.drawImage(tile, leftX + tileW, 0, tileW, tileH);
    // Knock-back overlay so the asteroid silhouettes still read against
    // the brightest patches of the tile. Same trick as the wave-N bg.
    ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.fillRect(-WORLD_W, 0, WORLD_W * 3, WORLD_H);
  }

  const [mid, near] = getDefenderLayers();
  // Mid stars: drift at 50% of camera speed (factor 0.50 of camX).
  ctx.save();
  ctx.translate(camX * 0.50, 0);
  drawParallaxStarfield(ctx, mid, { viewportW: WORLD_W, parallaxX: 0 });
  ctx.restore();
  // Near stars: drift at 85% of camera speed (factor 0.15 of camX).
  ctx.save();
  ctx.translate(camX * 0.15, 0);
  drawParallaxStarfield(ctx, near, { viewportW: WORLD_W, parallaxX: 0 });
  ctx.restore();
}

function drawDeathmatchBackground(ctx: CanvasRenderingContext2D, now: number, orbitMs: number, bounds?: WorldBounds): void {
  const rw = deathmatchWorldW();
  const rh = deathmatchWorldH();
  const fillX = bounds?.x0 ?? 0;
  const fillY = bounds?.y0 ?? 0;
  const fillW = bounds ? bounds.x1 - bounds.x0 : rw;
  const fillH = bounds ? bounds.y1 - bounds.y0 : rh;
  ctx.fillStyle = '#02050c';
  ctx.fillRect(fillX, fillY, fillW, fillH);

  const deepSpace = loadDeathmatchDeepSpace();
  if (deepSpace && deepSpace.width > 0) {
    drawCoverImageBounds(ctx, deepSpace, rw, rh, bounds);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.36)';
    ctx.fillRect(fillX, fillY, fillW, fillH);
  }

  const nebulae = [
    { x: rw * 0.18, y: rh * 0.22, r: 720, c0: 'rgba(70, 120, 210, 0.13)', c1: 'rgba(70, 120, 210, 0)' },
    { x: rw * 0.76, y: rh * 0.34, r: 860, c0: 'rgba(190, 80, 120, 0.10)', c1: 'rgba(190, 80, 120, 0)' },
    { x: rw * 0.54, y: rh * 0.78, r: 940, c0: 'rgba(70, 210, 180, 0.08)', c1: 'rgba(70, 210, 180, 0)' },
  ];
  for (const n of nebulae) {
    if (!boundsIntersectCircle(bounds, n.x, n.y, n.r)) continue;
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
    g.addColorStop(0, n.c0);
    g.addColorStop(1, n.c1);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    ctx.fill();
  }

  const fallbackGalaxies = deepSpace ? [] : [
    { x: rw * 0.34, y: rh * 0.16, rx: 260, ry: 70, rot: -0.35 },
    { x: rw * 0.82, y: rh * 0.72, rx: 320, ry: 84, rot: 0.42 },
  ];
  for (const g of fallbackGalaxies) {
    if (!boundsIntersectRect(bounds, g.x - g.rx, g.y - g.rx, g.x + g.rx, g.y + g.rx)) continue;
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rot + Math.sin(now * 0.00004) * 0.02);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, g.rx);
    grad.addColorStop(0, 'rgba(245, 240, 210, 0.55)');
    grad.addColorStop(0.22, 'rgba(160, 190, 255, 0.24)');
    grad.addColorStop(1, 'rgba(160, 190, 255, 0)');
    ctx.scale(1, g.ry / g.rx);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, g.rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  drawDeathmatchSolarScenery(ctx, rw, rh, orbitMs, bounds);

  ctx.fillStyle = 'rgba(230, 245, 255, 0.9)';
  for (let i = 0; i < 360; i++) {
    const x = ((i * 977 + 271) % 4096) / 4096 * rw;
    const y = ((i * 577 + 911) % 4096) / 4096 * rh;
    if (bounds && (x < bounds.x0 - 4 || x > bounds.x1 + 4 || y < bounds.y0 - 4 || y > bounds.y1 + 4)) continue;
    const twinkle = 0.55 + 0.45 * Math.sin(now * 0.0015 + i * 11.37);
    const r = (i % 9 === 0 ? 1.8 : i % 5 === 0 ? 1.25 : 0.75) * twinkle;
    ctx.globalAlpha = 0.42 + twinkle * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function normalise2(dx: number, dy: number): { x: number; y: number } {
  const d = Math.hypot(dx, dy) || 1;
  return { x: dx / d, y: dy / d };
}

function applyTerminator(ctx: CanvasRenderingContext2D, r: number, light: { x: number; y: number }, opacity: number): void {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const shade = ctx.createRadialGradient(light.x * r * 0.42, light.y * r * 0.42, r * 0.1, -light.x * r * 0.62, -light.y * r * 0.62, r * 1.25);
  shade.addColorStop(0, 'rgba(255,255,255,1)');
  shade.addColorStop(0.48, 'rgba(190,190,190,0.96)');
  shade.addColorStop(1, `rgba(0,0,0,${opacity})`);
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function solarFract(n: number): number {
  return n - Math.floor(n);
}

function solarHash(seed: number): number {
  return solarFract(Math.sin(seed * 127.1 + 311.7) * 43758.5453123);
}

function drawOrganicPatch(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rot: number,
  seed: number,
  points = 18,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  ctx.beginPath();
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const wobble = 0.72 + solarHash(seed + i * 13.91) * 0.48;
    const x = Math.cos(a) * rx * wobble;
    const y = Math.sin(a) * ry * (0.74 + solarHash(seed + i * 7.37) * 0.42);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawSolarAtmosphere(
  ctx: CanvasRenderingContext2D,
  r: number,
  light: { x: number; y: number },
  colour: string,
  alpha: number,
): void {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = alpha;
  ctx.shadowColor = colour;
  ctx.shadowBlur = r * 0.18;
  ctx.strokeStyle = colour;
  ctx.lineWidth = Math.max(1.5, r * 0.045);
  ctx.beginPath();
  ctx.arc(0, 0, r - ctx.lineWidth * 0.35, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = alpha * 0.7;
  const g = ctx.createRadialGradient(light.x * r * 0.96, light.y * r * 0.96, 0, light.x * r * 0.96, light.y * r * 0.96, r * 0.42);
  g.addColorStop(0, colour);
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(light.x * r * 0.68, light.y * r * 0.68, r * 0.46, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawOrbit(ctx: CanvasRenderingContext2D, sx: number, sy: number, rx: number, ry: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(150, 180, 220, 0.10)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawSol(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, now: number): void {
  const photo = loadSolarSprite('sol');
  if (photo) {
    ctx.save();
    const pulse = 1 + Math.sin(now * 0.0012) * 0.018;
    const corona = ctx.createRadialGradient(x, y, r * 0.55, x, y, r * 5.8 * pulse);
    corona.addColorStop(0, 'rgba(255, 240, 170, 0.36)');
    corona.addColorStop(0.12, 'rgba(255, 154, 58, 0.18)');
    corona.addColorStop(0.42, 'rgba(255, 98, 44, 0.045)');
    corona.addColorStop(1, 'rgba(255, 98, 44, 0)');
    ctx.fillStyle = corona;
    ctx.beginPath();
    ctx.arc(x, y, r * 5.8 * pulse, 0, Math.PI * 2);
    ctx.fill();
    drawSolarSprite(ctx, 'sol', x, y, r * 3.85 * pulse, r * 3.78 * pulse);
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.translate(x, y);
  const pulse = 1 + Math.sin(now * 0.0012) * 0.025;
  const corona = ctx.createRadialGradient(0, 0, r * 0.08, 0, 0, r * 7.2 * pulse);
  corona.addColorStop(0, 'rgba(255, 252, 210, 0.94)');
  corona.addColorStop(0.06, 'rgba(255, 216, 118, 0.50)');
  corona.addColorStop(0.18, 'rgba(255, 138, 56, 0.19)');
  corona.addColorStop(0.46, 'rgba(255, 88, 42, 0.045)');
  corona.addColorStop(1, 'rgba(255, 120, 64, 0)');
  ctx.fillStyle = corona;
  ctx.beginPath();
  ctx.arc(0, 0, r * 7.2 * pulse, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const a = i * 2.399963 + Math.sin(now * 0.00009 + i) * 0.04;
    const inner = r * (1.05 + solarHash(i + 1) * 0.2);
    const outer = r * (2.2 + solarHash(i + 17) * 1.9) * pulse;
    ctx.strokeStyle = i % 3 === 0 ? 'rgba(255, 234, 154, 0.17)' : 'rgba(255, 142, 78, 0.10)';
    ctx.lineWidth = r * (0.018 + solarHash(i + 23) * 0.026);
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.quadraticCurveTo(
      Math.cos(a + 0.22) * outer * 0.76,
      Math.sin(a + 0.22) * outer * 0.76,
      Math.cos(a + 0.05) * outer,
      Math.sin(a + 0.05) * outer,
    );
    ctx.stroke();
  }
  ctx.restore();
  const disc = ctx.createRadialGradient(-r * 0.32, -r * 0.36, r * 0.05, 0, 0, r);
  disc.addColorStop(0, '#fffef0');
  disc.addColorStop(0.28, '#fff2a6');
  disc.addColorStop(0.58, '#ffbf50');
  disc.addColorStop(1, '#ff6e28');
  ctx.fillStyle = disc;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 58; i++) {
    const a = i * 2.399963 + now * 0.00008;
    const d = Math.sqrt(solarHash(i + 41)) * r * 0.92;
    const gr = r * (0.035 + solarHash(i + 57) * 0.055);
    const gx = Math.cos(a) * d;
    const gy = Math.sin(a * 1.07) * d;
    const cell = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
    cell.addColorStop(0, i % 4 === 0 ? 'rgba(255,255,235,0.24)' : 'rgba(255,198,76,0.18)');
    cell.addColorStop(1, 'rgba(255,142,54,0)');
    ctx.fillStyle = cell;
    ctx.beginPath();
    ctx.arc(gx, gy, gr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(255, 255, 220, 0.72)';
  ctx.lineWidth = Math.max(1.5, r * 0.035);
  ctx.beginPath();
  ctx.arc(0, 0, r - ctx.lineWidth * 0.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawShadedMoon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, base: string, light: { x: number; y: number }, phase: number): void {
  ctx.save();
  ctx.translate(x, y);
  const grad = ctx.createRadialGradient(light.x * r * 0.35, light.y * r * 0.35, r * 0.08, 0, 0, r);
  grad.addColorStop(0, 'rgba(255,255,245,0.95)');
  grad.addColorStop(0.34, base);
  grad.addColorStop(1, 'rgba(18,22,34,0.98)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  const craterCount = Math.max(5, Math.min(18, Math.round(r * 0.55)));
  for (let i = 0; i < craterCount; i++) {
    const a = i * 2.399963 + phase * 0.31;
    const d = Math.sqrt(solarHash(phase + i * 5.1)) * r * 0.82;
    const cx = Math.cos(a) * d;
    const cy = Math.sin(a * 1.17) * d;
    const cr = r * (0.045 + solarHash(phase + i * 9.7) * 0.085);
    ctx.fillStyle = 'rgba(18, 20, 26, 0.18)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, cr, cr * (0.55 + solarHash(i + 3) * 0.35), a * 0.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 238, 0.14)';
    ctx.lineWidth = Math.max(0.6, cr * 0.16);
    ctx.stroke();
  }
  ctx.restore();
  applyTerminator(ctx, r, light, 0.72);
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(light.x * r * 0.28, light.y * r * 0.26, r * (0.20 + Math.sin(phase) * 0.025), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawTransitShadow(ctx: CanvasRenderingContext2D, r: number, light: { x: number; y: number }, moonDir: { x: number; y: number }, moonScale: number): void {
  const alignment = light.x * moonDir.x + light.y * moonDir.y;
  if (alignment < 0.94) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = Math.min(0.55, (alignment - 0.94) / 0.06 * 0.45);
  const shadowR = Math.max(2.5, r * moonScale);
  const sx = moonDir.x * r * 0.42;
  const sy = moonDir.y * r * 0.42;
  const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, shadowR);
  g.addColorStop(0, 'rgba(0,0,0,0.92)');
  g.addColorStop(0.58, 'rgba(0,0,0,0.52)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(sx, sy, shadowR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

type SolarTextureKind = 'venus' | 'earth' | 'mars' | 'jupiter' | 'saturn';
const SOLAR_TEXTURE_CACHE_LIMIT = 256;
const solarTextureCache = new Map<string, HTMLCanvasElement>();

function solarRotationBucket(rotation: number, steps = 96): number {
  const turn = Math.PI * 2;
  return Math.floor((((rotation % turn) + turn) % turn) / turn * steps);
}

function getSolarTexture(
  kind: SolarTextureKind,
  r: number,
  rotation: number,
  paint: (ctx: CanvasRenderingContext2D, r: number, bucket: number) => void,
  steps = 32,
): HTMLCanvasElement {
  const size = Math.max(8, Math.ceil(r * 2));
  const bucket = solarRotationBucket(rotation, steps);
  const key = `${kind}:${size}:${bucket}`;
  const cached = solarTextureCache.get(key);
  if (cached) return cached;

  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const x = c.getContext('2d');
  if (!x) return c;
  x.translate(size / 2, size / 2);
  x.beginPath();
  x.arc(0, 0, r, 0, Math.PI * 2);
  x.clip();
  paint(x, r, bucket);
  solarTextureCache.set(key, c);
  if (solarTextureCache.size > SOLAR_TEXTURE_CACHE_LIMIT) {
    const first = solarTextureCache.keys().next().value;
    if (first) solarTextureCache.delete(first);
  }
  return c;
}

function drawCachedSolarTexture(
  ctx: CanvasRenderingContext2D,
  kind: SolarTextureKind,
  r: number,
  rotation: number,
  paint: (ctx: CanvasRenderingContext2D, r: number, bucket: number) => void,
  steps = 32,
): void {
  const tex = getSolarTexture(kind, r, rotation, paint, steps);
  ctx.drawImage(tex, -r, -r, r * 2, r * 2);
}

function applySolarDiscLight(ctx: CanvasRenderingContext2D, r: number, light: { x: number; y: number }, warmth = 0.35): void {
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  const g = ctx.createRadialGradient(light.x * r * 0.55, light.y * r * 0.55, 0, light.x * r * 0.15, light.y * r * 0.15, r * 1.2);
  g.addColorStop(0, `rgba(255, 246, 210, ${warmth})`);
  g.addColorStop(0.38, `rgba(255, 216, 148, ${warmth * 0.22})`);
  g.addColorStop(1, 'rgba(255, 216, 148, 0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawSolarPhotoDisc(
  ctx: CanvasRenderingContext2D,
  kind: Exclude<SolarSpriteKind, 'sol' | 'saturn' | 'belt'>,
  x: number,
  y: number,
  r: number,
  light: { x: number; y: number },
  atmosphere?: { colour: string; alpha: number },
): boolean {
  if (!drawSolarSprite(ctx, kind, x, y, r * 2.02, r * 2.02)) return false;
  ctx.save();
  ctx.translate(x, y);
  applySolarDiscLight(ctx, r, light, 0.10);
  applyTerminator(ctx, r, light, 0.12);
  if (atmosphere) drawSolarAtmosphere(ctx, r, light, atmosphere.colour, atmosphere.alpha);
  ctx.restore();
  return true;
}

function drawMercury(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }): void {
  if (drawSolarPhotoDisc(ctx, 'mercury', x, y, r, light, { colour: 'rgba(255, 235, 194, 0.52)', alpha: 0.10 })) return;
  drawShadedMoon(ctx, x, y, r, '#9d9a91', light, 0.2);
}

function drawVenus(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }, now: number, rotation = now * 0.00007): void {
  if (drawSolarPhotoDisc(ctx, 'venus', x, y, r, light, { colour: 'rgba(255, 222, 150, 0.78)', alpha: 0.20 })) return;

  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  drawCachedSolarTexture(ctx, 'venus', r, rotation, (xctx, rr, bucket) => {
    const base = xctx.createRadialGradient(-rr * 0.25, -rr * 0.30, rr * 0.08, 0, 0, rr);
    base.addColorStop(0, '#fff7cc');
    base.addColorStop(0.42, '#d9ab5c');
    base.addColorStop(0.74, '#8b5f3f');
    base.addColorStop(1, '#3d2a26');
    xctx.fillStyle = base;
    xctx.fillRect(-rr, -rr, rr * 2, rr * 2);
    xctx.lineCap = 'round';
    for (let i = 0; i < 18; i++) {
      const yy = (-0.82 + i * 0.10) * rr;
      const warm = i % 3 === 0 ? 'rgba(255, 245, 200, 0.38)' : i % 3 === 1 ? 'rgba(180, 111, 64, 0.25)' : 'rgba(255, 214, 136, 0.30)';
      xctx.strokeStyle = warm;
      xctx.lineWidth = Math.max(1, rr * (0.030 + (i % 4) * 0.006));
      xctx.beginPath();
      const drift = (bucket / 48) * rr * 0.44;
      xctx.moveTo(-rr * 1.1, yy + Math.sin(i * 1.7 + bucket * 0.12) * rr * 0.035);
      for (let px = -rr; px <= rr; px += rr * 0.22) {
        const wobble = Math.sin(px * 0.035 + i * 1.3 + bucket * 0.18) * rr * 0.045;
        xctx.lineTo(px, yy + wobble + Math.sin((px + drift) * 0.018) * rr * 0.025);
      }
      xctx.stroke();
    }
    xctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 7; i++) {
      const a = i * 1.73 + bucket * 0.05;
      const gx = Math.cos(a) * rr * 0.38;
      const gy = Math.sin(a * 1.4) * rr * 0.48;
      const g = xctx.createRadialGradient(gx, gy, 0, gx, gy, rr * (0.18 + solarHash(i) * 0.13));
      g.addColorStop(0, 'rgba(255, 245, 198, 0.20)');
      g.addColorStop(1, 'rgba(255, 210, 118, 0)');
      xctx.fillStyle = g;
      xctx.beginPath();
      xctx.arc(gx, gy, rr * 0.35, 0, Math.PI * 2);
      xctx.fill();
    }
  }, 48);
  applySolarDiscLight(ctx, r, light, 0.28);
  applyTerminator(ctx, r, light, 0.67);
  drawSolarAtmosphere(ctx, r, light, 'rgba(255, 222, 150, 0.78)', 0.34);
  ctx.restore();
}

function drawEarth(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }, now: number, rotation = now * 0.00018): void {
  if (drawSolarPhotoDisc(ctx, 'earth', x, y, r, light, { colour: 'rgba(120, 218, 255, 0.88)', alpha: 0.26 })) return;

  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  drawCachedSolarTexture(ctx, 'earth', r, rotation, (xctx, rr, bucket) => {
    const ocean = xctx.createRadialGradient(-rr * 0.24, -rr * 0.28, rr * 0.1, 0, 0, rr);
    ocean.addColorStop(0, '#c6fbff');
    ocean.addColorStop(0.34, '#2d95c5');
    ocean.addColorStop(0.68, '#0a4f96');
    ocean.addColorStop(1, '#051843');
    xctx.fillStyle = ocean;
    xctx.fillRect(-rr, -rr, rr * 2, rr * 2);
    const spin = bucket / 64;
    const land = [
      { lon: 0.04, lat: -0.24, sx: 0.27, sy: 0.22, rot: -0.30, seed: 10 },
      { lon: 0.15, lat: 0.12, sx: 0.20, sy: 0.28, rot: 0.32, seed: 20 },
      { lon: 0.38, lat: -0.02, sx: 0.34, sy: 0.18, rot: 0.08, seed: 30 },
      { lon: 0.60, lat: 0.20, sx: 0.18, sy: 0.13, rot: -0.18, seed: 40 },
      { lon: 0.74, lat: -0.30, sx: 0.24, sy: 0.18, rot: 0.25, seed: 50 },
      { lon: 0.87, lat: 0.06, sx: 0.28, sy: 0.20, rot: -0.38, seed: 60 },
    ];
    for (const l of land) {
      const lon = (((l.lon + spin) % 1) * 2 - 1) * rr * 1.42;
      const lat = l.lat * rr;
      xctx.fillStyle = 'rgba(64, 151, 82, 0.98)';
      drawOrganicPatch(xctx, lon, lat, rr * l.sx, rr * l.sy, l.rot, l.seed + bucket * 0.03, 20);
      xctx.fillStyle = 'rgba(188, 158, 88, 0.42)';
      drawOrganicPatch(xctx, lon + rr * 0.02, lat + rr * 0.02, rr * l.sx * 0.64, rr * l.sy * 0.48, l.rot + 0.18, l.seed + 88 + bucket * 0.03, 14);
    }
    xctx.fillStyle = 'rgba(246, 250, 255, 0.84)';
    xctx.beginPath();
    xctx.ellipse(0, -rr * 0.84, rr * 0.78, rr * 0.095, 0.04, 0, Math.PI * 2);
    xctx.fill();
    xctx.globalCompositeOperation = 'screen';
    xctx.lineCap = 'round';
    for (let i = 0; i < 15; i++) {
      const yy = (-0.70 + i * 0.10) * rr;
      const span = rr * (0.35 + (i % 4) * 0.18);
      xctx.strokeStyle = i % 5 === 0 ? 'rgba(255,255,255,0.64)' : 'rgba(240,250,255,0.34)';
      xctx.lineWidth = Math.max(1, rr * (0.017 + (i % 3) * 0.006));
      xctx.beginPath();
      const ox = Math.sin(spin * 8 + i * 1.37) * rr * 0.42;
      xctx.moveTo(ox - span, yy);
      for (let px = -span; px <= span; px += rr * 0.18) {
        xctx.lineTo(ox + px, yy + Math.sin(px * 0.045 + i + bucket * 0.16) * rr * 0.024);
      }
      xctx.stroke();
    }
    xctx.globalCompositeOperation = 'source-over';
  }, 64);
  applySolarDiscLight(ctx, r, light, 0.34);
  applyTerminator(ctx, r, light, 0.66);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = 'rgba(255, 224, 132, 0.62)';
  for (let i = 0; i < 34; i++) {
    const a = i * 2.399963 + rotation * 0.18;
    const d = Math.sqrt(solarHash(i + 101)) * r * 0.70;
    const px = Math.cos(a) * d;
    const py = Math.sin(a * 1.11) * d;
    if (px * light.x + py * light.y > -r * 0.08) continue;
    ctx.globalAlpha = 0.20 + solarHash(i + 3) * 0.42;
    ctx.beginPath();
    ctx.arc(px, py, Math.max(0.8, r * 0.010), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
  drawSolarAtmosphere(ctx, r, light, 'rgba(120, 218, 255, 0.88)', 0.42);
  ctx.restore();
}

function drawMars(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }, now: number, rotation = now * 0.00005): void {
  if (drawSolarPhotoDisc(ctx, 'mars', x, y, r, light, { colour: 'rgba(255, 170, 108, 0.55)', alpha: 0.16 })) return;

  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  drawCachedSolarTexture(ctx, 'mars', r, rotation, (xctx, rr, bucket) => {
    const base = xctx.createRadialGradient(-rr * 0.22, -rr * 0.28, rr * 0.08, 0, 0, rr);
    base.addColorStop(0, '#ffd1a8');
    base.addColorStop(0.42, '#be6237');
    base.addColorStop(0.72, '#7d3925');
    base.addColorStop(1, '#3f1b16');
    xctx.fillStyle = base;
    xctx.fillRect(-rr, -rr, rr * 2, rr * 2);
    const spin = bucket / 48;
    for (let i = 0; i < 18; i++) {
      const lon = (((i * 0.19 + spin) % 1) * 2 - 1) * rr * 1.18;
      const lat = Math.sin(i * 1.31) * rr * 0.46;
      xctx.fillStyle = i % 4 === 0 ? 'rgba(242, 165, 88, 0.30)' : 'rgba(66, 29, 23, 0.42)';
      drawOrganicPatch(xctx, lon, lat, rr * (0.09 + solarHash(i) * 0.12), rr * (0.030 + solarHash(i + 7) * 0.045), i * 0.39, i + bucket * 0.04, 12);
    }
    xctx.strokeStyle = 'rgba(82, 30, 23, 0.46)';
    xctx.lineWidth = Math.max(1, rr * 0.020);
    xctx.beginPath();
    xctx.moveTo(-rr * 0.78, rr * 0.10);
    for (let px = -rr * 0.78; px <= rr * 0.50; px += rr * 0.18) {
      xctx.lineTo(px, rr * 0.08 + Math.sin(px * 0.04 + bucket * 0.15) * rr * 0.035);
    }
    xctx.stroke();
    xctx.fillStyle = 'rgba(255, 238, 218, 0.78)';
    xctx.beginPath();
    xctx.ellipse(-rr * 0.12, -rr * 0.72, rr * 0.24, rr * 0.065, 0.08, 0, Math.PI * 2);
    xctx.fill();
    xctx.fillStyle = 'rgba(255, 218, 176, 0.30)';
    xctx.beginPath();
    xctx.ellipse(rr * 0.24, rr * 0.56, rr * 0.38, rr * 0.065, -0.16, 0, Math.PI * 2);
    xctx.fill();
  }, 48);
  applySolarDiscLight(ctx, r, light, 0.26);
  applyTerminator(ctx, r, light, 0.68);
  drawSolarAtmosphere(ctx, r, light, 'rgba(255, 170, 108, 0.55)', 0.22);
  ctx.restore();
}

function drawMarsSystem(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }, now: number, sun: { x: number; y: number }, rotation: number): void {
  const moons = resolveMoonStates(x, y, r, MARS_MOONS, now);
  drawMars(ctx, x, y, r, light, now, rotation);
  drawMoonOrbits(ctx, x, y, r, MARS_MOONS);
  drawSolarMoons(ctx, moons, sun, now);
}

function drawUranusSystem(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }): void {
  if (drawSolarSprite(ctx, 'uranus', x, y, r * 3.10, r * 2.18, 0.96)) {
    ctx.save();
    ctx.translate(x, y);
    applySolarDiscLight(ctx, r, light, 0.07);
    drawSolarAtmosphere(ctx, r, light, 'rgba(160, 245, 255, 0.72)', 0.18);
    ctx.restore();
    return;
  }
  drawShadedMoon(ctx, x, y, r, '#9ad7e4', light, 0.1);
}

function drawPlutoSystem(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }, now: number, sun: { x: number; y: number }): void {
  const moons = resolveMoonStates(x, y, r, PLUTO_MOONS, now);
  if (!drawSolarPhotoDisc(ctx, 'pluto', x, y, r, light, { colour: 'rgba(222, 210, 196, 0.52)', alpha: 0.12 })) {
    drawShadedMoon(ctx, x, y, r, '#b9aaa0', light, 0.3);
  }
  drawMoonOrbits(ctx, x, y, r, PLUTO_MOONS);
  drawSolarMoons(ctx, moons, sun, now);
}

const SOLAR_DAYS_PER_MS = 0.0012;

type SolarMoonSpec = {
  orbit: number;
  flatten: number;
  tilt: number;
  periodDays: number;
  epoch: number;
  size: number;
  colour: string;
  shadowScale: number;
  sprite?: SolarSpriteKind;
  alpha?: number;
};

type SolarMoonState = SolarMoonSpec & {
  x: number;
  y: number;
  dir: { x: number; y: number };
  radius: number;
};

const JUPITER_MOONS: SolarMoonSpec[] = [
  { orbit: 0.86, flatten: 0.24, tilt: -0.12, periodDays: 1.769, epoch: 0.2, size: 0.060, colour: '#e2bd82', shadowScale: 0.040, sprite: 'io' },
  { orbit: 1.05, flatten: 0.24, tilt: -0.12, periodDays: 3.551, epoch: 1.4, size: 0.048, colour: '#d7d2c7', shadowScale: 0.034, sprite: 'europa' },
  { orbit: 1.30, flatten: 0.24, tilt: -0.12, periodDays: 7.155, epoch: 2.6, size: 0.070, colour: '#a9b7c8', shadowScale: 0.048, sprite: 'ganymede' },
  { orbit: 1.62, flatten: 0.24, tilt: -0.12, periodDays: 16.689, epoch: 3.8, size: 0.055, colour: '#8da0b0', shadowScale: 0.038, sprite: 'callisto' },
];

const SATURN_MOONS: SolarMoonSpec[] = [
  { orbit: 2.20, flatten: 0.20, tilt: 0, periodDays: 15.945, epoch: 0.8, size: 0.078, colour: '#d8b27a', shadowScale: 0.052, sprite: 'titan' },
  { orbit: 2.56, flatten: 0.20, tilt: 0, periodDays: 1.370, epoch: 1.6, size: 0.044, colour: '#e8eef0', shadowScale: 0.030, sprite: 'enceladus' },
  { orbit: 2.82, flatten: 0.20, tilt: 0, periodDays: 4.518, epoch: 2.5, size: 0.054, colour: '#c5c8c8', shadowScale: 0.030, sprite: 'rhea' },
  { orbit: 3.12, flatten: 0.20, tilt: 0, periodDays: 79.321, epoch: 3.2, size: 0.052, colour: '#9f9588', shadowScale: 0.026, sprite: 'iapetus' },
  { orbit: 3.34, flatten: 0.20, tilt: 0, periodDays: 0.942, epoch: 4.4, size: 0.038, colour: '#b7b3aa', shadowScale: 0.024, sprite: 'mimas' },
  { orbit: 3.56, flatten: 0.20, tilt: 0, periodDays: 21.277, epoch: 5.0, size: 0.040, colour: '#9f8f7f', shadowScale: 0.024, sprite: 'hyperion' },
];

const MARS_MOONS: SolarMoonSpec[] = [
  { orbit: 1.86, flatten: 0.42, tilt: 0.12, periodDays: 0.319, epoch: 0.7, size: 0.145, colour: '#8a8177', shadowScale: 0.055, sprite: 'phobos' },
  { orbit: 2.56, flatten: 0.42, tilt: 0.12, periodDays: 1.263, epoch: 2.6, size: 0.110, colour: '#756f68', shadowScale: 0.044, sprite: 'deimos' },
];

const PLUTO_MOONS: SolarMoonSpec[] = [
  { orbit: 2.32, flatten: 0.58, tilt: -0.10, periodDays: 6.387, epoch: 2.0, size: 0.330, colour: '#a9a2a0', shadowScale: 0.105, sprite: 'charon' },
];

function solarAngle(now: number, periodDays: number, epoch: number): number {
  return epoch + ((now * SOLAR_DAYS_PER_MS) / periodDays) * Math.PI * 2;
}

function resolveMoonStates(x: number, y: number, r: number, moons: readonly SolarMoonSpec[], now: number): SolarMoonState[] {
  return moons.map((m) => {
    const phase = solarAngle(now, m.periodDays, m.epoch);
    const orbit = r * m.orbit;
    const ox = Math.cos(phase) * orbit;
    const oy = Math.sin(phase) * orbit * m.flatten;
    const ct = Math.cos(m.tilt);
    const st = Math.sin(m.tilt);
    const wx = x + ox * ct - oy * st;
    const wy = y + ox * st + oy * ct;
    return { ...m, x: wx, y: wy, dir: normalise2(wx - x, wy - y), radius: r * m.size };
  });
}

function drawMoonOrbits(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, moons: readonly SolarMoonSpec[]): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(190, 210, 255, 0.08)';
  ctx.lineWidth = 1;
  for (const m of moons) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(m.tilt);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * m.orbit, r * m.orbit * m.flatten, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function drawSolarMoons(ctx: CanvasRenderingContext2D, states: readonly SolarMoonState[], sun: { x: number; y: number }, now: number): void {
  ctx.save();
  ctx.globalAlpha = 0.94;
  for (const m of [...states].sort((a, b) => a.y - b.y)) {
    if (m.sprite && drawSolarSpritePreserveAspect(ctx, m.sprite, m.x, m.y, m.radius * 2.18, m.alpha ?? 0.96)) continue;
    drawShadedMoon(ctx, m.x, m.y, m.radius, m.colour, normalise2(sun.x - m.x, sun.y - m.y), now * 0.0001 + m.epoch);
  }
  ctx.restore();
}

function drawGasGiantSystem(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }, now: number, sun: { x: number; y: number }): void {
  const moons = resolveMoonStates(x, y, r, JUPITER_MOONS, now);
  if (drawSolarPhotoDisc(ctx, 'jupiter', x, y, r, light, { colour: 'rgba(255, 222, 168, 0.60)', alpha: 0.12 })) {
    ctx.save();
    ctx.translate(x, y);
    for (const m of moons) drawTransitShadow(ctx, r, light, m.dir, m.shadowScale);
    ctx.restore();
    drawMoonOrbits(ctx, x, y, r, JUPITER_MOONS);
    drawSolarMoons(ctx, moons, sun, now);
    return;
  }

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.16);
  ctx.globalAlpha = 0.82;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  drawCachedSolarTexture(ctx, 'jupiter', r, solarRotation(now, 0.414), (xctx, rr, bucket) => {
    const base = xctx.createRadialGradient(-rr * 0.28, -rr * 0.34, rr * 0.1, 0, 0, rr);
    base.addColorStop(0, '#fff4d6');
    base.addColorStop(0.28, '#e7b273');
    base.addColorStop(0.58, '#9c694f');
    base.addColorStop(0.82, '#69404a');
    base.addColorStop(1, '#2c202e');
    xctx.fillStyle = base;
    xctx.fillRect(-rr, -rr, rr * 2, rr * 2);
    const bands = [
      ['rgba(255, 242, 202, 0.78)', -0.70, 0.11],
      ['rgba(122, 68, 58, 0.60)', -0.55, 0.10],
      ['rgba(235, 176, 105, 0.72)', -0.38, 0.13],
      ['rgba(93, 56, 70, 0.48)', -0.20, 0.11],
      ['rgba(255, 229, 166, 0.62)', -0.04, 0.12],
      ['rgba(146, 82, 60, 0.62)', 0.14, 0.12],
      ['rgba(245, 193, 117, 0.66)', 0.31, 0.13],
      ['rgba(80, 48, 58, 0.44)', 0.50, 0.10],
      ['rgba(250, 220, 156, 0.50)', 0.65, 0.09],
    ] as const;
    for (let i = 0; i < bands.length; i++) {
      const [colour, yy, hh] = bands[i];
      xctx.fillStyle = colour;
      xctx.beginPath();
      const top = yy * rr;
      const amp = rr * (0.018 + i * 0.002);
      xctx.moveTo(-rr, top);
      for (let px = -rr; px <= rr; px += Math.max(12, rr * 0.08)) {
        const wobble = (
          Math.sin(px * 0.014 + bucket * 0.24 + i * 1.7)
          + Math.sin(px * 0.037 - bucket * 0.10 + i * 0.8) * 0.34
        ) * amp;
        xctx.lineTo(px, top + wobble);
      }
      xctx.lineTo(rr, top + hh * rr);
      for (let px = rr; px >= -rr; px -= Math.max(12, rr * 0.08)) {
        const wobble = (
          Math.sin(px * 0.014 + bucket * 0.24 + i * 1.7)
          + Math.sin(px * 0.037 - bucket * 0.10 + i * 0.8) * 0.34
        ) * amp;
        xctx.lineTo(px, top + hh * rr + wobble);
      }
      xctx.closePath();
      xctx.fill();
    }
    xctx.lineCap = 'round';
    for (let i = 0; i < 26; i++) {
      const yy = (-0.74 + i * 0.058) * rr;
      const len = rr * (0.42 + solarHash(i + 22) * 0.58);
      const ox = (solarHash(i + bucket * 0.13) * 2 - 1) * rr * 0.42;
      xctx.strokeStyle = i % 2 === 0 ? 'rgba(255, 244, 214, 0.18)' : 'rgba(74, 44, 58, 0.14)';
      xctx.lineWidth = Math.max(1, rr * (0.006 + solarHash(i + 33) * 0.011));
      xctx.beginPath();
      xctx.moveTo(ox - len * 0.5, yy);
      for (let px = -len * 0.5; px <= len * 0.5; px += rr * 0.12) {
        xctx.lineTo(ox + px, yy + Math.sin(px * 0.050 + i + bucket * 0.2) * rr * 0.012);
      }
      xctx.stroke();
    }
    for (let i = 0; i < 6; i++) {
      const vx = rr * (-0.52 + i * 0.22 + Math.sin(bucket * 0.07 + i) * 0.03);
      const vy = rr * (-0.40 + solarHash(i + 12) * 0.82);
      xctx.fillStyle = i % 2 === 0 ? 'rgba(238, 205, 146, 0.22)' : 'rgba(112, 65, 72, 0.18)';
      xctx.beginPath();
      xctx.ellipse(vx, vy, rr * (0.055 + solarHash(i + 1) * 0.038), rr * (0.018 + solarHash(i + 2) * 0.018), i * 0.4, 0, Math.PI * 2);
      xctx.fill();
    }
    const spotX = rr * (0.42 - (bucket / 40) * 0.34);
    xctx.fillStyle = 'rgba(190, 76, 48, 0.72)';
    xctx.beginPath();
    xctx.ellipse(spotX, rr * 0.20, rr * 0.18, rr * 0.066, -0.10, 0, Math.PI * 2);
    xctx.fill();
    xctx.fillStyle = 'rgba(255, 185, 118, 0.20)';
    xctx.beginPath();
    xctx.ellipse(spotX - rr * 0.015, rr * 0.196, rr * 0.115, rr * 0.038, -0.08, 0, Math.PI * 2);
    xctx.fill();
    xctx.strokeStyle = 'rgba(255, 224, 178, 0.34)';
    xctx.lineWidth = Math.max(1, rr * 0.010);
    xctx.stroke();
  }, 40);
  applySolarDiscLight(ctx, r, light, 0.30);
  applyTerminator(ctx, r, light, 0.50);
  drawSolarAtmosphere(ctx, r, light, 'rgba(255, 222, 168, 0.60)', 0.18);
  for (const m of moons) drawTransitShadow(ctx, r, light, m.dir, m.shadowScale);
  ctx.restore();

  drawMoonOrbits(ctx, x, y, r, JUPITER_MOONS);
  drawSolarMoons(ctx, moons, sun, now);
}

function drawSaturnRings(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, front: boolean): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.28);
  ctx.lineCap = 'round';
  const start = front ? 0 : Math.PI;
  const end = front ? Math.PI : Math.PI * 2;
  const ringBands = [
    { rx: 1.34, ry: 0.31, width: 0.030, colour: 'rgba(158, 130, 92, 0.34)' },
    { rx: 1.50, ry: 0.35, width: 0.042, colour: 'rgba(255, 238, 196, 0.58)' },
    { rx: 1.63, ry: 0.38, width: 0.012, colour: 'rgba(18, 16, 18, 0.36)' },
    { rx: 1.75, ry: 0.42, width: 0.048, colour: 'rgba(194, 164, 122, 0.52)' },
    { rx: 1.96, ry: 0.48, width: 0.030, colour: 'rgba(238, 224, 194, 0.38)' },
    { rx: 2.12, ry: 0.52, width: 0.014, colour: 'rgba(170, 150, 120, 0.23)' },
  ];
  ctx.globalAlpha = front ? 0.98 : 0.70;
  for (const band of ringBands) {
    ctx.strokeStyle = band.colour;
    ctx.lineWidth = r * band.width;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * band.rx, r * band.ry, 0, start, end);
    ctx.stroke();
  }
  if (front) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineWidth = r * 0.11;
    ctx.beginPath();
    ctx.ellipse(-r * 0.16, -r * 0.02, r * 1.25, r * 0.29, 0, Math.PI * 0.05, Math.PI * 0.55);
    ctx.stroke();
  }
  ctx.restore();
}

function drawSaturnSystem(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, light: { x: number; y: number }, now: number, sun: { x: number; y: number }): void {
  const moons = resolveMoonStates(x, y, r, SATURN_MOONS, now);
  const saturnPhoto = loadSolarSprite('saturn');
  if (saturnPhoto) {
    drawSolarSprite(ctx, 'saturn', x, y, r * 4.18, r * 2.50);
    ctx.save();
    ctx.translate(x, y);
    applySolarDiscLight(ctx, r, light, 0.08);
    for (const m of moons) drawTransitShadow(ctx, r, light, m.dir, m.shadowScale);
    ctx.restore();
    drawMoonOrbits(ctx, x, y, r, SATURN_MOONS);
    drawSolarMoons(ctx, moons, sun, now);
    return;
  }

  drawSaturnRings(ctx, x, y, r, false);

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-0.06);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.clip();
  drawCachedSolarTexture(ctx, 'saturn', r, solarRotation(now, 0.444), (xctx, rr, bucket) => {
    const base = xctx.createRadialGradient(-rr * 0.24, -rr * 0.30, rr * 0.1, 0, 0, rr);
    base.addColorStop(0, '#fff3c8');
    base.addColorStop(0.42, '#d7b174');
    base.addColorStop(0.72, '#8b6844');
    base.addColorStop(1, '#3c2d24');
    xctx.fillStyle = base;
    xctx.fillRect(-rr, -rr, rr * 2, rr * 2);
    for (let i = 0; i < 18; i++) {
      const yy = (-0.78 + i * 0.092) * rr;
      const h = rr * (0.020 + (i % 3) * 0.006);
      xctx.fillStyle = i % 2 === 0 ? 'rgba(255, 232, 184, 0.26)' : 'rgba(118, 88, 64, 0.18)';
      xctx.fillRect(-rr, yy + Math.sin(bucket * 0.09 + i) * rr * 0.010, rr * 2, h);
    }
    xctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 12; i++) {
      const yy = (-0.66 + i * 0.12) * rr;
      xctx.strokeStyle = 'rgba(255, 240, 190, 0.15)';
      xctx.lineWidth = Math.max(1, rr * 0.010);
      xctx.beginPath();
      xctx.moveTo(-rr, yy);
      for (let px = -rr; px <= rr; px += rr * 0.16) {
        xctx.lineTo(px, yy + Math.sin(px * 0.04 + i + bucket * 0.14) * rr * 0.010);
      }
      xctx.stroke();
    }
  }, 36);
  applySolarDiscLight(ctx, r, light, 0.26);
  applyTerminator(ctx, r, light, 0.58);
  drawSolarAtmosphere(ctx, r, light, 'rgba(255, 220, 162, 0.45)', 0.16);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.globalAlpha = 0.46;
  ctx.rotate(-0.22);
  const ringShadow = ctx.createLinearGradient(0, -r * 0.16, 0, r * 0.16);
  ringShadow.addColorStop(0, 'rgba(0,0,0,0)');
  ringShadow.addColorStop(0.42, 'rgba(0,0,0,0.82)');
  ringShadow.addColorStop(0.60, 'rgba(0,0,0,0.60)');
  ringShadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ringShadow;
  ctx.fillRect(-r * 1.05, -r * 0.18, r * 2.1, r * 0.36);
  ctx.restore();
  for (const m of moons) drawTransitShadow(ctx, r, light, m.dir, m.shadowScale);
  ctx.restore();

  drawSaturnRings(ctx, x, y, r, true);

  drawMoonOrbits(ctx, x, y, r, SATURN_MOONS);
  drawSolarMoons(ctx, moons, sun, now);
}

function drawSolarAsteroidBelt(
  ctx: CanvasRenderingContext2D,
  sx: number,
  sy: number,
  rx: number,
  ry: number,
  now: number,
  bounds?: WorldBounds,
): void {
  if (!boundsIntersectRect(bounds, sx - rx * 1.25, sy - ry * 1.25 - 48, sx + rx * 1.25, sy + ry * 1.25 + 48)) return;
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 8; i++) {
    ctx.globalAlpha = 0.030 + i * 0.004;
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(215, 188, 148, 0.62)' : 'rgba(150, 174, 210, 0.46)';
    ctx.lineWidth = 22 + i * 9;
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx * (0.84 + i * 0.045), ry * (0.84 + i * 0.045), 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const beltSprite = loadSolarSprite('belt');
  if (beltSprite) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI * 0.62 + 0.32 + now * (0.000000010 + i * 0.000000002);
      const band = 0.94 + (i % 2) * 0.13;
      const x = sx + Math.cos(angle) * rx * band;
      const y = sy + Math.sin(angle) * ry * band;
      if (!boundsIntersectCircle(bounds, x, y, 150)) continue;
      const w = 210 + i * 34;
      const h = w * (beltSprite.height / Math.max(1, beltSprite.width));
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle + Math.PI * 0.08);
      ctx.globalAlpha = 0.22 + i * 0.045;
      ctx.drawImage(beltSprite, -w / 2, -h / 2, w, h);
      ctx.restore();
    }
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.70;
  for (let i = 0; i < 520; i++) {
    const jitter = (((i * 16807) % 997) / 997 - 0.5);
    const angle = i * 2.399963 + now * (0.000000018 + (i % 7) * 0.000000002);
    const band = 0.86 + (((i * 48271) % 541) / 541) * 0.32;
    const x = sx + Math.cos(angle) * rx * band;
    const y = sy + Math.sin(angle) * ry * band + jitter * 36;
    const size = i % 67 === 0 ? 4.2 : i % 31 === 0 ? 3.1 : i % 11 === 0 ? 2.0 : 0.95;
    if (bounds && (x < bounds.x0 - 8 || x > bounds.x1 + 8 || y < bounds.y0 - 8 || y > bounds.y1 + 8)) continue;
    const warm = i % 5 === 0;
    ctx.fillStyle = warm ? 'rgba(220, 185, 132, 0.78)' : 'rgba(152, 166, 186, 0.58)';
    ctx.beginPath();
    ctx.ellipse(x, y, size * (0.75 + solarHash(i) * 0.65), size * (0.58 + solarHash(i + 11) * 0.5), angle * 1.7, 0, Math.PI * 2);
    ctx.fill();
    if (size > 2.8) {
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = warm ? 'rgba(255, 232, 184, 0.80)' : 'rgba(225, 235, 255, 0.65)';
      ctx.beginPath();
      ctx.arc(x - size * 0.32, y - size * 0.24, size * 0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.70;
    }
  }
  ctx.restore();
}

type SolarPlanetKind = 'mercury' | 'venus' | 'earth' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'pluto';
type SolarPlanetSpec = {
  kind: SolarPlanetKind;
  orbitRx: number;
  orbitRy: number;
  periodDays: number;
  epoch: number;
  radius: number;
  rotationDays: number;
};

const DEATHMATCH_SOLAR_PLANETS: readonly SolarPlanetSpec[] = [
  { kind: 'mercury', orbitRx: 360, orbitRy: 214, periodDays: 87.969, epoch: 0.92, radius: 24, rotationDays: 58.646 },
  { kind: 'venus', orbitRx: 560, orbitRy: 330, periodDays: 224.701, epoch: 1.70, radius: 42, rotationDays: -243.025 },
  { kind: 'earth', orbitRx: 870, orbitRy: 520, periodDays: 365.256, epoch: 0.35, radius: 58, rotationDays: 0.997 },
  { kind: 'mars', orbitRx: 1180, orbitRy: 705, periodDays: 686.980, epoch: 1.05, radius: 34, rotationDays: 1.026 },
  { kind: 'jupiter', orbitRx: 1990, orbitRy: 1190, periodDays: 4332.590, epoch: 0.62, radius: 185, rotationDays: 0.414 },
  { kind: 'saturn', orbitRx: 2760, orbitRy: 1640, periodDays: 10759.220, epoch: 1.14, radius: 118, rotationDays: 0.444 },
  { kind: 'uranus', orbitRx: 3220, orbitRy: 1920, periodDays: 30688.500, epoch: 0.54, radius: 84, rotationDays: -0.718 },
  { kind: 'pluto', orbitRx: 3500, orbitRy: 2080, periodDays: 90560.000, epoch: 0.83, radius: 30, rotationDays: -6.387 },
];

const EARTH_MOON: SolarMoonSpec = {
  orbit: 132,
  flatten: 92 / 132,
  tilt: 0,
  periodDays: 27.321661,
  epoch: 1.2,
  size: 17,
  colour: '#b9c0c8',
  shadowScale: 0.13,
};

function solarOrbitPosition(sun: { x: number; y: number }, p: SolarPlanetSpec, now: number): { x: number; y: number; angle: number } {
  const angle = solarAngle(now, p.periodDays, p.epoch);
  return {
    x: sun.x + Math.cos(angle) * p.orbitRx,
    y: sun.y + Math.sin(angle) * p.orbitRy,
    angle,
  };
}

function solarRotation(now: number, rotationDays: number, epoch = 0): number {
  return epoch + ((now * SOLAR_DAYS_PER_MS) / rotationDays) * Math.PI * 2;
}

function drawDeathmatchSolarScenery(ctx: CanvasRenderingContext2D, rw: number, rh: number, now: number, bounds?: WorldBounds): void {
  const sun = { x: rw * 0.13, y: rh * 0.16 };
  for (const planet of DEATHMATCH_SOLAR_PLANETS) {
    if (boundsIntersectRect(bounds, sun.x - planet.orbitRx, sun.y - planet.orbitRy, sun.x + planet.orbitRx, sun.y + planet.orbitRy)) {
      drawOrbit(ctx, sun.x, sun.y, planet.orbitRx, planet.orbitRy);
    }
  }
  if (boundsIntersectRect(bounds, sun.x - 1460, sun.y - 875, sun.x + 1460, sun.y + 875)) {
    drawOrbit(ctx, sun.x, sun.y, 1460, 875);
  }
  drawSolarAsteroidBelt(ctx, sun.x, sun.y, 1460, 875, now, bounds);

  const bodies = DEATHMATCH_SOLAR_PLANETS
    .map((spec) => ({ spec, ...solarOrbitPosition(sun, spec, now) }))
    .sort((a, b) => a.y - b.y);

  for (const body of bodies) {
    const visibilityRadius = body.spec.kind === 'saturn'
      ? body.spec.radius * 4.2
      : body.spec.kind === 'jupiter'
      ? body.spec.radius * 1.8
      : body.spec.kind === 'earth'
      ? body.spec.radius + EARTH_MOON.orbit + EARTH_MOON.size + 8
      : body.spec.kind === 'mars'
      ? body.spec.radius * 2.7
      : body.spec.kind === 'pluto'
      ? body.spec.radius * 2.8
      : body.spec.radius * 1.8;
    if (!boundsIntersectCircle(bounds, body.x, body.y, visibilityRadius)) continue;
    const light = normalise2(sun.x - body.x, sun.y - body.y);
    const spin = solarRotation(now, body.spec.rotationDays, body.spec.epoch);
    if (body.spec.kind === 'mercury') {
      drawMercury(ctx, body.x, body.y, body.spec.radius, light);
    } else if (body.spec.kind === 'saturn') {
      drawSaturnSystem(ctx, body.x, body.y, body.spec.radius, light, now, sun);
    } else if (body.spec.kind === 'jupiter') {
      drawGasGiantSystem(ctx, body.x, body.y, body.spec.radius, light, now, sun);
    } else if (body.spec.kind === 'mars') {
      drawMarsSystem(ctx, body.x, body.y, body.spec.radius, light, now, sun, spin);
    } else if (body.spec.kind === 'venus') {
      drawVenus(ctx, body.x, body.y, body.spec.radius, light, now, spin);
    } else if (body.spec.kind === 'uranus') {
      drawUranusSystem(ctx, body.x, body.y, body.spec.radius, light);
    } else if (body.spec.kind === 'pluto') {
      drawPlutoSystem(ctx, body.x, body.y, body.spec.radius, light, now, sun);
    } else {
      const moonAngle = solarAngle(now, EARTH_MOON.periodDays, EARTH_MOON.epoch);
      const moonX = body.x + Math.cos(moonAngle) * EARTH_MOON.orbit;
      const moonY = body.y + Math.sin(moonAngle) * EARTH_MOON.orbit * EARTH_MOON.flatten;
      const moonDir = normalise2(moonX - body.x, moonY - body.y);
      drawEarth(ctx, body.x, body.y, body.spec.radius, light, now, spin);
      ctx.save();
      ctx.translate(body.x, body.y);
      ctx.beginPath();
      ctx.arc(0, 0, body.spec.radius, 0, Math.PI * 2);
      ctx.clip();
      drawTransitShadow(ctx, body.spec.radius, light, moonDir, EARTH_MOON.shadowScale);
      ctx.restore();
      const moonLight = normalise2(sun.x - moonX, sun.y - moonY);
      if (!drawSolarPhotoDisc(ctx, 'moon', moonX, moonY, EARTH_MOON.size * 1.12, moonLight)) {
        drawShadedMoon(ctx, moonX, moonY, EARTH_MOON.size, EARTH_MOON.colour, moonLight, moonAngle);
      }
      const moonFacingEarth = moonDir.x * light.x + moonDir.y * light.y;
      if (moonFacingEarth < -0.965) {
        ctx.save();
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = Math.min(0.58, (-moonFacingEarth - 0.965) / 0.035 * 0.48);
        ctx.fillStyle = 'rgba(18, 9, 7, 0.86)';
        ctx.beginPath();
        ctx.arc(moonX, moonY, EARTH_MOON.size + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }

  if (boundsIntersectCircle(bounds, sun.x, sun.y, 68 * 6.2)) drawSol(ctx, sun.x, sun.y, 68, now);
}

function drawBackground(ctx: CanvasRenderingContext2D, state: GameState, now: number, deathmatchBounds?: WorldBounds): void {
  // Defender preview: replace the wave bg with a multi-layer parallax
  // starfield that scrolls under the follow camera. Skips the wave webp +
  // procedural fallback paths entirely.
  if (renderMode.defender) {
    drawDefenderBackground(ctx);
    return;
  }
  if (deathmatchActive() && state.phase !== 'title') {
    drawDeathmatchBackground(ctx, now, state.elapsed, deathmatchBounds);
    return;
  }
  // Arena replaces the wave backdrop with a flat containment void; the grid
  // and cage walls (drawArenaGrid / drawArenaWalls) carry the look instead.
  if (arenaActive() && state.phase !== 'title') {
    drawArenaVoid(ctx);
    return;
  }
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
    // 1280×720 world rect. Save/restore the world transform around it so other
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

  // Retro: draw bg in 1280×720 world space. Cover-scale the source so a 4:3
  // wave image crops into the 16:9 world rather than squashing — wave art is
  // regenerated 16:9 separately; this keeps the interim look clean.
  if (override) {
    const breath = 1.025 + Math.sin(now * 0.00038) * 0.006;
    const coverScale = Math.max(WORLD_W / override.width, WORLD_H / override.height) * breath;
    const w = override.width * coverScale;
    const h = override.height * coverScale;
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

function drawShield(ctx: CanvasRenderingContext2D, ship: Ship, now: number, elapsed: number): void {
  if (!ship.shieldUp || !ship.alive) return;
  // 3D shield dome renders on the WebGL overlay — skip the 2D path entirely
  // when ship-tier is mesh and the overlay is ready so the player sees the
  // faceted dome alone, not both at once.
  if (getVisualStyle('ship') === 'mesh' && isWebGLOverlayReady()) return;
  const remaining = Math.max(0, ship.shieldExpiresAt - elapsed);
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

function drawShip(ctx: CanvasRenderingContext2D, ship: Ship, now: number, elapsed: number, idleSway = false, forceCanvas = false): void {
  if (!ship.alive) return;
  // Hide ship entirely during hyperspace cloak — except when the warp is
  // malfunctioning, in which case render a red distortion at the departure
  // point so the player sees something is going wrong.
  if (ship.hyperspaceCloakMs > 0) {
    if (ship.hyperspaceMalfunction) drawHyperspaceMalfunction(ctx, ship, now);
    return;
  }
  const flickerOff = ship.invulnerableUntil > elapsed && Math.floor(now / 80) % 2 === 0;
  if (flickerOff) return;

  const skin = getActiveSkin().palette;

  const shipTier = getVisualStyle('ship');
  // MESH ship draws on the WebGL overlay; skip the 2D path entirely
  // once the overlay's loaded so the player sees the 3D mesh alone.
  if (!forceCanvas && shipTier === 'mesh' && isWebGLOverlayReady()) return;
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
  for (const t of ['stony', 'iron', 'chondrite', 'pallasite', 'carbonaceous', 'mesosiderite', 'achondrite'] as const) {
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
    stony:        { lit: '#c4b298', mid: '#7a6856', shadow: '#2a2218', rim: '#1a1410' },
    iron:         { lit: '#7a4e36', mid: '#3a1f12', shadow: '#1a0a06', rim: '#0a0402' },
    chondrite:    { lit: '#d8b070', mid: '#7c5828', shadow: '#2c1c08', rim: '#180e04' },
    pallasite:    { lit: '#a6b070', mid: '#3a4a18', shadow: '#1a200a', rim: '#0a1004' },
    // New types — used as procedural fallback until the photoreal
    // webps land. Once loaded the photoreal overrides this anyway.
    carbonaceous: { lit: '#605866', mid: '#2a2832', shadow: '#0c0a14', rim: '#040208' },
    mesosiderite: { lit: '#b89868', mid: '#5a3e22', shadow: '#221408', rim: '#100804' },
    achondrite:   { lit: '#b06848', mid: '#5a2818', shadow: '#1e0a04', rim: '#0a0402' },
    kinetic:      { lit: '#6fd0c8', mid: '#2a6058', shadow: '#0c2420', rim: '#04100e' },
    volatile:     { lit: '#e08848', mid: '#7a3818', shadow: '#2a1006', rim: '#100602' },
    ballast:      { lit: '#8090a4', mid: '#3a4452', shadow: '#141820', rim: '#080a10' },
    tektite:      { lit: '#88c0a0', mid: '#3a6048', shadow: '#142418', rim: '#08100c' },
    lodestone:    { lit: '#a878b0', mid: '#503058', shadow: '#1c1020', rim: '#0c0610' },
  };
  const p = palettes[type];
  const rng = makePrng(
    type === 'stony' ? 0x57071 :
    type === 'iron' ? 0x12041 :
    type === 'chondrite' ? 0xC4014 :
    type === 'pallasite' ? 0xA1148 :
    type === 'carbonaceous' ? 0xCA160 :
    type === 'mesosiderite' ? 0xE502D :
    /* achondrite */ 0xAC410,
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

/** Behavioural-type glow tell, drawn over the rock (in the rotated frame)
 *  so it reads in both the vector and shaded tiers. Gameplay plane only;
 *  the inert meteorite types fall straight through. */
function drawTypeTell(ctx: CanvasRenderingContext2D, a: Asteroid, now: number): void {
  if ((a.depth ?? 3) !== 3) return;
  const r = a.radius;
  if (a.type === 'volatile') {
    // Unstable molten core — a fast hot throb.
    const pulse = 0.55 + 0.45 * Math.sin(now * 0.011);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(0, 0, r * 0.1, 0, 0, r * 1.05);
    g.addColorStop(0, `rgba(255, 232, 150, ${0.55 * pulse})`);
    g.addColorStop(0.5, `rgba(255, 130, 40, ${0.4 * pulse})`);
    g.addColorStop(1, 'rgba(255, 90, 20, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.05, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (a.type === 'lodestone') {
    // Magnetic field — two slow concentric rings.
    const pulse = 0.72 + 0.28 * Math.sin(now * 0.004);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(208, 96, 224, ${0.42 * pulse})`;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = '#d060e0';
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.34 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.72 * pulse, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  } else if (a.type === 'kinetic') {
    // Charge halo — brightens and widens with the rock's speed.
    const charge = Math.max(0, Math.min(1, Math.hypot(a.vel.x, a.vel.y) / 420));
    if (charge > 0.05) {
      const shimmer = 0.7 + 0.3 * Math.sin(now * 0.02);
      const rr = r * (1.18 + charge * 0.5);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createRadialGradient(0, 0, r * 0.7, 0, 0, rr);
      g.addColorStop(0, 'rgba(58, 214, 200, 0)');
      g.addColorStop(1, `rgba(58, 214, 200, ${0.5 * charge * shimmer})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  } else if (a.type === 'tektite') {
    // Glassy sheen — a cool, sharp highlight.
    const pulse = 0.6 + 0.4 * Math.sin(now * 0.006);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(-r * 0.32, -r * 0.32, 0, -r * 0.32, -r * 0.32, r * 0.95);
    g.addColorStop(0, `rgba(190, 255, 224, ${0.5 * pulse})`);
    g.addColorStop(1, 'rgba(120, 230, 170, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else if (a.type === 'ballast') {
    // Dense mass — a dim, slow inner ring suggesting a heavy core.
    const pulse = 0.55 + 0.45 * Math.sin(now * 0.003);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(120, 150, 196, ${0.34 * pulse})`;
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.55, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawAsteroid(ctx: CanvasRenderingContext2D, a: Asteroid, now: number): void {
  if (!a.alive) return;
  const style = getAsteroidStyle(a.type);
  // MESH-tier asteroids are rendered by the WebGL overlay below. Skip
  // the 2D path entirely so the player sees one mesh per rock instead
  // of a 2D copy underneath. Falls back to SHADED 2D if the overlay
  // hasn't finished loading yet (or the player has the renderer turned
  // off via prefers-reduced-motion / WebGL unavailable).
  const asteroidTier = getVisualStyle('asteroid');
  // Veins now flow through the mesh path too — the WebGL overlay paints
  // a regular pallasite mesh which reads as a chunky 3D vault, far more
  // "massive" than the 2D gold-halo vector circle that used to leak
  // through underneath. The bespoke gold halo is sacrificed in mesh tier;
  // shaded/vector tiers still get the original treatment below.
  if (asteroidTier === 'mesh' && isWebGLOverlayReady() && !a.councilMember) return;
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

  // Behavioural-type glow tell, over the rock so it reads in vector and
  // shaded alike.
  drawTypeTell(ctx, a, now);

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

    // HP ring — a gold arc just outside the rock that depletes as the
    // vein takes hits. Without this the 100/200/300-hit wave-5 vault
    // felt like a black hole for bullets: no visible progress until
    // the eventual jackpot. The ring sweeps from 12 o'clock clockwise
    // around 360°, length proportional to remaining HP. A faint
    // background track keeps the empty portion legible against the
    // varied wave backdrops.
    if (a.hpMax > 1) {
      const frac = Math.max(0, Math.min(1, a.hp / a.hpMax));
      const ringR = a.radius * 1.18;
      const startA = -Math.PI / 2;  // 12 o'clock
      ctx.save();
      // Background track — dim, full circle.
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = 'rgba(80, 60, 20, 0.65)';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();
      // Filled portion — bright gold, pulses softly.
      const pulse = 0.85 + 0.15 * Math.sin(now * 0.006);
      ctx.lineWidth = 3.4;
      ctx.strokeStyle = `rgba(255, 216, 74, ${0.95 * pulse})`;
      ctx.shadowColor = '#ffd84a';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, startA, startA + Math.PI * 2 * frac);
      ctx.stroke();
      ctx.restore();
    }
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
  // UFOs render as a 3D saucer on the WebGL overlay when EITHER the ship
  // tier OR the asteroid tier is mesh — the player almost always expects
  // mesh UFOs once any other entity is meshed, and tying it to ship-only
  // meant a default-vector main game with mesh asteroids still drew 2D
  // saucers, which looked inconsistent.
  if ((getVisualStyle('ship') === 'mesh' || getVisualStyle('asteroid') === 'mesh') && isWebGLOverlayReady()) return;
  const r = u.radius;
  // 600bn flavour / Sanctum-mode swap — UFO renders as the canonical
  // 4-line sacred number ($600B logo), rotating slowly. The hitbox +
  // behaviour are unchanged; just the silhouette is replaced.
  if (getFlavour() === '600bn' || isSanctumMode()) {
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

  // 600bn flavour / Sanctum-mode — every drop renders as a bitcoin coin
  // (outlined gold circle + ₿). 'dust' kind keeps its score-only
  // economy (no sat credit) but visually reads as a ₿ shard so the
  // council-break debris feels themed. Sat-coin drops use the same
  // look — already matches.
  const isBtcAesthetic = getFlavour() === '600bn' || isSanctumMode();

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
  // Powerups follow the 'particle' visual tier (decorative field
  // items, same bucket as particles in the settings UI). When on mesh
  // the 3D path renders the spinning glyph sphere instead.
  if (getVisualStyle('particle') === 'mesh' && isWebGLOverlayReady()) return;
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

function drawDeathmatchLocalMarker(ctx: CanvasRenderingContext2D, ship: Ship, now: number, elapsed: number, players: number): void {
  if (!deathmatchActive() || players < 8) return;
  if (!ship.alive || ship.hyperspaceCloakMs > 0) return;
  const pulse = 0.5 + 0.5 * Math.sin(now * 0.008);
  const flicker = ship.invulnerableUntil > elapsed ? 0.72 + pulse * 0.22 : 1;
  const r = ship.radius + 22 + pulse * 5;
  ctx.save();
  ctx.translate(ship.pos.x, ship.pos.y);
  ctx.globalAlpha = flicker;
  ctx.strokeStyle = '#58ff58';
  ctx.fillStyle = '#58ff58';
  ctx.shadowColor = '#58ff58';
  ctx.shadowBlur = 13;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  for (let i = 0; i < 4; i++) {
    const a = ship.rot + i * Math.PI / 2;
    const x0 = Math.cos(a) * (r + 5);
    const y0 = Math.sin(a) * (r + 5);
    const x1 = Math.cos(a) * (r + 19);
    const y1 = Math.sin(a) * (r + 19);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }
  ctx.font = 'bold 12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowBlur = 9;
  ctx.fillText('YOU', 0, -r - 17);
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

function formatHudTime(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function drawDeathmatchHudExtras(ctx: CanvasRenderingContext2D, s: GameState, w: number, topY: number, rightX: number): void {
  const rows = s.players
    .map((p, slot) => ({ slot, kills: p.deathmatchKills, deaths: p.deathmatchDeaths, streak: p.deathmatchStreak, score: p.score }))
    .sort((a, b) => b.kills - a.kills || b.score - a.score || a.deaths - b.deaths || a.slot - b.slot);
  const localSlot = renderMode.localSlot ?? 0;
  const localRank = Math.max(0, rows.findIndex(r => r.slot === localSlot));
  const manyPlayers = s.players.length >= 32;
  const maxRows = Math.min(rows.length, manyPlayers ? (w < 760 ? 2 : 4) : w < 760 ? 3 : w < 1080 ? 5 : 8);
  const visibleRows = rows.slice(0, maxRows);
  if (localRank >= maxRows && rows[localRank]) visibleRows[visibleRows.length - 1] = rows[localRank];
  const panelW = Math.min(w < 760 ? 188 : manyPlayers ? 228 : 286, Math.max(172, w * (manyPlayers ? 0.22 : 0.28)));
  const panelX = manyPlayers
    ? Math.max(24 + renderMode.insets.left, Math.round(rightX - panelW))
    : Math.round(w / 2 - panelW / 2);
  const panelY = manyPlayers ? topY + 62 : topY + 88;
  const rowH = manyPlayers ? 14 : 16;
  const panelH = 42 + visibleRows.length * rowH;
  const liveCount = s.players.filter(p => p.ship.alive).length;
  ctx.save();
  ctx.fillStyle = 'rgba(4, 8, 18, 0.72)';
  ctx.strokeStyle = 'rgba(120, 150, 255, 0.34)';
  ctx.lineWidth = 1;
  ctx.fillRect(panelX, panelY, panelW, panelH);
  ctx.strokeRect(panelX + 0.5, panelY + 0.5, panelW - 1, panelH - 1);
  ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ffd84a';
  ctx.fillText('LEADERBOARD', panelX + 10, panelY + 7);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(220, 230, 255, 0.72)';
  ctx.fillText(`${liveCount}/${s.players.length} LIVE`, panelX + panelW - 10, panelY + 7);
  ctx.font = 'bold 9px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(180, 200, 240, 0.70)';
  ctx.fillText('K/D', panelX + panelW - 78, panelY + 24);
  ctx.fillText('PTS', panelX + panelW - 10, panelY + 24);
  ctx.font = `${manyPlayers ? 11 : 12}px ui-monospace, monospace`;
  for (let i = 0; i < visibleRows.length; i++) {
    const r = visibleRows[i];
    const rank = rows.indexOf(r) + 1;
    const y = panelY + 39 + i * rowH;
    const isLocal = r.slot === localSlot;
    const omitted = localRank >= maxRows && i === visibleRows.length - 1;
    ctx.textAlign = 'left';
    ctx.fillStyle = isLocal ? '#58ff58' : i === 0 ? '#ffd84a' : 'rgba(230, 238, 255, 0.88)';
    const rankX = omitted ? panelX + 34 : panelX + 10;
    const playerX = omitted ? panelX + 66 : panelX + 44;
    if (omitted) {
      ctx.fillStyle = 'rgba(180, 200, 240, 0.55)';
      ctx.fillText('...', panelX + 10, y);
      ctx.fillStyle = isLocal ? '#58ff58' : 'rgba(230, 238, 255, 0.88)';
    }
    ctx.fillText(`#${rank}`, rankX, y);
    ctx.fillText(`P${r.slot + 1}`, playerX, y);
    ctx.textAlign = 'right';
    const streak = r.streak >= 3 ? ` x${r.streak}` : '';
    ctx.fillText(`${r.kills}/${r.deaths}${streak}`, panelX + panelW - 78, y);
    ctx.fillText(String(r.score), panelX + panelW - 10, y);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  const feed = s.deathmatchFeed.filter(e => s.elapsed - e.t <= 6_000).slice(-4).reverse();
  if (!feed.length || w < 620) return;
  const feedW = Math.min(250, Math.max(190, w * 0.22));
  const feedX = Math.max(24 + renderMode.insets.left, rightX - feedW);
  const feedY = manyPlayers ? panelY + panelH + 8 : topY + 62;
  ctx.save();
  ctx.fillStyle = 'rgba(4, 8, 18, 0.64)';
  ctx.strokeStyle = 'rgba(255, 216, 74, 0.26)';
  ctx.lineWidth = 1;
  ctx.fillRect(feedX, feedY, feedW, 20 + feed.length * 17);
  ctx.strokeRect(feedX + 0.5, feedY + 0.5, feedW - 1, 19 + feed.length * 17);
  ctx.font = 'bold 10px ui-monospace, monospace';
  ctx.fillStyle = '#ffd84a';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('KILL FEED', feedX + 9, feedY + 6);
  ctx.font = '12px ui-monospace, monospace';
  for (let i = 0; i < feed.length; i++) {
    const e = feed[i];
    const age = Math.max(0, Math.min(1, 1 - (s.elapsed - e.t) / 6_000));
    ctx.globalAlpha = 0.42 + age * 0.58;
    ctx.fillStyle = e.attackerSlot == null ? '#d8c27a' : '#fff5d8';
    const text = e.attackerSlot == null
      ? `P${e.victimSlot + 1} LOST`
      : `P${e.attackerSlot + 1} > P${e.victimSlot + 1} +${e.points}${e.streak >= 3 ? ` x${e.streak}` : ''}`;
    ctx.fillText(text, feedX + 9, feedY + 21 + i * 17);
  }
  ctx.restore();
}

function drawHud(ctx: CanvasRenderingContext2D, s: GameState): void {
  const p0 = s.players[0];
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
  // Retro letterboxes the canvas inside the inscribed 16:9 area, so insets
  // are zero there by design.
  const insets = renderMode.insets;
  const topY = 16 + insets.top;
  const leftX = 24 + insets.left;
  const rightX = w - 24 - insets.right;
  // 600bn / Sanctum is a ceremonial run with no sat economy and no
  // wave number to count — hide both the SATS counter and the WAVE
  // label outright. The SCORE column still shows.
  const is600bn = getFlavour() === '600bn' || isSanctumMode();
  const isDeathmatch = deathmatchActive();
  const showSats = s.session && !s.cheatedThisRun && !is600bn;

  ctx.font = '24px ui-monospace, monospace';
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#58ff58';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText('SCORE', leftX, topY);
  ctx.fillText(pad(p0.score, 6), leftX, topY + 26);

  // Sats column stacks under SCORE on the left rail. Was previously at
  // x=w*0.32 alongside SCORE, which pushed WAVE off-centre and crowded the
  // top row on narrow viewports. Stacking lets WAVE claim the centre.
  // Hidden in guest mode (no sats to track), once a cheat fires this run
  // (the SATS VOID chip below signals the run is unranked anyway), and in
  // 600bn / Sanctum mode (no sat economy at all).
  if (showSats) {
    ctx.fillStyle = '#ffd84a';
    ctx.fillText('SATS', leftX, topY + 60);
    ctx.fillText('₿ ' + pad(Math.floor(p0.displaySats), 6), leftX, topY + 86);
  }

  // WAVE label — top-centre. 600bn / Sanctum has no waves so the label
  // is suppressed entirely (the SIGNAL strapline takes the centre column
  // by itself). Arena/deathmatch get mode labels. Campaign shows WAVE n.
  const isArena = arenaActive();
  ctx.fillStyle = is600bn ? '#ffd84a' : '#5b9dff';
  ctx.shadowColor = is600bn ? '#ff8a3a' : '#5b9dff';
  ctx.shadowBlur = 8;
  ctx.textAlign = 'center';
  if (is600bn) {
    // No WAVE word, no number — just the SIGNAL strapline below claims
    // the centre column.
  } else if (isArena) {
    // Arena is a continuous infinity run — no wave number or name.
    ctx.fillText('ARENA', w / 2, topY + 14);
  } else if (isDeathmatch) {
    ctx.fillText('DEATHMATCH', w / 2, topY + 14);
  } else {
    ctx.fillText('WAVE', w / 2, topY);
    ctx.fillText(pad(s.wave, 2), w / 2, topY + 26);
  }
  ctx.shadowBlur = 0;
  ctx.font = 'bold 13px ui-monospace, monospace';
  ctx.fillStyle = '#fff5d8';
  ctx.letterSpacing = '0.18em' as unknown as string;
  if (!isArena) {
    const deathmatchRules = s.deathmatchRules;
    const deathmatchLeaderKills = isDeathmatch
      ? s.players.reduce((best, p) => Math.max(best, p.deathmatchKills), 0)
      : 0;
    const deathmatchTimeLeft = deathmatchRules
      ? Math.max(0, deathmatchRules.timeLimitMs - (s.elapsed - s.deathmatchStartedAt))
      : 0;
    const deathmatchKillText = deathmatchRules?.killLimit
      ? `${deathmatchLeaderKills}/${deathmatchRules.killLimit}`
      : 'NO CAP';
    ctx.fillText(
      is600bn
        ? 'THE SIGNAL'
        : isDeathmatch && deathmatchRules
        ? `${s.players.length}P · ${formatHudTime(deathmatchTimeLeft)} · ${deathmatchKillText}`
        : isDeathmatch
        ? `${s.players.length} PILOTS`
        : waveName(s.wave).toUpperCase(),
      w / 2,
      is600bn ? topY + 14 : topY + 56,
    );
  }
  ctx.letterSpacing = '0em' as unknown as string;

  ctx.font = '24px ui-monospace, monospace';
  ctx.fillStyle = '#58ff58';
  ctx.shadowColor = '#58ff58';
  ctx.shadowBlur = 0;
  ctx.textAlign = 'right';
  if (isDeathmatch) {
    ctx.fillText('RESPAWNS', rightX, topY);
    const respawnsLeft = Math.max(0, p0.lives - (p0.ship.alive ? 1 : 0));
    ctx.fillText(pad(respawnsLeft, 2), rightX, topY + 26);
    drawDeathmatchHudExtras(ctx, s, w, topY, rightX);
  } else {
    ctx.fillText('LIVES', rightX, topY);
    for (let i = 0; i < p0.lives; i++) {
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

  if (p0.combo >= 2) {
    const remaining = Math.max(0, p0.comboExpiresAt - s.elapsed);
    const colour = p0.combo >= 5 ? '#ffd84a' : p0.combo >= 4 ? '#ff8a3a' : '#5b9dff';
    drawChip(`×${p0.combo}  CHAIN`, remaining, 3000, colour);
  }
  if (s.elapsed < p0.rapidExpiresAt) {
    drawChip('⚡ RAPID', p0.rapidExpiresAt - s.elapsed, 8000, '#ff8a3a');
  }
  if (s.elapsed < p0.satboostExpiresAt) {
    drawChip('₿ ×2 SATS', p0.satboostExpiresAt - s.elapsed, 12000, '#ffd84a');
  }
  if (s.elapsed < p0.tridentExpiresAt) {
    drawChip('⋔ TRIDENT', p0.tridentExpiresAt - s.elapsed, 6000, '#ffd84a');
  }
  if (s.elapsed < p0.magnetExpiresAt) {
    drawChip('◎ MAGNET', p0.magnetExpiresAt - s.elapsed, 8000, '#5b9dff');
  }
  // Lurking + cheated indicators removed — both states already fire
  // toasts when they're entered (toastNow in updateLurkState and
  // cheatJumpToWave), so the persistent red chips were duplicate noise.
  drawGhostChip(ctx, s);

  // Couch 2-player: P2 readouts (SCORE + LIVES) below the P1 LIVES corner on
  // the right rail. A blue "P2" tag so the stacked rail reads clearly.
  // Per-player SATS and buff chips for P2 are a polish follow-up.
  if (s.players.length >= 2 && !isDeathmatch) {
    const p2 = s.players[1];
    ctx.font = 'bold 16px ui-monospace, monospace';
    ctx.fillStyle = '#7fbfff';
    ctx.shadowColor = '#7fbfff';
    ctx.shadowBlur = 6;
    ctx.textAlign = 'right';
    ctx.fillText('P2', rightX, topY + 80);
    ctx.font = '20px ui-monospace, monospace';
    ctx.fillStyle = '#58ff58';
    ctx.shadowColor = '#58ff58';
    ctx.shadowBlur = 0;
    ctx.fillText('SCORE', rightX, topY + 104);
    ctx.fillText(pad(p2.score, 6), rightX, topY + 128);
    ctx.fillText('LIVES', rightX, topY + 162);
    for (let i = 0; i < p2.lives; i++) {
      const x = rightX - i * 22;
      const y = topY + 200;
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
  }

  // Defender HUD removed — the Council-protect mechanic + timer it
  // surfaced has been unbundled while the real classic-Defender mode
  // is built. Wave / Score / Sats etc. above are enough for the
  // interim wide-arena visual demo.

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
  const gap = s.players[0].score - leaderScore;
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
function drawWaveBanner(ctx: CanvasRenderingContext2D, s: GameState): void {
  if (s.phase !== 'wavestart') return;
  // Act-boundary waves are owned by drawIntertitle — one card carrying the
  // act beat AND the wave name. The standard banner is suppressed there.
  if (intertitleHoldMs(s) > 0) return;
  const elapsed = s.elapsed - s.phaseStart;
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
  applyOverlayTransform(ctx);
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

  // Wave number — bigger, more confident. 600bn flavour / Sanctum mode
  // swaps the 'WAVE N' label for the canonical sacred-number wordmark.
  // All four lines are auto-shrunk to fit the viewport in portrait so
  // long strings (especially "THE $600B WAVE" and the lore line) don't
  // spill off both edges of the screen on phones.
  const isBnWave = (getFlavour() === '600bn' || isSanctumMode()) && s.wave === 1;
  const maxW = overlayWorldWidth() - 40;  // 20 world px margin each side
  const headline = isBnWave ? 'THE $600B WAVE' : `WAVE ${s.wave}`;
  fitFontToWidth(ctx, headline, px => `bold ${px}px ui-monospace, monospace`, isBnWave ? 64 : 72, maxW);
  ctx.fillStyle = isBnWave ? '#ffd84a' : '#5b9dff';
  ctx.shadowColor = isBnWave ? '#ff8a3a' : '#5b9dff';
  ctx.shadowBlur = isBnWave ? 26 : 22;
  ctx.fillText(headline, WORLD_W / 2, WORLD_H / 2 - 30);

  // Sub-name — pallasite specimen for campaign waves, council label
  // for the 600bn flavour.
  const subname = isBnWave ? 'COUNCIL OF 600' : waveName(s.wave);
  fitFontToWidth(ctx, subname, px => `bold ${px}px ui-monospace, monospace`, 28, maxW);
  ctx.fillStyle = '#ffd84a';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 14;
  ctx.letterSpacing = '0.18em' as unknown as string;
  ctx.fillText(subname, WORLD_W / 2, WORLD_H / 2 + 38);

  // One-line lore — pallasite history for campaign, 600B canon for
  // the Sanctum wave.
  const lore = isBnWave
    ? 'Madeira to Prague · The signal carries the stone'
    : waveSubtitle(s.wave);
  if (lore) {
    fitFontToWidth(ctx, lore, px => `${px}px ui-monospace, monospace`, 16, maxW);
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
    fitFontToWidth(ctx, tagline, px => `${px}px ui-monospace, monospace`, 14, maxW);
    ctx.fillStyle = isBnWave ? '#ffb060' : '#7da5d4';
    ctx.shadowColor = isBnWave ? '#ff8a3a' : '#5b9dff';
    ctx.shadowBlur = 6;
    ctx.letterSpacing = '0.10em' as unknown as string;
    ctx.fillText(tagline, WORLD_W / 2, WORLD_H / 2 + 102);
  }

  ctx.restore();
}

/** Intertitle wavestart length for this wave, in ms. Zero unless the wave is
 *  an act boundary (1/10/17/25) and the flavour is the campaign — in which
 *  case the whole wavestart is the story card and the banner is suppressed. */
function intertitleHoldMs(s: GameState): number {
  if (getFlavour() === '600bn' || isSanctumMode()) return 0;
  return intertitleForWave(s.wave) ? INTERTITLE_MS : 0;
}

/** Fade-out tail of the intertitle card. */
const INTERTITLE_OUT_MS = 560;

/** True while an act-boundary intertitle card is fully opaque. The WebGL
 *  overlay is fed empty entity lists during this window so its separate
 *  canvas does not paint over the 2D story card; it is released for the
 *  fade-out so mesh entities reveal behind the lifting card. */
function isIntertitleHolding(s: GameState): boolean {
  if (s.phase !== 'wavestart') return false;
  if (intertitleHoldMs(s) === 0) return false;
  return (s.elapsed - s.phaseStart) < INTERTITLE_MS - INTERTITLE_OUT_MS;
}

/**
 * Act-boundary story card — a self-contained full-screen card shown for the
 * whole wavestart on the waves in ACT_INTROS (1 / 10 / 17 / 25). One card
 * carries the act beat (label + two arc lines) AND the wave identity (WAVE N
 * + specimen name + subtitle + tagline), so skipping it never drops the wave
 * name and there is no fragile second banner. Skippable via skipWaveStart
 * once the window opens. Campaign flavour only — the 600bn Sanctum teaser is
 * not the hero quest.
 */
function drawIntertitle(ctx: CanvasRenderingContext2D, s: GameState): void {
  if (s.phase !== 'wavestart') return;
  if (intertitleHoldMs(s) === 0) return;
  const intro = intertitleForWave(s.wave);
  if (!intro) return;
  const elapsed = s.elapsed - s.phaseStart;
  if (elapsed >= INTERTITLE_MS) return;

  // Single envelope — the whole card fades in, holds, then fades out, so
  // every element is on screen well before the skip window opens.
  const IN = 420;
  let alpha: number;
  if (elapsed < IN) alpha = elapsed / IN;
  else if (elapsed < INTERTITLE_MS - INTERTITLE_OUT_MS) alpha = 1;
  else alpha = (INTERTITLE_MS - elapsed) / INTERTITLE_OUT_MS;
  alpha = Math.max(0, Math.min(1, alpha));

  ctx.save();
  applyOverlayTransform(ctx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Full-screen black hold — covers HUD, background, the lot. Filled in
  // device space so the modern-mode letterbox gutters black out too; the
  // transform is restored straight after for the world-space text below.
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#000';
  if (renderMode.kind === 'modern') {
    ctx.save();
    ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
    ctx.fillRect(0, 0, renderMode.vw, renderMode.vh);
    ctx.restore();
  } else {
    ctx.fillRect(0, 0, WORLD_W, WORLD_H);
  }

  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;

  // — Act label — small, wide-tracked, cold blue.
  ctx.font = 'bold 17px ui-monospace, monospace';
  ctx.fillStyle = '#5b9dff';
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 14;
  ctx.letterSpacing = '0.34em' as unknown as string;
  ctx.fillText(intro.act, cx, cy - 132);

  // — Two arc lines — the story beat.
  ctx.font = '21px ui-monospace, monospace';
  ctx.fillStyle = '#fff5d8';
  ctx.shadowColor = 'rgba(0,0,0,0.9)';
  ctx.shadowBlur = 4;
  ctx.letterSpacing = '0.04em' as unknown as string;
  ctx.fillText(intro.lines[0], cx, cy - 90);
  ctx.fillText(intro.lines[1], cx, cy - 58);

  // — Divider —
  ctx.globalAlpha = alpha * 0.45;
  ctx.strokeStyle = '#5b9dff';
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 170, cy - 20);
  ctx.lineTo(cx + 170, cy - 20);
  ctx.stroke();
  ctx.globalAlpha = alpha;

  // — Wave identity — WAVE N + specimen name + factual subtitle + tagline.
  ctx.font = 'bold 50px ui-monospace, monospace';
  ctx.fillStyle = '#5b9dff';
  ctx.shadowColor = '#5b9dff';
  ctx.shadowBlur = 22;
  ctx.letterSpacing = '0em' as unknown as string;
  ctx.fillText(`WAVE ${s.wave}`, cx, cy + 22);

  ctx.font = 'bold 25px ui-monospace, monospace';
  ctx.fillStyle = '#ffd84a';
  ctx.shadowColor = '#ffd84a';
  ctx.shadowBlur = 14;
  ctx.letterSpacing = '0.18em' as unknown as string;
  ctx.fillText(waveName(s.wave), cx, cy + 64);

  const subtitle = waveSubtitle(s.wave);
  if (subtitle) {
    ctx.font = '15px ui-monospace, monospace';
    ctx.fillStyle = '#fff5d8';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur = 4;
    ctx.letterSpacing = '0.06em' as unknown as string;
    ctx.fillText(subtitle, cx, cy + 96);
  }

  const tagline = waveTagline(s.wave);
  if (tagline) {
    ctx.font = '14px ui-monospace, monospace';
    ctx.fillStyle = '#7da5d4';
    ctx.shadowColor = '#5b9dff';
    ctx.shadowBlur = 6;
    ctx.letterSpacing = '0.10em' as unknown as string;
    ctx.fillText(tagline, cx, cy + 124);
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
  const elapsed = (s.elapsed - s.phaseStart) / WARP_MS;  // 0..1 across phase
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

  if (isWebGLOverlayReady()) {
    callWebGLOverlay({
      asteroids: [],
      ufos: [],
      powerups: [],
      ships: [],
      elapsed: state.elapsed,
      dpr: renderMode.dpr,
      scale: renderMode.scale,
      tx: renderMode.tx,
      ty: renderMode.ty,
      worldW: WORLD_W,
      worldH: WORLD_H,
      wrapXs: [0],
    });
  }

  drawBackground(ctx, state, now);
  drawStars(ctx, now);

  const wallElapsed = state.elapsed - dr.startedAt;
  const gameTime = replayGameTime(dr.spanMs, wallElapsed);
  const snap = pickSnapshot(dr.snapshots, gameTime);

  // Clip replayed entities and debris to the world rect, the same letterbox-
  // gutter guard as the live path. The vignette below is device space and is
  // left unclipped on purpose so it still frames the whole screen.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, WORLD_W, WORLD_H);
  ctx.clip();

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
      shieldHitFlash: 0, lastHyperspaceAt: 0,
    };
    drawShip(ctx, fauxShip, now, 0, false, true);
  }

  // Real death-explosion: particles + ship debris that updateGame re-spawns
  // when replay-time crosses the impact frame. Same composition as killShip
  // during live play so the cinematic matches exactly. The synthetic ring
  // overlay is gone — particles + debris carry the moment.
  drawParticles(ctx, state.particles);
  drawDebris(ctx, state.debris);
  drawShockwaves(ctx, state.shockwaveRings, now);
  ctx.restore();  // release the world-rect clip before the device-space vignette

  // Red vignette: clear at the centre, deepening to red at the edges. Drawn
  // in device space so it frames the whole screen — modern-mode letterbox
  // gutters included — not just the world rect. Skipped under ASCII, where
  // the postfx brightness-normalises each cell into a harsh red flood.
  if (getTheme() !== 'ascii') {
    ctx.save();
    const vigW = renderMode.kind === 'modern' ? renderMode.vw : WORLD_W;
    const vigH = renderMode.kind === 'modern' ? renderMode.vh : WORLD_H;
    if (renderMode.kind === 'modern') ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
    const grad = ctx.createRadialGradient(
      vigW / 2, vigH / 2, vigH * 0.25,
      vigW / 2, vigH / 2, Math.hypot(vigW, vigH) / 2,
    );
    grad.addColorStop(0, 'rgba(255, 80, 80, 0)');
    grad.addColorStop(1, 'rgba(120, 0, 0, 0.42)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, vigW, vigH);
    ctx.restore();
  }

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

// ── Hyperspace cinematic ────────────────────────────────────────────────────
//
// Two transient effects: a 'collapse' at the departure point (inward spiral
// + contracting ring + central pinch flash) and an 'emerge' at the arrival
// point (expanding ring + outward starburst + central flash). Drawn in 2D so
// it works across all visual tiers. Self-prunes each frame.

function drawHyperspaceEffects(ctx: CanvasRenderingContext2D, effects: HyperspaceEffect[], now: number): void {
  const COLLAPSE_MS = 350;
  const EMERGE_MS = 400;
  for (const e of effects) {
    const lifeMs = e.kind === 'collapse' ? COLLAPSE_MS : EMERGE_MS;
    const age = (now - e.startMs) / lifeMs;
    if (age >= 1 || age < 0) continue;
    const accent = e.malfunction ? '#ff4040' : (e.kind === 'collapse' ? '#7fdfff' : '#9be7ff');
    const white = '#ffffff';
    ctx.save();
    ctx.translate(e.x, e.y);
    ctx.strokeStyle = accent;
    ctx.shadowColor = accent;
    if (e.kind === 'collapse') {
      // Inward spiral lines + contracting ring + central pinch at end.
      const ease = age * age;
      const ringR = 70 * (1 - ease);
      ctx.globalAlpha = (1 - age) * 0.9;
      ctx.shadowBlur = 14;
      ctx.lineWidth = 2;
      for (let i = 0; i < 10; i++) {
        const a = (Math.PI * 2 * i) / 10 + age * 4;
        const outerR = 70 + (1 - age) * 30;
        const innerR = Math.max(0, ringR);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * outerR, Math.sin(a) * outerR);
        ctx.lineTo(Math.cos(a) * innerR, Math.sin(a) * innerR);
        ctx.stroke();
      }
      if (ringR > 0.5) {
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (age > 0.7) {
        const flash = (age - 0.7) / 0.3;
        ctx.globalAlpha = flash;
        ctx.fillStyle = white;
        ctx.shadowBlur = 22;
        ctx.beginPath();
        ctx.arc(0, 0, 8 + flash * 6, 0, Math.PI * 2);
        ctx.fill();
      }
    } else {
      // Emerge: expanding ring + outward starburst + central white flash.
      const ease = 1 - Math.pow(1 - age, 2.5);
      const ringR = 6 + 75 * ease;
      ctx.globalAlpha = (1 - age) * 0.9;
      ctx.shadowBlur = 16;
      ctx.lineWidth = 2 + (1 - age) * 2;
      ctx.beginPath();
      ctx.arc(0, 0, ringR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 8; i++) {
        const a = (Math.PI * 2 * i) / 8 + age * 0.6;
        const r0 = 12 + ringR * 0.4;
        const r1 = ringR + 6;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.stroke();
      }
      if (age < 0.4) {
        const flash = 1 - age / 0.4;
        ctx.globalAlpha = flash;
        ctx.fillStyle = white;
        ctx.shadowBlur = 22;
        ctx.beginPath();
        ctx.arc(0, 0, 14 * flash + 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
  // Prune dead effects — walk backward so splice indices stay stable.
  for (let i = effects.length - 1; i >= 0; i--) {
    const lifeMs = effects[i].kind === 'collapse' ? 350 : 400;
    if ((now - effects[i].startMs) >= lifeMs) effects.splice(i, 1);
  }
}

// ── Wave-clear pickup countdown ─────────────────────────────────────────────
//
// The grab-everything grace window after a wave clears. A gentle 5→1
// countdown sits high on screen so the player can pace the dash. The window
// itself is skipped (waveClearAt never set) when there's nothing to grab or
// the run is cheated — see the wave-clear handler in game.ts.

function drawWaveClearCountdown(ctx: CanvasRenderingContext2D, state: GameState): void {
  // Live play only — never bleeds into warp / wavestart / gameover.
  if (state.phase !== 'playing') return;
  if (state.waveClearAt === null) return;
  const elapsed = state.elapsed - state.waveClearAt;
  const remainingMs = Math.max(0, WAVE_CLEAR_GRACE_MS - elapsed);
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000));
  // Pulse: the number breathes between full size and 90% so the countdown
  // feels alive even when it doesn't change. Synced to the second boundary
  // so the "tick" lines up with the breath.
  const fracInSecond = (remainingMs % 1000) / 1000;
  const pulse = 0.9 + 0.1 * Math.sin(fracInSecond * Math.PI * 2);
  ctx.save();
  applyOverlayTransform(ctx);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffd84a';
  ctx.shadowColor = '#ff8a3a';
  ctx.shadowBlur = 12;
  ctx.font = 'bold 18px ui-monospace, monospace';
  ctx.fillText('WAVE CLEAR · GRAB EVERYTHING', WORLD_W / 2, 110);
  ctx.shadowBlur = 28;
  ctx.font = `bold ${Math.round(72 * pulse)}px ui-monospace, monospace`;
  ctx.fillText(String(seconds), WORLD_W / 2, 170);
  ctx.restore();
}

// ── Shockwave rings (transient post-shatter effect) ─────────────────────────
//
// Soft expanding stroke, ~380ms life. Cubic ease-out so the initial pop is
// fast and the trailing fade reads "settling dust" rather than "drifting".
// Self-prunes dead rings each frame — no game-tick coupling. Drawn inside the
// shake transform so the ring moves with the world that spawned it.

function drawShockwaves(ctx: CanvasRenderingContext2D, rings: Shockwave[], now: number): void {
  const RING_LIFETIME_MS = 380;
  const RING_GROWTH = 2.2;
  for (const r of rings) {
    const age = (now - r.startMs) / RING_LIFETIME_MS;
    if (age >= 1 || age < 0) continue;
    const ease = 1 - Math.pow(1 - age, 3);
    const radius = r.baseRadius * (1 + ease * RING_GROWTH);
    const alpha = (1 - age) * 0.85;
    const width = (1 - age) * 4 + 0.5;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // Prune dead rings — walk backward so splice indices stay stable.
  for (let i = rings.length - 1; i >= 0; i--) {
    if ((now - rings[i].startMs) >= RING_LIFETIME_MS) rings.splice(i, 1);
  }
}

// ── HUD layer ─────────────────────────────────────────────────────────────────

/** Persistent offscreen canvas the radar renders into at 1:1 each frame.
 *  Composited back to the main canvas with a per-scanline trapezoidal
 *  warp so the panel looks like an arcade-cabinet console tilted away
 *  from the player. Holding it module-level so we are not constructing
 *  + destroying a canvas every frame. */
let radarOffscreen: HTMLCanvasElement | null = null;
function getRadarOffscreen(w: number, h: number): HTMLCanvasElement {
  if (!radarOffscreen) radarOffscreen = document.createElement('canvas');
  if (radarOffscreen.width !== w || radarOffscreen.height !== h) {
    radarOffscreen.width = w;
    radarOffscreen.height = h;
  }
  return radarOffscreen;
}

/** Defender-style radar. Portrait-follow only: the player sees a vertical
 *  slice of the world, so a compressed whole-world map with blips keeps them
 *  aware of the field that is off-screen.
 *
 *  Visual depth: rendered to an offscreen canvas at 1:1 then composited
 *  back with a per-scanline trapezoid warp (top edge ~92% the width of
 *  the bottom) plus an atmospheric darken-toward-the-top gradient.
 *  Reads like a sloped cabinet console rather than a flat sticker. */
function drawRadar(ctx: CanvasRenderingContext2D, s: GameState): void {
  if (!isFollowPhase(s.phase)) return;
  const radarDeathmatch = deathmatchActive();
  // Defender mode forces the radar on — the wide-arena scroll only reads
  // with whole-world awareness. Outside defender, the player's preference
  // governs (default on for portrait, off for landscape).
  if (!renderMode.defender && !radarDeathmatch && !getRadarVisible()) return;
  if (!renderMode.follow && !getRadarLandscape() && !renderMode.defender && !radarDeathmatch) return;

  ctx.save();
  ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);

  const insets = renderMode.insets;
  let x0 = 24 + insets.left;
  let w = renderMode.vw - 48 - insets.left - insets.right;
  // Below the HUD top block — the SCORE / SATS stack reaches roughly topY+110.
  let y0 = 16 + insets.top + 120;
  let h = 76;
  if (radarDeathmatch) {
    const maxW = renderMode.vw - 48 - insets.left - insets.right;
    const maxH = renderMode.vh - 128 - insets.top - insets.bottom;
    const manyPlayers = s.players.length >= 32;
    const size = Math.round(Math.max(132, Math.min(manyPlayers ? 178 : 212, maxW, maxH * 0.34)));
    x0 = 24 + insets.left;
    y0 = renderMode.vh >= 560
      ? renderMode.vh - size - 24 - insets.bottom
      : 92 + insets.top;
    w = size;
    h = size;
  }
  if (w < 80) { ctx.restore(); return; }  // too cramped to be useful

  // ── Phase 1: render the radar contents into the offscreen canvas at 1:1.
  const off = getRadarOffscreen(w, h);
  const oc = off.getContext('2d');
  if (!oc) { ctx.restore(); return; }
  oc.clearRect(0, 0, w, h);

  // Panel. Near-opaque so blips read against any background colour.
  oc.fillStyle = 'rgba(6, 10, 20, 0.94)';
  oc.fillRect(0, 0, w, h);
  oc.lineWidth = 1;
  oc.strokeStyle = 'rgba(120, 150, 255, 0.32)';
  oc.strokeRect(0.5, 0.5, w - 1, h - 1);
  if (radarDeathmatch) {
    oc.strokeStyle = 'rgba(100, 132, 190, 0.18)';
    oc.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const gx = (i / 4) * w;
      const gy = (i / 4) * h;
      oc.beginPath();
      oc.moveTo(gx, 1);
      oc.lineTo(gx, h - 1);
      oc.moveTo(1, gy);
      oc.lineTo(w - 1, gy);
      oc.stroke();
    }
  }
  oc.save();
  oc.beginPath();
  oc.rect(0, 0, w, h);
  oc.clip();

  // World -> offscreen mapping. Same shape as before but anchored at 0,0
  // inside the offscreen canvas; the warp on the way out positions it.
  const radarWorldW = renderWorldW();
  const radarWorldH = renderWorldH();
  const mapRadar = (wx: number, wy: number): { x: number; y: number } => ({
    x: radarDeathmatch ? (wx / radarWorldW) * w : (wrapInto(wx) / WORLD_W) * w,
    y: (wy / radarWorldH) * h,
  });
  const blip = (wx: number, wy: number, r: number, fill: string, stroke?: string): void => {
    const p = mapRadar(wx, wy);
    oc.fillStyle = fill;
    oc.beginPath();
    oc.arc(p.x, p.y, r, 0, Math.PI * 2);
    oc.fill();
    if (stroke) {
      oc.strokeStyle = stroke;
      oc.lineWidth = 1;
      oc.stroke();
    }
  };
  const playerColours = ['#58ff58', '#ff6b6b', '#5be8ff', '#ffd84a', '#ff8a3a', '#d77aff', '#8cffb8', '#ff9ec7'];
  const terrainBlip = (wx: number, wy: number, r: number): void => {
    const p = mapRadar(wx, wy);
    oc.fillStyle = 'rgba(216, 194, 122, 0.54)';
    oc.strokeStyle = 'rgba(255, 230, 150, 0.82)';
    oc.lineWidth = 1;
    oc.beginPath();
    oc.arc(p.x, p.y, r, 0, Math.PI * 2);
    oc.fill();
    oc.stroke();
  };
  for (const a of s.asteroids) {
    if (radarDeathmatch && a.terrain) {
      terrainBlip(a.pos.x, a.pos.y, Math.max(4, Math.min(15, a.radius * 0.045 + 1)));
      continue;
    }
    const colour = radarDeathmatch ? 'rgba(154, 166, 200, 0.72)' : '#9aa6c8';
    blip(a.pos.x, a.pos.y, Math.max(1.3, Math.min(4.8, a.radius * 0.058 + 0.75)), colour);
  }
  for (const b of s.enemyBullets) blip(b.pos.x, b.pos.y, 1.8, '#ff8a1e');
  for (const p of s.powerups) blip(p.pos.x, p.pos.y, 3.4, '#5be8ff', 'rgba(210,250,255,0.86)');
  for (const m of s.mines) blip(m.pos.x, m.pos.y, 3, '#ff5a4a', 'rgba(255,210,190,0.72)');
  for (const u of s.ufos) blip(u.pos.x, u.pos.y, 3.6, '#ff4af0', 'rgba(255,210,255,0.75)');
  const localSlot = renderMode.localSlot ?? 0;
  const playerBlip = s.players.length > 32 ? 2.4 : s.players.length > 16 ? 3.2 : 4.6;
  for (let i = 0; i < s.players.length; i++) {
    const pl = s.players[i];
    if (!pl.ship.alive) continue;
    const p = mapRadar(pl.ship.pos.x, pl.ship.pos.y);
    const local = i === localSlot;
    const colour = local ? '#58ff58' : playerColours[i % playerColours.length];
    oc.fillStyle = colour;
    oc.strokeStyle = local ? 'rgba(232,255,232,0.95)' : 'rgba(255,255,255,0.58)';
    oc.lineWidth = local ? 2.2 : 1;
    oc.beginPath();
    oc.arc(p.x, p.y, local ? playerBlip + 2.6 : playerBlip, 0, Math.PI * 2);
    oc.fill();
    oc.stroke();
    if (radarDeathmatch && s.players.length <= 8) {
      oc.font = 'bold 8px ui-monospace, monospace';
      oc.textAlign = 'center';
      oc.textBaseline = 'middle';
      oc.fillStyle = '#031008';
      oc.fillText(String(i + 1), p.x, p.y + 0.2);
    }
  }

  // Visible-strip box — the slice the follow camera currently shows.
  const strip = renderMode.vw / (renderMode.vh / WORLD_H);
  const boxW = Math.min(strip / radarWorldW, 1) * w;
  const boxX = radarDeathmatch
    ? Math.max(0, Math.min(w - boxW, ((camX - strip / 2) / radarWorldW) * w))
    : (wrapInto(camX - strip / 2) / WORLD_W) * w;
  const boxH = radarDeathmatch ? Math.min(WORLD_H / radarWorldH, 1) * h : h - 2;
  const boxY = radarDeathmatch ? Math.max(1, Math.min(h - boxH - 1, ((camY - WORLD_H / 2) / radarWorldH) * h)) : 1;
  oc.strokeStyle = 'rgba(255, 240, 180, 0.95)';
  oc.lineWidth = 1.5;
  if (radarDeathmatch) {
    oc.strokeRect(boxX, boxY, boxW, boxH);
  } else if (boxX + boxW <= w) {
    oc.strokeRect(boxX, 1, boxW, h - 2);
  } else {
    const first = w - boxX;
    oc.strokeRect(boxX, 1, first, h - 2);
    oc.strokeRect(0, 1, boxW - first, h - 2);
  }

  // Atmospheric depth: top edge slightly darker so the eye reads
  // "further away" before the geometry even helps.
  const grad = oc.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(4, 6, 12, 0.35)');
  grad.addColorStop(0.55, 'rgba(0, 0, 0, 0)');
  oc.fillStyle = grad;
  oc.fillRect(0, 0, w, h);
  oc.restore();

  if (radarDeathmatch) {
    ctx.drawImage(off, x0, y0);
    ctx.restore();
    return;
  }

  // ── Phase 2: composite back with a per-scanline trapezoid warp.
  // Tilt intensity is player-controlled; 'off' draws flat (single
  // drawImage), 'subtle' uses a 96% top-edge, 'cabinet' the original 92%.
  // 76 drawImage calls per frame is negligible on any GPU that can run
  // the rest of the game.
  const tilt = getRadarTilt();
  if (tilt === 'off') {
    ctx.drawImage(off, x0, y0);
  } else {
    const topScale = tilt === 'subtle' ? 0.96 : 0.92;
    const cx = x0 + w / 2;
    for (let row = 0; row < h; row++) {
      const t = row / (h - 1);
      const widthScale = topScale + (1 - topScale) * t;
      const sliceW = w * widthScale;
      ctx.drawImage(off, 0, row, w, 1, cx - sliceW / 2, y0 + row, sliceW, 1);
    }
  }

  ctx.restore();
}

/** The full HUD overlay layer: persistent readouts, transient wave
 *  banners, and the intertitle. The intertitle draws last so its black
 *  card can cover the readouts during act-boundary intros. */
function drawHudLayer(ctx: CanvasRenderingContext2D, state: GameState): void {
  if (state.phase === 'title') return;
  drawHud(ctx, state);
  drawRadar(ctx, state);
  drawWaveBanner(ctx, state);
  drawBonusBanner(ctx, state);
  drawWaveClearCountdown(ctx, state);
  drawIntertitle(ctx, state);
}

/** Crisp HUD pass for the ASCII theme. render() skips the HUD layer while
 *  ASCII is active so it is not resampled into a smear; main.ts calls this
 *  after the postfx so the readouts land sharp over the character field.
 *  The 2D transform persists between calls, so the layer sees the same
 *  world transform render() would have left it. */
export function drawAsciiHud(canvas: HTMLCanvasElement, state: GameState): void {
  if (hudHidden) return;
  if (state.phase === 'warp' || state.phase === 'deathreplay') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  drawHudLayer(ctx, state);
}

// ── Main render ───────────────────────────────────────────────────────────────

export function render(canvas: HTMLCanvasElement, state: GameState, now: number): void {
  const ctx = canvas.getContext('2d')!;
  // Follow camera centres on the LOCAL slot — defaults to players[0] for
  // every solo / couch / spectate / portrait-solo path; only the slot-1
  // duel client passes localSlot=1 via setRenderMode.
  const localSlotIdx = renderMode.localSlot ?? 0;
  const p0 = state.players[localSlotIdx] ?? state.players[0];
  // Clear in identity space — the ctx still holds the previous frame's world
  // transform, and clearRect under it would miss the device-pixel edges.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Portrait follow camera. In portrait-modern the renderer shows the world at
  // full height and scrolls a horizontal slice to track the ship; everywhere
  // else it keeps fit()'s static contain transform. Computed here, before the
  // phase branches, so the transform, the seam-wrap offsets, the clip and the
  // star field all share one camera. Render-only: the sim never sees any of
  // this, so B3 determinism is untouched.
  const followActive = !!renderMode.follow && isFollowPhase(state.phase);
  // Arena cage: shown from wavestart onward (title keeps the bg cycle).
  const arenaRun = arenaActive() && state.phase !== 'title';
  const deathmatchRun = deathmatchActive() && state.phase !== 'title';
  const noWrapRun = arenaRun || deathmatchRun;
  const rw = renderWorldW();
  const rh = renderWorldH();
  const arenaCageR = arenaRun ? arenaCage(state.runTimeMs) : null;
  let scale = renderMode.scale;
  let tx = renderMode.tx;
  let ty = renderMode.ty;
  let camStrip = 0;
  let camStripY = WORLD_H;
  const followXs: number[] = [0];
  if (followActive) {
    scale = renderMode.vh / WORLD_H;        // full world height fills the viewport
    camStrip = renderMode.vw / scale;       // visible world width
    camStripY = renderMode.vh / scale;
    const sx = p0.ship.pos.x;
    const sy = p0.ship.pos.y;
    if (!camInit) {
      // Fresh run, post-death respawn, or a rotation into portrait: snap on.
      camX = deathmatchRun ? clampCamera(sx, camStrip, rw) : wrapInto(sx);
      camY = deathmatchRun ? clampCamera(sy, camStripY, rh) : WORLD_H / 2;
      camInit = true;
    } else if (p0.ship.alive) {
      // Dead-zone follow: the camera holds until the ship leaves a central
      // band, then eases toward the band edge. Held entirely while the ship is
      // dead so a death is not yanked off-centre.
      const dz = camStrip * 0.16;
      const d = deathmatchRun ? (sx - camX) : wrapDelta(camX, sx);
      let target = camX;
      if (d > dz) target = camX + (d - dz);
      else if (d < -dz) target = camX + (d + dz);
      const dt = Math.min(0.05, Math.max(0, (now - camPrevNow) / 1000));
      const k = 1 - Math.exp(-dt / 0.12);   // ~120ms time constant
      if (deathmatchRun) {
        camX = clampCamera(camX + (target - camX) * k, camStrip, rw);
        const dy = sy - camY;
        const dzY = camStripY * 0.16;
        let targetY = camY;
        if (dy > dzY) targetY = camY + (dy - dzY);
        else if (dy < -dzY) targetY = camY + (dy + dzY);
        camY = clampCamera(camY + (targetY - camY) * k, camStripY, rh);
      } else {
        camX = wrapInto(camX + wrapDelta(camX, target) * k);
      }
    }
    camPrevNow = now;
    tx = renderMode.vw / 2 - camX * scale;
    ty = deathmatchRun ? (renderMode.vh / 2 - camY * scale) : 0;
    // Seam-wrap copies: pull in a world-neighbour copy only when the visible
    // strip actually overruns a seam, so calm frames stay single-pass.
    // Arena has no wrap, so no seam copies: the camera simply scrolls.
    if (!noWrapRun) {
      if (camX - camStrip / 2 < 0) followXs.push(-WORLD_W);
      if (camX + camStrip / 2 > WORLD_W) followXs.push(WORLD_W);
    }
  } else {
    // Not following: re-seed onto the ship next time the camera engages.
    camInit = false;
  }

  // World-to-device transform: fit()'s contain transform, or the follow
  // camera's per-frame transform. Set before the phase branches so the warp
  // and death-replay paths, which draw in world coords and set no transform of
  // their own, render at the right scale too.
  ctx.setTransform(
    renderMode.dpr * scale, 0, 0, renderMode.dpr * scale,
    renderMode.dpr * tx, renderMode.dpr * ty,
  );

  if (state.phase === 'warp') {
    drawWarp(ctx, state, now);
    return;
  }

  if (state.phase === 'deathreplay') {
    drawReplay(ctx, state, now);
    return;
  }

  const deathmatchViewBounds: WorldBounds | undefined = followActive && deathmatchRun
    ? {
        x0: Math.max(0, camX - camStrip / 2),
        y0: Math.max(0, camY - camStripY / 2),
        x1: Math.min(rw, camX + camStrip / 2),
        y1: Math.min(rh, camY + camStripY / 2),
      }
    : undefined;
  drawBackground(ctx, state, now, deathmatchViewBounds);
  // Stars ride the world transform; under the follow camera draw them at each
  // visible seam copy so a strip straddling x=0 / WORLD_W stays starred.
  // Skipped in defender mode where the parallax starfield from
  // drawDefenderBackground is the entire star layer.
  if (!renderMode.defender && !deathmatchRun) {
    for (const dx of followXs) {
      if (dx === 0) {
        drawStars(ctx, now);
      } else {
        ctx.save();
        ctx.translate(dx, 0);
        drawStars(ctx, now);
        ctx.restore();
      }
    }
  }

  // Camera shake from accumulated trauma. trauma² gives a quadratic feel —
  // small hits barely shake, big hits punch. Reduced-motion zeros amplitude.
  let shakeX = 0, shakeY = 0;
  const trauma = state.cameraTrauma;
  if (trauma > 0 && !shouldReduceMotion()) {
    const amp = trauma * trauma * 14;
    shakeX = (Math.sin(now * 0.073) + Math.sin(now * 0.127) * 0.6) * amp;
    shakeY = (Math.cos(now * 0.091) + Math.cos(now * 0.151) * 0.6) * amp;
  }

  // Seamless wrap: when an entity straddles a world seam it must show on both
  // edges at once, so draw a ghost copy a full WORLD_W / WORLD_H over. A ghost
  // offset is added only when some entity is actually near that seam, so calm
  // frames stay single-pass. Entities wrap at the exact edge, so the teleport
  // is exactly WORLD_W and the ghost hands off to the real copy with no jump.
  const ghostXs: number[] = followActive ? followXs : [0];
  const ghostYs: number[] = [0];
  // Arena confines entities to the inset box, so they never straddle a world
  // seam: skip the ghost scan and leave ghostXs / ghostYs single-pass.
  if (!noWrapRun) {
    const BAND = 140;  // largest entity radius plus a lead-in
    let nearL = false, nearR = false, nearT = false, nearB = false;
    const scan = (x: number, y: number): void => {
      if (x < BAND) nearL = true;
      if (x > WORLD_W - BAND) nearR = true;
      if (y < BAND) nearT = true;
      if (y > WORLD_H - BAND) nearB = true;
    };
    for (const a of state.asteroids) scan(a.pos.x, a.pos.y);
    for (const b of state.bullets) scan(b.pos.x, b.pos.y);
    for (const b of state.enemyBullets) scan(b.pos.x, b.pos.y);
    for (const c of state.coins) scan(c.pos.x, c.pos.y);
    for (const p of state.powerups) scan(p.pos.x, p.pos.y);
    for (const pl of state.players) scan(pl.ship.pos.x, pl.ship.pos.y);
    // The follow camera derives its X copies from the visible strip
    // (followXs); only the contain modes need the proximity scan for X.
    if (!followActive) {
      if (nearL) ghostXs.push(WORLD_W);
      if (nearR) ghostXs.push(-WORLD_W);
    }
    if (nearT) ghostYs.push(WORLD_H);
    if (nearB) ghostYs.push(-WORLD_H);
  }

  // Shake wraps the entity layer only — HUD stays steady so readouts don't
  // judder during impacts.
  ctx.save();
  // Clip the entity layer to the world rect so nothing spills into the
  // modern-mode letterbox gutters: wrap ghosts straddling a seam, an asteroid
  // poking past an edge, scattered debris. Set before the shake translate so
  // the clip stays pinned to the world rather than riding the shake. The
  // device-space full-screen effects (combo tint, HUD) run after the restore
  // below, so they still cover the gutters.
  ctx.beginPath();
  if (followActive) {
    // The follow camera fills the viewport with the strip; clip to the strip
    // so the seam-wrap world copies are trimmed to what is actually visible.
    if (deathmatchRun) {
      ctx.rect(camX - camStrip / 2, camY - camStripY / 2, camStrip, camStripY);
    } else {
      ctx.rect(camX - camStrip / 2, 0, camStrip, WORLD_H);
    }
  } else {
    ctx.rect(0, 0, rw, rh);
  }
  ctx.clip();
  ctx.translate(shakeX, shakeY);

  // Arena cage floor — the grid sits beneath the entity layer.
  if (arenaCageR) drawArenaGrid(ctx, arenaCageR, now);

  const visibleInDeathmatchView = (x: number, y: number, r: number): boolean => (
    !deathmatchViewBounds || boundsIntersectCircle(deathmatchViewBounds, x, y, r + 120)
  );

  for (const dx of ghostXs) {
    for (const dy of ghostYs) {
      const isGhost = dx !== 0 || dy !== 0;
      if (isGhost) { ctx.save(); ctx.translate(dx, dy); }
      // Parallax depth sort: all asteroids paint back-to-front BEFORE
      // the ship + projectiles. Foregrounds (depth ≥4) used to paint
      // AFTER the ship to suggest "closer to camera", but users found
      // the resulting ship occlusion confusing and unpredictable
      // ("ship goes behind some asteroids"). Ship now stays on top of
      // every band; depth still reads via size/speed/opacity cues.
      const sortedAsteroids = state.asteroids.slice().sort((p, q) => (p.depth ?? 3) - (q.depth ?? 3));
      for (const a of sortedAsteroids) {
        if (!visibleInDeathmatchView(a.pos.x, a.pos.y, a.radius)) continue;
        const dCfg = DEPTH_CONFIGS[a.depth ?? 3];
        if (dCfg && dCfg.alphaMul !== 1) {
          ctx.save();
          ctx.globalAlpha *= dCfg.alphaMul;
          drawAsteroid(ctx, a, now);
          ctx.restore();
        } else {
          drawAsteroid(ctx, a, now);
        }
      }
      // Mines and UFOs never wrap. In the contain modes that means one draw,
      // in the real pass. Under the follow camera the X-offset copies are the
      // genuine wrapped world and must include them; the Y-ghost passes still
      // must not, or a phantom appears on the off-screen opposite edge.
      if (dy === 0 && (dx === 0 || followActive)) {
        for (const m of state.mines) if (visibleInDeathmatchView(m.pos.x, m.pos.y, m.radius)) drawMine(ctx, m, now);
        for (const u of state.ufos) if (visibleInDeathmatchView(u.pos.x, u.pos.y, u.radius)) drawUfo(ctx, u, now);
      }
      for (const b of state.bullets) if (visibleInDeathmatchView(b.pos.x, b.pos.y, b.radius)) drawBullet(ctx, b, true);
      for (const b of state.enemyBullets) if (visibleInDeathmatchView(b.pos.x, b.pos.y, b.radius)) drawBullet(ctx, b, false);
      for (const c of state.coins) if (visibleInDeathmatchView(c.pos.x, c.pos.y, c.radius)) drawCoin(ctx, c, now);
      for (const p of state.powerups) if (visibleInDeathmatchView(p.pos.x, p.pos.y, p.radius + 20)) drawPowerUp(ctx, p, now);
      drawGhostShip(ctx, state);
      drawGhostAttract(ctx, state, now);
      const idleSway = state.phase === 'title' || state.phase === 'wavestart';
      for (const pl of state.players) {
        if (pl.ship.alive || pl.ship.hyperspaceCloakMs > 0) {
          if (!visibleInDeathmatchView(pl.ship.pos.x, pl.ship.pos.y, pl.ship.radius + 80)) continue;
          drawShield(ctx, pl.ship, now, state.elapsed);
          drawShip(ctx, pl.ship, now, state.elapsed, idleSway);
        }
      }
      if (deathmatchRun && dx === 0 && dy === 0) {
        drawDeathmatchLocalMarker(ctx, p0.ship, now, state.elapsed, state.players.length);
      }
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
  drawShockwaves(ctx, state.shockwaveRings, now);
  drawHyperspaceEffects(ctx, state.hyperspaceEffects, now);

  // Arena cage walls — glowing borders over the entity layer, flushing red
  // as the ship nears a wall.
  if (arenaCageR) drawArenaWalls(ctx, state, arenaCageR, now);

  ctx.restore();

  // Hyperspace-malfunction chromatic split — red+cyan vignettes nudged
  // opposite directions sell the "something's wrong" frame. Cheap (two
  // gradient draws), and visually distinct from any other in-world effect.
  if (p0.ship.hyperspaceCloakMs > 0 && p0.ship.hyperspaceMalfunction && !shouldReduceMotion()) {
    drawChromaticSplit(ctx, now);
  }

  // 5x combo screen tint -- a faint warm wash that signals "we're at the
  // cap" without obscuring play. Only when combo is at COMBO_MAX; below
  // that the bass-pulse stem alone carries the intensity. Skipped under
  // ASCII, where the postfx brightness-normalises each cell and would
  // amplify this faint wash into a screen-wide red flood.
  if (p0.combo >= COMBO_MAX && getTheme() !== 'ascii') {
    const alpha = shouldReduceMotion() ? 0.04 : 0.08;
    ctx.save();
    ctx.fillStyle = `rgba(255,80,40,${alpha})`;
    if (renderMode.kind === 'modern') {
      // Device space so the tint covers the whole screen, letterbox gutters
      // included — not just the world rect.
      ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
      ctx.fillRect(0, 0, renderMode.vw, renderMode.vh);
    } else {
      ctx.fillRect(0, 0, WORLD_W, WORLD_H);
    }
    ctx.restore();
  }

  // ASCII defers the HUD layer: drawing it now would feed the readouts
  // through the character resample into an unreadable smear. main.ts
  // re-runs drawAsciiHud crisp once the postfx has finished.
  if (!hudHidden && getTheme() !== 'ascii') {
    drawHudLayer(ctx, state);
  }

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
    const asteroidTier = getVisualStyle('asteroid');
    const particleTier = getVisualStyle('particle');
    // UFOs follow ship OR asteroid tier — see drawUfo gate for why.
    const ufosMesh = shipTier === 'mesh' || asteroidTier === 'mesh';
    // While an act-boundary intertitle holds the screen black, feed the
    // overlay empty lists so its canvas stays clear of the story card.
    const holding = isIntertitleHolding(state) || state.phase === 'title';
    const meshMargin = 260;
    const meshVisible = (x: number, y: number, r = 0): boolean => {
      if (!followActive || !deathmatchRun) return true;
      const left = camX - camStrip / 2 - meshMargin;
      const right = camX + camStrip / 2 + meshMargin;
      const top = camY - camStripY / 2 - meshMargin;
      const bottom = camY + camStripY / 2 + meshMargin;
      return x + r >= left && x - r <= right && y + r >= top && y - r <= bottom;
    };
    const meshAsteroids = !holding && asteroidTier === 'mesh'
      ? state.asteroids.filter((a) => !a.councilMember && meshVisible(a.pos.x, a.pos.y, a.radius))
      : [];
    const meshUfos = !holding && ufosMesh
      ? state.ufos.filter((u) => meshVisible(u.pos.x, u.pos.y, u.radius))
      : [];
    const meshPowerups = !holding && particleTier === 'mesh'
      ? state.powerups.filter((p) => meshVisible(p.pos.x, p.pos.y, p.radius + 30))
      : [];
    const meshShips = !holding && shipTier === 'mesh'
      ? state.players.map((pl) => meshVisible(pl.ship.pos.x, pl.ship.pos.y, pl.ship.radius + 80) ? pl.ship : null)
      : [];
    // Mesh path now supports multi-ship: feed every player's ship by
    // slot. The overlay caches a mesh per slot so both ships render
    // with the full 3D look in duel / couch (was: slot 1 dropped out).
    callWebGLOverlay({
      asteroids: meshAsteroids,
      ufos: meshUfos,
      powerups: meshPowerups,
      ships: meshShips,
      elapsed: state.elapsed,
      dpr: renderMode.dpr,
      // Camera-adjusted transform so mesh-tier entities track the follow
      // camera; identical to renderMode's values outside portrait-follow.
      scale,
      tx,
      ty,
      worldW: rw,
      worldH: rh,
      // Seam-wrap copies for the follow camera, so mesh entities wrap at the
      // world edge like the 2D layer. Just [0] outside portrait-follow.
      wrapXs: followXs,
    });
  }

  // Council label chip removed — the medallion now shows name + role
  // on its own faces, so an external chip is redundant noise.
}

/** BONUS banner — large 'B · O · N · U · S' intro for the first ~3s,
 *  then a persistent countdown timer + sub-phase label (HYPER BLITZ
 *  vs EVENT HORIZON PRELUDE) at the top of the canvas for the rest
 *  of the 60s window. */
function drawBonusBanner(ctx: CanvasRenderingContext2D, s: GameState): void {
  if (s.phase !== 'bonus') return;
  const elapsed = s.elapsed - s.bonusStartedAt;
  const remaining = Math.max(0, 60_000 - elapsed);
  const subPhase = elapsed < 45_000 ? 'HYPER BLITZ' : 'EVENT HORIZON PRELUDE';

  ctx.save();
  applyOverlayTransform(ctx);
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
  // Device space so the split covers the whole screen — letterbox gutters
  // included — not just the world rect. Radii scale to the viewport.
  const modern = renderMode.kind === 'modern';
  const w = modern ? renderMode.vw : WORLD_W;
  const h = modern ? renderMode.vh : WORLD_H;
  const cx = w / 2, cy = h / 2;
  const inner = Math.hypot(w, h) / 12;
  const outer = Math.hypot(w, h) / 2;
  ctx.save();
  if (modern) ctx.setTransform(renderMode.dpr, 0, 0, renderMode.dpr, 0, 0);
  ctx.globalCompositeOperation = 'lighter';
  const red = ctx.createRadialGradient(cx - amp, cy, inner, cx - amp, cy, outer);
  red.addColorStop(0, 'rgba(255,80,80,0)');
  red.addColorStop(1, `rgba(255,60,60,${alpha})`);
  ctx.fillStyle = red;
  ctx.fillRect(0, 0, w, h);
  const cyan = ctx.createRadialGradient(cx + amp, cy, inner, cx + amp, cy, outer);
  cyan.addColorStop(0, 'rgba(80,255,255,0)');
  cyan.addColorStop(1, `rgba(60,200,255,${alpha})`);
  ctx.fillStyle = cyan;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}
