/**
 * Game logic — entity creation, simulation, collisions, wave progression.
 *
 * The render layer is in render.ts. The audio layer is in audio.ts.
 * Auth and scoring live alongside in auth.ts and score.ts.
 */

import type {
  GameState, Ship, Asteroid, AsteroidSize, AsteroidType, Ufo, UfoType, Mine, Bullet, Vec2,
  SimTransition, SimTransitionKind, PlayerState, RunStats, DeathmatchRules, DeathmatchEndReason,
} from './types.js';
import { recordStreamEvent } from './stream-session.js';
import { getGameConfig } from './faucet.js';
import { getFlavour } from './flavour.js';
import { asteroidBounceEnabled } from './bounce.js';
import { bulletKnockbackEnabled } from './knockback.js';
import { getCouncil } from './sanctum-avatars.js';
import { DEPTH_CONFIGS, decorativeSpawnCount, getParallaxTier, pickDecorativeDepth } from './parallax.js';
import {
  waveName, FINAL_WAVE, ASTEROID_TYPE_CONFIG,
  REPLAY_RECORD_INTERVAL_MS, REPLAY_BUFFER_FRAMES, REPLAY_TOTAL_WALL_MS, REPLAY_EXPLOSION_WALL_MS,
  REPLAY_SLOW_MS, REPLAY_SLOW_RATE, REPLAY_EXPLOSION_MS,
  LURK_CENTRE_RADIUS_PX, LURK_VEL_THRESHOLD, LURK_DURATION_MS, LURK_TOAST_MS,
  WARP_SKIP_AFTER_MS,
} from './types.js';
import type { PickupKind } from './types.js';
import type { ReplaySnapshot, Debris } from './types.js';
import {
  WORLD_W, WORLD_H, WARP_MS, WAVE_CLEAR_GRACE_MS, intertitleForWave, INTERTITLE_MS,
  SHIP_RADIUS, SHIP_THRUST, SHIP_DRAG, SHIP_ROT_ACCEL, SHIP_ROT_DAMPING, SHIP_MAX_ROT, SHIP_INVULN_MS, FIRE_COOLDOWN_MS,
  HYPERSPACE_COOLDOWN_MS, HYPERSPACE_CLOAK_MS, HYPERSPACE_MALFUNCTION_CHANCE, HYPERSPACE_SAFE_DIST,
  HYPERSPACE_CONSECUTIVE_WINDOW_MS, HYPERSPACE_DETONATE_RANGE,
  SHIELD_DURATION_MS, SHIELD_COOLDOWN_MS,
  BULLET_SPEED, BULLET_TTL_MS, BULLET_RADIUS,
  ASTEROID_BASE_SPEED, ASTEROID_SPEED_PER_WAVE,
  COIN_RADIUS, COIN_TTL_MS,
  POINTS_PER_SIZE, SATS_PER_SIZE, RADIUS_PER_SIZE,
  VEIN_HP_BASE, VEIN_HP_EASY_MUL, VEIN_HP_HARD_MUL,
  VEIN_RADIUS_MUL, VEIN_MIN_RADIUS_SCALE, VEIN_SATS_PER_HIT, VEIN_SCORE_PER_HIT,
  VEIN_RETALIATE_PER_N_HITS, VEIN_SHARD_SPEED, VEIN_SHARD_TTL_MS, VEIN_SHARD_RADIUS,
  STATION_ARMS, STATION_ARM_R, STATION_EMITTER_R, STATION_ROT_SPEED, STATION_EMITTER_HP, STATION_AMBIENT_MS,
  STATION_MISSILE_MS, STATION_MISSILE_CAP, STATION_MISSILE_SPEED, STATION_MISSILE_TURN, STATION_MISSILE_TTL_MS, STATION_MISSILE_RADIUS,
  FORGE_SPAWN, FORGE_CENTRE_Y, FORGE_SEGMENTS, FORGE_RING_R, FORGE_CORE_R, FORGE_SEG_R, FORGE_SPIN, FORGE_ROCK_MS, FORGE_ROCK_SPREAD,
  FORGE_CORE_HP, FORGE_VENT_HP, FORGE_MISSILE_CAP, FORGE_MISSILE_SPEED_MUL, FORGE_MISSILE_TTL_MUL, FORGE_MISSILE_TURN_MUL,
  FORGE_PULSE_DENSITY, FORGE_PULSE_CADENCE_MS, FORGE_PULSE_DENSITY_MUL, FORGE_PULSE_CADENCE_MUL, FORGE_ROCK_CAP,
  FORGE_MELTDOWN_FRAC, FORGE_MELTDOWN_WELLS, FORGE_MELTDOWN_R_START, FORGE_MELTDOWN_R_MIN, FORGE_MELTDOWN_SPIN,
  FORGE_MELTDOWN_WELL_RANGE, FORGE_MELTDOWN_WELL_STRENGTH, FORGE_ESCAPE_FRAC, FORGE_ESCAPE_SPEED, FORGE_ESCAPE_ZIG_MS, FORGE_ESCAPE_HP,
  VEIN_JACKPOT_SATS, VEIN_JACKPOT_SCORE, VEIN_SPAWN_CHANCE,
  VEIN_SPAWN_MIN_WAVE, VEIN_SPAWN_MAX_WAVE, VEIN_SWARM_DELAY_MS,
  VEIN_POWERUP_PER_N_HITS, VEIN_NOVA_DAMAGE,
  UFO_RADIUS, UFO_SPEED, UFO_HP, UFO_SHOT_SPREAD, UFO_SHOOT_INTERVAL, UFO_BULLET_SPEED_MUL,
  UFO_BULLET_SPEED, UFO_BULLET_TTL_MS, UFO_LIFETIME_MS,
  UFO_ZIG_INTERVAL_MS, UFO_POINTS, UFO_SATS,
  bossPhaseForHp,
  UFO_TYPE_BY_WAVE,
  MINE_RADIUS, MINE_GRAVITY_RANGE, MINE_GRAVITY_STRENGTH, MINE_POINTS, MINE_SATS_DROP, MINE_HP_BASE,
  MINE_CANDIDATE_POSITIONS, MINE_COUNT_BY_WAVE,
  COMBO_WINDOW_MS, COMBO_MAX,
  POWERUP_CONFIG, POWERUP_TTL_MS, POWERUP_RADIUS,
  RAPID_COOLDOWN_MUL, SATBOOST_MUL,
  TRIDENT_SPREAD, MAGNET_MAX_ACCEL, MAGNET_RANGE,
  satBudgetForWave,
} from './types.js';
import type { PowerUp, PowerUpType } from './types.js';
import * as audio from './audio.js';
import { preloadBackground, invalidateBackgroundCache } from './render.js';
import { currentMods, lockInDifficulty, getStoredDifficulty, currentDifficulty } from './difficulty.js';
import { lockInMode, getStoredMode, currentMode, isEndlessMode, isSanctumMode, isDefenderMode, isCoopCampaignMode, type RunMode } from './mode.js';
import { arenaActive, arenaCage, confineToArena, clampToArena, outsideArena } from './arena.js';
import {
  configureDeathmatchWorld,
  deathmatchActive,
  deathmatchSpawnPoint,
  deathmatchWorldH,
  deathmatchWorldW,
  confineToDeathmatch,
  outsideDeathmatch,
  makeDeathmatchRules,
} from './deathmatch.js';
import { markAchievement, resetRunAchievements } from './achievements.js';
import { gameRng, seedRun, getRngState } from './seed.js';
import { haptic } from './haptics.js';
import { markSkinUnlocked } from './skins.js';
import {
  getVisualStyle,
  isWebGLOverlayReady,
  callWebGLShipExplosion,
  callWebGLClearShipChunks,
} from './visual-style.js';
import { SpatialHash, type SpatialCircle } from './spatial.js';

// ── Initial state ─────────────────────────────────────────────────────────────

/** Fixed simulation timestep. The sim advances in exact 1/60s quanta so a
 *  run reproduces bit-identically from its seed and inputs (B3). */
export const FIXED_STEP_S = 1 / 60;
export const FIXED_STEP_MS = 1000 / 60;

function worldW(): number {
  return deathmatchActive() ? deathmatchWorldW() : WORLD_W;
}

function worldH(): number {
  return deathmatchActive() ? deathmatchWorldH() : WORLD_H;
}

