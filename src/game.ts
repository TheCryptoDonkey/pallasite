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
  REPLAY_RECORD_INTERVAL_MS, REPLAY_BUFFER_FRAMES, REPLAY_TOTAL_WALL_MS, REPLAY_EXPLOSION_WALL_MS,
  REPLAY_SLOW_MS, REPLAY_SLOW_RATE, REPLAY_EXPLOSION_MS,
  LURK_CENTRE_RADIUS_PX, LURK_VEL_THRESHOLD, LURK_DURATION_MS, LURK_TOAST_MS,
  SAT_DROP_CHANCE_DENOM, WARP_SKIP_AFTER_MS,
} from './types.js';
import type { PickupKind } from './types.js';
import type { ReplaySnapshot, Debris } from './types.js';
import {
  WORLD_W, WORLD_H, WARP_MS,
  SHIP_RADIUS, SHIP_THRUST, SHIP_DRAG, SHIP_ROT_ACCEL, SHIP_ROT_DAMPING, SHIP_MAX_ROT, SHIP_INVULN_MS, FIRE_COOLDOWN_MS,
  HYPERSPACE_COOLDOWN_MS, HYPERSPACE_CLOAK_MS, HYPERSPACE_MALFUNCTION_CHANCE, HYPERSPACE_SAFE_DIST,
  HYPERSPACE_CONSECUTIVE_WINDOW_MS, HYPERSPACE_DETONATE_RANGE,
  SHIELD_DURATION_MS, SHIELD_COOLDOWN_MS,
  BULLET_SPEED, BULLET_TTL_MS, BULLET_RADIUS,
  ASTEROID_BASE_SPEED, ASTEROID_SPEED_PER_WAVE,
  COIN_RADIUS, COIN_TTL_MS,
  POINTS_PER_SIZE, SATS_PER_SIZE, RADIUS_PER_SIZE,
  UFO_RADIUS, UFO_SPEED, UFO_HP, UFO_SHOT_SPREAD, UFO_SHOOT_INTERVAL, UFO_BULLET_SPEED_MUL,
  UFO_BULLET_SPEED, UFO_BULLET_TTL_MS, UFO_LIFETIME_MS,
  UFO_ZIG_INTERVAL_MS, UFO_POINTS, UFO_SATS,
  UFO_FIRST_SPAWN_MS, UFO_RESPAWN_BASE_MS, UFO_RESPAWN_PER_WAVE_MS, UFO_RESPAWN_MIN_MS,
  bossPhaseForHp,
  UFO_TYPE_BY_WAVE,
  MINE_RADIUS, MINE_GRAVITY_RANGE, MINE_GRAVITY_STRENGTH, MINE_POINTS, MINE_SATS_DROP, MINE_HP_BASE,
  MINE_CANDIDATE_POSITIONS, MINE_COUNT_BY_WAVE,
  COMBO_WINDOW_MS, COMBO_MAX,
  POWERUP_CONFIG, POWERUP_DROP_CHANCE, POWERUP_TTL_MS, POWERUP_RADIUS,
  RAPID_COOLDOWN_MUL, SATBOOST_MUL,
  TRIDENT_SPREAD, MAGNET_MAX_ACCEL, MAGNET_RANGE,
} from './types.js';
import type { PowerUp, PowerUpType } from './types.js';
import * as audio from './audio.js';
import { preloadBackground, getCollisionWrap, getVisibleBoundsW } from './render.js';
import { currentMods, lockInDifficulty, getStoredDifficulty } from './difficulty.js';
import { gameRng } from './seed.js';
import { haptic } from './haptics.js';
import { markSkinUnlocked } from './skins.js';

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
    debris: [],
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
    runStartedAt: 0,
    bossDefeated: false,
    combo: 0,
    comboExpiresAt: 0,
    hitStopUntil: 0,
    rapidExpiresAt: 0,
    satboostExpiresAt: 0,
    tridentExpiresAt: 0,
    magnetExpiresAt: 0,
    session: null,
    profile: null,
    keys: {},
    toast: null,
    toastUntil: 0,
    replayBuffer: [],
    deathReplay: null,
    initialsEnteredThisRun: false,
    lurking: false,
    lurkingSince: 0,
    lurkSatsBlocked: 0,
    lurkEverDetected: false,
    cheatedThisRun: false,
    bonusLivesGranted: 0,
    targetHeading: null,
    thrustOverride: false,
    runStats: {
      ufoKills: { cruiser: 0, elite: 0, tank: 0, sniper: 0, boss: 0 },
      minesDestroyed: 0,
      largestCombo: 0,
      powerupsCollected: 0,
    },
    ghostSamples: [],
    ghostPoseSamples: [],
    cameraTrauma: 0,
    shieldUsedThisWave: false,
    bulletsFiredThisWave: 0,
    missedShotsThisWave: 0,
    ufoSpawnedThisWave: false,
    ufoKilledThisWave: false,
  };
}

/** Add to the screen-shake trauma accumulator. Clamped 0..1 so a barrage of
 *  small hits never builds past death-impact magnitude. The renderer reads
 *  trauma² so headshake feels quadratic anyway. Reduced-motion users have
 *  this drained to zero by render rather than by skipping bumps — keeps the
 *  state machine honest. */
export function bumpTrauma(s: GameState, amount: number): void {
  s.cameraTrauma = Math.min(1, s.cameraTrauma + amount);
}

/** Freeze the simulation for `ms` to let an impact land. Render keeps running.
 *  Takes the max of any in-flight hit-stop so a brief later event can't shorten
 *  a longer earlier one (e.g. boss-down should not be cut by a stray combo hit). */
export function hitStop(s: GameState, ms: number): void {
  const target = performance.now() + ms;
  if (target > s.hitStopUntil) s.hitStopUntil = target;
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
    recoilOffset: 0,
    lastHyperspaceAt: 0,
  };
}

