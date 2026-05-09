/**
 * Game logic — entity creation, simulation, collisions, wave progression.
 *
 * The render layer is in render.ts. The audio layer is in audio.ts.
 * Auth and scoring live alongside in auth.ts and score.ts.
 */

import type {
  GameState, Ship, Asteroid, AsteroidSize, AsteroidType, Ufo, UfoType, Mine, Vec2,
} from './types.js';
import {
  waveName, FINAL_WAVE, ASTEROID_TYPE_CONFIG,
  REPLAY_RECORD_INTERVAL_MS, REPLAY_BUFFER_FRAMES, REPLAY_TOTAL_WALL_MS,
  LURK_CENTRE_RADIUS_PX, LURK_VEL_THRESHOLD, LURK_DURATION_MS, LURK_TOAST_MS,
  SAT_DROP_CHANCE_DENOM,
} from './types.js';
import type { PickupKind } from './types.js';
import type { ReplaySnapshot } from './types.js';
import {
  WORLD_W, WORLD_H,
  SHIP_RADIUS, SHIP_THRUST, SHIP_DRAG, SHIP_ROT_ACCEL, SHIP_ROT_DAMPING, SHIP_MAX_ROT, SHIP_INVULN_MS, FIRE_COOLDOWN_MS,
  HYPERSPACE_COOLDOWN_MS, HYPERSPACE_CLOAK_MS, HYPERSPACE_MALFUNCTION_CHANCE, HYPERSPACE_SAFE_DIST,
  SHIELD_DURATION_MS, SHIELD_COOLDOWN_MS,
  BULLET_SPEED, BULLET_TTL_MS, BULLET_RADIUS,
  ASTEROID_BASE_SPEED, ASTEROID_SPEED_PER_WAVE,
  COIN_RADIUS, COIN_TTL_MS,
  POINTS_PER_SIZE, SATS_PER_SIZE, RADIUS_PER_SIZE,
  UFO_RADIUS, UFO_SPEED, UFO_HP, UFO_SHOT_SPREAD, UFO_SHOOT_INTERVAL, UFO_BULLET_SPEED_MUL,
  UFO_BULLET_SPEED, UFO_BULLET_TTL_MS, UFO_LIFETIME_MS,
  UFO_ZIG_INTERVAL_MS, UFO_POINTS, UFO_SATS,
  UFO_FIRST_SPAWN_MS, UFO_RESPAWN_BASE_MS, UFO_RESPAWN_PER_WAVE_MS, UFO_RESPAWN_MIN_MS,
  UFO_TYPE_BY_WAVE,
  MINE_RADIUS, MINE_GRAVITY_RANGE, MINE_GRAVITY_STRENGTH, MINE_POINTS, MINE_SATS_DROP,
  MINE_CANDIDATE_POSITIONS, MINE_COUNT_BY_WAVE,
  COMBO_WINDOW_MS, COMBO_MAX,
  POWERUP_CONFIG, POWERUP_DROP_CHANCE, POWERUP_TTL_MS, POWERUP_RADIUS,
  RAPID_COOLDOWN_MUL, SATBOOST_MUL,
} from './types.js';
import type { PowerUp, PowerUpType } from './types.js';
import * as audio from './audio.js';
import { preloadBackground } from './render.js';
import { currentMods } from './difficulty.js';
import { gameRng } from './seed.js';

// ── Initial state ─────────────────────────────────────────────────────────────

export function makeInitialState(): GameState {
  return {
    phase: 'title',
    ship: makeShip(),
    asteroids: [],
    bullets: [],
    enemyBullets: [],
    ufos: [],
    mines: [],
    coins: [],
    powerups: [],
    particles: [],
    score: 0,
    sats: 0,
    displaySats: 0,
    wave: 0,
    lives: 3,
    phaseStart: performance.now(),
    lastUpdate: performance.now(),
    elapsed: 0,
    nextUfoSpawn: UFO_FIRST_SPAWN_MS,
    nextMineSpawn: 0,
    warpTargetWave: 1,
    runTimeMs: 0,
    bossDefeated: false,
    combo: 0,
    comboExpiresAt: 0,
    rapidExpiresAt: 0,
    satboostExpiresAt: 0,
    session: null,
    profile: null,
    keys: {},
    toast: null,
    toastUntil: 0,
    replayBuffer: [],
    deathReplay: null,
    lurking: false,
    lurkingSince: 0,
    lurkSatsBlocked: 0,
    lurkEverDetected: false,
  };
}

function makeShip(): Ship {
  return {
    pos: { x: WORLD_W / 2, y: WORLD_H / 2 },
    vel: { x: 0, y: 0 },
    radius: SHIP_RADIUS,
    alive: true,
    rot: -Math.PI / 2,
    rotVel: 0,
    thrusting: false,
    invulnerableUntil: 0,
    thrustFrame: 0,
    hyperspaceReadyAt: 0,
    hyperspaceCloakMs: 0,
    hyperspaceMalfunction: false,
    shieldUp: false,
    shieldExpiresAt: 0,
    shieldReadyAt: 0,
  };
}

export function startGame(s: GameState): void {
  const mods = currentMods();
  s.score = 0;
  s.sats = 0;
  s.displaySats = 0;
  s.wave = 0;
  s.lives = mods.livesStart;
  s.asteroids = [];
  s.bullets = [];
  s.enemyBullets = [];
  s.ufos = [];
  s.mines = [];
  s.coins = [];
  s.powerups = [];
  s.particles = [];
  s.ship = makeShip();
  s.ship.invulnerableUntil = performance.now() + SHIP_INVULN_MS;
  s.nextUfoSpawn = UFO_FIRST_SPAWN_MS;
  s.nextMineSpawn = 0;
  s.runTimeMs = 0;
  s.bossDefeated = false;
  s.combo = 0;
  s.comboExpiresAt = 0;
  s.rapidExpiresAt = 0;
  s.satboostExpiresAt = 0;
  s.warpTargetWave = 1;
  s.elapsed = 0;
  s.toast = null;
  s.toastUntil = 0;
  s.keys = {};
  s.replayBuffer = [];
  s.deathReplay = null;
  s.lurking = false;
  s.lurkingSince = 0;
  s.lurkSatsBlocked = 0;
  s.lurkEverDetected = false;
  beginWave(s, 1);
  audio.startHeartbeat();
  audio.startAmbient();
}

// ── Asteroids ─────────────────────────────────────────────────────────────────

function makeAsteroidShape(): number[] {
  const points = 11;
  const out: number[] = [];
  for (let i = 0; i < points; i++) {
    out.push(0.7 + Math.random() * 0.45);
  }
  return out;
}

/**
 * Wave-based asteroid type distribution. Stony only at the very start; iron
 * arrives early as the first armoured threat; chondrite swarms enter mid-game;
 * pallasite is a rare jackpot throughout but never common.
 */
function pickAsteroidType(wave: number): AsteroidType {
  const r = gameRng();
  if (wave <= 3) return 'stony';
  if (wave <= 6) {
    if (r < 0.05) return 'pallasite';
    if (r < 0.30) return 'iron';
    return 'stony';
  }
  if (wave <= 10) {
    if (r < 0.06) return 'pallasite';
    if (r < 0.30) return 'iron';
    if (r < 0.50) return 'chondrite';
    return 'stony';
  }
  if (wave <= 17) {
    if (r < 0.07) return 'pallasite';
    if (r < 0.35) return 'iron';
    if (r < 0.60) return 'chondrite';
    return 'stony';
  }
  // Waves 18-25
  if (r < 0.08) return 'pallasite';
  if (r < 0.40) return 'iron';
  if (r < 0.70) return 'chondrite';
  return 'stony';
}

