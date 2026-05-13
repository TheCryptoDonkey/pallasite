/**
 * 600bn Sanctum — 240s single-level teaser at 600b.pallasite.app.
 *
 * Five timed phases of escalating energy across a four-minute window,
 * keyed off the 600bn lore canon (Madeira / council / racooDNI / Bullbear /
 * sacred number). Council never empties: members respawn ~10s after each
 * kill so the ring stays populated. Sacred Stone wakes mid-run and can
 * shatter multiple times.
 *
 *   00:00 - 00:30  INVOCATION   council orbits slow, the-cult bed soft
 *   00:30 - 01:30  ASCENDANT    ember meteors drift in, council faster
 *   01:30 - 02:30  RITUAL       racooDNI cameo (canonical 04:20 GMT GM moment)
 *   02:30 - 03:30  INFERNO      Sacred Stone wakes, meteors thicken
 *   03:30 - 04:00  FINALE       Bullbear charges from the dark
 *   04:00          COMPLETE     run ends, FUCHS2 card on game-over
 *
 * Lazy-imported when getFlavour() === '600bn' so main-game users ship
 * none of this. Pure simulation + render helpers; the game loop drives
 * collision + scoring + game-over hand-off externally.
 *
 * Sat scale (1 / 2 / 6 / 21 tier, scaled down from 6/21/60/600):
 *   council member kill   →  1 sat
 *   ember meteor kill     →  0 sats  (score only — keeps the float bounded)
 *   racooDNI cameo hit    →  6 sats
 *   Sacred Stone shatter  → 21 sats per shatter
 *   Bullbear defeat       → 21 sats
 *
 * Theoretical max per perfect run ~60 sats; £500 float ≈ 7-10k runs.
 */

import { drawAvatarAsteroid, getCouncil, type ReadonlyMember } from './sanctum-avatars.js';

// ── World + timing constants ─────────────────────────────────────────

/** World dimensions the entities are sized against. Matches the main
 *  game's playfield so existing collision/wrap utilities work without
 *  conversion. */
export const SANCTUM_WORLD_W = 1280;
export const SANCTUM_WORLD_H = 720;

/** Total run length. 240s = 4 minutes. */
export const SANCTUM_TOTAL_MS = 240_000;

/** Phase boundaries in ms-from-start. Picked so the energy ramps in
 *  five legible movements rather than a flat blast.
 *  Adjust here to retune the arc; everything downstream is timer-driven. */
export const PHASE_BOUNDS = {
  invocation: 0,
  ascendant: 30_000,
  ritual: 90_000,
  inferno: 150_000,
  finale: 210_000,
  complete: SANCTUM_TOTAL_MS,
} as const;

export type SanctumPhase = keyof typeof PHASE_BOUNDS;


// ── Sat drop denominations ───────────────────────────────────────────

/** 1 sat per council member kill (matches the 6/21/60 numerology
 *  scaled down × 6). */
export const DROP_MEMBER = 1;
/** Ember meteors don't pay sats — pure score reward so the conference
 *  float doesn't get drained by filler entities. */
export const DROP_METEOR = 0;
/** racooDNI cameo: small 6-sat burst, single hit (Racoo has 1 HP). */
export const DROP_RACOO = 6;
/** Sacred Stone shatter — the headline payout. Each shatter drops the
 *  full 21 sats; multiple shatters in a run compound. */
export const DROP_STONE = 21;
/** Bullbear defeat — boss-tier match for the Stone. */
export const DROP_BULLBEAR = 21;

// ── Council tuning ───────────────────────────────────────────────────

export const SANCTUM_RING_RADIUS = 260;
export const SANCTUM_MEMBER_RADIUS = 42;
/** Council orbit speed (rad/s). Two values — slow during invocation,
 *  ramps up during ascendant phase for energy. */
export const ORBIT_SPEED_BASE = 0.18;
export const ORBIT_SPEED_RAMP = 0.42;
/** Member HP. Two hits feels punchy without dragging out the kill. */
export const SANCTUM_MEMBER_HP = 2;
/** Respawn delay after a member is killed. Keeps the ring populated. */
export const MEMBER_RESPAWN_MS = 9_000;

// ── Sacred Stone tuning ──────────────────────────────────────────────

export const SANCTUM_STONE_RADIUS = 60;
/** Stones get tougher each shatter — escalation. 1st shatter is
 *  satisfying-quick; 3rd needs commitment. After 3 shatters no more
 *  Stones spawn. */
export const STONE_HP_PROGRESSION = [10, 16, 24] as const;
/** Max Stones in a run. */
export const STONE_MAX_SHATTERS = STONE_HP_PROGRESSION.length;
/** Stone wakes here (in ms from start) regardless of council state.
 *  Mid-INFERNO so the player has two heat sources at once. */
export const STONE_WAKE_AT_MS = PHASE_BOUNDS.inferno;
/** Stone respawn delay after each shatter. */
export const STONE_RESPAWN_MS = 3_000;