export function makeInitialState(): GameState {
  return {
    phase: 'title',
    players: [makePlayerState()],
    asteroids: [],
    bullets: [],
    enemyBullets: [],
    ufos: [],
    mines: [],
    coins: [],
    powerups: [],
    particles: [],
    debris: [],
    deathmatchFeed: [],
    deathmatchRules: null,
    deathmatchStartedAt: 0,
    deathmatchEndedReason: null,
    deathmatchWinnerSlot: null,
    shockwaveRings: [],
    hyperspaceEffects: [],
    waveClearAt: null,
    phaseEpoch: 0,
    pendingTransitions: [],
    wave: 0,
    phaseStart: 0,
    lastUpdate: 0,
    elapsed: 0,
    frame: 0,
    nextUfoSpawn: getGameConfig().ufo_first_spawn_ms,
    nextMineSpawn: 0,
    warpTargetWave: 1,
    bonusStartedAt: 0,
    bonusNextSpawnAt: 0,
    bonusPreludeSpawned: 0,
    runTimeMs: 0,
    runStartedAt: 0,
    seed: 0,
    rng: null,
    nextEntityId: 0,
    bossDefeated: false,
    forgeBreached: false,
    forgeMeltdown: false,
    forgeEscaped: false,
    defenderMode: false,
    defenderTimerMs: 0,
    defenderCouncilLost: 0,
    hitStopSteps: 0,
    flash: 0,
    session: null,
    profile: null,
    coopIdentity2: null,
    toast: null,
    toastUntil: 0,
    replayBuffer: [],
    deathReplay: null,
    initialsEnteredThisRun: false,
    cheatedThisRun: false,
    ghostSamples: [],
    ghostPoseSamples: [],
    cameraTrauma: 0,
    shieldUsedThisWave: false,
    bulletsFiredThisWave: 0,
    missedShotsThisWave: 0,
    ufoSpawnedThisWave: false,
    ufoKilledThisWave: false,
    ufoKillsThisWave: 0,
    satRollsThisWave: 0,
    bulletCurtainKillTarget: 0,
    veinSwarmDueAt: 0,
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

/** Spawn a transient radial shockwave ring at world coords. Pure visual —
 *  no collision side effects. Lifetime is fixed (~380ms in render.ts), so
 *  callers only supply spawn data. Used for big-shatter feel: large
 *  asteroid breaks and vein collapse. Reduced-motion users still get the
 *  ring (it's a soft expanding stroke, not a flash) — render pass renders
 *  it at the same alpha either way. */
export function spawnShockwave(s: GameState, x: number, y: number, baseRadius: number, color: string): void {
  s.shockwaveRings.push({ x, y, startMs: performance.now(), baseRadius, color });
}

/** Freeze the simulation for `ms` to let an impact land. Render keeps running.
 *  Takes the max of any in-flight hit-stop so a brief later event can't shorten
 *  a longer earlier one (e.g. boss-down should not be cut by a stray combo hit). */
export function hitStop(s: GameState, ms: number): void {
  // Express the freeze in whole fixed sim steps so the loop can skip
  // exactly that many ticks. Takes the max of any in-flight freeze.
  const steps = Math.round(ms / FIXED_STEP_MS);
  if (steps > s.hitStopSteps) s.hitStopSteps = steps;
}

// ── Wire-stream entity ids ───────────────────────────────────────────────────
//
// Monotonic counter assigned in every spawn function for wire-bound
// entities (ship, asteroids, UFOs, mines, bullets). The live-stream
// viewer matches entities across consecutive kind 22769 frames by
// this id so it can interpolate positions smoothly — without it, the
// viewer would snap entities to new positions at the 2 Hz wire rate.
//
// Module-local; reset to 0 at startGame so a run's wire entity IDs
// reproduce from a fresh start (deterministic re-simulation, B3). Modulo
// bounds the value so JSON tuples don't bloat within a long run.
let nextEntityId = 0;
export function nextStreamEntityId(): number {
  nextEntityId = (nextEntityId + 1) % 1_000_000;
  return nextEntityId;
}
/** Read/write the module-global entity ID counter. Used by the peer harness
 *  to save and restore per-sim state between two interleaved in-process sims
 *  (a real two-client deployment has one counter per tab and never collides). */
export function getEntityIdCounter(): number { return nextEntityId; }
export function setEntityIdCounter(n: number): void { nextEntityId = n; }

function makeShip(): Ship {
  return {
    pos: { x: WORLD_W / 2, y: WORLD_H / 2 },
    vel: { x: 0, y: 0 },
    radius: SHIP_RADIUS,
    alive: true,
    id: nextStreamEntityId(),
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
    shieldHitFlash: 0,
    lastHyperspaceAt: 0,
  };
}

/** Fresh per-run telemetry, all counters zeroed. A factory (not a shared
 *  const) so each player gets its own object — the nested ufoKills record
 *  must not be aliased between players. */
function makeRunStats(): RunStats {
  return {
    ufoKills: { cruiser: 0, elite: 0, tank: 0, sniper: 0, boss: 0 },
    minesDestroyed: 0,
    largestCombo: 0,
    powerupsCollected: 0,
    veinsBroken: 0,
    asteroidsBroken: 0,
    bulletsFired: 0,
    bulletsMissed: 0,
    hyperspacesUsed: 0,
    livesLost: 0,
  };
}

/** Fresh PlayerState — a new ship plus zeroed per-player gameplay state.
 *  `lives` is a placeholder; startGame sets it from the chosen difficulty. */
function makePlayerState(): PlayerState {
  return {
    ship: makeShip(),
    targetHeading: null,
    thrustOverride: false,
    keys: {},
    score: 0,
    deathmatchKills: 0,
    deathmatchDeaths: 0,
    deathmatchStreak: 0,
    sats: 0,
    displaySats: 0,
    lives: 3,
    bonusLivesGranted: 0,
    combo: 0,
    comboExpiresAt: 0,
    rapidExpiresAt: 0,
    satboostExpiresAt: 0,
    tridentExpiresAt: 0,
    magnetExpiresAt: 0,
    fireCooldownUntil: 0,
    lurking: false,
    lurkingSince: 0,
    lurkSatsBlocked: 0,
    lurkEverDetected: false,
    runStats: makeRunStats(),
  };
}

/** Defender-mode tunables. Timer ticks DOWN from DEFENDER_RUN_MS;
 *  the player wins when it reaches 0 with at least DEFENDER_WIN_THRESHOLD
 *  council members still alive. Losing condition: defenderCouncilLost
 *  >= COUNCIL_TOTAL (i.e. every member destroyed) before the timer
 *  hits 0. */
const DEFENDER_RUN_MS = 90_000;
export const DEFENDER_WIN_THRESHOLD = 6;

export interface StartGameOptions {
  players?: number;
  defender?: boolean;
  aiOpponents?: boolean;
  aiSlots?: readonly number[];
  runMode?: RunMode;
  deathmatchRules?: Partial<DeathmatchRules>;
}

export function startGame(s: GameState, forcedSeed?: number, opts?: StartGameOptions): void {
  // 600bn flavour now runs through the standard Pallasite startGame +
  // beginWave path. beginWave(s, 1) detects flavour=600bn and spawns
  // council-member-textured asteroids instead of the wave-1 default.
  // That keeps the ship/HUD/IGNITE banner/claim flow identical to the
  // campaign — the 600bn theme is layered into the existing pipeline
  // rather than running a parallel game loop.

  // Seed the run's RNG and record the seed on state. Every run is seeded
  // now (daily mode keys off the date, otherwise a fresh random seed) so a
  // run can be deterministically re-simulated from s.seed (B3).
  s.seed = seedRun(forcedSeed);
  // seedRun() set seed.ts's module rngState; mirror onto state.rng so
  // updateGame can load/save the per-state value each tick. The module
  // global is still the live value during this startGame run (beginWave
  // below will call gameRng()), captured back onto state below.
  s.rng = getRngState();

  // Defensive re-lock — the title-screen IGNITE path also locks, but the
  // gameover SPAWN AGAIN and completion IGNITE AGAIN buttons jump straight
  // here. Without this, switching difficulty between runs (via TO TITLE then
  // back) wouldn't take effect on the next press of SPAWN AGAIN.
  lockInDifficulty(getStoredDifficulty());
  // Lock in the run mode too — campaign vs drift changes the wave-25
  // completion path. Same re-lock rationale as difficulty: button paths
  // that bypass title need this to honour the picked mode.
  lockInMode(opts?.runMode ?? getStoredMode());
  const mods = currentMods();
  const deathmatch = deathmatchActive();
  const playerCount = deathmatch ? Math.max(2, opts?.players ?? 4) : (opts?.players ?? 1);
  if (deathmatch) configureDeathmatchWorld(playerCount);
  const deathmatchAiOpponents = deathmatch && (opts?.aiOpponents ?? true);
  const deathmatchAiSlots = deathmatch && opts?.aiSlots !== undefined ? new Set(opts.aiSlots) : null;
  const deathmatchRules = deathmatch ? makeDeathmatchRules(playerCount, opts?.deathmatchRules) : null;
  s.deathmatchRules = deathmatchRules;
  s.deathmatchStartedAt = 0;
  s.deathmatchEndedReason = null;
  s.deathmatchWinnerSlot = null;
  // Defender bonus wave — protect the Council variant. Drives the
  // wave-1 council-spawn check below + win/lose timer in updateGame.
  // Triggered by either the explicit opts.defender (URL flag still
  // works) OR Mode picker → DEFENDER. lockInMode just ran above so
  // isDefenderMode() reflects the picked mode here.
  s.defenderMode = !!opts?.defender || isDefenderMode();
  s.defenderTimerMs = s.defenderMode ? DEFENDER_RUN_MS : 0;
  s.defenderCouncilLost = 0;
  s.players = [];
  for (let i = 0; i < playerCount; i++) s.players.push(makePlayerState());
  s.wave = 0;
  // Lives: admin override (starting_lives > 0) wins over the
  // difficulty default. 0 = inherit (the common case).
  const livesOverride = getGameConfig().starting_lives;
  const startingLives = deathmatch ? (deathmatchRules?.respawns ?? 0) + 1 : (livesOverride > 0 ? livesOverride : mods.livesStart);
  for (const pl of s.players) {
    pl.lives = startingLives;
  }
  // 2-player runs (couch + duel + co-op + spectate) spread the ships across the
  // playfield so they're visually distinct from the first frame. Both
  // ships face inward (toward each other) so the spawn pose reads as a
  // duel rather than two players blindly facing the same direction.
  // makeShip() defaults both to (WORLD_W/2, WORLD_H/2) which collapses
  // the spawn into a single visible ship — exactly the "no duel /
  // interaction" symptom on first contact.
  if (deathmatch) {
    for (let i = 0; i < s.players.length; i++) {
      const spawn = deathmatchSpawnPoint(i, s.players.length);
      s.players[i].ship.pos.x = spawn.x;
      s.players[i].ship.pos.y = spawn.y;
      s.players[i].ship.rot = spawn.rot;
      if (deathmatchAiSlots ? deathmatchAiSlots.has(i) : deathmatchAiOpponents && i > 0) s.players[i].ai = true;
    }
  } else if (playerCount === 2) {
    s.players[0].ship.pos.x = WORLD_W * 0.30;
    s.players[0].ship.pos.y = WORLD_H * 0.50;
    s.players[0].ship.rot = 0;                  // facing right (toward P2)
    s.players[1].ship.pos.x = WORLD_W * 0.70;
    s.players[1].ship.pos.y = WORLD_H * 0.50;
    s.players[1].ship.rot = Math.PI;            // facing left (toward P1)
  }
  s.asteroids = [];
  s.bullets = [];
  s.enemyBullets = [];
  s.ufos = [];
  s.mines = [];
  s.coins = [];
  s.powerups = [];
  s.particles = [];
  s.pendingTransitions = [];
  for (const pl of s.players) pl.ship.invulnerableUntil = s.elapsed + SHIP_INVULN_MS;
  s.nextUfoSpawn = getGameConfig().ufo_first_spawn_ms;
  s.nextMineSpawn = 0;
  s.runTimeMs = 0;
  s.runStartedAt = Date.now();
  // Clear the "achievements unlocked this run" tracker so the NIP-58
  // award handshake only ships badges genuinely earned in the new run.
  resetRunAchievements();
  s.bossDefeated = false;
  s.warpTargetWave = 1;
  s.frame = 0;
  s.hitStopSteps = 0;
  s.elapsed = 0;
  s.toast = null;
  s.toastUntil = 0;
  s.replayBuffer = [];
  s.deathReplay = null;
  s.initialsEnteredThisRun = false;
  s.debris = [];
  s.deathmatchFeed = [];
  s.cheatedThisRun = false;
  s.ghostSamples = [];
  s.ghostPoseSamples = [];
  s.cameraTrauma = 0;
  lastGhostSampleRunMs = -1;
  lastGhostPoseRunMs = -1;
  lastReplayRecordedAt = 0;
  // Entity-id counter resets per run so a run's wire IDs reproduce from a
  // fresh start — needed for deterministic re-simulation (B3). Reset BOTH
  // the module global (which beginWave's nextStreamEntityId calls are
  // reading from) and the state mirror.
  nextEntityId = 0;
  s.nextEntityId = 0;
  beginWave(s, 1);
  // Capture the post-beginWave module values back onto state so the next
  // updateGame loads from the right baseline. (beginWave bumped both via
  // gameRng() and nextStreamEntityId() to spawn the initial asteroids.)
  s.rng = getRngState();
  s.nextEntityId = nextEntityId;
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
 * pallasite is a rare jackpot throughout but never common. New mid/late types:
 *   achondrite    (~W11) — fragile volcanic, shatters into more fragments
 *   carbonaceous  (~W14) — dark primitive, slight sat bonus
 *   mesosiderite  (~W18) — rare end-game armoured stony-iron mix
 */
function pickAsteroidType(wave: number): AsteroidType {
  const arena = arenaActive();
  const deathmatch = deathmatchActive();
  const r = gameRng();
  // Campaign eases in with three stony-only waves; arena wants variety
  // from round one, so it skips that onboarding.
  if (!arena && !deathmatch && wave <= 3) return 'stony';
  // Behavioural specials roll on their own draw so they do not skew the
  // meteorite-type bands below. Kinetic is arena-only (it needs cage
  // walls). Arena rolls them from round one; campaign/drift from wave 5.
  if (arena || deathmatch || wave >= 5) {
    const sp = gameRng();
    if (sp < 0.05) return 'volatile';
    if (sp < 0.09) return 'tektite';
    if (sp < 0.12) return 'ballast';
    if (sp < 0.15) return 'lodestone';
    if (arena && sp < 0.22) return 'kinetic';
  }
  // Arena draws the full meteorite roster from the start; campaign widens
  // it wave by wave.
  const w = arena || deathmatch ? 20 : wave;
  if (w <= 6) {
    if (r < 0.05) return 'pallasite';
    if (r < 0.30) return 'iron';
    return 'stony';
  }
  if (w <= 10) {
    if (r < 0.06) return 'pallasite';
    if (r < 0.30) return 'iron';
    if (r < 0.50) return 'chondrite';
    return 'stony';
  }
  if (w <= 13) {
    if (r < 0.06) return 'pallasite';
    if (r < 0.22) return 'achondrite';
    if (r < 0.40) return 'iron';
    if (r < 0.60) return 'chondrite';
    return 'stony';
  }
  if (w <= 17) {
    if (r < 0.07) return 'pallasite';
    if (r < 0.18) return 'carbonaceous';
    if (r < 0.30) return 'achondrite';
    if (r < 0.45) return 'iron';
    if (r < 0.65) return 'chondrite';
    return 'stony';
  }
  // Waves 18-25 — full roster including the rare mesosiderite.
  if (r < 0.07) return 'pallasite';
  if (r < 0.13) return 'mesosiderite';
  if (r < 0.22) return 'carbonaceous';
  if (r < 0.32) return 'achondrite';
  if (r < 0.48) return 'iron';
  if (r < 0.68) return 'chondrite';
  return 'stony';
}

/** Drop a handful of decorative asteroids onto the non-gameplay
 *  depth bands. They drift in the background or foreground for
 *  parallax depth, take no damage and deal none. Count + visual
 *  treatment governed by the parallax setting.
 *
 *  Main campaign spawns no decoratives: players need every visible
 *  asteroid to be a gameplay rock. Decoration is reserved for showcase
 *  modes where it cannot be mistaken for a shootable hazard.
 *
 *  Size bias depends on depth: backgrounds favour small/medium (they
 *  read as distant), foregrounds favour medium/large (closer to
 *  camera). Avoids the "shot a large background rock and it just
 *  vanished" confusion. */
function spawnDecorativeAsteroids(s: GameState, wave: number): void {
  if (wave <= 1) return;
  // Campaign contract: every asteroid the player can see must be a real
  // shootable/lethal asteroid. Decorative parallax rocks looked like
  // normal hazards on wave 2 but ignored bullets and ship collision, so
  // keep them out of the main campaign/arena/co-op paths entirely.
  if (getFlavour() !== '600bn' && !isSanctumMode()) return;
  // Parallax depth bands are dressing for the enhanced visual tiers. Pure
  // vector mode stays flat — classic 1979, no background depth.
  if (getVisualStyle('asteroid') === 'vector') return;
  const count = decorativeSpawnCount(getParallaxTier());
  if (count === 0) return;
  for (let i = 0; i < count; i++) {
    const depth = pickDecorativeDepth(gameRng);
    const isBackground = depth <= 2;
    const r = gameRng();
    const size: AsteroidSize = isBackground
      ? (r < 0.55 ? 'small' : r < 0.90 ? 'medium' : 'large')
      : (r < 0.20 ? 'small' : r < 0.55 ? 'medium' : 'large');
    s.asteroids.push(spawnAsteroid(size, wave, undefined, undefined, undefined, { depth }));
  }
}

export function spawnAsteroid(size: AsteroidSize, wave: number, pos?: Vec2, vel?: Vec2, type?: AsteroidType, opts?: { vein?: boolean; councilMember?: import('./types.js').CouncilMemberRef; depth?: number; terrain?: boolean; gravity?: number }): Asteroid {
  const mods = currentMods();
  const isVein = opts?.vein === true;
  // Parallax depth band — 3 by default (gameplay plane, full collision).
  // Non-3 spawns are decorative: smaller/dimmer/faster per the depth
  // config so the eye reads them as distance, not threats.
  const depth = opts?.depth ?? 3;
  const depthCfg = DEPTH_CONFIGS[depth] ?? DEPTH_CONFIGS[3];
  // Veins are oversized and drift slowly — they're a fixed-position target,
  // not a hazard the player has to dodge. Standard asteroids use the per-wave
  // speed band as before.
  let radius = RADIUS_PER_SIZE[size] * (isVein ? VEIN_RADIUS_MUL : 1) * depthCfg.sizeMul;
  const speedBase = (ASTEROID_BASE_SPEED + wave * ASTEROID_SPEED_PER_WAVE) * mods.asteroidSpeedMul * depthCfg.speedMul;
  const sizeMul = size === 'large' ? 0.7 : size === 'medium' ? 1 : 1.5;
  const speed = isVein
    ? speedBase * 0.2 * (0.7 + gameRng() * 0.6)
    : speedBase * sizeMul * (0.7 + gameRng() * 0.6);

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

  const t = isVein ? 'pallasite' : (type ?? pickAsteroidType(wave));
  // Ballast is an oversized, sluggish obstacle — bigger and much slower
  // than a standard rock of the same size.
  if (t === 'ballast') {
    radius *= 1.55;
    velocity.x *= 0.4;
    velocity.y *= 0.4;
  }
  const cfg = ASTEROID_TYPE_CONFIG[t];

  // HP — veins use their own scaled HP, council members get the
  // beefed-up Sanctum scaling so the level lasts longer (small ships
  // chipping at large rocks should feel like a fight, not a flick),
  // everything else uses the standard per-type config.
  let hp: number;
  if (isVein) {
    hp = veinScaledHp();
  } else if (opts?.councilMember) {
    // Council mass scale — gentle bump over standard so the level
    // lasts longer than 10s but stays playable. Large 2 HP (iron 3,
    // pallasite 3), medium 1, small 1. Mass-shedding particles
    // telegraph "still has more in it" without making the rock a
    // bullet sponge.
    hp = size === 'large' ? 2 : 1;
    if (size === 'large' && (t === 'iron' || t === 'pallasite')) hp += 1;
  } else {
    hp = size === 'large' ? cfg.hp : 1;
  }
  return {
    pos: position,
    vel: velocity,
    radius,
    alive: true,
    id: nextStreamEntityId(),
    size,
    type: t,
    hp,
    hpMax: hp,
    hitFlash: 0,
    rot: Math.random() * Math.PI * 2,
    // Guarantee a visible non-zero rotation by picking sign first then
    // a strictly-positive magnitude. The old (random-0.5)*scale form
    // centred on 0 — a chunk of asteroids would spawn near-static,
    // which on a smooth 3D mesh reads as "frozen" rather than "drifting".
    // Council members get a slower band so players can read the face;
    // veins keep their slow drift. Non-gameplay depth bands get a
    // visible spin bump so they read as "tumbling toward you" — pairs
    // with the toned-down foreground speedMul to keep them readable.
    rotVel: (Math.random() < 0.5 ? -1 : 1) * (
      opts?.councilMember
        ? 0.25 + Math.random() * 0.25     // 0.25..0.50 rad/s — readable face
        : isVein
        ? 0.15 + Math.random() * 0.20     // 0.15..0.35 rad/s — gentle drift
        : depth !== 3
        ? 1.20 + Math.random() * 1.40     // 1.20..2.60 rad/s — telegraphed tumble
        : 0.50 + Math.random() * 1.00     // 0.50..1.50 rad/s — lively
    ),
    shape: makeAsteroidShape(),
    hue: Math.random() * 60 - 30,
    isVein,
    depth,
    ...(opts?.terrain ? { terrain: true } : {}),
    ...(opts?.gravity != null ? { gravity: opts.gravity } : {}),
    ...(opts?.councilMember ? { councilMember: opts.councilMember } : {}),
  };
}

/** Spawn position + the inward unit-direction the asteroid should head in. */
interface EdgeSpawn { pos: Vec2; inwardAngle: number; }

function randomEdgePosition(): EdgeSpawn {
  // Spawn from the edges of the playfield, away from the ship's centre.
  // inwardAngle points toward the centre half of the playfield so the
  // asteroid actually enters view (vs picking a random angle that could be
  // edge-parallel or outward).
  const ww = worldW();
  const wh = worldH();
  const edge = Math.floor(gameRng() * 4);
  switch (edge) {
    case 0: return { pos: { x: gameRng() * ww, y: -RADIUS_PER_SIZE.large }, inwardAngle: Math.PI / 2 };  // top -> moves down
    case 1: return { pos: { x: ww + RADIUS_PER_SIZE.large, y: gameRng() * wh }, inwardAngle: Math.PI };  // right -> moves left
    case 2: return { pos: { x: gameRng() * ww, y: wh + RADIUS_PER_SIZE.large }, inwardAngle: -Math.PI / 2 };  // bottom -> moves up
    default: return { pos: { x: -RADIUS_PER_SIZE.large, y: gameRng() * wh }, inwardAngle: 0 };  // left -> moves right
  }
}

/**
 * Hand-authored set piece for a specific wave — the campaign's "signature
 * moments". Each replaces the default procedural fill at a fixed wave to give
 * the run a memorable, talked-about beat between the procedural waves. Seven
 * slots: the Heist (5), Gauntlet (8), Gold Rush (9), Bullet Curtain (12),
 * Mother Lode (16), Maelstrom (20) and Approach (24) — spaced to escalate
 * toward the wave-25 boss. The on-screen gold banner title for each lives in
 * WAVE_SET_PIECE_BANNERS (types.ts). All spawn randomness routes through
 * gameRng so co-op lockstep stays bit-identical; the only Math.random in the
 * spawn path is cosmetic (rotation/hue/shape, excluded from the desync canary).
 */
interface WaveSetPiece {
  /** Custom wave setup — replaces the default asteroid spawn loop. */
  setup(s: GameState): void;
  /** Per-frame hook for waves with active spawning logic (e.g. curtain
   *  respawning UFOs as the player kills them). Called from updateGame
   *  after the standard ufo update. */
  tick?(s: GameState, dt: number): void;
  /** Override the wave-clear check. Defaults to "no asteroids alive". */
  isCleared?(s: GameState): boolean;
  /** Suppress the default placeWaveMines pass — set pieces with custom
   *  mine layouts use this so the procedural mines don't pile on. */
  suppressDefaultMines?: boolean;
  /** Suppress the standard UFO respawn timer — curtain/heist pieces
   *  drive spawns themselves via tick() so the loop's automatic spawn
   *  shouldn't fire. */
  suppressDefaultUfos?: boolean;
  /** Override the player's spawn position + facing for both the
   *  wavestart entry AND mid-wave respawns after death. Without this
   *  the player respawns at WORLD_W/2, WORLD_H/2 — which on the heist
   *  drops them straight onto the pallasite + into the mine ring.
   *  Returned `rot` defaults to -PI/2 (facing up). */
  playerSpawn?: { x: number; y: number; rot?: number };
}

const WAVE_SET_PIECES: Record<number, WaveSetPiece> = {
  // Wave 5 — Pallasite Heist. The pallasite glows at centre, ringed by
  // a tight mine "vault". Player spawns at the bottom edge so the prize
  // is across the screen, not directly under them. Iron+chondrite chaos
  // drifts in from the edges to keep the field busy while they thread
  // the ring — the heist isn't just a target, it's a moving-cover scrap
  // with one obvious prize.
  5: {
    playerSpawn: { x: WORLD_W / 2, y: WORLD_H - 90 },
    setup(s) {
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      // The prize — a stationary vein at centre, beefier than the random
      // vein event so the heist plays as a sustained mini-boss fight on
      // top of the mine ring + chondrite chaos. 100/200/300 hits on
      // easy/normal/hard, with the standard vein power-up drops every 25
      // hits to keep the player armed during the long engagement.
      const d = currentDifficulty();
      const vaultHp = d === 'easy' ? 100 : d === 'hard' ? 300 : 200;
      const vault = spawnAsteroid('large', s.wave, { x: cx, y: cy }, { x: 0, y: 0 }, 'pallasite', { vein: true });
      vault.hp = vaultHp;
      vault.hpMax = vaultHp;
      s.asteroids.push(vault);
      // Vault — 5 mines in a tight ring. Tight enough that brute-forcing
      // through gets the player nicked by gravity wells, so they need to
      // either snipe through gaps or warp.
      const ringR = 90;
      const N = 5;
      for (let i = 0; i < N; i++) {
        const angle = (Math.PI * 2 * i) / N + Math.PI / 10;
        s.mines.push(makeMine({ x: cx + Math.cos(angle) * ringR, y: cy + Math.sin(angle) * ringR }));
      }
      // Chaos — two iron and three chondrite large asteroids drifting in
      // from random edge positions. Iron takes two hits each so it carries
      // weight even on a short wave; chondrites swarm into smalls. Enough
      // bodies to make the player choose: clear the chaos first or sprint
      // to the prize and outrun the fragments.
      for (let i = 0; i < 2; i++) s.asteroids.push(spawnAsteroid('large', s.wave, undefined, undefined, 'iron'));
      for (let i = 0; i < 3; i++) s.asteroids.push(spawnAsteroid('large', s.wave, undefined, undefined, 'chondrite'));
    },
    suppressDefaultMines: true,
  },

  // Wave 8 — The Gauntlet. Mines arm for the first time this wave, so we make
  // their debut a designed corridor: three pairs narrow into a funnel, wide at
  // the bottom mouth where the player spawns and tightening to a throat at the
  // top. At the head sits a pallasite VEIN that fires rock-shards back DOWN the
  // corridor at whoever's shooting it — so camping the mouth and sniping is
  // out; you have to keep weaving the shards (and two descending iron tanks)
  // while you chip it down. The walls' overlapping gravity keeps the centre the
  // only clean lane, and it still bites if you drift.
  8: {
    playerSpawn: { x: WORLD_W / 2, y: WORLD_H - 70 },
    setup(s) {
      const cx = WORLD_W / 2;
      // Funnel rows: bottom gap ~540px, throat ~260px. Each `half` is the
      // x-offset of the pair from centre at that height.
      const rows = [
        { y: 545, half: 270 },
        { y: 360, half: 200 },
        { y: 185, half: 130 },
      ];
      for (const r of rows) {
        s.mines.push(makeMine({ x: cx - r.half, y: r.y }));
        s.mines.push(makeMine({ x: cx + r.half, y: r.y }));
      }
      // The head of the funnel hits back: a vein that spits shards down the
      // corridor at the firing pilot, so the mouth is no longer a safe snipe
      // spot. Modest HP — a quick gauntlet boss, not a mega-vein.
      const d = currentDifficulty();
      const hp = d === 'easy' ? 40 : d === 'hard' ? 90 : 60;
      const boss = spawnAsteroid('large', s.wave, { x: cx, y: 120 }, { x: 0, y: 0 }, 'pallasite', { vein: true });
      boss.hp = hp;
      boss.hpMax = hp;
      boss.veinRetaliates = true;
      s.asteroids.push(boss);
      // Two iron tanks sweep down the flanks, pressuring the mouth so the
      // player can't just sit there casually dodging the shards.
      s.asteroids.push(spawnAsteroid('large', s.wave, { x: cx - 250, y: 70 }, { x: 16, y: 34 }, 'iron'));
      s.asteroids.push(spawnAsteroid('large', s.wave, { x: cx + 250, y: 70 }, { x: -16, y: 34 }, 'iron'));
    },
    suppressDefaultMines: true,
    suppressDefaultUfos: true,
  },

  // Wave 9 — Gold Rush. Act II's curtain-up, reimagined as a closing cage:
  // eight pallasite (one the jackpot vein) start wide and rush INWARD, sealing
  // into a tight ring around the player at dead centre. You're boxed in — the
  // only way out is to blast a gap — and the wave only clears once the whole
  // ring is broken, so hyperspacing merely relocates you (the cage is still
  // there to clear). Raining sats the whole way: greed the jackpot vein, or
  // punch a quick exit and pick the ring apart from outside.
  9: {
    playerSpawn: { x: WORLD_W / 2, y: WORLD_H / 2 },  // dead centre — the cage closes on you
    setup(s) {
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      const N = 8;
      const d = currentDifficulty();
      const veinHp = d === 'easy' ? 40 : d === 'hard' ? 90 : 60;
      const closeSpeed = 52;  // px/s inward — seals in ~2.4s, fast enough to actually trap
      for (let i = 0; i < N; i++) {
        const ang = (Math.PI * 2 * i) / N - Math.PI / 2;
        const r = 250;
        const pos = { x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r };
        const vel = { x: -Math.cos(ang) * closeSpeed, y: -Math.sin(ang) * closeSpeed };
        const rich = i === 3;  // a side slot is the jackpot vein
        const a = spawnAsteroid('large', s.wave, pos, vel, 'pallasite', rich ? { vein: true } : undefined);
        if (rich) {
          a.hp = veinHp; a.hpMax = veinHp;
          a.radius = RADIUS_PER_SIZE.large;  // match the ring so the cage seals even
        }
        s.asteroids.push(a);
      }
    },
    tick(s) {
      // Halt each ring rock at the seal radius so the eight lock into a tight
      // cage instead of piling onto the player at the centre. Only the large
      // originals are pinned; fragments fly free once a rock is shot. Pure
      // geometry, no RNG — deterministic for co-op lockstep.
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      // 8 large rocks (r48) just-touch at ~125px; seal a hair beyond so they
      // never overlap — overlap makes the physics engine fling them apart as
      // they converge. The ~2px edge gaps are far too small for the ship (r12)
      // to slip through, so the cage stays solid until you blast a rock out.
      const SEAL_R = 130;  // ~70px inner bubble for the boxed-in player
      for (const a of s.asteroids) {
        if (!a.alive || a.size !== 'large') continue;
        const dx = a.pos.x - cx, dy = a.pos.y - cy;
        const dist = Math.hypot(dx, dy);
        if (dist <= SEAL_R && dist > 0.1) {
          const k = SEAL_R / dist;  // clamp back out to the ring and stop
          a.pos.x = cx + dx * k;
          a.pos.y = cy + dy * k;
          a.vel.x = 0;
          a.vel.y = 0;
        }
      }
    },
    suppressDefaultMines: true,
    suppressDefaultUfos: true,
  },

  // Wave 12 — Bullet Curtain. No asteroids. Cruisers respawn as they die,
  // up to a target kill count. Pure dodge wave — the player has to read
  // bullet patterns instead of clearing rocks.
  12: {
    setup(s) {
      s.bulletCurtainKillTarget = 6;
      // Two starters from opposite sides. Push directly so we control y
      // and dir rather than the random spawnUfo placement.
      s.ufos.push(makeCurtainCruiser(s, 1));
      s.ufos.push(makeCurtainCruiser(s, -1));
      s.ufoSpawnedThisWave = true;
    },
    tick(s, dt) {
      void dt;
      if (s.ufoKillsThisWave >= s.bulletCurtainKillTarget) return;
      const aliveMinions = s.ufos.filter(u => u.alive && u.type !== 'boss').length;
      // Keep two cruisers in play until the kill target is reached.
      if (aliveMinions < 2 && (s.ufoKillsThisWave + aliveMinions) < s.bulletCurtainKillTarget) {
        const dir: 1 | -1 = gameRng() < 0.5 ? 1 : -1;
        s.ufos.push(makeCurtainCruiser(s, dir));
      }
    },
    isCleared(s) {
      return s.ufoKillsThisWave >= s.bulletCurtainKillTarget
          && s.ufos.every(u => !u.alive || u.type === 'boss');
    },
    suppressDefaultMines: true,
    suppressDefaultUfos: true,
  },

  // Wave 16 — Mother Lode. The pallasite-seam tagline made literal: one
  // colossal vein dominates the centre, far beefier and bigger than the heist
  // vault, pinned by two gravity wells so you can't simply park on it and
  // grind. The harvest is a committed orbit — dipping in and out of the pull
  // to land shots — and it showers sats the whole way down. Two iron escorts
  // drift the flanks for incidental pressure.
  16: {
    playerSpawn: { x: WORLD_W / 2, y: WORLD_H - 90 },
    setup(s) {
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      const d = currentDifficulty();
      const hp = d === 'easy' ? 180 : d === 'hard' ? 420 : 300;
      const lode = spawnAsteroid('large', s.wave, { x: cx, y: cy - 20 }, { x: 0, y: 0 }, 'pallasite', { vein: true });
      lode.hp = hp;
      lode.hpMax = hp;
      lode.radius *= 1.5;  // a true mega — reads as the mountain it is
      lode.veinRetaliates = true;  // hits back — the more you fire, the more comes back
      s.asteroids.push(lode);
      // Two wells pinning the lode left and right.
      s.mines.push(makeMine({ x: cx - 200, y: cy }));
      s.mines.push(makeMine({ x: cx + 200, y: cy }));
      // Iron escorts drifting in from the edges.
      for (let i = 0; i < 2; i++) s.asteroids.push(spawnAsteroid('large', s.wave, undefined, undefined, 'iron'));
    },
    suppressDefaultMines: true,
    suppressDefaultUfos: true,
  },

  // Wave 17 — EAGLE STATION · "The Placer". Act III's opener and the campaign's
  // first ARTIFICIAL structure: the rig that's been seeding your hunt. A reactor
  // core (a retaliating vein) sits at centre, ringed by three slowly-rotating
  // terrain arms — solid, so they sweep across and block your fire — each tipped
  // with an emitter pod that keeps placing anomalous rocks into the field until
  // you knock it out. Break the core to bring the whole rig down. Pure geometry
  // + the deterministic RNG drive it, so co-op lockstep is unaffected.
  17: {
    playerSpawn: { x: WORLD_W / 2, y: WORLD_H - 90 },
    setup(s) {
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      const d = currentDifficulty();
      // Core reactor — the weak point. No shard-retaliation here: the threat is
      // the rocks the pods throw, so stacking retaliation on top read as "too
      // hard". Just a destructible reactor you chip through the rotating arms.
      const coreHp = d === 'easy' ? 90 : d === 'hard' ? 220 : 140;
      const core = spawnAsteroid('large', s.wave, { x: cx, y: cy }, { x: 0, y: 0 }, 'pallasite', { vein: true });
      core.hp = coreHp;
      core.hpMax = coreHp;
      core.radius = 38;  // compact core so the tighter arm ring still clears it (portrait fit)
      core.stationPart = 'core';
      s.asteroids.push(core);
      // Three arms (indestructible terrain beams) + emitter pods at their tips,
      // evenly spaced. The tick drives their live positions from stationSlot +
      // the rig's spin; seed them at the slot so frame 1 already looks right.
      for (let i = 0; i < STATION_ARMS; i++) {
        const slot = (Math.PI * 2 * i) / STATION_ARMS - Math.PI / 2;
        const arm = spawnAsteroid('large', s.wave, { x: cx + Math.cos(slot) * STATION_ARM_R, y: cy + Math.sin(slot) * STATION_ARM_R }, { x: 0, y: 0 }, 'iron', { terrain: true });
        arm.radius = 30;  // slimmer cover so the tighter ring still clears the core (no overlap → no shove)
        arm.stationPart = 'arm';
        arm.stationSlot = slot;
        s.asteroids.push(arm);
        const em = spawnAsteroid('small', s.wave, { x: cx + Math.cos(slot) * STATION_EMITTER_R, y: cy + Math.sin(slot) * STATION_EMITTER_R }, { x: 0, y: 0 }, 'pallasite');
        em.hp = STATION_EMITTER_HP;
        em.hpMax = STATION_EMITTER_HP;
        em.stationPart = 'emitter';
        em.stationSlot = slot;
        s.asteroids.push(em);
      }
    },
    tick(s, dt) {
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      const spin = s.elapsed * STATION_ROT_SPEED;
      // Rail the arms + emitters around the core on their slots (the rig spins).
      for (const a of s.asteroids) {
        if (!a.alive || (a.stationPart !== 'arm' && a.stationPart !== 'emitter')) continue;
        const ang = (a.stationSlot ?? 0) + spin;
        const rad = a.stationPart === 'arm' ? STATION_ARM_R : STATION_EMITTER_R;
        a.pos.x = cx + Math.cos(ang) * rad;
        a.pos.y = cy + Math.sin(ang) * rad;
        a.vel.x = 0;
        a.vel.y = 0;
        a.rot = ang;  // orient the beam/pod along its radial for the renderer
      }
      const d = currentDifficulty();
      const prev = s.elapsed - dt * 1000;
      // Each cycle a live pod LAUNCHES a homing missile (up to a live cap) aimed
      // at the nearest pilot — it then steers (see the enemy-bullet update) and
      // can be shot down. Kill the pods to choke the stream. Stateless boundary.
      const missileMs = STATION_MISSILE_MS[d];
      if (Math.floor(s.elapsed / missileMs) > Math.floor(prev / missileMs)) {
        const missiles = s.enemyBullets.filter(b => b.alive && b.homing).length;
        const emitters = s.asteroids.filter(a => a.alive && a.stationPart === 'emitter');
        if (emitters.length > 0 && missiles < STATION_MISSILE_CAP[d]) {
          const em = emitters[Math.floor(gameRng() * emitters.length)];
          let tx = cx, ty = WORLD_H, bestSq = Infinity;
          for (const pl of s.players) {
            if (!pl.ship.alive) continue;
            const ddx = pl.ship.pos.x - em.pos.x, ddy = pl.ship.pos.y - em.pos.y;
            const dSq = ddx * ddx + ddy * ddy;
            if (dSq < bestSq) { bestSq = dSq; tx = pl.ship.pos.x; ty = pl.ship.pos.y; }
          }
          const aim = Math.atan2(ty - em.pos.y, tx - em.pos.x);
          s.enemyBullets.push({
            pos: { x: em.pos.x + Math.cos(aim) * em.radius * 1.4, y: em.pos.y + Math.sin(aim) * em.radius * 1.4 },
            vel: { x: Math.cos(aim) * STATION_MISSILE_SPEED, y: Math.sin(aim) * STATION_MISSILE_SPEED },
            radius: STATION_MISSILE_RADIUS,
            alive: true,
            id: nextStreamEntityId(),
            ttl: STATION_MISSILE_TTL_MS,
            pierceLeft: 0,
            caromHit: false,
            wrapped: false,
            hasLanded: false,
            owner: -1,
            homing: true,
          });
          em.hitFlash = 1;                                       // pod flares as it fires
          spawnShockwave(s, em.pos.x, em.pos.y, em.radius * 1.9, '#ffb24a');
          spawnParticles(s, em.pos.x, em.pos.y, 14, '#ffb24a', 300, 380);
          spawnParticles(s, em.pos.x, em.pos.y, 6, '#fff5d8', 360, 280);
          audio.ufoShoot();
        }
      }
      // Ambient debris: a rock of a random type drifts through now and then so
      // the field isn't dead between drone launches.
      if (Math.floor(s.elapsed / STATION_AMBIENT_MS) > Math.floor(prev / STATION_AMBIENT_MS)) {
        const loose = s.asteroids.filter(a => a.alive && a.stationPart == null && !a.isVein).length;
        if (loose < 5) {
          const types: AsteroidType[] = ['iron', 'pallasite', 'stony', 'chondrite'];
          const t = types[Math.floor(gameRng() * types.length)];
          s.asteroids.push(spawnAsteroid(gameRng() < 0.5 ? 'large' : 'medium', s.wave, undefined, undefined, t));
        }
      }
    },
    isCleared(s) {
      // The rig falls when the core dies — drones + ambient rocks don't gate it.
      return !s.asteroids.some(a => a.alive && a.stationPart === 'core');
    },
    suppressDefaultMines: true,
    suppressDefaultUfos: true,
  },

  // Wave 20 — The Maelstrom. The five-wells tagline as a set-piece: a pentagon
  // of mines rings a pallasite prize at the dead centre, with stony debris
  // caught in the swirl. Every approach to the eye crosses at least one
  // gravity well, so reaching it is a problem of timing and braking, not just
  // aim. Act III's signature gauntlet — the gravity-well showcase.
  20: {
    playerSpawn: { x: WORLD_W / 2, y: WORLD_H - 70 },
    setup(s) {
      const cx = WORLD_W / 2, cy = WORLD_H / 2;
      const ringR = 200;
      const N = 5;
      for (let i = 0; i < N; i++) {
        const ang = (Math.PI * 2 * i) / N - Math.PI / 2;  // point-up pentagon
        s.mines.push(makeMine({ x: cx + Math.cos(ang) * ringR, y: cy + Math.sin(ang) * ringR }));
      }
      // The eye of the storm — a vein prize reachable only by threading the
      // pentagon. Difficulty-scaled so it's a real commitment.
      const d = currentDifficulty();
      const hp = d === 'easy' ? 120 : d === 'hard' ? 280 : 180;
      const eye = spawnAsteroid('large', s.wave, { x: cx, y: cy }, { x: 0, y: 0 }, 'pallasite', { vein: true });
      eye.hp = hp;
      eye.hpMax = hp;
      eye.veinRetaliates = true;  // the eye fires back
      s.asteroids.push(eye);
      // Stony debris drawn into the swirl — keeps the player moving while they
      // pick their entry window.
      for (let i = 0; i < 4; i++) s.asteroids.push(spawnAsteroid('large', s.wave, undefined, undefined, 'stony'));
    },
    suppressDefaultMines: true,
    suppressDefaultUfos: true,
  },

  // Wave 24 — The Approach. The last orbit before the horizon: the boss's
  // vanguard. A formation wall of iron (tanky) and chondrite (splits into a
  // swarm) sweeps down from the top edge while two cruisers escort the flanks,
  // and a four-corner mine perimeter denies the safe edges so the player has
  // to hold the middle against the wall. No prize, no breather — just the
  // weight of what's coming. Punch through the wall and the gate opens.
  24: {
    playerSpawn: { x: WORLD_W / 2, y: WORLD_H - 80 },
    setup(s) {
      // The wall — a rank of heavy rocks descending in formation. The y-stagger
      // on alternating columns reads as a deliberate echelon, not random scatter.
      const cols = 6;
      for (let i = 0; i < cols; i++) {
        const x = 140 + i * ((WORLD_W - 280) / (cols - 1));
        const type: AsteroidType = i % 2 === 0 ? 'iron' : 'chondrite';
        s.asteroids.push(spawnAsteroid('large', s.wave, { x, y: -40 - (i % 2) * 60 }, { x: 0, y: 55 }, type));
      }
      // Two cruiser escorts sweeping in from the sides — the boss's outriders.
      s.ufos.push(makeEdgeUfo('cruiser', 1));
      s.ufos.push(makeEdgeUfo('cruiser', -1));
      s.ufoSpawnedThisWave = true;
      // Four-corner mine perimeter — denies the easy edges.
      s.mines.push(makeMine({ x: 200, y: 160 }));
      s.mines.push(makeMine({ x: WORLD_W - 200, y: 160 }));
      s.mines.push(makeMine({ x: 200, y: WORLD_H - 160 }));
      s.mines.push(makeMine({ x: WORLD_W - 200, y: WORLD_H - 160 }));
    },
    suppressDefaultMines: true,
    suppressDefaultUfos: true,  // our own escorts are placed in setup; no timer spawns
  },
};

// ── THE FORGE — wave-25 finale boss ──────────────────────────────────────────
// The campaign's climax (replaces the old bouncing gun-UFO). Peel the rotating
// shell of destructible pods to expose the core; the core wakes on its first hit
// and fires a telegraphed 360° pulse (ramping as it's worn down); the forge
// places lethal rocks throughout. Built on EAGLE STATION's rig tech (stationPart
// core/arm/emitter), so the pods + core render for free on the 2D + mesh tiers.
// Tuning lives in FORGE_* (types.ts). Portrait framing is handled by the
// follow-cam bias in render.ts (FORGE_CAM_BIAS). All spawn randomness routes
// through gameRng so co-op lockstep stays bit-identical; the only Math.random in
// the spawn path is cosmetic (rotation/hue/shape, excluded from the canary).
// See docs/plans/2026-06-03-wave25-forge-boss.md.

/** The core's signature: a dense 360° bullet pulse. Rotation is randomised per
 *  beat so a camper can't sit in a fixed gap between spokes. Reuses the enemy-
 *  bullet shape + UFO bullet constants; only the cosmetic rotation uses gameRng. */
function forgeCorePulse(s: GameState, core: Asteroid, n: number): void {
  const mods = currentMods();
  const baseRot = gameRng() * (Math.PI * 2);
  const speed = UFO_BULLET_SPEED * UFO_BULLET_SPEED_MUL.boss * mods.ufoBulletSpeedMul * 0.75;
  for (let i = 0; i < n; i++) {
    const ang = baseRot + (Math.PI * 2 * i) / n;
    s.enemyBullets.push({
      pos: { x: core.pos.x, y: core.pos.y },
      vel: { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed },
      radius: BULLET_RADIUS + 1,
      alive: true,
      id: nextStreamEntityId(),
      ttl: UFO_BULLET_TTL_MS,
      pierceLeft: 0,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
      owner: -1,
    });
  }
  spawnShockwave(s, core.pos.x, core.pos.y, core.radius * 2.6, '#9be15d');
  spawnParticles(s, core.pos.x, core.pos.y, 20, '#9be15d', 340, 560);
  bumpTrauma(s, 0.3);
  hitStop(s, 40);
  audio.ufoShoot();
}

const THE_FORGE: WaveSetPiece = {
  // A real corner of the play area, not dead-below. On portrait the boss-wave
  // camera bias (render.ts, FORGE_CAM_BIAS) frames the ship + the central Forge
  // together, so the corner reads on a phone too — not just landscape.
  playerSpawn: FORGE_SPAWN,
  setup(s) {
    s.forgeBreached = false;
    s.forgeMeltdown = false;
    s.forgeEscaped = false;
    const d = currentDifficulty();
    const cx = WORLD_W / 2, cy = FORGE_CENTRE_Y;
    // Core — a vein at centre. Sealed only in the emergent sense: the shell
    // blocks fire, so it's unreachable until you blow a gap facing it.
    const core = spawnAsteroid('large', s.wave, { x: cx, y: cy }, { x: 0, y: 0 }, 'pallasite', { vein: true });
    core.hp = FORGE_CORE_HP[d]; core.hpMax = FORGE_CORE_HP[d];
    core.radius = FORGE_CORE_R;
    core.stationPart = 'core';
    s.asteroids.push(core);
    // The shell — FORGE_SEGMENTS destructible pods evenly spaced on the ring,
    // railed by the spin tick. Each one you kill opens its slot as a firing line.
    for (let i = 0; i < FORGE_SEGMENTS; i++) {
      const slot = (Math.PI * 2 * i) / FORGE_SEGMENTS - Math.PI / 2;
      const seg = spawnAsteroid('small', s.wave, { x: cx + Math.cos(slot) * FORGE_RING_R, y: cy + Math.sin(slot) * FORGE_RING_R }, { x: 0, y: 0 }, 'pallasite');
      seg.radius = FORGE_SEG_R;
      seg.hp = FORGE_VENT_HP[d]; seg.hpMax = FORGE_VENT_HP[d];
      seg.stationPart = 'emitter';
      seg.stationSlot = slot;
      s.asteroids.push(seg);
    }
  },
  tick(s, dt) {
    const d = currentDifficulty();
    const cx = WORLD_W / 2, cy = FORGE_CENTRE_Y;
    const prev = s.elapsed - dt * 1000;
    const spin = s.elapsed * FORGE_SPIN;
    // Rail the live shell segments around the core (pure geometry, deterministic).
    for (const a of s.asteroids) {
      if (!a.alive || a.stationPart !== 'emitter') continue;
      const ang = (a.stationSlot ?? 0) + spin;
      a.pos.x = cx + Math.cos(ang) * FORGE_RING_R;
      a.pos.y = cy + Math.sin(ang) * FORGE_RING_R;
      a.vel.x = 0; a.vel.y = 0;
      a.rot = ang;
    }
    // Shell pods lob homing missiles at the nearest pilot — peeling under fire is
    // what makes it a fight, not target practice. (Built on EAGLE STATION; the
    // missiles steer at a difficulty-scaled turn cap in the enemy-bullet update.)
    const missileMs = STATION_MISSILE_MS[d];
    if (Math.floor(s.elapsed / missileMs) > Math.floor(prev / missileMs)) {
      const missiles = s.enemyBullets.filter(b => b.alive && b.homing).length;
      const pods = s.asteroids.filter(a => a.alive && a.stationPart === 'emitter');
      if (pods.length > 0 && missiles < FORGE_MISSILE_CAP[d]) {
        const em = pods[Math.floor(gameRng() * pods.length)];
        let tx = cx, ty = WORLD_H, bestSq = Infinity;
        for (const pl of s.players) {
          if (!pl.ship.alive) continue;
          const ddx = pl.ship.pos.x - em.pos.x, ddy = pl.ship.pos.y - em.pos.y;
          const dSq = ddx * ddx + ddy * ddy;
          if (dSq < bestSq) { bestSq = dSq; tx = pl.ship.pos.x; ty = pl.ship.pos.y; }
        }
        const aim = Math.atan2(ty - em.pos.y, tx - em.pos.x);
        const mspd = STATION_MISSILE_SPEED * FORGE_MISSILE_SPEED_MUL[d];
        s.enemyBullets.push({
          pos: { x: em.pos.x + Math.cos(aim) * em.radius * 1.4, y: em.pos.y + Math.sin(aim) * em.radius * 1.4 },
          vel: { x: Math.cos(aim) * mspd, y: Math.sin(aim) * mspd },
          radius: STATION_MISSILE_RADIUS,
          alive: true,
          id: nextStreamEntityId(),
          ttl: STATION_MISSILE_TTL_MS * FORGE_MISSILE_TTL_MUL[d],
          pierceLeft: 0,
          caromHit: false,
          wrapped: false,
          hasLanded: false,
          owner: -1,
          homing: true,
        });
        em.hitFlash = 1;
        spawnShockwave(s, em.pos.x, em.pos.y, em.radius * 1.9, '#ffb24a');
        spawnParticles(s, em.pos.x, em.pos.y, 14, '#ffb24a', 300, 380);
        audio.ufoShoot();
      }
    }
    const core = s.asteroids.find(a => a.alive && a.stationPart === 'core');

    // BREACH beat — once half the shell is down, announce the core exposed.
    const segsAlive = s.asteroids.filter(a => a.alive && a.stationPart === 'emitter').length;
    if (!s.forgeBreached && segsAlive <= Math.floor(FORGE_SEGMENTS / 2)) {
      s.forgeBreached = true;
      if (core) {
        spawnShockwave(s, core.pos.x, core.pos.y, core.radius * 3, '#9be15d');
        spawnParticles(s, core.pos.x, core.pos.y, 40, '#9be15d', 280, 700);
      }
      bumpTrauma(s, 0.6);
      hitStop(s, 260);
      audio.pulseDuck(0.45, 280);
      toastNow(s, 'SHELL BREACHED · CORE EXPOSED');
    }

    // THE FORGE PULSES — the core wakes on its first hit, then every few seconds
    // it charges (telegraph glow) and releases a dense 360° ring of bullets.
    // Rotation is randomised each beat (no fixed-gap camp); density + cadence
    // ramp as the core is worn down. See forgeCorePulse.
    if (core && core.hp < core.hpMax && !s.forgeEscaped) {
      const frac = core.hp / core.hpMax;
      const band = frac < 0.34 ? 'low' : frac < 0.67 ? 'mid' : 'fresh';
      const pulseMs = FORGE_PULSE_CADENCE_MS[band] * FORGE_PULSE_CADENCE_MUL[d];
      const pulseN = Math.max(5, Math.round(FORGE_PULSE_DENSITY[band] * FORGE_PULSE_DENSITY_MUL[d]));
      // Telegraph: core glows + sheds sparks in the ~440ms before release.
      const toRelease = pulseMs - (s.elapsed % pulseMs);
      if (toRelease < 440) {
        const k = 1 - toRelease / 440;
        core.hitFlash = Math.max(core.hitFlash, 0.35 + 0.65 * k);
        if (Math.floor(s.elapsed / 80) > Math.floor(prev / 80)) {
          spawnParticles(s, core.pos.x, core.pos.y, 3, '#9be15d', 140 + 240 * k, 240);
        }
      }
      if (Math.floor(s.elapsed / pulseMs) > Math.floor(prev / pulseMs)) {
        forgeCorePulse(s, core, pulseN);
      }
    }

    // MELTDOWN · EVENT HORIZON — below FORGE_MELTDOWN_FRAC the forge's
    // containment fails: a ring of indestructible gravity wells appears and
    // tightens toward the core as you push it to death, squeezing the fight into
    // the pulse zone. The wells are the only mines here (suppressDefaultMines),
    // so railing every live mine repositions the ring. Pure geometry → deterministic.
    if (core) {
      const frac = core.hp / core.hpMax;
      if (!s.forgeMeltdown && frac < FORGE_MELTDOWN_FRAC) {
        s.forgeMeltdown = true;
        for (let i = 0; i < FORGE_MELTDOWN_WELLS; i++) {
          const ang = (Math.PI * 2 * i) / FORGE_MELTDOWN_WELLS - Math.PI / 2;
          const w = makeMine({ x: cx + Math.cos(ang) * FORGE_MELTDOWN_R_START, y: cy + Math.sin(ang) * FORGE_MELTDOWN_R_START }, 99999);
          w.gravityRange = FORGE_MELTDOWN_WELL_RANGE;       // wide field — can't find a calm spot
          w.gravityStrength = FORGE_MELTDOWN_WELL_STRENGTH; // strong pull — camping the core gets dragged off
          s.mines.push(w);
        }
        bumpTrauma(s, 0.8);
        hitStop(s, 300);
        audio.pulseDuck(0.5, 320);
        spawnShockwave(s, cx, cy, FORGE_MELTDOWN_R_START * 1.25, '#ff5050');
        spawnParticles(s, cx, cy, 36, '#ff5050', 320, 760);
        toastNow(s, 'EVENT HORIZON · CONTAINMENT FAILING');
      }
      if (s.forgeMeltdown) {
        // Ring tightens R_START → R_MIN as HP drops FRAC → 0, slowly counter-rotating.
        const ratio = Math.max(0, Math.min(1, frac / FORGE_MELTDOWN_FRAC));
        const ringR = FORGE_MELTDOWN_R_MIN + (FORGE_MELTDOWN_R_START - FORGE_MELTDOWN_R_MIN) * ratio;
        const mspin = s.elapsed * FORGE_MELTDOWN_SPIN;
        const wells = s.mines.filter(m => m.alive);
        for (let i = 0; i < wells.length; i++) {
          const ang = (Math.PI * 2 * i) / FORGE_MELTDOWN_WELLS - Math.PI / 2 + mspin;
          wells[i].pos.x = cx + Math.cos(ang) * ringR;
          wells[i].pos.y = cy + Math.sin(ang) * ringR;
        }
      }

      // ESCAPE / THE CHASE — below FORGE_ESCAPE_FRAC the core breaks containment:
      // the rig + wells tear apart and the bare core FLEES the nearest pilot. You
      // have to run it down to finish it (it keeps pulsing as it runs). Velocity is
      // set here each frame; the asteroid update integrates the position.
      if (!s.forgeEscaped && frac < FORGE_ESCAPE_FRAC) {
        s.forgeEscaped = true;
        core.hp = Math.min(core.hp, FORGE_ESCAPE_HP[d]);  // the chase is a SHORT run-down, not a long grind on a moving target
        for (const a of s.asteroids) {                 // the rig tears apart — pods blow
          if (a.alive && a.stationPart != null && a !== core) {
            a.alive = false;
            spawnShockwave(s, a.pos.x, a.pos.y, a.radius * 2, '#ffb24a');
            spawnParticles(s, a.pos.x, a.pos.y, 16, '#ffb24a', 340, 600);
          }
        }
        for (const m of s.mines) {                     // containment broken — wells blow
          spawnShockwave(s, m.pos.x, m.pos.y, 50, '#ff5050');
          spawnParticles(s, m.pos.x, m.pos.y, 12, '#ff5050', 300, 500);
        }
        s.mines = [];
        const ang0 = gameRng() * Math.PI * 2;          // launch the bare core off in a random heading
        core.vel.x = Math.cos(ang0) * FORGE_ESCAPE_SPEED;
        core.vel.y = Math.sin(ang0) * FORGE_ESCAPE_SPEED;
        bumpTrauma(s, 0.8); hitStop(s, 200); audio.pulseDuck(0.5, 320); audio.explosion(1.3);
        spawnShockwave(s, core.pos.x, core.pos.y, core.radius * 4, '#9be15d');
        spawnParticles(s, core.pos.x, core.pos.y, 30, '#9be15d', 360, 700);
        toastNow(s, 'CONTAINMENT BREACHED · RUN IT DOWN');
      }
      if (s.forgeEscaped) {
        // Keep the bare core a CONSISTENT, hittable size — the vein would otherwise
        // shrink to a near-invisible dot at this HP, making the chase brutal.
        core.radius = FORGE_CORE_R * 1.5;              // a bigger, clearer target — the moving core was too small to hit
        const escSpeed = FORGE_ESCAPE_SPEED * (d === 'easy' ? 0.72 : d === 'hard' ? 1.12 : 1);
        // Move like a UFO: fly straight, bounce off all four walls, hold a steady speed.
        const M = 70;
        if (core.pos.x < M && core.vel.x < 0) core.vel.x = -core.vel.x;
        else if (core.pos.x > WORLD_W - M && core.vel.x > 0) core.vel.x = -core.vel.x;
        if (core.pos.y < M && core.vel.y < 0) core.vel.y = -core.vel.y;
        else if (core.pos.y > WORLD_H - M && core.vel.y > 0) core.vel.y = -core.vel.y;
        const vm = Math.hypot(core.vel.x, core.vel.y) || 1;
        core.vel.x = core.vel.x / vm * escSpeed;
        core.vel.y = core.vel.y / vm * escSpeed;
        if (Math.floor(s.elapsed / FORGE_ESCAPE_ZIG_MS) > Math.floor(prev / FORGE_ESCAPE_ZIG_MS)) {
          let px = cx, py = cy, bestSq = Infinity;
          for (const pl of s.players) {
            if (!pl.ship.alive) continue;
            const ddx = pl.ship.pos.x - core.pos.x, ddy = pl.ship.pos.y - core.pos.y;
            const dSq = ddx * ddx + ddy * ddy;
            if (dSq < bestSq) { bestSq = dSq; px = pl.ship.pos.x; py = pl.ship.pos.y; }
          }
          // Only jink AWAY when the pilot is right on top of it; otherwise roam (often
          // crossing your aim) so you actually get shooting windows.
          const away = Math.atan2(core.pos.y - py, core.pos.x - px);
          const heading = bestSq < 160 * 160 ? away + (gameRng() - 0.5) * 1.6 : gameRng() * Math.PI * 2;
          core.vel.x = Math.cos(heading) * escSpeed;
          core.vel.y = Math.sin(heading) * escSpeed;
          // Aimed shot only at sensible range; eased hard on easy so the chase
          // isn't a bullet-storm while you're trying to line up the kill.
          const shootChance = d === 'easy' ? 0.4 : d === 'hard' ? 1 : 0.72;
          if (bestSq < 460 * 460 && gameRng() < shootChance) ufoShootAt(s, { pos: core.pos, type: 'boss' } as unknown as Ufo, { x: px, y: py });
        }
      }
    }

    // THE FORGE PLACES ITS OWN (Slice 3) — the whole arc has been "someone is
    // placing them"; here you watch the placer do it. Instead of generic rocks
    // the forge births foes from across the run — W4 elites, the W7/W12 iron, and
    // chondrite that splits into a swarm — the "I placed all of these" payoff +
    // sustaining targets. Capped across every placed foe (rocks + ufos); easy
    // leans on the gentler rocks. Stops once the core breaks free (the chase is
    // the bare core alone). NB: no free rig pods — a loose emitter careens off the
    // pinned shell ring like a glitch; only rocks (which bounce normally) + ufos.
    if (!s.forgeEscaped && Math.floor(s.elapsed / FORGE_ROCK_MS) > Math.floor(prev / FORGE_ROCK_MS)) {
      const placed = s.asteroids.filter(a => a.alive && a.stationPart == null && !a.isVein).length
                   + s.ufos.filter(u => u.alive).length;
      if (placed < FORGE_ROCK_CAP[d]) {
        const rx = WORLD_W / 2 + (gameRng() - 0.5) * FORGE_ROCK_SPREAD;
        const roll = gameRng();
        const eliteCut = d === 'easy' ? 0.18 : 0.32;   // fewer UFO harassers on easy
        if (roll < eliteCut) {
          // W4 — an elite UFO sweeps in from the edge.
          s.ufos.push(makeEdgeUfo('elite', gameRng() < 0.5 ? 1 : -1));
        } else {
          // W7/W12 tanky iron, or a chondrite that splits into a swarm.
          const t: AsteroidType = roll < eliteCut + 0.42 ? 'iron' : 'chondrite';
          const rock = spawnAsteroid(gameRng() < 0.5 ? 'large' : 'medium', s.wave, { x: rx, y: -40 }, { x: (gameRng() - 0.5) * 50, y: 70 + gameRng() * 50 }, t);
          s.asteroids.push(rock);
          spawnShockwave(s, rx, 20, rock.radius * 1.6, '#ffb24a');
          spawnParticles(s, rx, 20, 10, '#ffb24a', 240, 360);
        }
      }
    }
  },
  // Note: wave 25's clear is governed by the engine's wave25Clear gate
  // (s.bossDefeated, set when the core dies — see forgeCoreFinale), not this
  // isCleared. Kept as the documented intent + a fallback for non-final use.
  isCleared(s) {
    return !s.asteroids.some(a => a.alive && a.stationPart === 'core');
  },
  suppressDefaultMines: true,
  suppressDefaultUfos: true,
};
WAVE_SET_PIECES[FINAL_WAVE] = THE_FORGE;

/** Vein HP scaled by current difficulty. Easy gets a shorter engagement
 *  so the event stays fun on low-pressure runs; hard runs commit to a
 *  proper marathon with the long fight balanced by power-up drops at
 *  hit milestones. */
function veinScaledHp(): number {
  const d = currentDifficulty();
  const mul = d === 'easy' ? VEIN_HP_EASY_MUL : d === 'hard' ? VEIN_HP_HARD_MUL : 1;
  return Math.round(VEIN_HP_BASE * mul);
}

/**
 * Spawn the pallasite-vein event. Picks the candidate position furthest
 * from any mine so the player has room to engage without the gravity
 * wells biting. Sets veinSwarmDueAt so the UFO swarm arrives after a
 * brief telegraph window. Plays a chime + toast.
 */
function spawnVein(s: GameState, wave: number): void {
  const margin = 120;
  const candidates: Vec2[] = [
    { x: margin,           y: margin },
    { x: WORLD_W - margin, y: margin },
    { x: margin,           y: WORLD_H - margin },
    { x: WORLD_W - margin, y: WORLD_H - margin },
    { x: WORLD_W / 2,      y: margin },
    { x: WORLD_W / 2,      y: WORLD_H - margin },
  ];
  // Pick the candidate that's furthest from the nearest mine — gives the
  // player a clear approach. Falls back to the first candidate when there
  // are no mines.
  let best = candidates[Math.floor(gameRng() * candidates.length)];
  let bestMin = -Infinity;
  for (const c of candidates) {
    let minDist = Infinity;
    for (const m of s.mines) {
      const dx = m.pos.x - c.x;
      const dy = m.pos.y - c.y;
      const d = Math.hypot(dx, dy);
      if (d < minDist) minDist = d;
    }
    if (minDist > bestMin) { bestMin = minDist; best = c; }
  }
  const vein = spawnAsteroid('large', wave, best, { x: 0, y: 0 }, 'pallasite', { vein: true });
  s.asteroids.push(vein);
  s.veinSwarmDueAt = s.elapsed + VEIN_SWARM_DELAY_MS;
  audio.coinPickup();
  toastNow(s, 'PALLASITE VEIN · STAKE YOUR CLAIM');
}

/** Spawn a UFO from the fixed world edge. Used by the curtain (cruisers)
 *  and vein-swarm (elites) paths that need direction control beyond the
 *  random spawnUfo. */
function makeEdgeUfo(type: UfoType, dir: 1 | -1): Ufo {
  const y = WORLD_H * (0.25 + gameRng() * 0.5);
  const x = dir === 1 ? -UFO_RADIUS[type] : WORLD_W + UFO_RADIUS[type];
  return {
    pos: { x, y },
    vel: { x: dir * UFO_SPEED[type], y: 0 },
    radius: UFO_RADIUS[type],
    alive: true,
    id: nextStreamEntityId(),
    type,
    hp: UFO_HP[type],
    dir,
    zigTimer: UFO_ZIG_INTERVAL_MS,
    shootTimer: type === 'sniper' ? 1800 : 1100,
    lifetime: UFO_LIFETIME_MS,
    blink: 0,
    hitFlash: 0,
    bossPhase: 1,
  };
}

/** Backwards-compatible alias used by the curtain set-piece. */
function makeCurtainCruiser(s: GameState, dir: 1 | -1): Ufo {
  void s;
  return makeEdgeUfo('cruiser', dir);
}

/** Spawn the 600bn council as a ring of large member-textured asteroids
 *  around the world centre. Used only by beginWave when getFlavour() is
 *  '600bn' and wave === 1. Council manifest is kicked off at boot via
 *  maybePreloadCouncil; if it hasn't resolved yet we still spawn the
 *  asteroids (their textures fill in once the image arrives via the
 *  avatar-loader cache). */
// ── 600bn council cycling + run stats ───────────────────────────────
// The wave now opens as a normal asteroid run (just textured fillers)
// and council members are introduced one at a time from a shuffled
// queue. Every member appears at least once before the cycle re-shuffles.
// councilSpawned / councilDefeated drive the end-of-run stats card.
type CouncilMemberRecord = ReturnType<typeof getCouncil>[number];
let sanctumCouncilQueue: CouncilMemberRecord[] = [];
const sanctumCouncilSpawned = new Set<string>();
let sanctumCouncilDefeated = 0;
let sanctumNextCouncilSpawn = 0;
const SANCTUM_COUNCIL_INTERVAL_MS = 9_000;

/** End-of-run readout fields populated through the run. Reset in
 *  beginWave so each fresh ignite starts clean. Public so the UI
 *  module can render the stats below the 600bn recap card. */
export interface SanctumRunStats {
  startedAt: number;      // performance.now() when the wave began
  councilDefeated: number;
  councilSpawned: number;
  councilTotal: number;
  asteroidsDestroyed: number;
}
const sanctumStats: SanctumRunStats = {
  startedAt: 0, councilDefeated: 0, councilSpawned: 0, councilTotal: 0, asteroidsDestroyed: 0,
};

export function getSanctumStats(): Readonly<SanctumRunStats> {
  // Sync the live counters into the snapshot before returning.
  sanctumStats.councilDefeated = sanctumCouncilDefeated;
  sanctumStats.councilSpawned = sanctumCouncilSpawned.size;
  return sanctumStats;
}

function fisherYates<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Spawn ONE council member at a random edge, drifting inward. Drawn
 *  from the shuffled queue; once empty, re-shuffle the full roster
 *  so the cycle continues. */
function spawnNextCouncilMember(s: GameState): void {
  const roster = getCouncil();
  if (roster.length === 0) return;
  if (sanctumCouncilQueue.length === 0) {
    sanctumCouncilQueue = fisherYates(roster);
  }
  const m = sanctumCouncilQueue.pop()!;
  sanctumCouncilSpawned.add(m.name);
  // Edge spawn — pick a side and aim roughly toward the centre with
  // a random ±60° spread for variety.
  const side = Math.floor(Math.random() * 4);
  let x = 0, y = 0;
  if (side === 0) { x = Math.random() * WORLD_W; y = -40; }
  else if (side === 1) { x = WORLD_W + 40; y = Math.random() * WORLD_H; }
  else if (side === 2) { x = Math.random() * WORLD_W; y = WORLD_H + 40; }
  else { x = -40; y = Math.random() * WORLD_H; }
  const inward = Math.atan2(WORLD_H / 2 - y, WORLD_W / 2 - x);
  const ang = inward + (Math.random() - 0.5) * (Math.PI / 3);
  const speed = 55 + Math.random() * 50;
  const ast = spawnAsteroid('large', 1, { x, y }, { x: Math.cos(ang) * speed, y: Math.sin(ang) * speed }, m.asteroidType, {
    councilMember: { name: m.name, role: m.role, archetype: m.archetype, img: m.img, pubkey: m.pubkey, asteroidType: m.asteroidType },
  });
  ast.rotVel = (Math.random() < 0.5 ? -1 : 1) * (1.2 + Math.random() * 1.0);
  s.asteroids.push(ast);
}

/** Spawn N textured filler asteroids from random edges, drifting
 *  inward. Used by the 600bn infinity mode — keeps the playfield
 *  populated after the council ring has been cleared. Capped via
 *  the caller; this fn itself doesn't enforce a max. */
function spawnSanctumFillers(s: GameState, count: number): void {
  const types: AsteroidType[] = ['pallasite', 'iron', 'stony', 'chondrite'];
  for (let i = 0; i < count; i++) {
    // Random asteroid mineral — pallasite ones are the visual treat
    // (gold sparkle aura + jackpot drop), iron is the chunky armour,
    // chondrite explodes into more children, stony is baseline.
    // Letting all four come through gives the field real variety.
    const t = types[Math.floor(Math.random() * types.length)];
    // Tag the filler so other systems (HUD, music) can tell council
    // vs filler in the future. For now it just rides the standard
    // asteroid pipeline.
    s.asteroids.push(spawnAsteroid('large', 1, undefined, undefined, t));
  }
}

/** Maximum live asteroids during the 600bn infinity wave. Counts ALL
 *  sizes (large + medium + small fragments) — a single large break can
 *  spawn up to 4-7 children, so the cap needs headroom or filler/council
 *  spawns immediately stall. 24 fills the 16:9 playfield at the density
 *  the old 4:3 world held at 18; watch framerate on mid-range mobile. */
const SANCTUM_ASTEROID_CAP = 24;
/** Spawn cadence on 600bn — when the count is below the cap, a new
 *  filler drifts in every ~1.8s. */
const SANCTUM_FILLER_INTERVAL_MS = 1_800;
let sanctumNextFillerSpawn = 0;

/** Tick the 600bn infinity filler spawner. Called from updateGame
 *  while the run is in flight. Adds one asteroid every interval as
 *  long as we're under the cap; respawn instantly if the field is
 *  near empty to avoid a dead-screen moment. */
function tickSanctumFillers(s: GameState, dtMs: number): void {
  // Defender mode runs the council cycle below but SKIPS the filler
  // spawn — the council + UFOs are the arena, asteroid garnish would
  // just be distraction.
  const inDefender = s.defenderMode;
  const isSanctumLike = getFlavour() === '600bn' || isSanctumMode();
  if (!inDefender && (!isSanctumLike || s.wave !== 1)) return;
  if (s.phase !== 'playing' && s.phase !== 'wavestart') return;
  // Filler cycle (non-defender only):
  // Filler spawn (textured non-council rocks) — keeps the field
  // populated baseline while the council cycle runs alongside.
  // Skipped in defender mode (council + UFOs only).
  if (!inDefender && s.asteroids.length < SANCTUM_ASTEROID_CAP) {
    sanctumNextFillerSpawn -= dtMs;
    if (s.asteroids.length < 3 && sanctumNextFillerSpawn > 600) {
      sanctumNextFillerSpawn = 600;
    }
    if (sanctumNextFillerSpawn <= 0) {
      spawnSanctumFillers(s, 1);
      sanctumNextFillerSpawn = SANCTUM_FILLER_INTERVAL_MS;
    }
  }
  // Council cycle — independent timer. One member drifts in every
  // ~9s (defender mode: ~3s) from the shuffled queue. Skips when the
  // playfield is at the entity cap so a busy moment doesn't compound.
  // In defender mode we want the full 11-member roster on field fast,
  // so the interval is overridden to 3s.
  const councilInterval = inDefender ? 3_000 : SANCTUM_COUNCIL_INTERVAL_MS;
  if (s.asteroids.length < SANCTUM_ASTEROID_CAP) {
    sanctumNextCouncilSpawn -= dtMs;
    if (sanctumNextCouncilSpawn <= 0) {
      spawnNextCouncilMember(s);
      sanctumNextCouncilSpawn = councilInterval;
    }
  }
}

/** Invuln granted at the start of every arena round (run start and each
 *  refill) — longer than the campaign SHIP_INVULN_MS so the player can
 *  read the fresh field before the cage and rocks bear down. */
const ARENA_INVULN_MS = 5_000;

/** Kinetic asteroid: speed multiplier applied on each cage-wall bounce, and
 *  the hard speed cap that stops it running away forever. */
const KINETIC_GAIN = 1.12;
const KINETIC_MAX_SPEED = 540;
/** Lodestone asteroid: ship-pull reach (world px) and pull strength. */
const LODESTONE_RANGE = 230;
const LODESTONE_PULL = 150;
/** Respawn: invuln granted on a fresh life, the clear-zone radius the
 *  spawn point must be free of, and the cap on how long the respawn waits
 *  for that zone to clear before spawning anyway. */
const RESPAWN_INVULN_MS = 2_000;
const DEATHMATCH_INITIAL_INVULN_MS = 3_500;
const DEATHMATCH_RESPAWN_DELAY_MS = 1_100;
const DEATHMATCH_RESPAWN_INVULN_MS = 2_600;
const RESPAWN_SAFE_RADIUS = 150;
const DEATHMATCH_SAFE_SPAWN_RADIUS = 260;
const RESPAWN_MAX_WAIT_MS = 2_500;
const DEATHMATCH_RESPAWN_MAX_WAIT_MS = 2_200;
const DEATHMATCH_FEED_MAX = 6;
const DEATHMATCH_KILL_BASE = 1000;
const DEATHMATCH_STREAK_BONUS = 250;
const DEATHMATCH_STREAK_BONUS_MAX = 1500;
const DEATHMATCH_GRAVITY_RANGE_SCALE = 4.2;

/** Arena round spawn: a procedural rock field scaled by s.wave. Arena is
 *  pure rock-survival, so no set pieces, veins, mines or boss. */
function arenaSpawnWave(s: GameState): void {
  const multiplier = getGameConfig().asteroid_count_multiplier;
  const count = Math.max(1, Math.round(Math.min(13, 4 + s.wave) * multiplier));
  for (let i = 0; i < count; i++) {
    s.asteroids.push(spawnAsteroid('large', s.wave));
  }
  spawnDecorativeAsteroids(s, s.wave);
}

/** Continuous-spawn timer for the arena infinity loop. Module-level,
 *  reset at the start of each arena run. */
let arenaSpawnTimer = 0;

/** Arena continuous spawn — trickles rocks in from the cage edge to hold
 *  a target field count. Count, cadence and rock speed all ramp on the
 *  run timer, so arena reads as one continuous escalating level rather
 *  than discrete waves. */
function arenaTickSpawn(s: GameState, dtMs: number): void {
  if (!arenaActive() || s.phase !== 'playing') return;
  const t = s.runTimeMs;
  const target = Math.min(18, 7 + Math.floor(t / 22_000));
  let live = 0;
  for (const a of s.asteroids) {
    if (a.alive && (a.depth ?? 3) === 3) live++;
  }
  if (live >= target) return;
  arenaSpawnTimer -= dtMs;
  // Near-empty field: spawn fast so the cage never goes dead.
  if (live < 3 && arenaSpawnTimer > 500) arenaSpawnTimer = 500;
  if (arenaSpawnTimer <= 0) {
    // Effective wave climbs on the timer; spawnAsteroid scales rock speed
    // by it, and arena's pickAsteroidType already draws the full roster.
    const effWave = 1 + Math.floor(t / 22_000);
    s.asteroids.push(spawnAsteroid('large', effWave));
    arenaSpawnTimer = Math.max(850, 2100 - t / 200);
  }
}

function spawnDeathmatchTerrain(s: GameState): void {
  const ww = deathmatchWorldW();
  const wh = deathmatchWorldH();
  const centre = { x: ww / 2, y: wh / 2 };
  const arenaScale = Math.max(0.75, Math.min(3, Math.sqrt((ww * wh) / (4096 * 4096))));
  const tightenTerrainShape = (a: Asteroid): void => {
    a.shape = a.shape.map((v) => Math.max(0.84, Math.min(0.99, 0.84 + (v - 0.7) * 0.34)));
  };
  const lockTerrain = (a: Asteroid, radius: number): Asteroid => {
    a.radius = radius;
    a.hp = Number.POSITIVE_INFINITY;
    a.hpMax = Number.POSITIVE_INFINITY;
    a.vel.x = 0;
    a.vel.y = 0;
    a.rotVel *= 0.10;
    tightenTerrainShape(a);
    return a;
  };
  const clearOfTerrain = (x: number, y: number, radius: number): boolean => {
    for (const a of s.asteroids) {
      if (!a.alive || !a.terrain) continue;
      const min = a.radius + radius + 160;
      const dx = a.pos.x - x;
      const dy = a.pos.y - y;
      if (dx * dx + dy * dy < min * min) return false;
    }
    for (const p of s.players) {
      const min = p.ship.radius + radius + 260;
      const dx = p.ship.pos.x - x;
      const dy = p.ship.pos.y - y;
      if (dx * dx + dy * dy < min * min) return false;
    }
    return true;
  };
  const fields = [
    { x: ww * 0.24, y: wh * 0.24, r: 260, gravity: 12, type: 'ballast' as AsteroidType },
    { x: ww * 0.78, y: wh * 0.28, r: 330, gravity: 14, type: 'iron' as AsteroidType },
    { x: ww * 0.30, y: wh * 0.74, r: 350, gravity: 14, type: 'carbonaceous' as AsteroidType },
    { x: ww * 0.72, y: wh * 0.72, r: 280, gravity: 12, type: 'mesosiderite' as AsteroidType },
    { x: ww * 0.50, y: wh * 0.50, r: 220, gravity: 10, type: 'pallasite' as AsteroidType },
    { x: ww * 0.50, y: wh * 0.18, r: 205, gravity: 9, type: 'lodestone' as AsteroidType },
    { x: ww * 0.18, y: wh * 0.52, r: 190, gravity: 9, type: 'tektite' as AsteroidType },
    { x: ww * 0.84, y: wh * 0.54, r: 215, gravity: 10, type: 'chondrite' as AsteroidType },
  ];
  for (const f of fields) {
    const a = spawnAsteroid('large', 20, { x: f.x, y: f.y }, { x: 0, y: 0 }, f.type, { terrain: true, gravity: f.gravity });
    s.asteroids.push(lockTerrain(a, f.r));
  }
  const extraCover = Math.min(30, Math.max(0, Math.floor((s.players.length + 3) / 6) + Math.floor((arenaScale - 1) * 5)));
  for (let i = 0; i < extraCover; i++) {
    const angle = (i / Math.max(1, extraCover)) * Math.PI * 2 + 0.28;
    const dist = (920 + (i % 3) * 430) * arenaScale;
    const x = Math.max(240, Math.min(ww - 240, centre.x + Math.cos(angle) * dist));
    const y = Math.max(240, Math.min(wh - 240, centre.y + Math.sin(angle) * dist));
    const type = i % 4 === 0 ? 'iron' : i % 4 === 1 ? 'carbonaceous' : i % 4 === 2 ? 'mesosiderite' : 'ballast';
    const a = spawnAsteroid('large', 20, { x, y }, { x: 0, y: 0 }, type, { terrain: true, gravity: 7 + (i % 3) * 2 });
    s.asteroids.push(lockTerrain(a, 165 + (i % 4) * 34));
  }
  const driftingCount = Math.min(80, Math.max(12, 10 + Math.ceil(s.players.length * 0.85)));
  for (let i = 0; i < driftingCount; i++) {
    let x = centre.x;
    let y = centre.y;
    for (let attempt = 0; attempt < 16; attempt++) {
      const angle = gameRng() * Math.PI * 2;
      const dist = (650 + gameRng() * 1250) * arenaScale;
      x = Math.max(180, Math.min(ww - 180, centre.x + Math.cos(angle) * dist));
      y = Math.max(180, Math.min(wh - 180, centre.y + Math.sin(angle) * dist));
      if (clearOfTerrain(x, y, 70)) break;
    }
    const speed = 10 + gameRng() * 25;
    const drift = Math.atan2(y - centre.y, x - centre.x) + Math.PI / 2 + (gameRng() - 0.5) * 0.7;
    s.asteroids.push(spawnAsteroid('large', 12, { x, y }, { x: Math.cos(drift) * speed, y: Math.sin(drift) * speed }, pickAsteroidType(20)));
  }
}

function beginDeathmatch(s: GameState): void {
  s.asteroids = [];
  s.ufos = [];
  s.mines = [];
  s.powerups = [];
  s.enemyBullets = [];
  s.deathmatchStartedAt = s.elapsed;
  s.deathmatchEndedReason = null;
  s.deathmatchWinnerSlot = null;
  spawnDeathmatchTerrain(s);
  for (let i = 0; i < s.players.length; i++) {
    const spawn = deathmatchSpawnPoint(i, s.players.length);
    const p = s.players[i];
    p.ship.pos.x = spawn.x;
    p.ship.pos.y = spawn.y;
    p.ship.vel.x = 0;
    p.ship.vel.y = 0;
    p.ship.rot = spawn.rot;
    p.ship.rotVel = 0;
    p.ship.invulnerableUntil = s.elapsed + DEATHMATCH_INITIAL_INVULN_MS;
  }
  s.phase = 'playing';
  s.phaseStart = s.elapsed;
  s.nextUfoSpawn = Number.POSITIVE_INFINITY;
  audio.setHeartbeatPeriod(0.55);
  toastNow(s, 'DEATHMATCH');
}

export function beginWave(s: GameState, wave: number): void {
  s.wave = wave;
  // Milestone achievements on wave entry — fired here so the badge lands
  // during the wavestart banner rather than mid-fight.
  if (wave === FINAL_WAVE) markAchievement(s, 'first-wave-25');
  if (wave === 26) markAchievement(s, 'first-drift');
  // Wave-end bonus tracking — reset every wave so each one stands on its own.
  s.waveClearAt = null;
  s.shieldUsedThisWave = false;
  s.bulletsFiredThisWave = 0;
  s.missedShotsThisWave = 0;
  s.ufoSpawnedThisWave = false;
  s.ufoKilledThisWave = false;
  s.ufoKillsThisWave = 0;
  s.satRollsThisWave = 0;
  s.bulletCurtainKillTarget = 0;
  // A new wave starts from a clean field. clearStage() empties these on
  // the normal wave-clear path, but beginWave is also entered directly
  // (skipWarp, set-piece setup), so clear leftover hazards and powerups
  // here too rather than spawning on top of the old wave's survivors.
  // Coins are left to clearStage, which banks their sat value first.
  s.asteroids = [];
  s.ufos = [];
  s.mines = [];
  s.powerups = [];
  s.enemyBullets = [];
  // 1979 homage: each new wave re-centres the ship and grants brief invuln,
  // matching the original arcade behaviour. Skips on wave 1 (startGame already
  // placed the ship there) but harmless to repeat. Set pieces with their own
  // spawn override get those coords so the player doesn't drop straight onto
  // a hand-placed hazard.
  const p0 = s.players[0];
  if (isCoopCampaignMode() && s.players.length >= 2) {
    const spawn = WAVE_SET_PIECES[wave]?.playerSpawn;
    const baseX = spawn?.x ?? WORLD_W / 2;
    const baseY = spawn?.y ?? WORLD_H / 2;
    const spacing = 68;
    for (let i = 0; i < Math.min(2, s.players.length); i++) {
      const p = s.players[i];
      if (!p.ship.alive) continue;
      p.ship.pos.x = baseX + (i === 0 ? -spacing : spacing);
      p.ship.pos.y = baseY;
      p.ship.vel.x = 0;
      p.ship.vel.y = 0;
      p.ship.rotVel = 0;
      p.ship.rot = spawn?.rot ?? -Math.PI / 2;
      p.ship.invulnerableUntil = s.elapsed + SHIP_INVULN_MS;
    }
  } else if (p0.ship.alive) {
    const spawn = WAVE_SET_PIECES[wave]?.playerSpawn;
    p0.ship.pos.x = spawn?.x ?? WORLD_W / 2;
    p0.ship.pos.y = spawn?.y ?? WORLD_H / 2;
    p0.ship.vel.x = 0;
    p0.ship.vel.y = 0;
    p0.ship.rotVel = 0;
    p0.ship.rot = spawn?.rot ?? -Math.PI / 2;
    p0.ship.invulnerableUntil = s.elapsed + SHIP_INVULN_MS;
  }
  if (arenaActive()) {
    // Arena is one continuous infinity level: a plain procedural rock
    // field, with no set pieces, veins, mines or boss, and no wavestart
    // banner or warp. Drop straight into play with a generous invuln.
    arenaSpawnWave(s);
    arenaSpawnTimer = 0;
    p0.ship.invulnerableUntil = s.elapsed + ARENA_INVULN_MS;
    s.phase = 'playing';
    s.phaseStart = s.elapsed;
    audio.setHeartbeatPeriod(Math.max(0.35, 1.0 - wave * 0.06));
    return;
  }
  if (deathmatchActive()) {
    beginDeathmatch(s);
    return;
  }
  const setPiece = WAVE_SET_PIECES[wave];
  // 600bn flavour overrides wave 1 with the council ring — every
  // asteroid is a member-textured large that splits into smaller
  // fragments still wearing the face. No mines, no UFO timer (set
  // below). The 'pallasite' type is used so each break drops sats.
  if ((getFlavour() === '600bn' || isSanctumMode()) && wave === 1) {
    // Sanctum-mode on the main hostname needs a wave-1 bg cache flush:
    // main.ts boot pre-loads wave-1.webp before lockInMode runs, so by
    // the time this branch fires the cache already has the wrong image.
    if (isSanctumMode() && getFlavour() !== '600bn') {
      invalidateBackgroundCache(1);
      preloadBackground(1);
    }
    // 600bn / Sanctum flow: opens as a normal asteroid run (textured
    // fillers) and cycles council members in one at a time.
    sanctumCouncilQueue = [];
    sanctumCouncilSpawned.clear();
    sanctumCouncilDefeated = 0;
    sanctumNextCouncilSpawn = 5_000;
    sanctumNextFillerSpawn = SANCTUM_FILLER_INTERVAL_MS;
    sanctumStats.startedAt = performance.now();
    sanctumStats.councilDefeated = 0;
    sanctumStats.councilSpawned = 0;
    sanctumStats.councilTotal = getCouncil().length;
    sanctumStats.asteroidsDestroyed = 0;
    spawnSanctumFillers(s, 13);
    s.nextUfoSpawn = 8_000;
    s.nextMineSpawn = 10 * 60 * 1000;
  } else if (setPiece) {
    // Wave 25 is THE FORGE (WAVE_SET_PIECES[FINAL_WAVE]); its core death sets
    // s.bossDefeated, which the wave25Clear gate reads (see stationCoreFinale).
    setPiece.setup(s);
  } else {
    // Standard wave — count ramps 5 to 13 then plateaus, then scaled
    // by the admin-tunable asteroid_count_multiplier. 1.0 keeps the
    // default; lower values thin the field for casual sessions,
    // higher values cram more rocks per wave. The 5-13 curve is the
    // 16:9 rebalance of the old 4-10: the world is ~33% wider.
    const multiplier = getGameConfig().asteroid_count_multiplier;
    // Waves 10-11 are a known difficulty spike: the rock count has just
    // plateaued at its 13 cap exactly as the sniper (W10) and tank (W11) UFOs
    // debut. Thin the field by two on these two waves so the new UFO threat
    // reads as the headline rather than piling onto a maxed-out rock field.
    const spikeRelief = wave === 10 || wave === 11 ? 2 : 0;
    const count = Math.max(1, Math.round(Math.min(13, 4 + wave) * multiplier) - spikeRelief);
    for (let i = 0; i < count; i++) {
      s.asteroids.push(spawnAsteroid('large', wave));
    }
  }
  // Parallax decoration — extra rocks on non-gameplay bands. Gated by
  // the parallax setting, deterministic from gameRng so replays remain
  // bit-identical.
  spawnDecorativeAsteroids(s, wave);
  // Place static mines for this wave unless the set piece supplied its own.
  if (!setPiece?.suppressDefaultMines) placeWaveMines(s, wave);
  // Rare pallasite-vein event — roll on procedural waves only (≥6,
  // excluding set pieces + the boss arena). Drift mode (waves 26+) is
  // explicitly included so an endless run keeps getting vein rolls;
  // VEIN_SPAWN_MAX_WAVE only applies in campaign mode where the run
  // ends at 25 anyway.
  const wavePastWindow = wave > VEIN_SPAWN_MAX_WAVE && !isEndlessMode();
  if (!setPiece && wave >= VEIN_SPAWN_MIN_WAVE && !wavePastWindow
      && wave !== FINAL_WAVE) {
    const roll = gameRng();
    if (roll < VEIN_SPAWN_CHANCE) spawnVein(s, wave);
  }
  // Switch to wavestart unconditionally — the warp transition is done by the
  // time beginWave fires (1300ms after startWarp), so leaving phase='warp' just
  // suppresses the cinematic drawWaveBanner that wave 1 gets. Wave 1 from a
  // fresh start lands here too because s.phase is 'title'.
  s.phase = 'wavestart';
  s.phaseStart = s.elapsed;
  // Transition token — bumped by every wave-progression change. The
  // scheduled transitions below capture it and no-op if a newer
  // transition (a cheat-warp, a death) supersedes this one mid-flight.
  const epoch = ++s.phaseEpoch;
  // Heartbeat speeds up with wave
  audio.setHeartbeatPeriod(Math.max(0.35, 1.0 - wave * 0.06));
  // Preload the next wave's background so the warp transition is seamless
  preloadBackground(wave + 1);
  // The ship is parked and frozen for the whole wave-intro (updateGame skips
  // ship input while phase === 'wavestart'), so kill any thrust loop still
  // droning from the moment the previous wave cleared — otherwise it holds
  // through the banner with no way for the player to release it.
  audio.thrustOff();
  // Half-beat of silence first — duck the music so the wave name lands cleanly,
  // then fire the chime + reveal at WAVE_REVEAL_DELAY_MS, then unduck and resume.
  audio.setMusicDuck(0.3);
  // Act-boundary waves (1/10/17/25) replace the wave banner with a story
  // intertitle card that carries the wave name itself. Campaign flavour
  // only — the 600bn Sanctum is a one-level teaser.
  const isActWave = getFlavour() !== '600bn' && intertitleForWave(wave) !== null;
  // Wave-name chime + toast, scheduled on the sim clock.
  scheduleSimTransition(s, 'wave-reveal', s.elapsed + WAVE_REVEAL_DELAY_MS, epoch, wave);
  // Act waves hold for the whole intertitle card (campaign wave 1 is always
  // ACT I, so it keeps a long, spectator-friendly opening — the watch page
  // discovers new runs on a 5s heartbeat). 600bn wave 1 holds longest so the
  // player can read the canonical lore line. Every other wave gets the
  // standard short banner. Skip-on-input still works after
  // WAVESTART_SKIP_AFTER_MS.
  const wavestartMs = isActWave
    ? INTERTITLE_MS
    : (wave === 1 && (getFlavour() === '600bn' || isSanctumMode()) ? 9_000 : WAVESTART_MS);
  // Hand control to the player once the wavestart banner has held.
  scheduleSimTransition(s, 'wave-begin-play', s.elapsed + wavestartMs, epoch);
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
  const elapsed = s.elapsed - s.phaseStart;
  if (elapsed < WAVESTART_SKIP_AFTER_MS) return;
  audio.setMusicDuck(1);
  s.phase = 'playing';
}

function startWarp(s: GameState, targetWave?: number): void {
  const next = targetWave ?? s.wave + 1;
  // Cancel any in-progress grab grace so its countdown can't bleed past the warp.
  s.waveClearAt = null;
  s.phase = 'warp';
  s.phaseStart = s.elapsed;
  s.warpTargetWave = next;
  // Transition token — a second startWarp (e.g. a cheat-warp taken while
  // this one is still animating) bumps it, so the stale warp transition
  // is suppressed and only the latest warp lands.
  const epoch = ++s.phaseEpoch;
  audio.warpJump();
  haptic('celebrate');
  scheduleSimTransition(s, 'warp-begin-wave', s.elapsed + WARP_MS, epoch, next);
}

function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

const DEATHMATCH_SPATIAL_CELL = 512;

type PlayerCollider = SpatialCircle & { slot: number; player: PlayerState };
type DeathmatchBroadphase = {
  asteroids: SpatialHash<Asteroid>;
  ufos: SpatialHash<Ufo>;
  mines: SpatialHash<Mine>;
  enemyBullets: SpatialHash<Bullet>;
  ships: SpatialHash<PlayerCollider>;
};

const DEATHMATCH_AI_PERSONAS = [
  { rangeMul: 0.86, aggressionMul: 1.22, shieldMul: 0.88, aimMul: 0.92 },
  { rangeMul: 1.22, aggressionMul: 0.82, shieldMul: 1.10, aimMul: 1.08 },
  { rangeMul: 1.00, aggressionMul: 1.00, shieldMul: 1.00, aimMul: 1.00 },
  { rangeMul: 0.72, aggressionMul: 1.34, shieldMul: 1.24, aimMul: 0.88 },
  { rangeMul: 1.38, aggressionMul: 0.72, shieldMul: 0.96, aimMul: 1.16 },
] as const;

function deathmatchAiPersona(slot: number): typeof DEATHMATCH_AI_PERSONAS[number] {
  return DEATHMATCH_AI_PERSONAS[Math.abs(slot) % DEATHMATCH_AI_PERSONAS.length];
}

function buildShipColliders(s: GameState): PlayerCollider[] {
  const out: PlayerCollider[] = [];
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    if (!p.ship.alive || p.ship.hyperspaceCloakMs > 0) continue;
    out.push({ slot: i, player: p, pos: p.ship.pos, radius: p.ship.radius });
  }
  return out;
}

function buildDeathmatchBroadphase(s: GameState): DeathmatchBroadphase {
  const asteroids = new SpatialHash<Asteroid>(DEATHMATCH_SPATIAL_CELL);
  asteroids.rebuild(s.asteroids, a => a.alive);
  const ufos = new SpatialHash<Ufo>(DEATHMATCH_SPATIAL_CELL);
  ufos.rebuild(s.ufos, u => u.alive);
  const mines = new SpatialHash<Mine>(DEATHMATCH_SPATIAL_CELL);
  mines.rebuild(s.mines, m => m.alive);
  const enemyBullets = new SpatialHash<Bullet>(DEATHMATCH_SPATIAL_CELL);
  enemyBullets.rebuild(s.enemyBullets, b => b.alive);
  const ships = new SpatialHash<PlayerCollider>(DEATHMATCH_SPATIAL_CELL);
  ships.rebuild(buildShipColliders(s));
  return { asteroids, ufos, mines, enemyBullets, ships };
}

function incomingThreat(ship: Ship, threat: { pos: Vec2; vel: Vec2; radius: number }, horizonS: number, padding: number): boolean {
  const dx = threat.pos.x - ship.pos.x;
  const dy = threat.pos.y - ship.pos.y;
  const rvx = threat.vel.x - ship.vel.x;
  const rvy = threat.vel.y - ship.vel.y;
  const dangerRadius = ship.radius + threat.radius + padding;
  const dangerSq = dangerRadius * dangerRadius;
  const distSq = dx * dx + dy * dy;
  if (distSq <= dangerSq) return true;
  const speedSq = rvx * rvx + rvy * rvy;
  if (speedSq <= 0.001) return false;
  const closing = dx * rvx + dy * rvy;
  if (closing >= 0) return false;
  const t = -closing / speedSq;
  if (t < 0 || t > horizonS) return false;
  const cx = dx + rvx * t;
  const cy = dy + rvy * t;
  return cx * cx + cy * cy <= dangerSq;
}

function shouldDeathmatchAiUseShield(s: GameState, slot: number, skill: number, shieldMul = 1): boolean {
  const p = s.players[slot];
  if (!p || !p.ship.alive || p.ship.shieldUp || s.elapsed < p.ship.shieldReadyAt) return false;
  if (s.elapsed <= p.ship.invulnerableUntil || p.ship.hyperspaceCloakMs > 0) return false;
  const bulletHorizon = (0.10 + skill * 0.28) * shieldMul;
  const hazardHorizon = (0.12 + skill * 0.18) * shieldMul;
  const bulletPadding = (8 + skill * 18) * shieldMul;
  const hazardPadding = (10 + skill * 16) * shieldMul;
  for (const b of s.bullets) {
    if (!b.alive || b.owner === slot) continue;
    if (incomingThreat(p.ship, b, bulletHorizon, bulletPadding)) return true;
  }
  for (const b of s.enemyBullets) {
    if (!b.alive) continue;
    if (incomingThreat(p.ship, b, bulletHorizon, bulletPadding)) return true;
  }
  for (const a of s.asteroids) {
    if (!a.alive || a.terrain || (a.depth ?? 3) !== 3) continue;
    if (incomingThreat(p.ship, a, hazardHorizon, hazardPadding)) return true;
  }
  for (const m of s.mines) {
    if (!m.alive) continue;
    const dx = m.pos.x - p.ship.pos.x;
    const dy = m.pos.y - p.ship.pos.y;
    const danger = m.radius + p.ship.radius + (34 + skill * 18) * shieldMul;
    if (dx * dx + dy * dy <= danger * danger) return true;
  }
  return false;
}

function updateDeathmatchAi(s: GameState): void {
  if (!deathmatchActive()) return;
  const shipGrid = s.players.length >= 16 ? new SpatialHash<PlayerCollider>(DEATHMATCH_SPATIAL_CELL) : null;
  if (shipGrid) shipGrid.rebuild(buildShipColliders(s));
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    if (!p.ai) continue;
    p.keys.ArrowLeft = false;
    p.keys.ArrowRight = false;
    p.keys.ArrowUp = false;
    p.keys.Space = false;
    p.targetHeading = null;
    p.thrustOverride = false;
    if (!p.ship.alive || p.ship.hyperspaceCloakMs > 0) continue;
    const baseSkill = s.deathmatchRules?.aiSkill ?? 1;
    const crowdScale = Math.max(0.70, 1 - Math.max(0, s.players.length - 4) * 0.005);
    const slotVariance = 0.88 + (i % 5) * 0.06;
    const persona = deathmatchAiPersona(i);
    const skill = Math.max(0.30, Math.min(1.45, baseSkill * crowdScale * slotVariance * persona.aimMul));
    if (shouldDeathmatchAiUseShield(s, i, skill, persona.shieldMul)) tryActivateShield(s, s.elapsed, p);
    let target: PlayerState | null = null;
    let bestSq = Infinity;
    const candidates = shipGrid
      ? shipGrid.queryCircle(p.ship.pos, 1500).map(c => c.player)
      : s.players;
    const targetPool = candidates.length > 1 ? candidates : s.players;
    for (const other of targetPool) {
      if (other === p || !other.ship.alive || other.ship.hyperspaceCloakMs > 0) continue;
      const dx = other.ship.pos.x - p.ship.pos.x;
      const dy = other.ship.pos.y - p.ship.pos.y;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestSq) {
        bestSq = dSq;
        target = other;
      }
    }
    if (!target) continue;
    const dx = target.ship.pos.x - p.ship.pos.x;
    const dy = target.ship.pos.y - p.ship.pos.y;
    const preferredDistance = (260 + skill * 110) * persona.rangeMul;
    const fireRange = (420 + skill * 500) * persona.rangeMul;
    const turnDeadzone = Math.max(0.045, 0.12 - skill * 0.035);
    const fireCone = 0.16 + skill * 0.09;
    const aimError = Math.max(0, 1 - skill) * (
      Math.sin((s.frame + i * 53) * 0.034) * 0.24 +
      Math.sin((s.frame + i * 29) * 0.071) * 0.10
    );
    const aim = Math.atan2(dy, dx) + aimError;
    const delta = angleDelta(p.ship.rot, aim);
    if (delta < -turnDeadzone) p.keys.ArrowLeft = true;
    if (delta > turnDeadzone) p.keys.ArrowRight = true;
    p.keys.ArrowUp = bestSq > preferredDistance * preferredDistance || Math.abs(delta) > 0.72;
    const burstPeriod = Math.max(8, Math.round((28 - skill * 10) / persona.aggressionMul));
    const burstWindow = Math.max(2, Math.round((2 + skill * 5) * persona.aggressionMul));
    const inBurst = ((s.frame + i * 7) % burstPeriod) < burstWindow;
    p.keys.Space = inBurst && bestSq < fireRange * fireRange && Math.abs(delta) < fireCone;
  }
}