export function startGame(s: GameState): void {
  // Defensive re-lock — the title-screen IGNITE path also locks, but the
  // gameover SPAWN AGAIN and completion IGNITE AGAIN buttons jump straight
  // here. Without this, switching difficulty between runs (via TO TITLE then
  // back) wouldn't take effect on the next press of SPAWN AGAIN.
  lockInDifficulty(getStoredDifficulty());
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
  s.runStartedAt = Date.now();
  s.bossDefeated = false;
  s.combo = 0;
  s.comboExpiresAt = 0;
  s.rapidExpiresAt = 0;
  s.satboostExpiresAt = 0;
  s.tridentExpiresAt = 0;
  s.magnetExpiresAt = 0;
  s.warpTargetWave = 1;
  s.elapsed = 0;
  s.toast = null;
  s.toastUntil = 0;
  s.keys = {};
  s.replayBuffer = [];
  s.deathReplay = null;
  s.initialsEnteredThisRun = false;
  s.debris = [];
  s.lurking = false;
  s.lurkingSince = 0;
  s.lurkSatsBlocked = 0;
  s.lurkEverDetected = false;
  s.cheatedThisRun = false;
  s.bonusLivesGranted = 0;
  s.targetHeading = null;
  s.thrustOverride = false;
  s.runStats = {
    ufoKills: { cruiser: 0, elite: 0, tank: 0, sniper: 0, boss: 0 },
    minesDestroyed: 0,
    largestCombo: 0,
    powerupsCollected: 0,
  };
  s.ghostSamples = [];
  s.ghostPoseSamples = [];
  s.cameraTrauma = 0;
  lastGhostSampleRunMs = -1;
  lastGhostPoseRunMs = -1;
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
  // Wave-end bonus tracking — reset every wave so each one stands on its own.
  s.shieldUsedThisWave = false;
  s.bulletsFiredThisWave = 0;
  s.missedShotsThisWave = 0;
  s.ufoSpawnedThisWave = false;
  s.ufoKilledThisWave = false;
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
  // Switch to wavestart unconditionally — the warp transition is done by the
  // time beginWave fires (1300ms after startWarp), so leaving phase='warp' just
  // suppresses the cinematic drawWaveBanner that wave 1 gets. Wave 1 from a
  // fresh start lands here too because s.phase is 'title'.
  s.phase = 'wavestart';
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

const WAVESTART_MS = 4000;
const WAVE_REVEAL_DELAY_MS = 400;
/** Earliest moment after wavestart begins that a tap/key can skip — give the
 *  banner enough time to fully fade in so accidental skips don't show nothing. */
const WAVESTART_SKIP_AFTER_MS = 900;

/** Cut a wavestart short on user input. Safe to call from any phase — no-op
 *  unless we're actually in wavestart and past the skip-allowed window. */
export function skipWaveStart(s: GameState): void {
  if (s.phase !== 'wavestart') return;
  const elapsed = performance.now() - s.phaseStart;
  if (elapsed < WAVESTART_SKIP_AFTER_MS) return;
  audio.setMusicDuck(1);
  s.phase = 'playing';
}

function startWarp(s: GameState, targetWave?: number): void {
  const next = targetWave ?? s.wave + 1;
  s.phase = 'warp';
  s.phaseStart = performance.now();
  s.warpTargetWave = next;
  audio.warpJump();
  haptic('celebrate');
  setTimeout(() => {
    if (s.phase === 'warp') {
      beginWave(s, next);
    }
  }, WARP_MS);
}

/** Cut a long warp short on user input. No-op outside warp or before the
 *  skip window opens (so accidental taps right at warp-start don't skip). */
export function skipWarp(s: GameState): void {
  if (s.phase !== 'warp') return;
  const elapsed = performance.now() - s.phaseStart;
  if (elapsed < WARP_SKIP_AFTER_MS) return;
  beginWave(s, s.warpTargetWave);
}

/** Cheat: skip to a specific wave. Clears stage, kicks off warp. */
export function cheatJumpToWave(s: GameState, wave: number): void {
  if (s.phase !== 'playing' && s.phase !== 'wavestart' && s.phase !== 'warp') return;
  const target = Math.max(1, Math.min(99, Math.floor(wave)));
  // First cheat use voids the run's sat earnings and locks the cheat flag for
  // any subsequent score publish. Score still accrues — score is bragging
  // rights; sats are money.
  if (!s.cheatedThisRun) {
    s.cheatedThisRun = true;
    if (s.sats > 0) {
      s.lurkSatsBlocked += s.sats;  // accounted as forfeited for the gameover breakdown
      s.sats = 0;
    }
    toastNow(s, '► CHEAT · SATS VOIDED');
  }
  clearStage(s, { autoCollect: false });
  audio.ufoSirenStop();
  // Preload the target wave so the warp banner doesn't flash a missing image
  preloadBackground(target);
  toastNow(s, `► CHEAT: WAVE ${target}`);
  startWarp(s, target);
}

// ── Power-ups ─────────────────────────────────────────────────────────────────

const POWERUP_TYPES_NOSTR: PowerUpType[] = ['rapid', 'satboost', 'nova', 'trident', 'magnet'];
const POWERUP_TYPES_GUEST: PowerUpType[] = ['rapid', 'nova', 'trident', 'magnet'];  // satboost has nothing to boost in guest mode

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
  } else if (p.type === 'trident') {
    s.tridentExpiresAt = Math.max(s.tridentExpiresAt, now) + cfg.durationMs;
  } else if (p.type === 'magnet') {
    s.magnetExpiresAt = Math.max(s.magnetExpiresAt, now) + cfg.durationMs;
  } else if (p.type === 'nova') {
    detonateNova(s);
  }
  toastNow(s, cfg.pickupLabel);
  audio.powerupPickup();
}

/**
 * NOVA: clears enemy bullets, breaks every asteroid, destroys non-boss UFOs
 * (boss takes 3 damage), wipes mines. SCORE-ONLY — wiped asteroids skip the
 * coin spawn so the player can't farm sats with a powerup. Combo still chains.
 */
function detonateNova(s: GameState): void {
  for (const a of [...s.asteroids]) {
    if (a.alive) breakAsteroid(s, a, { suppressCoins: true });
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
  spawnParticles(s, WORLD_W / 2, WORLD_H / 2, 60, '#ff5050', 360, 1100);
  spawnParticles(s, WORLD_W / 2, WORLD_H / 2, 30, '#ffffff', 480, 700);
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
      // Lurking and cheating both forfeit the wave-clear sat bank; dust score
      // is never blocked because it's not money.
      if (s.lurking || s.cheatedThisRun) {
        s.lurkSatsBlocked += bankedSats;
        toastNow(s, s.cheatedThisRun ? `CHEAT · ${bankedSats} sats forfeit` : `LURK · ${bankedSats} sats forfeit`);
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
    bossPhase: 1,
  };
}

function spawnUfo(s: GameState): void {
  s.ufoSpawnedThisWave = true;
  const type = pickUfoType(s.wave);
  const dir: 1 | -1 = gameRng() < 0.5 ? 1 : -1;
  // Spawn the UFO just off the *visible* edge so it drifts onto the screen
  // from off-screen on phones. Spawning at the world edge (-radius) in
  // modern portrait crop puts the +visW ghost copy directly in the middle
  // of the visible band — the player sees a UFO blink into existence
  // mid-screen instead of arriving from outside. getVisibleBoundsW returns
  // the world-edge in retro/landscape, so this is a no-op there.
  const visBounds = getVisibleBoundsW();
  const y = visBounds.top + (visBounds.bottom - visBounds.top) * (0.15 + gameRng() * 0.7);
  const x = dir === 1 ? visBounds.left - UFO_RADIUS[type] : visBounds.right + UFO_RADIUS[type];
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
    bossPhase: 1,
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

    // Despawn when the UFO leaves the visible band on its travel side. Using
    // the visible band rather than the world edge so a UFO that spawns at
    // the band edge in modern portrait actually exits cleanly — otherwise
    // it lingers off-screen for seconds while traversing the wider world.
    // Boss never despawns this way.
    if (u.type !== 'boss') {
      const visBounds = getVisibleBoundsW();
      if (u.dir === 1  && u.pos.x > visBounds.right + u.radius * 2) u.alive = false;
      if (u.dir === -1 && u.pos.x < visBounds.left  - u.radius * 2) u.alive = false;
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
      if (u.type === 'tank') {
        u.shootTimer = UFO_SHOOT_INTERVAL[u.type];
        ufoFanShoot(s, u, s.ship.pos);
      } else if (u.type === 'boss') {
        // Per-phase boss combat. Cadence accelerates and the attack mix
        // escalates: P1 aimed, P2 alternates aimed+fan, P3 throws in radial
        // bullet curtains on top so the player has to dance, not snipe.
        if (u.bossPhase === 1) {
          u.shootTimer = 900;
          ufoShootAt(s, u, s.ship.pos);
        } else if (u.bossPhase === 2) {
          u.shootTimer = 700;
          if (Math.random() < 0.45) ufoFanShoot(s, u, s.ship.pos);
          else ufoShootAt(s, u, s.ship.pos);
        } else {
          u.shootTimer = 500;
          const roll = Math.random();
          if (roll < 0.30) ufoRadialShoot(s, u);
          else if (roll < 0.65) ufoFanShoot(s, u, s.ship.pos);
          else ufoShootAt(s, u, s.ship.pos);
        }
      } else {
        u.shootTimer = UFO_SHOOT_INTERVAL[u.type];
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
    pierceLeft: 0,
    caromHit: false,
    wrapped: false,
    hasLanded: false,
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
      pierceLeft: 0,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
    });
  }
  audio.ufoShoot();
}

/** 8-spoke radial bullet curtain — boss phase-3 signature attack. Fires
 *  evenly around the boss with a slight random rotation per volley so the
 *  player can't memorise a single lane. */
