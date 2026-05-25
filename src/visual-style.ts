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
}

function defaults(): State {
  // Every fresh player opens in full 3D mesh with a CRT scanline pass.
  // The WebGL overlay is the headline visual feature, and the CRT theme
  // is the house presentation — anyone who actively wants the original
  // 1979 line-art look can flip categories to vector and theme to
  // standard from the settings panel; their choice persists. Pre-existing
  // players keep whatever they had stored — load() only reaches defaults()
  // when no value is in localStorage.
  return {
    asteroid: 'mesh',
    ship: 'mesh',
    bullet: 'mesh',
    particle: 'mesh',
    theme: 'crt',
    asciiCols: ASCII_COLS.default,
    bitDepth: BIT_DEPTH.default,
    bitColour: false,
  };
}

let cached: State | null = null;

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
  return forcedTier ?? load()[cat];
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
  if (tier === 'mesh') void warmWebGL();
}

/** Set every category to the same tier. Used by the quick-pick row in the
 *  settings panel. */
export function setAllVisualStyles(tier: VisualTier): void {
  save({ ...load(), asteroid: tier, ship: tier, bullet: tier, particle: tier });
  if (tier === 'mesh') void warmWebGL();
}

/** The active presentation theme: the post-process look (CRT etc.). A
 *  separate axis from the per-category fidelity tiers. */
export function getTheme(): ThemeId {
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

/** Boot-time warm-up: if any category is already on 'mesh' from a
 *  previous session, start the WebGL load immediately. Called from
 *  main.ts; safe to call repeatedly (the loader is idempotent). */
export function warmWebGLIfPreviouslyEnabled(): void {
  const s = load();
  const anyMesh = s.asteroid === 'mesh' || s.ship === 'mesh' || s.bullet === 'mesh' || s.particle === 'mesh';
  if (anyMesh) void warmWebGL();
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
  ships: ReadonlyArray<Ship>;
  /** Sim clock (ms) for time-based overlay effects such as the shield
   *  dome's expiry fade. Wall-clock would mismatch the sim-clock deadlines
   *  the gameplay state now carries (B3 determinism). */
  elapsed: number;
  dpr: number;
  scale: number;
  tx: number;
  ty: number;
  /** World-X seam offsets for the portrait follow camera. The overlay
   *  renders the scene once per entry so mesh entities wrap at the world
   *  edge. Absent (treated as [0]) outside portrait-follow. */
  wrapXs?: number[];
}
let overlayRenderFn: ((opts: WebGLOverlayCall) => void) | null = null;
let overlayShipExplosionFn: ((pos: { x: number; y: number }, vel: { x: number; y: number }, rot: number) => void) | null = null;
let overlayClearShipChunksFn: (() => void) | null = null;
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

let warmStarted = false;
async function warmWebGL(): Promise<void> {
  if (warmStarted) return;
  warmStarted = true;
  try {
    const mod = await import('./webgl/overlay.js');
    await mod.ensureWebGLOverlay();
    overlayRenderFn = mod.renderOverlay;
    overlayShipExplosionFn = mod.spawnShipMeshExplosion;
    overlayClearShipChunksFn = mod.clearShipChunks;
    overlayReady = true;
  } catch (e) {
    // If three.js fails to load (offline, sw bug, etc.), render code
    // keeps falling back to shaded — no game-breaking failure mode.
    console.warn('[visual-style] WebGL overlay load failed', e);
    warmStarted = false;
  }
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
