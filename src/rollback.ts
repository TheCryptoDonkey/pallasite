/**
 * Rollback netcode foundation — fast, complete, byte-exact snapshot/restore of
 * the entire simulation (Phase 2, Stage A).
 *
 * The lockstep loop (src/main.ts) currently applies every input at a fixed
 * delay so all clients stay deterministically in sync. Rollback removes the
 * delay on the LOCAL player's own ship and predicts remote inputs, re-running
 * `updateGame` from a saved point whenever a prediction turns out wrong. That
 * requires the one primitive this module provides: capture the *entire*
 * simulation state at frame N and restore it bit-for-bit later.
 *
 * The correctness contract (proven by rollback-harness.html):
 *
 *   restoreSim(state, snapshotSim(state)) followed by re-running updateGame N
 *   times produces the IDENTICAL per-frame `hashState` sequence as never having
 *   snapshotted/restored at all.
 *
 * `hashState` (peer-canary.ts) is the arbiter of "byte-identical". It excludes
 * the cosmetic pools (particles/debris/shockwaveRings/hyperspaceEffects, all
 * Math.random-driven and never read by gameplay), so the snapshot may omit
 * exactly those — and no more.
 *
 * Two axes of silent desync this module is built to avoid:
 *   1. A forgotten sim-relevant field (a buff timer, a pending transition).
 *      Caught by the harness's restore-then-re-sim assertion.
 *   2. Restoring the GameState mirrors of `rng`/`nextEntityId` but NOT the
 *      module globals they mirror. `gameRng()` and `nextStreamEntityId()` read
 *      the MODULE globals (seed.ts / game.ts), not `state.rng`/`state.nextEntityId`.
 *      restoreSim sets both, in the right order — see restoreSim below.
 *
 * Hot-path allocation: snapshots are taken every frame in the live loop, where
 * the soak shows zero long tasks today. The variable-length entity arrays are
 * therefore POOLED — each snapshot owns reusable entity objects that grow to a
 * high-water mark and are copied into field-by-field, never reallocated.
 * Restore (rare — only on a misprediction) allocates fresh live objects so the
 * stored snapshot stays pristine across repeated restores.
 */

import type {
  GameState, PlayerState, Ship, Asteroid, Bullet, Ufo, Mine, Coin, PowerUp,
  SimTransition, RunStats, DeathmatchRules,
} from './types.js';
import { getRngState, setRngState } from './seed.js';
import {
  getEntityIdCounter, setEntityIdCounter,
  getSimModuleState, setSimModuleState, type SimModuleState,
} from './game.js';

// ── Pooled variable-length array ─────────────────────────────────────────────
// `buf` is the backing store (length = high-water mark, never shrinks); `n` is
// the current logical length. Capture grows `buf` as needed and copies into the
// first `n`; restore reads the first `n`. Clone and live entity types are
// identical, so a single make()/copy() pair serves both directions.
interface Pooled<T> { buf: T[]; n: number; }
function pooled<T>(): Pooled<T> { return { buf: [], n: 0 }; }

function captureList<T>(live: readonly T[], p: Pooled<T>, make: () => T, copy: (s: T, d: T) => void): void {
  const n = live.length;
  while (p.buf.length < n) p.buf.push(make());
  for (let i = 0; i < n; i++) copy(live[i], p.buf[i]);
  p.n = n;
}
function restoreList<T>(p: Pooled<T>, make: () => T, copy: (s: T, d: T) => void): T[] {
  const out: T[] = new Array(p.n);
  for (let i = 0; i < p.n; i++) { const d = make(); copy(p.buf[i], d); out[i] = d; }
  return out;
}

// ── Per-entity shells + copiers ──────────────────────────────────────────────
// Each copy() assigns EVERY field. Vec2s are copied component-wise (never
// aliased). `shape`/`councilMember` are ref-copied — both are set once at spawn
// and never mutated, so sharing the reference is correct and cheap. Optional
// fields are always assigned (even to `undefined`) so a reused pooled object
// can never leak a stale value when an entity's optional field disappears.

const EMPTY_SHAPE: number[] = [];

