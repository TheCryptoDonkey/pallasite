import type { AsteroidType, GameState, Particle } from './types.js';

// Cosmetic state stays outside the simulation, snapshots and gameplay RNG.
export interface RockImpact {
  time: number; x: number; y: number; vx: number; vy: number;
  nx: number; ny: number; speed: number;
  type: AsteroidType; otherType?: AsteroidType;
  kind?: 'break'; radius?: number;
}
const impacts = new WeakMap<GameState, RockImpact[]>();
const rockParticles = new WeakSet<Particle>();
export const ROCK_DUST_LIFETIME_MS = 1800;
/** The Ultra dust replaces these legacy lights without changing simulation particles. */
export function markRockDustParticles(s: GameState, start: number): void {
  for (let i = start; i < s.particles.length; i++) rockParticles.add(s.particles[i]);
}
export function isRockDustParticle(p: Particle): boolean { return rockParticles.has(p); }
export const levelOneReview = typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('graphicsReview') === '1';

export function recordRockImpact(s: GameState, impact: Omit<RockImpact, 'time'>): void {
  if (impact.speed < 12) return;
  const list = liveRockImpacts(s);
  // A contact burst is bounded even when many fragments meet in one tick.
  if (list.length >= 12) list.shift();
  list.push({ ...impact, time: s.elapsed });
  impacts.set(s, list);
}

export function liveRockImpacts(s: GameState): RockImpact[] {
  const list = impacts.get(s) ?? [];
  const alive = list.filter(i => s.elapsed >= i.time && s.elapsed - i.time < ROCK_DUST_LIFETIME_MS);
  impacts.set(s, alive);
  return alive;
}

export function resetRockImpacts(s: GameState): void { impacts.delete(s); }
