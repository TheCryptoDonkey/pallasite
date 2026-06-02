/**
 * Per-category visual style preferences.
 *
 *   vector  — original 1979 line-art look: thin stroke, per-type glow, no fill.
 *   shaded  — modern lit look: gradient/photoreal fill, rim light, drop shadow.
 *   mesh    — full WebGL 3D meshes via the dynamic-imported overlay (three.js).
 *             Falls back to shaded at render time until the overlay loads so
 *             a stale localStorage value or slow CDN can't blank the game.
 *
 * Four independent categories — asteroid, ship, bullet, particle — so a
 * player can mix-and-match (e.g. mesh asteroids on a vector ship). The
 * settings panel offers a quick-preset shortcut (ALL CLASSIC / ALL SHADED /
 * ALL 3D) for the common case.
 *
 * Defaults vary by flavour: main game opens with everything VECTOR (matches
 * what returning players see), 600bn opens with everything MESH (the
 * conference teaser is the showcase for the WebGL pipeline).
 */

import type { Asteroid, PowerUp, Ship, Ufo } from './types.js';
import { ASCII_COLS, BIT_DEPTH, coerceThemeId, type ThemeId } from './postfx/index.js';
import { getFlavour } from './flavour.js';
import { getStoredMode, isSanctumMode } from './mode.js';

export type VisualTier = 'vector' | 'shaded' | 'mesh';
export type VisualCategory = 'asteroid' | 'ship' | 'bullet' | 'particle';

export const VISUAL_CATEGORIES: readonly VisualCategory[] = ['asteroid', 'ship', 'bullet', 'particle'];
export const VISUAL_TIERS: readonly VisualTier[] = ['vector', 'shaded', 'mesh'];

const KEY = 'pallasite:visualStyle';

interface State {
  asteroid: VisualTier;
  ship: VisualTier;
  bullet: VisualTier;
  particle: VisualTier;
  theme: ThemeId;
  asciiCols: number;
  bitDepth: number;
  bitColour: boolean;
  brightness: number;
}

export const BRIGHTNESS = { min: 0.7, max: 1.35, step: 0.05, default: 1.0 } as const;

function defaults(): State {
  // Fresh installs open in full 3D mesh with the standard presentation.
  // CRT remains selectable, but it is no longer the default: the extra
  // full-frame post-process cost is not worth paying before a player opts in.
  return {
    asteroid: 'mesh',
    ship: 'mesh',
    bullet: 'mesh',
    particle: 'mesh',
    theme: 'none',
    asciiCols: ASCII_COLS.default,
    bitDepth: BIT_DEPTH.default,
    bitColour: false,
    brightness: BRIGHTNESS.default,
  };
}

let cached: State | null = null;

function urlFlag(name: string): string | null {
  try { return new URLSearchParams(window.location.search).get(name); }
  catch { return null; }
}

export function mobileRuntimeActive(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const uaMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  const coarse = (() => {
    try { return window.matchMedia?.('(pointer: coarse)').matches === true; }
    catch { return false; }
  })();
  const touch = (navigator.maxTouchPoints ?? 0) > 0;
  const smallViewport = Math.min(window.innerWidth || 9999, window.innerHeight || 9999) <= 640
    || Math.max(window.innerWidth || 0, window.innerHeight || 0) <= 960;
  return uaMobile || ((coarse || touch) && smallViewport);
}

/** URL escape hatches that force FULL fidelity regardless of device or
 *  measured performance — `?fullfx=1` / `?highfx=1` for capture/debug, and
 *  `?mobileLite=0` to disable the phone guard. Both must also veto the runtime
 *  governor below, or the override wouldn't actually hold under load. */
function fxOverrideForcesFull(): boolean {
  return urlFlag('fullfx') === '1' || urlFlag('highfx') === '1' || urlFlag('mobileLite') === '0';
}

/** Phone-safe presentation guard. iOS Safari cannot reliably hold frame
 *  budget with the WebGL mesh overlay plus the game canvas in the general
 *  campaign, so phones use the shaded canvas path by default and skip
 *  expensive presentation FX. Sanctum is the exception: its textured fillers
 *  and council medallions are cheaper and clearer on the overlay path. */
