/**
 * Arena run mode geometry: the shrinking hard-walled cage.
 *
 * Arena replaces the toroidal world wrap with a box that bounces entities
 * off its walls, and that box steadily shrinks across a run. The box is a
 * pure function of run time (s.runTimeMs, which advances only while
 * phase==='playing' and resets each run), so it holds no state of its own
 * and re-simulates bit-identically for B3 verifiable replay.
 *
 * All arena behaviour is gated on currentMode()==='arena', which is locked
 * in at startGame. Campaign and drift runs never reach this code.
 */

import { WORLD_W, WORLD_H } from './types.js';
import type { Vec2 } from './types.js';
import { currentMode } from './mode.js';

/** Shrink fraction at run start. A small inset so the cage reads as a cage
 *  from the first frame rather than sitting flush on the world edge. */
const K_MIN = 0.05;
/** Shrink fraction at full collapse. The box is (1 - K_MAX) of the world on
 *  each axis, so 0.52 leaves a brutal 614 x 346 cage. */
const K_MAX = 0.52;
/** Playing-time in ms over which the box creeps from K_MIN to K_MAX. */
const SHRINK_MS = 240_000;

/** A resolved arena box in world coordinates. */
export interface ArenaBox {
  l: number; r: number; t: number; b: number;
  w: number; h: number; cx: number; cy: number;
}

/** True when the active, locked-in run mode is arena. */
export function arenaActive(): boolean {
  return currentMode() === 'arena';
}

/** Shrink fraction k for a given playing-time, clamped to [K_MIN, K_MAX]. */
export function arenaShrink(runTimeMs: number): number {
  const t = Math.max(0, Math.min(1, runTimeMs / SHRINK_MS));
  return K_MIN + (K_MAX - K_MIN) * t;
}

/** The arena box (world coords) for a given playing-time. The box always
 *  stays centred on the world centre, so a ship respawn at WORLD_W/2,
 *  WORLD_H/2 lands inside it without any special handling. */
export function arenaBox(runTimeMs: number): ArenaBox {
  const k = arenaShrink(runTimeMs);
  const w = WORLD_W * (1 - k);
  const h = WORLD_H * (1 - k);
  const l = (WORLD_W - w) / 2;
  const t = (WORLD_H - h) / 2;
  return { l, r: l + w, t, b: t + h, w, h, cx: WORLD_W / 2, cy: WORLD_H / 2 };
}

/** Reflect a moving entity off the arena walls, mutating pos and vel in
 *  place. The position is clamped inside the box (inset by the entity
 *  radius) and any velocity component heading into a crossed wall is
 *  flipped and scaled by restitution. This also handles a shrinking wall
 *  overtaking a slow entity: the clamp carries it inward, while the
 *  velocity flip only fires when the entity was genuinely moving into the
 *  wall, so the squeeze never adds energy. */
export function confineToArena(
  pos: Vec2, vel: Vec2, radius: number, box: ArenaBox, restitution: number,
): void {
  const minX = box.l + radius, maxX = box.r - radius;
  const minY = box.t + radius, maxY = box.b - radius;
  if (pos.x < minX) { pos.x = minX; if (vel.x < 0) vel.x = -vel.x * restitution; }
  else if (pos.x > maxX) { pos.x = maxX; if (vel.x > 0) vel.x = -vel.x * restitution; }
  if (pos.y < minY) { pos.y = minY; if (vel.y < 0) vel.y = -vel.y * restitution; }
  else if (pos.y > maxY) { pos.y = maxY; if (vel.y > 0) vel.y = -vel.y * restitution; }
}

/** Clamp a static entity's position inside the arena box. Used for mines,
 *  which have no velocity, so the shrinking wall just carries them inward. */
export function clampToArena(pos: Vec2, radius: number, box: ArenaBox): void {
  pos.x = Math.max(box.l + radius, Math.min(box.r - radius, pos.x));
  pos.y = Math.max(box.t + radius, Math.min(box.b - radius, pos.y));
}

/** True when a point lies beyond the arena box by more than radius. Used to
 *  expire bullets at the wall, since arena has no wrap-around. */
export function outsideArena(pos: Vec2, radius: number, box: ArenaBox): boolean {
  return pos.x < box.l - radius || pos.x > box.r + radius
      || pos.y < box.t - radius || pos.y > box.b + radius;
}