// ── Ember meteor tuning ──────────────────────────────────────────────

export const METEOR_RADIUS_RANGE = [16, 32] as const;
export const METEOR_SPEED_RANGE = [50, 140] as const;       // px/s
/** Spawn cadence varies by phase — none during invocation, then ramps. */
export const METEOR_SPAWN_MS_BY_PHASE: Record<SanctumPhase, number> = {
  invocation: Infinity,
  ascendant: 2_500,
  ritual: 1_800,
  inferno: 1_100,
  finale: 700,
  complete: Infinity,
};
/** Max simultaneous meteors so frame-rate stays sane on phones. */
export const METEOR_CAP = 14;

// ── racooDNI cameo tuning ────────────────────────────────────────────

/** Cameo window — appears at start of RITUAL phase, leaves ~30s later. */
export const RACOO_APPEAR_AT_MS = PHASE_BOUNDS.ritual;
export const RACOO_DURATION_MS = 30_000;
export const RACOO_RADIUS = 36;
/** Scuttle speed across the screen edges. */
export const RACOO_SPEED = 110;

// ── Bullbear tuning ──────────────────────────────────────────────────

/** Bullbear enters at the start of FINALE for the last 30 seconds. */
export const BULLBEAR_APPEAR_AT_MS = PHASE_BOUNDS.finale;
export const BULLBEAR_RADIUS = 80;
export const BULLBEAR_HP = 8;
/** Charge speed across the screen (px/s). */
export const BULLBEAR_CHARGE_SPEED = 340;

// ── Entity types ─────────────────────────────────────────────────────

export interface SanctumCouncilAsteroid {
  x: number;
  y: number;
  r: number;
  rot: number;
  rotVel: number;
  hp: number;
  hpMax: number;
  orbitAngle: number;
  ringSlot: number;
  member: ReadonlyMember;
  hitFlash: number;
  bannerTtl: number;
  /** True between death and respawn. The level loop sweeps these out
   *  on phase transitions; respawn flips this back to false when the
   *  respawnAt timer elapses. */
  dead: boolean;
  /** performance.now() at which this slot becomes spawnable again.
   *  Zero when not pending. */
  respawnAt: number;
}

export interface SanctumSacredStone {
  x: number;
  y: number;
  r: number;
  rot: number;
  hp: number;
  hpMax: number;
  awake: boolean;
  /** Index into STONE_HP_PROGRESSION — also doubles as "which shatter
   *  this is" (0 = first, 1 = second, 2 = third). */
  shatterIndex: number;
  pulse: number;
  hitFlash: number;
  /** True after the current Stone shatters, while we wait STONE_RESPAWN_MS
   *  before spawning the next deeper Stone. The renderer fades the
   *  shattered Stone out during this window. */
  shattering: boolean;
  /** performance.now() at which the next Stone spawns (or 0 if no more). */
  respawnAt: number;
}

export interface SanctumRacoo {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rot: number;
  /** Cameo timer — racoo despawns when this hits zero. */
  ttl: number;
  /** 1 HP — single hit ends the cameo with a 6-sat burst. */
  hp: number;
  hitFlash: number;
  /** "GM" banner flashes on first appearance, fades. */
  bannerTtl: number;
}

export interface SanctumBullbear {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hp: number;
  hpMax: number;
  /** Each charge sweeps the screen from one edge to the other.
   *  Direction flips when an edge is hit. */
  chargeDir: 1 | -1;
  hitFlash: number;
  /** Crackle phase 0..1 for the orange-lightning trail. */
  crackle: number;
}

export interface SanctumMeteor {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  rot: number;
  rotVel: number;
  hp: number;
  hitFlash: number;
  /** Random hue offset for visual variety in the ember palette. */
  hueOffset: number;
}

// ── State + construction ─────────────────────────────────────────────

export interface SanctumState {
  council: SanctumCouncilAsteroid[];
  stone: SanctumSacredStone | null;
  racoo: SanctumRacoo | null;
  bullbear: SanctumBullbear | null;
  meteors: SanctumMeteor[];
  /** Cumulative sats earned across the run — sent to the faucet on
   *  game-over hand-off. */
  satsEarned: number;
  /** Cumulative score — pure points, no float impact. Member kill = 100,
   *  meteor = 25, racoo = 600, Stone shatter = 2100, Bullbear = 4200. */
  score: number;
  /** Run start in performance.now() ms. */
  startedAt: number;
  /** Current phase, recomputed each tick from elapsedMs. */
  phase: SanctumPhase;
  /** Count of Stone shatters so far this run (caps at STONE_MAX_SHATTERS). */
  stoneShatters: number;
  /** Set true once Bullbear has been defeated so the level loop can
   *  end-on-victory rather than wait out the timer. */
  bullbearDefeated: boolean;
  /** Last meteor spawn time (performance.now()) so the spawn cadence
   *  honours METEOR_SPAWN_MS_BY_PHASE per phase. */
  lastMeteorSpawnAt: number;
  /** Set true exactly once when racooDNI first appears so the GM
   *  banner doesn't re-fire on subsequent ticks. */
  racooSpawned: boolean;
  /** Set true exactly once when Bullbear first appears. */
  bullbearSpawned: boolean;
}