function makeShip(): Ship {
  return {
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: 0, alive: false, id: undefined,
    rot: 0, rotVel: 0, thrusting: false, invulnerableUntil: 0, thrustFrame: 0,
    hyperspaceReadyAt: 0, hyperspaceCloakMs: 0, hyperspaceMalfunction: false,
    shieldUp: false, shieldExpiresAt: 0, shieldReadyAt: 0, recoilOffset: 0,
    shieldHitFlash: 0, lastHyperspaceAt: 0,
  };
}
function copyShip(s: Ship, d: Ship): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.vel.x = s.vel.x; d.vel.y = s.vel.y;
  d.radius = s.radius; d.alive = s.alive; d.id = s.id;
  d.rot = s.rot; d.rotVel = s.rotVel; d.thrusting = s.thrusting;
  d.invulnerableUntil = s.invulnerableUntil; d.thrustFrame = s.thrustFrame;
  d.hyperspaceReadyAt = s.hyperspaceReadyAt; d.hyperspaceCloakMs = s.hyperspaceCloakMs;
  d.hyperspaceMalfunction = s.hyperspaceMalfunction;
  d.shieldUp = s.shieldUp; d.shieldExpiresAt = s.shieldExpiresAt; d.shieldReadyAt = s.shieldReadyAt;
  d.recoilOffset = s.recoilOffset; d.shieldHitFlash = s.shieldHitFlash; d.lastHyperspaceAt = s.lastHyperspaceAt;
}

function makeAsteroid(): Asteroid {
  return {
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: 0, alive: false, id: undefined,
    size: 'large', type: 'stony', depth: 3, councilMember: undefined,
    hp: 0, hpMax: 0, hitFlash: 0, rot: 0, rotVel: 0, shape: EMPTY_SHAPE, hue: 0,
    isVein: false, veinBaseRadius: undefined, veinRetaliates: undefined,
    stationPart: undefined, stationSlot: undefined, terrain: undefined, gravity: undefined,
  };
}
function copyAsteroid(s: Asteroid, d: Asteroid): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.vel.x = s.vel.x; d.vel.y = s.vel.y;
  d.radius = s.radius; d.alive = s.alive; d.id = s.id;
  d.size = s.size; d.type = s.type; d.depth = s.depth; d.councilMember = s.councilMember;
  d.hp = s.hp; d.hpMax = s.hpMax; d.hitFlash = s.hitFlash; d.rot = s.rot; d.rotVel = s.rotVel;
  d.shape = s.shape;  // ref-copy: generated at spawn, never mutated
  d.hue = s.hue; d.isVein = s.isVein; d.terrain = s.terrain; d.gravity = s.gravity;
  // Vein gameplay state — base radius drives the live collision/render radius
  // (shrink), veinRetaliates gates the defensive shard. Both affect the sim, so
  // they must survive snapshot/restore or a rollback mid-vein-fight would
  // desync. Always assigned (incl. undefined).
  d.veinBaseRadius = s.veinBaseRadius; d.veinRetaliates = s.veinRetaliates;
  // EAGLE STATION part tagging — drives rig render + the tick's rotation/placing.
  d.stationPart = s.stationPart; d.stationSlot = s.stationSlot;
}

function makeBullet(): Bullet {
  return {
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: 0, alive: false, id: undefined,
    ttl: 0, pierceLeft: 0, caromHit: false, wrapped: false, hasLanded: false, owner: -1,
    shard: undefined, homing: undefined,
  };
}
function copyBullet(s: Bullet, d: Bullet): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.vel.x = s.vel.x; d.vel.y = s.vel.y;
  d.radius = s.radius; d.alive = s.alive; d.id = s.id;
  d.ttl = s.ttl; d.pierceLeft = s.pierceLeft; d.caromHit = s.caromHit;
  d.wrapped = s.wrapped; d.hasLanded = s.hasLanded; d.owner = s.owner;
  // `homing` steers the missile (gameplay) so it MUST survive snapshot/restore
  // or a rollback would desync; `shard` is render-only, copied for fidelity.
  d.shard = s.shard; d.homing = s.homing;
}

function makeUfo(): Ufo {
  return {
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: 0, alive: false, id: undefined,
    type: 'cruiser', hp: 0, dir: 1, zigTimer: 0, shootTimer: 0, lifetime: 0, blink: 0, hitFlash: 0, bossPhase: 1,
  };
}
function copyUfo(s: Ufo, d: Ufo): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.vel.x = s.vel.x; d.vel.y = s.vel.y;
  d.radius = s.radius; d.alive = s.alive; d.id = s.id;
  d.type = s.type; d.hp = s.hp; d.dir = s.dir; d.zigTimer = s.zigTimer; d.shootTimer = s.shootTimer;
  d.lifetime = s.lifetime; d.blink = s.blink; d.hitFlash = s.hitFlash; d.bossPhase = s.bossPhase;
}