export function spawnAsteroid(size: AsteroidSize, wave: number, pos?: Vec2, vel?: Vec2, type?: AsteroidType): Asteroid {
  const mods = currentMods();
  const radius = RADIUS_PER_SIZE[size];
  const speedBase = (ASTEROID_BASE_SPEED + wave * ASTEROID_SPEED_PER_WAVE) * mods.asteroidSpeedMul;
  const sizeMul = size === 'large' ? 0.7 : size === 'medium' ? 1 : 1.5;
  const speed = speedBase * sizeMul * (0.7 + Math.random() * 0.6);

  // For an edge-spawned asteroid (no explicit pos given), use the inward angle
  // ± 60° so velocity always has a meaningful inward component. For explicit
  // positions (e.g. break children), fall back to a fully random angle.
  let position: Vec2;
  let velocity: Vec2;
  if (pos) {
    position = pos;
    if (vel) {
      velocity = vel;
    } else {
      const angle = gameRng() * Math.PI * 2;
      velocity = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
    }
  } else {
    const spawn = randomEdgePosition();
    position = spawn.pos;
    const inwardSpread = (gameRng() - 0.5) * (Math.PI * 2 / 3);  // ±60° around the inward heading
    const angle = spawn.inwardAngle + inwardSpread;
    velocity = vel ?? { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
  }

  const t = type ?? pickAsteroidType(wave);
  const cfg = ASTEROID_TYPE_CONFIG[t];

  return {
    pos: position,
    vel: velocity,
    radius,
    alive: true,
    size,
    type: t,
    hp: size === 'large' ? cfg.hp : 1,
    hitFlash: 0,
    rot: Math.random() * Math.PI * 2,
    rotVel: (Math.random() - 0.5) * 1.6,
    shape: makeAsteroidShape(),
    hue: Math.random() * 60 - 30,
  };
}

/** Spawn position + the inward unit-direction the asteroid should head in. */
interface EdgeSpawn { pos: Vec2; inwardAngle: number; }

function randomEdgePosition(): EdgeSpawn {
  // Spawn from the edges of the playfield, away from the ship's centre.
  // inwardAngle points toward the centre half of the playfield so the
  // asteroid actually enters view (vs picking a random angle that could be
  // edge-parallel or outward).
  const edge = Math.floor(gameRng() * 4);
  switch (edge) {
    case 0: return { pos: { x: gameRng() * WORLD_W, y: -RADIUS_PER_SIZE.large }, inwardAngle: Math.PI / 2 };  // top → moves down
    case 1: return { pos: { x: WORLD_W + RADIUS_PER_SIZE.large, y: gameRng() * WORLD_H }, inwardAngle: Math.PI };  // right → moves left
    case 2: return { pos: { x: gameRng() * WORLD_W, y: WORLD_H + RADIUS_PER_SIZE.large }, inwardAngle: -Math.PI / 2 };  // bottom → moves up
    default: return { pos: { x: -RADIUS_PER_SIZE.large, y: gameRng() * WORLD_H }, inwardAngle: 0 };  // left → moves right
  }
}

export function beginWave(s: GameState, wave: number): void {
  s.wave = wave;
  // 1979 homage: each new wave re-centres the ship and grants brief invuln,
  // matching the original arcade behaviour. Skips on wave 1 (startGame already
  // placed the ship there) but harmless to repeat.
  if (s.ship.alive) {
    s.ship.pos.x = WORLD_W / 2;
    s.ship.pos.y = WORLD_H / 2;
    s.ship.vel.x = 0;
    s.ship.vel.y = 0;
    s.ship.rotVel = 0;
    s.ship.rot = -Math.PI / 2;
    s.ship.invulnerableUntil = performance.now() + SHIP_INVULN_MS;
  }
  if (wave === FINAL_WAVE) {
    // Wave 25: BOSS arena — spawn boss + lighter asteroid garnish
    s.ufos.push(makeBossUfo());
    audio.ufoSirenStart();
    for (let i = 0; i < 5; i++) {
      s.asteroids.push(spawnAsteroid('large', wave));
    }
  } else {
    // Standard wave — count plateaus at 10 asteroids
    const count = Math.min(10, 3 + wave);
    for (let i = 0; i < count; i++) {
      s.asteroids.push(spawnAsteroid('large', wave));
    }
  }
  // Place static mines for this wave (deterministic per wave so player can learn the layout)
  placeWaveMines(s, wave);
  // Always preceded by a 'warp' phase except for wave 1 from a fresh start.
  if (s.phase !== 'warp') {
    s.phase = 'wavestart';
  }
  s.phaseStart = performance.now();
  // Heartbeat speeds up with wave
  audio.setHeartbeatPeriod(Math.max(0.35, 1.0 - wave * 0.06));
  // Preload the next wave's background so the warp transition is seamless
  preloadBackground(wave + 1);
  // Half-beat of silence first — duck the music so the wave name lands cleanly,
  // then fire the chime + reveal at WAVE_REVEAL_DELAY_MS, then unduck and resume.
  audio.setMusicDuck(0.3);
  setTimeout(() => {
    if (s.phase !== 'wavestart') return;
    audio.levelUp();
    toastNow(s, `WAVE ${wave} · ${waveName(wave)}`);
  }, WAVE_REVEAL_DELAY_MS);
  setTimeout(() => {
    audio.setMusicDuck(1);
    if (s.phase === 'wavestart' || s.phase === 'warp') s.phase = 'playing';
  }, WAVESTART_MS);
}

const WAVESTART_MS = 2000;
const WAVE_REVEAL_DELAY_MS = 400;

function startWarp(s: GameState, targetWave?: number): void {
  const next = targetWave ?? s.wave + 1;
  s.phase = 'warp';
  s.phaseStart = performance.now();
  s.warpTargetWave = next;
  audio.warpJump();
  setTimeout(() => {
    if (s.phase === 'warp') {
      beginWave(s, next);
    }
  }, 1300);
}

/** Cheat: skip to a specific wave. Clears stage, kicks off warp. */
export function cheatJumpToWave(s: GameState, wave: number): void {
  if (s.phase !== 'playing' && s.phase !== 'wavestart' && s.phase !== 'warp') return;
  const target = Math.max(1, Math.min(99, Math.floor(wave)));
  clearStage(s, { autoCollect: false });
  audio.ufoSirenStop();
  // Preload the target wave so the warp banner doesn't flash a missing image
  preloadBackground(target);
  toastNow(s, `► CHEAT: WAVE ${target}`);
  startWarp(s, target);
}

// ── Power-ups ─────────────────────────────────────────────────────────────────

const POWERUP_TYPES_NOSTR: PowerUpType[] = ['rapid', 'satboost', 'bomb'];
const POWERUP_TYPES_GUEST: PowerUpType[] = ['rapid', 'bomb'];  // satboost has nothing to boost

/** Maybe drop a power-up at the given position. Called from UFO kills. */
function maybeDropPowerUp(s: GameState, x: number, y: number, force?: PowerUpType): void {
  let type: PowerUpType;
  if (force) {
    type = force;
  } else {
    if (gameRng() >= POWERUP_DROP_CHANCE) return;
    const pool = s.session ? POWERUP_TYPES_NOSTR : POWERUP_TYPES_GUEST;
    type = pool[Math.floor(gameRng() * pool.length)];
  }
  const angle = gameRng() * Math.PI * 2;
  const speed = 30 + gameRng() * 40;
  s.powerups.push({
    pos: { x, y },
    vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    radius: POWERUP_RADIUS,
    alive: true,
    type,
    ttl: POWERUP_TTL_MS,
    collected: false,
  });
  const cfg = POWERUP_CONFIG[type];
  toastNow(s, `${cfg.glyph} ${cfg.pickupLabel} DROPPED`);
  audio.powerupDrop();
  // Sparkle burst at the drop site
  spawnParticles(s, x, y, 18, cfg.colour, 220, 700);
}

function applyPowerUp(s: GameState, p: PowerUp, now: number): void {
  const cfg = POWERUP_CONFIG[p.type];
  if (p.type === 'rapid') {
    s.rapidExpiresAt = Math.max(s.rapidExpiresAt, now) + cfg.durationMs;
  } else if (p.type === 'satboost') {
    s.satboostExpiresAt = Math.max(s.satboostExpiresAt, now) + cfg.durationMs;
  } else if (p.type === 'bomb') {
    detonateBomb(s);
  }
  toastNow(s, cfg.pickupLabel);
  audio.powerupPickup();
}

/**
 * Smart bomb effect: clears enemy bullets, breaks every asteroid, destroys
 * non-boss UFOs (boss takes 3 damage), wipes mines. Triggers each kill through
 * the standard destroy paths so combo/score chain naturally.
 */
function detonateBomb(s: GameState): void {
  for (const a of [...s.asteroids]) {
    if (a.alive) breakAsteroid(s, a);
  }
  for (const u of [...s.ufos]) {
    if (!u.alive) continue;
    if (u.type === 'boss') {
      damageUfo(s, u);
      damageUfo(s, u);
      damageUfo(s, u);
    } else {
      destroyUfo(s, u);
    }
  }
  for (const m of [...s.mines]) {
    if (m.alive) destroyMine(s, m);
  }
  s.enemyBullets = [];
  audio.explosion(1.8);
  spawnParticles(s, WORLD_W / 2, WORLD_H / 2, 60, '#ffd84a', 360, 1100);
}

/** Wipe entities so the new wave starts clean. Optionally bank uncollected coins. */
function clearStage(s: GameState, opts: { autoCollect: boolean }): void {
  if (opts.autoCollect) {
    let bankedSats = 0;
    let bankedScore = 0;
    for (const c of s.coins) {
      if (c.alive && !c.collected) {
        if (c.kind === 'sat') bankedSats += Math.max(1, Math.round(c.value));
        else bankedScore += Math.max(1, Math.round(c.value));
      }
      // Sparkle puff at each coin position — tinted by kind
      const tint = c.kind === 'sat' ? '#ffd84a' : '#7fffb0';
      spawnParticles(s, c.pos.x, c.pos.y, 4, tint, 100, 350);
    }
    if (bankedSats > 0) {
      // Lurking forfeits the wave-clear sat bank too; dust score is never
      // blocked because it's not money.
      if (s.lurking) {
        s.lurkSatsBlocked += bankedSats;
        toastNow(s, `LURK · ${bankedSats} sats forfeit`);
      } else {
        s.sats += bankedSats;
        toastNow(s, `+ ${bankedSats} sats banked`);
      }
      audio.coinPickup();
    } else if (bankedScore > 0) {
      // Quieter notification — dust is filler reward, not a banner moment.
      audio.dustPickup();
    }
    if (bankedScore > 0) s.score += bankedScore;
  }
  for (const u of s.ufos) spawnParticles(s, u.pos.x, u.pos.y, 12, '#ff5050', 100, 400);
  for (const m of s.mines) spawnParticles(s, m.pos.x, m.pos.y, 8, '#ff5050', 80, 300);
  s.asteroids = [];
  s.ufos = [];
  s.mines = [];
  s.coins = [];
  s.powerups = [];
  s.enemyBullets = [];
  s.bullets = [];
}

// ── UFO ───────────────────────────────────────────────────────────────────────

/** UFO species is locked per wave — see UFO_TYPE_BY_WAVE. */
function pickUfoType(wave: number): UfoType {
  return UFO_TYPE_BY_WAVE[wave - 1] ?? 'cruiser';
}

function makeBossUfo(): Ufo {
  return {
    pos: { x: WORLD_W / 2, y: WORLD_H / 3 },
    vel: { x: 30, y: 0 },
    radius: UFO_RADIUS.boss,
    alive: true,
    type: 'boss',
    hp: UFO_HP.boss,
    dir: 1,
    zigTimer: UFO_ZIG_INTERVAL_MS,
    shootTimer: 1500,
    lifetime: Number.POSITIVE_INFINITY,
    blink: 0,
    hitFlash: 0,
  };
}

function spawnUfo(s: GameState): void {
  const type = pickUfoType(s.wave);
  const dir: 1 | -1 = gameRng() < 0.5 ? 1 : -1;
  const y = WORLD_H * (0.15 + gameRng() * 0.7);
  const x = dir === 1 ? -UFO_RADIUS[type] : WORLD_W + UFO_RADIUS[type];
  const speed = UFO_SPEED[type];
  s.ufos.push({
    pos: { x, y },
    vel: { x: dir * speed, y: 0 },
    radius: UFO_RADIUS[type],
    alive: true,
    type,
    hp: UFO_HP[type],
    dir,
    zigTimer: UFO_ZIG_INTERVAL_MS,
    shootTimer: type === 'sniper' ? 1800 : 1100,
    lifetime: UFO_LIFETIME_MS,
    blink: 0,
    hitFlash: 0,
  });
  audio.ufoSirenStart();
}

function updateUfos(s: GameState, dt: number): void {
  for (const u of s.ufos) {
    if (!u.alive) continue;
    u.lifetime -= dt * 1000;
    u.blink += dt;
    if (u.hitFlash > 0) u.hitFlash = Math.max(0, u.hitFlash - dt * 4);
    if (u.lifetime <= 0) {
      u.alive = false;
      continue;
    }

    // Boss-only behaviour — stay in centre area, drift gently
    if (u.type === 'boss') {
      // Bounce off horizontal bounds
      if (u.pos.x < 120 || u.pos.x > WORLD_W - 120) u.vel.x *= -1;
      // Random vertical drift
      if (Math.random() < dt * 0.4) u.vel.y = (Math.random() - 0.5) * 30;
      if (u.pos.y < 100 || u.pos.y > WORLD_H * 0.55) u.vel.y *= -1;
      // No traversal-edge despawn
    }

    // Sniper-only behaviour: stop moving when within range, and only briefly
    if (u.type === 'sniper') {
      const dx = s.ship.pos.x - u.pos.x;
      const dy = s.ship.pos.y - u.pos.y;
      const distSq = dx * dx + dy * dy;
      const stopRange = 360;
      if (distSq < stopRange * stopRange && s.ship.alive) {
        // Brake to a stop while in range — accelerate gently when out of range
        u.vel.x *= Math.exp(-2.5 * dt);
        u.vel.y *= Math.exp(-2.5 * dt);
      } else {
        // Move toward player horizontally
        const targetVx = u.dir * UFO_SPEED.sniper;
        u.vel.x += (targetVx - u.vel.x) * dt * 1.2;
      }
    }

    u.pos.x += u.vel.x * dt;
    u.pos.y += u.vel.y * dt;

    // Despawn when leaves the screen on its travel side (boss never despawns this way)
    if (u.type !== 'boss') {
      if (u.dir === 1 && u.pos.x > WORLD_W + u.radius * 2) u.alive = false;
      if (u.dir === -1 && u.pos.x < -u.radius * 2) u.alive = false;
    }

    // Wrap Y so vertical drift stays on-screen
    if (u.pos.y < u.radius) u.pos.y = u.radius;
    if (u.pos.y > WORLD_H - u.radius) u.pos.y = WORLD_H - u.radius;

    // Zig-zag for non-sniper types (sniper holds steady when aiming)
    if (u.type !== 'sniper') {
      u.zigTimer -= dt * 1000;
      if (u.zigTimer <= 0) {
        u.zigTimer = UFO_ZIG_INTERVAL_MS * (0.6 + Math.random() * 0.8);
        u.vel.y = (Math.random() - 0.5) * UFO_SPEED[u.type] * 0.6;
      }
    }

    // Shoot
    u.shootTimer -= dt * 1000;
    if (u.shootTimer <= 0 && s.ship.alive) {
      u.shootTimer = UFO_SHOOT_INTERVAL[u.type];
      if (u.type === 'tank') {
        ufoFanShoot(s, u, s.ship.pos);
      } else if (u.type === 'boss') {
        // Boss alternates between aimed shots and fans, depending on HP
        if (u.hp < UFO_HP.boss * 0.5 && Math.random() < 0.5) {
          ufoFanShoot(s, u, s.ship.pos);
        } else {
          ufoShootAt(s, u, s.ship.pos);
        }
      } else {
        ufoShootAt(s, u, s.ship.pos);
      }
    }
  }
  const before = s.ufos.length;
  s.ufos = s.ufos.filter(u => u.alive);
  if (before > 0 && s.ufos.length === 0) audio.ufoSirenStop();
}

function ufoShootAt(s: GameState, u: Ufo, target: Vec2): void {
  const mods = currentMods();
  const dx = target.x - u.pos.x;
  const dy = target.y - u.pos.y;
  const baseAngle = Math.atan2(dy, dx);
  const spread = UFO_SHOT_SPREAD[u.type] * mods.ufoSpreadMul;
  const angle = baseAngle + (gameRng() - 0.5) * spread;
  const speed = UFO_BULLET_SPEED * UFO_BULLET_SPEED_MUL[u.type] * mods.ufoBulletSpeedMul;
  s.enemyBullets.push({
    pos: { x: u.pos.x, y: u.pos.y },
    vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
    radius: BULLET_RADIUS + 1,
    alive: true,
    ttl: UFO_BULLET_TTL_MS,
  });
  audio.ufoShoot();
}

function ufoFanShoot(s: GameState, u: Ufo, target: Vec2): void {
  const mods = currentMods();
  const dx = target.x - u.pos.x;
  const dy = target.y - u.pos.y;
  const baseAngle = Math.atan2(dy, dx);
  const speed = UFO_BULLET_SPEED * UFO_BULLET_SPEED_MUL.tank * mods.ufoBulletSpeedMul;
  for (const offset of [-0.32, 0, 0.32]) {
    const angle = baseAngle + offset + (gameRng() - 0.5) * 0.06;
    s.enemyBullets.push({
      pos: { x: u.pos.x, y: u.pos.y },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      radius: BULLET_RADIUS + 1,
      alive: true,
      ttl: UFO_BULLET_TTL_MS,
    });
  }
  audio.ufoShoot();
}

// ── Mines ─────────────────────────────────────────────────────────────────────

function makeMine(pos: Vec2): Mine {
  return {
    pos: { x: pos.x, y: pos.y },
    vel: { x: 0, y: 0 },     // static — never drifts
    radius: MINE_RADIUS,
    alive: true,
    age: 0,
    gravityRange: MINE_GRAVITY_RANGE,
    hp: 1,
    hitFlash: 0,
  };
}

/**
 * Pick the subset of candidate mine positions for this wave, deterministically
 * seeded by the wave number so layouts are stable across runs (the player can
 * learn them).
 */
function placeWaveMines(s: GameState, wave: number): void {
  const count = MINE_COUNT_BY_WAVE[wave - 1] ?? 0;
  if (count === 0) return;

  // Deterministic shuffle via seeded indices
  const seed = wave * 2654435761;
  const indices = MINE_CANDIDATE_POSITIONS.map((_, i) => i);
  // Fisher-Yates with seed-rotated picks
  for (let i = indices.length - 1; i > 0; i--) {
    const j = ((seed >>> (i & 31)) ^ (seed * (i + 1))) % (i + 1);
    const k = j < 0 ? j + i + 1 : j;
    [indices[i], indices[k]] = [indices[k], indices[i]];
  }
  const chosen = indices.slice(0, count);
  for (const idx of chosen) {
    const pos = MINE_CANDIDATE_POSITIONS[idx];
    s.mines.push(makeMine(pos));
  }
  audio.mineArm();
}

function updateMines(s: GameState, dt: number, _now: number): void {
  for (const m of s.mines) {
    if (!m.alive) continue;
    m.age += dt * 1000;
    if (m.hitFlash > 0) m.hitFlash = Math.max(0, m.hitFlash - dt * 4);

    // Mines are static — no movement physics.

    // Gravity well — pulls ship in (skipped during shield/hyperspace cloak)
    if (s.ship.alive && s.ship.hyperspaceCloakMs <= 0) {
      const mods = currentMods();
      const dx = m.pos.x - s.ship.pos.x;
      const dy = m.pos.y - s.ship.pos.y;
      const distSq = dx * dx + dy * dy;
      const range = m.gravityRange;
      if (distSq < range * range && distSq > 4) {
        const dist = Math.sqrt(distSq);
        const t = 1 - dist / range;
        const accel = MINE_GRAVITY_STRENGTH * t * mods.mineGravityMul;
        const nx = dx / dist;
        const ny = dy / dist;
        s.ship.vel.x += nx * accel * dt;
        s.ship.vel.y += ny * accel * dt;
      }
    }
  }
  s.mines = s.mines.filter(m => m.alive);
}

function destroyMine(s: GameState, m: Mine): void {
  if (!m.alive) return;
  m.alive = false;
  const mul = recordCombo(s, performance.now());
  s.score += MINE_POINTS * mul;
  audio.explosion(0.7);
  spawnParticles(s, m.pos.x, m.pos.y, 14, '#ff5050', 200, 600);
  spawnCoins(s, m.pos.x, m.pos.y, MINE_SATS_DROP, 2);
  toastNow(s, `MINE CLEARED  +${MINE_POINTS * mul}`);
}

// ── Boss / completion ─────────────────────────────────────────────────────────

function triggerCompletion(s: GameState): void {
  s.phase = 'completed';
  s.phaseStart = performance.now();
  audio.thrustOff();
  audio.stopHeartbeat();
  audio.ufoSirenStop();
  audio.stopAmbient();
  // Boss-down already played triumph(); the UI screen carries from there.
  // Kill remaining mines + enemy bullets — clear stage for the screen
  for (const m of s.mines) m.alive = false;
  s.mines = [];
  s.enemyBullets = [];
}

function damageUfo(s: GameState, u: Ufo): void {
  u.hp -= 1;
  u.hitFlash = 1;
  spawnParticles(s, u.pos.x, u.pos.y, 4, '#ffffff', 80, 250);

  // Boss drops mines around itself at every 5 HP threshold
  if (u.type === 'boss' && u.hp > 0 && u.hp % 5 === 0) {
    for (let i = 0; i < 3; i++) {
      const angle = (Math.PI * 2 * i) / 3 + Math.random() * 0.4;
      const dist = 90 + Math.random() * 40;
      const x = u.pos.x + Math.cos(angle) * dist;
      const y = u.pos.y + Math.sin(angle) * dist;
      if (x > 30 && x < WORLD_W - 30 && y > 30 && y < WORLD_H - 30) {
        s.mines.push(makeMine({ x, y }));
      }
    }
    toastNow(s, `BOSS: ${u.hp} HP · MINES DEPLOYED`);
  }

  if (u.hp <= 0) {
    destroyUfo(s, u);
  } else {
    audio.hit();
  }
}

function destroyUfo(s: GameState, u: Ufo): void {
  u.alive = false;
  const mul = recordCombo(s, performance.now());
  s.score += UFO_POINTS[u.type] * mul;
  const explodeScale = u.type === 'tank' ? 1.3 : u.type === 'elite' ? 0.9 : 1.0;
  audio.explosion(explodeScale);
  spawnParticles(s, u.pos.x, u.pos.y, u.type === 'tank' ? 36 : 26, '#ff5050', 220, 800);
  // Sat coins drop
  const coinCount = u.type === 'tank' ? 6 : u.type === 'elite' ? 5 : 4;
  spawnCoins(s, u.pos.x, u.pos.y, UFO_SATS[u.type], coinCount);
  const labels: Record<UfoType, string> = {
    cruiser: `+ UFO  +${UFO_POINTS.cruiser}`,
    elite: `+ ELITE  +${UFO_POINTS.elite}`,
    tank: `+ TANK  +${UFO_POINTS.tank}`,
    sniper: `+ SNIPER  +${UFO_POINTS.sniper}`,
    boss: `BOSS DOWN  +${UFO_POINTS.boss}`,
  };
  toastNow(s, labels[u.type]);
  if (u.type === 'boss') {
    s.bossDefeated = true;
    // Banked music carries the moment now — no synth triumph chime.
    // Victory drop — guaranteed bomb so any straggler debris vanishes
    maybeDropPowerUp(s, u.pos.x, u.pos.y, 'bomb');
  } else {
    // Random power-up drop on regular UFO kills
    maybeDropPowerUp(s, u.pos.x, u.pos.y);
  }
  maybeExtraLife(s);
}

// ── Bullets ───────────────────────────────────────────────────────────────────

export function fireBullet(s: GameState): void {
  if (!s.ship.alive) return;
  const mods = currentMods();
  const cos = Math.cos(s.ship.rot);
  const sin = Math.sin(s.ship.rot);
  const muzzleX = s.ship.pos.x + cos * (SHIP_RADIUS + 4);
  const muzzleY = s.ship.pos.y + sin * (SHIP_RADIUS + 4);
  const speed = BULLET_SPEED * mods.bulletSpeedMul;
  s.bullets.push({
    pos: { x: muzzleX, y: muzzleY },
    vel: { x: cos * speed + s.ship.vel.x * 0.4, y: sin * speed + s.ship.vel.y * 0.4 },
    radius: BULLET_RADIUS,
    alive: true,
    ttl: BULLET_TTL_MS,
  });
  audio.fire();
}

// ── Particles ─────────────────────────────────────────────────────────────────

/** Hard ceiling on the live particle buffer. Above this, fresh spawns get
 *  proportionally scaled down so a chain of explosions on a busy wave doesn't
 *  push the renderer into the red. Tuned by-eye against wave 7-8 stress. */
const MAX_PARTICLES = 240;

function spawnParticles(s: GameState, x: number, y: number, count: number, colour: string, speed = 100, ttl = 600): void {
  // Scale request down when the buffer is filling up — at the cap, requests
  // are reduced to ~25% of nominal so big visual moments still register but
  // don't compound.
  const headroom = MAX_PARTICLES - s.particles.length;
  const effective = headroom <= 0
    ? 0
    : headroom < count
      ? Math.max(1, Math.floor(headroom * 0.6))
      : count;
  for (let i = 0; i < effective; i++) {
    const angle = Math.random() * Math.PI * 2;
    const v = speed * (0.4 + Math.random() * 0.8);
    s.particles.push({
      pos: { x, y },
      vel: { x: Math.cos(angle) * v, y: Math.sin(angle) * v },
      ttl,
      maxTtl: ttl,
      colour,
      size: 1.5 + Math.random() * 1.5,
    });
  }
}

// ── Coins (sat drops) ─────────────────────────────────────────────────────────

/** Per-asteroid roll: in Nostr mode, 1-in-SAT_DROP_CHANCE_DENOM picks `sat`; the
 *  rest pick `dust`. Guest mode never picks `sat` — pickups stay non-monetary
 *  so we don't accumulate uncashable sats against an unsigned identity. */
function rollPickupKind(s: GameState): PickupKind {
  if (s.session === null) return 'dust';
  return Math.random() < (1 / SAT_DROP_CHANCE_DENOM) ? 'sat' : 'dust';
}

/** Score awarded per dust shard, scaled to the source so a small asteroid
 *  doesn't out-pay a large one. Tuned so a typical run nets a meaningful
 *  score boost without overshadowing the kill points themselves. */
const DUST_SCORE_BASE = 25;

function spawnCoins(s: GameState, x: number, y: number, value: number, count: number, kind?: PickupKind): void {
  const resolvedKind = kind ?? rollPickupKind(s);
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 30 + Math.random() * 40;
    // Sat coins split the source `value` (sats) across N drops; dust shards
    // each grant a fixed score bonus regardless of source size.
    const perPickup = resolvedKind === 'sat' ? value / count : DUST_SCORE_BASE;
    s.coins.push({
      pos: { x, y },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      radius: COIN_RADIUS,
      alive: true,
      ttl: COIN_TTL_MS,
      collected: false,
      kind: resolvedKind,
      value: perPickup,
    });
  }
}

