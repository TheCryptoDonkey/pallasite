/**
 * Per-category visual style preferences.
 *
 *   vector  — original 1979 line-art look: thin stroke, per-type glow, no fill.
 *   shaded  — modern lit look: gradient/photoreal fill, rim light, drop shadow.
 *   mesh    — full WebGL 3D meshes. NOT YET IMPLEMENTED. Falls back to shaded
 *             at render time so a stale localStorage value can't blank the
 *             game. Surfaced in the settings UI as "3D · SOON" (disabled).
 *
 * Four independent categories — asteroid, ship, bullet, particle — so a
 * player can mix-and-match (e.g. shaded asteroids on a vector ship). The
 * settings panel offers a quick-preset shortcut (ALL CLASSIC / ALL SHADED)
 * for the common case.
 *
 * Defaults vary by flavour: main game opens with everything VECTOR (matches
 * what returning players see), 600bn opens with everything SHADED (the
 * conference teaser is designed around the modern look).
 */

import { getFlavour } from './flavour.js';

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
  const tier: VisualTier = getFlavour() === '600bn' ? 'shaded' : 'vector';
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

/** Read the effective tier for a category. 'mesh' is downgraded to 'shaded'
 *  at the boundary so render code only ever has to handle two paths until
 *  the WebGL layer ships. */
export function getVisualStyle(cat: VisualCategory): Exclude<VisualTier, 'mesh'> {
  const t = load()[cat];
  return t === 'mesh' ? 'shaded' : t;
}

/** Read the raw stored tier (including 'mesh'). For the settings UI only —
 *  render code should use getVisualStyle which downgrades unimplemented
 *  tiers. */
export function getVisualStyleRaw(cat: VisualCategory): VisualTier {
  return load()[cat];
}

export function setVisualStyle(cat: VisualCategory, tier: VisualTier): void {
  const next = { ...load(), [cat]: tier };
  save(next);
}

/** Set every category to the same tier. Used by the quick-pick row in the
 *  settings panel. */
export function setAllVisualStyles(tier: VisualTier): void {
  save({ asteroid: tier, ship: tier, bullet: tier, particle: tier });
}

/** True iff every category is set to the same tier — used by the quick-pick
 *  row to highlight which preset is active. */
export function visualStyleIsUniform(tier: VisualTier): boolean {
  const s = load();
  return s.asteroid === tier && s.ship === tier && s.bullet === tier && s.particle === tier;
}