function makeMine(): Mine {
  return {
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: 0, alive: false, id: undefined,
    age: 0, gravityRange: 0, hp: 0, hitFlash: 0,
  };
}
function copyMine(s: Mine, d: Mine): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.vel.x = s.vel.x; d.vel.y = s.vel.y;
  d.radius = s.radius; d.alive = s.alive; d.id = s.id;
  d.age = s.age; d.gravityRange = s.gravityRange; d.hp = s.hp; d.hitFlash = s.hitFlash;
}

function makeCoin(): Coin {
  return {
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: 0, alive: false, id: undefined,
    ttl: 0, collected: false, kind: 'dust', value: 0, sourceType: undefined,
  };
}
function copyCoin(s: Coin, d: Coin): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.vel.x = s.vel.x; d.vel.y = s.vel.y;
  d.radius = s.radius; d.alive = s.alive; d.id = s.id;
  d.ttl = s.ttl; d.collected = s.collected; d.kind = s.kind; d.value = s.value; d.sourceType = s.sourceType;
}

function makePowerUp(): PowerUp {
  return {
    pos: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, radius: 0, alive: false, id: undefined,
    type: 'rapid', ttl: 0, collected: false,
  };
}
function copyPowerUp(s: PowerUp, d: PowerUp): void {
  d.pos.x = s.pos.x; d.pos.y = s.pos.y; d.vel.x = s.vel.x; d.vel.y = s.vel.y;
  d.radius = s.radius; d.alive = s.alive; d.id = s.id;
  d.type = s.type; d.ttl = s.ttl; d.collected = s.collected;
}

function makeTransition(): SimTransition {
  return { kind: 'respawn', due: 0, epoch: 0, arg: 0, playerIdx: -1 };
}
function copyTransition(s: SimTransition, d: SimTransition): void {
  d.kind = s.kind; d.due = s.due; d.epoch = s.epoch; d.arg = s.arg; d.playerIdx = s.playerIdx;
}

function makeRunStats(): RunStats {
  return {
    ufoKills: { cruiser: 0, elite: 0, tank: 0, sniper: 0, boss: 0 },
    minesDestroyed: 0, largestCombo: 0, powerupsCollected: 0, veinsBroken: 0,
    asteroidsBroken: 0, bulletsFired: 0, bulletsMissed: 0, hyperspacesUsed: 0, livesLost: 0,
  };
}
function copyRunStats(s: RunStats, d: RunStats): void {
  d.ufoKills.cruiser = s.ufoKills.cruiser; d.ufoKills.elite = s.ufoKills.elite;
  d.ufoKills.tank = s.ufoKills.tank; d.ufoKills.sniper = s.ufoKills.sniper; d.ufoKills.boss = s.ufoKills.boss;
  d.minesDestroyed = s.minesDestroyed; d.largestCombo = s.largestCombo;
  d.powerupsCollected = s.powerupsCollected; d.veinsBroken = s.veinsBroken;
  d.asteroidsBroken = s.asteroidsBroken; d.bulletsFired = s.bulletsFired;
  d.bulletsMissed = s.bulletsMissed; d.hyperspacesUsed = s.hyperspacesUsed; d.livesLost = s.livesLost;
}

// Clear-and-refill the destination record so a reused pooled object never keeps
// a key the source no longer has, and a fresh restore target fills cleanly.
function copyKeys(s: Record<string, boolean>, d: Record<string, boolean>): void {
  for (const k in d) if (!(k in s)) delete d[k];
  for (const k in s) d[k] = s[k];
}

