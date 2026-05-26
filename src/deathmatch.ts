/**
 * Deathmatch arena geometry.
 *
 * This is intentionally separate from the existing shrinking Arena mode.
 * Deathmatch uses a large square, non-wrapping field so radar and cover matter,
 * and so future N-player netcode can reason about absolute positions.
 */

import { currentMode } from './mode.js';
import type { Vec2 } from './types.js';

export const DEATHMATCH_WORLD_W = 4096;
export const DEATHMATCH_WORLD_H = 4096;

export function deathmatchActive(): boolean {
  return currentMode() === 'deathmatch';
}

export function deathmatchWorldW(): number {
  return deathmatchActive() ? DEATHMATCH_WORLD_W : 1280;
}

export function deathmatchWorldH(): number {
  return deathmatchActive() ? DEATHMATCH_WORLD_H : 720;
}

export function deathmatchSpawnPoint(slot: number, total: number): { x: number; y: number; rot: number } {
  const cx = DEATHMATCH_WORLD_W / 2;
  const cy = DEATHMATCH_WORLD_H / 2;
  const ringCount = total <= 12 ? 1 : total <= 32 ? 2 : total <= 48 ? 3 : 4;
  const ring = slot % ringCount;
  const ordinal = Math.floor(slot / ringCount);
  const inRing = Math.ceil((Math.max(1, total) - ring) / ringCount);
  const radiusFactor = ringCount === 1 ? 0.38 : 0.22 + (0.25 * ring) / (ringCount - 1);
  const radius = Math.min(DEATHMATCH_WORLD_W, DEATHMATCH_WORLD_H) * radiusFactor;
  const angle = (ordinal / Math.max(1, inRing)) * Math.PI * 2 - Math.PI / 2 + ring * 0.37;
  const x = cx + Math.cos(angle) * radius;
  const y = cy + Math.sin(angle) * radius;
  return { x, y, rot: Math.atan2(cy - y, cx - x) };
}

export function confineToDeathmatch(pos: Vec2, vel: Vec2, radius: number, restitution = 0.45): boolean {
  let bounced = false;
  const minX = radius;
  const minY = radius;
  const maxX = DEATHMATCH_WORLD_W - radius;
  const maxY = DEATHMATCH_WORLD_H - radius;
  if (pos.x < minX) {
    pos.x = minX;
    if (vel.x < 0) { vel.x = -vel.x * restitution; bounced = true; }
  } else if (pos.x > maxX) {
    pos.x = maxX;
    if (vel.x > 0) { vel.x = -vel.x * restitution; bounced = true; }
  }
  if (pos.y < minY) {
    pos.y = minY;
    if (vel.y < 0) { vel.y = -vel.y * restitution; bounced = true; }
  } else if (pos.y > maxY) {
    pos.y = maxY;
    if (vel.y > 0) { vel.y = -vel.y * restitution; bounced = true; }
  }
  return bounced;
}

export function outsideDeathmatch(pos: Vec2, radius: number): boolean {
  return pos.x < -radius || pos.x > DEATHMATCH_WORLD_W + radius
    || pos.y < -radius || pos.y > DEATHMATCH_WORLD_H + radius;
}