/** Build a fresh Sanctum state with council spawned, all other entities
 *  null/empty. Stone is null until STONE_WAKE_AT_MS. */
export function createSanctumState(now: number = performance.now()): SanctumState {
  return {
    council: spawnCouncil(now),
    stone: null,
    racoo: null,
    bullbear: null,
    meteors: [],
    satsEarned: 0,
    score: 0,
    startedAt: now,
    phase: 'invocation',
    stoneShatters: 0,
    bullbearDefeated: false,
    lastMeteorSpawnAt: now,
    racooSpawned: false,
    bullbearSpawned: false,
  };
}

/** Spawn the council in a ring around the world centre. Each member
 *  gets a fixed slot so the visual order matches the canonical roster:
 *  CEO at 12 o'clock, then walking clockwise. */
export function spawnCouncil(now: number): SanctumCouncilAsteroid[] {
  const members = getCouncil();
  const out: SanctumCouncilAsteroid[] = [];
  const cx = SANCTUM_WORLD_W / 2;
  const cy = SANCTUM_WORLD_H / 2;
  const n = members.length;
  if (n === 0) return out;
  for (let i = 0; i < n; i++) {
    const orbitAngle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push({
      x: cx + Math.cos(orbitAngle) * SANCTUM_RING_RADIUS,
      y: cy + Math.sin(orbitAngle) * SANCTUM_RING_RADIUS,
      r: SANCTUM_MEMBER_RADIUS,
      rot: (i * 137.5) * (Math.PI / 180),
      rotVel: 0.0009 + (i % 3) * 0.0002,
      hp: SANCTUM_MEMBER_HP,
      hpMax: SANCTUM_MEMBER_HP,
      orbitAngle,
      ringSlot: i,
      member: members[i],
      hitFlash: 0,
      bannerTtl: 0,
      dead: false,
      respawnAt: 0,
    });
  }
  void now;
  return out;
}

function spawnSacredStone(shatterIndex: number): SanctumSacredStone {
  const hp = STONE_HP_PROGRESSION[Math.min(shatterIndex, STONE_HP_PROGRESSION.length - 1)];
  return {
    x: SANCTUM_WORLD_W / 2,
    y: SANCTUM_WORLD_H / 2,
    r: SANCTUM_STONE_RADIUS,
    rot: 0,
    hp,
    hpMax: hp,
    awake: true,
    shatterIndex,
    pulse: 0,
    hitFlash: 0,
    shattering: false,
    respawnAt: 0,
  };
}

function spawnRacoo(now: number): SanctumRacoo {
  // Scuttles in from the left edge horizontally then bounces around.
  return {
    x: -RACOO_RADIUS,
    y: SANCTUM_WORLD_H * 0.5,
    vx: RACOO_SPEED,
    vy: (Math.random() - 0.5) * RACOO_SPEED * 0.6,
    r: RACOO_RADIUS,
    rot: 0,
    ttl: RACOO_DURATION_MS,
    hp: 1,
    hitFlash: 0,
    bannerTtl: 3_000,
  };
  void now;
}

function spawnBullbear(): SanctumBullbear {
  return {
    x: -BULLBEAR_RADIUS,
    y: SANCTUM_WORLD_H * 0.5,
    vx: BULLBEAR_CHARGE_SPEED,
    vy: 0,
    r: BULLBEAR_RADIUS,
    hp: BULLBEAR_HP,
    hpMax: BULLBEAR_HP,
    chargeDir: 1,
    hitFlash: 0,
    crackle: 0,
  };
}

function spawnMeteor(): SanctumMeteor {
  // Pick an edge then a perpendicular drift direction so meteors arc
  // diagonally across the playfield rather than going straight through.
  const edge = Math.floor(Math.random() * 4);
  const r = METEOR_RADIUS_RANGE[0] + Math.random() * (METEOR_RADIUS_RANGE[1] - METEOR_RADIUS_RANGE[0]);
  const speed = METEOR_SPEED_RANGE[0] + Math.random() * (METEOR_SPEED_RANGE[1] - METEOR_SPEED_RANGE[0]);
  let x = 0, y = 0, vx = 0, vy = 0;
  if (edge === 0) {        // top → drift down-right
    x = Math.random() * SANCTUM_WORLD_W;
    y = -r;
    vx = (Math.random() - 0.5) * speed * 0.6;
    vy = speed;
  } else if (edge === 1) { // right → drift down-left
    x = SANCTUM_WORLD_W + r;
    y = Math.random() * SANCTUM_WORLD_H;
    vx = -speed;
    vy = (Math.random() - 0.5) * speed * 0.6;
  } else if (edge === 2) { // bottom → drift up-right
    x = Math.random() * SANCTUM_WORLD_W;
    y = SANCTUM_WORLD_H + r;
    vx = (Math.random() - 0.5) * speed * 0.6;
    vy = -speed;
  } else {                 // left → drift up-right
    x = -r;
    y = Math.random() * SANCTUM_WORLD_H;
    vx = speed;
    vy = (Math.random() - 0.5) * speed * 0.6;
  }
  return {
    x, y, vx, vy, r,
    rot: Math.random() * Math.PI * 2,
    rotVel: (Math.random() - 0.5) * 0.003,
    hp: 1,
    hitFlash: 0,
    hueOffset: Math.random() * 30 - 15,
  };
}

