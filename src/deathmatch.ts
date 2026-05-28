/**
 * Deathmatch arena geometry.
 *
 * This is intentionally separate from the existing shrinking Arena mode.
 * Deathmatch uses a large square, non-wrapping field so radar and cover matter,
 * and so future N-player netcode can reason about absolute positions.
 */

import { currentMode } from './mode.js';
import { currentDifficulty, type Difficulty } from './difficulty.js';
import type { DeathmatchRules, Vec2 } from './types.js';

export const DEATHMATCH_WORLD_W = 4096;
export const DEATHMATCH_WORLD_H = 4096;
export const DEATHMATCH_DEFAULT_TIME_LIMIT_MS = 3 * 60 * 1000;
const DEATHMATCH_MIN_WORLD = 2560;
const DEATHMATCH_MAX_WORLD = 12288;

let activeDeathmatchWorld = { w: DEATHMATCH_WORLD_W, h: DEATHMATCH_WORLD_H };

function clampNumber(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

export function defaultDeathmatchKillLimit(players: number): number {
  const count = Math.max(2, Math.min(64, Math.floor(players)));
  return Math.min(100, Math.max(12, Math.ceil(count * 1.25)));
}

export function defaultDeathmatchRespawns(players: number): number {
  const count = Math.max(2, Math.min(64, Math.floor(players)));
  return Math.min(14, Math.max(5, Math.ceil(count / 8) + 4));
}

export function defaultDeathmatchAiSkill(difficulty: Difficulty = currentDifficulty()): number {
  switch (difficulty) {
    case 'easy': return 0.38;
    case 'hard': return 1.20;
    case 'normal':
    default: return 0.88;
  }
}

export function makeDeathmatchRules(players: number, overrides: Partial<DeathmatchRules> = {}): DeathmatchRules {
  const timeLimitMs = Math.floor(clampNumber(
    overrides.timeLimitMs ?? DEATHMATCH_DEFAULT_TIME_LIMIT_MS,
    0,
    30 * 60 * 1000,
  ));
  const killLimit = Math.floor(clampNumber(
    overrides.killLimit ?? defaultDeathmatchKillLimit(players),
    0,
    250,
  ));
  const respawns = Math.floor(clampNumber(
    overrides.respawns ?? defaultDeathmatchRespawns(players),
    0,
    99,
  ));
  const aiSkill = clampNumber(overrides.aiSkill ?? defaultDeathmatchAiSkill(), 0.30, 2.0);
  return { mode: 'ffa', timeLimitMs, killLimit, respawns, aiSkill };
}

export function deathmatchActive(): boolean {
  return currentMode() === 'deathmatch';
}

function roundToArenaStep(v: number): number {
  return Math.round(v / 256) * 256;
}

export function deathmatchArenaSize(players: number): { w: number; h: number } {
  const count = Math.max(2, Math.min(64, Math.floor(players)));
  const side = roundToArenaStep(clampNumber(
    DEATHMATCH_MIN_WORLD * Math.sqrt(count / 2),
    DEATHMATCH_MIN_WORLD,
    DEATHMATCH_MAX_WORLD,
  ));
  return { w: side, h: side };
}

export function configureDeathmatchWorld(players: number): void {
  activeDeathmatchWorld = deathmatchArenaSize(players);
}

export function deathmatchWorldW(): number {
  return deathmatchActive() ? activeDeathmatchWorld.w : 1280;
}

export function deathmatchWorldH(): number {
  return deathmatchActive() ? activeDeathmatchWorld.h : 720;
}

function clampSpawn(v: number, max: number): number {
  const margin = 340;
  return Math.max(margin, Math.min(max - margin, v));
}

export function deathmatchSpawnPoint(slot: number, total: number, variant = 0): { x: number; y: number; rot: number } {
  const arena = deathmatchArenaSize(total);
  const cx = arena.w / 2;
  const cy = arena.h / 2;
  const ringCount = total <= 8 ? 1 : total <= 24 ? 2 : total <= 48 ? 3 : 4;
  const ring = slot % ringCount;
  const ordinal = Math.floor(slot / ringCount);
  const inRing = Math.ceil((Math.max(1, total) - ring) / ringCount);
  const radiusFactor = ringCount === 1 ? 0.40 : 0.23 + (0.25 * ring) / (ringCount - 1);
  const radius = Math.min(arena.w, arena.h) * radiusFactor;
  const alternate = variant > 0 ? Math.floor((variant + 1) / 2) : 0;
  const side = variant % 2 === 0 ? -1 : 1;
  const angleOffset = variant === 0 ? 0 : side * (0.22 + alternate * 0.11);
  const radiusScale = variant === 0 ? 1 : 1 - Math.min(0.20, alternate * 0.045);
  const angle = (ordinal / Math.max(1, inRing)) * Math.PI * 2 - Math.PI / 2 + ring * 0.37 + angleOffset;
  const x = clampSpawn(cx + Math.cos(angle) * radius * radiusScale, arena.w);
  const y = clampSpawn(cy + Math.sin(angle) * radius * radiusScale, arena.h);
  return { x, y, rot: Math.atan2(cy - y, cx - x) };
}

export function confineToDeathmatch(pos: Vec2, vel: Vec2, radius: number, restitution = 0.45): boolean {
  let bounced = false;
  const minX = radius;
  const minY = radius;
  const maxX = activeDeathmatchWorld.w - radius;
  const maxY = activeDeathmatchWorld.h - radius;
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
  return pos.x < -radius || pos.x > activeDeathmatchWorld.w + radius
    || pos.y < -radius || pos.y > activeDeathmatchWorld.h + radius;
}