function makePlayer(): PlayerState {
  return {
    ship: makeShip(), targetHeading: null, thrustOverride: false, keys: {}, ai: undefined,
    score: 0, deathmatchKills: 0, deathmatchDeaths: 0, deathmatchStreak: 0,
    sats: 0, displaySats: 0, lives: 0, bonusLivesGranted: 0,
    combo: 0, comboExpiresAt: 0,
    rapidExpiresAt: 0, satboostExpiresAt: 0, tridentExpiresAt: 0, magnetExpiresAt: 0, fireCooldownUntil: 0,
    lurking: false, lurkingSince: 0, lurkSatsBlocked: 0, lurkEverDetected: false,
    runStats: makeRunStats(),
  };
}
function copyPlayer(s: PlayerState, d: PlayerState): void {
  copyShip(s.ship, d.ship);
  d.targetHeading = s.targetHeading; d.thrustOverride = s.thrustOverride;
  copyKeys(s.keys, d.keys); d.ai = s.ai;
  d.score = s.score; d.deathmatchKills = s.deathmatchKills; d.deathmatchDeaths = s.deathmatchDeaths; d.deathmatchStreak = s.deathmatchStreak;
  d.sats = s.sats; d.displaySats = s.displaySats; d.lives = s.lives; d.bonusLivesGranted = s.bonusLivesGranted;
  d.combo = s.combo; d.comboExpiresAt = s.comboExpiresAt;
  d.rapidExpiresAt = s.rapidExpiresAt; d.satboostExpiresAt = s.satboostExpiresAt;
  d.tridentExpiresAt = s.tridentExpiresAt; d.magnetExpiresAt = s.magnetExpiresAt; d.fireCooldownUntil = s.fireCooldownUntil;
  d.lurking = s.lurking; d.lurkingSince = s.lurkingSince; d.lurkSatsBlocked = s.lurkSatsBlocked; d.lurkEverDetected = s.lurkEverDetected;
  copyRunStats(s.runStats, d.runStats);
}

function cloneRules(s: DeathmatchRules | null): DeathmatchRules | null {
  return s ? { mode: s.mode, timeLimitMs: s.timeLimitMs, killLimit: s.killLimit, respawns: s.respawns, aiSkill: s.aiSkill } : null;
}

// ── The clone: the sim-relevant subset of GameState ──────────────────────────
// Deliberately NOT `Partial<GameState>` — a typed subset makes "did I forget a
// field" a compile-time question. Omitted: the cosmetic pools (particles,
// debris, shockwaveRings, hyperspaceEffects — Math.random-driven, not hashed)
// and the non-sim output sinks (session, profile, deathReplay, replayBuffer,
// ghostSamples, ghostPoseSamples, deathmatchFeed — never read back into
// gameplay, not hashed). Their sampling cursors ARE captured via SimModuleState,
// so a re-sim won't double-append; the sinks themselves are intentionally not
// rewound (a documented, harmless non-rewind).
interface SimStateClone {
  phase: GameState['phase'];
  players: Pooled<PlayerState>;
  asteroids: Pooled<Asteroid>;
  bullets: Pooled<Bullet>;
  enemyBullets: Pooled<Bullet>;
  ufos: Pooled<Ufo>;
  mines: Pooled<Mine>;
  coins: Pooled<Coin>;
  powerups: Pooled<PowerUp>;
  pendingTransitions: Pooled<SimTransition>;
  deathmatchRules: DeathmatchRules | null;
  deathmatchStartedAt: number;
  deathmatchEndedReason: GameState['deathmatchEndedReason'];
  deathmatchWinnerSlot: number | null;
  sanctum: GameState['sanctum'];
  wave: number;
  phaseStart: number;
  lastUpdate: number;
  elapsed: number;
  frame: number;
  nextUfoSpawn: number;
  nextMineSpawn: number;
  warpTargetWave: number;
  bonusStartedAt: number;
  bonusNextSpawnAt: number;
  bonusPreludeSpawned: number;
  runTimeMs: number;
  runStartedAt: number;
  seed: number;
  rng: number | null;
  nextEntityId: number;
  bossDefeated: boolean;
  forgeBreached: boolean;
  defenderMode: boolean;
  defenderTimerMs: number;
  defenderCouncilLost: number;
  hitStopSteps: number;
  toast: string | null;
  toastUntil: number;
  cheatedThisRun: boolean;
  initialsEnteredThisRun: boolean;
  cameraTrauma: number;
  shieldUsedThisWave: boolean;
  bulletsFiredThisWave: number;
  missedShotsThisWave: number;
  ufoSpawnedThisWave: boolean;
  ufoKilledThisWave: boolean;
  ufoKillsThisWave: number;
  satRollsThisWave: number;
  bulletCurtainKillTarget: number;
  veinSwarmDueAt: number;
  waveClearAt: number | null;
  phaseEpoch: number;
}