// ── Update / collision ────────────────────────────────────────────────────────

function wrap(p: Vec2, margin = 0): void {
  // Inclusive boundaries — using strict `<` and `>` left a stable parking spot
  // exactly at p.x = -margin (and the three siblings) where an asteroid with
  // near-zero perpendicular velocity could sit off-screen forever, blocking
  // wave-clear. Inclusive `<=` / `>=` ensures any contact with the boundary
  // teleports.
  if (p.x <= -margin) p.x += WORLD_W + margin * 2;
  if (p.x >= WORLD_W + margin) p.x -= WORLD_W + margin * 2;
  if (p.y <= -margin) p.y += WORLD_H + margin * 2;
  if (p.y >= WORLD_H + margin) p.y -= WORLD_H + margin * 2;
}

function circlesHit(a: { pos: Vec2; radius: number }, b: { pos: Vec2; radius: number }): boolean {
  const dx = a.pos.x - b.pos.x;
  const dy = a.pos.y - b.pos.y;
  const r = a.radius + b.radius;
  return dx * dx + dy * dy <= r * r;
}

let fireCooldownUntil = 0;

export function tryActivateShield(s: GameState, now: number): boolean {
  if (!s.ship.alive) return false;
  if (s.ship.shieldUp) return false;
  if (now < s.ship.shieldReadyAt) return false;
  const mods = currentMods();
  s.ship.shieldUp = true;
  s.ship.shieldExpiresAt = now + SHIELD_DURATION_MS;
  s.ship.shieldReadyAt = now + SHIELD_DURATION_MS + SHIELD_COOLDOWN_MS * mods.shieldCooldownMul;
  audio.shieldUp();
  toastNow(s, 'SHIELD UP');
  return true;
}

