/**
 * 600bn Sanctum — game-loop integration.
 *
 * Self-contained alternate game loop driven when state.phase === 'sanctum'.
 * Duplicates the ship + bullet input/physics from game.ts (rather than
 * weaving phase guards through it) so the main-game updateGame stays
 * completely untouched — when running on the 'main' flavour, this module
 * never executes a line.
 *
 * Lazy-imported from game.ts so main-game bundle pays nothing extra.
 *
 * Lifecycle:
 *   - startSanctumRun()   ←  called from startGame() when flavour=600bn
 *   - updateSanctumLoop() ←  called from updateGame() while phase=sanctum
 *   - endSanctumRun()     ←  fired internally when the 240s timer expires
 *                            OR Bullbear is defeated; transitions to gameover.
 *
 * Collision model is circle-on-circle for everything — the Sanctum has
 * no slim/lumpy entities; every member, stone, racoo, bullbear, meteor
 * has a well-defined radius.
 */

import {
  WORLD_W, WORLD_H,
  SHIP_THRUST, SHIP_DRAG, SHIP_ROT_ACCEL, SHIP_ROT_DAMPING, SHIP_MAX_ROT,
  FIRE_COOLDOWN_MS,
  type GameState,
} from './types.js';
import {
  createSanctumState,
  tickSanctum,
  applyMemberHit,
  applyStoneHit,
  applyRacooHit,
  applyBullbearHit,
  applyMeteorHit,
  isSanctumComplete,
} from './sanctum.js';
import { fireBullet } from './game.js';
import { maybePreloadCouncil } from './sanctum-avatars.js';
import * as audio from './audio.js';

/** Last fire timestamp — module-local so back-to-back PLAY taps don't
 *  carry over a stale cooldown from a previous run. Reset in startSanctumRun. */
let lastFireAt = 0;

/** Score bumps per entity class — matches the in-canon ranking. Sat
 *  drops are returned by the applyXxxHit helpers in sanctum.ts; these
 *  are pure points for the leaderboard. */
const SCORE_MEMBER = 100;
const SCORE_METEOR = 25;
const SCORE_RACOO = 600;
const SCORE_STONE_SHATTER = 2_100;
const SCORE_BULLBEAR = 4_200;

/** Initialise a Sanctum run. Wipes standard-game entity arrays, builds
 *  a fresh SanctumState, recentres the ship, grants intro invulnerability. */
export function startSanctumRun(s: GameState, now: number): void {
  s.phase = 'sanctum';
  s.phaseStart = now;
  s.runStartedAt = now;
  s.runTimeMs = 0;

  // Clear any lingering standard-game entities so they don't bleed in.
  s.asteroids.length = 0;
  s.ufos.length = 0;
  s.mines.length = 0;
  s.coins.length = 0;
  s.powerups.length = 0;
  s.bullets.length = 0;
  s.enemyBullets.length = 0;
  s.particles.length = 0;
  s.debris.length = 0;

  // Fresh sanctum state.
  s.sanctum = createSanctumState(now);

  // Run-level counters.
  const p0 = s.players[0];
  p0.score = 0;
  p0.sats = 0;
  p0.displaySats = 0;
  p0.lives = 1;     // single-life sanctum — death ends the run early
  s.wave = 0;
  s.missedShotsThisWave = 0;

  // Ship centre-low, pointing up, with 3s intro grace.
  p0.ship.pos.x = WORLD_W / 2;
  p0.ship.pos.y = WORLD_H * 0.72;
  p0.ship.vel.x = 0;
  p0.ship.vel.y = 0;
  p0.ship.rot = -Math.PI / 2;
  p0.ship.rotVel = 0;
  p0.ship.alive = true;
  p0.ship.invulnerableUntil = now + 3_000;
  p0.ship.thrusting = false;
  p0.ship.hyperspaceCloakMs = 0;
  p0.ship.shieldUp = false;

  lastFireAt = 0;

  // Avatars preloaded if not already.
  maybePreloadCouncil();
}

/** Same wrap function game.ts uses — duplicated rather than exported
 *  to keep the surgery on the main file zero. */
function wrap(p: { x: number; y: number }, margin = 0): void {
  if (p.x < -margin) p.x = WORLD_W + margin;
  else if (p.x > WORLD_W + margin) p.x = -margin;
  if (p.y < -margin) p.y = WORLD_H + margin;
  else if (p.y > WORLD_H + margin) p.y = -margin;
}