function makeClone(): SimStateClone {
  return {
    phase: 'title',
    players: pooled(), asteroids: pooled(), bullets: pooled(), enemyBullets: pooled(),
    ufos: pooled(), mines: pooled(), coins: pooled(), powerups: pooled(), pendingTransitions: pooled(),
    deathmatchRules: null, deathmatchStartedAt: 0, deathmatchEndedReason: null, deathmatchWinnerSlot: null,
    sanctum: undefined,
    wave: 0, phaseStart: 0, lastUpdate: 0, elapsed: 0, frame: 0,
    nextUfoSpawn: 0, nextMineSpawn: 0, warpTargetWave: 0,
    bonusStartedAt: 0, bonusNextSpawnAt: 0, bonusPreludeSpawned: 0,
    runTimeMs: 0, runStartedAt: 0, seed: 0, rng: null, nextEntityId: 0,
    bossDefeated: false, forgeBreached: false, defenderMode: false, defenderTimerMs: 0, defenderCouncilLost: 0,
    hitStopSteps: 0,
    toast: null, toastUntil: 0, cheatedThisRun: false, initialsEnteredThisRun: false,
    cameraTrauma: 0,
    shieldUsedThisWave: false, bulletsFiredThisWave: 0, missedShotsThisWave: 0,
    ufoSpawnedThisWave: false, ufoKilledThisWave: false, ufoKillsThisWave: 0,
    satRollsThisWave: 0, bulletCurtainKillTarget: 0, veinSwarmDueAt: 0,
    waveClearAt: null, phaseEpoch: 0,
  };
}

function captureState(s: GameState, c: SimStateClone): void {
  c.phase = s.phase;
  captureList(s.players, c.players, makePlayer, copyPlayer);
  captureList(s.asteroids, c.asteroids, makeAsteroid, copyAsteroid);
  captureList(s.bullets, c.bullets, makeBullet, copyBullet);
  captureList(s.enemyBullets, c.enemyBullets, makeBullet, copyBullet);
  captureList(s.ufos, c.ufos, makeUfo, copyUfo);
  captureList(s.mines, c.mines, makeMine, copyMine);
  captureList(s.coins, c.coins, makeCoin, copyCoin);
  captureList(s.powerups, c.powerups, makePowerUp, copyPowerUp);
  captureList(s.pendingTransitions, c.pendingTransitions, makeTransition, copyTransition);
  c.deathmatchRules = cloneRules(s.deathmatchRules);
  c.deathmatchStartedAt = s.deathmatchStartedAt;
  c.deathmatchEndedReason = s.deathmatchEndedReason;
  c.deathmatchWinnerSlot = s.deathmatchWinnerSlot;
  // Sanctum is never present in the rollback target (deathmatch/co-op/duel);
  // a full deep clone via structuredClone keeps the foundation mode-agnostic
  // at zero hot-path cost when (as always in MP) it is undefined.
  c.sanctum = s.sanctum ? structuredClone(s.sanctum) : undefined;
  c.wave = s.wave; c.phaseStart = s.phaseStart; c.lastUpdate = s.lastUpdate; c.elapsed = s.elapsed; c.frame = s.frame;
  c.nextUfoSpawn = s.nextUfoSpawn; c.nextMineSpawn = s.nextMineSpawn; c.warpTargetWave = s.warpTargetWave;
  c.bonusStartedAt = s.bonusStartedAt; c.bonusNextSpawnAt = s.bonusNextSpawnAt; c.bonusPreludeSpawned = s.bonusPreludeSpawned;
  c.runTimeMs = s.runTimeMs; c.runStartedAt = s.runStartedAt; c.seed = s.seed; c.rng = s.rng; c.nextEntityId = s.nextEntityId;
  c.bossDefeated = s.bossDefeated; c.forgeBreached = s.forgeBreached; c.defenderMode = s.defenderMode; c.defenderTimerMs = s.defenderTimerMs; c.defenderCouncilLost = s.defenderCouncilLost;
  c.hitStopSteps = s.hitStopSteps;
  c.toast = s.toast; c.toastUntil = s.toastUntil; c.cheatedThisRun = s.cheatedThisRun; c.initialsEnteredThisRun = s.initialsEnteredThisRun;
  c.cameraTrauma = s.cameraTrauma;
  c.shieldUsedThisWave = s.shieldUsedThisWave; c.bulletsFiredThisWave = s.bulletsFiredThisWave; c.missedShotsThisWave = s.missedShotsThisWave;
  c.ufoSpawnedThisWave = s.ufoSpawnedThisWave; c.ufoKilledThisWave = s.ufoKilledThisWave; c.ufoKillsThisWave = s.ufoKillsThisWave;
  c.satRollsThisWave = s.satRollsThisWave; c.bulletCurtainKillTarget = s.bulletCurtainKillTarget; c.veinSwarmDueAt = s.veinSwarmDueAt;
  c.waveClearAt = s.waveClearAt; c.phaseEpoch = s.phaseEpoch;
}