export function shieldStatus(s: GameState, now: number): 'up' | 'cooling' | 'ready' {
  if (s.ship.shieldUp) return 'up';
  if (now < s.ship.shieldReadyAt) return 'cooling';
  return 'ready';
}

function dropShield(s: GameState, now: number): void {
  if (!s.ship.shieldUp) return;
  s.ship.shieldUp = false;
  // shieldReadyAt was already pre-set when activated; keep it.
  audio.shieldDown();
  void now;
}

/** Cancel an in-flight shield (e.g. on hyperspace). Cooldown still applies. */
export function cancelShield(s: GameState): void {
  if (!s.ship.shieldUp) return;
  s.ship.shieldUp = false;
}

export function tryHyperspace(s: GameState, now: number): void {
  if (!s.ship.alive) return;
  if (s.ship.hyperspaceCloakMs > 0) return;
  if (now < s.ship.hyperspaceReadyAt) return;
  const mods = currentMods();
  cancelShield(s);
  s.ship.hyperspaceReadyAt = now + HYPERSPACE_COOLDOWN_MS * mods.hyperspaceCooldownMul;
  s.ship.hyperspaceCloakMs = HYPERSPACE_CLOAK_MS;
  s.ship.vel.x = 0;
  s.ship.vel.y = 0;
  s.ship.rotVel = 0;
  // Roll the malfunction at jump time — the cloak then *visibly* signals it
  // (red distortion particles + glitched audio) rather than the player taking
  // an invisible RNG hit on emergence.
  s.ship.hyperspaceMalfunction = gameRng() < HYPERSPACE_MALFUNCTION_CHANCE;
  if (s.ship.hyperspaceMalfunction) {
    audio.warpJumpGlitch();
    // Sprinkle warning particles at the departure point so the cloak is visibly off
    spawnParticles(s, s.ship.pos.x, s.ship.pos.y, 18, '#ff5050', 140, 500);
    toastNow(s, 'WARP UNSTABLE');
  } else {
    audio.warpJump();
    toastNow(s, 'HYPERSPACE LOCK');
  }
  audio.thrustOff();
  // Re-emerge timer
  setTimeout(() => emergeHyperspace(s), HYPERSPACE_CLOAK_MS);
}