function ufoRadialShoot(s: GameState, u: Ufo): void {
  const mods = currentMods();
  const spokes = 8;
  const baseRot = gameRng() * (Math.PI * 2);
  const speed = UFO_BULLET_SPEED * UFO_BULLET_SPEED_MUL.boss * mods.ufoBulletSpeedMul * 0.85;
  for (let i = 0; i < spokes; i++) {
    const angle = baseRot + (Math.PI * 2 * i) / spokes;
    s.enemyBullets.push({
      pos: { x: u.pos.x, y: u.pos.y },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      radius: BULLET_RADIUS + 1,
      alive: true,
      ttl: UFO_BULLET_TTL_MS,
      pierceLeft: 0,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
    });
  }
  audio.ufoShoot();
}

// ── Mines ─────────────────────────────────────────────────────────────────────

function makeMine(pos: Vec2, hp: number = MINE_HP_BASE): Mine {
  return {
    pos: { x: pos.x, y: pos.y },
    vel: { x: 0, y: 0 },     // static — never drifts
    radius: MINE_RADIUS,
    alive: true,
    age: 0,
    gravityRange: MINE_GRAVITY_RANGE,
    hp,
    hitFlash: 0,
  };
}

/** One bullet's worth of damage. Flashes on a non-fatal hit; destroys
 *  on the killing blow with the existing payout/effects path. */
function damageMine(s: GameState, m: Mine): void {
  m.hp -= 1;
  m.hitFlash = 1;
  if (m.hp <= 0) {
    destroyMine(s, m);
  } else {
    audio.hit();
    spawnParticles(s, m.pos.x, m.pos.y, 5, '#ff5050', 110, 280);
  }
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
  s.runStats.minesDestroyed += 1;
  const mul = recordCombo(s, performance.now());
  s.score += MINE_POINTS * mul;
  audio.explosion(0.7);
  spawnParticles(s, m.pos.x, m.pos.y, 14, '#ff5050', 200, 600);
  spawnCoins(s, m.pos.x, m.pos.y, MINE_SATS_DROP, 2);
  // Mines are anchored danger — clearing one should feel substantial.
  bumpTrauma(s, 0.32);
  hitStop(s, 60);
  audio.pulseDuck(0.55, 220);
  haptic('thump');
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

  // Boss hits punch — every shot that lands on the wave-25 boss should feel
  // earned. Tank hits rumble too because they're rare and the chunky frame
  // wants weight. Other UFOs are handled at destroy-time only.
  if (u.type === 'boss') {
    bumpTrauma(s, 0.16);
    hitStop(s, 35);
  } else if (u.type === 'tank' && u.hp > 0) {
    bumpTrauma(s, 0.10);
  }

  // Boss drops mines around itself at every 5 HP threshold (P1+P2 drop 3,
  // P3 drops 5 because the bullet curtain isn't enough on its own).
  if (u.type === 'boss' && u.hp > 0 && u.hp % 5 === 0) {
    const mineCount = u.bossPhase === 3 ? 5 : 3;
    for (let i = 0; i < mineCount; i++) {
      const angle = (Math.PI * 2 * i) / mineCount + Math.random() * 0.4;
      const dist = 90 + Math.random() * 40;
      const x = u.pos.x + Math.cos(angle) * dist;
      const y = u.pos.y + Math.sin(angle) * dist;
      if (x > 30 && x < WORLD_W - 30 && y > 30 && y < WORLD_H - 30) {
        s.mines.push(makeMine({ x, y }));
      }
    }
    bumpTrauma(s, 0.30);
    hitStop(s, 140);
    toastNow(s, `BOSS: ${u.hp} HP · MINES DEPLOYED`);
  }

  // Boss phase transition — recompute phase from HP, and if it changed,
  // fire the climactic juice: big freeze, fat trauma, particle burst around
  // the boss, and a banked-style toast announcing the next phase. The
  // attack pattern + fire cadence change is read off bossPhase from the
  // ufo update loop and per-phase code paths below.
  if (u.type === 'boss' && u.hp > 0) {
    const next = bossPhaseForHp(u.hp);
    if (next !== u.bossPhase) {
      u.bossPhase = next;
      bumpTrauma(s, 0.7);
      hitStop(s, 320);
      audio.pulseDuck(0.45, 280);
      haptic('rumble');
      // Phase-entry particle ring around the boss — red on P2, white-hot on P3.
      const colour = next === 3 ? '#fff5d8' : '#ff5050';
      spawnParticles(s, u.pos.x, u.pos.y, 40, colour, 280, 700);
      toastNow(s, next === 3 ? 'EVENT HORIZON · CRITICAL' : 'EVENT HORIZON · ENRAGED');
    }
  }

  if (u.hp <= 0) {
    destroyUfo(s, u);
  } else {
    audio.hit();
  }
}

function destroyUfo(s: GameState, u: Ufo): void {
  u.alive = false;
  s.ufoKilledThisWave = true;
  s.runStats.ufoKills[u.type] += 1;
  const mul = recordCombo(s, performance.now());
  // Risk-proximity also pays out on UFO kills — sniping from safety is fine,
  // but landing the kill while threading the field earns a fatter score.
  const risk = computeRiskBonus(s);
  s.score += Math.round(UFO_POINTS[u.type] * mul * risk.mul);
  const explodeScale = u.type === 'tank' ? 1.3 : u.type === 'elite' ? 0.9 : 1.0;
  audio.explosion(explodeScale);
  spawnParticles(s, u.pos.x, u.pos.y, u.type === 'tank' ? 36 : 26, '#ff5050', 220, 800);
  // Per-class shake + freeze. Boss is the climax — biggest of any kill bar
  // ship death. Tanks are hefty. Cruiser/elite/sniper get a small punch.
  if (u.type === 'boss') {
    bumpTrauma(s, 0.7);
    hitStop(s, 280);
  } else if (u.type === 'tank') {
    bumpTrauma(s, 0.28);
    hitStop(s, 60);
  } else {
    bumpTrauma(s, 0.16);
  }
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
  const riskPrefix = risk.tier === 'risk' ? 'RISK · ' : '';
  toastNow(s, `${riskPrefix}${labels[u.type]}`);
  if (u.type === 'boss') {
    s.bossDefeated = true;
    // Halo skin: unlocks the first time the player downs the wave-25 boss.
    // markSkinUnlocked is idempotent so repeat clears are no-ops, and the
    // gameover overlay's publish path picks the unlock up to push to Nostr.
    if (markSkinUnlocked('halo')) toastNow(s, 'HALO SKIN UNLOCKED');
    // Banked music carries the moment now — no synth triumph chime.
    // Victory drop — guaranteed nova so any straggler debris vanishes
    maybeDropPowerUp(s, u.pos.x, u.pos.y, 'nova');
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
  // Trident active: fan three bullets at ±TRIDENT_SPREAD around the centre
  // heading. Same speed and cooldown as a normal shot — the value is the
  // wider arc, not faster fire.
  const tridentActive = performance.now() < s.tridentExpiresAt;
  const angles = tridentActive
    ? [-TRIDENT_SPREAD, 0, TRIDENT_SPREAD]
    : [0];
  for (const dAng of angles) {
    const a = s.ship.rot + dAng;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    s.bullets.push({
      pos: { x: muzzleX, y: muzzleY },
      vel: { x: dx * speed + s.ship.vel.x * 0.4, y: dy * speed + s.ship.vel.y * 0.4 },
      radius: BULLET_RADIUS,
      alive: true,
      ttl: BULLET_TTL_MS,
      pierceLeft: 1,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
    });
    s.bulletsFiredThisWave += 1;
  }
  // Visual kick — every shot nudges the ship back a couple of px along its
  // own facing. Decays in a few frames; affects render only.
  s.ship.recoilOffset = Math.max(s.ship.recoilOffset, 1.8);
  audio.fire();
}

// ── Particles ─────────────────────────────────────────────────────────────────

/** Hard ceiling on the live particle buffer. Above this, fresh spawns get
 *  proportionally scaled down so a chain of explosions on a busy wave doesn't
 *  push the renderer into the red. Tuned by-eye against wave 7-8 stress. */
const MAX_PARTICLES = 240;

/** Inward star-streak burst played on wave clear. Pushes particles from the
 *  playfield edges flying toward the centre at high speed for a brief moment.
 *  Reads as a "warp ignition" beat — distinct from the radial outward bursts
 *  used elsewhere. Bypasses spawnParticles because the velocity is inward, not
 *  random-radial. */
function spawnWaveClearStreak(s: GameState): void {
  const cx = WORLD_W / 2;
  const cy = WORLD_H / 2;
  const N = 18;
  const headroom = MAX_PARTICLES - s.particles.length;
  if (headroom <= 0) return;
  const count = Math.min(N, headroom);
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.25;
    const startR = Math.max(WORLD_W, WORLD_H) * 0.55;
    const sx = cx + Math.cos(angle) * startR;
    const sy = cy + Math.sin(angle) * startR;
    const speed = 360 + Math.random() * 220;
    s.particles.push({
      pos: { x: sx, y: sy },
      vel: { x: -Math.cos(angle) * speed, y: -Math.sin(angle) * speed },
      ttl: 420,
      maxTtl: 420,
      colour: '#ffffff',
      size: 1.4 + Math.random() * 1.2,
    });
  }
}

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