function applyDeathmatchGravity(wells: readonly Asteroid[], pos: Vec2, vel: Vec2, radius: number, dt: number): void {
  for (const well of wells) {
    const gravity = well.gravity;
    if (gravity === undefined) continue;
    const dx = well.pos.x - pos.x;
    const dy = well.pos.y - pos.y;
    const range = well.radius * DEATHMATCH_GRAVITY_RANGE_SCALE;
    const distSq = dx * dx + dy * dy;
    if (distSq <= 1 || distSq > range * range) continue;
    const dist = Math.sqrt(distSq);
    if (dist < well.radius + radius + 8) continue;
    const pull = gravity * (1 - dist / range);
    vel.x += (dx / dist) * pull * dt;
    vel.y += (dy / dist) * pull * dt;
  }
}

function pushDeathmatchFeed(s: GameState, attackerSlot: number | null, victimSlot: number, points: number, streak: number): void {
  s.deathmatchFeed.push({ t: s.elapsed, attackerSlot, victimSlot, points, streak });
  if (s.deathmatchFeed.length > DEATHMATCH_FEED_MAX) {
    s.deathmatchFeed.splice(0, s.deathmatchFeed.length - DEATHMATCH_FEED_MAX);
  }
}

function recordDeathmatchDeath(s: GameState, victim: PlayerState, attacker: PlayerState | null | undefined): void {
  if (!deathmatchActive()) return;
  const victimSlot = s.players.indexOf(victim);
  if (victimSlot < 0) return;
  victim.deathmatchDeaths += 1;
  victim.deathmatchStreak = 0;

  const attackerSlot = attacker ? s.players.indexOf(attacker) : -1;
  if (attacker && attacker !== victim && attackerSlot >= 0) {
    attacker.deathmatchKills += 1;
    attacker.deathmatchStreak += 1;
    attacker.combo = Math.min(COMBO_MAX, attacker.combo + 1);
    attacker.comboExpiresAt = s.elapsed + COMBO_WINDOW_MS;
    const streakBonus = Math.min(DEATHMATCH_STREAK_BONUS_MAX, Math.max(0, attacker.deathmatchStreak - 1) * DEATHMATCH_STREAK_BONUS);
    const points = DEATHMATCH_KILL_BASE + streakBonus;
    attacker.score += points;
    pushDeathmatchFeed(s, attackerSlot, victimSlot, points, attacker.deathmatchStreak);
    if (!attacker.ai || !victim.ai) {
      const streak = attacker.deathmatchStreak >= 3 ? ` x${attacker.deathmatchStreak}` : '';
      toastNow(s, `P${attackerSlot + 1}${streak} +${points} · P${victimSlot + 1} DOWN`);
    }
  } else {
    pushDeathmatchFeed(s, null, victimSlot, 0, 0);
    if (!victim.ai) toastNow(s, `P${victimSlot + 1} LOST`);
  }
}