function emergeHyperspace(s: GameState): void {
  if (!s.ship.alive) return;
  if (s.ship.hyperspaceMalfunction) {
    s.ship.hyperspaceMalfunction = false;
    audio.explosion(1.2);
    // Implosion at the original departure point — a tighter, redder burst than a
    // generic explosion, so the player reads "the warp ate me" not "I exploded"
    spawnParticles(s, s.ship.pos.x, s.ship.pos.y, 36, '#ff5050', 320, 900);
    spawnParticles(s, s.ship.pos.x, s.ship.pos.y, 18, '#ffffff', 80, 400);
    s.ship.hyperspaceCloakMs = 0;
    s.lives -= 1;
    toastNow(s, 'HYPERSPACE BREACH');
    if (s.lives <= 0) {
      s.phase = 'gameover';
      s.phaseStart = performance.now();
      // Hull-breached music carries the moment now — no synth gameOver chime.
      audio.stopHeartbeat();
      audio.ufoSirenStop();
      audio.stopAmbient();
    } else {
      // Respawn at centre after malfunction
      setTimeout(() => respawnShip(s), 1200);
      s.ship.alive = false;
    }
    return;
  }
  // Try up to 12 random points away from threats
  let pos = { x: WORLD_W / 2, y: WORLD_H / 2 };
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidate = {
      x: 80 + gameRng() * (WORLD_W - 160),
      y: 80 + gameRng() * (WORLD_H - 160),
    };
    let safe = true;
    for (const a of s.asteroids) {
      if ((a.pos.x - candidate.x) ** 2 + (a.pos.y - candidate.y) ** 2 < (HYPERSPACE_SAFE_DIST + a.radius) ** 2) { safe = false; break; }
    }
    if (safe) for (const u of s.ufos) {
      if ((u.pos.x - candidate.x) ** 2 + (u.pos.y - candidate.y) ** 2 < (HYPERSPACE_SAFE_DIST + u.radius) ** 2) { safe = false; break; }
    }
    if (safe) { pos = candidate; break; }
  }
  s.ship.pos = pos;
  s.ship.hyperspaceCloakMs = 0;
  s.ship.invulnerableUntil = performance.now() + 800;
}

/** Exponential ease for the HUD sat counter — higher = faster catch-up. */
const SAT_TICK_RATE = 9;

let lastReplayRecordedAt = 0;

function recordReplaySnapshot(s: GameState, now: number): void {
  if (s.phase !== 'playing') return;
  if (now - lastReplayRecordedAt < REPLAY_RECORD_INTERVAL_MS) return;
  lastReplayRecordedAt = now;
  // Spread-copy each entity and its mutable Vec2 fields so the buffer doesn't
  // alias the live state (and get mutated frame-by-frame). The `shape` array
  // on asteroids is never mutated post-spawn so a shared ref is safe.
  const snap: ReplaySnapshot = {
    t: now,
    ship: { pos: { x: s.ship.pos.x, y: s.ship.pos.y }, rot: s.ship.rot, alive: s.ship.alive, thrusting: s.ship.thrusting },
    asteroids: s.asteroids.map(a => ({ ...a, pos: { x: a.pos.x, y: a.pos.y }, vel: { x: a.vel.x, y: a.vel.y } })),
    ufos: s.ufos.map(u => ({ ...u, pos: { x: u.pos.x, y: u.pos.y }, vel: { x: u.vel.x, y: u.vel.y } })),
    bullets: s.bullets.map(b => ({ ...b, pos: { x: b.pos.x, y: b.pos.y }, vel: { x: b.vel.x, y: b.vel.y } })),
    enemyBullets: s.enemyBullets.map(b => ({ ...b, pos: { x: b.pos.x, y: b.pos.y }, vel: { x: b.vel.x, y: b.vel.y } })),
    mines: s.mines.map(m => ({ ...m, pos: { x: m.pos.x, y: m.pos.y }, vel: { x: m.vel.x, y: m.vel.y } })),
  };
  s.replayBuffer.push(snap);
  if (s.replayBuffer.length > REPLAY_BUFFER_FRAMES) s.replayBuffer.shift();
}

