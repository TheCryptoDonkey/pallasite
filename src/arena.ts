/**
 * Arena run mode geometry: the breathing, shrinking oval cage.
 *
 * Arena replaces the toroidal world wrap with an elliptical wall that
 * bounces entities off it. The ellipse steadily shrinks across a run and
 * also "breathes" (a slow pulse that tightens past the baseline and
 * relaxes back), so the cage feels alive and never gives ground. The
 * geometry is a pure function of run time (s.runTimeMs, which advances
 * only while phase==='playing' and resets each run), so it holds no state
 * of its own and re-simulates bit-identically for B3 verifiable replay.
 *
 * All arena behaviour is gated on currentMode()==='arena', locked in at
 * startGame. Campaign and drift runs never reach this code.
 */

import { WORLD_W, WORLD_H } from './types.js';
import type { Vec2 } from './types.js';
import { currentMode } from './mode.js';

/** Shrink fraction at run start: a small inset so the cage reads as a cage
 *  from the first frame. */
const K_MIN = 0.05;
/** Shrink fraction the baseline creep reaches at full collapse. */
const K_MAX = 0.52;
/** Playing-time in ms over which the baseline creeps from K_MIN to K_MAX. */
const SHRINK_MS = 240_000;
/** Peak extra contraction from the breath, layered on the baseline. */
const BREATH_AMP = 0.045;
/** One full breathe-in-and-out cycle, in ms. Slow and ominous. */
const BREATH_MS = 7_000;

/** A resolved arena cage: an axis-aligned ellipse centred on the world. */
export interface ArenaCage {
  cx: number; cy: number;
  rx: number; ry: number;
}

/** True when the active, locked-in run mode is arena. */
export function arenaActive(): boolean {
  return currentMode() === 'arena';
}

/** Shrink fraction k at a given playing-time: the monotonic baseline creep
 *  plus the breathing pulse. The breath uses 1-cos so it sits entirely on
 *  the contracting side (0 at rest), meaning the cage only ever pulses
 *  tighter and relaxes back to the baseline, never looser. */
export function arenaShrink(runTimeMs: number): number {
  const base = K_MIN + (K_MAX - K_MIN) * Math.min(1, Math.max(0, runTimeMs / SHRINK_MS));
  const breath = BREATH_AMP * (1 - Math.cos((runTimeMs / BREATH_MS) * Math.PI * 2)) / 2;
  return Math.min(0.6, base + breath);
}

/** The arena cage (ellipse, world coords) for a given playing-time. The
 *  ellipse is inscribed in the shrunk world rect, so it keeps the 16:9
 *  proportion and stays centred on the world centre, which means a ship
 *  respawn at WORLD_W/2, WORLD_H/2 always lands inside it. */
export function arenaCage(runTimeMs: number): ArenaCage {
  const k = arenaShrink(runTimeMs);
  return {
    cx: WORLD_W / 2,
    cy: WORLD_H / 2,
    rx: (WORLD_W / 2) * (1 - k),
    ry: (WORLD_H / 2) * (1 - k),
  };
}

/** Reflect a moving entity off the elliptical cage wall, mutating pos and
 *  vel in place. The entity centre is kept within the cage inset by its
 *  radius; a velocity component heading out through the wall is reversed
 *  and scaled by restitution, the tangential component is preserved. A
 *  shrinking wall overtaking a slow entity just pushes it inward, since
 *  the velocity reflection only fires when the entity is moving outward.
 *  Returns true on a genuine bounce (velocity reflected) — the kinetic
 *  asteroid keys off this to ratchet up its speed. */
export function confineToArena(
  pos: Vec2, vel: Vec2, radius: number, cage: ArenaCage, restitution: number,
): boolean {
  const a = Math.max(1, cage.rx - radius);
  const b = Math.max(1, cage.ry - radius);
  const dx = pos.x - cage.cx;
  const dy = pos.y - cage.cy;
  const norm = (dx * dx) / (a * a) + (dy * dy) / (b * b);
  if (norm <= 1) return false;
  // Push the centre back onto the inner ellipse along its radial line.
  const scale = 1 / Math.sqrt(norm);
  pos.x = cage.cx + dx * scale;
  pos.y = cage.cy + dy * scale;
  // Outward normal of (X/a)^2+(Y/b)^2=1 is proportional to (X/a^2, Y/b^2).
  let nx = (pos.x - cage.cx) / (a * a);
  let ny = (pos.y - cage.cy) / (b * b);
  const nlen = Math.hypot(nx, ny) || 1;
  nx /= nlen; ny /= nlen;
  const vn = vel.x * nx + vel.y * ny;
  if (vn > 0) {
    const k = (1 + restitution) * vn;
    vel.x -= k * nx;
    vel.y -= k * ny;
    return true;
  }
  return false;
}

/** Clamp a static entity's position inside the cage. Used for mines, which
 *  have no velocity, so the shrinking wall just carries them inward. */
export function clampToArena(pos: Vec2, radius: number, cage: ArenaCage): void {
  const a = Math.max(1, cage.rx - radius);
  const b = Math.max(1, cage.ry - radius);
  const dx = pos.x - cage.cx;
  const dy = pos.y - cage.cy;
  const norm = (dx * dx) / (a * a) + (dy * dy) / (b * b);
  if (norm <= 1) return;
  const scale = 1 / Math.sqrt(norm);
  pos.x = cage.cx + dx * scale;
  pos.y = cage.cy + dy * scale;
}

/** True when a point lies beyond the cage wall (by more than radius). Used
 *  to expire bullets at the wall, since arena has no wrap-around. */
export function outsideArena(pos: Vec2, radius: number, cage: ArenaCage): boolean {
  const a = cage.rx + radius;
  const b = cage.ry + radius;
  const dx = pos.x - cage.cx;
  const dy = pos.y - cage.cy;
  return (dx * dx) / (a * a) + (dy * dy) / (b * b) > 1;
}
