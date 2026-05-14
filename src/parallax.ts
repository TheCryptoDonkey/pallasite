/**
 * Parallax depth setting.
 *
 *   off       — every asteroid lives on the gameplay plane (depth 3).
 *                Matches pre-parallax behaviour exactly.
 *   subtle    — a handful of decorative asteroids drift in the background
 *                and foreground each wave. Mild alpha/size variation.
 *   dramatic  — more decorative spawns + stronger depth cues.
 *                Best with WebGL mesh + a good GPU.
 *
 * Collision behaviour is independent of this setting — gameplay-plane
 * asteroids always bounce off each other elastically. Parallax controls
 * only the decorative non-collide layers.
 */

import { getFlavour } from './flavour.js';

export type ParallaxTier = 'off' | 'subtle' | 'dramatic';

const KEY = 'pallasite:parallax';

function defaultTier(): ParallaxTier {
  // 600bn flavour defaults to dramatic — the Sanctum benefits from a
  // richer sense of depth. Main campaign defaults to subtle so returning
  // players get a tasteful enhancement without a jarring change.
  return getFlavour() === '600bn' ? 'dramatic' : 'subtle';
}

let cached: ParallaxTier | null = null;

function coerce(v: unknown): ParallaxTier {
  if (v === 'off' || v === 'subtle' || v === 'dramatic') return v;
  return defaultTier();
}

export function getParallaxTier(): ParallaxTier {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw ? coerce(raw) : defaultTier();
  } catch {
    cached = defaultTier();
  }
  return cached;
}

export function setParallaxTier(tier: ParallaxTier): void {
  cached = tier;
  try { localStorage.setItem(KEY, tier); } catch { /* ignore */ }
  try { window.dispatchEvent(new CustomEvent('pallasite:parallax')); } catch { /* ignore */ }
}

/** Visual + spawn tuning per depth band. Depth 3 is the gameplay
 *  plane — everything else is decorative. sizeMul/speedMul/alphaMul
 *  scale the entity at spawn; collide gates the per-frame bounce. */
export interface DepthConfig {
  /** Multiplier on the depth-3 spawn radius. */
  sizeMul: number;
  /** Multiplier on the depth-3 spawn velocity. */
  speedMul: number;
  /** Render alpha so non-3 bands fade gracefully into the backdrop. */
  alphaMul: number;
  /** Z offset in the WebGL scene — back layers go to negative Z,
   *  front layers to positive Z, so three.js paints them in order. */
  meshZ: number;
  /** True iff asteroids on this band collide with each other. Only
   *  depth 3 (gameplay plane) collides today. */
  collide: boolean;
}

export const DEPTH_CONFIGS: Record<number, DepthConfig> = {
  // Backgrounds fade into the void — translucent reads as "distant".
  1: { sizeMul: 0.35, speedMul: 0.25, alphaMul: 0.40, meshZ: -80, collide: false },
  2: { sizeMul: 0.65, speedMul: 0.55, alphaMul: 0.70, meshZ: -40, collide: false },
  // Gameplay plane — fully opaque.
  3: { sizeMul: 1.00, speedMul: 1.00, alphaMul: 1.00, meshZ:   0, collide: true  },
  // Foregrounds are CLOSER to the camera, not "out of focus" — they
  // should occlude whatever's behind them. Keep alpha at 1.0 so a
  // foreground rock properly hides a gameplay-plane rock it's in front
  // of, rather than showing the other rock through itself.
  4: { sizeMul: 1.40, speedMul: 1.35, alphaMul: 1.00, meshZ:  40, collide: false },
  5: { sizeMul: 1.85, speedMul: 1.70, alphaMul: 1.00, meshZ:  80, collide: false },
};

/** Decorative-asteroid spawn count per wave, by tier. */
export function decorativeSpawnCount(tier: ParallaxTier): number {
  if (tier === 'off') return 0;
  if (tier === 'subtle') return 4;
  return 8;
}

/** Pick a depth for a decorative spawn. Weighted so deepest/farthest
 *  bands are rarer (they read as distant). */
export function pickDecorativeDepth(rng: () => number): number {
  const r = rng();
  if (r < 0.30) return 1;  // 30% far back
  if (r < 0.55) return 2;  // 25% mid back
  if (r < 0.80) return 4;  // 25% mid front
  return 5;                 // 20% far front
}