/** Tear down sirens / heartbeat / ambient — shared by the direct game-over path
 *  and the post-replay transition so audio stops at the right moment. */
function stopGameplayAudio(): void {
  audio.stopHeartbeat();
  audio.ufoSirenStop();
  audio.stopAmbient();
}

/**
 * Begin (or restart, from the gameover REPLAY button) the death replay using
 * whatever's currently in `s.deathReplay`. Schedules the post-replay phase via
 * setTimeout — caller picks the destination ('gameover' on first run; back to
 * 'gameover' on replay-button restarts).
 */
export function startDeathReplay(s: GameState, after: 'gameover'): void {
  if (!s.deathReplay) return;
  s.deathReplay.startedAt = performance.now();
  s.phase = 'deathreplay';
  s.phaseStart = s.deathReplay.startedAt;
  audio.thrustOff();
  audio.ufoSirenStop();
  audio.setMusicDuck(0.2);
  setTimeout(() => {
    if (s.phase !== 'deathreplay') return;
    audio.setMusicDuck(1);
    s.phase = after;
    s.phaseStart = performance.now();
    if (after === 'gameover') {
      // Hull-breached music carries it; no synth chime.
      stopGameplayAudio();
    }
  }, REPLAY_TOTAL_WALL_MS);
}

/** Skip the in-progress replay — fast-forward to the gameover screen. */
export function skipDeathReplay(s: GameState): void {
  if (s.phase !== 'deathreplay') return;
  audio.setMusicDuck(1);
  s.phase = 'gameover';
  s.phaseStart = performance.now();
  stopGameplayAudio();
}

/**
 * Lurking detector — homage to the 1979 Asteroids saucer-aim exploit. The
 * player can park in dead centre and pick off drifting rocks indefinitely;
 * the strategy still works as a play option, but the moment the flag latches
 * coins stop crediting sats. Score still accumulates. Cleared instantly when
 * the ship leaves the zone or accelerates.
 */
function updateLurkState(s: GameState, now: number): void {
  if (s.phase !== 'playing' || !s.ship.alive) {
    if (s.lurking) s.lurking = false;
    s.lurkingSince = 0;
    return;
  }
  const dx = s.ship.pos.x - WORLD_W / 2;
  const dy = s.ship.pos.y - WORLD_H / 2;
  const distSq = dx * dx + dy * dy;
  const speedSq = s.ship.vel.x * s.ship.vel.x + s.ship.vel.y * s.ship.vel.y;
  const inZone = distSq < LURK_CENTRE_RADIUS_PX * LURK_CENTRE_RADIUS_PX
    && speedSq < LURK_VEL_THRESHOLD * LURK_VEL_THRESHOLD;
  if (inZone) {
    if (s.lurkingSince === 0) s.lurkingSince = now;
    const held = now - s.lurkingSince;
    if (!s.lurking && held >= LURK_DURATION_MS) {
      s.lurking = true;
    }
    // Easter-egg toast fires only after a longer commitment so it lands as
    // discovery, not a hair-trigger explainer. Suppressed if previously
    // shown this run.
    if (!s.lurkEverDetected && held >= LURK_TOAST_MS) {
      s.lurkEverDetected = true;
      toastNow(s, 'LURKING · 1979 RESPECT · NO SATS');
    }
  } else {
    s.lurking = false;
    s.lurkingSince = 0;
  }
}

function updateDisplaySats(s: GameState, dt: number): void {
  if (s.displaySats >= s.sats) { s.displaySats = s.sats; return; }
  const delta = s.sats - s.displaySats;
  // At least 1 sat/frame so high deltas don't crawl; cap to delta so we never overshoot.
  const step = Math.min(delta, Math.max(1, delta * SAT_TICK_RATE * dt));
  s.displaySats = Math.min(s.sats, s.displaySats + step);
}