// ── Phase resolution ─────────────────────────────────────────────────

function phaseFor(elapsedMs: number): SanctumPhase {
  if (elapsedMs >= PHASE_BOUNDS.complete) return 'complete';
  if (elapsedMs >= PHASE_BOUNDS.finale)   return 'finale';
  if (elapsedMs >= PHASE_BOUNDS.inferno)  return 'inferno';
  if (elapsedMs >= PHASE_BOUNDS.ritual)   return 'ritual';
  if (elapsedMs >= PHASE_BOUNDS.ascendant) return 'ascendant';
  return 'invocation';
}

/** Council orbit speed — slow during invocation, ramps to full in
 *  ascendant. Stays at full thereafter. */
function orbitSpeedFor(phase: SanctumPhase): number {
  return phase === 'invocation' ? ORBIT_SPEED_BASE : ORBIT_SPEED_RAMP;
}

// ── Per-frame tick ───────────────────────────────────────────────────

/**
 * Advance the Sanctum state by `dtMs`. Pure simulation — no rendering,
 * no input handling. The level loop calls this once per frame and is
 * responsible for collision resolution against external entities
 * (ship bullets) via the applyXxxHit helpers.
 *
 * dtMs is clamped to 100ms to avoid huge integration jumps after the
 * tab was backgrounded — a 5-second freeze shouldn't fly the council
 * through ten orbits.
 */