function deathmatchRankRows(s: GameState): Array<{ slot: number; kills: number; score: number; deaths: number }> {
  return s.players
    .map((p, slot) => ({ slot, kills: p.deathmatchKills, score: p.score, deaths: p.deathmatchDeaths }))
    .sort((a, b) => b.kills - a.kills || b.score - a.score || a.deaths - b.deaths || a.slot - b.slot);
}

function deathmatchActiveSlots(s: GameState): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.players.length; i++) {
    const p = s.players[i];
    if (p.ship.alive || p.lives > 0) out.push(i);
  }
  return out;
}

function resolveDeathmatchWinner(s: GameState, reason: DeathmatchEndReason): number | null {
  const active = deathmatchActiveSlots(s);
  if (reason === 'last-player-standing' && active.length === 1) return active[0];
  const rows = deathmatchRankRows(s);
  if (rows.length === 0) return null;
  const first = rows[0];
  const second = rows[1];
  if (second && second.kills === first.kills && second.score === first.score && second.deaths === first.deaths) {
    return null;
  }
  return first.slot;
}

function endDeathmatch(s: GameState, reason: DeathmatchEndReason): void {
  if (!deathmatchActive() || s.phase === 'gameover' || s.phase === 'title') return;
  s.deathmatchEndedReason = reason;
  s.deathmatchWinnerSlot = resolveDeathmatchWinner(s, reason);
  s.phase = 'gameover';
  s.phaseStart = s.elapsed;
  s.pendingTransitions = s.pendingTransitions.filter(t => t.kind !== 'respawn');
  audio.ufoSirenStop();
  stopGameplayAudio();
  const label = reason === 'kill-limit'
    ? 'KILL LIMIT'
    : reason === 'time-limit'
    ? 'TIME'
    : 'LAST PILOT';
  toastNow(s, s.deathmatchWinnerSlot === null ? `${label} · DRAW` : `${label} · P${s.deathmatchWinnerSlot + 1} WINS`);
}

function checkDeathmatchEnd(s: GameState): void {
  if (!deathmatchActive() || s.phase !== 'playing' || !s.deathmatchRules) return;
  if (s.deathmatchRules.killLimit > 0) {
    for (const p of s.players) {
      if (p.deathmatchKills >= s.deathmatchRules.killLimit) {
        endDeathmatch(s, 'kill-limit');
        return;
      }
    }
  }
  if (s.deathmatchRules.timeLimitMs > 0 && s.elapsed - s.deathmatchStartedAt >= s.deathmatchRules.timeLimitMs) {
    endDeathmatch(s, 'time-limit');
    return;
  }
  if (s.players.length > 1 && deathmatchActiveSlots(s).length <= 1) {
    endDeathmatch(s, 'last-player-standing');
  }
}

function resolveDeathmatchTerrainContact(ship: Ship, terrain: Asteroid): boolean {
  let dx = ship.pos.x - terrain.pos.x;
  let dy = ship.pos.y - terrain.pos.y;
  let dist = Math.hypot(dx, dy);
  if (dist < 0.001) {
    dx = Math.cos(ship.rot);
    dy = Math.sin(ship.rot);
    dist = 1;
  }
  const minDist = ship.radius + terrain.radius + 2;
  if (dist >= minDist) return false;
  const nx = dx / dist;
  const ny = dy / dist;
  const overlap = minDist - dist;
  ship.pos.x += nx * overlap;
  ship.pos.y += ny * overlap;
  const intoTerrain = ship.vel.x * nx + ship.vel.y * ny;
  if (intoTerrain < 0) {
    ship.vel.x -= intoTerrain * nx * 1.25;
    ship.vel.y -= intoTerrain * ny * 1.25;
  }
  ship.vel.x *= 0.92;
  ship.vel.y *= 0.92;
  if (deathmatchActive()) confineToDeathmatch(ship.pos, ship.vel, ship.radius, 0.25);
  return true;
}

/** BONUS phase length + sub-phase split. 60s total: 45s HYPER BLITZ
 *  (dense asteroid storm, removed hyperspace cooldown, ship invuln)
 *  then 15s EVENT HORIZON PRELUDE (pallasite mini-bosses).
 *
 *  Density is capped: an asteroid kill spawns 2-3 medium/small children
 *  before they're shot down, so an uncapped refill loop drives the
 *  on-screen entity count to 200+ and tanks framerate. Cap is enforced
 *  in tickBonus before each refill. */
export const BONUS_TOTAL_MS = 60_000;
export const BONUS_BLITZ_MS = 45_000;
export const BONUS_BLITZ_SPAWN_INTERVAL_MS = 3000;
export const BONUS_PRELUDE_SPAWN_INTERVAL_MS = 3500;
/** Max asteroids on screen during bonus — refills skip when above. Sized
 *  so 6 large can fully shatter (6 × ~9 children = 54 entities, room for
 *  bullets/coins/particles on top) without the frame budget exploding. */
export const BONUS_ASTEROID_CAP = 14;

export function startBonus(s: GameState): void {
  s.phase = 'bonus';
  s.phaseStart = s.elapsed;
  ++s.phaseEpoch;  // supersede any pending warp / wavestart timer
  s.bonusStartedAt = s.elapsed;
  s.bonusNextSpawnAt = s.elapsed + 1500;  // first refill 1.5s in
  s.bonusPreludeSpawned = 0;
  // Re-centre ship + grant invuln for the FULL bonus duration. Hyperspace
  // cooldown wiped so the player can spam X.
  const p0 = s.players[0];
  if (p0.ship.alive) {
    p0.ship.pos.x = WORLD_W / 2;
    p0.ship.pos.y = WORLD_H / 2;
    p0.ship.vel.x = 0;
    p0.ship.vel.y = 0;
    p0.ship.invulnerableUntil = s.elapsed + BONUS_TOTAL_MS + 200;
    p0.ship.hyperspaceReadyAt = 0;
  }
  // Initial spawn — 6 large mixed-type asteroids. They shatter into
  // mediums + smalls, so 6 large = up to 54 entities in flight before
  // any refill. Previously 12 with unbounded refill = ~200+ entities,
  // which made the framerate hit a wall.
  for (let i = 0; i < 6; i++) {
    s.asteroids.push(spawnAsteroid('large', s.wave));
  }
  audio.warpJump();
  haptic('celebrate');
  toastNow(s, 'B · O · N · U · S');
  // Auto-exit after the full 60s window — startWarp lands the player
  // in wave 10 the same way a normal wave-clear would.
  scheduleSimTransition(s, 'bonus-end', s.elapsed + BONUS_TOTAL_MS);
}

/** Tick called every frame from updateGame while in bonus phase.
 *  Maintains spawn density during HYPER BLITZ + flips into the PRELUDE
 *  spawn pattern in the last 15s. Throttled by BONUS_ASTEROID_CAP so a
 *  player who isn't keeping up doesn't get drowned in entities. */
export function tickBonus(s: GameState): void {
  if (s.phase !== 'bonus') return;
  const now = s.elapsed;
  const elapsed = now - s.bonusStartedAt;
  if (now < s.bonusNextSpawnAt) return;
  // Skip refill while the screen is busy — keeps the entity count
  // sustainable for 60fps on lower-end devices.
  const alive = s.asteroids.filter((a) => a.alive).length;
  if (alive >= BONUS_ASTEROID_CAP) {
    s.bonusNextSpawnAt = now + 600;  // retry soon, don't block forever
    return;
  }
  if (elapsed < BONUS_BLITZ_MS) {
    // HYPER BLITZ — spawn ONE large asteroid per tick. It shatters
    // into 3-9 children over its lifetime, naturally keeping the
    // screen busy without the firehose effect.
    s.asteroids.push(spawnAsteroid('large', s.wave));
    s.bonusNextSpawnAt = now + BONUS_BLITZ_SPAWN_INTERVAL_MS;
  } else if (s.bonusPreludeSpawned < 5) {
    // EVENT HORIZON PRELUDE — large pallasite asteroid (no vein
    // modifier, which would otherwise trigger the jackpot cascade
    // and dump a giant particle burst per kill).
    s.asteroids.push(spawnAsteroid('large', s.wave, undefined, undefined, 'pallasite'));
    s.bonusPreludeSpawned += 1;
    s.bonusNextSpawnAt = now + BONUS_PRELUDE_SPAWN_INTERVAL_MS;
  }
}

/** Cut a long warp short on user input. No-op outside warp or before the
 *  skip window opens (so accidental taps right at warp-start don't skip). */