export function updateGame(s: GameState, dt: number, now: number): void {
  s.elapsed += dt * 1000;

  // HUD ticker eases toward s.sats every frame regardless of phase, so the
  // counter still finishes its run-up under gameover / wavestart overlays.
  updateDisplaySats(s, dt);

  // Snapshot the world state for the death replay buffer (no-op outside 'playing').
  recordReplaySnapshot(s, now);

  // Detect the 1979 lurking exploit so coin credit can be withheld for it.
  updateLurkState(s, now);

  // Particles always update so they fade out across phase changes
  if (s.phase === 'title' || s.phase === 'paused' || s.phase === 'gameover' || s.phase === 'completed' || s.phase === 'deathreplay') {
    return;
  }

  // Warp: ship still moves, no enemies, fast forward to next wave
  if (s.phase === 'warp') {
    // freeze enemy spawning, drift ship slightly, no input
    return;
  }

  // Track total run time (only while actually playing)
  if (s.phase === 'playing') {
    s.runTimeMs += dt * 1000;
  }

  // ── Ship input ──
  const turnLeft = s.keys['ArrowLeft'] || s.keys['KeyA'];
  const turnRight = s.keys['ArrowRight'] || s.keys['KeyD'];
  const thrust = s.keys['ArrowUp'] || s.keys['KeyW'];
  const fire = s.keys['Space'];

  // Hyperspace cloak countdown
  if (s.ship.hyperspaceCloakMs > 0) {
    s.ship.hyperspaceCloakMs -= dt * 1000;
  }

  if (s.ship.alive && s.ship.hyperspaceCloakMs <= 0) {
    if (turnLeft) s.ship.rotVel -= SHIP_ROT_ACCEL * dt;
    if (turnRight) s.ship.rotVel += SHIP_ROT_ACCEL * dt;
    // Damping toward zero
    if (!turnLeft && !turnRight) {
      const sign = Math.sign(s.ship.rotVel);
      const newVel = s.ship.rotVel - sign * SHIP_ROT_DAMPING * dt;
      s.ship.rotVel = Math.sign(newVel) === sign ? newVel : 0;
    }
    s.ship.rotVel = Math.max(-SHIP_MAX_ROT, Math.min(SHIP_MAX_ROT, s.ship.rotVel));
    s.ship.rot += s.ship.rotVel * dt;

    s.ship.thrusting = thrust;
    if (thrust) {
      s.ship.thrustFrame += dt * 30;
      s.ship.vel.x += Math.cos(s.ship.rot) * SHIP_THRUST * dt;
      s.ship.vel.y += Math.sin(s.ship.rot) * SHIP_THRUST * dt;
      audio.thrustOn();
    } else {
      audio.thrustOff();
    }

    // Drag
    const dragK = Math.exp(-SHIP_DRAG * dt);
    s.ship.vel.x *= dragK;
    s.ship.vel.y *= dragK;

    s.ship.pos.x += s.ship.vel.x * dt;
    s.ship.pos.y += s.ship.vel.y * dt;
    wrap(s.ship.pos);

    if (fire && now >= fireCooldownUntil) {
      fireBullet(s);
      const rapid = now < s.rapidExpiresAt;
      fireCooldownUntil = now + (rapid ? FIRE_COOLDOWN_MS * RAPID_COOLDOWN_MUL : FIRE_COOLDOWN_MS);
    }
  }

  // ── Bullets ──
  for (const b of s.bullets) {
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.ttl -= dt * 1000;
    if (b.ttl <= 0) b.alive = false;
    else wrap(b.pos);
  }
  s.bullets = s.bullets.filter(b => b.alive);

  // ── Enemy bullets (don't wrap — feel different) ──
  for (const b of s.enemyBullets) {
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.ttl -= dt * 1000;
    if (b.ttl <= 0 || b.pos.x < -10 || b.pos.x > WORLD_W + 10 || b.pos.y < -10 || b.pos.y > WORLD_H + 10) {
      b.alive = false;
    }
  }
  s.enemyBullets = s.enemyBullets.filter(b => b.alive);

  // ── UFOs (boss never replaced; minions spawn alongside on boss wave) ──
  const mods = currentMods();
  const minionCount = s.ufos.filter(u => u.type !== 'boss').length;
  s.nextUfoSpawn -= dt * 1000;
  if (s.nextUfoSpawn <= 0 && minionCount === 0) {
    spawnUfo(s);
    const baseInterval = Math.max(UFO_RESPAWN_MIN_MS, UFO_RESPAWN_BASE_MS - s.wave * UFO_RESPAWN_PER_WAVE_MS);
    s.nextUfoSpawn = baseInterval * mods.ufoIntervalMul;
  }
  updateUfos(s, dt);

  // ── Mines (static — placed once at wave start by placeWaveMines) ──
  updateMines(s, dt, now);

  // ── Asteroids ──
  // Lurk-time tangential nudge: when the player is flagged lurking, asteroids
  // entering an outer skirt (1.6× the lurk zone) gain a small force perpendicular
  // to their radial vector, biased to match their current direction of motion.
  // The result is a gentle curve around the dead-zone — replicating the second
  // half of the 1979 bug (asteroid drift patterns left the centre disproportion-
  // ately empty). Cleared instantly when lurking ends.
  const LURK_NUDGE_RADIUS = LURK_CENTRE_RADIUS_PX * 1.6;
  const LURK_NUDGE_ACCEL = 90;  // px/s²; gentle enough that fast asteroids still cut through
  for (const a of s.asteroids) {
    if (s.lurking) {
      const dx = a.pos.x - WORLD_W / 2;
      const dy = a.pos.y - WORLD_H / 2;
      const distSq = dx * dx + dy * dy;
      if (distSq < LURK_NUDGE_RADIUS * LURK_NUDGE_RADIUS && distSq > 1) {
        const dist = Math.sqrt(distSq);
        // Falloff: strongest at the centre, zero at the skirt edge
        const strength = 1 - dist / LURK_NUDGE_RADIUS;
        // Two perpendicular candidates; pick the one closer to current velocity
        const tx1 = -dy / dist, ty1 = dx / dist;
        const dot1 = a.vel.x * tx1 + a.vel.y * ty1;
        const tx = dot1 >= 0 ? tx1 : -tx1;
        const ty = dot1 >= 0 ? ty1 : -ty1;
        a.vel.x += tx * LURK_NUDGE_ACCEL * strength * dt;
        a.vel.y += ty * LURK_NUDGE_ACCEL * strength * dt;
      }
    }
    a.pos.x += a.vel.x * dt;
    a.pos.y += a.vel.y * dt;
    a.rot += a.rotVel * dt;
    if (a.hitFlash > 0) a.hitFlash = Math.max(0, a.hitFlash - dt * 4);
    wrap(a.pos, RADIUS_PER_SIZE.large);
  }

  // ── Shield expiry ──
  if (s.ship.shieldUp && now >= s.ship.shieldExpiresAt) {
    dropShield(s, now);
  }

  // ── Particles ──
  for (const p of s.particles) {
    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.ttl -= dt * 1000;
    p.vel.x *= Math.exp(-1.5 * dt);
    p.vel.y *= Math.exp(-1.5 * dt);
  }
  s.particles = s.particles.filter(p => p.ttl > 0);

  // ── Coins ──
  for (const c of s.coins) {
    c.pos.x += c.vel.x * dt;
    c.pos.y += c.vel.y * dt;
    c.ttl -= dt * 1000;
    c.vel.x *= Math.exp(-0.8 * dt);
    c.vel.y *= Math.exp(-0.8 * dt);
    if (c.ttl <= 0) c.alive = false;
    wrap(c.pos);

    // Pull toward ship within range
    if (s.ship.alive) {
      const dx = s.ship.pos.x - c.pos.x;
      const dy = s.ship.pos.y - c.pos.y;
      const distSq = dx * dx + dy * dy;
      const pullRange = 80;
      if (distSq < pullRange * pullRange) {
        const dist = Math.sqrt(distSq);
        const pull = 380 * (1 - dist / pullRange);
        c.vel.x += (dx / dist) * pull * dt;
        c.vel.y += (dy / dist) * pull * dt;
      }
    }
  }
  s.coins = s.coins.filter(c => c.alive && !c.collected);

  // ── Collisions: bullets × asteroids ──
  for (const b of s.bullets) {
    if (!b.alive) continue;
    for (const a of s.asteroids) {
      if (!a.alive) continue;
      if (circlesHit(b, a)) {
        b.alive = false;
        damageAsteroid(s, a);
        break;
      }
    }
  }

  // ── Collisions: bullets × UFOs ──
  for (const b of s.bullets) {
    if (!b.alive) continue;
    for (const u of s.ufos) {
      if (!u.alive) continue;
      if (circlesHit(b, u)) {
        b.alive = false;
        damageUfo(s, u);
        break;
      }
    }
  }

  // ── Collisions: bullets × mines ──
  for (const b of s.bullets) {
    if (!b.alive) continue;
    for (const m of s.mines) {
      if (!m.alive) continue;
      if (circlesHit(b, m)) {
        b.alive = false;
        destroyMine(s, m);
        break;
      }
    }
  }

  // ── Shield deflection of mines ──
  if (s.ship.alive && s.ship.shieldUp) {
    for (const m of s.mines) {
      if (!m.alive) continue;
      if (circlesHit(s.ship, m)) {
        destroyMine(s, m);
        spawnParticles(s, m.pos.x, m.pos.y, 12, '#5b9dff', 200, 400);
        audio.shieldHit();
      }
    }
  }

  // ── Shield deflection (runs before damage check) ──
  if (s.ship.alive && s.ship.shieldUp) {
    for (const a of s.asteroids) {
      if (!a.alive) continue;
      if (circlesHit(s.ship, a)) {
        const dx = a.pos.x - s.ship.pos.x;
        const dy = a.pos.y - s.ship.pos.y;
        const distSq = dx * dx + dy * dy;
        const dist = Math.sqrt(distSq) || 1;
        const nx = dx / dist;
        const ny = dy / dist;
        const vDot = a.vel.x * nx + a.vel.y * ny;
        if (vDot < 0) {
          // Reflect velocity along the normal, give a small extra kick
          a.vel.x -= 2 * vDot * nx * 1.05;
          a.vel.y -= 2 * vDot * ny * 1.05;
          // Push apart so we don't get stuck inside the shield
          const overlap = s.ship.radius + a.radius + 4 - dist;
          if (overlap > 0) {
            a.pos.x += nx * overlap;
            a.pos.y += ny * overlap;
          }
          spawnParticles(s, (s.ship.pos.x + a.pos.x) / 2, (s.ship.pos.y + a.pos.y) / 2, 10, '#5b9dff', 220, 380);
          audio.shieldHit();
        }
      }
    }
    for (const b of s.enemyBullets) {
      if (!b.alive) continue;
      if (circlesHit(s.ship, b)) {
        b.alive = false;
        spawnParticles(s, b.pos.x, b.pos.y, 8, '#5b9dff', 180, 320);
        audio.shieldHit();
      }
    }
  }

  // ── Collisions: ship × asteroids / UFOs / enemy bullets ──
  if (s.ship.alive && !s.ship.shieldUp && s.ship.hyperspaceCloakMs <= 0 && now > s.ship.invulnerableUntil) {
    for (const a of s.asteroids) {
      if (a.alive && circlesHit(s.ship, a)) {
        killShip(s);
        break;
      }
    }
    for (const u of s.ufos) {
      if (s.ship.alive && u.alive && circlesHit(s.ship, u)) {
        destroyUfo(s, u);  // ramming kills the UFO too
        killShip(s);
        break;
      }
    }
    for (const b of s.enemyBullets) {
      if (s.ship.alive && b.alive && circlesHit(s.ship, b)) {
        if (s.lurking) {
          // Lurk-mode UFO immunity: the 1979 saucer-aim bug had a centre blind
          // spot. Bullet passes through with a small puff so the player sees
          // the bullet "missed" rather than the collision being silently
          // swallowed. Bullet still consumed so it doesn't hit twice.
          b.alive = false;
          spawnParticles(s, b.pos.x, b.pos.y, 4, '#5b9dff', 80, 200);
          continue;
        }
        b.alive = false;
        killShip(s);
        break;
      }
    }
    for (const m of s.mines) {
      if (s.ship.alive && m.alive && circlesHit(s.ship, m)) {
        destroyMine(s, m);
        killShip(s);
        break;
      }
    }
  }

  // ── Collisions: ship × coins (sat coins or dust shards) ──
  if (s.ship.alive) {
    const satMul = now < s.satboostExpiresAt ? SATBOOST_MUL : 1;
    for (const c of s.coins) {
      if (!c.alive || c.collected) continue;
      if (circlesHit(s.ship, c)) {
        c.collected = true;
        if (c.kind === 'sat') {
          const credit = Math.max(1, Math.round(c.value * satMul));
          if (s.lurking) s.lurkSatsBlocked += credit;
          else s.sats += credit;
          audio.coinPickup();
          spawnParticles(s, c.pos.x, c.pos.y, 6, '#ffd84a', 80, 350);
        } else {
          // Dust shard — pure score, never blocked by lurking (it's not sats).
          s.score += Math.max(1, Math.round(c.value));
          audio.dustPickup();
          spawnParticles(s, c.pos.x, c.pos.y, 5, '#7fffb0', 70, 300);
        }
      }
    }
  }

  // ── Power-up update + collect ──
  if (s.powerups.length > 0) {
    for (const p of s.powerups) {
      if (!p.alive || p.collected) continue;
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.vel.x *= Math.exp(-0.6 * dt);
      p.vel.y *= Math.exp(-0.6 * dt);
      p.ttl -= dt * 1000;
      if (p.ttl <= 0) p.alive = false;
      wrap(p.pos);
      if (s.ship.alive && circlesHit(s.ship, p)) {
        p.collected = true;
        applyPowerUp(s, p, now);
        spawnParticles(s, p.pos.x, p.pos.y, 14, '#ffffff', 200, 600);
      }
    }
    s.powerups = s.powerups.filter(p => p.alive && !p.collected);
  }

  // Sweep dead asteroids
  s.asteroids = s.asteroids.filter(a => a.alive);

  // Wave clear? Trigger warp transition (or completion if wave 25 boss is down).
  if (s.phase === 'playing') {
    const asteroidsClear = s.asteroids.length === 0;
    if (s.wave === FINAL_WAVE) {
      // Wave 25 completion: boss down AND the arena is fully clean. Mopping
      // up the lingering asteroids and UFO escorts after the kill is the
      // earned exhale before the credits roll.
      const ufosClear = s.ufos.length === 0;
      if (s.bossDefeated && asteroidsClear && ufosClear) {
        triggerCompletion(s);
      }
    } else if (asteroidsClear) {
      // Despawn UFOs/mines/enemy bullets and auto-bank any uncollected coins
      clearStage(s, { autoCollect: true });
      audio.ufoSirenStop();
      startWarp(s);
    }
  }

  // Combo decay
  if (s.combo > 0 && now > s.comboExpiresAt) {
    s.combo = 0;
  }

  // Toast expiry
  if (s.toast && now > s.toastUntil) {
    s.toast = null;
  }
}

