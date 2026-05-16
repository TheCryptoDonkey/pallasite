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

import { getFlavour } from './flavour.js';
import type { Asteroid, PowerUp, Ship, Ufo } from './types.js';

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
}

function defaults(): State {
  // 600bn opens in full 3D — the Sanctum is the showcase, and the WebGL
  // overlay is the headline feature. Players on weak devices downshift
  // themselves via the settings panel (Player agency over defaults).
  const tier: VisualTier = getFlavour() === '600bn' ? 'mesh' : 'vector';
  return { asteroid: tier, ship: tier, bullet: tier, particle: tier };
}

let cached: State | null = null;

/** Coerce an unknown value into a known VisualTier; unknown → 'vector'. */
function coerceTier(v: unknown): VisualTier {
  if (v === 'vector' || v === 'shaded' || v === 'mesh') return v;
  return 'vector';
}

function load(): State {
  if (cached) return cached;
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<VisualCategory, unknown>>;
      cached = {
        asteroid: coerceTier(parsed.asteroid ?? base.asteroid),
        ship: coerceTier(parsed.ship ?? base.ship),
        bullet: coerceTier(parsed.bullet ?? base.bullet),
        particle: coerceTier(parsed.particle ?? base.particle),
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

/** Read the effective tier for a category. Returns the raw stored value
 *  including 'mesh'. Render code is responsible for falling back to
 *  'shaded' if the WebGL overlay hasn't loaded yet (call
 *  getReadyOverlay() and downgrade locally). */
export function getVisualStyle(cat: VisualCategory): VisualTier {
  return load()[cat];
}

/** Alias retained for the settings UI / clarity at call sites. */
export const getVisualStyleRaw = getVisualStyle;

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
  save({ asteroid: tier, ship: tier, bullet: tier, particle: tier });
  if (tier === 'mesh') void warmWebGL();
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
  ship: Ship | null;
  dpr: number;
  scale: number;
  tx: number;
  ty: number;
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