/** Per-asteroid roll: in Nostr mode, 1-in-SAT_DROP_CHANCE_DENOM picks `sat`;
 *  the rest pick `dust`. Guest mode never picks `sat` — pickups stay
 *  non-monetary so we don't accumulate uncashable sats against an unsigned
 *  identity. Pallasite asteroids ALWAYS drop sats in Nostr mode — they're
 *  the headline jackpot type and should reliably reward the player. */
function rollPickupKind(s: GameState, asteroidType?: AsteroidType): PickupKind {
  if (s.session === null) return 'dust';
  if (asteroidType === 'pallasite') return 'sat';
  return Math.random() < (1 / SAT_DROP_CHANCE_DENOM) ? 'sat' : 'dust';
}

/** Score awarded per dust shard, scaled to the source so a small asteroid
 *  doesn't out-pay a large one. Tuned so a typical run nets a meaningful
 *  score boost without overshadowing the kill points themselves. */
const DUST_SCORE_BASE = 25;

function spawnCoins(s: GameState, x: number, y: number, value: number, count: number, kind?: PickupKind, asteroidType?: AsteroidType): void {
  const resolvedKind = kind ?? rollPickupKind(s, asteroidType);
  // Dust shards inherit the source asteroid's score multiplier so iron and
  // pallasite drops feel meaningfully better than stony or chondrite — and
  // the renderer tints them with the source's glow colour for at-a-glance
  // recognition. Sat coins continue to split the cfg-scaled value.
  const dustMul = asteroidType ? ASTEROID_TYPE_CONFIG[asteroidType].scoreMul : 1;
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 30 + Math.random() * 40;
    const perPickup = resolvedKind === 'sat' ? value / count : Math.round(DUST_SCORE_BASE * dustMul);
    s.coins.push({
      pos: { x, y },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      radius: COIN_RADIUS,
      alive: true,
      ttl: COIN_TTL_MS,
      collected: false,
      kind: resolvedKind,
      value: perPickup,
      sourceType: asteroidType,
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
  // Use the same effective wrap dims that collisions use (= visible band in
  // modern portrait crop, = WORLD_W/H elsewhere). Without this the ship
  // would visibly skip across the screen on every WORLD_W traversal in
  // zoomed-out portrait, because visW doesn't divide WORLD_W cleanly:
  // physics wraps at 960 while the renderer ghosts at ±visW.
  //
  // Per-axis margin gating: on a cropped axis (ew.w !== WORLD_W or
  // ew.h !== WORLD_H) the wrap cycle IS the visible band and the ghost
  // renderer offsets at ±ew. A non-zero margin makes the physics wrap cycle
  // ew + 2·margin while the ghost cycle stays ew, so a wrapping asteroid
  // appears to jump backwards by exactly 2·margin world units — visible as
  // an asteroid that "travels, jumps back, then travels the same path
  // again" on iPhone modern portrait. Force margin to 0 on each cropped
  // axis individually so the wrap cycle matches the ghost cycle. Uncropped
  // axes (e.g. Y in iPhone portrait, both axes in retro) keep the courtesy
  // margin so an asteroid flies its radius off-screen before reappearing.
  const ew = getCollisionWrap();
  const mx = ew.w !== WORLD_W ? 0 : margin;
  const my = ew.h !== WORLD_H ? 0 : margin;
  if (p.x <= -mx) p.x += ew.w + mx * 2;
  if (p.x >= ew.w + mx) p.x -= ew.w + mx * 2;
  if (p.y <= -my) p.y += ew.h + my * 2;
  if (p.y >= ew.h + my) p.y -= ew.h + my * 2;
}

function circlesHit(a: { pos: Vec2; radius: number }, b: { pos: Vec2; radius: number }): boolean {
  // Wrap-aware shortest delta. In modern portrait mode the world is rendered
  // cropped with ghosts at ±visW; collisions must use the same shorter wrap
  // distance or the player aims at a visible ghost and the bullet passes
  // through it (the real entity sits one full visW away in world coords).
  // Use proper modulo so positions further than one wrap apart still fold
  // back correctly — visW need not divide WORLD_W cleanly.
  const wrap = getCollisionWrap();
  let dx = (((a.pos.x - b.pos.x) % wrap.w) + wrap.w) % wrap.w;
  if (dx > wrap.w / 2) dx -= wrap.w;
  let dy = (((a.pos.y - b.pos.y) % wrap.h) + wrap.h) % wrap.h;
  if (dy > wrap.h / 2) dy -= wrap.h;
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
  // Small punch on activation — the shield ignite reads as a meaningful
  // event, not a button click.
  bumpTrauma(s, 0.18);
  audio.pulseDuck(0.7, 180);
  haptic('tap');
  s.shieldUsedThisWave = true;
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
  // Capture the departure point before zeroing velocity — through-mine
  // detonation needs the ship's current position, which is still valid
  // because hyperspaceCloakMs is the only thing gating render/collision.
  const departureX = s.ship.pos.x;
  const departureY = s.ship.pos.y;
  s.ship.vel.x = 0;
  s.ship.vel.y = 0;
  s.ship.rotVel = 0;
  // Malfunction roll: standalone warps are safe. Only warps within
  // HYPERSPACE_CONSECUTIVE_WINDOW_MS of the last successful jump risk a
  // glitch. Reframes warp from "panic button with a tax" to "movement
  // primitive that punishes spam".
  const sinceLast = now - s.ship.lastHyperspaceAt;
  const isConsecutive = s.ship.lastHyperspaceAt > 0 && sinceLast < HYPERSPACE_CONSECUTIVE_WINDOW_MS;
  const malfunctionChance = isConsecutive ? HYPERSPACE_MALFUNCTION_CHANCE : 0;
  s.ship.hyperspaceMalfunction = gameRng() < malfunctionChance;
  s.ship.lastHyperspaceAt = now;
  if (s.ship.hyperspaceMalfunction) {
    audio.warpJumpGlitch();
    // Sprinkle warning particles at the departure point so the cloak is visibly off
    spawnParticles(s, departureX, departureY, 18, '#ff5050', 140, 500);
    toastNow(s, 'WARP UNSTABLE');
  } else {
    audio.warpJump();
    // Outward white burst signals warp ignition at the departure point. Fast
    // particles, short ttl — reads as speed-lines for ~250ms before the cloak
    // takes over and the ship reappears elsewhere.
    spawnParticles(s, departureX, departureY, 22, '#ffffff', 380, 260);
    spawnParticles(s, departureX, departureY, 10, '#7fbfff', 220, 320);
    // Through-mine detonation: any live mine inside the warp's energy
    // radius gets ripped apart. Player approached, got pulled by the
    // gravity well, and bailed via warp — and the warp took the mine
    // with them. Awards the normal mine score+sats per kill.
    let detonated = 0;
    for (const m of s.mines) {
      if (!m.alive) continue;
      const dx = m.pos.x - departureX;
      const dy = m.pos.y - departureY;
      if (dx * dx + dy * dy <= HYPERSPACE_DETONATE_RANGE * HYPERSPACE_DETONATE_RANGE) {
        destroyMine(s, m);
        detonated += 1;
      }
    }
    if (detonated > 0) {
      toastNow(s, `WARP DETONATE ×${detonated}`);
    } else {
      toastNow(s, 'HYPERSPACE LOCK');
    }
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
/** ms since startGame at which we last pushed a ghost sample. Reset when
 *  startGame zeroes runTimeMs; capture cadence is GHOST_SAMPLE_MS. */
let lastGhostSampleRunMs = -1;
const GHOST_SAMPLE_MS = 1000;
/** Ceiling so a paused tab can't grow ghost samples without bound. 1h at 1Hz
 *  is way past any realistic run length. */
const GHOST_SAMPLE_CAP = 3600;
/** Pose sample cadence — daily-mode only. 250ms (4Hz) keeps the overlay
 *  smooth while keeping the v2 payload under ~40KB for a 10-min run. */
const GHOST_POSE_SAMPLE_MS = 250;
const GHOST_POSE_SAMPLE_CAP = 14_400;
let lastGhostPoseRunMs = -1;

/** Push an unconditional snapshot — used by killShip to bake the impact-
 *  moment frame into the buffer (the regular recorder runs at frame start,
 *  before collision). */
function pushReplayImpactFrame(s: GameState): void {
  s.replayBuffer.push(buildReplaySnapshot(s, performance.now()));
  if (s.replayBuffer.length > REPLAY_BUFFER_FRAMES) s.replayBuffer.shift();
}

function buildReplaySnapshot(s: GameState, t: number): ReplaySnapshot {
  return {
    t,
    ship: { pos: { x: s.ship.pos.x, y: s.ship.pos.y }, rot: s.ship.rot, alive: s.ship.alive, thrusting: s.ship.thrusting },
    asteroids: s.asteroids.map(a => ({ ...a, pos: { x: a.pos.x, y: a.pos.y }, vel: { x: a.vel.x, y: a.vel.y } })),
    ufos: s.ufos.map(u => ({ ...u, pos: { x: u.pos.x, y: u.pos.y }, vel: { x: u.vel.x, y: u.vel.y } })),
    bullets: s.bullets.map(b => ({ ...b, pos: { x: b.pos.x, y: b.pos.y }, vel: { x: b.vel.x, y: b.vel.y } })),
    enemyBullets: s.enemyBullets.map(b => ({ ...b, pos: { x: b.pos.x, y: b.pos.y }, vel: { x: b.vel.x, y: b.vel.y } })),
    mines: s.mines.map(m => ({ ...m, pos: { x: m.pos.x, y: m.pos.y }, vel: { x: m.vel.x, y: m.vel.y } })),
  };
}

function recordReplaySnapshot(s: GameState, now: number): void {
  if (s.phase !== 'playing') return;
  if (now - lastReplayRecordedAt < REPLAY_RECORD_INTERVAL_MS) return;
  lastReplayRecordedAt = now;
  // Spread-copy each entity and its mutable Vec2 fields so the buffer doesn't
  // alias the live state (and get mutated frame-by-frame). The `shape` array
  // on asteroids is never mutated post-spawn so a shared ref is safe.
  s.replayBuffer.push(buildReplaySnapshot(s, now));
  if (s.replayBuffer.length > REPLAY_BUFFER_FRAMES) s.replayBuffer.shift();
}

/** Push a (t, score) pair to s.ghostSamples every GHOST_SAMPLE_MS of in-game
 *  time. Keyed off s.runTimeMs (not wall-clock) so pause / phase transitions
 *  don't bloat the timeline. The ghost decoder reconstructs t as i*intervalMs,
 *  so we only sample on tight intervals — never on irregular boundaries. */
function recordGhostSample(s: GameState): void {
  if (s.phase !== 'playing') return;
  const runMs = s.runTimeMs;
  // First sample fires at t=0 (startGame seeded lastGhostSampleRunMs to -1).
  if (lastGhostSampleRunMs < 0 || runMs - lastGhostSampleRunMs >= GHOST_SAMPLE_MS) {
    if (s.ghostSamples.length < GHOST_SAMPLE_CAP) {
      const expectedT = s.ghostSamples.length * GHOST_SAMPLE_MS;
      s.ghostSamples.push({ t: expectedT, score: s.score });
    }
    lastGhostSampleRunMs = runMs;
  }
  // Pose stream is always captured. In daily mode it powers the in-game
  // ship overlay; outside daily it powers the title-screen attract loop.
  // 35 KB / 10-min run is small enough that we don't gate this on mode.
  if (lastGhostPoseRunMs < 0 || runMs - lastGhostPoseRunMs >= GHOST_POSE_SAMPLE_MS) {
    if (s.ghostPoseSamples.length < GHOST_POSE_SAMPLE_CAP) {
      const expectedT = s.ghostPoseSamples.length * GHOST_POSE_SAMPLE_MS;
      const flags = (s.ship.alive ? 1 : 0) | (s.ship.thrusting ? 2 : 0);
      s.ghostPoseSamples.push({
        t: expectedT,
        score: s.score,
        x: s.ship.pos.x,
        y: s.ship.pos.y,
        rot: s.ship.rot,
        flags,
      });
    }
    lastGhostPoseRunMs = runMs;
  }
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
  // Re-arm the impact-frame explosion spawn — the flag is sticky from the
  // previous play, so a REPLAY KILL click would otherwise skip the explosion
  // entirely. Clear lingering particles/debris from the prior replay so the
  // prelude isn't haunted by faded remnants.
  s.deathReplay.explosionSpawned = false;
  s.particles = [];
  s.debris = [];
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
  }, REPLAY_TOTAL_WALL_MS + REPLAY_EXPLOSION_WALL_MS);
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
 * Wipe gameplay entities so the title screen renders clean. Going to title
 * from gameover/completion previously left asteroids, coins, debris, and
 * particles in place — the renderer drew them through the title overlay's
 * 65%-translucent backdrop, and debris kept drifting because particle/debris
 * physics tick during fade-only phases. On portrait mobile the bottom of
 * the world band ended up showing visible drifting line-segments that read
 * as "asteroids" to the player. Cheap to clear; no callsite needs the
 * entities once we've left the run.
 */
export function clearEntitiesForTitle(s: GameState): void {
  s.asteroids = [];
  s.bullets = [];
  s.enemyBullets = [];
  s.ufos = [];
  s.mines = [];
  s.coins = [];
  s.powerups = [];
  s.particles = [];
  s.debris = [];
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
  // Hit-stop crescendo: freeze the simulation while a milestone-kill punch
  // frame holds. The renderer still draws the static state so the player
  // sees the moment land. dt is discarded -- next frame's natural dt picks
  // play back up; main.ts caps dt at 50ms so any drift is minor.
  if (now < s.hitStopUntil) return;
  s.elapsed += dt * 1000;

  // HUD ticker eases toward s.sats every frame regardless of phase, so the
  // counter still finishes its run-up under gameover / wavestart overlays.
  updateDisplaySats(s, dt);

  // Camera trauma decays linearly. Half-life ~0.5s at trauma=1 — long enough
  // that a death-impact shake reads as a single thwack, short enough that
  // back-to-back hits don't compound into a permanent rumble.
  if (s.cameraTrauma > 0) {
    s.cameraTrauma = Math.max(0, s.cameraTrauma - dt * 1.8);
  }

  // Snapshot the world state for the death replay buffer (no-op outside 'playing').
  recordReplaySnapshot(s, now);
  // 1Hz score-pacing sample for the kind 30763 ghost replay.
  recordGhostSample(s);

  // Detect the 1979 lurking exploit so coin credit can be withheld for it.
  updateLurkState(s, now);

  // Particles + debris always update so they fade out across phase changes
  // (and so the death-replay's impact-frame explosion animates).
  const fadeOnly = s.phase === 'title' || s.phase === 'paused' || s.phase === 'gameover' || s.phase === 'completed' || s.phase === 'deathreplay';
  if (fadeOnly) {
    // Death-replay specific: when replay-time crosses the impact moment,
    // re-spawn the same particles+debris that killShip emitted during live
    // play so the explosion matches exactly. Guarded by explosionSpawned.
    if (s.phase === 'deathreplay' && s.deathReplay && !s.deathReplay.explosionSpawned) {
      const dr = s.deathReplay;
      const wallElapsed = now - dr.startedAt;
      const slowGameTime = Math.min(REPLAY_SLOW_MS, dr.spanMs);
      const fastGameTime = Math.max(0, dr.spanMs - slowGameTime);
      const fastWallEnd = fastGameTime;
      const slowWall = Math.max(0, wallElapsed - fastWallEnd);
      const gameTime = Math.min(dr.spanMs + REPLAY_EXPLOSION_MS, fastGameTime + slowWall * REPLAY_SLOW_RATE);
      if (gameTime >= dr.spanMs) {
        dr.explosionSpawned = true;
        spawnParticles(s, dr.explosionAt.x, dr.explosionAt.y, 42, '#58ff58', 280, 1100);
        spawnParticles(s, dr.explosionAt.x, dr.explosionAt.y, 22, '#ffd84a', 200,  700);
        spawnParticles(s, dr.explosionAt.x, dr.explosionAt.y, 18, '#ffffff', 380,  450);
        const fauxShip: Ship = {
          pos: dr.explosionShip.pos,
          vel: dr.explosionShip.vel,
          radius: SHIP_RADIUS,
          alive: false,
          rot: dr.explosionShip.rot,
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
          recoilOffset: 0,
          lastHyperspaceAt: 0,
        };
        spawnShipDebris(s, fauxShip);
      }
    }
    // Particles + debris physics tick (so the explosion animates regardless
    // of phase). Cheaper than the full update path.
    for (const p of s.particles) {
      p.pos.x += p.vel.x * dt; p.pos.y += p.vel.y * dt;
      p.ttl -= dt * 1000;
      p.vel.x *= Math.exp(-1.5 * dt); p.vel.y *= Math.exp(-1.5 * dt);
    }
    s.particles = s.particles.filter(p => p.ttl > 0);
    for (const d of s.debris) {
      d.pos.x += d.vel.x * dt; d.pos.y += d.vel.y * dt;
      d.rot += d.rotVel * dt;
      d.ttl -= dt * 1000;
      d.vel.x *= Math.exp(-0.6 * dt); d.vel.y *= Math.exp(-0.6 * dt);
      wrap(d.pos, 20);
    }
    s.debris = s.debris.filter(d => d.ttl > 0);
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
  const thrust = (s.keys['ArrowUp'] || s.keys['KeyW']) || s.thrustOverride;
  const fire = s.keys['Space'];

  // Hyperspace cloak countdown
  if (s.ship.hyperspaceCloakMs > 0) {
    s.ship.hyperspaceCloakMs -= dt * 1000;
  }

  if (s.ship.alive && s.ship.hyperspaceCloakMs <= 0) {
    if (s.targetHeading !== null) {
      // Heading-mode (joystick): rotate ship smoothly toward the stick angle
      // at a fixed angular rate. Snaps when within one frame's worth of rate.
      const HEADING_LERP_RATE = 8;  // rad/s — feels responsive without jitter
      let diff = s.targetHeading - s.ship.rot;
      while (diff >  Math.PI) diff -= 2 * Math.PI;
      while (diff < -Math.PI) diff += 2 * Math.PI;
      const step = HEADING_LERP_RATE * dt;
      if (Math.abs(diff) <= step) {
        s.ship.rot = s.targetHeading;
        s.ship.rotVel = 0;
      } else {
        s.ship.rot += Math.sign(diff) * step;
        s.ship.rotVel = Math.sign(diff) * HEADING_LERP_RATE;  // for thrust-flame visuals etc
      }
    } else {
      if (turnLeft) s.ship.rotVel -= SHIP_ROT_ACCEL * dt;
      if (turnRight) s.ship.rotVel += SHIP_ROT_ACCEL * dt;
      if (!turnLeft && !turnRight) {
        const sign = Math.sign(s.ship.rotVel);
        const newVel = s.ship.rotVel - sign * SHIP_ROT_DAMPING * dt;
        s.ship.rotVel = Math.sign(newVel) === sign ? newVel : 0;
      }
      s.ship.rotVel = Math.max(-SHIP_MAX_ROT, Math.min(SHIP_MAX_ROT, s.ship.rotVel));
      s.ship.rot += s.ship.rotVel * dt;
    }

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

    // Recoil decays linearly — a 1.8px kick fades in ~75ms at 24 px/s.
    if (s.ship.recoilOffset > 0) {
      s.ship.recoilOffset = Math.max(0, s.ship.recoilOffset - dt * 24);
    }

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
    if (b.ttl <= 0) {
      b.alive = false;
      // Bullet expired without ever connecting — counts as a miss for the
      // wave-end NO MISS bonus. A bullet that hit at least once (including a
      // pierce that hit then TTL'd before the next rock) does not.
      if (!b.hasLanded) s.missedShotsThisWave += 1;
    } else {
      // Detect wrap so a hit landed on the far side counts as a WRAP KILL.
      // wrap() only mutates pos when the bullet actually crosses an edge, so a
      // simple before/after compare is reliable.
      const preX = b.pos.x;
      const preY = b.pos.y;
      wrap(b.pos);
      if (b.pos.x !== preX || b.pos.y !== preY) b.wrapped = true;
    }
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

  // ── Debris (ship explosion fragments) ──
  for (const d of s.debris) {
    d.pos.x += d.vel.x * dt;
    d.pos.y += d.vel.y * dt;
    d.rot += d.rotVel * dt;
    d.ttl -= dt * 1000;
    // Mild drag so pieces decelerate as they tumble outward
    d.vel.x *= Math.exp(-0.6 * dt);
    d.vel.y *= Math.exp(-0.6 * dt);
    wrap(d.pos, 20);
  }
  s.debris = s.debris.filter(d => d.ttl > 0);

  // ── Coins ──
  const magnetActive = now < s.magnetExpiresAt;
  for (const c of s.coins) {
    c.pos.x += c.vel.x * dt;
    c.pos.y += c.vel.y * dt;
    c.ttl -= dt * 1000;
    c.vel.x *= Math.exp(-0.8 * dt);
    c.vel.y *= Math.exp(-0.8 * dt);
    if (c.ttl <= 0) c.alive = false;
    wrap(c.pos);

    // Pull toward ship — short-range natural magnetism always, plus a strong
    // whole-screen pull while the MAGNET powerup is active.
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
      if (magnetActive && distSq > pullRange * pullRange && distSq < MAGNET_RANGE * MAGNET_RANGE) {
        // Constant accel toward ship — coins always reach the ship within a
        // couple of seconds regardless of distance, even across wrap edges.
        const dist = Math.sqrt(distSq);
        c.vel.x += (dx / dist) * MAGNET_MAX_ACCEL * dt;
        c.vel.y += (dy / dist) * MAGNET_MAX_ACCEL * dt;
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
        // Carom: a bullet that has already broken one asteroid earns the
        // bonus on its next break. Wrap: a bullet that has crossed a playfield
        // edge before its kill earns the wrap bonus. Stack independently — a
        // wrapped carom is a 4× kill.
        const isCarom = b.caromHit;
        const isWrap = b.wrapped;
        b.hasLanded = true;
        damageAsteroid(s, a, { isCarom, isWrap });
        // Pierce: if the asteroid actually broke and the bullet has pierce
        // left, the bullet survives to seek a second target. Iron-large takes
        // two hits to break, so a pierce shot only travels through fully
        // shattered rocks. Either way, only one asteroid is hit per frame.
        if (!a.alive && b.pierceLeft > 0) {
          b.pierceLeft--;
          b.caromHit = true;
        } else {
          b.alive = false;
        }
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
        b.hasLanded = true;
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
        b.hasLanded = true;
        damageMine(s, m);
        break;
      }
    }
  }

  // ── Shield contact with mines ──
  // Shield protects the ship from death but no longer destroys the mine —
  // matches how shield handles asteroids (pure deflect, no damage). Mines
  // are cleared by bullets only. Visual sparks + audio still fire so the
  // contact reads on screen.
  if (s.ship.alive && s.ship.shieldUp) {
    for (const m of s.mines) {
      if (!m.alive) continue;
      if (circlesHit(s.ship, m)) {
        spawnParticles(s, m.pos.x, m.pos.y, 8, '#5b9dff', 180, 320);
        audio.shieldHit();
      }
    }
  }

  // ── Shield deflection (runs before damage check) ──
  if (s.ship.alive && s.ship.shieldUp) {
    for (const a of s.asteroids) {
      if (!a.alive) continue;
      if (circlesHit(s.ship, a)) {
        // Use wrap-aware delta so reflections at the edges push the asteroid
        // along the actual contact normal, not a normal flipped by the wrap.
        const wrap = getCollisionWrap();
        let dx = (((a.pos.x - s.ship.pos.x) % wrap.w) + wrap.w) % wrap.w;
        if (dx > wrap.w / 2) dx -= wrap.w;
        let dy = (((a.pos.y - s.ship.pos.y) % wrap.h) + wrap.h) % wrap.h;
        if (dy > wrap.h / 2) dy -= wrap.h;
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
          // Lurking and cheating both forfeit sat credit. Score still ticks
          // via dust, but sats won't accumulate once the run is tainted.
          if (s.lurking || s.cheatedThisRun) s.lurkSatsBlocked += credit;
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
        s.runStats.powerupsCollected += 1;
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
      // Award NO SHIELD / NO MISS / PACIFIST UFO bonuses before clearing the
      // stage so the per-wave flags still reflect what the player did. The
      // toast lands a beat before warp so the bonuses register.
      awardWaveClearBonuses(s);
      // Despawn UFOs/mines/enemy bullets and auto-bank any uncollected coins
      clearStage(s, { autoCollect: true });
      audio.ufoSirenStop();
      // Wave-clear punctuation: brief freeze + a soft trauma bump + inward
      // star-streak so the transition into warp lands on a beat instead of
      // a smooth fade.
      bumpTrauma(s, 0.30);
      hitStop(s, 180);
      spawnWaveClearStreak(s);
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
  const prev = s.combo;
  if (now < s.comboExpiresAt && s.combo > 0) {
    s.combo = Math.min(COMBO_MAX, s.combo + 1);
  } else {
    s.combo = 1;
  }
  s.comboExpiresAt = now + COMBO_WINDOW_MS;
  if (s.combo > s.runStats.largestCombo) s.runStats.largestCombo = s.combo;
  if (s.combo >= 2) audio.comboTick(s.combo);
  // Crescendo on first reaching the cap in this chain: short hit-stop and
  // a trauma bump so the moment lands. Only fires once per chain because
  // subsequent kills find prev already at COMBO_MAX.
  if (s.combo === COMBO_MAX && prev < COMBO_MAX) {
    s.hitStopUntil = now + 80;
    bumpTrauma(s, 0.18);
  }
  return s.combo;
}

function resetCombo(s: GameState): void {
  s.combo = 0;
  s.comboExpiresAt = 0;
}

/**
 * Wave-end bonus pass. Three independent chips:
 *   - NO SHIELD  (+1500): cleared the wave without ever activating the shield.
 *   - NO MISS    (+2000): every bullet that TTL'd had landed a hit. Requires
 *     at least 8 bullets fired so a nova-cleared wave doesn't qualify.
 *   - PACIFIST   (+1000): a UFO spawned this wave but the player never killed
 *     a UFO — the saucer drifted off on its own. Doesn't fire on wave 25 (the
 *     boss is mandatory and the asteroidsClear branch never runs there).
 * All earned chips toast as a single line so multi-bonus waves land as one
 * impression, not three overlapping toasts.
 */
function awardWaveClearBonuses(s: GameState): void {
  const tags: string[] = [];
  let total = 0;
  if (!s.shieldUsedThisWave) {
    tags.push('NO SHIELD +1500');
    total += 1500;
  }
  if (s.bulletsFiredThisWave >= 8 && s.missedShotsThisWave === 0) {
    tags.push('NO MISS +2000');
    total += 2000;
  }
  if (s.ufoSpawnedThisWave && !s.ufoKilledThisWave) {
    tags.push('PACIFIST +1000');
    total += 1000;
  }
  if (total > 0) {
    s.score += total;
    toastNow(s, tags.join(' · '));
  }
}

/**
 * Risk-proximity multiplier — the closer the ship was to another live threat
 * at kill time, the bigger the reward. Two tiers:
 *   - RISK  (≤55px): ×1.5 score, surfaces as a toast tag.
 *   - CLOSE (≤110px): ×1.25 score, silent so a dense field doesn't spam toasts.
 * Considers asteroids and UFOs both — the killed entity has already had `alive`
 * flipped to false by the caller and is naturally excluded.
 */
function computeRiskBonus(s: GameState): { mul: number; tier: 'risk' | 'close' | 'none' } {
  if (!s.ship.alive) return { mul: 1, tier: 'none' };
  let minDistSq = Infinity;
  for (const a of s.asteroids) {
    if (!a.alive) continue;
    const dx = a.pos.x - s.ship.pos.x;
    const dy = a.pos.y - s.ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDistSq) minDistSq = d2;
  }
  for (const u of s.ufos) {
    if (!u.alive) continue;
    const dx = u.pos.x - s.ship.pos.x;
    const dy = u.pos.y - s.ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDistSq) minDistSq = d2;
  }
  if (minDistSq <= 55 * 55) return { mul: 1.5,  tier: 'risk' };
  if (minDistSq <= 110 * 110) return { mul: 1.25, tier: 'close' };
  return { mul: 1, tier: 'none' };
}

/**
 * Apply one bullet's worth of damage to an asteroid. Iron at large size has hp=2
 * — first hit flashes and dents, second hit fragments. All other cases are 1hp.
 */
function damageAsteroid(s: GameState, a: Asteroid, opts?: { isCarom?: boolean; isWrap?: boolean }): void {
  a.hp -= 1;
  a.hitFlash = 1;
  if (a.hp <= 0) {
    breakAsteroid(s, a, opts);
  } else {
    const cfg = ASTEROID_TYPE_CONFIG[a.type];
    audio.hit();
    spawnParticles(s, a.pos.x, a.pos.y, 5, cfg.glow, 110, 280);
  }
}

function breakAsteroid(s: GameState, a: Asteroid, opts?: { suppressCoins?: boolean; isCarom?: boolean; isWrap?: boolean }): void {
  a.alive = false;
  const cfg = ASTEROID_TYPE_CONFIG[a.type];
  const mul = recordCombo(s, performance.now());
  // Trick-shot bonuses stack multiplicatively on top of combo: a wrapped carom
  // is a 4× kill on top of any active combo. Risk-proximity adds another tier
  // on top: ≤55px = ×1.5, ≤110px = ×1.25. Each fires independently and is
  // toasted unless the pallasite jackpot text would conflict.
  let bonusMul = 1;
  const trickLabels: string[] = [];
  const risk = computeRiskBonus(s);
  if (risk.tier === 'risk') trickLabels.push('RISK');
  bonusMul *= risk.mul;
  if (opts?.isCarom) { bonusMul *= 2; trickLabels.push('CAROM'); }
  if (opts?.isWrap)  { bonusMul *= 2; trickLabels.push('WRAP'); }
  s.score += Math.round(POINTS_PER_SIZE[a.size] * cfg.scoreMul * mul * bonusMul);
  const satsValue = SATS_PER_SIZE[a.size] * cfg.satMul * bonusMul;

  // Trauma scales with mass — a large rock's break should feel weightier than
  // a small shard popping. Iron gets a bonus because the armoured crack hits
  // harder. Range ~0.05..0.40 per break.
  const sizeFactor = a.size === 'large' ? 0.32 : a.size === 'medium' ? 0.16 : 0.05;
  const ironBonus = a.type === 'iron' ? 1.25 : 1;
  bumpTrauma(s, sizeFactor * ironBonus);
  // Only large breaks duck the music or buzz the haptics — smaller breaks
  // are too frequent for the bed to handle without pumping.
  if (a.size === 'large') {
    audio.pulseDuck(0.65, 180);
    haptic('thump');
  }

  // Particles tinted to the type's accent
  spawnParticles(s, a.pos.x, a.pos.y, a.size === 'large' ? 18 : a.size === 'medium' ? 12 : 8, cfg.glow, 140, 700);

  // Coins drop — suppressed for NOVA so it can't be farmed for sats. Pallasite
  // asteroids always drop sats; other types roll for sat-vs-dust.
  if (!opts?.suppressCoins) {
    const coinCount = a.size === 'large' ? 4 : a.size === 'medium' ? 2 : 1;
    spawnCoins(s, a.pos.x, a.pos.y, satsValue, coinCount, undefined, a.type);
  }

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
    // Final shard of a pallasite chain is a moment — let it land.
    bumpTrauma(s, 0.35);
    hitStop(s, 110);
    const trickPrefix = trickLabels.length ? `${trickLabels.join('+')} · ` : '';
    toastNow(s, `${trickPrefix}PALLASITE +${Math.max(1, Math.round(satsValue))} sats`);
  } else if (trickLabels.length) {
    // Non-jackpot break: surface the trick-shot label on its own. Carom + wrap
    // each get a small punch and a comboTick chime so the moment reads
    // independently of the combo bar.
    bumpTrauma(s, 0.12);
    audio.comboTick(Math.min(COMBO_MAX, s.combo + 1));
    toastNow(s, `+${trickLabels.join(' + ')}`);
  }

  maybeExtraLife(s);
}

/**
 * Award an extra life on each 10,000-score threshold crossing. Tracked via
 * `bonusLivesGranted` so dying after earning one doesn't get the life
 * regenerated by the next asteroid kill (the previous logic compared
 * current lives against a hardcoded `3 + earnedLives` target, which silently
 * resurrected players on Normal and bumped Hard runs from 2 lives up to 3).
 */
function maybeExtraLife(s: GameState): void {
  const earnedLives = Math.floor(s.score / 10000);
  if (earnedLives <= s.bonusLivesGranted) return;
  if (s.lives >= 5) {
    // Cap reached but the threshold still counts — record it so we don't
    // grant a backlog if the player drops below cap later.
    s.bonusLivesGranted = earnedLives;
    return;
  }
  const grant = Math.min(earnedLives - s.bonusLivesGranted, 5 - s.lives);
  s.lives += grant;
  s.bonusLivesGranted = earnedLives;
  audio.extraLife();
  toastNow(s, grant > 1 ? `+ ${grant} EXTRA LIVES` : '+ EXTRA LIFE');
}

/**
 * Spawn ship-shaped debris pieces — line segments along the ship's outline
 * scattering outward from the kill site. Mirrors the iconic 1979 effect.
 */
function spawnShipDebris(s: GameState, ship: Ship): void {
  // Ship local-space outline (matches drawShip): four line segments.
  const segments: Array<[Vec2, Vec2]> = [
    [{ x: 14, y: 0 },  { x: -10, y: 8 }],
    [{ x: -10, y: 8 }, { x: -6, y: 0 }],
    [{ x: -6, y: 0 },  { x: -10, y: -8 }],
    [{ x: -10, y: -8 }, { x: 14, y: 0 }],
  ];
  const cosR = Math.cos(ship.rot);
  const sinR = Math.sin(ship.rot);
  for (const [a, b] of segments) {
    const cxLocal = (a.x + b.x) / 2;
    const cyLocal = (a.y + b.y) / 2;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const segAngleLocal = Math.atan2(b.y - a.y, b.x - a.x);
    // Rotate centre into world space
    const worldX = ship.pos.x + cxLocal * cosR - cyLocal * sinR;
    const worldY = ship.pos.y + cxLocal * sinR + cyLocal * cosR;
    // Outward velocity: from ship centre through the segment's centre,
    // rotated into world. Carry a fraction of the ship's velocity so debris
    // inherits inertia.
    const distLocal = Math.hypot(cxLocal, cyLocal) || 1;
    const dirX = cxLocal / distLocal;
    const dirY = cyLocal / distLocal;
    const wDirX = dirX * cosR - dirY * sinR;
    const wDirY = dirX * sinR + dirY * cosR;
    const speed = 70 + Math.random() * 80;
    const debris: Debris = {
      pos: { x: worldX, y: worldY },
      vel: {
        x: wDirX * speed + ship.vel.x * 0.5,
        y: wDirY * speed + ship.vel.y * 0.5,
      },
      rot: ship.rot + segAngleLocal,
      rotVel: (Math.random() - 0.5) * 6,
      length,
      ttl: 1500,
      maxTtl: 1500,
      colour: '#58ff58',
    };
    s.debris.push(debris);
  }
}

function killShip(s: GameState): void {
  // Capture the impact-frame snapshot BEFORE flipping ship.alive — the
  // standard recordReplaySnapshot at frame start was taken at the ship's
  // pre-collision position, so without this the replay would end one frame
  // before the actual hit. Synthesising it here puts the visible final
  // frame on the impact moment.
  pushReplayImpactFrame(s);

  const deathPos: Vec2 = { x: s.ship.pos.x, y: s.ship.pos.y };
  s.ship.alive = false;
  resetCombo(s);
  audio.explosion(1.4);
  audio.thrustOff();
  // Maximum trauma + deepest duck + rumble — death is the loudest impact.
  bumpTrauma(s, 1.0);
  hitStop(s, 140);
  audio.pulseDuck(0.35, 360);
  haptic('rumble');
  // Layered explosion: ship-green burst + yellow flash + white sparks +
  // line-segment debris. Bigger and more cinematic than the old 30-particle
  // single-colour puff.
  spawnParticles(s, deathPos.x, deathPos.y, 42, '#58ff58', 280, 1100);
  spawnParticles(s, deathPos.x, deathPos.y, 22, '#ffd84a', 200,  700);
  spawnParticles(s, deathPos.x, deathPos.y, 18, '#ffffff', 380,  450);
  spawnShipDebris(s, s.ship);
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
        explosionAt: deathPos,
        explosionShip: {
          pos: { x: s.ship.pos.x, y: s.ship.pos.y },
          vel: { x: s.ship.vel.x, y: s.ship.vel.y },
          rot: s.ship.rot,
        },
        explosionSpawned: false,
      };
      // Clear the live particle/debris pools so the killShip burst doesn't
      // visibly haunt the replay's prelude — the replay re-spawns identical
      // particles+debris when it reaches the impact frame.
      s.particles = [];
      s.debris = [];
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