export function tickSanctum(state: SanctumState, dtMs: number): void {
  const clampedDtMs = Math.min(100, Math.max(0, dtMs));
  const dt = clampedDtMs / 1000;
  const now = state.startedAt + (state.startedAt > 0 ? performance.now() - state.startedAt : 0);
  // `elapsedMs` is the canonical run-clock; phase + spawn-windows all key off it.
  const elapsedMs = performance.now() - state.startedAt;

  // Resolve current phase. Don't lock 'complete' here — the level loop
  // owns the end-of-run transition and decides whether to early-end on
  // a Bullbear defeat.
  state.phase = phaseFor(elapsedMs);

  // Council orbit + respawn.
  const orbitSpeed = orbitSpeedFor(state.phase);
  const cx = SANCTUM_WORLD_W / 2;
  const cy = SANCTUM_WORLD_H / 2;
  for (const m of state.council) {
    if (m.dead) {
      // Respawn check.
      if (m.respawnAt > 0 && performance.now() >= m.respawnAt) {
        m.hp = m.hpMax;
        m.dead = false;
        m.respawnAt = 0;
        m.hitFlash = 1;  // brief flash to telegraph the respawn
      }
      continue;
    }
    m.orbitAngle += orbitSpeed * dt;
    m.x = cx + Math.cos(m.orbitAngle) * SANCTUM_RING_RADIUS;
    m.y = cy + Math.sin(m.orbitAngle) * SANCTUM_RING_RADIUS;
    m.rot += m.rotVel * clampedDtMs;
    if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt * 4);
    if (m.bannerTtl > 0) m.bannerTtl = Math.max(0, m.bannerTtl - clampedDtMs);
  }

  // Sacred Stone — wakes once at STONE_WAKE_AT_MS, can shatter up to
  // STONE_MAX_SHATTERS times, each Stone deeper HP than the last.
  if (!state.stone && state.stoneShatters < STONE_MAX_SHATTERS && elapsedMs >= STONE_WAKE_AT_MS) {
    state.stone = spawnSacredStone(state.stoneShatters);
  }
  if (state.stone) {
    const s = state.stone;
    if (s.shattering) {
      // Waiting for the next Stone to spawn (or the run to end if this
      // was the last).
      if (s.respawnAt > 0 && performance.now() >= s.respawnAt) {
        if (state.stoneShatters < STONE_MAX_SHATTERS) {
          state.stone = spawnSacredStone(state.stoneShatters);
        } else {
          state.stone = null;  // no more Stones for the rest of the run
        }
      }
    } else {
      s.pulse = (s.pulse + dt * 1.4) % (Math.PI * 2);
      s.rot += clampedDtMs * 0.0003;
      if (s.hitFlash > 0) s.hitFlash = Math.max(0, s.hitFlash - dt * 4);
    }
  }

  // racooDNI cameo — single spawn at RACOO_APPEAR_AT_MS, despawns after
  // RACOO_DURATION_MS or on hit.
  if (!state.racoo && !state.racooSpawned && elapsedMs >= RACOO_APPEAR_AT_MS) {
    state.racoo = spawnRacoo(performance.now());
    state.racooSpawned = true;
  }
  if (state.racoo) {
    const r = state.racoo;
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    // Bounce off edges so racoo zig-zags around.
    if (r.x - r.r < 0 || r.x + r.r > SANCTUM_WORLD_W) r.vx *= -1;
    if (r.y - r.r < 0 || r.y + r.r > SANCTUM_WORLD_H) r.vy *= -1;
    r.rot += clampedDtMs * 0.005;
    r.ttl -= clampedDtMs;
    if (r.hitFlash > 0) r.hitFlash = Math.max(0, r.hitFlash - dt * 4);
    if (r.bannerTtl > 0) r.bannerTtl = Math.max(0, r.bannerTtl - clampedDtMs);
    if (r.ttl <= 0 || r.hp <= 0) state.racoo = null;
  }

  // Bullbear — single boss spawn at BULLBEAR_APPEAR_AT_MS, persists
  // until killed or run ends.
  if (!state.bullbear && !state.bullbearSpawned && elapsedMs >= BULLBEAR_APPEAR_AT_MS) {
    state.bullbear = spawnBullbear();
    state.bullbearSpawned = true;
  }
  if (state.bullbear) {
    const b = state.bullbear;
    b.x += b.vx * dt;
    b.crackle = (b.crackle + dt * 6) % (Math.PI * 2);
    if (b.hitFlash > 0) b.hitFlash = Math.max(0, b.hitFlash - dt * 4);
    // Charge pattern: when an edge is hit, reverse direction and pick
    // a fresh vertical lane so each pass crosses different territory.
    if (b.x - b.r < -BULLBEAR_RADIUS && b.vx < 0) {
      b.chargeDir = 1;
      b.vx = BULLBEAR_CHARGE_SPEED;
      b.y = SANCTUM_WORLD_H * (0.3 + Math.random() * 0.4);
    } else if (b.x + b.r > SANCTUM_WORLD_W + BULLBEAR_RADIUS && b.vx > 0) {
      b.chargeDir = -1;
      b.vx = -BULLBEAR_CHARGE_SPEED;
      b.y = SANCTUM_WORLD_H * (0.3 + Math.random() * 0.4);
    }
    if (b.hp <= 0) {
      state.bullbear = null;
      state.bullbearDefeated = true;
    }
  }

  // Ember meteors — phase-driven spawn cadence + cap.
  const spawnEveryMs = METEOR_SPAWN_MS_BY_PHASE[state.phase] ?? Infinity;
  if (
    spawnEveryMs !== Infinity &&
    state.meteors.length < METEOR_CAP &&
    performance.now() - state.lastMeteorSpawnAt >= spawnEveryMs
  ) {
    state.meteors.push(spawnMeteor());
    state.lastMeteorSpawnAt = performance.now();
  }
  for (let i = state.meteors.length - 1; i >= 0; i--) {
    const m = state.meteors[i];
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    m.rot += m.rotVel * clampedDtMs;
    if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt * 4);
    // Cull off-screen so they don't accumulate forever.
    const off = m.r + 80;
    if (m.x < -off || m.x > SANCTUM_WORLD_W + off ||
        m.y < -off || m.y > SANCTUM_WORLD_H + off ||
        m.hp <= 0) {
      state.meteors.splice(i, 1);
    }
  }

  void now;
}

// ── Hit application (sat-returning) ──────────────────────────────────

/** Land a hit on a council member. Returns the sat drop on a kill, 0
 *  otherwise. Sets the respawn timer so the slot comes back ~9s later. */
export function applyMemberHit(member: SanctumCouncilAsteroid): number {
  if (member.dead) return 0;
  member.hp -= 1;
  member.hitFlash = 1;
  member.bannerTtl = 1_500;
  if (member.hp <= 0) {
    member.dead = true;
    member.respawnAt = performance.now() + MEMBER_RESPAWN_MS;
    return DROP_MEMBER;
  }
  return 0;
}

/** Land a hit on the Sacred Stone. Returns the sat drop on shatter, 0
 *  otherwise. Marks the Stone as 'shattering' so the next deeper Stone
 *  spawns after STONE_RESPAWN_MS. Caller bumps `state.stoneShatters`
 *  on a non-zero return so the next spawn picks the right HP tier. */
export function applyStoneHit(state: SanctumState): number {
  const stone = state.stone;
  if (!stone || !stone.awake || stone.hp <= 0 || stone.shattering) return 0;
  stone.hp -= 1;
  stone.hitFlash = 1;
  if (stone.hp <= 0) {
    stone.shattering = true;
    stone.respawnAt = performance.now() + STONE_RESPAWN_MS;
    state.stoneShatters += 1;
    return DROP_STONE;
  }
  return 0;
}

/** Land a hit on racooDNI. One-shot — returns the 6-sat burst and
 *  clears racoo from state (handled in tickSanctum on hp<=0). */
