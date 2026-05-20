/**
 * Watch-theatre render adapter.
 *
 * The live theatre receives compact LiveFrame wire snapshots, not a
 * GameState; the shared render() in render.ts draws a GameState. This
 * module synthesises a GameState from an interpolated pair of LiveFrames
 * so the theatre drives render() directly and inherits the game's
 * vector / shaded / mesh fidelity, instead of the separate hand-rolled
 * 2D renderer that froze at the vector era.
 *
 * Positions are emitted in WORLD coordinates; the theatre canvas carries
 * the world->device transform, exactly like the game's retro render mode.
 */

import { makeInitialState } from './game.js';
import { WORLD_W, WORLD_H, bossPhaseForHp } from './types.js';
import type {
  GameState, Asteroid, AsteroidSize, AsteroidType, Ufo, UfoType,
  Mine, Bullet, Coin, PowerUp, PowerUpType, Particle, Debris,
} from './types.js';
import type {
  LiveFrame, LiveAsteroid, LiveUfo, LiveMine, LiveCoin, LivePowerup,
} from './ui.js';

const TAU = Math.PI * 2;

const ASTEROID_SIZE: Record<LiveAsteroid['size'], AsteroidSize> = {
  l: 'large', m: 'medium', s: 'small',
};
/** Mirrors game.ts RADIUS_PER_SIZE. */
const ASTEROID_RADIUS: Record<LiveAsteroid['size'], number> = {
  l: 48, m: 26, s: 14,
};
const ASTEROID_TYPE: Record<LiveAsteroid['type'], AsteroidType> = {
  s: 'stony', i: 'iron', c: 'chondrite', p: 'pallasite',
};
/** Mirrors game.ts UFO_RADIUS. */
const UFO_RADIUS: Record<LiveUfo['type'], number> = {
  s: 22, c: 22, p: 14, t: 30, e: 12, b: 50,
};
const UFO_TYPE: Record<LiveUfo['type'], UfoType> = {
  s: 'cruiser', c: 'cruiser', e: 'elite', t: 'tank', p: 'sniper', b: 'boss',
};
const COIN_SOURCE: Record<'s' | 'i' | 'c' | 'p', AsteroidType> = {
  s: 'stony', i: 'iron', c: 'chondrite', p: 'pallasite',
};
const POWERUP_TYPE: Record<LivePowerup['type'], PowerUpType> = {
  r: 'rapid', b: 'satboost', n: 'nova', t: 'trident', m: 'magnet',
};

/** Deterministic lumpy outline seeded by entity id — the wire carries no
 *  vertex data, so the silhouette is reconstructed from the id and stays
 *  stable frame to frame. Matches the game's asteroid look (8-10 sides,
 *  0.82-1.14 radius wobble) closely enough to read as identical at a
 *  spectator's distance. */
const shapeCache = new Map<number, number[]>();
function asteroidShape(id: number): number[] {
  const hit = shapeCache.get(id);
  if (hit) return hit;
  let s = (id * 2654435761) >>> 0;
  const rnd = (): number => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  const sides = 8 + Math.floor(rnd() * 3);
  const shape: number[] = [];
  for (let i = 0; i < sides; i++) shape.push(0.82 + rnd() * 0.32);
  shapeCache.set(id, shape);
  return shape;
}

/** Stable per-id hue offset (0..100) so neighbouring asteroids of one
 *  type don't flat-shade identically — matches Asteroid.hue. */
function asteroidHue(id: number): number {
  let h = (id * 2654435761) >>> 0;
  h = (h * 1664525 + 1013904223) >>> 0;
  return (h / 0x100000000) * 100;
}

/** Short-way-around position interp — a delta past half the world span
 *  means the entity wrapped, so snap to `b` rather than streak across. */
function interpAxis(a: number, b: number, k: number, span: number): number {
  const d = b - a;
  if (Math.abs(d) > span * 0.5) return b;
  return a + d * k;
}
function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a;
  while (d > Math.PI) d -= TAU;
  while (d < -Math.PI) d += TAU;
  return a + d * k;
}