/**
 * Advance the kill chain. Returns the multiplier to apply to this kill's score.
 * First kill of a fresh chain returns 1; subsequent kills within COMBO_WINDOW_MS
 * return 2, 3, 4, 5 (capped). Plays a rising tick at each step.
 */
function recordCombo(s: GameState, now: number): number {
  if (now < s.comboExpiresAt && s.combo > 0) {
    s.combo = Math.min(COMBO_MAX, s.combo + 1);
  } else {
    s.combo = 1;
  }
  s.comboExpiresAt = now + COMBO_WINDOW_MS;
  if (s.combo >= 2) audio.comboTick(s.combo);
  return s.combo;
}

function resetCombo(s: GameState): void {
  s.combo = 0;
  s.comboExpiresAt = 0;
}

/**
 * Apply one bullet's worth of damage to an asteroid. Iron at large size has hp=2
 * — first hit flashes and dents, second hit fragments. All other cases are 1hp.
 */
function damageAsteroid(s: GameState, a: Asteroid): void {
  a.hp -= 1;
  a.hitFlash = 1;
  if (a.hp <= 0) {
    breakAsteroid(s, a);
  } else {
    const cfg = ASTEROID_TYPE_CONFIG[a.type];
    audio.hit();
    spawnParticles(s, a.pos.x, a.pos.y, 5, cfg.glow, 110, 280);
  }
}

function breakAsteroid(s: GameState, a: Asteroid): void {
  a.alive = false;
  const cfg = ASTEROID_TYPE_CONFIG[a.type];
  const mul = recordCombo(s, performance.now());
  s.score += Math.round(POINTS_PER_SIZE[a.size] * cfg.scoreMul * mul);
  const satsValue = SATS_PER_SIZE[a.size] * cfg.satMul;

  // Particles tinted to the type's accent
  spawnParticles(s, a.pos.x, a.pos.y, a.size === 'large' ? 18 : a.size === 'medium' ? 12 : 8, cfg.glow, 140, 700);

  // Coins drop — value scales with type's sat multiplier
  const coinCount = a.size === 'large' ? 4 : a.size === 'medium' ? 2 : 1;
  spawnCoins(s, a.pos.x, a.pos.y, satsValue, coinCount);

  audio.explosion(a.size === 'large' ? 1.0 : a.size === 'medium' ? 0.8 : 0.6);

  // Spawn smaller children — same type carries over so a chondrite swarm stays a swarm
  if (a.size === 'large' || a.size === 'medium') {
    const childSize: AsteroidSize = a.size === 'large' ? 'medium' : 'small';
    const count = cfg.breakInto;
    const baseAngle = Math.atan2(a.vel.y, a.vel.x);
    const spread = count === 2 ? 1.2 : 0.6;
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * spread;
      const angle = baseAngle + offset;
      const speed = Math.hypot(a.vel.x, a.vel.y) * 1.2;
      const vel: Vec2 = { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed };
      s.asteroids.push(spawnAsteroid(childSize, s.wave, { x: a.pos.x, y: a.pos.y }, vel, a.type));
    }
  }

  // Pallasite jackpot signal on the final shard
  if (a.type === 'pallasite' && a.size === 'small') {
    toastNow(s, `PALLASITE +${Math.max(1, Math.round(satsValue))} sats`);
  }

  maybeExtraLife(s);
}

function maybeExtraLife(s: GameState): void {
  // Every 10000 score, +1 life (cap at 5)
  const earnedLives = Math.floor(s.score / 10000);
  // Track how many we've granted via lives count: starting 3 + earned
  const targetLives = Math.min(5, 3 + earnedLives);
  if (s.lives < targetLives) {
    s.lives = targetLives;
    audio.extraLife();
    toastNow(s, '+ EXTRA LIFE');
  }
}

function killShip(s: GameState): void {
  s.ship.alive = false;
  resetCombo(s);
  audio.explosion(1.4);
  audio.thrustOff();
  spawnParticles(s, s.ship.pos.x, s.ship.pos.y, 30, '#58ff58', 200, 900);
  s.lives -= 1;
  if (s.lives <= 0) {
    // Final death — capture the buffer for the replay, then route through
    // 'deathreplay' (provided we have something worth showing). The post-replay
    // setTimeout stops the ambient bed; hull-breached music carries the moment.
    if (s.replayBuffer.length >= 8) {
      s.deathReplay = {
        snapshots: s.replayBuffer.slice(),
        startedAt: performance.now(),
        spanMs: s.replayBuffer[s.replayBuffer.length - 1].t - s.replayBuffer[0].t,
      };
      startDeathReplay(s, 'gameover');
    } else {
      s.phase = 'gameover';
      s.phaseStart = performance.now();
      // Hull-breached music carries it; no synth chime.
      stopGameplayAudio();
    }
  } else {
    setTimeout(() => respawnShip(s), 1500);
  }
}

function respawnShip(s: GameState): void {
  if (s.phase === 'gameover') return;
  s.ship = makeShip();
  s.ship.invulnerableUntil = performance.now() + SHIP_INVULN_MS;
  toastNow(s, '');
}

export function pauseGame(s: GameState): void {
  if (s.phase !== 'playing') return;
  s.phase = 'paused';
  audio.thrustOff();
  audio.stopHeartbeat();
  audio.ufoSirenStop();
  audio.stopAmbient();
}

export function resumeGame(s: GameState): void {
  if (s.phase !== 'paused') return;
  s.phase = 'playing';
  audio.startHeartbeat();
  audio.startAmbient();
  if (s.ufos.some(u => u.alive)) audio.ufoSirenStart();
}

export function toastNow(s: GameState, text: string): void {
  if (!text) {
    s.toast = null;
    return;
  }
  s.toast = text;
  s.toastUntil = performance.now() + 2500;
}