export function applyRacooHit(racoo: SanctumRacoo): number {
  if (racoo.hp <= 0) return 0;
  racoo.hp -= 1;
  racoo.hitFlash = 1;
  return DROP_RACOO;
}

/** Land a hit on Bullbear. Returns DROP_BULLBEAR on defeat, 0 otherwise. */
export function applyBullbearHit(bullbear: SanctumBullbear): number {
  if (bullbear.hp <= 0) return 0;
  bullbear.hp -= 1;
  bullbear.hitFlash = 1;
  if (bullbear.hp <= 0) return DROP_BULLBEAR;
  return 0;
}

/** Land a hit on an ember meteor. Returns 0 always — meteors are score
 *  only, no sat payout. The level loop bumps score externally. */
export function applyMeteorHit(meteor: SanctumMeteor): number {
  if (meteor.hp <= 0) return 0;
  meteor.hp -= 1;
  meteor.hitFlash = 1;
  return DROP_METEOR;
}

// ── End conditions ───────────────────────────────────────────────────

/** True when the run is over — either the 240s timer expired OR
 *  Bullbear was defeated (early victory). The level loop transitions
 *  to game-over on this returning true. */
export function isSanctumComplete(state: SanctumState): boolean {
  if (state.bullbearDefeated) return true;
  const elapsedMs = performance.now() - state.startedAt;
  return elapsedMs >= SANCTUM_TOTAL_MS;
}

/** Ms remaining before the auto-end, clamped to [0, SANCTUM_TOTAL_MS].
 *  Used by the HUD countdown. */
export function sanctumTimeRemainingMs(state: SanctumState): number {
  const elapsedMs = performance.now() - state.startedAt;
  return Math.max(0, SANCTUM_TOTAL_MS - elapsedMs);
}

// ── Render helpers ───────────────────────────────────────────────────