export function mobilePerformanceGuardActive(): boolean {
  return !fxOverrideForcesFull() && mobileRuntimeActive();
}

export function getRenderDprCap(): number {
  // DPR is fixed at fit/resize time, so key it on the STATIC device guard, not
  // the runtime governor — flipping the backing-store resolution mid-run would
  // force a canvas resize and a visible reflow. Phones get the bounded DPR.
  return mobilePerformanceGuardActive() ? 1.5 : 2;
}

// ── Adaptive performance governor ────────────────────────────────────────────
//
// Capability-based, not device-based. UA/viewport sniffing (mobileRuntimeActive)
// is a guess — it punishes a fast tablet and misses a struggling old laptop on
// integrated graphics. The governor instead watches real frame time and flips a
// runtime "shed the expensive cheap-FX" flag on ANY device that can't hold rate.
//
// Scope is deliberately cheap-FX-only: it sheds shadowBlur glow and full-frame
// post-FX (the per-frame costs that scale with on-screen entity count), and
// NEVER touches the player's chosen mesh/vector art tiers. Runtime-only, never
// persisted. Hysteresis (different drop/raise thresholds) plus a change cooldown
// keep it from oscillating; the rolling window itself supplies the "sustained"
// requirement so a single GC stutter can't trip it.
const PERF_WINDOW = 90;             // frames sampled (~1.5s at 60Hz)
const PERF_DROP_MS = 22;            // a frame slower than this (~<45fps) is "slow"
const PERF_RAISE_MS = 13;           // a frame faster than this (~>75fps) is "fast"
const PERF_DROP_FRACTION = 0.2;     // ≥20% of the window slow → shed FX
const PERF_RAISE_FRACTION = 0.9;    // ≥90% of the window fast → restore FX
const PERF_CHANGE_COOLDOWN_MS = 3000; // min wall-time between state flips
const PERF_OUTLIER_MS = 500;        // ignore tab-restore / first-frame spikes

const perfFrames: number[] = [];    // ring of recent rAF deltas (ms)
let perfHead = 0;
let perfFilled = 0;
let perfSlowCount = 0;              // frames in window with dt > PERF_DROP_MS
let perfFastCount = 0;             // frames in window with dt < PERF_RAISE_MS
let perfMsSinceChange = PERF_CHANGE_COOLDOWN_MS; // allow an early first decision
let governorShedFx = false;        // the runtime decision the renderer reads

/** Feed one rAF frame delta to the governor. Called once per frame from the
 *  main loop. O(1) — maintains the slow/fast counts incrementally so there's no
 *  per-frame sort. */
export function recordFrameTime(ms: number): void {
  if (!(ms > 0) || ms > PERF_OUTLIER_MS) return; // drop spikes (backgrounded tab etc.)
  perfMsSinceChange += ms;
  // Evict the value leaving the window, fold in the new one.
  if (perfFilled === PERF_WINDOW) {
    const old = perfFrames[perfHead];
    if (old > PERF_DROP_MS) perfSlowCount--;
    if (old < PERF_RAISE_MS) perfFastCount--;
  } else {
    perfFilled++;
  }
  perfFrames[perfHead] = ms;
  if (ms > PERF_DROP_MS) perfSlowCount++;
  if (ms < PERF_RAISE_MS) perfFastCount++;
  perfHead = (perfHead + 1) % PERF_WINDOW;

  // Decide only on a full window and outside the cooldown.
  if (perfFilled < PERF_WINDOW || perfMsSinceChange < PERF_CHANGE_COOLDOWN_MS) return;
  const slowFrac = perfSlowCount / PERF_WINDOW;
  const fastFrac = perfFastCount / PERF_WINDOW;
  if (!governorShedFx && slowFrac >= PERF_DROP_FRACTION) {
    governorShedFx = true;
    perfMsSinceChange = 0;
    console.log(`[perf] sustained slow frames (${Math.round(slowFrac * 100)}% > ${PERF_DROP_MS}ms) — shedding expensive FX`);
  } else if (governorShedFx && fastFrac >= PERF_RAISE_FRACTION) {
    governorShedFx = false;
    perfMsSinceChange = 0;
    console.log(`[perf] frame budget recovered (${Math.round(fastFrac * 100)}% < ${PERF_RAISE_MS}ms) — restoring FX`);
  }
}