function applyState(c: SimStateClone, s: GameState): void {
  s.phase = c.phase;
  s.players = restoreList(c.players, makePlayer, copyPlayer);
  s.asteroids = restoreList(c.asteroids, makeAsteroid, copyAsteroid);
  s.bullets = restoreList(c.bullets, makeBullet, copyBullet);
  s.enemyBullets = restoreList(c.enemyBullets, makeBullet, copyBullet);
  s.ufos = restoreList(c.ufos, makeUfo, copyUfo);
  s.mines = restoreList(c.mines, makeMine, copyMine);
  s.coins = restoreList(c.coins, makeCoin, copyCoin);
  s.powerups = restoreList(c.powerups, makePowerUp, copyPowerUp);
  s.pendingTransitions = restoreList(c.pendingTransitions, makeTransition, copyTransition);
  s.deathmatchRules = cloneRules(c.deathmatchRules);
  s.deathmatchStartedAt = c.deathmatchStartedAt;
  s.deathmatchEndedReason = c.deathmatchEndedReason;
  s.deathmatchWinnerSlot = c.deathmatchWinnerSlot;
  s.sanctum = c.sanctum ? structuredClone(c.sanctum) : undefined;
  s.wave = c.wave; s.phaseStart = c.phaseStart; s.lastUpdate = c.lastUpdate; s.elapsed = c.elapsed; s.frame = c.frame;
  s.nextUfoSpawn = c.nextUfoSpawn; s.nextMineSpawn = c.nextMineSpawn; s.warpTargetWave = c.warpTargetWave;
  s.bonusStartedAt = c.bonusStartedAt; s.bonusNextSpawnAt = c.bonusNextSpawnAt; s.bonusPreludeSpawned = c.bonusPreludeSpawned;
  s.runTimeMs = c.runTimeMs; s.runStartedAt = c.runStartedAt; s.seed = c.seed; s.rng = c.rng; s.nextEntityId = c.nextEntityId;
  s.bossDefeated = c.bossDefeated; s.forgeBreached = c.forgeBreached; s.defenderMode = c.defenderMode; s.defenderTimerMs = c.defenderTimerMs; s.defenderCouncilLost = c.defenderCouncilLost;
  s.hitStopSteps = c.hitStopSteps;
  s.toast = c.toast; s.toastUntil = c.toastUntil; s.cheatedThisRun = c.cheatedThisRun; s.initialsEnteredThisRun = c.initialsEnteredThisRun;
  s.cameraTrauma = c.cameraTrauma;
  s.shieldUsedThisWave = c.shieldUsedThisWave; s.bulletsFiredThisWave = c.bulletsFiredThisWave; s.missedShotsThisWave = c.missedShotsThisWave;
  s.ufoSpawnedThisWave = c.ufoSpawnedThisWave; s.ufoKilledThisWave = c.ufoKilledThisWave; s.ufoKillsThisWave = c.ufoKillsThisWave;
  s.satRollsThisWave = c.satRollsThisWave; s.bulletCurtainKillTarget = c.bulletCurtainKillTarget; s.veinSwarmDueAt = c.veinSwarmDueAt;
  s.waveClearAt = c.waveClearAt; s.phaseEpoch = c.phaseEpoch;
}

// ── Public snapshot/restore ──────────────────────────────────────────────────

export interface SimSnapshot {
  state: SimStateClone;
  /** seed.ts module RNG state at capture (load-bearing — see restoreSim). */
  rng: number | null;
  /** game.ts module entity-id counter at capture. */
  nextEntityId: number;
  /** game.ts non-mirrored module globals (sanctum/arena/sampling cursors). */
  mod: SimModuleState;
  /** state.frame at capture — the ring key. */
  frame: number;
}

