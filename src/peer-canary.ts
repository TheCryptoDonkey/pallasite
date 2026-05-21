/**
 * Desync canary for shared-arena multiplayer (M3 §6.1).
 *
 * Every PEER_HASH_PERIOD sim frames, both clients hash the gameplay-
 * relevant slice of GameState and send the result via peer.sendHash.
 * When the partner's hash for the same frame arrives, we compare. A
 * mismatch sets a sticky `peerDesyncFrame` we surface on the next
 * commit; v1 only observes, it does not resync.
 *
 * Hash choice matches the determinism harness intent (FNV1a-32 over a
 * JSON serialisation of position / velocity / score / RNG / etc.) but is
 * deliberately a fresh implementation so the harness stays the
 * load-bearing single source of truth for B3 determinism. If a
 * divergence here is ever spurious, we can tighten the slice without
 * risking the harness's PASS criterion.
 */

import type { GameState, PlayerState, Asteroid, Ufo, Bullet, Mine, Coin, PowerUp } from './types.js';
import { getRngState } from './seed.js';

/** Hash every N sim frames. 60 = once per second at fixed 60Hz. Keeps
 *  bandwidth trivial (one int per second per peer) and gives a useful
 *  upper bound on how stale a desync detection can be. */
export const PEER_HASH_PERIOD = 60;

export function fnv1a32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Two-player aware gameplay slice. Includes every player in turn so
 *  the canary works for couch + duel runs. Entities are summarised by
 *  position / velocity (plus identifying fields where they exist) so
 *  cosmetic pools (particles, debris) never feed the canary. */
export function serializeForCanary(s: GameState): string {
  const players = s.players.map((p: PlayerState) => [
    p.score, p.lives, p.sats, p.combo,
    p.ship.pos.x, p.ship.pos.y, p.ship.vel.x, p.ship.vel.y, p.ship.rot,
    p.ship.alive, p.ship.shieldUp, p.ship.shieldExpiresAt,
    p.ship.invulnerableUntil, p.ship.hyperspaceReadyAt, p.ship.hyperspaceCloakMs,
  ]);
  return JSON.stringify({
    f: s.frame, ph: s.phase, w: s.wave, el: s.elapsed, hs: s.hitStopSteps,
    rng: getRngState(),
    players,
    ast: s.asteroids.map((a: Asteroid) => [a.pos.x, a.pos.y, a.vel.x, a.vel.y, a.radius, a.id, a.hp]),
    ufo: s.ufos.map((u: Ufo) => [u.pos.x, u.pos.y, u.vel.x, u.vel.y, u.hp ?? 0]),
    bul: s.bullets.map((b: Bullet) => [b.pos.x, b.pos.y, b.vel.x, b.vel.y, b.owner]),
    ebul: s.enemyBullets.map((b: Bullet) => [b.pos.x, b.pos.y, b.vel.x, b.vel.y]),
    mine: s.mines.map((m: Mine) => [m.pos.x, m.pos.y]),
    coin: s.coins.map((c: Coin) => [c.pos.x, c.pos.y, c.vel ? c.vel.x : 0, c.vel ? c.vel.y : 0]),
    pow: s.powerups.map((p: PowerUp) => [p.pos.x, p.pos.y]),
  });
}

export function hashState(s: GameState): number {
  return fnv1a32(serializeForCanary(s));
}