/** The unified "render in reduced-FX mode" decision used by the per-frame
 *  presentation paths (shadowBlur glow, post-FX theme). True when EITHER the
 *  static phone guard is active OR the runtime governor has shed FX on a
 *  device measuring as overloaded. The force-full URL flags veto both. */
export function reducedFxActive(): boolean {
  if (fxOverrideForcesFull()) return false;
  return mobileRuntimeActive() || governorShedFx;
}

function effectiveTier(cat: VisualCategory, tier: VisualTier): VisualTier {
  void cat;
  if (tier === 'mesh' && mobilePerformanceGuardActive() && !sanctumMeshAllowed()) return 'shaded';
  return tier;
}

function sanctumMeshAllowed(): boolean {
  try {
    return getFlavour() === '600bn' || getStoredMode() === 'sanctum' || isSanctumMode();
  } catch {
    return false;
  }
}

/** Coerce an unknown value into a known VisualTier; unknown → 'vector'. */
function coerceTier(v: unknown): VisualTier {
  if (v === 'vector' || v === 'shaded' || v === 'mesh') return v;
  return 'vector';
}

/** Coerce an unknown value into a valid ASCII column count; clamps to the
 *  supported range, unknown → the default. */
function coerceAsciiCols(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(ASCII_COLS.min, Math.min(ASCII_COLS.max, n)) : ASCII_COLS.default;
}

/** Coerce an unknown value into a valid bit-depth stop; unknown or
 *  off-grid → the default. */
function coerceBitDepth(v: unknown): number {
  const n = Math.round(Number(v));
  return (BIT_DEPTH.stops as readonly number[]).includes(n) ? n : BIT_DEPTH.default;
}

function coerceBrightness(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return BRIGHTNESS.default;
  const stepped = Math.round(n / BRIGHTNESS.step) * BRIGHTNESS.step;
  return Math.max(BRIGHTNESS.min, Math.min(BRIGHTNESS.max, stepped));
}

function load(): State {
  if (cached) return cached;
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      cached = {
        asteroid: coerceTier(parsed.asteroid ?? base.asteroid),
        ship: coerceTier(parsed.ship ?? base.ship),
        bullet: coerceTier(parsed.bullet ?? base.bullet),
        particle: coerceTier(parsed.particle ?? base.particle),
        theme: coerceThemeId(parsed.theme ?? base.theme),
        asciiCols: coerceAsciiCols(parsed.asciiCols ?? base.asciiCols),
        bitDepth: coerceBitDepth(parsed.bitDepth ?? base.bitDepth),
        bitColour: typeof parsed.bitColour === 'boolean' ? parsed.bitColour : base.bitColour,
        brightness: coerceBrightness(parsed.brightness ?? base.brightness),
      };
      return cached;
    }
  } catch { /* localStorage might be blocked — fall through to defaults */ }
  cached = base;
  return cached;
}

function save(s: State): void {
  cached = s;
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ }
  // Broadcast so live render code can react without re-reading every frame.
  // The settings panel listens for this to repaint button selection.
  try { window.dispatchEvent(new CustomEvent('pallasite:visualStyle')); } catch { /* ignore */ }
}

let forcedTier: VisualTier | null = null;

/** Force a single tier for the duration of one synchronous render()
 *  call. The watch live tiles use this to render in vector regardless
 *  of the player's saved preference: set it, call render(), clear it.
 *  Synchronous use only, so it never races other render() callers. */
export function setForcedVisualTier(tier: VisualTier | null): void {
  forcedTier = tier;
}

/** Read the effective tier for a category. Honours an active forced
 *  tier override (see setForcedVisualTier). Render code falls back to
 *  'shaded' if the WebGL overlay hasn't loaded yet. */
export function getVisualStyle(cat: VisualCategory): VisualTier {
  if (forcedTier) return forcedTier;
  return effectiveTier(cat, load()[cat]);
}

/** The raw stored tier, ignoring any forced override. Used by the
 *  settings UI so it reflects the player's real saved choice. */