function makeSnapshot(): SimSnapshot {
  return { state: makeClone(), rng: null, nextEntityId: 0, mod: getSimModuleState(), frame: -1 };
}

/**
 * Capture the complete simulation state. Pass `out` to reuse a snapshot's
 * pooled buffers (the allocation-light path the ring uses every frame); omit it
 * for a fresh standalone snapshot. Capture at the post-`updateGame` boundary,
 * where the GameState `rng`/`nextEntityId` mirrors already equal the module
 * globals — a snapshot of frame F then carries exactly what frame F+1 consumes.
 */
export function snapshotSim(state: GameState, out?: SimSnapshot): SimSnapshot {
  const snap = out ?? makeSnapshot();
  snap.rng = getRngState();
  snap.nextEntityId = getEntityIdCounter();
  snap.mod = getSimModuleState();
  snap.frame = state.frame;
  captureState(state, snap.state);
  // Force the stored mirrors to equal the captured module globals so a restore
  // is internally consistent even if a snapshot is ever taken mid-tick.
  snap.state.rng = snap.rng;
  snap.state.nextEntityId = snap.nextEntityId;
  return snap;
}

/**
 * Restore a snapshot into `state` in place. ORDERING IS LOAD-BEARING:
 * `gameRng()`/`nextStreamEntityId()` and the sanctum/arena spawners read the
 * MODULE globals, not the GameState mirrors. So after deep-restoring `state`
 * (which includes the mirrors), set the module globals from the snapshot — all
 * before the caller's next `updateGame`, or the first re-simmed frame draws
 * from the wrong RNG / id / spawn-cursor streams. Restore allocates fresh live
 * objects, so the snapshot stays pristine across repeated restores.
 */
export function restoreSim(state: GameState, snap: SimSnapshot): void {
  applyState(snap.state, state);
  state.rng = snap.rng;
  state.nextEntityId = snap.nextEntityId;
  setRngState(snap.rng);
  setEntityIdCounter(snap.nextEntityId);
  setSimModuleState(snap.mod);
}

// ── Snapshot ring over the rollback window ───────────────────────────────────
// Frame-keyed like InputLog: a parallel `frameOf` guard rejects a stale slot
// after the ring wraps, so `get`/`has` return only genuine matches.
export class SnapshotRing {
  readonly capacity: number;
  private snaps: (SimSnapshot | undefined)[];
  private frameOf: Int32Array;

  constructor(capacity = 16) {
    this.capacity = Math.max(1, capacity | 0);
    this.snaps = new Array(this.capacity);
    this.frameOf = new Int32Array(this.capacity).fill(-1);
  }

  private slot(frame: number): number {
    const c = this.capacity;
    return ((frame % c) + c) % c;
  }

  /** Snapshot `state` keyed by `state.frame`, reusing the slot's pooled
   *  snapshot (no steady-state allocation). Returns the stored snapshot. */
  capture(state: GameState): SimSnapshot {
    const i = this.slot(state.frame);
    let snap = this.snaps[i];
    if (!snap) { snap = makeSnapshot(); this.snaps[i] = snap; }
    snapshotSim(state, snap);
    this.frameOf[i] = state.frame;
    return snap;
  }

  has(frame: number): boolean {
    return this.frameOf[this.slot(frame)] === frame;
  }

  get(frame: number): SimSnapshot | null {
    const i = this.slot(frame);
    return this.frameOf[i] === frame ? (this.snaps[i] ?? null) : null;
  }

  /** Restore `state` from the snapshot recorded for `frame`. False if evicted. */
  restoreTo(state: GameState, frame: number): boolean {
    const snap = this.get(frame);
    if (!snap) return false;
    restoreSim(state, snap);
    return true;
  }

  newestFrame(): number {
    let best = -1;
    for (let i = 0; i < this.capacity; i++) if (this.frameOf[i] > best) best = this.frameOf[i];
    return best;
  }

  oldestFrame(): number {
    let best = -1;
    for (let i = 0; i < this.capacity; i++) {
      const f = this.frameOf[i];
      if (f >= 0 && (best === -1 || f < best)) best = f;
    }
    return best;
  }

  /** Drop all recorded frames (e.g. on session teardown / fresh run). */
  clear(): void {
    this.frameOf.fill(-1);
  }
}