export function skipWarp(s: GameState): void {
  if (s.phase !== 'warp') return;
  const elapsed = s.elapsed - s.phaseStart;
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
    const p0 = s.players[0];
    if (p0.sats > 0) {
      p0.lurkSatsBlocked += p0.sats;  // accounted as forfeited for the gameover breakdown
      p0.sats = 0;
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

/** Cheat: jump straight to the bonus phase. Same gate + sat-void
 *  semantics as cheatJumpToWave. Used by the 'B' / 'B1' cheat code
 *  to test the W9 → W10 bonus mid-run without grinding to wave 9. */
export function cheatJumpToBonus(s: GameState): void {
  if (s.phase !== 'playing' && s.phase !== 'wavestart' && s.phase !== 'warp') return;
  if (!s.cheatedThisRun) {
    s.cheatedThisRun = true;
    const p0 = s.players[0];
    if (p0.sats > 0) {
      p0.lurkSatsBlocked += p0.sats;
      p0.sats = 0;
    }
    toastNow(s, '► CHEAT · SATS VOIDED');
  }
  // Park s.wave at 9 so the bonus → wave-10 transition lands on a
  // valid wave number (preload + banner expect a sane wave index).
  s.wave = 9;
  clearStage(s, { autoCollect: false });
  audio.ufoSirenStop();
  preloadBackground(10);
  toastNow(s, '► CHEAT: BONUS');
  startBonus(s);
}

// ── Power-ups ─────────────────────────────────────────────────────────────────

const POWERUP_TYPES_NOSTR: PowerUpType[] = ['rapid', 'satboost', 'nova', 'trident', 'magnet'];
const POWERUP_TYPES_GUEST: PowerUpType[] = ['rapid', 'nova', 'trident', 'magnet'];  // satboost has nothing to boost in guest mode

/** Maybe drop a power-up at the given position. Called from UFO kills. An
 *  explicit `vel` overrides the default gentle random scatter — used by the
 *  boss-vein milestone drop to fling the pickup well clear of the rock so a
 *  camper has to leave their spot to collect it. */
function maybeDropPowerUp(s: GameState, x: number, y: number, force?: PowerUpType, vel?: Vec2): void {
  let type: PowerUpType;
  if (force) {
    type = force;
  } else {
    if (gameRng() >= getGameConfig().powerup_drop_chance) return;
    const pool = s.session && !isCoopCampaignMode() ? POWERUP_TYPES_NOSTR : POWERUP_TYPES_GUEST;
    type = pool[Math.floor(gameRng() * pool.length)];
  }
  const angle = gameRng() * Math.PI * 2;
  const speed = 30 + gameRng() * 40;
  s.powerups.push({
    id: nextStreamEntityId(),
    pos: { x, y },
    vel: vel ? { x: vel.x, y: vel.y } : { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
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

function applyPowerUp(s: GameState, pu: PowerUp, now: number, p: PlayerState): void {
  const cfg = POWERUP_CONFIG[pu.type];
  if (pu.type === 'rapid') {
    p.rapidExpiresAt = Math.max(p.rapidExpiresAt, now) + cfg.durationMs;
  } else if (pu.type === 'satboost') {
    p.satboostExpiresAt = Math.max(p.satboostExpiresAt, now) + cfg.durationMs;
  } else if (pu.type === 'trident') {
    p.tridentExpiresAt = Math.max(p.tridentExpiresAt, now) + cfg.durationMs;
  } else if (pu.type === 'magnet') {
    p.magnetExpiresAt = Math.max(p.magnetExpiresAt, now) + cfg.durationMs;
  } else if (pu.type === 'nova') {
    detonateNova(s);
  } else if (pu.type === 'extralife') {
    // Lives cap mirrors the old maybeExtraLife ceiling — picking up a
    // 1UP while already at the cap forfeits the life but still pays
    // the pickup sound + toast so the action isn't silent.
    if (p.lives < 5) p.lives += 1;
    audio.extraLife();
    toastNow(s, cfg.pickupLabel);
    return;
  }
  toastNow(s, cfg.pickupLabel);
  audio.powerupPickup();
}

/**
 * NOVA: clears enemy bullets, breaks every asteroid, destroys non-boss UFOs
 * (boss takes 3 damage), wipes mines. SCORE-ONLY — wiped asteroids skip the
 * coin spawn so the player can't farm sats with a powerup. Combo still chains.
 *
 * Veins are special — nova chips VEIN_NOVA_DAMAGE off their HP rather than
 * collapsing them outright. The per-hit sat stream + power-up drops + UFO
 * swarm pressure are the whole point of the event; an instakill via nova
 * would trivialise the encounter and jump straight to the jackpot.
 */
function detonateNova(s: GameState): void {
  for (const a of [...s.asteroids]) {
    if (!a.alive) continue;
    if (a.isVein) {
      a.hp = Math.max(1, a.hp - VEIN_NOVA_DAMAGE);
      a.hitFlash = 1;
      spawnParticles(s, a.pos.x, a.pos.y, 14, '#ffd84a', 220, 540);
    } else {
      breakAsteroid(s, a, { suppressCoins: true, p: s.players[0] });
    }
  }
  for (const u of [...s.ufos]) {
    if (!u.alive) continue;
    if (u.type === 'boss') {
      damageUfo(s, u, s.players[0]);
      damageUfo(s, u, s.players[0]);
      damageUfo(s, u, s.players[0]);
    } else {
      destroyUfo(s, u, s.players[0]);
    }
  }
  for (const m of [...s.mines]) {
    if (m.alive) destroyMine(s, m, s.players[0]);
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
        if (c.kind === 'sat' && !isCoopCampaignMode()) bankedSats += Math.max(1, Math.round(c.value));
        else bankedScore += Math.max(1, Math.round(c.value));
      }
      // Sparkle puff at each coin position — tinted by kind
      const tint = c.kind === 'sat' ? '#ffd84a' : '#7fffb0';
      spawnParticles(s, c.pos.x, c.pos.y, 4, tint, 100, 350);
    }
    if (bankedSats > 0) {
      // Lurking and cheating both forfeit the wave-clear sat bank; dust score
      // is never blocked because it's not money.
      if (s.players[0].lurking || s.cheatedThisRun) {
        s.players[0].lurkSatsBlocked += bankedSats;
        toastNow(s, s.cheatedThisRun ? `CHEAT · ${bankedSats} sats forfeit` : `LURK · ${bankedSats} sats forfeit`);
      } else {
        s.players[0].sats += bankedSats;
        toastNow(s, `+ ${bankedSats} sats banked`);
      }
      audio.coinPickup();
    } else if (bankedScore > 0) {
      // Quieter notification — dust is filler reward, not a banner moment.
      audio.dustPickup();
    }
    if (bankedScore > 0) s.players[0].score += bankedScore;
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

function spawnUfo(s: GameState): void {
  s.ufoSpawnedThisWave = true;
  const type = pickUfoType(s.wave);
  const dir: 1 | -1 = gameRng() < 0.5 ? 1 : -1;
  // Spawn just off the fixed world edge so the UFO drifts in from
  // off-screen. The world is the same fixed size on every device, so the
  // spawn point never depends on the viewport.
  const y = WORLD_H * (0.15 + gameRng() * 0.7);
  const x = dir === 1 ? -UFO_RADIUS[type] : WORLD_W + UFO_RADIUS[type];
  const speed = UFO_SPEED[type];
  s.ufos.push({
    pos: { x, y },
    vel: { x: dir * speed, y: 0 },
    radius: UFO_RADIUS[type],
    alive: true,
    id: nextStreamEntityId(),
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
      if (gameRng() < dt * 0.4) u.vel.y = (gameRng() - 0.5) * 30;
      if (u.pos.y < 100 || u.pos.y > WORLD_H * 0.55) u.vel.y *= -1;
      // No traversal-edge despawn
    }

    // Sniper-only behaviour: stop moving when within range, and only briefly
    if (u.type === 'sniper') {
      const dx = s.players[0].ship.pos.x - u.pos.x;
      const dy = s.players[0].ship.pos.y - u.pos.y;
      const distSq = dx * dx + dy * dy;
      const stopRange = 360;
      if (distSq < stopRange * stopRange && s.players[0].ship.alive) {
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

    // Arena: confine UFOs to the shrinking cage too, so they bounce off the
    // walls rather than phasing through. The off-world despawn below is then
    // unreachable; the UFO lifetime timer still retires it.
    if (arenaActive()) confineToArena(u.pos, u.vel, u.radius, arenaCage(s.runTimeMs), 0.95);

    // Despawn once the UFO has fully left the fixed world on its travel
    // side. Boss never despawns this way.
    if (u.type !== 'boss') {
      if (u.dir === 1  && u.pos.x > WORLD_W + u.radius * 2) u.alive = false;
      if (u.dir === -1 && u.pos.x < -u.radius * 2) u.alive = false;
    }

    // Wrap Y so vertical drift stays on-screen
    if (u.pos.y < u.radius) u.pos.y = u.radius;
    if (u.pos.y > WORLD_H - u.radius) u.pos.y = WORLD_H - u.radius;

    // Zig-zag for non-sniper types (sniper holds steady when aiming)
    if (u.type !== 'sniper') {
      u.zigTimer -= dt * 1000;
      if (u.zigTimer <= 0) {
        u.zigTimer = UFO_ZIG_INTERVAL_MS * (0.6 + gameRng() * 0.8);
        u.vel.y = (gameRng() - 0.5) * UFO_SPEED[u.type] * 0.6;
      }
    }

    // Shoot
    u.shootTimer -= dt * 1000;
    if (u.shootTimer <= 0 && s.players[0].ship.alive) {
      // 600bn flavour — every UFO is the $600B badge and it fires 8-way
      // radial spray. Reads as a ritual broadcast pulse rather than a
      // sniper, matching the "signal carrier" theme.
      if ((getFlavour() === '600bn' || isSanctumMode()) && s.wave === 1) {
        u.shootTimer = 1800;
        ufoRadialShoot(s, u);
      } else if (u.type === 'tank') {
        u.shootTimer = UFO_SHOOT_INTERVAL[u.type];
        ufoFanShoot(s, u, s.players[0].ship.pos);
      } else if (u.type === 'boss') {
        // Per-phase boss combat scaled by difficulty. Cadence accelerates
        // and the attack mix escalates: P1 aimed, P2 alternates aimed+fan,
        // P3 throws in radial bullet curtains on top so the player has to
        // dance, not snipe.
        //
        // Easy mode keeps the phase progression but stays readable on
        // phones: no fan in P2, no radial curtain in P3, longer cadence.
        const easy = currentDifficulty() === 'easy';
        if (u.bossPhase === 1) {
          u.shootTimer = easy ? 1200 : 900;
          ufoShootAt(s, u, s.players[0].ship.pos);
        } else if (u.bossPhase === 2) {
          u.shootTimer = easy ? 900 : 700;
          if (!easy && gameRng() < 0.45) ufoFanShoot(s, u, s.players[0].ship.pos);
          else ufoShootAt(s, u, s.players[0].ship.pos);
        } else {
          u.shootTimer = easy ? 700 : 500;
          if (easy) {
            // No radial curtains on easy — aimed shots with the occasional
            // fan to keep the phase distinct from P2.
            if (gameRng() < 0.35) ufoFanShoot(s, u, s.players[0].ship.pos);
            else ufoShootAt(s, u, s.players[0].ship.pos);
          } else {
            const roll = gameRng();
            if (roll < 0.30) ufoRadialShoot(s, u);
            else if (roll < 0.65) ufoFanShoot(s, u, s.players[0].ship.pos);
            else ufoShootAt(s, u, s.players[0].ship.pos);
          }
        }
      } else {
        u.shootTimer = UFO_SHOOT_INTERVAL[u.type];
        ufoShootAt(s, u, s.players[0].ship.pos);
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
    id: nextStreamEntityId(),
    ttl: UFO_BULLET_TTL_MS,
    pierceLeft: 0,
    caromHit: false,
    wrapped: false,
    hasLanded: false,
    owner: -1,
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
      id: nextStreamEntityId(),
      ttl: UFO_BULLET_TTL_MS,
      pierceLeft: 0,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
      owner: -1,
    });
  }
  audio.ufoShoot();
}

/** Radial bullet curtain — boss phase-3 signature attack. Fires evenly
 *  around the boss with a slight random rotation per volley so the player
 *  can't memorise a single lane. Spokes dialled back to 6 (was 8) so the
 *  screen stays readable on phones during the busiest moments. */
function ufoRadialShoot(s: GameState, u: Ufo): void {
  const mods = currentMods();
  const spokes = 6;
  const baseRot = gameRng() * (Math.PI * 2);
  const speed = UFO_BULLET_SPEED * UFO_BULLET_SPEED_MUL.boss * mods.ufoBulletSpeedMul * 0.8;
  for (let i = 0; i < spokes; i++) {
    const angle = baseRot + (Math.PI * 2 * i) / spokes;
    s.enemyBullets.push({
      pos: { x: u.pos.x, y: u.pos.y },
      vel: { x: Math.cos(angle) * speed, y: Math.sin(angle) * speed },
      radius: BULLET_RADIUS + 1,
      alive: true,
      id: nextStreamEntityId(),
      ttl: UFO_BULLET_TTL_MS,
      pierceLeft: 0,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
      owner: -1,
    });
  }
  audio.ufoShoot();
}

/** A single fat pallasite shard broken off the vein's rim straight at `target`
 *  (the firing pilot's position at this instant). Aimed, no spread — the player
 *  dodges by moving. Fired reactively from the hit handler every Nth landed hit,
 *  so the more fire you pour in, the more comes back. `speed` scales with
 *  difficulty. Deterministic (no RNG). */
function veinRetaliateShard(s: GameState, a: Asteroid, target: Vec2, speed: number): void {
  const ang = Math.atan2(target.y - a.pos.y, target.x - a.pos.x);
  const c = Math.cos(ang), sn = Math.sin(ang);
  s.enemyBullets.push({
    pos: { x: a.pos.x + c * a.radius, y: a.pos.y + sn * a.radius },  // emanate from the rim
    vel: { x: c * speed, y: sn * speed },
    radius: VEIN_SHARD_RADIUS,
    alive: true,
    id: nextStreamEntityId(),
    ttl: VEIN_SHARD_TTL_MS,
    pierceLeft: 0,
    caromHit: false,
    wrapped: false,
    hasLanded: false,
    owner: -1,
    shard: true,  // rendered as a spinning rock chunk, not a fire bolt
  });
  audio.ufoShoot();
}

// ── Mines ─────────────────────────────────────────────────────────────────────

function makeMine(pos: Vec2, hp: number = MINE_HP_BASE): Mine {
  return {
    pos: { x: pos.x, y: pos.y },
    vel: { x: 0, y: 0 },     // static — never drifts
    radius: MINE_RADIUS,
    alive: true,
    id: nextStreamEntityId(),
    age: 0,
    gravityRange: MINE_GRAVITY_RANGE,
    hp,
    hitFlash: 0,
  };
}

/** One bullet's worth of damage. Flashes on a non-fatal hit; destroys
 *  on the killing blow with the existing payout/effects path. */
function damageMine(s: GameState, m: Mine, p: PlayerState): void {
  m.hp -= 1;
  m.hitFlash = 1;
  if (m.hp <= 0) {
    destroyMine(s, m, p);
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

    // Mines are static — no movement physics. Arena is the one exception:
    // the shrinking cage sweeps a mine inward so it never strands outside
    // the playable cage.
    if (arenaActive()) clampToArena(m.pos, m.radius, arenaCage(s.runTimeMs));

    // Gravity well — pulls ship in (skipped during shield/hyperspace cloak)
    if (s.players[0].ship.alive && s.players[0].ship.hyperspaceCloakMs <= 0) {
      const mods = currentMods();
      const dx = m.pos.x - s.players[0].ship.pos.x;
      const dy = m.pos.y - s.players[0].ship.pos.y;
      const distSq = dx * dx + dy * dy;
      const range = m.gravityRange;
      if (distSq < range * range && distSq > 4) {
        const dist = Math.sqrt(distSq);
        const t = 1 - dist / range;
        const accel = (m.gravityStrength ?? MINE_GRAVITY_STRENGTH) * t * mods.mineGravityMul;
        const nx = dx / dist;
        const ny = dy / dist;
        s.players[0].ship.vel.x += nx * accel * dt;
        s.players[0].ship.vel.y += ny * accel * dt;
      }
    }
  }
  s.mines = s.mines.filter(m => m.alive);
}

function destroyMine(s: GameState, m: Mine, p: PlayerState): void {
  if (!m.alive) return;
  m.alive = false;
  p.runStats.minesDestroyed += 1;
  markAchievement(s, 'first-mine');
  const mul = recordCombo(s, s.elapsed, p);
  p.score += MINE_POINTS * mul;
  audio.explosion(0.7);
  recordStreamEvent('md', m.pos.x, m.pos.y);
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
  s.phaseStart = s.elapsed;
  ++s.phaseEpoch;  // supersede any pending warp / wavestart timer
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

function damageUfo(s: GameState, u: Ufo, p: PlayerState): void {
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

  // Boss drops mines around itself at every 5 HP threshold. Count scales
  // with difficulty so easy stays survivable; normal and hard keep the
  // chunky deploys. P3 always drops more because the bullet curtain alone
  // isn't enough to keep the player honest.
  if (u.type === 'boss' && u.hp > 0 && u.hp % 5 === 0) {
    const diff = currentDifficulty();
    const mineCount = diff === 'easy'
      ? (u.bossPhase === 3 ? 2 : 1)
      : (u.bossPhase === 3 ? 5 : 3);
    for (let i = 0; i < mineCount; i++) {
      const angle = (Math.PI * 2 * i) / mineCount + gameRng() * 0.4;
      const dist = 90 + gameRng() * 40;
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
  // fire the climactic juice + drop a fresh tool for the next chapter.
  // Easy mode also grants a free life so a long fight doesn't dead-end
  // on a single mistake.
  if (u.type === 'boss' && u.hp > 0) {
    const next = bossPhaseForHp(u.hp);
    if (next !== u.bossPhase) {
      u.bossPhase = next;
      bumpTrauma(s, 0.7);
      hitStop(s, 320);
      audio.pulseDuck(0.45, 280);
      haptic('rumble');
      const colour = next === 3 ? '#fff5d8' : '#ff5050';
      spawnParticles(s, u.pos.x, u.pos.y, 40, colour, 280, 700);
      // Guaranteed tool drop a short distance off the boss so it isn't
      // immediately inside the new mine ring.
      const aid: PowerUpType = next === 3 ? 'nova' : 'trident';
      maybeDropPowerUp(s, u.pos.x + 80, u.pos.y + 20, aid);
      // Easy: free life on every phase entry.
      if (currentDifficulty() === 'easy') {
        p.lives += 1;
        toastNow(s, next === 3 ? 'CRITICAL · +1 LIFE' : 'ENRAGED · +1 LIFE');
      } else {
        toastNow(s, next === 3 ? 'EVENT HORIZON · CRITICAL' : 'EVENT HORIZON · ENRAGED');
      }
    }
  }

  if (u.hp <= 0) {
    destroyUfo(s, u, p);
  } else {
    audio.hit();
  }
}

function destroyUfo(s: GameState, u: Ufo, p: PlayerState): void {
  u.alive = false;
  s.ufoKilledThisWave = true;
  if (u.type !== 'boss') s.ufoKillsThisWave += 1;
  p.runStats.ufoKills[u.type] += 1;
  // Per-type kill achievements — first-ufo fires on any kill, plus a
  // species-specific badge for the harder targets. Boss gets its own.
  markAchievement(s, 'first-ufo');
  if (u.type === 'tank')   markAchievement(s, 'first-tank');
  if (u.type === 'elite')  markAchievement(s, 'first-elite');
  if (u.type === 'sniper') markAchievement(s, 'first-sniper');
  if (u.type === 'boss')   markAchievement(s, 'first-boss');
  const mul = recordCombo(s, s.elapsed, p);
  // Risk-proximity also pays out on UFO kills — sniping from safety is fine,
  // but landing the kill while threading the field earns a fatter score.
  const risk = computeRiskBonus(s);
  p.score += Math.round(UFO_POINTS[u.type] * mul * risk.mul);
  const explodeScale = u.type === 'tank' ? 1.3 : u.type === 'elite' ? 0.9 : 1.0;
  audio.explosion(explodeScale);
  recordStreamEvent('uk', u.pos.x, u.pos.y);
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
  maybeExtraLife(s, p);
}

// ── Bullets ───────────────────────────────────────────────────────────────────

export function fireBullet(s: GameState, p: PlayerState): void {
  if (!p.ship.alive) return;
  const mods = currentMods();
  const cos = Math.cos(p.ship.rot);
  const sin = Math.sin(p.ship.rot);
  const muzzleX = p.ship.pos.x + cos * (SHIP_RADIUS + 4);
  const muzzleY = p.ship.pos.y + sin * (SHIP_RADIUS + 4);
  const speed = BULLET_SPEED * mods.bulletSpeedMul;
  // Trident active: fan three bullets at ±TRIDENT_SPREAD around the centre
  // heading. Same speed and cooldown as a normal shot — the value is the
  // wider arc, not faster fire.
  const tridentActive = s.elapsed < p.tridentExpiresAt;
  const angles = tridentActive
    ? [-TRIDENT_SPREAD, 0, TRIDENT_SPREAD]
    : [0];
  const ownerIdx = s.players.indexOf(p);
  for (const dAng of angles) {
    const a = p.ship.rot + dAng;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    s.bullets.push({
      pos: { x: muzzleX, y: muzzleY },
      vel: { x: dx * speed + p.ship.vel.x * 0.4, y: dy * speed + p.ship.vel.y * 0.4 },
      radius: BULLET_RADIUS,
      alive: true,
      id: nextStreamEntityId(),
      ttl: BULLET_TTL_MS,
      pierceLeft: 1,
      caromHit: false,
      wrapped: false,
      hasLanded: false,
      owner: ownerIdx,
    });
    s.bulletsFiredThisWave += 1;
    p.runStats.bulletsFired += 1;
  }
  // Visual kick — every shot nudges the ship back a couple of px along its
  // own facing. Decays in a few frames; affects render only.
  p.ship.recoilOffset = Math.max(p.ship.recoilOffset, 1.8);
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

function spawnParticles(s: GameState, x: number, y: number, count: number, colour: string, speed = 100, ttl = 600, opts?: { dir?: Vec2; spread?: number }): void {
  // Scale request down when the buffer is filling up — at the cap, requests
  // are reduced to ~25% of nominal so big visual moments still register but
  // don't compound.
  const headroom = MAX_PARTICLES - s.particles.length;
  const effective = headroom <= 0
    ? 0
    : headroom < count
      ? Math.max(1, Math.floor(headroom * 0.6))
      : count;
  // Optional directional spray: aim the cone along `dir` with a half-angle of
  // `spread`/2 either side. Without `dir`, particles puff out omnidirectionally
  // (full 2π). Used for impact chips that should eject off the surface back the
  // way the shot came, rather than blooming evenly from a point.
  const baseAngle = opts?.dir ? Math.atan2(opts.dir.y, opts.dir.x) : 0;
  const spread = opts?.dir ? (opts.spread ?? Math.PI * 0.8) : Math.PI * 2;
  for (let i = 0; i < effective; i++) {
    const angle = baseAngle + (Math.random() - 0.5) * spread;
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

/** Per-pickup roll: in Nostr mode, 1-in-SAT_DROP_CHANCE_DENOM picks `sat`;
 *  the rest pick `dust`. Guest mode never picks `sat` — pickups stay
 *  non-monetary so we don't accumulate uncashable sats against an unsigned
 *  identity.
 *
 *  Asteroid-source rolls are now gated on size: only smalls can yield sats.
 *  Larges and mediums always drop dust regardless of luck, which makes the
 *  reward a follow-through gate (chase the chain to the smalls if you want
 *  the sats) and keeps whole-run accrual within the server-side anti-cheat
 *  cap. Pallasite SMALLS still always drop sats — the headline jackpot
 *  reward is preserved at the chain's end. UFO / mine drops have no size,
 *  so they continue rolling at the legacy 1-in-N rate.
 */
function rollPickupKind(s: GameState, asteroidType?: AsteroidType, size?: AsteroidSize): PickupKind {
  if (s.session === null) return 'dust';
  if (isCoopCampaignMode()) return 'dust';
  // 600bn Sanctum (hostname-driven flavour or explicit Sanctum Mode) is a
  // ceremonial / lore run. Collecting sats would imply a monetary outcome
  // the experience deliberately doesn't deliver — dust shards still spawn
  // for score and visual feedback, but no sat coins ever roll.
  if (getFlavour() === '600bn' || isSanctumMode()) return 'dust';
  // Large + medium asteroid breaks never roll for sat — gate is "drive to
  // the smalls". Mines + UFOs pass with size === undefined so they fall
  // through this guard.
  //
  // WAVE 1 EXCEPTION: relax the gate so the cold-open actually rains
  // sats. A new player's first sat lands when they break their first
  // LARGE (~5 seconds in), not after chaining all the way down to a
  // small (~20+ seconds in). The wave-1 budget caps how many sats can
  // drop, so this exception doesn't blow the per-run accrual cap.
  // From wave 2 onward the chase-the-smalls economy resumes.
  if (s.wave !== 1 && size !== undefined && size !== 'small') return 'dust';
  // Per-wave sat budget. Once the budget for this wave's rolls have
  // landed, everything else is dust. satBudgetForWave returns 5 on
  // wave 1 and 1 on every other wave — see types.ts.
  if (s.satRollsThisWave >= satBudgetForWave(s.wave)) return 'dust';
  // First eligible drop of the wave is a guaranteed sat — the player sees
  // visible sat feedback early in the level instead of waiting on the
  // denom roll, which on its own would leave most waves silent. Pallasite
  // smalls are still "always pay" (they were the headline jackpot under
  // the old model), and they also consume the wave budget so a pallasite
  // chain followed by other smalls only pays once per wave.
  if (asteroidType === 'pallasite' && size === 'small') {
    s.satRollsThisWave += 1;
    return 'sat';
  }
  if (s.satRollsThisWave === 0) {
    s.satRollsThisWave += 1;
    return 'sat';
  }
  // Belt-and-braces: subsequent rolls still go through the denom — the
  // wave-1 budget allows up to 5 drops and the denom controls whether
  // the 2nd / 3rd / 4th / 5th allowable drop in the wave actually lands.
  const denom = Math.max(1, getGameConfig().sat_drop_denom);
  if (gameRng() < (1 / denom)) {
    s.satRollsThisWave += 1;
    return 'sat';
  }
  return 'dust';
}

/** Score awarded per dust shard, scaled to the source so a small asteroid
 *  doesn't out-pay a large one. Tuned so a typical run nets a meaningful
 *  score boost without overshadowing the kill points themselves. */
const DUST_SCORE_BASE = 25;

function spawnCoins(s: GameState, x: number, y: number, value: number, count: number, kind?: PickupKind, asteroidType?: AsteroidType, size?: AsteroidSize): void {
  const resolvedKind = kind ?? rollPickupKind(s, asteroidType, size);
  // Dust shards inherit the source asteroid's score multiplier so iron and
  // pallasite drops feel meaningfully better than stony or chondrite — and
  // the renderer tints them with the source's glow colour for at-a-glance
  // recognition. Sat coins continue to split the cfg-scaled value.
  const dustMul = asteroidType ? ASTEROID_TYPE_CONFIG[asteroidType].scoreMul : 1;
  for (let i = 0; i < count; i++) {
    const angle = gameRng() * Math.PI * 2;
    const speed = 30 + gameRng() * 40;
    const perPickup = resolvedKind === 'sat' ? value / count : Math.round(DUST_SCORE_BASE * dustMul);
    s.coins.push({
      id: nextStreamEntityId(),
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
  // The world is a fixed WORLD_W x WORLD_H on every device — the camera, not
  // the sim, adapts to the viewport — so the wrap cycle is always the world
  // plus the courtesy margin (an entity flies its radius off-screen before
  // reappearing).
  const ww = worldW();
  const wh = worldH();
  if (p.x <= -margin) p.x += ww + margin * 2;
  if (p.x >= ww + margin) p.x -= ww + margin * 2;
  if (p.y <= -margin) p.y += wh + margin * 2;
  if (p.y >= wh + margin) p.y -= wh + margin * 2;
}

function circlesHit(a: { pos: Vec2; radius: number }, b: { pos: Vec2; radius: number }): boolean {
  const r = a.radius + b.radius;
  if (arenaActive() || deathmatchActive()) {
    // Arena has hard walls and no wrap, so the torus fold (which can pull two
    // entities near opposite world edges into a false hit) must not run.
    const ex = a.pos.x - b.pos.x;
    const ey = a.pos.y - b.pos.y;
    return ex * ex + ey * ey <= r * r;
  }
  // Wrap-aware shortest delta on the fixed WORLD_W x WORLD_H torus. Proper
  // modulo so positions more than one wrap apart still fold back correctly.
  const ww = worldW();
  const wh = worldH();
  let dx = (((a.pos.x - b.pos.x) % ww) + ww) % ww;
  if (dx > ww / 2) dx -= ww;
  let dy = (((a.pos.y - b.pos.y) % wh) + wh) % wh;
  if (dy > wh / 2) dy -= wh;
  return dx * dx + dy * dy <= r * r;
}

export function tryActivateShield(s: GameState, now: number, p: PlayerState): boolean {
  if (!p.ship.alive) return false;
  if (p.ship.shieldUp) return false;
  if (now < p.ship.shieldReadyAt) return false;
  const mods = currentMods();
  p.ship.shieldUp = true;
  p.ship.shieldExpiresAt = now + SHIELD_DURATION_MS;
  p.ship.shieldReadyAt = now + SHIELD_DURATION_MS + SHIELD_COOLDOWN_MS * mods.shieldCooldownMul;
  if (!p.ai) {
    audio.shieldUp();
    recordStreamEvent('sb', p.ship.pos.x, p.ship.pos.y);
    // Small punch on activation — the shield ignite reads as a meaningful
    // event, not a button click.
    bumpTrauma(s, 0.18);
    audio.pulseDuck(0.7, 180);
    haptic('tap');
    s.shieldUsedThisWave = true;
    markAchievement(s, 'first-shield');
    toastNow(s, 'SHIELD UP');
  }
  return true;
}

export function shieldStatus(s: GameState, now: number): 'up' | 'cooling' | 'ready' {
  if (s.players[0].ship.shieldUp) return 'up';
  if (now < s.players[0].ship.shieldReadyAt) return 'cooling';
  return 'ready';
}

function dropShield(s: GameState, now: number, p: PlayerState = s.players[0]): void {
  if (!p.ship.shieldUp) return;
  p.ship.shieldUp = false;
  // shieldReadyAt was already pre-set when activated; keep it.
  audio.shieldDown();
  void now;
}

/** Cancel an in-flight shield (e.g. on hyperspace). Cooldown still applies. */
export function cancelShield(s: GameState, p: PlayerState = s.players[0]): void {
  if (!p.ship.shieldUp) return;
  p.ship.shieldUp = false;
}

export function tryHyperspace(s: GameState, now: number, p: PlayerState): void {
  if (!p.ship.alive) return;
  if (p.ship.hyperspaceCloakMs > 0) return;
  if (now < p.ship.hyperspaceReadyAt) return;
  const mods = currentMods();
  cancelShield(s, p);
  p.ship.hyperspaceReadyAt = now + HYPERSPACE_COOLDOWN_MS * mods.hyperspaceCooldownMul;
  p.ship.hyperspaceCloakMs = HYPERSPACE_CLOAK_MS;
  // Capture the departure point before zeroing velocity — through-mine
  // detonation needs the ship's current position, which is still valid
  // because hyperspaceCloakMs is the only thing gating render/collision.
  const departureX = p.ship.pos.x;
  const departureY = p.ship.pos.y;
  p.ship.vel.x = 0;
  p.ship.vel.y = 0;
  p.ship.rotVel = 0;
  // Malfunction roll: standalone warps are safe. Only warps within
  // HYPERSPACE_CONSECUTIVE_WINDOW_MS of the last successful jump risk a
  // glitch. Reframes warp from "panic button with a tax" to "movement
  // primitive that punishes spam".
  const sinceLast = now - p.ship.lastHyperspaceAt;
  const isConsecutive = p.ship.lastHyperspaceAt > 0 && sinceLast < HYPERSPACE_CONSECUTIVE_WINDOW_MS;
  const malfunctionChance = isConsecutive ? HYPERSPACE_MALFUNCTION_CHANCE : 0;
  p.ship.hyperspaceMalfunction = gameRng() < malfunctionChance;
  p.ship.lastHyperspaceAt = now;
  p.runStats.hyperspacesUsed += 1;
  markAchievement(s, 'first-warp');
  // Collapse cinematic — fires at the departure point regardless of
  // malfunction (the visual sells the warp ignition either way; the
  // glitch case is tinted red so the player reads "this went wrong").
  s.hyperspaceEffects.push({
    x: departureX,
    y: departureY,
    startMs: now,
    kind: 'collapse',
    malfunction: p.ship.hyperspaceMalfunction,
  });
  if (p.ship.hyperspaceMalfunction) {
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
        destroyMine(s, m, p);
        detonated += 1;
      }
    }
    if (detonated > 0) {
      markAchievement(s, 'first-warp-detonate');
      toastNow(s, `WARP DETONATE ×${detonated}`);
    } else {
      toastNow(s, 'HYPERSPACE LOCK');
    }
  }
  audio.thrustOff();
  // Re-emerge from the cloak window, on the sim clock.
  scheduleSimTransition(s, 'hyperspace-emerge', now + HYPERSPACE_CLOAK_MS, 0, 0, s.players.indexOf(p));
}

function emergeHyperspace(s: GameState, p: PlayerState): void {
  if (!p.ship.alive) return;
  if (p.ship.hyperspaceMalfunction) {
    p.ship.hyperspaceMalfunction = false;
    audio.explosion(1.2);
    // Implosion at the original departure point — a tighter, redder burst than a
    // generic explosion, so the player reads "the warp ate me" not "I exploded"
    spawnParticles(s, p.ship.pos.x, p.ship.pos.y, 36, '#ff5050', 320, 900);
    spawnParticles(s, p.ship.pos.x, p.ship.pos.y, 18, '#ffffff', 80, 400);
    p.ship.hyperspaceCloakMs = 0;
    p.lives -= 1;
    p.runStats.livesLost += 1;
    toastNow(s, 'HYPERSPACE BREACH');
    if (p.lives <= 0) {
      // Game-over only when every player is out. With one player this is
      // exactly the original condition; with two it lets the survivor play on.
      if (s.players.every((pl) => pl.lives <= 0)) {
        s.phase = 'gameover';
        s.phaseStart = s.elapsed;
        // Hull-breached music carries the moment now — no synth gameOver chime.
        audio.stopHeartbeat();
        audio.ufoSirenStop();
        audio.stopAmbient();
      } else {
        // p is out, but others are alive — stop simulating this ship.
        p.ship.alive = false;
      }
    } else {
      // Respawn after the malfunction, scheduled on the sim clock.
      scheduleSimTransition(s, 'respawn', s.elapsed + 1200, 0, s.elapsed + 1200 + RESPAWN_MAX_WAIT_MS, s.players.indexOf(p));
      p.ship.alive = false;
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
  p.ship.pos = pos;
  p.ship.hyperspaceCloakMs = 0;
  p.ship.invulnerableUntil = s.elapsed + 800;
  // Emerge cinematic — expanding ring + arrival starburst at the new
  // position. Spawned after the position lands so the ring centres on
  // the visible ship rather than where it WAS during cloak.
  s.hyperspaceEffects.push({
    x: pos.x,
    y: pos.y,
    startMs: performance.now(),
    kind: 'emerge',
    malfunction: false,
  });
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
  s.replayBuffer.push(buildReplaySnapshot(s, s.elapsed));
  if (s.replayBuffer.length > REPLAY_BUFFER_FRAMES) s.replayBuffer.shift();
}

function buildReplaySnapshot(s: GameState, t: number): ReplaySnapshot {
  return {
    t,
    ship: { pos: { x: s.players[0].ship.pos.x, y: s.players[0].ship.pos.y }, rot: s.players[0].ship.rot, alive: s.players[0].ship.alive, thrusting: s.players[0].ship.thrusting },
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
      s.ghostSamples.push({ t: expectedT, score: s.players[0].score });
    }
    lastGhostSampleRunMs = runMs;
  }
  // Pose stream is always captured. In daily mode it powers the in-game
  // ship overlay; outside daily it powers the title-screen attract loop.
  // 35 KB / 10-min run is small enough that we don't gate this on mode.
  if (lastGhostPoseRunMs < 0 || runMs - lastGhostPoseRunMs >= GHOST_POSE_SAMPLE_MS) {
    if (s.ghostPoseSamples.length < GHOST_POSE_SAMPLE_CAP) {
      const expectedT = s.ghostPoseSamples.length * GHOST_POSE_SAMPLE_MS;
      const flags = (s.players[0].ship.alive ? 1 : 0) | (s.players[0].ship.thrusting ? 2 : 0);
      s.ghostPoseSamples.push({
        t: expectedT,
        score: s.players[0].score,
        x: s.players[0].ship.pos.x,
        y: s.players[0].ship.pos.y,
        rot: s.players[0].ship.rot,
        flags,
      });
    }
    lastGhostPoseRunMs = runMs;
  }
}

/**
 * Opaque capture of the module-global simulation state that lives OUTSIDE
 * GameState yet evolves every tick — the Sanctum/arena spawn cursors and the
 * replay/ghost sampling cursors. Rollback netcode (src/rollback.ts) must
 * snapshot and restore these alongside the GameState clone, or a re-simulated
 * frame would spawn / sample on a different schedule and desync. The RNG
 * (seed.ts getRngState/setRngState) and the entity-id counter
 * (getEntityIdCounter/setEntityIdCounter) are captured separately via their
 * own accessors.
 *
 * Mirrors the getEntityIdCounter/setEntityIdCounter pattern: one opaque blob
 * keeps the rollback module decoupled from this file's private field set.
 */
export interface SimModuleState {
  sanctumCouncilQueue: CouncilMemberRecord[];
  sanctumCouncilSpawned: string[];
  sanctumCouncilDefeated: number;
  sanctumNextCouncilSpawn: number;
  sanctumNextFillerSpawn: number;
  arenaSpawnTimer: number;
  lastReplayRecordedAt: number;
  lastGhostSampleRunMs: number;
  lastGhostPoseRunMs: number;
}

export function getSimModuleState(): SimModuleState {
  return {
    // Copy the array container (elements are read-only roster refs) so live
    // push/pop on the queue can't mutate a stored snapshot.
    sanctumCouncilQueue: sanctumCouncilQueue.slice(),
    // Serialise the Set as an array; setSimModuleState rebuilds it.
    sanctumCouncilSpawned: [...sanctumCouncilSpawned],
    sanctumCouncilDefeated,
    sanctumNextCouncilSpawn,
    sanctumNextFillerSpawn,
    arenaSpawnTimer,
    lastReplayRecordedAt,
    lastGhostSampleRunMs,
    lastGhostPoseRunMs,
  };
}

export function setSimModuleState(m: SimModuleState): void {
  // Fresh array container so subsequent restores from the same snapshot
  // (a deeper rollback) keep the stored copy pristine.
  sanctumCouncilQueue = m.sanctumCouncilQueue.slice();
  sanctumCouncilSpawned.clear();
  for (const n of m.sanctumCouncilSpawned) sanctumCouncilSpawned.add(n);
  sanctumCouncilDefeated = m.sanctumCouncilDefeated;
  sanctumNextCouncilSpawn = m.sanctumNextCouncilSpawn;
  sanctumNextFillerSpawn = m.sanctumNextFillerSpawn;
  arenaSpawnTimer = m.arenaSpawnTimer;
  lastReplayRecordedAt = m.lastReplayRecordedAt;
  lastGhostSampleRunMs = m.lastGhostSampleRunMs;
  lastGhostPoseRunMs = m.lastGhostPoseRunMs;
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
 * whatever's currently in `s.deathReplay`. The post-replay transition to the
 * gameover screen is scheduled on the sim clock.
 */
export function startDeathReplay(s: GameState): void {
  if (!s.deathReplay) return;
  s.deathReplay.startedAt = s.elapsed;
  // Re-arm the impact-frame explosion spawn — the flag is sticky from the
  // previous play, so a REPLAY KILL click would otherwise skip the explosion
  // entirely. Clear lingering particles/debris from the prior replay so the
  // prelude isn't haunted by faded remnants.
  s.deathReplay.explosionSpawned = false;
  s.particles = [];
  s.debris = [];
  s.shockwaveRings = [];
  s.phase = 'deathreplay';
  s.phaseStart = s.deathReplay.startedAt;
  audio.thrustOff();
  audio.ufoSirenStop();
  audio.setMusicDuck(0.2);
  // Post-replay transition to the gameover screen, on the sim clock.
  scheduleSimTransition(
    s,
    'deathreplay-end',
    s.elapsed + REPLAY_TOTAL_WALL_MS + REPLAY_EXPLOSION_WALL_MS,
  );
}

/** Skip the in-progress replay — fast-forward to the gameover screen. */
export function skipDeathReplay(s: GameState): void {
  if (s.phase !== 'deathreplay') return;
  audio.setMusicDuck(1);
  s.phase = 'gameover';
  s.phaseStart = s.elapsed;
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
function updateLurkState(s: GameState, now: number, p: PlayerState): void {
  if (s.phase !== 'playing' || !p.ship.alive) {
    if (p.lurking) p.lurking = false;
    p.lurkingSince = 0;
    return;
  }
  const dx = p.ship.pos.x - WORLD_W / 2;
  const dy = p.ship.pos.y - WORLD_H / 2;
  const distSq = dx * dx + dy * dy;
  const speedSq = p.ship.vel.x * p.ship.vel.x + p.ship.vel.y * p.ship.vel.y;
  const inZone = distSq < LURK_CENTRE_RADIUS_PX * LURK_CENTRE_RADIUS_PX
    && speedSq < LURK_VEL_THRESHOLD * LURK_VEL_THRESHOLD;
  if (inZone) {
    if (p.lurkingSince === 0) p.lurkingSince = now;
    const held = now - p.lurkingSince;
    if (!p.lurking && held >= LURK_DURATION_MS) {
      p.lurking = true;
      markAchievement(s, 'lurker');
    }
    // Easter-egg toast fires only after a longer commitment so it lands as
    // discovery, not a hair-trigger explainer. Suppressed if previously
    // shown this run.
    if (!p.lurkEverDetected && held >= LURK_TOAST_MS) {
      p.lurkEverDetected = true;
      toastNow(s, 'LURKING · 1979 RESPECT · NO SATS');
    }
  } else {
    p.lurking = false;
    p.lurkingSince = 0;
  }
}

function updateDisplaySats(s: GameState, dt: number): void {
  if (s.players[0].displaySats >= s.players[0].sats) { s.players[0].displaySats = s.players[0].sats; return; }
  const delta = s.players[0].sats - s.players[0].displaySats;
  // At least 1 sat/frame so high deltas don't crawl; cap to delta so we never overshoot.
  const step = Math.min(delta, Math.max(1, delta * SAT_TICK_RATE * dt));
  s.players[0].displaySats = Math.min(s.players[0].sats, s.players[0].displaySats + step);
}

/** Schedule a deferred sim transition. A fresh schedule replaces a stale
 *  transition for the same kind and same player slot. Global transitions
 *  still replace by kind only; player-bound transitions such as respawn
 *  must coexist in deathmatch so one pilot's death cannot cancel another's
 *  pending respawn. */
function scheduleSimTransition(
  s: GameState,
  kind: SimTransitionKind,
  due: number,
  epoch = 0,
  arg = 0,
  playerIdx = -1,
): void {
  const existing = s.pendingTransitions.findIndex((t) =>
    t.kind === kind && (playerIdx >= 0 ? t.playerIdx === playerIdx : t.playerIdx < 0),
  );
  if (existing >= 0) s.pendingTransitions.splice(existing, 1);
  s.pendingTransitions.push({ kind, due, epoch, arg, playerIdx });
}

/** Fire one due transition. Returns true when consumed (drop it), false
 *  when it should retry on a later step — only 'respawn' does that, while
 *  it waits for a clear spawn point. */
function runSimTransition(s: GameState, t: SimTransition): boolean {
  switch (t.kind) {
    case 'wave-reveal': {
      if (s.phaseEpoch === t.epoch && s.phase === 'wavestart') {
        audio.levelUp();
        // Act-boundary waves carry the name on the intertitle card, so the
        // toast is skipped there. Deterministic from the wave number.
        const isActWave = getFlavour() !== '600bn' && intertitleForWave(t.arg) !== null;
        if (!isActWave) toastNow(s, `WAVE ${t.arg} · ${waveName(t.arg)}`);
      }
      return true;
    }
    case 'wave-begin-play': {
      if (s.phaseEpoch === t.epoch) {
        audio.setMusicDuck(1);
        if (s.phase === 'wavestart' || s.phase === 'warp') s.phase = 'playing';
      }
      return true;
    }
    case 'warp-begin-wave': {
      if (s.phaseEpoch === t.epoch && s.phase === 'warp') beginWave(s, t.arg);
      return true;
    }
    case 'bonus-end': {
      if (s.phase === 'bonus') {
        clearStage(s, { autoCollect: true });
        s.players[0].ship.invulnerableUntil = s.elapsed + SHIP_INVULN_MS;
        startWarp(s, 10);
      }
      return true;
    }
    case 'hyperspace-emerge':
      emergeHyperspace(s, s.players[t.playerIdx]);
      return true;
    case 'respawn':
      return respawnShip(s, s.players[t.playerIdx], t.arg);
    case 'deathreplay-end': {
      if (s.phase === 'deathreplay') {
        audio.setMusicDuck(1);
        s.phase = 'gameover';
        s.phaseStart = s.elapsed;
        stopGameplayAudio();
      }
      return true;
    }
  }
}

/** Fire every deferred transition whose sim-clock deadline has arrived.
 *  Due entries are collected before any handler runs, so a handler that
 *  schedules new transitions (beginWave, startWarp) cannot have them fire
 *  this same step or disturb the iteration. */
function drainSimTransitions(s: GameState): void {
  const due: SimTransition[] = [];
  for (const t of s.pendingTransitions) {
    if (s.elapsed >= t.due) due.push(t);
  }
  for (const t of due) {
    const idx = s.pendingTransitions.indexOf(t);
    if (idx < 0) continue;  // superseded by an earlier handler's schedule
    if (runSimTransition(s, t)) s.pendingTransitions.splice(idx, 1);
  }
}

export function updateGame(s: GameState): void {
  // One fixed sim step. `dt` is the constant timestep; `now` is the sim
  // clock (s.elapsed), not wall time, so every deadline runs on a clock
  // that advances by exactly STEP each tick — the basis for a run
  // reproducing bit-identically from its seed and inputs (B3).
  // Hit-stop lives in the sim contract: when set the step decrements the
  // counter and returns, so both lockstep clients skip the same step
  // off the same `s.hitStopSteps` value rather than each side's loop
  // making the call independently.
  if (s.hitStopSteps > 0) {
    s.hitStopSteps--;
    // Module RNG / entity-id state untouched this tick — keep the
    // state mirror in sync with module so a later canary read of s.rng
    // matches what gameRng would see next call.
    s.rng = getRngState();
    s.nextEntityId = nextEntityId;
    return;
  }
  const dt = FIXED_STEP_S;
  const now = s.elapsed;
  s.frame++;

  // 600bn Sanctum is now layered into the standard wave-1 pipeline
  // (council-themed asteroids spawned by beginWave). The parallel
  // 'sanctum' phase from the previous iteration is no longer reached
  // — startGame no longer routes there. Branch left out intentionally.
  s.elapsed += dt * 1000;

  // Fire deferred sim transitions whose sim-clock deadline has arrived —
  // the deterministic replacement for wall-clock setTimeout.
  drainSimTransitions(s);

  // Arena run: the playfield is an oval cage that bounces entities off its
  // wall instead of wrapping; the cage breathes and shrinks over the run.
  // Both derive from s.runTimeMs and are read by every entity loop below;
  // campaign and drift leave `arena` false and behave exactly as before.
  const arena = arenaActive();
  const deathmatch = deathmatchActive();
  const cage = arenaCage(s.runTimeMs);
  const deathmatchGravityWells = deathmatch
    ? s.asteroids.filter(a => a.alive && a.gravity !== undefined)
    : [];

  // HUD ticker eases toward s.players[0].sats every frame regardless of phase, so the
  // counter still finishes its run-up under gameover / wavestart overlays.
  updateDisplaySats(s, dt);

  // Camera trauma decays linearly. Half-life ~0.5s at trauma=1 — long enough
  // that a death-impact shake reads as a single thwack, short enough that
  // back-to-back hits don't compound into a permanent rumble.
  if (s.cameraTrauma > 0) {
    s.cameraTrauma = Math.max(0, s.cameraTrauma - dt * 1.8);
  }
  // Screen-flash decay (~330ms fade). Runs after the hit-stop early-return, so a
  // white-out punch HOLDS through the freeze, then fades to reveal the burst.
  if (s.flash > 0) {
    s.flash = Math.max(0, s.flash - dt * 3);
  }

  // Snapshot the world state for the death replay buffer (no-op outside 'playing').
  recordReplaySnapshot(s, now);
  // 1Hz score-pacing sample for the kind 30763 ghost replay.
  recordGhostSample(s);

  // BONUS phase tick — keeps spawn density up during HYPER BLITZ and
  // flips into the EVENT HORIZON PRELUDE spawn pattern in the last 15s.
  tickBonus(s);
  // 600bn infinity-wave filler spawner — no-op on every other path.
  tickSanctumFillers(s, dt * 1000);
  // Arena infinity spawner — keeps the cage populated continuously.
  arenaTickSpawn(s, dt * 1000);
  // Defender bonus wave: the 600bn Council-protect mechanic has been
  // unbundled — DEFENDER mode is now the wide-arena + parallax bg +
  // radar visual demo while the real classic-Defender game (humanoids /
  // landers / mutants / smartbomb) is built. No win/lose timer here.

  // Detect the 1979 lurking exploit so coin credit can be withheld for it.
  updateLurkState(s, now, s.players[0]);

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
        spawnShockwave(s, dr.explosionAt.x, dr.explosionAt.y, 48, '#58ff58');
        spawnShockwave(s, dr.explosionAt.x, dr.explosionAt.y, 78, '#ffd84a');
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
          shieldHitFlash: 0,
          lastHyperspaceAt: 0,
        };
        // Death replay is a canvas snapshot playback and returns before the
        // WebGL overlay render pass, so replay debris must be 2D even when
        // live gameplay uses mesh ships.
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
      if (arena) confineToArena(d.pos, d.vel, 0, cage, 0.5);
      else if (deathmatch) confineToDeathmatch(d.pos, d.vel, 0, 0.45);
      else wrap(d.pos, 20);
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

  updateDeathmatchAi(s);

  // ── Ship input ──
  for (const p of s.players) {
    const turnLeft = p.keys['ArrowLeft'] || p.keys['KeyA'];
    const turnRight = p.keys['ArrowRight'] || p.keys['KeyD'];
    const thrust = (p.keys['ArrowUp'] || p.keys['KeyW']) || p.thrustOverride;
    const fire = p.keys['Space'];

    // Hyperspace cloak countdown
    if (p.ship.hyperspaceCloakMs > 0) {
      p.ship.hyperspaceCloakMs -= dt * 1000;
    }
    // Shield hit-flash decay — exponential so the spike reads as a pulse
    // (sharp peak, quick fade) rather than a flat ramp. Half-life ~120ms.
    if (p.ship.shieldHitFlash > 0) {
      p.ship.shieldHitFlash = Math.max(0, p.ship.shieldHitFlash * Math.exp(-dt * 5.5));
      if (p.ship.shieldHitFlash < 0.005) p.ship.shieldHitFlash = 0;
    }

    // Ship control is frozen during the wave-intro banner ('wavestart'): the
    // sim still ticks (asteroids drift, scheduled transitions fire) but the
    // player cannot rotate, thrust or fire until play actually begins, so the
    // intro never reads as a level that has already started. 'bonus' and
    // 'sanctum' keep full control — only the wave-intro is frozen.
    if (p.ship.alive && p.ship.hyperspaceCloakMs <= 0 && s.phase !== 'wavestart') {
      if (p.targetHeading !== null) {
        // Heading-mode (joystick / point-and-fly): rotate the ship smoothly
        // toward the stick angle at a fixed rate, snapping when within one
        // frame's worth. 8 rad/s is the long-standing "really nice" point-and-fly
        // feel; the gamepad-aim work briefly pushed this to 20, which made the
        // touch stick twitchy (the nose snapped ahead of the ship's momentum).
        // The genuine iOS breakage was the joystick INPUT handling — a floating
        // origin that dropped the drag off the pad edge — fixed in touch.ts, not
        // this rate.
        const HEADING_LERP_RATE = 8;  // rad/s
        let diff = p.targetHeading - p.ship.rot;
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        const step = HEADING_LERP_RATE * dt;
        if (Math.abs(diff) <= step) {
          p.ship.rot = p.targetHeading;
          p.ship.rotVel = 0;
        } else {
          p.ship.rot += Math.sign(diff) * step;
          p.ship.rotVel = Math.sign(diff) * HEADING_LERP_RATE;  // for thrust-flame visuals etc
        }
      } else {
        if (turnLeft) p.ship.rotVel -= SHIP_ROT_ACCEL * dt;
        if (turnRight) p.ship.rotVel += SHIP_ROT_ACCEL * dt;
        if (!turnLeft && !turnRight) {
          const sign = Math.sign(p.ship.rotVel);
          const newVel = p.ship.rotVel - sign * SHIP_ROT_DAMPING * dt;
          p.ship.rotVel = Math.sign(newVel) === sign ? newVel : 0;
        }
        p.ship.rotVel = Math.max(-SHIP_MAX_ROT, Math.min(SHIP_MAX_ROT, p.ship.rotVel));
        p.ship.rot += p.ship.rotVel * dt;
      }

      p.ship.thrusting = thrust;
      if (thrust) {
        p.ship.thrustFrame += dt * 30;
        p.ship.vel.x += Math.cos(p.ship.rot) * SHIP_THRUST * dt;
        p.ship.vel.y += Math.sin(p.ship.rot) * SHIP_THRUST * dt;
        audio.thrustOn();
      } else {
        audio.thrustOff();
      }
      // Deathmatch uses the same ship control contract as campaign:
      // thrust, drag, rotation, and inertia must feel identical. Terrain
      // gravity is reserved for drifting asteroids below; applying it to
      // ships made low-player deathmatch feel like a different flight model.

      // Drag
      const dragK = Math.exp(-SHIP_DRAG * dt);
      p.ship.vel.x *= dragK;
      p.ship.vel.y *= dragK;

      p.ship.pos.x += p.ship.vel.x * dt;
      p.ship.pos.y += p.ship.vel.y * dt;
      if (arena) confineToArena(p.ship.pos, p.ship.vel, p.ship.radius, cage, 0.4);
      else if (deathmatch) confineToDeathmatch(p.ship.pos, p.ship.vel, p.ship.radius, 0.35);
      else wrap(p.ship.pos);

      // Recoil decays linearly — a 1.8px kick fades in ~75ms at 24 px/s.
      if (p.ship.recoilOffset > 0) {
        p.ship.recoilOffset = Math.max(0, p.ship.recoilOffset - dt * 24);
      }

      if (fire && now >= p.fireCooldownUntil) {
        fireBullet(s, p);
        const rapid = now < p.rapidExpiresAt;
        p.fireCooldownUntil = now + (rapid ? FIRE_COOLDOWN_MS * RAPID_COOLDOWN_MUL : FIRE_COOLDOWN_MS);
      }
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
      if (!b.hasLanded) {
        s.missedShotsThisWave += 1;
        s.players[0].runStats.bulletsMissed += 1;
      }
    } else if (arena || deathmatch) {
      // No wrap in arena: a bullet that reaches the wall is spent. An
      // unlanded wall-expiry still counts as a miss, like a TTL expiry.
      if (arena ? outsideArena(b.pos, b.radius, cage) : outsideDeathmatch(b.pos, b.radius)) {
        b.alive = false;
        if (!b.hasLanded) {
          s.missedShotsThisWave += 1;
          s.players[0].runStats.bulletsMissed += 1;
        }
      }
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
  // Homing-missile steering is dumbed WAY down on easy so they're out-jukeable
  // instead of inescapable (shared by THE FORGE wave-25 boss + EAGLE STATION).
  const homingTurnScale = FORGE_MISSILE_TURN_MUL[currentDifficulty()];
  for (const b of s.enemyBullets) {
    // Homing missiles (EAGLE STATION) steer toward the nearest living pilot each
    // frame, capped turn so they're dodgeable + shoot-downable. Constant speed.
    if (b.homing) {
      let tx = 0, ty = 0, bestSq = Infinity, found = false;
      for (const pl of s.players) {
        if (!pl.ship.alive) continue;
        const ddx = pl.ship.pos.x - b.pos.x, ddy = pl.ship.pos.y - b.pos.y;
        const dSq = ddx * ddx + ddy * ddy;
        if (dSq < bestSq) { bestSq = dSq; tx = pl.ship.pos.x; ty = pl.ship.pos.y; found = true; }
      }
      if (found) {
        const speed = Math.hypot(b.vel.x, b.vel.y) || 1;
        const cur = Math.atan2(b.vel.y, b.vel.x);
        const turn = STATION_MISSILE_TURN * homingTurnScale * dt;
        const na = cur + Math.max(-turn, Math.min(turn, angleDelta(cur, Math.atan2(ty - b.pos.y, tx - b.pos.x))));
        b.vel.x = Math.cos(na) * speed;
        b.vel.y = Math.sin(na) * speed;
      }
    }
    b.pos.x += b.vel.x * dt;
    b.pos.y += b.vel.y * dt;
    b.ttl -= dt * 1000;
    const offField = arena
      ? outsideArena(b.pos, b.radius, cage)
      : deathmatch
      ? outsideDeathmatch(b.pos, b.radius)
      : (b.pos.x < -10 || b.pos.x > WORLD_W + 10 || b.pos.y < -10 || b.pos.y > WORLD_H + 10);
    if (b.ttl <= 0 || offField) {
      b.alive = false;
    }
  }
  s.enemyBullets = s.enemyBullets.filter(b => b.alive);

  // ── UFOs (boss never replaced; minions spawn alongside on boss wave) ──
  // Easy mode boss arena gets no sniper minions — the boss + its mine ring
  // is enough fight on its own. Set-piece waves with their own UFO logic
  // (curtain) also suppress the default spawn timer.
  const mods = currentMods();
  const easyBossArena = !arena && !deathmatch && s.wave === FINAL_WAVE && currentDifficulty() === 'easy';
  const setPiece = arena || deathmatch ? undefined : WAVE_SET_PIECES[s.wave];
  const suppressSpawn = easyBossArena || setPiece?.suppressDefaultUfos === true;
  const minionCount = s.ufos.filter(u => u.type !== 'boss').length;
  s.nextUfoSpawn -= dt * 1000;
  if (!suppressSpawn && s.nextUfoSpawn <= 0 && minionCount === 0) {
    spawnUfo(s);
    const cfg = getGameConfig();
    let baseInterval = Math.max(
      cfg.ufo_respawn_min_ms,
      cfg.ufo_respawn_base_ms - s.wave * cfg.ufo_respawn_per_wave_ms,
    );
    // Waves 10-11 debut the sniper + tank UFOs, but by this wave the respawn
    // timer has already bottomed out at its floor — so a fresh nasty UFO
    // arrives the instant the last one dies. Stretch the gap ~60% on these two
    // waves so each new type lands as an event, not a relentless harasser.
    if (s.wave === 10 || s.wave === 11) baseInterval *= 1.6;
    // 600bn flavour wants the $600B badge UFOs MUCH more frequent —
    // they're a marquee visual element of the cross-promo wave, not
    // a periodic harasser. ~4s respawn instead of ~17s.
    s.nextUfoSpawn = ((getFlavour() === '600bn' || isSanctumMode()) && s.wave === 1)
      ? 4_000
      : baseInterval * mods.ufoIntervalMul;
  }
  updateUfos(s, dt);
  // Set-piece per-frame tick — curtain respawns cruisers as they die.
  setPiece?.tick?.(s, dt);

  // Vein-event swarm trigger. Two elites arrive from opposite edges a
  // beat after the vein appeared, so the player has time to read the
  // event before the heat shows up. Only fires if the vein is still
  // alive — if the player one-shot it via nova/heavy fire, no swarm.
  if (s.veinSwarmDueAt > 0 && now >= s.veinSwarmDueAt) {
    s.veinSwarmDueAt = 0;
    const veinAlive = s.asteroids.some(a => a.alive && a.isVein);
    if (veinAlive) {
      s.ufos.push(makeEdgeUfo('elite', 1));
      s.ufos.push(makeEdgeUfo('elite', -1));
      audio.ufoSirenStart();
      toastNow(s, 'HEAT INBOUND');
    }
  }

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
    if (s.players[0].lurking) {
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
    if (deathmatch && !a.terrain) applyDeathmatchGravity(deathmatchGravityWells, a.pos, a.vel, a.radius, dt);
    if (a.terrain) {
      a.vel.x = 0;
      a.vel.y = 0;
    }
    a.pos.x += a.vel.x * dt;
    a.pos.y += a.vel.y * dt;
    a.rot += a.rotVel * dt;
    // Lodestone rocks tug the ship in campaign — a mobile gravity well,
    // gameplay-plane only, skipped while the ship is cloaked. Deathmatch
    // keeps ship handling campaign-pure for PvP fairness; cover gravity
    // only perturbs drifting rocks there.
    if (!deathmatch && a.type === 'lodestone' && a.alive && (a.depth ?? 3) === 3) {
      for (const p of s.players) {
        if (p.ship.alive && p.ship.hyperspaceCloakMs <= 0) {
          const dx = a.pos.x - p.ship.pos.x;
          const dy = a.pos.y - p.ship.pos.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < LODESTONE_RANGE * LODESTONE_RANGE && distSq > 16) {
            const dist = Math.sqrt(distSq);
            const pull = LODESTONE_PULL * (1 - dist / LODESTONE_RANGE);
            p.ship.vel.x += (dx / dist) * pull * dt;
            p.ship.vel.y += (dy / dist) * pull * dt;
          }
        }
      }
    }
    // 600bn council shedding — periodic tiny gold particles spit off
    // the polygon edge while the rock still has mass to shed. Per-
    // frame poisson roll, rate scales with hp-remaining ratio so a
    // full-health large pumps out sparks and a 1-HP rock barely
    // sheds. Particles get an outward radial velocity + short ttl
    // so they read as "mass flying off" rather than a static glow.
    if (a.councilMember && a.hp > 1 && a.size !== 'small') {
      const ratio = a.hp / a.hpMax;
      // ~6 particles per second at full hp on a large rock, scaled
      // down by ratio + size. Cap so a perfect run doesn't fill the
      // particle buffer.
      const sizeMul = a.size === 'large' ? 1 : 0.55;
      const expected = 6 * ratio * sizeMul * dt;
      if (Math.random() < expected) {
        const headroom = MAX_PARTICLES - s.particles.length;
        if (headroom > 0) {
          const ang = Math.random() * Math.PI * 2;
          const edgeR = a.radius * 0.92;
          const px = a.pos.x + Math.cos(ang) * edgeR;
          const py = a.pos.y + Math.sin(ang) * edgeR;
          // Outward velocity with a small tangential nudge so the
          // shed trail curls naturally with the rock's motion.
          const outSpeed = 40 + Math.random() * 40;
          s.particles.push({
            pos: { x: px, y: py },
            vel: {
              x: Math.cos(ang) * outSpeed + a.vel.x * 0.2,
              y: Math.sin(ang) * outSpeed + a.vel.y * 0.2,
            },
            ttl: 350,
            maxTtl: 350,
            colour: '#ffd84a',
            size: 1.4 + Math.random() * 1.0,
          });
        }
      }
    }
    if (a.hitFlash > 0) a.hitFlash = Math.max(0, a.hitFlash - dt * 4);
    // Exact-edge wrap (no courtesy margin): render ghosts the seam, so the
    // teleport must land exactly WORLD_W over or the ghost hand-off jumps.
    // Arena instead bounces the rock off the cage wall, fully elastic so the
    // field stays lively as the cage shrinks.
    if (arena) {
      const bounced = confineToArena(a.pos, a.vel, a.radius, cage, 1);
      // Kinetic rocks feed on wall impacts: each bounce ratchets the speed
      // up a notch, up to a hard cap so they cannot run away forever.
      if (bounced && a.type === 'kinetic') {
        const sp = Math.hypot(a.vel.x, a.vel.y);
        if (sp > 1 && sp < KINETIC_MAX_SPEED) {
          a.vel.x *= KINETIC_GAIN;
          a.vel.y *= KINETIC_GAIN;
        }
      }
    } else if (deathmatch) {
      confineToDeathmatch(a.pos, a.vel, a.radius, 0.92);
    } else wrap(a.pos);
  }

  // Asteroid-asteroid elastic bounce on the gameplay plane. Decorative
  // depth bands pass through everything. O(N²) is cheap at the typical
  // ~10-30 active rocks; only kicks in when same-depth circles overlap.
  // Gated: off restores classic 1979 pass-through (easy mode / override).
  if (asteroidBounceEnabled()) runAsteroidCollisions(s);

  // ── Shield expiry ──
  for (const p of s.players) {
    if (p.ship.shieldUp && now >= p.ship.shieldExpiresAt) {
      dropShield(s, now, p);
    }
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
    if (arena) confineToArena(d.pos, d.vel, 0, cage, 0.5);
    else if (deathmatch) confineToDeathmatch(d.pos, d.vel, 0, 0.45);
    else wrap(d.pos, 20);
  }
  s.debris = s.debris.filter(d => d.ttl > 0);

  // ── Coins ──
  for (const c of s.coins) {
    c.pos.x += c.vel.x * dt;
    c.pos.y += c.vel.y * dt;
    c.ttl -= dt * 1000;
    c.vel.x *= Math.exp(-0.8 * dt);
    c.vel.y *= Math.exp(-0.8 * dt);
    if (c.ttl <= 0) c.alive = false;
    if (arena) confineToArena(c.pos, c.vel, c.radius, cage, 0.55);
    else if (deathmatch) confineToDeathmatch(c.pos, c.vel, c.radius, 0.5);
    else wrap(c.pos);

    // Pull toward ship — short-range natural magnetism always, plus a strong
    // whole-screen pull while the MAGNET powerup is active.
    for (const p of s.players) {
      if (p.ship.alive) {
        const magnetActive = now < p.magnetExpiresAt;
        const dx = p.ship.pos.x - c.pos.x;
        const dy = p.ship.pos.y - c.pos.y;
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
  }
  s.coins = s.coins.filter(c => c.alive && !c.collected);

  const deathmatchBroadphase = deathmatch ? buildDeathmatchBroadphase(s) : null;

  // ── Collisions: bullets × asteroids ──
  for (const b of s.bullets) {
    if (!b.alive) continue;
    const asteroids = deathmatchBroadphase ? deathmatchBroadphase.asteroids.queryCircle(b.pos, b.radius) : s.asteroids;
    for (const a of asteroids) {
      if (!a.alive) continue;
      if ((a.depth ?? 3) !== 3) continue;
      if (circlesHit(b, a)) {
        // Carom: a bullet that has already broken one asteroid earns the
        // bonus on its next break. Wrap: a bullet that has crossed a playfield
        // edge before its kill earns the wrap bonus. Stack independently — a
        // wrapped carom is a 4× kill.
        const isCarom = b.caromHit;
        const isWrap = b.wrapped;
        b.hasLanded = true;
        damageAsteroid(s, a, { isCarom, isWrap, bulletVel: b.vel, bulletPos: b.pos, p: s.players[b.owner] });
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
    const ufos = deathmatchBroadphase ? deathmatchBroadphase.ufos.queryCircle(b.pos, b.radius) : s.ufos;
    for (const u of ufos) {
      if (!u.alive) continue;
      if (circlesHit(b, u)) {
        b.alive = false;
        b.hasLanded = true;
        damageUfo(s, u, s.players[b.owner]);
        break;
      }
    }
  }

  // ── Collisions: bullets × homing missiles (shoot them down) ──
  for (const b of s.bullets) {
    if (!b.alive) continue;
    for (const m of s.enemyBullets) {
      if (!m.alive || !m.homing) continue;
      if (circlesHit(b, m)) {
        m.alive = false;
        b.alive = false;
        b.hasLanded = true;
        s.players[b.owner].score += 60;
        spawnParticles(s, m.pos.x, m.pos.y, 12, '#ff7a4a', 240, 360);
        spawnParticles(s, m.pos.x, m.pos.y, 5, '#ffe6b0', 300, 260);
        audio.hit();
        break;
      }
    }
  }

  // ── Collisions: bullets × mines ──
  for (const b of s.bullets) {
    if (!b.alive) continue;
    const mines = deathmatchBroadphase ? deathmatchBroadphase.mines.queryCircle(b.pos, b.radius) : s.mines;
    for (const m of mines) {
      if (!m.alive) continue;
      if (circlesHit(b, m)) {
        b.alive = false;
        b.hasLanded = true;
        damageMine(s, m, s.players[b.owner]);
        break;
      }
    }
  }

  // ── Deathmatch: player bullets × ships ──
  if (deathmatch) {
    for (const b of s.bullets) {
      if (!b.alive) continue;
      const ships = deathmatchBroadphase ? deathmatchBroadphase.ships.queryCircle(b.pos, b.radius) : [];
      for (const ship of ships) {
        if (ship.slot === b.owner) continue;
        const target = ship.player;
        if (!target.ship.alive || target.ship.hyperspaceCloakMs > 0 || now <= target.ship.invulnerableUntil) continue;
        if (circlesHit(b, target.ship)) {
          b.alive = false;
          b.hasLanded = true;
          if (target.ship.shieldUp) {
            spawnParticles(s, b.pos.x, b.pos.y, 8, '#5b9dff', 180, 320);
            audio.shieldHit();
            target.ship.shieldHitFlash = 1;
            break;
          }
          const attacker = s.players[b.owner];
          killShip(s, target, attacker);
          break;
        }
      }
    }
  }

  // ── Shield contact with mines ──
  // Shield protects the ship from death but no longer destroys the mine —
  // matches how shield handles asteroids (pure deflect, no damage). Mines
  // are cleared by bullets only. Visual sparks + audio still fire so the
  // contact reads on screen.
  for (const p of s.players) {
    if (p.ship.alive && p.ship.shieldUp) {
      const mines = deathmatchBroadphase ? deathmatchBroadphase.mines.queryCircle(p.ship.pos, p.ship.radius) : s.mines;
      for (const m of mines) {
        if (!m.alive) continue;
        if (circlesHit(p.ship, m)) {
          spawnParticles(s, m.pos.x, m.pos.y, 8, '#5b9dff', 180, 320);
          audio.shieldHit();
          p.ship.shieldHitFlash = 1;
        }
      }
    }

    // ── Shield deflection (runs before damage check) ──
    if (p.ship.alive && p.ship.shieldUp) {
      const asteroids = deathmatchBroadphase ? deathmatchBroadphase.asteroids.queryCircle(p.ship.pos, p.ship.radius) : s.asteroids;
      for (const a of asteroids) {
        if (!a.alive || (a.depth ?? 3) !== 3) continue;
        if (circlesHit(p.ship, a)) {
          if (a.terrain) {
            if (resolveDeathmatchTerrainContact(p.ship, a)) p.ship.shieldHitFlash = 1;
            continue;
          }
          // Use wrap-aware delta so reflections at the edges push the asteroid
          // along the actual contact normal, not a normal flipped by the wrap.
          // Arena has no wrap, so a plain delta is already the real normal.
          let dx: number, dy: number;
          if (arena || deathmatch) {
            dx = a.pos.x - p.ship.pos.x;
            dy = a.pos.y - p.ship.pos.y;
          } else {
            dx = (((a.pos.x - p.ship.pos.x) % WORLD_W) + WORLD_W) % WORLD_W;
            if (dx > WORLD_W / 2) dx -= WORLD_W;
            dy = (((a.pos.y - p.ship.pos.y) % WORLD_H) + WORLD_H) % WORLD_H;
            if (dy > WORLD_H / 2) dy -= WORLD_H;
          }
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
            const overlap = p.ship.radius + a.radius + 4 - dist;
            if (overlap > 0) {
              a.pos.x += nx * overlap;
              a.pos.y += ny * overlap;
            }
            spawnParticles(s, (p.ship.pos.x + a.pos.x) / 2, (p.ship.pos.y + a.pos.y) / 2, 10, '#5b9dff', 220, 380);
            audio.shieldHit();
            p.ship.shieldHitFlash = 1;
          }
        }
      }
      const enemyBullets = deathmatchBroadphase ? deathmatchBroadphase.enemyBullets.queryCircle(p.ship.pos, p.ship.radius) : s.enemyBullets;
      for (const b of enemyBullets) {
        if (!b.alive) continue;
        if (circlesHit(p.ship, b)) {
          b.alive = false;
          spawnParticles(s, b.pos.x, b.pos.y, 8, '#5b9dff', 180, 320);
          audio.shieldHit();
          p.ship.shieldHitFlash = 1;
        }
      }
    }
  }

  // ── Collisions: ship × asteroids / UFOs / enemy bullets ──
  for (const p of s.players) {
    if (p.ship.alive && !p.ship.shieldUp && p.ship.hyperspaceCloakMs <= 0 && now > p.ship.invulnerableUntil) {
      const asteroids = deathmatchBroadphase ? deathmatchBroadphase.asteroids.queryCircle(p.ship.pos, p.ship.radius) : s.asteroids;
      for (const a of asteroids) {
        if (!a.alive || (a.depth ?? 3) !== 3) continue;
        if (circlesHit(p.ship, a)) {
          // Terrain (deathmatch cover AND the EAGLE STATION arms) is SOLID, not
          // lethal — you bounce off it, you don't die on it. Previously this
          // cover-bounce was deathmatch-only, so the campaign station arms
          // instakilled on touch.
          if (a.terrain) {
            resolveDeathmatchTerrainContact(p.ship, a);
            continue;
          }
          killShip(s, p);
          break;
        }
      }
      const ufos = deathmatchBroadphase ? deathmatchBroadphase.ufos.queryCircle(p.ship.pos, p.ship.radius) : s.ufos;
      for (const u of ufos) {
        if (p.ship.alive && u.alive && circlesHit(p.ship, u)) {
          destroyUfo(s, u, p);  // ramming kills the UFO too
          killShip(s, p);
          break;
        }
      }
      const enemyBullets = deathmatchBroadphase ? deathmatchBroadphase.enemyBullets.queryCircle(p.ship.pos, p.ship.radius) : s.enemyBullets;
      for (const b of enemyBullets) {
        if (p.ship.alive && b.alive && circlesHit(p.ship, b)) {
          if (p.lurking) {
            // Lurk-mode UFO immunity: the 1979 saucer-aim bug had a centre blind
            // spot. Bullet passes through with a small puff so the player sees
            // the bullet "missed" rather than the collision being silently
            // swallowed. Bullet still consumed so it doesn't hit twice.
            b.alive = false;
            spawnParticles(s, b.pos.x, b.pos.y, 4, '#5b9dff', 80, 200);
            continue;
          }
          b.alive = false;
          killShip(s, p);
          break;
        }
      }
      const mines = deathmatchBroadphase ? deathmatchBroadphase.mines.queryCircle(p.ship.pos, p.ship.radius) : s.mines;
      for (const m of mines) {
        if (p.ship.alive && m.alive && circlesHit(p.ship, m)) {
          destroyMine(s, m, p);
          killShip(s, p);
          break;
        }
      }
    }
  }

  // ── Collisions: ship × coins (sat coins or dust shards) ──
  for (const p of s.players) {
    if (p.ship.alive) {
      const satMul = now < p.satboostExpiresAt ? SATBOOST_MUL : 1;
      for (const c of s.coins) {
        if (!c.alive || c.collected) continue;
        if (circlesHit(p.ship, c)) {
          c.collected = true;
          if (c.kind === 'sat' && !isCoopCampaignMode()) {
            const credit = Math.max(1, Math.round(c.value * satMul));
            // Lurking and cheating both forfeit sat credit. Score still ticks
            // via dust, but sats won't accumulate once the run is tainted.
            if (p.lurking || s.cheatedThisRun) p.lurkSatsBlocked += credit;
            else p.sats += credit;
            audio.coinPickup();
            spawnParticles(s, c.pos.x, c.pos.y, 6, '#ffd84a', 80, 350);
          } else {
            // Dust shard — pure score, never blocked by lurking (it's not sats).
            p.score += Math.max(1, Math.round(c.value));
            audio.dustPickup();
            spawnParticles(s, c.pos.x, c.pos.y, 5, '#7fffb0', 70, 300);
          }
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
      if (arena) confineToArena(p.pos, p.vel, p.radius, cage, 0.55);
      else if (deathmatch) confineToDeathmatch(p.pos, p.vel, p.radius, 0.5);
      else wrap(p.pos);
      for (const pl of s.players) {
        if (pl.ship.alive && circlesHit(pl.ship, p)) {
          p.collected = true;
          pl.runStats.powerupsCollected += 1;
          applyPowerUp(s, p, now, pl);
          spawnParticles(s, p.pos.x, p.pos.y, 14, '#ffffff', 200, 600);
        }
      }
    }
    s.powerups = s.powerups.filter(p => p.alive && !p.collected);
  }

  // Sweep dead asteroids
  s.asteroids = s.asteroids.filter(a => a.alive);

  checkDeathmatchEnd(s);

  // Wave clear — two-stage: a grab-everything grace window (when there are
  // loose coins / power-ups and the run isn't cheated), then the warp /
  // bonus / completion transition.
  if (s.phase === 'playing' && !deathmatch) {
    // Decoratives (parallax depth 1-2, 4-5) are visual dressing only —
    // they shouldn't block a clear. Without this filter the wave is
    // gated on the player tracking down tiny background dust rocks that
    // can't even hit them.
    const collideAsteroids = s.asteroids.filter(a => a.alive && (a.depth ?? 3) === 3);
    const asteroidsClear = collideAsteroids.every(a => a.terrain);
    const setPiece = arena || deathmatch ? undefined : WAVE_SET_PIECES[s.wave];
    // Set-piece waves can override the clear condition (e.g. bullet curtain
    // clears on UFO kill count, not on empty asteroid array). Falls back to
    // the standard asteroidsClear check.
    const cleared = setPiece?.isCleared ? setPiece.isCleared(s) : asteroidsClear;
    const ufosClear = s.ufos.length === 0;
    const wave25Clear = s.bossDefeated && asteroidsClear && ufosClear;
    const isFinalWave = s.wave === FINAL_WAVE;
    const conditionClear = (isFinalWave && !arena) ? wave25Clear : cleared;

    // 600bn flavour wave 1 is an infinity wave — a clear just respawns
    // fillers and keeps going; the Sanctum is a continuous engagement.
    const sanctumInfinity = (getFlavour() === '600bn' || isSanctumMode()) && s.wave === 1;

    // Stage 1 — first frame of clear: award bonuses, then either open the
    // grab-everything grace window or transition straight away.
    if (conditionClear && s.waveClearAt === null && !arena) {
      awardWaveClearBonuses(s);
      bumpTrauma(s, isFinalWave ? 0.40 : 0.30);
      hitStop(s, isFinalWave ? 220 : 180);
      audio.ufoSirenStop();
      if (sanctumInfinity) {
        // Infinity wave — sweep, refill, keep going; no grace, no transition.
        clearStage(s, { autoCollect: true });
        spawnSanctumFillers(s, 5);
      } else {
        spawnWaveClearStreak(s);
        // Set-piece clear achievements land on the wave-clear beat.
        if (s.wave === 5)  markAchievement(s, 'first-heist');
        if (s.wave === 12) markAchievement(s, 'first-curtain');
        // Grace window — a few seconds to fly in and scoop loose coins /
        // power-ups before the warp. Skipped (backdated so Stage 2 fires
        // this frame) when there's nothing to grab, or the run is cheated
        // and sats are voided — either way the dash would be pointless.
        const hasGoodies = s.coins.some(c => c.alive)
          || s.powerups.some(p => p.alive && !p.collected);
        // EAGLE STATION (17) and THE FORGE (25) always hold the grace beat even
        // with nothing to scoop / on a cheated run, so the rig's big detonation
        // actually plays out instead of cutting straight to the warp / completion.
        const bossHold = s.wave === 17 || s.wave === FINAL_WAVE;
        if ((hasGoodies && !s.cheatedThisRun) || bossHold) {
          s.waveClearAt = now;
          for (const p of s.players) {
            p.ship.invulnerableUntil = Math.max(
              p.ship.invulnerableUntil, now + WAVE_CLEAR_GRACE_MS + 200,
            );
          }
        } else {
          s.waveClearAt = now - WAVE_CLEAR_GRACE_MS;
        }
      }
    }

    // Stage 2 — grace expired (or skipped) → sweep + transition.
    if (s.waveClearAt !== null && now >= s.waveClearAt + WAVE_CLEAR_GRACE_MS) {
      s.waveClearAt = null;
      clearStage(s, { autoCollect: true });
      audio.ufoSirenStop();
      if (isFinalWave) {
        if (isEndlessMode()) {
          toastNow(s, currentMode() === 'arena'
            ? 'ARENA · NO RETREAT'
            : 'DRIFT · BEYOND THE HORIZON');
          startWarp(s);
        } else {
          triggerCompletion(s);
        }
      } else if (s.wave === 9 && gameRng() < getGameConfig().bonus_wave_chance) {
        // BONUS round divert — W9 → W10 hyper blitz + event-horizon
        // prelude. Gated on bonus_wave_chance from /api/game-config;
        // uses gameRng so daily-seed runs stay deterministic.
        startBonus(s);
      } else {
        startWarp(s);
      }
    }
  }

  // Combo decay
  for (const p of s.players) {
    if (p.combo > 0 && now > p.comboExpiresAt) {
      p.combo = 0;
    }
  }

  // Toast expiry
  if (s.toast && now > s.toastUntil) {
    s.toast = null;
  }
  // Bridge save: capture the post-tick module RNG + entity-id values
  // back onto state so the next tick (or another sim's next tick) sees
  // an honest baseline. See the matching load at the top of updateGame.
  s.rng = getRngState();
  s.nextEntityId = nextEntityId;
}

/**
 * Advance the kill chain. Returns the multiplier to apply to this kill's score.
 * First kill of a fresh chain returns 1; subsequent kills within COMBO_WINDOW_MS
 * return 2, 3, 4, 5 (capped). Plays a rising tick at each step.
 */
function recordCombo(s: GameState, now: number, p: PlayerState): number {
  const prev = p.combo;
  if (now < p.comboExpiresAt && p.combo > 0) {
    p.combo = Math.min(COMBO_MAX, p.combo + 1);
  } else {
    p.combo = 1;
  }
  p.comboExpiresAt = now + COMBO_WINDOW_MS;
  if (p.combo > p.runStats.largestCombo) p.runStats.largestCombo = p.combo;
  if (p.combo >= 2) audio.comboTick(p.combo);
  // Crescendo on first reaching the cap in this chain: short hit-stop and
  // a trauma bump so the moment lands. Only fires once per chain because
  // subsequent kills find prev already at COMBO_MAX.
  if (p.combo === COMBO_MAX && prev < COMBO_MAX) {
    hitStop(s, 80);
    bumpTrauma(s, 0.18);
    markAchievement(s, 'first-max-combo');
  }
  return p.combo;
}

function resetCombo(_s: GameState, p: PlayerState): void {
  p.combo = 0;
  p.comboExpiresAt = 0;
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
    markAchievement(s, 'first-no-shield');
  }
  if (s.bulletsFiredThisWave >= 8 && s.missedShotsThisWave === 0) {
    tags.push('NO MISS +2000');
    total += 2000;
    markAchievement(s, 'first-no-miss');
  }
  if (s.ufoSpawnedThisWave && !s.ufoKilledThisWave) {
    tags.push('PACIFIST +1000');
    total += 1000;
    markAchievement(s, 'first-pacifist');
  }
  if (total > 0) {
    s.players[0].score += total;
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
  if (!s.players[0].ship.alive) return { mul: 1, tier: 'none' };
  let minDistSq = Infinity;
  for (const a of s.asteroids) {
    if (!a.alive) continue;
    const dx = a.pos.x - s.players[0].ship.pos.x;
    const dy = a.pos.y - s.players[0].ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDistSq) minDistSq = d2;
  }
  for (const u of s.ufos) {
    if (!u.alive) continue;
    const dx = u.pos.x - s.players[0].ship.pos.x;
    const dy = u.pos.y - s.players[0].ship.pos.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < minDistSq) minDistSq = d2;
  }
  if (minDistSq <= 55 * 55) return { mul: 1.5,  tier: 'risk' };
  if (minDistSq <= 110 * 110) return { mul: 1.25, tier: 'close' };
  return { mul: 1, tier: 'none' };
}

/** Mass for asteroid-asteroid elastic collisions. Size dominates
 *  (volume-ish ~ radius³ would over-weight large rocks, so square-root
 *  it down); type tweaks density slightly (iron + mesosiderite heavier,
 *  carbonaceous lighter).
 *
 *  Veins are set-piece centrepieces — the wave-5 heist vault and the
 *  random vein event. They should feel megalithic: bullets already
 *  skip their knockback (damageAsteroid), but without an oversized
 *  mass an incoming chondrite or iron rock could still shunt them
 *  around during the long engagement, which makes the prize feel
 *  cheap. A very large mass keeps the impulse and position-correction
 *  contributions on the vein effectively zero while the other rock
 *  bounces off naturally. */
function asteroidMass(a: Asteroid): number {
  if (a.terrain) return 1e9;
  if (a.isVein) return 1e6;
  const sizeFactor = a.size === 'large' ? 4 : a.size === 'medium' ? 2 : 1;
  const typeFactor =
    a.type === 'ballast' ? 2.6 :
    a.type === 'iron' || a.type === 'mesosiderite' ? 1.5 :
    a.type === 'pallasite' ? 1.3 :
    a.type === 'carbonaceous' ? 0.8 :
    1.0;
  return sizeFactor * typeFactor;
}

/** Pair-wise elastic bounce between same-depth asteroids. Currently
 *  only depth 3 (the gameplay plane) has collide=true; the loop will
 *  fan out cleanly if other bands flip the flag later. */
function runAsteroidCollisions(s: GameState): void {
  const list = s.asteroids;
  const n = list.length;
  const RESTITUTION = 0.86;  // <1 so collisions slowly bleed energy
  for (let i = 0; i < n; i++) {
    const a = list[i];
    if (!a.alive) continue;
    const cfgA = DEPTH_CONFIGS[a.depth];
    if (!cfgA || !cfgA.collide) continue;
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      if (!b.alive || b.depth !== a.depth) continue;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const minDist = a.radius + b.radius;
      const distSq = dx * dx + dy * dy;
      if (distSq >= minDist * minDist || distSq < 1) continue;
      const dist = Math.sqrt(distSq);
      const nx = dx / dist;
      const ny = dy / dist;
      const rvx = b.vel.x - a.vel.x;
      const rvy = b.vel.y - a.vel.y;
      const velAlongNormal = rvx * nx + rvy * ny;
      // Separating already — skip impulse, only correct overlap.
      if (velAlongNormal < 0) {
        const massA = asteroidMass(a);
        const massB = asteroidMass(b);
        const jImpulse = -(1 + RESTITUTION) * velAlongNormal / (1 / massA + 1 / massB);
        const ix = jImpulse * nx;
        const iy = jImpulse * ny;
        a.vel.x -= ix / massA;
        a.vel.y -= iy / massA;
        b.vel.x += ix / massB;
        b.vel.y += iy / massB;
        // Angular kick — convert tangential component into rotational
        // velocity so big crunches visibly spin the rocks.
        const tx = -ny;
        const ty = nx;
        const tangSpeed = (rvx * tx + rvy * ty);
        a.rotVel += tangSpeed * 0.012 / massA;
        b.rotVel -= tangSpeed * 0.012 / massB;
      }
      // Position correction so the rocks aren't penetrating next frame.
      // Distribute the push by inverse mass so the heavier one moves less.
      const overlap = minDist - dist;
      const massA = asteroidMass(a);
      const massB = asteroidMass(b);
      const totalInvMass = (1 / massA) + (1 / massB);
      const corrA = (overlap / totalInvMass) * (1 / massA);
      const corrB = (overlap / totalInvMass) * (1 / massB);
      a.pos.x -= nx * corrA;
      a.pos.y -= ny * corrA;
      b.pos.x += nx * corrB;
      b.pos.y += ny * corrB;
    }
  }
}

/**
 * Apply one bullet's worth of damage to an asteroid. Iron at large size has hp=2
 * — first hit flashes and dents, second hit fragments. All other cases are 1hp.
 */
function damageAsteroid(s: GameState, a: Asteroid, opts?: { isCarom?: boolean; isWrap?: boolean; bulletVel?: Vec2; bulletPos?: Vec2; p?: PlayerState }): void {
  const p = opts?.p ?? s.players[0];
  if (a.terrain) {
    a.hitFlash = 0.55;
    const px = opts?.bulletPos?.x ?? a.pos.x, py = opts?.bulletPos?.y ?? a.pos.y;
    if (a.stationPart === 'arm') {
      // Armoured clang — a bright cold-metal spark spray that reads as
      // "deflected; this is a shield, not the weak point".
      spawnParticles(s, px, py, 9, '#cfe0ff', 220, 240);
      spawnParticles(s, px, py, 4, '#ffffff', 300, 160);
    } else {
      const cfg = ASTEROID_TYPE_CONFIG[a.type];
      spawnParticles(s, px, py, 5, cfg.glow, 90, 260);
    }
    audio.hit();
    return;
  }
  a.hp -= 1;
  a.hitFlash = 1;
  // Tiny momentum transfer on the non-fatal hit — even iron-large surviving
  // a first shot should visibly accept the impulse. Scales inversely with
  // asteroid mass-equivalent so a small rock budges more than a large one.
  if (opts?.bulletVel && !a.isVein && bulletKnockbackEnabled()) {
    // Veins are set-piece centrepieces (wave 5 vault, random vein events)
    // and should feel massive — no bullet impulse budges them. The 100-300
    // hit fight reads as "chipping a megalith" instead of "shoving a pebble".
    const massBias = a.size === 'large' ? 0.05 : a.size === 'medium' ? 0.08 : 0.12;
    a.vel.x += opts.bulletVel.x * massBias;
    a.vel.y += opts.bulletVel.y * massBias;
  }
  // Council edge ergonomics: when the ship is hugging a screen edge and the
  // player lands a bullet on a council asteroid, apply an angular impulse
  // (2D cross product of impact-offset × bullet force, matching real space
  // physics — off-centre hits spin, dead-on hits don't) plus a gentle push
  // in the away-from-ship direction. Reads as "I knocked it back into the
  // room" when you're cornered; does nothing when you're mid-field.
  if (a.councilMember && opts?.bulletPos && opts?.bulletVel) {
    const EDGE_PX = 90;
    const shipAtEdge = p.ship.pos.x < EDGE_PX
                    || p.ship.pos.x > WORLD_W - EDGE_PX
                    || p.ship.pos.y < EDGE_PX
                    || p.ship.pos.y > WORLD_H - EDGE_PX;
    if (shipAtEdge) {
      // Lever arm: asteroid centre → impact point. Sign of (r × F)_z picks
      // which side of the rock got hit, so spin direction matches physics.
      const rx = opts.bulletPos.x - a.pos.x;
      const ry = opts.bulletPos.y - a.pos.y;
      const bspeed = Math.hypot(opts.bulletVel.x, opts.bulletVel.y) || 1;
      const fx = opts.bulletVel.x / bspeed;
      const fy = opts.bulletVel.y / bspeed;
      const cross = rx * fy - ry * fx;
      // Normalise by radius so large and small council pieces spin at a
      // comparable visual rate. 3.0 picks ~half a rotation per second on a
      // glancing tangent hit; a dead-on shot contributes ~zero.
      a.rotVel += (cross / Math.max(1, a.radius)) * 3.0;
      // Gentle push away from the ship in straight-line distance. 35 px/s
      // is enough to read but not so much that the council escapes pursuit.
      const dx = a.pos.x - p.ship.pos.x;
      const dy = a.pos.y - p.ship.pos.y;
      const ddist = Math.hypot(dx, dy) || 1;
      const PUSH = 35;
      a.vel.x += (dx / ddist) * PUSH;
      a.vel.y += (dy / ddist) * PUSH;
    }
  }
  if (a.hp <= 0) {
    breakAsteroid(s, a, opts);
    return;
  }
  // Vein streams sats/score per hit, throws a shower of chips off the impact
  // point on the rim (so the bite reads at the surface, not in the centre of a
  // huge rock), and visibly wears the megalith down to a glowing core as its HP
  // drops. Power-ups drop on landed-hit milestones to sustain the long fight.
  if (a.isVein) {
    if (s.session && !isCoopCampaignMode()) {
      p.sats += VEIN_SATS_PER_HIT;
    } else {
      p.score += VEIN_SCORE_PER_HIT;
    }
    audio.coinPickup();
    // Capture the spawn radius on first hit (after any set-piece override) so
    // the rock can wear to a glowing core as HP drops. Derived purely from
    // hp/hpMax — no RNG in this path, so co-op lockstep stays bit-identical.
    // Collision + render both read a.radius, so the hitbox shrinks with it.
    if (a.veinBaseRadius == null) a.veinBaseRadius = a.radius;
    const hpFrac = Math.max(0, Math.min(1, a.hp / a.hpMax));
    a.radius = a.veinBaseRadius * (VEIN_MIN_RADIUS_SCALE + (1 - VEIN_MIN_RADIUS_SCALE) * hpFrac);
    let nx = (opts?.bulletPos?.x ?? a.pos.x) - a.pos.x;
    let ny = (opts?.bulletPos?.y ?? a.pos.y) - a.pos.y;
    const nlen = Math.hypot(nx, ny) || 1;
    nx /= nlen; ny /= nlen;
    // Chip at the TRUE contact point — the bullet's own position when the hit
    // registered — not a forced inner circle. The collision radius can sit
    // inside the lumpy visible silhouette, so a computed rim floated chips off
    // the rock; the real impact point lands them where the shot actually bit.
    const rimX = opts?.bulletPos?.x ?? (a.pos.x + nx * a.radius);
    const rimY = opts?.bulletPos?.y ?? (a.pos.y + ny * a.radius);
    const out: Vec2 = { x: nx, y: ny };
    if (a.stationPart === 'core') {
      // The reactor vents anomalous energy when struck — bright green + white
      // sparks so the core reads unmistakably as THE weak point you're hurting.
      spawnParticles(s, rimX, rimY, 13, '#9be15d', 240, 520, { dir: out, spread: Math.PI * 0.9 });
      spawnParticles(s, rimX, rimY, 6, '#eaffc0', 320, 360, { dir: out, spread: Math.PI * 1.0 });
      spawnParticles(s, rimX, rimY, 4, '#ffffff', 280, 240, { dir: out, spread: Math.PI * 0.7 });
    } else {
      spawnParticles(s, rimX, rimY, 12, '#ffd84a', 250, 520, { dir: out, spread: Math.PI * 0.85 });
      spawnParticles(s, rimX, rimY, 5, '#fff5d8', 320, 360, { dir: out, spread: Math.PI * 1.0 });
      spawnParticles(s, rimX, rimY, 4, '#9be15d', 200, 460, { dir: out, spread: Math.PI * 0.75 });
    }
    bumpTrauma(s, 0.05);
    const hitsLanded = a.hpMax - a.hp;
    // Reactive defence — a boss vein breaks a fat shard off straight back at the
    // firing pilot every Nth landed hit. The more you pour in, the more comes
    // back, so you can't sit and grind: weave the shard while you chip. Cadence
    // + speed soften on easy, sharpen on hard.
    if (a.veinRetaliates && hitsLanded > 0) {
      const diff = currentDifficulty();
      if (hitsLanded % VEIN_RETALIATE_PER_N_HITS[diff] === 0) {
        veinRetaliateShard(s, a, p.ship.pos, VEIN_SHARD_SPEED[diff]);
      }
    }
    if (hitsLanded > 0 && hitsLanded % VEIN_POWERUP_PER_N_HITS === 0) {
      const pool: PowerUpType[] = s.session && !isCoopCampaignMode()
        ? ['rapid', 'trident', 'satboost']
        : ['rapid', 'trident'];
      const pick = pool[Math.floor(gameRng() * pool.length)];
      // Fling the pickup OUT, biased away from the shooter, so it sails clear of
      // the rock and the player must break off to chase it down — a gentle pull
      // off the camp spot (it decelerates to rest ~300px out). ±60° of jitter
      // keeps the lane varied; all deterministic.
      let ax = a.pos.x - p.ship.pos.x, ay = a.pos.y - p.ship.pos.y;
      const al = Math.hypot(ax, ay) || 1;
      const base = Math.atan2(ay / al, ax / al) + (gameRng() - 0.5) * (Math.PI * 0.7);
      const launch = 210;
      maybeDropPowerUp(s, a.pos.x, a.pos.y, pick, { x: Math.cos(base) * launch, y: Math.sin(base) * launch });
    }
    return;
  }
  if (a.stationPart === 'emitter') {
    // Emitter pod taking damage — hot orange sparks off the impact point so a
    // breakable weak point reads clearly (vs the arm's cold clang).
    const px = opts?.bulletPos?.x ?? a.pos.x, py = opts?.bulletPos?.y ?? a.pos.y;
    spawnParticles(s, px, py, 8, '#ffb24a', 200, 300);
    spawnParticles(s, px, py, 4, '#ffe6b0', 260, 220);
    bumpTrauma(s, 0.03);
    audio.hit();
    return;
  }
  const cfg = ASTEROID_TYPE_CONFIG[a.type];
  audio.hit();
  spawnParticles(s, a.pos.x, a.pos.y, 5, cfg.glow, 110, 280);
}

/** Volatile asteroid detonation — a shockwave that shoves every nearby
 *  asteroid and the ship outward from the blast point. Pure math, no RNG,
 *  so it stays deterministic; particles/shockwave are cosmetic pools. */
function volatileBlast(s: GameState, x: number, y: number, size: AsteroidSize): void {
  const radius = size === 'large' ? 220 : size === 'medium' ? 150 : 95;
  const force = size === 'large' ? 270 : size === 'medium' ? 175 : 115;
  spawnShockwave(s, x, y, radius * 0.5, '#ff7a2a');
  spawnParticles(s, x, y, size === 'large' ? 22 : 13, '#ff9a3a', 320, 620);
  for (const a of s.asteroids) {
    if (!a.alive) continue;
    const dx = a.pos.x - x, dy = a.pos.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist >= radius || dist < 1) continue;
    const push = force * (1 - dist / radius);
    a.vel.x += (dx / dist) * push;
    a.vel.y += (dy / dist) * push;
  }
  if (s.players[0].ship.alive) {
    const dx = s.players[0].ship.pos.x - x, dy = s.players[0].ship.pos.y - y;
    const dist = Math.hypot(dx, dy);
    if (dist < radius && dist > 1) {
      const push = force * (1 - dist / radius);
      s.players[0].ship.vel.x += (dx / dist) * push;
      s.players[0].ship.vel.y += (dy / dist) * push;
    }
  }
  bumpTrauma(s, size === 'large' ? 0.3 : 0.18);
  audio.explosion(size === 'large' ? 1.1 : 0.8);
}

/** EAGLE STATION core destroyed — the rig comes apart in a big multi-stage
 *  detonation: the core blooms, every other rig part (arms + pods) blows with
 *  it, and a fat scatter of collectible loot is flung out so the clear-grace
 *  window becomes a proper scoop-the-spoils beat before the warp. */
function stationCoreFinale(s: GameState, core: Asteroid, p: PlayerState): void {
  p.runStats.veinsBroken += 1;
  markAchievement(s, 'first-vein');
  if (s.session && !isCoopCampaignMode()) p.sats += VEIN_JACKPOT_SATS * 2;
  p.score += VEIN_JACKPOT_SCORE * 2;
  bumpTrauma(s, 0.9);
  hitStop(s, 320);
  audio.pulseDuck(0.5, 320);
  haptic('rumble');
  audio.explosion(1.9);
  // Core bloom — stacked shockwaves + a chromatic particle storm.
  spawnShockwave(s, core.pos.x, core.pos.y, core.radius * 1.5, '#9be15d');
  spawnShockwave(s, core.pos.x, core.pos.y, core.radius * 2.4, '#eaffc0');
  spawnParticles(s, core.pos.x, core.pos.y, 64, '#9be15d', 440, 1150);
  spawnParticles(s, core.pos.x, core.pos.y, 32, '#eaffc0', 340, 920);
  spawnParticles(s, core.pos.x, core.pos.y, 24, '#ffffff', 520, 700);
  // The rest of the rig blows apart — arms (cold metal) + pods (hot).
  for (const part of s.asteroids) {
    if (!part.alive || part.stationPart == null || part === core) continue;
    part.alive = false;
    const hot = part.stationPart === 'emitter';
    spawnShockwave(s, part.pos.x, part.pos.y, part.radius * 1.4, hot ? '#ffb24a' : '#cfe0ff');
    spawnParticles(s, part.pos.x, part.pos.y, 20, hot ? '#ffb24a' : '#aab3c2', 320, 760);
    spawnParticles(s, part.pos.x, part.pos.y, 9, '#ffffff', 380, 520);
  }
  // Loot scatter — signed-in solo gets sat coins, everyone gets a dust shower,
  // so the clear-grace window always has goodies to scoop.
  if (s.session && !isCoopCampaignMode()) spawnCoins(s, core.pos.x, core.pos.y, VEIN_JACKPOT_SATS * 3, 6, 'sat');
  spawnCoins(s, core.pos.x, core.pos.y, 0, 11, 'dust');
  recordStreamEvent('vc', core.pos.x, core.pos.y);
  // THE FORGE (wave 25) is the campaign finale — the core's fall is the run's
  // victory, so it carries what the old boss-UFO kill did. EAGLE STATION (W17)
  // keeps the lighter "STATION DOWN" beat.
  if (s.wave === FINAL_WAVE) {
    s.bossDefeated = true;                         // the wave25Clear gate reads this
    markAchievement(s, 'first-boss');
    if (markSkinUnlocked('halo')) toastNow(s, 'HALO SKIN UNLOCKED');
    // Sweep the field for a clean victory beat — forged rocks, the meltdown
    // wells, and any pulse/missile in flight all go. (The clear's bossHold grace
    // holds the playing phase so the detonation below actually plays out.)
    for (const a of s.asteroids) {
      if (a.alive && a.stationPart == null && !a.terrain) {
        a.alive = false;
        spawnParticles(s, a.pos.x, a.pos.y, 8, '#ffb24a', 220, 360);
      }
    }
    for (const u of s.ufos) spawnParticles(s, u.pos.x, u.pos.y, 10, '#ff5050', 280, 500);  // forge-placed elites vaporise too
    s.ufos = [];
    s.mines = [];
    s.enemyBullets = [];
    // END-OF-GAME DETONATION — the forge tears itself apart. A full-screen white
    // flash + a SHORT punch (a long freeze would stall the burst) + screen-filling
    // shockwaves sweeping off the edges + a huge particle storm that bursts outward
    // and lingers as embers. The 5s bossHold grace lets it play out fully.
    s.flash = 1;                                   // white-out, held through the hit-stop then fades to reveal the burst
    bumpTrauma(s, 1.0);                            // max shake
    hitStop(s, 140);                               // a beat of weight, short enough that the burst still animates
    spawnShockwave(s, core.pos.x, core.pos.y, 120, '#ffffff');
    spawnShockwave(s, core.pos.x, core.pos.y, 340, '#eaffc0');
    spawnShockwave(s, core.pos.x, core.pos.y, 600, '#9be15d');
    spawnShockwave(s, core.pos.x, core.pos.y, 880, '#eaffc0');
    spawnShockwave(s, core.pos.x, core.pos.y, 1150, '#ffffff');   // sweeps off the screen edges
    spawnParticles(s, core.pos.x, core.pos.y, 70, '#ffffff', 920, 700);
    spawnParticles(s, core.pos.x, core.pos.y, 120, '#9be15d', 660, 1800);
    spawnParticles(s, core.pos.x, core.pos.y, 90, '#eaffc0', 500, 2100);
    spawnParticles(s, core.pos.x, core.pos.y, 70, '#ffd84a', 360, 2300);
    spawnParticles(s, core.pos.x, core.pos.y, 44, '#ff9a3a', 240, 2500);  // slow drifting embers
    audio.explosion(2.2);
    audio.explosion(1.5);                          // layered second boom for depth
    audio.pulseDuck(0.65, 700);
    haptic('celebrate');
    maybeDropPowerUp(s, core.pos.x, core.pos.y, 'nova');
    toastNow(s, s.session && !isCoopCampaignMode() ? `THE FORGE FALLS · +${VEIN_JACKPOT_SATS * 2} sats` : 'THE FORGE FALLS');
  } else {
    toastNow(s, s.session && !isCoopCampaignMode() ? `STATION DOWN · +${VEIN_JACKPOT_SATS * 2} sats` : `STATION DOWN · +${VEIN_JACKPOT_SCORE * 2}`);
  }
  maybeExtraLife(s, p);
}

/** An emitter pod knocked out — it bursts (and so stops placing rocks). A
 *  smaller cousin of the core finale: orange shockwave + spark storm + a kick
 *  of trauma, plus a little dust loot for disabling a placer. */
function stationEmitterDestroyed(s: GameState, em: Asteroid, p: PlayerState): void {
  bumpTrauma(s, 0.14);
  hitStop(s, 70);
  audio.explosion(0.7);
  spawnShockwave(s, em.pos.x, em.pos.y, em.radius * 2.6, '#ffb24a');
  spawnParticles(s, em.pos.x, em.pos.y, 24, '#ffb24a', 340, 720);
  spawnParticles(s, em.pos.x, em.pos.y, 11, '#ffe6b0', 400, 520);
  spawnParticles(s, em.pos.x, em.pos.y, 6, '#ffffff', 440, 380);
  p.score += 250;
  spawnCoins(s, em.pos.x, em.pos.y, 0, 3, 'dust');  // a small reward for cutting off the flow
  toastNow(s, 'POD DESTROYED');
}

function breakAsteroid(s: GameState, a: Asteroid, opts?: { suppressCoins?: boolean; isCarom?: boolean; isWrap?: boolean; bulletVel?: Vec2; p?: PlayerState }): void {
  const p = opts?.p ?? s.players[0];
  // Two shrink-rather-than-fragment cases:
  //   - Council members on the gameplay plane (chip a sculpture down).
  //   - Decoratives on non-gameplay depth bands (the player's bullet
  //     just chipped a big foreground rock; one-shot disappear felt
  //     glitchy because the visual size promised more impact).
  // Both want "shrink with a chunky pop, repeat until small, then
  // final death". Final small-size break flows through the normal
  // path below — for councils that means coins + stats, for
  // decoratives that means the clean-pop branch further down.
  const isDecorativeBand = (a.depth ?? 3) !== 3;
  const shouldShrink = a.size !== 'small'
    && !a.isVein
    && (a.councilMember !== undefined || isDecorativeBand);
  if (shouldShrink) {
    const newSize: AsteroidSize = a.size === 'large' ? 'medium' : 'small';
    a.size = newSize;
    const depthMul = DEPTH_CONFIGS[a.depth ?? 3]?.sizeMul ?? 1;
    a.radius = RADIUS_PER_SIZE[newSize] * depthMul;
    a.hp = 1;
    a.hpMax = 1;
    a.hitFlash = 1.5;
    // Carry bullet momentum into the surviving piece. The chunk just lost
    // mass, so the laser's impulse should push it along the shot direction
    // instead of leaving a stationary post-shrink rock floating in place.
    // Smaller surviving sizes accept proportionally more kick. Factors are
    // tuned conservatively — at BULLET_SPEED=520, a small-size kick of 0.12
    // adds ~62 px/s, enough to read as directional without rocketing the
    // chunk across the screen.
    if (opts?.bulletVel && bulletKnockbackEnabled()) {
      const kick = newSize === 'small' ? 0.12 : 0.08;
      a.vel.x += opts.bulletVel.x * kick;
      a.vel.y += opts.bulletVel.y * kick;
    }
    if (a.councilMember) audio.councilHit();
    else                 audio.hit();
    const colour = a.councilMember ? '#ffd84a' : (ASTEROID_TYPE_CONFIG[a.type]?.glow ?? '#fff5d8');
    spawnParticles(s, a.pos.x, a.pos.y, 16, colour, 200, 460);
    spawnParticles(s, a.pos.x, a.pos.y, 6, '#fff5d8', 220, 380);
    bumpTrauma(s, a.councilMember ? 0.15 : 0.08);
    return;
  }
  // Decorative final death (size === 'small' or already shrunk through).
  // Pop cleanly: no coin drop, no score, no fragments. Particle burst
  // sized to read against dim background bands.
  if (isDecorativeBand && !a.councilMember && !a.isVein) {
    a.alive = false;
    const cfg = ASTEROID_TYPE_CONFIG[a.type];
    spawnParticles(s, a.pos.x, a.pos.y, 12, cfg.glow, 200, 420);
    spawnParticles(s, a.pos.x, a.pos.y, 5, '#fff5d8', 240, 360);
    audio.hit();
    return;
  }
  a.alive = false;
  // EAGLE STATION core down — the whole rig detonates and scatters loot.
  if (a.stationPart === 'core') {
    stationCoreFinale(s, a, p);
    return;
  }
  // Emitter pod knocked out — it explodes (and stops placing rocks).
  if (a.stationPart === 'emitter') {
    stationEmitterDestroyed(s, a, p);
    return;
  }
  // Vein collapse: jackpot, big bloom, no fragments. Vapourises clean.
  if (a.isVein) {
    p.runStats.veinsBroken += 1;
    markAchievement(s, 'first-vein');
    if (s.session && !isCoopCampaignMode()) p.sats += VEIN_JACKPOT_SATS;
    p.score += VEIN_JACKPOT_SCORE;
    bumpTrauma(s, 0.55);
    hitStop(s, 220);
    audio.pulseDuck(0.45, 240);
    haptic('rumble');
    // Layered burst — gold core, white sparkle, magenta shockwave.
    spawnShockwave(s, a.pos.x, a.pos.y, a.radius * 0.9, '#ffd84a');
    spawnParticles(s, a.pos.x, a.pos.y, 36, '#ffd84a', 320, 900);
    spawnParticles(s, a.pos.x, a.pos.y, 18, '#fff5d8', 220, 700);
    spawnParticles(s, a.pos.x, a.pos.y, 14, '#ff8ad6', 280, 600);
    audio.explosion(1.2);
    recordStreamEvent('vc', a.pos.x, a.pos.y);
    if (s.session && !isCoopCampaignMode()) toastNow(s, `VEIN COLLAPSED · +${VEIN_JACKPOT_SATS} sats`);
    else           toastNow(s, `VEIN COLLAPSED · +${VEIN_JACKPOT_SCORE}`);
    maybeExtraLife(s, p);
    return;
  }
  const cfg = ASTEROID_TYPE_CONFIG[a.type];
  const mul = recordCombo(s, s.elapsed, p);
  // Trick-shot bonuses stack multiplicatively on top of combo: a wrapped carom
  // is a 4× kill on top of any active combo. Risk-proximity adds another tier
  // on top: ≤55px = ×1.5, ≤110px = ×1.25. Each fires independently and is
  // toasted unless the pallasite jackpot text would conflict.
  let bonusMul = 1;
  const trickLabels: string[] = [];
  const risk = computeRiskBonus(s);
  if (risk.tier === 'risk') { trickLabels.push('RISK'); markAchievement(s, 'first-risk'); }
  bonusMul *= risk.mul;
  if (opts?.isCarom) { bonusMul *= 2; trickLabels.push('CAROM'); markAchievement(s, 'first-carom'); }
  if (opts?.isWrap)  { bonusMul *= 2; trickLabels.push('WRAP');  markAchievement(s, 'first-wrap'); }
  // First-kill badge — fires the first time any asteroid breaks on this device.
  markAchievement(s, 'first-kill');
  p.runStats.asteroidsBroken += 1;
  p.score += Math.round(POINTS_PER_SIZE[a.size] * cfg.scoreMul * mul * bonusMul);
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
    spawnShockwave(s, a.pos.x, a.pos.y, a.radius, cfg.glow);
  }

  // Particles tinted to the type's accent
  spawnParticles(s, a.pos.x, a.pos.y, a.size === 'large' ? 18 : a.size === 'medium' ? 12 : 8, cfg.glow, 140, 700);

  // Coins drop — suppressed for NOVA so it can't be farmed for sats. Pallasite
  // asteroids always drop sats; other types roll for sat-vs-dust.
  if (!opts?.suppressCoins) {
    const coinCount = a.size === 'large' ? 4 : a.size === 'medium' ? 2 : 1;
    spawnCoins(s, a.pos.x, a.pos.y, satsValue, coinCount, undefined, a.type, a.size);
  }

  audio.explosion(a.size === 'large' ? 1.0 : a.size === 'medium' ? 0.8 : 0.6);
  // Final council shatter: layer the heroic break chord over the standard
  // explosion. Only fires on a.size === 'small' because larger council
  // sizes shrink via the branch above and never reach this code path.
  if (a.councilMember && a.size === 'small') {
    audio.councilBreak();
  }
  recordStreamEvent('ak', a.pos.x, a.pos.y);

  // Spawn smaller children — same type carries over so a chondrite swarm stays a swarm
  if (a.size === 'large' || a.size === 'medium') {
    // Tektite is impact glass — it shatters straight to a fast, wide spray
    // of small shards rather than the usual halving into the next size.
    const tektite = a.type === 'tektite';
    const childSize: AsteroidSize = tektite ? 'small' : (a.size === 'large' ? 'medium' : 'small');
    const count = cfg.breakInto;
    const baseAngle = Math.atan2(a.vel.y, a.vel.x);
    const spread = tektite ? 1.9 : (count === 2 ? 1.2 : 0.6);
    // Bullet impulse blended into every child — without this, a near-stationary
    // parent produces near-stationary kids whose only motion is the spread
    // offset around a zero-length vector. With it, the shot's direction
    // dominates when the parent was slow and adds to it when the parent was fast.
    // Factors are tuned conservatively (small=0.10 adds ~52 px/s at
    // BULLET_SPEED=520) so children read as kicked debris, not racing rounds.
    const childSizeFactor = childSize === 'medium' ? 0.07 : 0.10;
    const applyKick = bulletKnockbackEnabled();
    const bulletKickX = applyKick && opts?.bulletVel ? opts.bulletVel.x * childSizeFactor : 0;
    const bulletKickY = applyKick && opts?.bulletVel ? opts.bulletVel.y * childSizeFactor : 0;
    for (let i = 0; i < count; i++) {
      const offset = (i - (count - 1) / 2) * spread;
      const angle = baseAngle + offset;
      const speed = Math.hypot(a.vel.x, a.vel.y) * (tektite ? 1.4 : 1.2) + (tektite ? 90 : 0);
      const vel: Vec2 = {
        x: Math.cos(angle) * speed + bulletKickX,
        y: Math.sin(angle) * speed + bulletKickY,
      };
      // Preserve the council-member ref so child fragments carry the
      // same face all the way down to the smallest size. Sat drops on
      // the small break still come from the normal coin-spawn path.
      const child = spawnAsteroid(childSize, s.wave, { x: a.pos.x, y: a.pos.y }, vel, a.type,
        a.councilMember ? { councilMember: a.councilMember } : undefined);
      // Council children get the same guaranteed-visible tumble as
      // their parent — fragments spin distinctly from the get-go so
      // it reads as kinetic debris, not floating stickers.
      if (a.councilMember) {
        child.rotVel = (Math.random() < 0.5 ? -1 : 1) * (1.6 + Math.random() * 1.2);
      }
      s.asteroids.push(child);
    }
  }

  // Volatile rocks detonate on break: a shockwave that shoves nearby rocks
  // and the ship outward. Cascades when a volatile chain breaks.
  if (a.type === 'volatile') volatileBlast(s, a.pos.x, a.pos.y, a.size);

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
    audio.comboTick(Math.min(COMBO_MAX, p.combo + 1));
    toastNow(s, `+${trickLabels.join(' + ')}`);
  }

  // 600bn run-stats hooks. Bump on every break so the end-of-run
  // panel can show total asteroids destroyed; council members are
  // counted on their smallest-size death (when the asteroid is
  // genuinely gone, not fragmenting).
  if (getFlavour() === '600bn' || isSanctumMode()) {
    sanctumStats.asteroidsDestroyed += 1;
    if (a.councilMember && a.size === 'small') {
      sanctumCouncilDefeated += 1;
    }
  }

  maybeExtraLife(s, p);
}

/**
 * Award an extra life on each 10,000-score threshold crossing. Tracked via
 * `bonusLivesGranted` so dying after earning one doesn't get the life
 * regenerated by the next asteroid kill (the previous logic compared
 * current lives against a hardcoded `3 + earnedLives` target, which silently
 * resurrected players on Normal and bumped Hard runs from 2 lives up to 3).
 */
/**
 * Each 10,000 score-point milestone now spawns a 1UP power-up the player
 * has to fetch instead of incrementing p.lives directly. This converts the
 * threshold from a quiet stat tick into a tactical objective — go cross
 * the field, grab the heart, dodge what's between you and it. p.lives is
 * still capped at 5; thresholds crossed at cap still count via
 * bonusLivesGranted so dropping back under cap later doesn't backfill.
 *
 * Multi-threshold crossings in a single call (e.g. a vein jackpot pushing
 * +2500 across two milestones at once) spawn one 1UP per threshold, each
 * at its own random position.
 */
function maybeExtraLife(s: GameState, p: PlayerState): void {
  const earnedLives = Math.floor(p.score / 10000);
  if (earnedLives <= p.bonusLivesGranted) return;
  if (p.lives >= 5) {
    // Already at cap — record the threshold so we don't backfill 1UPs
    // later if the player loses lives.
    p.bonusLivesGranted = earnedLives;
    return;
  }
  const grant = Math.min(earnedLives - p.bonusLivesGranted, 5 - p.lives);
  p.bonusLivesGranted += grant;
  for (let i = 0; i < grant; i++) {
    const pos = pickExtraLifeSpawn(s, p);
    maybeDropPowerUp(s, pos.x, pos.y, 'extralife');
  }
}

/**
 * Pick a position on the gameplay plane for the 1UP spawn. The player
 * should have to traverse for it — so the spawn is 280–500 px from the
 * ship at a random angle, clamped inside the inner playfield (away from
 * the edges where the camera might cut the powerup off in portrait
 * follow). Avoids landing inside a live mine's gravity well — if the
 * first roll lands too close to a mine, retry up to a few times before
 * giving up and letting the player ride out the gravity.
 */
function pickExtraLifeSpawn(s: GameState, p: PlayerState): Vec2 {
  const ship = p.ship.pos;
  const MARGIN = 100;
  const MIN_DIST = 280;
  const MAX_DIST = 500;
  const MAX_TRIES = 8;
  let last: Vec2 = { x: WORLD_W / 2, y: WORLD_H / 2 };
  for (let t = 0; t < MAX_TRIES; t++) {
    const angle = gameRng() * Math.PI * 2;
    const dist = MIN_DIST + gameRng() * (MAX_DIST - MIN_DIST);
    const x = Math.max(MARGIN, Math.min(WORLD_W - MARGIN, ship.x + Math.cos(angle) * dist));
    const y = Math.max(MARGIN, Math.min(WORLD_H - MARGIN, ship.y + Math.sin(angle) * dist));
    last = { x, y };
    let clearOfMines = true;
    for (const m of s.mines) {
      if (!m.alive) continue;
      const dx = m.pos.x - x;
      const dy = m.pos.y - y;
      if (dx * dx + dy * dy < (m.gravityRange * 0.7) ** 2) { clearOfMines = false; break; }
    }
    if (clearOfMines) return { x, y };
  }
  return last;
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

function killShip(s: GameState, p: PlayerState, attacker?: PlayerState | null): void {
  const deathmatch = deathmatchActive();
  // Capture the impact-frame snapshot BEFORE flipping ship.alive — the
  // standard recordReplaySnapshot at frame start was taken at the ship's
  // pre-collision position, so without this the replay would end one frame
  // before the actual hit. Synthesising it here puts the visible final
  // frame on the impact moment.
  if (!deathmatch) pushReplayImpactFrame(s);

  const deathPos: Vec2 = { x: p.ship.pos.x, y: p.ship.pos.y };
  if (deathmatch) recordDeathmatchDeath(s, p, attacker);
  p.ship.alive = false;
  resetCombo(s, p);
  audio.explosion(1.4);
  recordStreamEvent('sh', deathPos.x, deathPos.y);
  audio.thrustOff();
  // Maximum trauma + deepest duck + rumble — death is the loudest impact.
  bumpTrauma(s, deathmatch ? 0.22 : 1.0);
  if (!deathmatch) hitStop(s, 140);
  audio.pulseDuck(deathmatch ? 0.65 : 0.35, deathmatch ? 140 : 360);
  haptic('rumble');
  // Layered explosion: ship-green burst + yellow flash + white sparks +
  // line-segment debris. Bigger and more cinematic than the old 30-particle
  // single-colour puff. When the ship style is MESH and the WebGL overlay
  // is ready, shatter into 3D chunk meshes instead of the 2D line fan —
  // the chunks live in the overlay scene and tumble themselves.
  spawnParticles(s, deathPos.x, deathPos.y, deathmatch ? 16 : 42, '#58ff58', 280, 1100);
  spawnParticles(s, deathPos.x, deathPos.y, deathmatch ? 8 : 22, '#ffd84a', 200,  700);
  spawnParticles(s, deathPos.x, deathPos.y, deathmatch ? 6 : 18, '#ffffff', 380,  450);
  if (!deathmatch || !p.ai) {
    if (getVisualStyle('ship') === 'mesh' && isWebGLOverlayReady()) {
      callWebGLShipExplosion(deathPos, p.ship.vel, p.ship.rot);
    } else {
      spawnShipDebris(s, p.ship);
    }
  }
  p.lives -= 1;
  p.runStats.livesLost += 1;
  if (deathmatch) {
    checkDeathmatchEnd(s);
    if (s.phase === 'gameover') return;
    if (p.lives > 0) {
      scheduleSimTransition(s, 'respawn', s.elapsed + DEATHMATCH_RESPAWN_DELAY_MS, 0, s.elapsed + DEATHMATCH_RESPAWN_DELAY_MS + DEATHMATCH_RESPAWN_MAX_WAIT_MS, s.players.indexOf(p));
    }
    return;
  }
  if (p.lives <= 0) {
    // p is out for good (ship.alive was already flipped to false above).
    // Fire the gameover sequence only when EVERY player is out — otherwise
    // the run continues with the survivors. Length-1: this is the original
    // single-player gameover.
    if (s.players.every((pl) => pl.lives <= 0)) {
      // Final death — capture the buffer for the replay, then route through
      // 'deathreplay' (provided we have something worth showing). The post-replay
      // transition stops the ambient bed; hull-breached music carries the moment.
      if (!deathmatch && s.replayBuffer.length >= 8) {
        s.deathReplay = {
          snapshots: s.replayBuffer.slice(),
          startedAt: performance.now(),
          spanMs: s.replayBuffer[s.replayBuffer.length - 1].t - s.replayBuffer[0].t,
          explosionAt: deathPos,
          explosionShip: {
            pos: { x: p.ship.pos.x, y: p.ship.pos.y },
            vel: { x: p.ship.vel.x, y: p.ship.vel.y },
            rot: p.ship.rot,
          },
          explosionSpawned: false,
        };
        // Clear the live particle/debris pools so the killShip burst doesn't
        // visibly haunt the replay's prelude — the replay re-spawns identical
        // particles+debris when it reaches the impact frame.
        s.particles = [];
        s.debris = [];
        // Drop any WebGL ship-explosion chunks left over from the live death
        // too — the replay re-fires the mesh explosion at its impact frame.
        callWebGLClearShipChunks();
        startDeathReplay(s);
      } else {
        s.phase = 'gameover';
        s.phaseStart = s.elapsed;
        // Hull-breached music carries it; no synth chime.
        stopGameplayAudio();
      }
    }
  } else {
    scheduleSimTransition(s, 'respawn', s.elapsed + 1500, 0, s.elapsed + 1500 + RESPAWN_MAX_WAIT_MS, s.players.indexOf(p));
  }
}

/** Clearance margin at a spawn point. Positive means the ship can safely
 *  appear there; negative means a hazard is inside the clear radius. */
function spawnPointClearance(s: GameState, x: number, y: number, ignorePlayer?: PlayerState, clearRadius = RESPAWN_SAFE_RADIUS): number {
  let best = Infinity;
  for (const a of s.asteroids) {
    if (!a.alive || (a.depth ?? 3) !== 3) continue;
    const dx = a.pos.x - x, dy = a.pos.y - y;
    best = Math.min(best, Math.hypot(dx, dy) - (a.radius + clearRadius));
  }
  for (const u of s.ufos) {
    if (!u.alive) continue;
    const dx = u.pos.x - x, dy = u.pos.y - y;
    best = Math.min(best, Math.hypot(dx, dy) - (u.radius + clearRadius));
  }
  for (const m of s.mines) {
    if (!m.alive) continue;
    const dx = m.pos.x - x, dy = m.pos.y - y;
    best = Math.min(best, Math.hypot(dx, dy) - (m.radius + clearRadius));
  }
  for (const pl of s.players) {
    if (pl === ignorePlayer || !pl.ship.alive) continue;
    const dx = pl.ship.pos.x - x, dy = pl.ship.pos.y - y;
    best = Math.min(best, Math.hypot(dx, dy) - (pl.ship.radius + clearRadius));
  }
  return best;
}

/** True when the spawn point has no gameplay asteroid, UFO, mine or live
 *  ship inside its clear radius — the respawn holds until this reads clear. */
function spawnPointClear(s: GameState, x: number, y: number, ignorePlayer?: PlayerState, clearRadius = RESPAWN_SAFE_RADIUS): boolean {
  return spawnPointClearance(s, x, y, ignorePlayer, clearRadius) >= 0;
}

/** Attempt a ship respawn. Returns true when the ship is placed — the
 *  caller then drops the pending 'respawn' transition — and false while
 *  the spawn point is still blocked, so the attempt retries next step.
 *  `deadline` is the sim-clock time past which the respawn goes ahead
 *  regardless, so a hazard parked on the point cannot soft-lock it. */
function respawnShip(s: GameState, p: PlayerState, deadline: number): boolean {
  if (s.phase === 'gameover' || s.phase === 'title') return true;
  // Resolve the respawn point in priority order:
  //   1. WAVE_SET_PIECES override (heist drops you at the bottom edge etc.)
  //   2. Per-slot spawn in 2-player runs (mirrors startGame so a respawned
  //      ship doesn't pile on top of its partner at world centre — bug
  //      observed in the duel recording, where slot 1 died once and then
  //      both ships shared (WORLD_W/2, WORLD_H/2) and the renderer drew
  //      what looked like a single ship for the rest of the run)
  //   3. World centre, single-player default
  const wavePiece = arenaActive() || deathmatchActive() ? undefined : WAVE_SET_PIECES[s.wave]?.playerSpawn;
  const slot = s.players.indexOf(p);
  const twoPlayer = s.players.length === 2;
  let px: number, py: number, prot: number;
  const deathmatch = deathmatchActive();
  if (deathmatch) {
    const spawnSlot = Math.max(0, slot);
    let best = deathmatchSpawnPoint(spawnSlot, s.players.length);
    let bestScore = -Infinity;
    for (let variant = 0; variant < 8; variant++) {
      const candidate = deathmatchSpawnPoint(spawnSlot, s.players.length, variant);
      const score = spawnPointClearance(s, candidate.x, candidate.y, p, DEATHMATCH_SAFE_SPAWN_RADIUS);
      if (score > bestScore) {
        bestScore = score;
        best = candidate;
      }
      if (score >= 0) break;
    }
    if (s.elapsed < deadline && bestScore < 0) return false;
    px = best.x; py = best.y; prot = best.rot;
  } else if (wavePiece) {
    px = wavePiece.x;
    py = wavePiece.y;
    prot = wavePiece.rot ?? -Math.PI / 2;
  } else if (twoPlayer && slot === 0) {
    px = WORLD_W * 0.30; py = WORLD_H * 0.50; prot = 0;
  } else if (twoPlayer && slot === 1) {
    px = WORLD_W * 0.70; py = WORLD_H * 0.50; prot = Math.PI;
  } else {
    px = WORLD_W / 2; py = WORLD_H / 2; prot = -Math.PI / 2;
  }
  // Hold the respawn until the spawn point is clear of hazards so the
  // player never materialises onto a rock — retry next step until then.
  if (!deathmatch && s.elapsed < deadline && !spawnPointClear(s, px, py, p)) {
    return false;
  }
  p.ship = makeShip();
  p.ship.pos.x = px;
  p.ship.pos.y = py;
  p.ship.rot = prot;
  p.ship.invulnerableUntil = s.elapsed + (deathmatch ? DEATHMATCH_RESPAWN_INVULN_MS : RESPAWN_INVULN_MS);
  toastNow(s, '');
  return true;
}

/** Regression-harness hook for the deterministic respawn placement contract.
 *  Kept as a tiny wrapper so tests can exercise the real private respawn
 *  code without duplicating its slot/clearance logic. */
export function __testRespawnShip(s: GameState, p: PlayerState, deadline: number): boolean {
  return respawnShip(s, p, deadline);
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
  s.toastUntil = s.elapsed + 2500;
}