export function drawCouncilAsteroid(
  ctx: CanvasRenderingContext2D,
  m: SanctumCouncilAsteroid,
): void {
  if (m.dead) return;
  drawAvatarAsteroid(ctx, m.member, m.x, m.y, m.r, m.rot);
  if (m.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = m.hitFlash * 0.6;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  if (m.bannerTtl > 0) {
    const a = Math.min(1, m.bannerTtl / 600);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ffd84a';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 4;
    const labelY = m.y - m.r - 8;
    ctx.fillText(`${m.member.role} · ${m.member.archetype.toUpperCase()}`, m.x, labelY);
    ctx.fillStyle = 'rgba(255, 245, 216, 0.9)';
    ctx.font = 'bold 13px ui-monospace, monospace';
    ctx.fillText(m.member.name.toUpperCase(), m.x, labelY - 14);
    ctx.restore();
  }
  if (m.hpMax > 1) {
    ctx.save();
    const gap = 6;
    const totalW = (m.hpMax - 1) * gap;
    const pipY = m.y + m.r + 10;
    for (let i = 0; i < m.hpMax; i++) {
      ctx.fillStyle = i < m.hp ? 'rgba(255, 138, 58, 0.9)' : 'rgba(255, 138, 58, 0.2)';
      ctx.beginPath();
      ctx.arc(m.x - totalW / 2 + i * gap, pipY, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function drawSacredStone(ctx: CanvasRenderingContext2D, s: SanctumSacredStone): void {
  ctx.save();
  // Fade during the shattering window so the transition between Stones reads.
  const alpha = s.shattering ? Math.max(0, 1 - (performance.now() - (s.respawnAt - STONE_RESPAWN_MS)) / STONE_RESPAWN_MS) : 1;
  ctx.globalAlpha = alpha;

  if (s.awake && !s.shattering) {
    const haloR = s.r * (1.6 + 0.18 * Math.sin(s.pulse));
    const haloA = 0.28 + 0.18 * Math.sin(s.pulse);
    const grad = ctx.createRadialGradient(s.x, s.y, s.r * 0.5, s.x, s.y, haloR);
    grad.addColorStop(0, `rgba(255, 138, 58, ${haloA})`);
    grad.addColorStop(1, 'rgba(255, 138, 58, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(s.x, s.y, haloR, 0, Math.PI * 2);
    ctx.fill();
  }

  const bodyGrad = ctx.createRadialGradient(
    s.x - s.r * 0.3, s.y - s.r * 0.3, s.r * 0.1,
    s.x, s.y, s.r,
  );
  bodyGrad.addColorStop(0, '#ff8a3a');
  bodyGrad.addColorStop(0.55, '#7a2f12');
  bodyGrad.addColorStop(1, '#1a0a06');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
  ctx.fill();

  // 4-line sacred number, etched on the stone face.
  ctx.fillStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.font = `bold ${Math.floor(s.r * 0.22)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lineH = s.r * 0.24;
  ctx.fillText('600', s.x, s.y - lineH * 1.5);
  ctx.fillText('000', s.x, s.y - lineH * 0.5);
  ctx.fillText('000', s.x, s.y + lineH * 0.5);
  ctx.fillText('000', s.x, s.y + lineH * 1.5);

  if (s.hitFlash > 0) {
    ctx.globalAlpha = s.hitFlash * 0.7 * alpha;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  }

  if (s.awake && !s.shattering) {
    ctx.globalAlpha = alpha;
    const barW = s.r * 1.8;
    const barH = 6;
    const barX = s.x - barW / 2;
    const barY = s.y - s.r - 18;
    ctx.fillStyle = 'rgba(40, 24, 12, 0.85)';
    ctx.fillRect(barX, barY, barW, barH);
    ctx.fillStyle = '#ff8a3a';
    ctx.fillRect(barX, barY, barW * (s.hp / s.hpMax), barH);
    ctx.strokeStyle = 'rgba(255, 216, 74, 0.6)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);
    // Shatter-progression tick marks below the bar — one filled tick
    // per shatter already landed in this run.
    for (let i = 0; i < STONE_MAX_SHATTERS; i++) {
      const tx = barX + (i + 0.5) * (barW / STONE_MAX_SHATTERS);
      const ty = barY + barH + 6;
      ctx.beginPath();
      ctx.arc(tx, ty, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = i < s.shatterIndex ? '#ffd84a' : 'rgba(255,216,74,0.25)';
      ctx.fill();
    }
  }
  ctx.restore();
}

export function drawRacoo(ctx: CanvasRenderingContext2D, r: SanctumRacoo): void {
  ctx.save();
  ctx.translate(r.x, r.y);
  ctx.rotate(r.rot);

  // Body — dark grey furry blob with subtle ember rim.
  ctx.fillStyle = '#1c1410';
  ctx.beginPath();
  ctx.arc(0, 0, r.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 138, 58, 0.7)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Sunglasses — two horizontal bars over the eyes (canonical raccoon
  // mask + shades combo).
  ctx.fillStyle = '#fff5d8';
  ctx.fillRect(-r.r * 0.55, -r.r * 0.15, r.r * 0.45, r.r * 0.18);
  ctx.fillRect(r.r * 0.10, -r.r * 0.15, r.r * 0.45, r.r * 0.18);
  ctx.fillStyle = '#0a0418';
  ctx.fillRect(-r.r * 0.48, -r.r * 0.10, r.r * 0.32, r.r * 0.10);
  ctx.fillRect(r.r * 0.16, -r.r * 0.10, r.r * 0.32, r.r * 0.10);

  // Tail-stripe hint — small white stripe across the back.
  ctx.fillStyle = 'rgba(255, 245, 216, 0.4)';
  ctx.fillRect(-r.r * 0.7, r.r * 0.3, r.r * 1.4, r.r * 0.12);

  ctx.restore();

  // Hit-flash overlay (un-rotated).
  if (r.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = r.hitFlash * 0.7;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // "GM" banner — flashes for the first 3s of the cameo as the
  // canonical 04:20 GMT ritual nod.
  if (r.bannerTtl > 0) {
    const a = Math.min(1, r.bannerTtl / 1_500);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = 'bold 28px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ffd84a';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 6;
    ctx.fillText('GM', r.x, r.y - r.r - 18);
    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255, 245, 216, 0.85)';
    ctx.fillText('04:20 GMT · RITUAL', r.x, r.y - r.r - 4);
    ctx.restore();
  }
}

export function drawBullbear(ctx: CanvasRenderingContext2D, b: SanctumBullbear): void {
  ctx.save();
  ctx.translate(b.x, b.y);

  // Body — black armoured mass with subtle bull/bear silhouette.
  // We don't have a sprite so this reads as a faceted dark obelisk
  // with orange lightning crackling around it.
  const bodyGrad = ctx.createRadialGradient(0, -b.r * 0.2, b.r * 0.15, 0, 0, b.r);
  bodyGrad.addColorStop(0, '#3a1a08');
  bodyGrad.addColorStop(0.5, '#1a0a04');
  bodyGrad.addColorStop(1, '#050201');
  ctx.fillStyle = bodyGrad;
  ctx.beginPath();
  ctx.arc(0, 0, b.r, 0, Math.PI * 2);
  ctx.fill();

  // Armoured outline.
  ctx.strokeStyle = 'rgba(255, 138, 58, 0.6)';
  ctx.lineWidth = 3;
  ctx.stroke();

  // Orange lightning crackle — three jagged bolts radiating, rotated
  // by the crackle phase so they animate.
  ctx.strokeStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(255, 138, 58, 0.9)';
  ctx.shadowBlur = 8;
  for (let i = 0; i < 3; i++) {
    const baseAngle = b.crackle + (i / 3) * Math.PI * 2;
    let cx = 0, cy = 0;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (let j = 0; j < 4; j++) {
      const t = (j + 1) / 4;
      const a = baseAngle + (Math.random() - 0.5) * 0.4;
      const len = b.r * (0.4 + t * 0.7);
      cx = Math.cos(a) * len;
      cy = Math.sin(a) * len;
      ctx.lineTo(cx, cy);
    }
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // Glyph: small "BB" wordmark at the centre.
  ctx.fillStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.font = `bold ${Math.floor(b.r * 0.3)}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('BB', 0, 0);

  ctx.restore();

  // Hit-flash overlay.
  if (b.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = b.hitFlash * 0.65;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // HP bar above the boss.
  const barW = b.r * 2.0;
  const barH = 8;
  const barX = b.x - barW / 2;
  const barY = b.y - b.r - 20;
  ctx.save();
  ctx.fillStyle = 'rgba(40, 24, 12, 0.9)';
  ctx.fillRect(barX, barY, barW, barH);
  ctx.fillStyle = '#ff8a3a';
  ctx.fillRect(barX, barY, barW * (b.hp / b.hpMax), barH);
  ctx.strokeStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(barX, barY, barW, barH);
  ctx.font = '11px ui-monospace, monospace';
  ctx.fillStyle = '#ffd84a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('BULLBEAR · CYCLE GUARDIAN', b.x, barY - 4);
  ctx.restore();
}

export function drawEmberMeteor(ctx: CanvasRenderingContext2D, m: SanctumMeteor): void {
  ctx.save();
  ctx.translate(m.x, m.y);
  ctx.rotate(m.rot);

  // Volcanic rock — radial gradient from warm core to dark edge.
  const grad = ctx.createRadialGradient(-m.r * 0.3, -m.r * 0.3, m.r * 0.1, 0, 0, m.r);
  grad.addColorStop(0, `hsl(${30 + m.hueOffset}, 90%, 60%)`);
  grad.addColorStop(0.5, '#7a2f12');
  grad.addColorStop(1, '#0d0503');
  ctx.fillStyle = grad;

  // Lumpy outline so they don't look like clones.
  ctx.beginPath();
  const segments = 8;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const r = m.r * (0.85 + ((i * 31) % 7) / 35);
    const x = Math.cos(a) * r;
    const y = Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = 'rgba(255, 138, 58, 0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();

  if (m.hitFlash > 0) {
    ctx.save();
    ctx.globalAlpha = m.hitFlash * 0.65;
    ctx.fillStyle = '#fff5d8';
    ctx.beginPath();
    ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Draw the standing brand chrome — sacred number wordmark, phase
 *  label, countdown timer. Doesn't depend on entity state; safe to
 *  call from any phase. */
export function drawSanctumChrome(
  ctx: CanvasRenderingContext2D,
  state: SanctumState | null = null,
  worldW: number = SANCTUM_WORLD_W,
  worldH: number = SANCTUM_WORLD_H,
): void {
  ctx.save();
  const cx = worldW / 2;
  const top = worldH * 0.06;
  const size = Math.min(worldH * 0.055, 42);
  ctx.font = `bold ${size}px ui-monospace, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(255, 216, 74, 0.85)';
  ctx.shadowColor = 'rgba(255, 138, 58, 0.55)';
  ctx.shadowBlur = 16;
  const lineGap = size * 0.95;
  ctx.fillText('600', cx, top);
  ctx.fillText('000', cx, top + lineGap);
  ctx.fillText('000', cx, top + lineGap * 2);
  ctx.fillText('000', cx, top + lineGap * 3);
  ctx.shadowBlur = 0;

  // Phase label + countdown timer when state is provided.
  if (state) {
    const phaseLabel = state.phase.toUpperCase();
    const remainingMs = sanctumTimeRemainingMs(state);
    const mm = Math.floor(remainingMs / 60_000);
    const ss = Math.floor((remainingMs % 60_000) / 1000);
    const time = `${mm}:${ss.toString().padStart(2, '0')}`;

    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255, 216, 74, 0.85)';
    ctx.fillText(`PHASE · ${phaseLabel}`, 20, 20);
    ctx.font = 'bold 22px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(time, worldW - 20, 18);

    // Sats + score chip.
    ctx.font = '14px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#3afc7c';
    ctx.fillText(`${state.satsEarned} SATS`, worldW - 20, 46);
    ctx.fillStyle = 'rgba(255, 245, 216, 0.75)';
    ctx.fillText(`${state.score.toLocaleString()} PTS`, worldW - 20, 62);
  }
  ctx.restore();
}

/** Convenience full-pass render — chrome + every active entity in the
 *  right z-order. The level loop is encouraged to call the pieces
 *  individually so particles/explosions can interleave; this works for
 *  the static preview page. */
export function renderSanctum(
  ctx: CanvasRenderingContext2D,
  state: SanctumState,
  worldW: number = SANCTUM_WORLD_W,
  worldH: number = SANCTUM_WORLD_H,
): void {
  drawSanctumChrome(ctx, state, worldW, worldH);
  for (const m of state.meteors) drawEmberMeteor(ctx, m);
  if (state.stone) drawSacredStone(ctx, state.stone);
  for (const m of state.council) drawCouncilAsteroid(ctx, m);
  if (state.racoo) drawRacoo(ctx, state.racoo);
  if (state.bullbear) drawBullbear(ctx, state.bullbear);
}