export interface TheatreFrameArgs {
  /** Frame at or before the playhead. */
  prev: LiveFrame;
  /** Frame at or after the playhead. */
  next: LiveFrame;
  /** Interpolation fraction prev->next, 0..1. */
  t: number;
  /** Playback clock in the player's capturedAt time-base (ms). */
  playbackT: number;
  /** Viewer-side cosmetic particles, already in game shape. */
  particles: Particle[];
  /** Viewer-side cosmetic debris, already in game shape. */
  debris: Debris[];
}

/** One persistent synthetic GameState, created when the theatre opens
 *  and mutated each frame by populateTheatreState. */
export function createTheatreState(): GameState {
  const gs = makeInitialState();
  gs.phase = 'playing';
  return gs;
}

/** Rewrite `gs` in place from an interpolated LiveFrame pair so the
 *  shared render() can draw the spectated run. */
export function populateTheatreState(gs: GameState, args: TheatreFrameArgs): void {
  const { prev, next, t, playbackT, particles, debris } = args;
  const blink = performance.now() * 0.001;

  // Ship pose — interpolated; all game-logic timers zeroed so render()
  // draws a clean, solid ship (no invuln flicker, no warp cloak).
  const ship = gs.players[0].ship;
  ship.pos.x = interpAxis(prev.x, next.x, t, WORLD_W);
  ship.pos.y = interpAxis(prev.y, next.y, t, WORLD_H);
  ship.vel.x = 0;
  ship.vel.y = 0;
  ship.rot = lerpAngle(prev.r, next.r, t);
  ship.rotVel = 0;
  ship.radius = 14;
  ship.alive = t < 0.5 ? prev.alive : next.alive;
  ship.thrusting = t < 0.5 ? prev.thrust : next.thrust;
  ship.shieldUp = t < 0.5 ? prev.shielded : next.shielded;
  // render()'s drawShield fades the dome over its final 300ms via
  // (shieldExpiresAt - now). The wire carries only a boolean, so park the
  // expiry well ahead while shielded so the dome paints at full opacity.
  ship.shieldExpiresAt = ship.shieldUp ? performance.now() + 1000 : 0;
  ship.invulnerableUntil = 0;
  ship.hyperspaceCloakMs = 0;
  ship.hyperspaceMalfunction = false;
  ship.recoilOffset = 0;
  ship.shieldHitFlash = 0;

  // Asteroids — interpolate each next-frame asteroid from its prev twin.
  const prevAst = new Map<number, LiveAsteroid>();
  for (const a of prev.asteroids) prevAst.set(a.id, a);
  gs.asteroids = next.asteroids.map((a): Asteroid => {
    const p = prevAst.get(a.id) ?? a;
    return {
      pos: { x: interpAxis(p.x, a.x, t, WORLD_W), y: interpAxis(p.y, a.y, t, WORLD_H) },
      vel: { x: 0, y: 0 },
      radius: ASTEROID_RADIUS[a.size],
      alive: true,
      id: a.id,
      size: ASTEROID_SIZE[a.size],
      type: ASTEROID_TYPE[a.type],
      depth: 3,
      hp: 1,
      hpMax: 1,
      hitFlash: 0,
      rot: lerpAngle(p.rot, a.rot, t),
      rotVel: 0,
      shape: asteroidShape(a.id),
      hue: asteroidHue(a.id),
      isVein: false,
    };
  });

  // UFOs — facing derived from interpolated motion, like the player saw.
  const prevUfo = new Map<number, LiveUfo>();
  for (const u of prev.ufos) prevUfo.set(u.id, u);
  gs.ufos = next.ufos.map((u): Ufo => {
    const p = prevUfo.get(u.id) ?? u;
    const dx = u.x - p.x;
    return {
      pos: { x: interpAxis(p.x, u.x, t, WORLD_W), y: interpAxis(p.y, u.y, t, WORLD_H) },
      vel: { x: dx, y: u.y - p.y },
      radius: UFO_RADIUS[u.type],
      alive: true,
      id: u.id,
      type: UFO_TYPE[u.type],
      hp: u.hp,
      dir: dx < -0.01 ? -1 : 1,
      zigTimer: 0,
      shootTimer: 0,
      lifetime: 9999,
      blink,
      hitFlash: 0,
      bossPhase: bossPhaseForHp(u.hp),
    };
  });

  // Mines.
  const prevMine = new Map<number, LiveMine>();
  for (const m of prev.mines) prevMine.set(m.id, m);
  gs.mines = next.mines.map((m): Mine => {
    const p = prevMine.get(m.id) ?? m;
    return {
      pos: { x: interpAxis(p.x, m.x, t, WORLD_W), y: interpAxis(p.y, m.y, t, WORLD_H) },
      vel: { x: 0, y: 0 },
      radius: 11,
      alive: true,
      id: m.id,
      age: performance.now(),
      gravityRange: 80,
      hp: 3,
      hitFlash: 0,
    };
  });

  // Bullets — extrapolated forward from `next` using wire velocity, so a
  // shot stays in motion between the sparse wire frames. A bullet that
  // only appears in `next` (spawned mid-pair) is held until the playhead
  // actually reaches it, else it draws flying backwards out of the ship.
  const prevBullet = new Set<number>();
  for (const b of prev.bullets) prevBullet.add(b.id);
  const extSec = (playbackT - next.capturedAt) / 1000;
  const playerBullets: Bullet[] = [];
  const enemyBullets: Bullet[] = [];
  for (const b of next.bullets) {
    if (!prevBullet.has(b.id) && extSec < 0) continue;
    let x = b.x + b.vx * extSec;
    let y = b.y + b.vy * extSec;
    x = ((x % WORLD_W) + WORLD_W) % WORLD_W;
    y = ((y % WORLD_H) + WORLD_H) % WORLD_H;
    const bullet: Bullet = {
      pos: { x, y },
      vel: { x: b.vx, y: b.vy },
      radius: 2.5,
      alive: true,
      id: b.id,
      ttl: 9999,
      pierceLeft: 0,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
      owner: b.enemy ? -1 : 0,
    };
    (b.enemy ? enemyBullets : playerBullets).push(bullet);
  }
  gs.bullets = playerBullets;
  gs.enemyBullets = enemyBullets;

  // Coins.
  const prevCoin = new Map<number, LiveCoin>();
  for (const c of prev.coins) prevCoin.set(c.id, c);
  gs.coins = next.coins.map((c): Coin => {
    const p = prevCoin.get(c.id) ?? c;
    return {
      pos: { x: interpAxis(p.x, c.x, t, WORLD_W), y: interpAxis(p.y, c.y, t, WORLD_H) },
      vel: { x: 0, y: 0 },
      radius: 6,
      alive: true,
      id: c.id,
      ttl: 9999,
      collected: false,
      kind: c.kind === 's' ? 'sat' : 'dust',
      value: 0,
      sourceType: c.sourceType === '' ? undefined : COIN_SOURCE[c.sourceType],
    };
  });

  // Powerups.
  const prevPow = new Map<number, LivePowerup>();
  for (const p of prev.powerups) prevPow.set(p.id, p);
  gs.powerups = next.powerups.map((pu): PowerUp => {
    const p = prevPow.get(pu.id) ?? pu;
    return {
      pos: { x: interpAxis(p.x, pu.x, t, WORLD_W), y: interpAxis(p.y, pu.y, t, WORLD_H) },
      vel: { x: 0, y: 0 },
      radius: 16,
      alive: true,
      id: pu.id,
      type: POWERUP_TYPE[pu.type],
      ttl: 9999,
      collected: false,
    };
  });

  // Viewer-side cosmetic layers — already game-shaped, passed straight.
  gs.particles = particles;
  gs.debris = debris;

  // HUD numbers — drive render()'s on-canvas SCORE / WAVE / LIVES and the
  // per-wave background. `prev` is the frame at the playhead (in live mode
  // the playhead is pinned to the newest frame, so prev is the latest).
  gs.players[0].score = prev.score;
  gs.players[0].sats = prev.sats;
  gs.players[0].displaySats = prev.sats;
  gs.wave = Math.max(1, prev.wave);
  gs.players[0].lives = prev.lives;

  // No simulation state on a spectated run — keep render() free of shake,
  // combo tint and stale powerup chips.
  gs.cameraTrauma = 0;
  gs.players[0].combo = 0;
}