export function getVisualStyleRaw(cat: VisualCategory): VisualTier {
  return load()[cat];
}

/** Set a category's tier. If the new tier is 'mesh', kick off the
 *  WebGL overlay dynamic-load so it's ready by the next frame (or one
 *  shortly after). Fire-and-forget — render code falls back to shaded
 *  while the load resolves. */
export function setVisualStyle(cat: VisualCategory, tier: VisualTier): void {
  const next = { ...load(), [cat]: tier };
  save(next);
  if (effectiveTier(cat, tier) === 'mesh') void warmWebGL();
}

/** Set every category to the same tier. Used by the quick-pick row in the
 *  settings panel. */
export function setAllVisualStyles(tier: VisualTier): void {
  save({ ...load(), asteroid: tier, ship: tier, bullet: tier, particle: tier });
  if (VISUAL_CATEGORIES.some((cat) => effectiveTier(cat, tier) === 'mesh')) void warmWebGL();
}

/** The active presentation theme: the post-process look (CRT etc.). A
 *  separate axis from the per-category fidelity tiers. Suppressed whenever
 *  reduced-FX is active — the phone guard OR the runtime governor on an
 *  overloaded device — since full-frame post-FX is one of the costs we shed. */
export function getTheme(): ThemeId {
  if (reducedFxActive()) return 'none';
  return load().theme;
}

/** Set the presentation theme. Persists and broadcasts like the tiers. */
export function setTheme(theme: ThemeId): void {
  save({ ...load(), theme });
}

/** The ASCII theme's character-grid resolution (column count). */
export function getAsciiCols(): number {
  return load().asciiCols;
}

/** Set the ASCII resolution. Clamped to the supported range; persists and
 *  broadcasts like the other visual prefs. */
export function setAsciiCols(cols: number): void {
  save({ ...load(), asciiCols: coerceAsciiCols(cols) });
}

/** The bit-depth theme's colour depth (bits per pixel). */
export function getBitDepth(): number {
  return load().bitDepth;
}

/** Set the bit-depth theme's colour depth. Snapped to a valid stop;
 *  persists and broadcasts like the other visual prefs. */
export function setBitDepth(depth: number): void {
  save({ ...load(), bitDepth: coerceBitDepth(depth) });
}

/** The bit-depth theme's palette mode — true colour, false greyscale. */
export function getBitColour(): boolean {
  return load().bitColour;
}

/** Set the bit-depth theme's palette mode. Persists and broadcasts. */
export function setBitColour(on: boolean): void {
  save({ ...load(), bitColour: on });
}

/** Canvas brightness multiplier. Applied as a compositor filter so the
 *  standard presentation stays cheap; the default 1.0 is visually neutral. */
export function getBrightness(): number {
  return load().brightness;
}

export function setBrightness(value: number): void {
  save({ ...load(), brightness: coerceBrightness(value) });
}

/** Boot-time warm-up: if any category is already on 'mesh' from a
 *  previous session, start the WebGL load immediately. Called from
 *  main.ts; safe to call repeatedly (the loader is idempotent). */
export function warmWebGLIfPreviouslyEnabled(): Promise<void> {
  const s = load();
  const anyMesh = VISUAL_CATEGORIES.some((cat) => effectiveTier(cat, s[cat]) === 'mesh');
  return anyMesh ? warmWebGL() : Promise.resolve();
}

export function ensureWebGLForCurrentStyle(): Promise<void> {
  return warmWebGLIfPreviouslyEnabled();
}

/** Sync accessors render.ts uses each frame. Resolve to no-ops until the
 *  dynamic-imported overlay module has finished loading. Keeps render.ts
 *  free of any static reference to webgl/overlay.ts, which lets Vite
 *  split three.js into its own chunk. */