function hitTest(x1: number, y1: number, r1: number, x2: number, y2: number, r2: number): boolean {
  const dx = x1 - x2;
  const dy = y1 - y2;
  const rr = r1 + r2;
  return dx * dx + dy * dy < rr * rr;
}

/** Per-frame sanctum tick. Handles ship input, bullet motion, sanctum
 *  entity tick, all collisions, end-of-run detection. */
export function updateSanctumLoop(s: GameState, dt: number, now: number): void {
  if (!s.sanctum) return;
  const p0 = s.players[0];
  s.elapsed += dt * 1000;
  s.runTimeMs += dt * 1000;

  // ── Ship input ──
  const turnLeft = p0.keys['ArrowLeft'] || p0.keys['KeyA'];
  const turnRight = p0.keys['ArrowRight'] || p0.keys['KeyD'];
  const thrust = (p0.keys['ArrowUp'] || p0.keys['KeyW']) || p0.thrustOverride;
  const fire = p0.keys['Space'];

  if (p0.ship.alive) {
    if (p0.targetHeading !== null) {
      // Joystick heading-mode (touch).
      const HEADING_LERP_RATE = 8;
      let diff = p0.targetHeading - p0.ship.rot;
      while (diff > Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const step = HEADING_LERP_RATE * dt;
      if (Math.abs(diff) <= step) {
        p0.ship.rot = p0.targetHeading;
        p0.ship.rotVel = 0;
      } else {
        p0.ship.rot += Math.sign(diff) * step;
        p0.ship.rotVel = Math.sign(diff) * HEADING_LERP_RATE;
      }
    } else {
      if (turnLeft) p0.ship.rotVel -= SHIP_ROT_ACCEL * dt;
      if (turnRight) p0.ship.rotVel += SHIP_ROT_ACCEL * dt;
      if (!turnLeft && !turnRight) {
        const sign = Math.sign(p0.ship.rotVel);
        const newVel = p0.ship.rotVel - sign * SHIP_ROT_DAMPING * dt;
        p0.ship.rotVel = Math.sign(newVel) === sign ? newVel : 0;
      }
      p0.ship.rotVel = Math.max(-SHIP_MAX_ROT, Math.min(SHIP_MAX_ROT, p0.ship.rotVel));
      p0.ship.rot += p0.ship.rotVel * dt;
    }

    p0.ship.thrusting = thrust;
    if (thrust) {
      p0.ship.thrustFrame += dt * 30;
      p0.ship.vel.x += Math.cos(p0.ship.rot) * SHIP_THRUST * dt;
      p0.ship.vel.y += Math.sin(p0.ship.rot) * SHIP_THRUST * dt;
      audio.thrustOn();
    } else {
      audio.thrustOff();
    }

    const dragK = Math.exp(-SHIP_DRAG * dt);
    p0.ship.vel.x *= dragK;
    p0.ship.vel.y *= dragK;
    p0.ship.pos.x += p0.ship.vel.x * dt;
    p0.ship.pos.y += p0.ship.vel.y * dt;
    wrap(p0.ship.pos);

    if (p0.ship.recoilOffset > 0) {
      p0.ship.recoilOffset = Math.max(0, p0.ship.recoilOffset - dt * 24);
    }

    if (fire && now >= lastFireAt + FIRE_COOLDOWN_MS) {
      fireBullet(s);
      lastFireAt = now;
    }
  }

  // ── Bullet motion + wrap ──
  for (const b of s.bullets) {
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.ttl -= dt * 1000;
    if (b.ttl <= 0) {
      b.alive = false;
    } else {
      wrap(b.pos);
    }
  }
  s.bullets = s.bullets.filter((b) => b.alive);

  // ── Sanctum entity tick ──
  tickSanctum(s.sanctum, dt * 1000);

  // ── Collisions: bullets × sanctum entities ──
  for (const b of s.bullets) {
    if (!b.alive || b.hasLanded) {
      // Already used this bullet — sanctum has no carom, one entity per shot.
      continue;
    }

    // Bullbear (highest priority — boss).
    const bb = s.sanctum.bullbear;
    if (bb && hitTest(b.pos.x, b.pos.y, b.radius, bb.x, bb.y, bb.r)) {
      const drop = applyBullbearHit(bb);
      b.alive = false;
      b.hasLanded = true;
      if (drop > 0) {
        s.sanctum.satsEarned += drop;
        p0.sats += drop;
        p0.score += SCORE_BULLBEAR;
        audio.explosion(0.6);
      } else {
        audio.hit();
      }
      continue;
    }

    // racooDNI cameo.
    const racoo = s.sanctum.racoo;
    if (racoo && hitTest(b.pos.x, b.pos.y, b.radius, racoo.x, racoo.y, racoo.r)) {
      const drop = applyRacooHit(racoo);
      b.alive = false;
      b.hasLanded = true;
      if (drop > 0) {
        s.sanctum.satsEarned += drop;
        p0.sats += drop;
        p0.score += SCORE_RACOO;
        audio.coinPickup();
      }
      continue;
    }

    // Council members.
    let hitCouncil = false;
    for (const m of s.sanctum.council) {
      if (m.dead) continue;
      if (hitTest(b.pos.x, b.pos.y, b.radius, m.x, m.y, m.r)) {
        const drop = applyMemberHit(m, s.sanctum);
        b.alive = false;
        b.hasLanded = true;
        hitCouncil = true;
        if (drop > 0) {
          s.sanctum.satsEarned += drop;
          p0.sats += drop;
          p0.score += SCORE_MEMBER;
          audio.explosion(0.6);
        } else {
          audio.hit();
        }
        break;
      }
    }
    if (hitCouncil) continue;

    // Sacred Stone.
    const stone = s.sanctum.stone;
    if (stone && !stone.shattering && hitTest(b.pos.x, b.pos.y, b.radius, stone.x, stone.y, stone.r)) {
      const drop = applyStoneHit(s.sanctum);
      b.alive = false;
      b.hasLanded = true;
      if (drop > 0) {
        s.sanctum.satsEarned += drop;
        p0.sats += drop;
        p0.score += SCORE_STONE_SHATTER;
        audio.explosion(1.4);
      } else {
        audio.hit();
      }
      continue;
    }

    // Ember meteors.
    for (const m of s.sanctum.meteors) {
      if (m.hp <= 0) continue;
      if (hitTest(b.pos.x, b.pos.y, b.radius, m.x, m.y, m.r)) {
        applyMeteorHit(m);
        b.alive = false;
        b.hasLanded = true;
        p0.score += SCORE_METEOR;
        audio.hit();
        break;
      }
    }
  }
  s.bullets = s.bullets.filter((b) => b.alive);

  // ── Ship × sanctum entity (body collisions = death) ──
  if (p0.ship.alive && now >= p0.ship.invulnerableUntil) {
    const sx = p0.ship.pos.x;
    const sy = p0.ship.pos.y;
    const sr = p0.ship.radius;
    let lethal = false;
    for (const m of s.sanctum.council) {
      if (m.dead) continue;
      if (hitTest(sx, sy, sr, m.x, m.y, m.r)) { lethal = true; break; }
    }
    if (!lethal && s.sanctum.stone && !s.sanctum.stone.shattering &&
        hitTest(sx, sy, sr, s.sanctum.stone.x, s.sanctum.stone.y, s.sanctum.stone.r)) {
      lethal = true;
    }
    if (!lethal && s.sanctum.bullbear &&
        hitTest(sx, sy, sr, s.sanctum.bullbear.x, s.sanctum.bullbear.y, s.sanctum.bullbear.r)) {
      lethal = true;
    }
    if (!lethal) {
      for (const m of s.sanctum.meteors) {
        if (m.hp <= 0) continue;
        if (hitTest(sx, sy, sr, m.x, m.y, m.r)) { lethal = true; break; }
      }
    }
    if (lethal) {
      p0.ship.alive = false;
      audio.explosion(2.0);
      // End the run; the game-over hand-off uses the same gateway as
      // the main game so the claim picker fires normally.
      endSanctumRun(s, now);
      return;
    }
  }

  // ── End condition: timer expired or Bullbear defeated ──
  if (isSanctumComplete(s.sanctum)) {
    endSanctumRun(s, now);
  }
}

/** Transition the Sanctum run to gameover. Sets the phase + freezes the
 *  in-game-counter values; the existing game-over UI flow (sat claim
 *  picker + leaderboard publish) then takes over via the standard
 *  renderGameOver path. */
export function endSanctumRun(s: GameState, now: number): void {
  s.phase = 'gameover';
  s.phaseStart = now;
  // Score + sats already accumulated in updateSanctumLoop; the claim
  // helper reads s.score + s.sats directly. Leave s.sanctum intact so
  // the game-over render can surface the run summary if it wants to.
  audio.thrustOff();
}