export interface WebGLOverlayCall {
  asteroids: ReadonlyArray<Asteroid>;
  ufos: ReadonlyArray<Ufo>;
  powerups: ReadonlyArray<PowerUp>;
  /** Every live ship to render as a 3D mesh. Empty array = no meshes
   *  (the caller wants the 2D path, e.g. during an intertitle hold or
   *  with ship tier set to shaded/vector). Index in this array IS the
   *  player slot — the overlay caches per-slot mesh handles, so a slot
   *  that disappears from this array gets its mesh hidden, and a new
   *  slot rebuilds. */
  ships: ReadonlyArray<Ship | null | undefined>;
  /** Sim clock (ms) for time-based overlay effects such as the shield
   *  dome's expiry fade. Wall-clock would mismatch the sim-clock deadlines
   *  the gameplay state now carries (B3 determinism). */
  elapsed: number;
  dpr: number;
  scale: number;
  tx: number;
  ty: number;
  /** World dimensions represented by the camera projection. Defaults to
   *  the classic 1280x720 playfield; deathmatch passes its larger arena. */
  worldW?: number;
  worldH?: number;
  /** World-X seam offsets for the portrait follow camera. The overlay
   *  renders the scene once per entry so mesh entities wrap at the world
   *  edge. Absent (treated as [0]) outside portrait-follow. */
  wrapXs?: number[];
}
let overlayRenderFn: ((opts: WebGLOverlayCall) => void) | null = null;
let overlayShipExplosionFn: ((pos: { x: number; y: number }, vel: { x: number; y: number }, rot: number) => void) | null = null;
let overlayClearShipChunksFn: (() => void) | null = null;
let overlayPrewarmMeshesFn: (() => void) | null = null;
let overlayReady = false;
export function isWebGLOverlayReady(): boolean { return overlayReady; }
export function callWebGLOverlay(opts: WebGLOverlayCall): void {
  overlayRenderFn?.(opts);
}
/** Trigger the WebGL ship-mesh explosion. Safe to call even if the
 *  overlay hasn't loaded yet — silently no-ops. Callers should still
 *  gate on isWebGLOverlayReady() so the 2D-debris fallback runs when
 *  WebGL isn't available. */
export function callWebGLShipExplosion(pos: { x: number; y: number }, vel: { x: number; y: number }, rot: number): void {
  overlayShipExplosionFn?.(pos, vel, rot);
}
/** Drop any live ship-explosion chunks. Called when the final-life
 *  cleanup wipes particle/debris pools so the death replay starts
 *  from a clean overlay too. */
export function callWebGLClearShipChunks(): void {
  overlayClearShipChunksFn?.();
}

/** Compile the mesh overlay's expensive first-use material/geometry variants
 *  after the player has started a run. This keeps mobile boot quiet while
 *  moving UFO/station first-spawn hitches into the wave-start downtime. */
export async function prewarmWebGLMeshesForCurrentStyle(): Promise<void> {
  const s = load();
  const anyMesh = VISUAL_CATEGORIES.some((cat) => effectiveTier(cat, s[cat]) === 'mesh');
  if (!anyMesh) return;
  await warmWebGL();
  overlayPrewarmMeshesFn?.();
}

let warmPromise: Promise<void> | null = null;
async function warmWebGL(): Promise<void> {
  if (overlayReady) return;
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    try {
      const mod = await import('./webgl/overlay.js');
      await mod.ensureWebGLOverlay();
      overlayRenderFn = mod.renderOverlay;
      overlayShipExplosionFn = mod.spawnShipMeshExplosion;
      overlayClearShipChunksFn = mod.clearShipChunks;
      overlayPrewarmMeshesFn = mod.prewarmWebGLOverlayMeshes;
      overlayReady = true;
    } catch (e) {
      // If three.js fails to load (offline, sw bug, etc.), render code
      // keeps falling back to shaded — no game-breaking failure mode.
      console.warn('[visual-style] WebGL overlay load failed', e);
    } finally {
      if (!overlayReady) warmPromise = null;
    }
  })();
  return warmPromise;
}

/** True iff every category is set to the same tier — used by the quick-pick
 *  row to highlight which preset is active. */
export function visualStyleIsUniform(tier: VisualTier): boolean {
  const s = load();
  return s.asteroid === tier && s.ship === tier && s.bullet === tier && s.particle === tier;
}

/** True iff a visual-tier preference has been stored for this origin
 *  (vs. running on the flavour default). Lets a surface apply its own
 *  default without overriding a real player choice. */
export function hasStoredVisualStyle(): boolean {
  try { return localStorage.getItem(KEY) !== null; }
  catch { return false; }
}
