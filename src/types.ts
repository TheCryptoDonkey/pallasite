/** Game-wide types. */

import type { SignetSession } from 'signet-login';

export interface Vec2 { x: number; y: number; }

export interface Entity {
  pos: Vec2;
  vel: Vec2;
  radius: number;
  alive: boolean;
  /** Optional sequential identifier set in spawn functions for wire-
   *  bound entities (ship, asteroids, UFOs, mines, bullets). The live
   *  stream uses it to match entities across consecutive kind 22769
   *  frames so the viewer can interpolate positions smoothly rather
   *  than snap at the wire cadence. Decorative entities (coins,
   *  particles, debris) leave this undefined — they don't go on the
   *  wire. */
  id?: number;
}

export interface Ship extends Entity {
  rot: number;            // radians
  rotVel: number;
  thrusting: boolean;
  invulnerableUntil: number;  // timestamp ms
  /** Flicker phase for thrust flame */
  thrustFrame: number;
  /** Timestamp ms when hyperspace cooldown ends */
  hyperspaceReadyAt: number;
  /** If > 0, ship is mid-hyperspace and not rendered/colliding for this many ms remaining */
  hyperspaceCloakMs: number;
  /**
   * True if the malfunction roll fired at jump time. The cloak/emerge code path
   * uses this to render a *visible* glitched warp instead of silently rolling
   * the dice on emergence: red distortion particles during cloak, glitched SFX,
   * and a red implosion at the would-be reappearance. Players curse the void,
   * not the code.
   */
  hyperspaceMalfunction: boolean;
  /** Shield active right now */
  shieldUp: boolean;
  /** Timestamp ms when the active shield expires */
  shieldExpiresAt: number;
  /** Timestamp ms when the shield can be re-activated after the last burst ends */
  shieldReadyAt: number;
  /** Visual-only recoil offset in pixels — set to a small value on fire and
   *  decayed each frame. Render nudges the ship backward along its facing by
   *  this amount, giving every shot a kick. Does not affect physics or aim. */
  recoilOffset: number;
  /** Shield hit-flash 0..1. Set to 1 on any shield contact (asteroid bounce,
   *  enemy bullet block, mine touch), decays exponentially per frame. The
   *  WebGL shield mesh modulates opacity + emissive by this value so the
   *  player sees the strike land on the dome. */
  shieldHitFlash: number;
  /** Timestamp ms of the most recent successful hyperspace jump (0 = never).
   *  Drives the consecutive-warp malfunction roll: a warp within
   *  HYPERSPACE_CONSECUTIVE_WINDOW_MS of this stamp risks glitching, anything
   *  outside the window is a clean primitive movement tool. */
  lastHyperspaceAt: number;
}

export type AsteroidSize = 'large' | 'medium' | 'small';

/**
 * Asteroid mineral types. Lifted from the pallasite lore so the visual variety
 * has narrative roots:
 *   - stony     → silicate baseline (the canonical rock)
 *   - iron      → iron-nickel core fragments, denser, take two hits
 *   - chondrite → fragile primitive matter, fragments into three
 *   - pallasite → rare olivine-in-iron jackpots, big sat payouts
 */
export type AsteroidType =
  | 'stony'         // generic regolith — early waves
  | 'iron'          // Widmanstätten cross-section — armoured
  | 'chondrite'     // chondrules in matrix — common ordinary type
  | 'pallasite'     // olivine + iron — rare jackpot
  | 'carbonaceous'  // CI/CM/CV — very dark primitive, fragile
  | 'mesosiderite'  // stony-iron mix — late-wave armoured
  | 'achondrite'    // basaltic/HED — volcanic, breaks into more
  | 'kinetic'       // ricochet rock: speeds up on every cage-wall bounce (arena)
  | 'volatile'      // detonates on break, shoving nearby rocks and the ship
  | 'ballast'       // oversized, slow, very heavy: a drifting obstacle
  | 'tektite'       // impact glass: shatters into a fast spray of shards
  | 'lodestone';    // magnetic: tugs the ship toward it

/** Pointer to a 600bn council member when this asteroid is themed
 *  to a member portrait. Renderer clips the member.img inside the
 *  asteroid's lumpy outline. Preserved across breakAsteroid splits
 *  so child fragments carry the same face. */
export interface CouncilMemberRef {
  name: string;
  role: string;
  archetype: string;
  img: string;
  pubkey?: string;
  /** Pallasite asteroid mineral type this member spawns as — drives
   *  HP, break-count, sat multiplier. */
  asteroidType?: AsteroidType;
}

export interface Asteroid extends Entity {
  size: AsteroidSize;
  type: AsteroidType;
  /** Parallax depth band. 1-2 = background (behind gameplay plane,
   *  no collision, smaller + dimmer + slower). 3 = gameplay plane
   *  (default — full collision with player, bullets, and other depth-3
   *  asteroids). 4-5 = foreground (in front of gameplay, no collision,
   *  larger + dimmer + faster). Defaults to 3 for any spawn that
   *  doesn't pass an explicit depth. */
  depth: number;
  /** Optional 600bn council-member tagging — only set during the
   *  600bn Sanctum wave; main-game asteroids leave this undefined. */
  councilMember?: CouncilMemberRef;
  /** HP remaining. Drops by 1 per hit; breaks at 0. Set per type × size. */
  hp: number;
  /** Initial HP at spawn — used for milestone math (vein power-up drops at
   *  every Nth landed hit) and for HP bars where applicable. Lets a set
   *  piece override the default vein scaling without breaking the
   *  hits-landed accounting. */
  hpMax: number;
  /** Hit-flash decay 0..1 (fades over ~250ms). */
  hitFlash: number;
  rot: number;
  rotVel: number;
  /** Pre-generated lumpy outline (relative to centre, in radius units) */
  shape: number[];
  /** Random hue offset for vector colour variety */
  hue: number;
  /** Pallasite VEIN flag — a rare special pallasite that streams sats per
   *  hit (instead of dropping a single coin on break), takes VEIN_HP hits
   *  to clear, spawns oversized with a pulsing gold halo, and triggers a
   *  UFO swarm a moment after appearing. Vapourises clean on break (no
   *  fragments) with a jackpot drop. The unique Lightning-arcade moment. */
  isVein: boolean;
  /** Vein only — the radius at first hit, captured lazily so the rock can
   *  visibly shrink as its HP is chipped down (radius derives deterministically
   *  from hp/hpMax, so co-op lockstep stays bit-identical). Captured on first
   *  hit rather than at spawn so set-piece overrides (e.g. the wave-16 lode's
   *  ×1.5) are already baked in. Undefined until the vein takes its first hit. */
  veinBaseRadius?: number;
  /** Set-piece boss veins only — true if the rock hits back, spitting a shard
   *  at the firing pilot every VEIN_RETALIATE_PER_N_HITS landed hits. Set at
   *  spawn; ordinary veins (the drive-by event) leave it unset and never shoot. */
  veinRetaliates?: boolean;
  /** Permanent terrain: collides as cover but does not take damage, split,
   *  score, or count as wave-clear material. Used by deathmatch cover rocks. */
  terrain?: boolean;
  /** Mild gravity-well acceleration in px/s^2 near this asteroid. Undefined
   *  for ordinary rocks. */
  gravity?: number;
}

export interface AsteroidTypeConfig {
  /** HP at large size — medium/small drop to 1 regardless. */
  hp: number;
  /** Multiplier on SATS_PER_SIZE drop. */
  satMul: number;
  /** Multiplier on POINTS_PER_SIZE. */
  scoreMul: number;
  /** Number of children spawned when this asteroid breaks (large/medium only). */
  breakInto: number;
  /** Base CSS hue for the outline. */
  hueBase: number;
  /** Glow shadow colour. */
  glow: string;
  /** Display label for toasts. */
  label: string;
}

export const ASTEROID_TYPE_CONFIG: Record<AsteroidType, AsteroidTypeConfig> = {
  stony:        { hp: 1, satMul: 1.0, scoreMul: 1.0, breakInto: 2, hueBase: 265, glow: '#b48cff', label: 'STONY' },
  iron:         { hp: 2, satMul: 1.5, scoreMul: 1.6, breakInto: 2, hueBase: 16,  glow: '#ff7a3a', label: 'IRON' },
  chondrite:    { hp: 1, satMul: 0.6, scoreMul: 0.8, breakInto: 3, hueBase: 195, glow: '#7fbfff', label: 'CHONDRITE' },
  pallasite:    { hp: 1, satMul: 1.0, scoreMul: 2.0, breakInto: 2, hueBase: 80,  glow: '#ffd84a', label: 'PALLASITE' },
  // Primitive, dark, fragile — low HP, slight sat bonus for the rarity.
  carbonaceous: { hp: 1, satMul: 1.2, scoreMul: 1.0, breakInto: 2, hueBase: 280, glow: '#7a5aa0', label: 'CARBONACEOUS' },
  // Stony-iron mix — armoured, decent payout for the difficulty.
  mesosiderite: { hp: 2, satMul: 1.3, scoreMul: 1.5, breakInto: 2, hueBase: 30,  glow: '#c0884a', label: 'MESOSIDERITE' },
  // Basaltic/HED — volcanic origin, fragile, shatters into more fragments.
  achondrite:   { hp: 1, satMul: 0.9, scoreMul: 1.3, breakInto: 3, hueBase: 0,   glow: '#d05a3a', label: 'ACHONDRITE' },
  // Behavioural types — the gimmick lives in game.ts, not these stats.
  kinetic:      { hp: 1, satMul: 1.0, scoreMul: 1.4, breakInto: 2, hueBase: 175, glow: '#3ad6c8', label: 'KINETIC' },
  volatile:     { hp: 1, satMul: 1.1, scoreMul: 1.4, breakInto: 2, hueBase: 32,  glow: '#ff8a2a', label: 'VOLATILE' },
  ballast:      { hp: 3, satMul: 1.4, scoreMul: 1.7, breakInto: 2, hueBase: 212, glow: '#6c8cb8', label: 'BALLAST' },
  tektite:      { hp: 1, satMul: 0.8, scoreMul: 1.1, breakInto: 4, hueBase: 152, glow: '#5fe0a0', label: 'TEKTITE' },
  lodestone:    { hp: 2, satMul: 1.2, scoreMul: 1.5, breakInto: 2, hueBase: 304, glow: '#d060e0', label: 'LODESTONE' },
};

export interface Bullet extends Entity {
  ttl: number;            // ms remaining
  /** Pierce budget — how many additional asteroid breaks this bullet can
   *  survive past the first. Set to 1 in fireBullet so each shot can carom
   *  once. Decremented when a bullet survives an asteroid break. UFO bullets
   *  set this to 0 (no carom for enemies). */
  pierceLeft: number;
  /** True after this bullet has already broken at least one asteroid. The next
   *  break it causes is the CAROM hit and gets a 2× score bonus. */
  caromHit: boolean;
  /** True once this bullet has wrapped around at least one playfield edge.
   *  A wrapped bullet that lands a kill is a WRAP KILL — also a 2× bonus. */
  wrapped: boolean;
  /** True once the bullet has connected with anything (asteroid, UFO, mine).
   *  Used by the wave-end NO MISS bonus to count shots that TTL'd without
   *  ever landing a hit. */
  hasLanded: boolean;
  /** Index into GameState.players of the player who fired this bullet;
   *  -1 for UFO / enemy bullets which are never credited to a player. */
  owner: number;
  /** True for a boss-vein retaliation projectile — rendered as a spinning
   *  pallasite chunk (a shard of the rock) rather than the default fire bolt. */
  shard?: boolean;
}

export type UfoType = 'cruiser' | 'elite' | 'tank' | 'sniper' | 'boss';

export interface Ufo extends Entity {
  type: UfoType;
  /** Health remaining — only Tank has > 1 */
  hp: number;
  /** Direction of travel: 1 right, -1 left */
  dir: 1 | -1;
  /** Time until next zig-zag direction change in ms */
  zigTimer: number;
  /** Time until next shot in ms */
  shootTimer: number;
  /** Lifetime remaining in ms before despawn */
  lifetime: number;
  /** Render-frame counter for blinking lights */
  blink: number;
  /** Hit flash decay (0..1) — flashes white on damage */
  hitFlash: number;
  /** Boss-only: current phase (1, 2, or 3). Recomputed in damageUfo from HP
   *  thresholds; a change fires the phase-transition juice. Non-boss UFOs
   *  carry phase 1 trivially. */
  bossPhase: 1 | 2 | 3;
}

/** Compute the boss phase from current HP. Three thresholds across the
 *  25-HP fight: P1 = full health to 2/3, P2 = 2/3 to 1/3, P3 = final third.
 *  Kept as a free function so render code can read it consistently. */
export function bossPhaseForHp(hp: number): 1 | 2 | 3 {
  if (hp > UFO_HP_BOSS_PHASE2) return 1;
  if (hp > UFO_HP_BOSS_PHASE3) return 2;
  return 3;
}

/** Boss HP at the start of each phase (exclusive lower bound). Tuned against
 *  UFO_HP.boss = 25 so phases land roughly at 8 hits per phase. */
export const UFO_HP_BOSS_PHASE2 = 17;
export const UFO_HP_BOSS_PHASE3 = 9;

/**
 * Pickup kinds. Two-tier economy:
 *   - 'sat' — yellow ₿ coin, only drops in Nostr mode at SAT_DROP_CHANCE per
 *     break. Worth real sats. Affected by the satboost power-up.
 *   - 'dust' — green olivine shard, the bread-and-butter drop in both modes.
 *     Pure score reward, never sats. Always available so guest players still
 *     get pickup feedback after every kill.
 */
export type PickupKind = 'sat' | 'dust';

export interface Coin extends Entity {
  ttl: number;
  collected: boolean;
  kind: PickupKind;
  /** Per-pickup payload — sats for `kind:'sat'`, score-bonus points for `kind:'dust'` */
  value: number;
  /** Source asteroid type when the coin came from an asteroid break. Used by
   *  the renderer to tint dust shards (so iron rocks drop orange shards,
   *  chondrites blue, etc.) and by spawnCoins to scale score-mul. Undefined
   *  when the drop came from a mine, UFO, or other non-asteroid source. */
  sourceType?: AsteroidType;
}

/** 1-in-N chance a small asteroid (or a UFO / mine drop) yields sat coins
 *  rather than dust. Large + medium asteroid breaks no longer roll for sat
 *  at all — that gate is enforced in rollPickupKind — so smalls are the only
 *  asteroid path. Tuned so a full W25 clear accrues roughly a hundred base
 *  sats, which the server-side tier multiplier then scales down for non-
 *  verified players. The 100k/year operator budget is the binding ceiling.
 *  Bumped 8 → 14 alongside the extra-life-as-powerup change: lives are no
 *  longer free at score thresholds, and the overall sat-accrual floor was
 *  more generous than the operator budget needed it to be. */
export const SAT_DROP_CHANCE_DENOM = 14;

/** Max sat-kind drops per wave. The denom roll picks which kill in a
 *  wave qualifies; the budget keeps total run accrual close to ~25 sats
 *  for a full 25-wave clear. The first eligible drop of each wave is
 *  guaranteed to pay (rollPickupKind overrides the denom on the
 *  zeroth-roll) so the player gets visible sat feedback early in every
 *  wave — beats waiting on randomness through a whole level. */
export const WAVE_SAT_BUDGET = 1;
/** Wave 1 gets a fatter sat budget so the cold open actually delivers
 *  on the "STACK SATS" tagline. A new player should see sat coins
 *  rain in their first ~30 seconds, not trickle one-at-a-time. Tied
 *  to wave 1 specifically (not first-run-ever) so every fresh session
 *  re-hooks the player — the dopamine should hit consistently, not
 *  just the first time. Operator cost: an extra ~4 sats per run,
 *  which the existing per-run anti-cheat cap absorbs comfortably. */
export const WAVE_SAT_BUDGET_FIRST_WAVE = 5;
/** Resolve the active sat budget for the given wave. Centralised so
 *  the rollPickupKind path and any future telemetry / display surface
 *  read from the same lookup. */
export function satBudgetForWave(wave: number): number {
  return wave === 1 ? WAVE_SAT_BUDGET_FIRST_WAVE : WAVE_SAT_BUDGET;
}

/** Pallasite VEIN tuning. The event is a long engagement — the prize is
 *  fat and the fight is real. Streams sats per hit, lands a jackpot on
 *  collapse, drops helpful power-ups at regular hit milestones, and
 *  scales HP heavily by difficulty so hard-mode runs commit ~half a
 *  minute of sustained fire (still tractable with rapid + trident).
 *  Probability is rolled per wave (waves 6-24) at beginWave. */
export const VEIN_HP_BASE = 100;
export const VEIN_HP_EASY_MUL = 0.6;
export const VEIN_HP_HARD_MUL = 3.0;
export const VEIN_RADIUS_MUL = 1.4;
/** As a vein is chipped down it shrinks from its spawn radius toward this
 *  fraction at the final hit, so the megalith visibly wears to a glowing
 *  core. Kept well above zero so the hitbox stays comfortably shootable. */
export const VEIN_MIN_RADIUS_SCALE = 0.62;
/** Stationary set-piece boss veins (W16 lode, W20 eye) hit back. The retaliation
 *  is REACTIVE, not on a timer: every VEIN_RETALIATE_PER_N_HITS landed hits, the
 *  rock spits one fat shard straight at the firing pilot. So the harder you pour
 *  in fire, the more comes back — you can't just sit and grind, you have to
 *  weave the shard while chipping. A single chunky aimed shard reads far better
 *  than a constant fan. Only veins flagged veinRetaliates attack; the drive-by
 *  vein event never does. Deterministic — cadence off the landed-hit count, aim
 *  off player position, no RNG — so co-op lockstep is unaffected. */
// Cadence + speed scale with difficulty: easy gets a slow shard only every 5th
// hit (gentle nudge to move), hard gets a fast one every OTHER hit (a real
// dodge-while-you-fire dance). Keyed by string literals so types.ts needn't
// import the Difficulty type (avoids a module cycle).
export const VEIN_RETALIATE_PER_N_HITS: Record<'easy' | 'normal' | 'hard', number> = { easy: 5, normal: 3, hard: 2 };
export const VEIN_SHARD_SPEED: Record<'easy' | 'normal' | 'hard', number> = { easy: 185, normal: 230, hard: 280 };
export const VEIN_SHARD_TTL_MS = 3200;
export const VEIN_SHARD_RADIUS = 9;             // chunky — bigger hitbox + reads as a thrown rock shard
export const VEIN_SATS_PER_HIT = 0;    // score-only drip; the jackpot is the sat moment
export const VEIN_SCORE_PER_HIT = 35;
export const VEIN_JACKPOT_SATS = 4;
export const VEIN_JACKPOT_SCORE = 2500;
/** Drop a helpful power-up every N landed hits on the vein. Tuned so a
 *  normal-mode 100-HP vein gets four drops across the engagement. */
export const VEIN_POWERUP_PER_N_HITS = 25;
/** Nova chips this many HP off a vein instead of fully clearing it —
 *  vein takes a meaningful bite but isn't trivialised. */
export const VEIN_NOVA_DAMAGE = 25;
export const VEIN_SPAWN_CHANCE = 0.15;
export const VEIN_SPAWN_MIN_WAVE = 6;
export const VEIN_SPAWN_MAX_WAVE = 24;
/** ms after vein spawn before the UFO swarm arrives — player should
 *  see the vein and start engaging before the heat shows up. */
export const VEIN_SWARM_DELAY_MS = 2200;

/** Rare temporary buff or one-shot effect dropped by UFO kills.
 *  'extralife' is a one-shot pickup — collecting it grants +1 life
 *  (capped at the lives ceiling). Spawned not by UFO drops but by the
 *  score-threshold path in maybeExtraLife, so the bonus life has to
 *  be *fetched* rather than appearing on the lives counter for free. */
export type PowerUpType = 'rapid' | 'satboost' | 'nova' | 'trident' | 'magnet' | 'extralife';

export interface PowerUp extends Entity {
  type: PowerUpType;
  /** ms remaining before despawn */
  ttl: number;
  collected: boolean;
}

export interface PowerUpConfig {
  /** Duration in ms a buff stays active (0 for instant effects like bomb). */
  durationMs: number;
  /** Glyph rendered on the pickup. */
  glyph: string;
  /** Body colour. */
  colour: string;
  /** Toast on pickup. */
  pickupLabel: string;
}

export const POWERUP_CONFIG: Record<PowerUpType, PowerUpConfig> = {
  rapid:     { durationMs: 8000,  glyph: '⚡', colour: '#ff8a3a', pickupLabel: 'RAPID FIRE' },
  satboost:  { durationMs: 12000, glyph: '₿', colour: '#ffd84a', pickupLabel: '×2 SATS' },
  nova:      { durationMs: 0,     glyph: '◉', colour: '#ff5050', pickupLabel: 'NOVA' },
  trident:   { durationMs: 6000,  glyph: '⋔', colour: '#ffd84a', pickupLabel: 'TRIDENT' },
  magnet:    { durationMs: 8000,  glyph: '◎', colour: '#5b9dff', pickupLabel: 'MAGNET' },
  extralife: { durationMs: 0,     glyph: '♥', colour: '#58ff58', pickupLabel: '1UP' },
};

/** Drop chance per non-boss UFO kill. */
export const POWERUP_DROP_CHANCE = 0.30;
/** TTL for an uncollected power-up on the field. */
export const POWERUP_TTL_MS = 14_000;
export const POWERUP_RADIUS = 14;
/** Multiplier on FIRE_COOLDOWN_MS while rapid is active (lower = faster). */
export const RAPID_COOLDOWN_MUL = 0.34;
/** Multiplier on coin sat value while satboost is active. Trimmed from 2×
 *  to 1.5× so the powerup is still a real bump but can't 2× the run cap. */
export const SATBOOST_MUL = 1.5;
/** Trident fan: half-angle of the spread (radians). Outer bullets fire at
 *  ±TRIDENT_SPREAD from the ship's facing; centre bullet stays on heading. */
export const TRIDENT_SPREAD = 0.18;
/** Magnet pull: max acceleration applied to coins (px/s²) when at MAGNET_RANGE. */
export const MAGNET_MAX_ACCEL = 1400;
/** Magnet effective range — coins within this radius accelerate toward the ship. */
export const MAGNET_RANGE = 9999;  // effectively whole screen

/** Stationary gravity mine — pulls the ship in, kills on contact unless shielded. */
export interface Mine extends Entity {
  /** ms since spawn — used for animation pulse */
  age: number;
  /** Gravity well effective range in px */
  gravityRange: number;
  /** Hits to destroy. Set per spawn — see MINE_HP_BASE / wave scaling. */
  hp: number;
  /** Hit-flash decay 0..1 */
  hitFlash: number;
}

/** Base mine HP — bumped from 1 so they take a small flurry to clear. */
export const MINE_HP_BASE = 3;

export interface Particle {
  pos: Vec2;
  vel: Vec2;
  ttl: number;
  maxTtl: number;
  colour: string;
  size: number;
}

/** Line-segment debris — used for the ship explosion to recreate the
 *  iconic 1979 Asteroids "ship splits into bits" effect. Each piece tumbles
 *  outward, fades over its TTL, and wraps around the playfield. */
export interface Debris {
  pos: Vec2;
  vel: Vec2;
  /** Current orientation in radians */
  rot: number;
  rotVel: number;
  /** Visual length in px (line drawn from -length/2 to +length/2 along local x axis) */
  length: number;
  ttl: number;
  maxTtl: number;
  colour: string;
}

export type GamePhase = 'title' | 'playing' | 'paused' | 'gameover' | 'wavestart' | 'warp' | 'bonus' | 'completed' | 'deathreplay' | 'sanctum';

/** Snapshot of motion-relevant state, captured at ~30Hz during play and used
 *  to drive the death replay. Reuses the live entity types so the existing
 *  draw functions work unchanged on snapshot data. Particles / coins /
 *  power-ups / shield / hyperspace cloak are intentionally omitted — they
 *  don't change the answer to "what killed me?". */
export interface ReplaySnapshot {
  t: number;
  ship: { pos: Vec2; rot: number; alive: boolean; thrusting: boolean };
  asteroids: Asteroid[];
  ufos: Ufo[];
  bullets: Bullet[];
  enemyBullets: Bullet[];
  mines: Mine[];
}

export interface DeathReplay {
  snapshots: ReplaySnapshot[];
  /** Sim-clock ms at the moment playback (re-)started. */
  startedAt: number;
  /** Captured game-time span, ms — last sample.t minus first sample.t.
   *  This is the SNAPSHOT span; the actual playback runs an additional
   *  REPLAY_EXPLOSION_MS past this to render the death explosion. */
  spanMs: number;
  /** Where the ship exploded — explosion centre for the post-buffer
   *  re-spawn. Captured in killShip from the ship's last position. */
  explosionAt: Vec2;
  /** Ship snapshot at the moment of death — replays use this to re-spawn
   *  the same particle burst + line-segment debris that killShip emitted
   *  during live play, so the cinematic matches exactly. */
  explosionShip: { pos: Vec2; vel: Vec2; rot: number };
  /** Guard so the impact-frame spawn fires once per replay loop. */
  explosionSpawned: boolean;
}

/** Type-only forward import so GameState can carry the Sanctum state
 *  with proper typing while staying tree-shake-clean. `import type` is
 *  erased at build time so the main bundle never pulls in sanctum.ts
 *  unless code actually references its runtime symbols (which only
 *  happens when getFlavour() === '600bn'). */
import type { SanctumState } from './sanctum.js';

/** Kinds of deferred sim transition — the deterministic replacement for
 *  the wall-clock setTimeout deferrals that used to live in game.ts. Each
 *  is scheduled against the sim clock so both lockstep clients and the B3
 *  verifier fire it on the identical sim frame. */
export type SimTransitionKind =
  | 'wave-reveal'        // beginWave: wave-name chime + toast
  | 'wave-begin-play'    // beginWave: wavestart/warp -> playing
  | 'warp-begin-wave'    // startWarp: warp -> beginWave(target)
  | 'bonus-end'          // startBonus: bonus -> clear + warp to wave 10
  | 'hyperspace-emerge'  // tryHyperspace: re-emerge from cloak
  | 'respawn'            // killShip / hyperspace breach: respawn the ship
  | 'deathreplay-end';   // startDeathReplay: deathreplay -> gameover

/** A pending deferred sim transition. Plain data (no closures) so
 *  GameState stays snapshot- and replay-safe. */
export interface SimTransition {
  kind: SimTransitionKind;
  /** Absolute s.elapsed (sim-clock ms) at or after which it fires. */
  due: number;
  /** s.phaseEpoch captured when scheduled; epoch-gated handlers no-op if
   *  superseded. 0 when the handler does not gate on epoch. */
  epoch: number;
  /** Kind-specific payload: wave number, warp target wave, or the respawn
   *  max-wait deadline. 0 when unused. */
  arg: number;
  /** Index into GameState.players of the player this transition affects, for
   *  per-player kinds (respawn, hyperspace-emerge). -1 for transitions that
   *  are not player-bound. */
  playerIdx: number;
}

/** Per-player gameplay state. `GameState.players` holds one of these per
 *  ship. Length 1 is every solo mode and stays byte-identical to the
 *  pre-split single-ship game; length 2 is shared-arena multiplayer. */
export interface PlayerState {
  ship: Ship;
  /** Heading-mode joystick target angle (radians); null = keyboard L/R. */
  targetHeading: number | null;
  /** Heading-mode joystick analog-thrust override. */
  thrustOverride: boolean;
  /** Resolved input key state for this player. */
  keys: Record<string, boolean>;
  /** Prototype local bot control. Used by deathmatch until network slots
   *  become dynamic; human/local players leave this unset. */
  ai?: boolean;

  score: number;
  /** Deathmatch-only round stats. Kept zero in campaign/arena. */
  deathmatchKills: number;
  deathmatchDeaths: number;
  deathmatchStreak: number;
  /** In-game sats counter (mirrors backend credit). Multiplayer never pays out. */
  sats: number;
  /** HUD counter easing toward `sats`. */
  displaySats: number;
  lives: number;
  /** Bonus lives earned via score thresholds (1 per 10,000), tracked apart
   *  from `lives` so lost lives don't regenerate. */
  bonusLivesGranted: number;

  /** Active kill-chain length (0 when not chained). Caps at COMBO_MAX. */
  combo: number;
  /** Sim-clock ms the combo window closes. */
  comboExpiresAt: number;

  /** Sim-clock ms each buff expires (0 = inactive). */
  rapidExpiresAt: number;
  satboostExpiresAt: number;
  tridentExpiresAt: number;
  magnetExpiresAt: number;
  /** Sim-clock ms the gun is next free to fire. */
  fireCooldownUntil: number;

  /** True while parked in the centre dead-zone — the 1979 lurk exploit;
   *  coins credit no sats while set. */
  lurking: boolean;
  /** Sim-clock ms the current lurk streak began; 0 when not lurking. */
  lurkingSince: number;
  /** Total sats withheld this run while lurking. */
  lurkSatsBlocked: number;
  /** Whether the lurk easter-egg toast has fired this run. */
  lurkEverDetected: boolean;

  /** Per-run telemetry for the gameover / completion stat grid. */
  runStats: RunStats;
}

export interface DeathmatchFeedEntry {
  /** Sim-clock ms when the event occurred. */
  t: number;
  attackerSlot: number | null;
  victimSlot: number;
  points: number;
  streak: number;
}

export type DeathmatchMode = 'ffa';

export type DeathmatchEndReason = 'time-limit' | 'kill-limit' | 'last-player-standing';

export interface DeathmatchRules {
  mode: DeathmatchMode;
  /** Sim-clock duration cap. 0 disables the time limit. */
  timeLimitMs: number;
  /** Kills required by one pilot to end the round. 0 disables the kill cap. */
  killLimit: number;
  /** Extra ships after the current hull is destroyed. 0 makes it one-life elimination. */
  respawns: number;
  /** Bot tuning multiplier. Human network slots ignore this. */
  aiSkill: number;
}

export interface GameState {
  phase: GamePhase;
  /** One PlayerState per ship. Length 1 is every solo mode (byte-identical
   *  to the pre-split single-ship game); length 2 is shared-arena
   *  multiplayer. */
  players: PlayerState[];
  asteroids: Asteroid[];
  bullets: Bullet[];
  enemyBullets: Bullet[];
  ufos: Ufo[];
  mines: Mine[];
  coins: Coin[];
  powerups: PowerUp[];
  particles: Particle[];
  debris: Debris[];
  /** Recent deathmatch kill/death events for the HUD kill feed. */
  deathmatchFeed: DeathmatchFeedEntry[];
  /** Deathmatch round rules/result metadata. Null outside deathmatch. */
  deathmatchRules: DeathmatchRules | null;
  deathmatchStartedAt: number;
  deathmatchEndedReason: DeathmatchEndReason | null;
  deathmatchWinnerSlot: number | null;

  wave: number;

  /** ms timestamp this phase started */
  phaseStart: number;
  /** ms timestamp last update */
  lastUpdate: number;
  /** total elapsed playtime ms — the sim clock; advances by a fixed step
   *  each tick, so it doubles as the deterministic time base for deadlines. */
  elapsed: number;
  /** fixed sim step counter, +1 each updateGame tick. The canonical step
   *  index for deterministic re-simulation and the B3 input log. */
  frame: number;

  /** ms until next UFO spawn */
  nextUfoSpawn: number;
  /** ms until next mine spawn check */
  nextMineSpawn: number;

  /** During warp, the wave number we're heading to (so the banner reads correctly under cheat-jumps too). */
  warpTargetWave: number;

  /** BONUS phase (W9 → W10 detour) — wall-clock ms when the bonus
   *  began so the renderer can show a countdown + tickBonus knows
   *  when to flip from HYPER BLITZ into EVENT HORIZON PRELUDE. */
  bonusStartedAt: number;
  /** Wall-clock ms of the next scheduled in-bonus spawn refill. */
  bonusNextSpawnAt: number;
  /** Count of pallasite mini-bosses already spawned in the bonus
   *  prelude window. Caps at 5. */
  bonusPreludeSpawned: number;

  /** 600bn Sanctum state (when phase === 'sanctum'). Undefined on the
   *  'main' flavour and during any non-sanctum phase. */
  sanctum?: SanctumState;

  /** Total run time in ms (excluding pauses) — for completion screen */
  runTimeMs: number;
  /** Wall-clock ms when the current run started (Date.now() in startGame).
   *  Survives phase changes — `phaseStart` resets between phases, this does
   *  not. Used as the `started_at` field on faucet claim submissions. 0 when
   *  no run is in flight. */
  runStartedAt: number;
  /** 32-bit RNG seed for this run. Set by seedRun() in startGame; recorded
   *  so the run can be deterministically re-simulated (B3 verifiable
   *  replay). 0 before the first run. */
  seed: number;
  /** Snapshot of seed.ts's module rngState taken at the END of every
   *  updateGame tick (and every other sim entry point). The module
   *  global stays the live value during a tick; this mirror lets the
   *  desync canary serialise the RNG state as part of `state` rather
   *  than reaching across files into a global. Null when daily mode
   *  is off (gameRng falls through to Math.random). */
  rng: number | null;
  /** Snapshot of game.ts's module nextEntityId taken at the END of
   *  every updateGame tick. Same shape as `rng` — a per-state mirror
   *  so canary / replay code reads from `state` rather than a module
   *  global. Wraps at 1_000_000 to keep JSON tuples compact for long
   *  runs. */
  nextEntityId: number;
  /** Wave 25 boss state */
  bossDefeated: boolean;

  /** 600bn Defender bonus wave (`?defender=1`). When true, council
   *  asteroids drift through the wide arena as defendees and the
   *  win condition is "protect N of them for T seconds" rather than
   *  the standard "clear the wave". Set by startGame's `defender`
   *  opt. */
  defenderMode: boolean;
  /** ms until the defender win-check fires (when defenderMode = true).
   *  Initialised in startGame; counts DOWN each tick. Win when it
   *  reaches 0 with at least DEFENDER_WIN_THRESHOLD council alive;
   *  lose when council count hits 0 before then. */
  defenderTimerMs: number;
  /** Defender-mode council kill counter. Goes up every time a council
   *  asteroid is destroyed by an enemy (UFO bullet, UFO collision,
   *  mine). Player bullets count as "friendly fire" — they DO kill
   *  the council, just at a steep score penalty. */
  defenderCouncilLost: number;

  /** Number of fixed sim steps still to skip for a hit-stop freeze (0 when
   *  not frozen). Set on milestone moments to give a punch a frame of
   *  weight; the loop skips updateGame while this is positive. */
  hitStopSteps: number;

  /** Deferred sim transitions pending against the sim clock — the
   *  deterministic replacement for wall-clock setTimeout deferrals.
   *  Drained each step in updateGame. */
  pendingTransitions: SimTransition[];

  /** auth state */
  session: SignetSession | null;
  /** Resolved kind-0 profile for the active session (or null if not yet fetched) */
  profile: import('./profile.js').NostrProfile | null;

  /** transient toast text */
  toast: string | null;
  toastUntil: number;

  /** Set true the first time a cheat is used in a run. Permanent for the run.
   *  Side effects: sats are voided to 0, the HUD chip flags it openly, and
   *  any kind 30762 score publish carries a `["cheated", "true"]` tag so the
   *  leaderboard can show or filter accordingly. Honest runs are unaffected. */
  cheatedThisRun: boolean;

  /** Ring buffer of recent gameplay snapshots. Capped at REPLAY_BUFFER_FRAMES. */
  replayBuffer: ReplaySnapshot[];
  /** Set by killShip on the final death; cleared by startGame. Lives across
   *  the gameover screen so the REPLAY button can re-trigger playback. */
  deathReplay: DeathReplay | null;
  /** True once the player has submitted initials for this run's high score
   *  entry. Guards against re-prompting the initials widget after a REPLAY
   *  KILL click flips phase back through 'gameover'. Cleared on startGame. */
  initialsEnteredThisRun: boolean;

  /** 1Hz score-pacing samples for the kind 30763 v1 ghost replay. Pushed
   *  by the game loop while phase==='playing'; finalised on game-over /
   *  completion and shipped to relays via publishGhost. */
  ghostSamples: GhostSample[];

  /** 4Hz pose samples for the kind 30763 v2 ghost — only captured when a
   *  daily seed is active (so the published overlay genuinely matches the
   *  same RNG sequence the watching player will see). Empty in non-daily
   *  runs to keep payload size small. */
  ghostPoseSamples: GhostPoseSample[];

  /** Accumulated screen-shake "trauma", clamped 0..1. Bumped by impact events
   *  (hull breach, large asteroid break, mine destroyed, shield ignite, boss
   *  hit), decays exponentially per frame. Render layer reads trauma², which
   *  gives a quadratic feel: small jolts barely shake, big hits punch. The
   *  reduced-motion preference zeroes out the visual at the render call. */
  cameraTrauma: number;

  /** Per-wave bookkeeping reset on every beginWave, used by the wave-clear
   *  bonus pass to award NO SHIELD / NO MISS / PACIFIST UFO chips. None of
   *  these affect mid-wave behaviour. */
  shieldUsedThisWave: boolean;
  bulletsFiredThisWave: number;
  missedShotsThisWave: number;
  ufoSpawnedThisWave: boolean;
  ufoKilledThisWave: boolean;

  /** Per-wave UFO kill counter, used by set-piece waves whose clear
   *  condition is "kill N UFOs" rather than "clear the asteroids". */
  ufoKillsThisWave: number;

  /** Per-wave sat-budget counter — how many sat-kind drops have already
   *  rolled this wave. rollPickupKind caps subsequent rolls at
   *  WAVE_SAT_BUDGET so a full 25-wave run lands in the right ballpark
   *  (the operator budget is the binding ceiling). Reset to 0 in
   *  beginWave. The vein jackpot bypasses this counter — it credits
   *  p.sats directly via the jackpot path, not via rollPickupKind. */
  satRollsThisWave: number;

  /** Active target kill count for the bullet-curtain set-piece (wave 12).
   *  0 when not on a curtain wave. */
  bulletCurtainKillTarget: number;

  /** Timestamp (performance.now() ms) at which the vein's UFO swarm should
   *  arrive. 0 when no swarm is pending. Set by spawnVein; consumed in
   *  updateGame the moment the timer elapses. */
  veinSwarmDueAt: number;

  /** Transient expanding-ring effects spawned by big shatters (large breaks,
   *  vein collapse). Purely visual — rendered as a stroked circle that grows
   *  and fades over ~380ms. Self-pruning in render. */
  shockwaveRings: Shockwave[];

  /** Transient hyperspace cinematic effects — a collapse spawned at the
   *  departure point on warp trigger, and an emerge spawned at the new
   *  position when the cloak ends. Self-pruning in render. */
  hyperspaceEffects: HyperspaceEffect[];

  /** performance.now() when the current wave was cleared, or null. While
   *  non-null the player is in the grab-everything grace window: ship
   *  invulnerable, countdown on screen. Never set when the field has no
   *  loose coins / power-ups, or the run is cheated. */
  waveClearAt: number | null;
  /** Monotonic transition token. Bumped by every wave-progression change
   *  (warp, wavestart, bonus, completion). Pending setTimeout-driven
   *  transitions capture it and no-op if a newer transition has superseded
   *  them — kills stale-timer races when the player cheat-warps. */
  phaseEpoch: number;
}

/** A single hyperspace cinematic ring (collapse on departure, emerge on
 *  re-entry). Drawn in 2D so it works across vector/shaded/mesh tiers. */
export interface HyperspaceEffect {
  x: number;
  y: number;
  /** performance.now() at spawn. */
  startMs: number;
  /** 'collapse' = spiral inward (departure), 'emerge' = ring outward (arrival). */
  kind: 'collapse' | 'emerge';
  /** True if this warp glitched — render in red instead of cyan. */
  malfunction: boolean;
}

/** Single radial shockwave ring. Wall-clock-driven so the visual lands even
 *  if the simulation is paused immediately after the kill. */
export interface Shockwave {
  x: number;
  y: number;
  /** performance.now() at spawn. */
  startMs: number;
  /** Stroke colour — typically the asteroid type's accent glow. */
  color: string;
  /** Radius at spawn — the ring grows from here to ~3.2× this over its life. */
  baseRadius: number;
}

/** A single (t, score) pacing point. t is ms since startGame. */
export interface GhostSample {
  t: number;
  score: number;
}

/** A single 4Hz pose-bearing sample for the daily-mode ghost overlay.
 *  Coordinates are world-space; flags bit 0 = alive, bit 1 = thrusting. */
export interface GhostPoseSample {
  t: number;
  score: number;
  x: number;
  y: number;
  rot: number;
  flags: number;
}

/** Per-run telemetry surfaced on the gameover / completion stat grid. */
export interface RunStats {
  /** UFO kills broken down by type — lets the recap brag about boss/elite kills. */
  ufoKills: Record<UfoType, number>;
  /** Gravity mines destroyed by player bullets (shield contact doesn't count). */
  minesDestroyed: number;
  /** Largest active combo length reached this run. */
  largestCombo: number;
  /** Powerups collected (any type — drilling further is future work). */
  powerupsCollected: number;
  /** Pallasite veins fully collapsed (jackpot triggered). Used by the
   *  share-text emoji recap. */
  veinsBroken: number;
  /** Total asteroids broken across the run (any size, any type). Feeds
   *  the score/kill outlier fingerprinter — score-per-kill in plausible
   *  range is one of the cheapest cheat signals to read. */
  asteroidsBroken: number;
  /** Cumulative bullets fired (player shots only — UFO bullets excluded). */
  bulletsFired: number;
  /** Cumulative bullets that expired without ever connecting to anything.
   *  Used with bulletsFired to compute hit ratio for the heuristic flagger. */
  bulletsMissed: number;
  /** Times the player invoked hyperspace (regardless of whether it detonated
   *  a nearby mine). Capped behaviour at sane rates is a cheat signal. */
  hyperspacesUsed: number;
  /** Lives lost across the run. Sanity-check against duration/wave —
   *  perfect-life runs at high waves are rare but possible; flat zero
   *  combined with impossible hit ratios is the real tell. */
  livesLost: number;
}

export const EMPTY_RUN_STATS: RunStats = {
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

/** Lurking easter egg — see GameState.lurking. Detection: ship within
 *  LURK_CENTRE_RADIUS_PX of dead centre AND speed below LURK_VEL_THRESHOLD.
 *  Two thresholds: at LURK_DURATION_MS the mechanical effects kick in (sats
 *  blocked, asteroid avoidance, UFO bullet immunity); at LURK_TOAST_MS the
 *  one-time easter-egg confirmation message fires. The longer toast threshold
 *  gates the explicit reveal behind a deliberate commitment, so it lands as
 *  discovery rather than a hair-trigger explainer. */
export const LURK_CENTRE_RADIUS_PX = 90;
export const LURK_VEL_THRESHOLD = 25;
export const LURK_DURATION_MS = 4000;
export const LURK_TOAST_MS = 12000;

/** Replay tuning. Total wall-clock duration is REPLAY_FAST_MS + REPLAY_SLOW_MS / SLOW_RATE. */
export const REPLAY_RECORD_INTERVAL_MS = 33;       // ~30Hz
export const REPLAY_DURATION_MS = 2000;            // captured span
export const REPLAY_BUFFER_FRAMES = Math.ceil(REPLAY_DURATION_MS / REPLAY_RECORD_INTERVAL_MS) + 4;
export const REPLAY_FAST_MS = 1500;                // first slice plays at 1.0x
export const REPLAY_SLOW_MS = 500;                 // last 0.5s of game-time...
export const REPLAY_SLOW_RATE = 0.4;               // ...stretched to 1.25s of wall-time
export const REPLAY_TOTAL_WALL_MS = REPLAY_FAST_MS + Math.round(REPLAY_SLOW_MS / REPLAY_SLOW_RATE);
/** Extra game-time tail past the captured buffer where a synthetic explosion
 *  blooms at the ship's last position. Plays at the slow-mo rate so it lingers. */
export const REPLAY_EXPLOSION_MS = 500;
export const REPLAY_EXPLOSION_WALL_MS = Math.round(REPLAY_EXPLOSION_MS / REPLAY_SLOW_RATE);

/** Fixed 16:9 sim world. Display modes scale a *view* of this; the sim
 *  itself never reads the viewport, so one recording verifies in any
 *  display mode (the B3 determinism invariant). */
export const WORLD_W = 1280;
export const WORLD_H = 720;

/** Grab-everything grace window after a wave is cleared, before the warp.
 *  Lets the player scoop loose coins / power-ups; ship is invulnerable for
 *  the duration. Skipped when there's nothing to grab or the run is cheated. */
export const WAVE_CLEAR_GRACE_MS = 5000;

/** Inter-wave warp transition duration. Drives the visual envelope in render
 *  (drawWarp uses elapsed/WARP_MS) and the setTimeout in startWarp that calls
 *  beginWave. 6s is short enough to not be punishing on repeat runs, long
 *  enough for the cutscene's tunnel→approach→arrive arc to read clearly.
 *  Skippable from WARP_SKIP_AFTER_MS onward. */
export const WARP_MS = 6000;
/** Earliest tap/key after warp begins that can skip the rest of the transition. */
export const WARP_SKIP_AFTER_MS = 1000;

export const SHIP_RADIUS = 12;
export const SHIP_THRUST = 240;       // px/s²
export const SHIP_DRAG = 0.4;         // multiplicative damping per second
export const SHIP_ROT_ACCEL = 8;      // rad/s² when key held
export const SHIP_ROT_DAMPING = 6;    // rad/s² counter
export const SHIP_MAX_ROT = 4;        // rad/s
export const SHIP_INVULN_MS = 2200;
export const FIRE_COOLDOWN_MS = 220;
export const HYPERSPACE_COOLDOWN_MS = 600;
export const HYPERSPACE_CLOAK_MS = 350;
/** Probability of hyperspace malfunction (instant death) on a CONSECUTIVE warp
 *  — i.e. a warp triggered within HYPERSPACE_CONSECUTIVE_WINDOW_MS of the last
 *  one. Standalone warps are 0% risk. Classic Asteroids rolled this on every
 *  warp; Pallasite reframes warp as a movement primitive that punishes only
 *  panic-spam. */
export const HYPERSPACE_MALFUNCTION_CHANCE = 0.25;
/** Window after a successful warp during which the next warp counts as
 *  consecutive and rolls a malfunction. Outside this window, warp is safe. */
export const HYPERSPACE_CONSECUTIVE_WINDOW_MS = 3000;
/** A successful warp detonates any mines within this radius of the departure
 *  position. Slightly less than MINE_GRAVITY_RANGE so the player has to
 *  actually be inside the mine's pull to clear it — warping anywhere on the
 *  field shouldn't sweep the arena clean. */
export const HYPERSPACE_DETONATE_RANGE = 90;
/** Min distance from any asteroid/UFO when re-emerging. */
export const HYPERSPACE_SAFE_DIST = 60;
/** Window in ms within which a second ↓ press counts as a double-tap → hyperspace. */
export const DOWN_DOUBLE_TAP_WINDOW_MS = 320;
/** Shield active duration. */
export const SHIELD_DURATION_MS = 1500;
/** Cooldown after a shield burst ends before it can re-activate. */
export const SHIELD_COOLDOWN_MS = 3000;

export const BULLET_SPEED = 520;      // px/s
export const BULLET_TTL_MS = 1000;
export const BULLET_RADIUS = 2;

export const ASTEROID_BASE_SPEED = 60;    // px/s base
/** Per-wave additive speed bump for asteroids (Normal baseline). Easier curve than before. */
export const ASTEROID_SPEED_PER_WAVE = 5;

export const COIN_RADIUS = 9;
export const COIN_TTL_MS = 8000;

export const POINTS_PER_SIZE: Record<AsteroidSize, number> = {
  large: 20,
  medium: 50,
  small: 100,
};

/** Sat-coin base value per asteroid size. Large and medium drop zero — the
 *  player has to follow the chain through to smalls to earn sats. This keeps
 *  rewards visible (lots of small drops) without ballooning the total: the
 *  server-side anti-cheat cap is `sqrt(score) × tier_multiplier`, so client
 *  accrual ≫ that just evaporates at claim. Smalls dropping 1 sat (scaled
 *  by type satMul + trick-shot bonusMul) lands a typical full-clear run in
 *  ~1500-2000 base sats, within the verified-tier cap for a strong score. */
export const SATS_PER_SIZE: Record<AsteroidSize, number> = {
  large: 0,
  medium: 0,
  small: 1,
};

export const RADIUS_PER_SIZE: Record<AsteroidSize, number> = {
  large: 48,
  medium: 26,
  small: 14,
};

/**
 * Per-wave specimen lore. Wave 1-24 are real pallasite finds; the subtitle is
 * shown on the wave-clear banner so each wave teaches a fragment of meteorite
 * history along with the play. Single source of truth — credits roll on the
 * completion screen reads from this table too.
 *
 * Wave 25 (EVENT HORIZON) is the boss arena, no real-world referent.
 */
export interface WaveLore {
  /** Display name shown big on the banner */
  name: string;
  /** One-line lore subtitle shown beneath the name */
  subtitle: string;
  /**
   * Brand-voice tactical tagline shown below the subtitle on the wavestart
   * banner. Punchy verb-noun pair that hints at this wave's danger or play
   * tip (UFO debut, mine count, mineral shift, chain advice). The factual
   * subtitle teaches meteorite history; the tagline teaches the wave.
   */
  tagline: string;
}

export const WAVE_LORE: readonly WaveLore[] = [
  // Verified against the Meteoritical Bulletin Database + Wikipedia, 2026-05-09
  { name: 'KRASNOJARSK',     subtitle: 'Russia, 1749 — first pallasite ever found',         tagline: 'Drift. Fire. Wrap.' },
  { name: 'BRENHAM',         subtitle: 'Kansas, 1882 — over 4 tonnes recovered',            tagline: 'Tighter orbits.' },
  { name: 'ESQUEL',          subtitle: 'Argentina, 1951 — gem-grade peridot',               tagline: 'Hold the centre.' },
  { name: 'FUKANG',          subtitle: 'Xinjiang, 2000 — 1,003 kg main mass',               tagline: 'Elites incoming. Mass attracts.' },
  { name: 'IMILAC',          subtitle: 'Atacama, Chile, 1822 — ~1 tonne strewn field',      tagline: 'Pallasite banks sats. Hunt the gold.' },
  { name: 'MINEO',           subtitle: 'Sicily, 1826 — observed fall',                      tagline: 'Iron takes two. Aim true.' },
  { name: 'ZAISHO',          subtitle: 'Japan, 1898 — observed fall, just 330 g',           tagline: 'Tanks roll. Three hits each.' },
  { name: 'MARJALAHTI',      subtitle: 'Finland, 1902 — observed fall, 45 kg',              tagline: 'Mines arm. Mind the well.' },
  { name: 'OMOLON',          subtitle: 'Russia, 1981 — largest observed pallasite fall',    tagline: 'Breather. Bank the chain.' },
  { name: 'SPRINGWATER',     subtitle: 'Saskatchewan, 1931 — type locality of farringtonite', tagline: 'Snipers calibrate. Keep moving.' },
  { name: 'GLORIETA MTN',    subtitle: 'New Mexico, 1884 — variable olivine content',       tagline: 'Two wells. Plot a clean line.' },
  { name: 'SEYMCHAN',        subtitle: 'Russia, 1967 — reclassified iron to pallasite',     tagline: 'Reclassified threats. Re-read the field.' },
  { name: 'ALBIN',           subtitle: 'Wyoming, 1915 — clear olivine to 38 mm',            tagline: 'Three wells. Edges open.' },
  { name: 'BRAHIN',          subtitle: 'Belarus, 1810 — over 1 tonne recovered',            tagline: 'Tanks anchor. Strip them down.' },
  { name: 'AHUMADA',         subtitle: 'Chihuahua, Mexico, 1909 — 53 kg main mass',         tagline: 'Conserve the chain.' },
  { name: 'ITZAWISIS',       subtitle: 'Namibia, 1946 — Eagle Station group, 350 g',        tagline: 'Pallasite seam. Press it.' },
  { name: 'EAGLE STATION',   subtitle: 'Kentucky, 1880 — type specimen of its group',       tagline: 'Past halfway. Lanes thin.' },
  { name: 'NEWPORT',         subtitle: 'Arkansas, 1923 — only stony-iron of the state',     tagline: 'Four wells. Lanes tighten.' },
  { name: 'OTINAPA',         subtitle: 'Durango, Mexico — main group pallasite',            tagline: 'Snipers brake on you. Brake first.' },
  { name: 'CONCEPTION JCT',  subtitle: 'Missouri, 2006 — anomalous main group, 17 kg',      tagline: 'Five wells. Chain hard.' },
  { name: 'QUIJINGUE',       subtitle: 'Bahia, Brazil, 1984 — first Brazilian pallasite',   tagline: 'Anomalous run. Stay sharp.' },
  { name: 'PHILLIPS COUNTY', subtitle: 'Colorado, 1935 — anomalous main group',             tagline: 'Trust no orbit.' },
  { name: 'ADMIRE',          subtitle: 'Kansas, 1881 — strewn field, ~2 tonnes total',      tagline: 'Six wells. Two tonnes of grief.' },
  { name: 'HAMBLETON',       subtitle: 'North Yorkshire, 2005 — sulphide-rich',             tagline: 'Last orbit before the horizon.' },
  { name: 'EVENT HORIZON',   subtitle: 'The final arena · no return',                       tagline: 'Stand or fall.' },
];

/** Lookup the lore subtitle for a wave (1-indexed). Null for waves outside the table. */
export function waveSubtitle(wave: number): string | null {
  return WAVE_LORE[wave - 1]?.subtitle ?? null;
}

/** Lookup the brand-voice tactical tagline for a wave (1-indexed). Null for waves outside the table. */
export function waveTagline(wave: number): string | null {
  return WAVE_LORE[wave - 1]?.tagline ?? null;
}

/**
 * Signature-moment banner titles. The hand-authored set-piece waves
 * (see WAVE_SET_PIECES in game.ts) get a punchy gold wordmark in place of
 * the plain "WAVE N" headline, so the campaign's tentpole beats read as
 * events rather than just another wave. Keyed by wave number; waves absent
 * from this map fall back to the standard banner. The title lives here in
 * types — not on the set-piece itself — so the renderer can read it without
 * importing the gameplay module (which would form an import cycle).
 */
export const WAVE_SET_PIECE_BANNERS: Readonly<Record<number, string>> = {
  5: 'PALLASITE HEIST',
  8: 'THE GAUNTLET',
  9: 'GOLD RUSH',
  12: 'BULLET CURTAIN',
  16: 'MOTHER LODE',
  20: 'THE MAELSTROM',
  24: 'THE APPROACH',
};

/** The signature-moment banner title for a wave, or null for a standard wave. */
export function waveSetPieceBanner(wave: number): string | null {
  return WAVE_SET_PIECE_BANNERS[wave] ?? null;
}

/** Convenience: just the names, derived from WAVE_LORE so the two stay in lock-step. */
export const WAVE_NAMES: readonly string[] = WAVE_LORE.map(w => w.name);

/** Total number of survival waves before completion. */
export const FINAL_WAVE = 25;

/** Get the lore name for a given wave number (1-indexed). Falls back to "WAVE N" beyond the table. */
export function waveName(wave: number): string {
  return WAVE_NAMES[wave - 1] ?? `WAVE ${wave}`;
}

// ── Story arc — three acts over the 25 waves ────────────────────────────────
// Connective tissue for the wave lore: the meteorite specimens are waypoints
// on a hero quest, not a museum catalogue. See docs/pallasite-arc.md.

/** Which act a campaign wave belongs to. The boss arena (wave 25) is its own beat. */
export function waveAct(wave: number): 1 | 2 | 3 | 'boss' {
  if (wave >= FINAL_WAVE) return 'boss';
  if (wave >= 17) return 3;
  if (wave >= 9) return 2;
  return 1;
}

/** A full-screen story card shown before the wavestart banner on act boundaries. */
export interface Intertitle {
  /** Wave whose wavestart this card precedes (1-indexed). */
  wave: number;
  /** Act label shown small above the lines. */
  act: string;
  /** Two lines of arc copy. */
  lines: readonly [string, string];
}

/** The four act-boundary story cards, triggered at the start of these waves. */
export const ACT_INTROS: readonly Intertitle[] = [
  {
    wave: 1,
    act: 'ACT I · THE OUTER DRIFT',
    lines: ['The contract pays per stone.', 'The chain pays only if you finish it.'],
  },
  {
    wave: 10,
    act: 'ACT II · THE RECLASSIFICATION',
    lines: ['That one was not on the list.', 'Someone is placing them.'],
  },
  {
    wave: 17,
    act: 'ACT III · THE ANOMALOUS RUN',
    lines: ['Past halfway. The catalogue grows anomalous.', 'You are no longer the one reading it.'],
  },
  {
    wave: 25,
    act: 'THE GATE',
    lines: ['The line ends here.', 'Stand or fall. Then choose.'],
  },
];

/** The intertitle for a given wave, or null if the wave is not an act boundary. */
export function intertitleForWave(wave: number): Intertitle | null {
  return ACT_INTROS.find(i => i.wave === wave) ?? null;
}

/** Wavestart duration for an act-boundary wave — the whole hold is the story
 *  card (act beat + wave identity), replacing the standard wave banner. */
export const INTERTITLE_MS = 6000;

/** Arc-aware game-over line, keyed off the act the player fell in. Null for
 *  drift-mode waves (26+) where the campaign arc no longer applies. */
export function gameOverArcLine(wave: number): string | null {
  if (wave < 1 || wave > FINAL_WAVE) return null;
  const name = waveName(wave);
  const act = waveAct(wave);
  if (act === 'boss') return 'You fell at the horizon. The forge sang on.';
  if (act === 3) return `You fell at ${name}, within sight of the gate.`;
  if (act === 2) return `You fell at ${name}. The catalogue holds your line for the next hunter.`;
  return `You fell at ${name}, the contract unfilled.`;
}

export const UFO_RADIUS: Record<UfoType, number> = {
  cruiser: 22,
  elite: 12,
  tank: 30,
  sniper: 14,
  boss: 50,
};
export const UFO_SPEED: Record<UfoType, number> = {
  cruiser: 110,
  elite: 170,
  tank: 70,
  sniper: 90,
  boss: 50,
};
/** HP — number of player bullet hits required to destroy. */
export const UFO_HP: Record<UfoType, number> = {
  cruiser: 1,
  elite: 1,
  tank: 3,
  sniper: 1,
  boss: 25,
};
/** Per-type shot accuracy in radians (smaller = more accurate). */
export const UFO_SHOT_SPREAD: Record<UfoType, number> = {
  cruiser: 0.4,
  elite: 0.08,
  tank: 0.5,
  sniper: 0.02,
  boss: 0.1,
};
/** Per-type shoot interval ms. */
export const UFO_SHOOT_INTERVAL: Record<UfoType, number> = {
  cruiser: 1600,
  elite: 1300,
  tank: 2200,
  sniper: 2400,
  boss: 900,    // boss fires often — be aggressive
};
/** Per-type bullet speed multiplier. */
export const UFO_BULLET_SPEED_MUL: Record<UfoType, number> = {
  cruiser: 1.0,
  elite: 1.0,
  tank: 0.85,
  sniper: 1.6,
  boss: 1.2,
};
export const UFO_BULLET_SPEED = 320;
export const UFO_BULLET_TTL_MS = 2500;
export const UFO_LIFETIME_MS = 12_000;
export const UFO_ZIG_INTERVAL_MS = 1100;
/** Score points awarded for shooting a UFO. */
export const UFO_POINTS: Record<UfoType, number> = {
  cruiser: 200, elite: 1000, tank: 500, sniper: 1500, boss: 25_000,
};
/** Sats coins dropped on UFO kill. Only headline kills (elite / sniper /
 *  boss) drop a token — the rank-and-file UFOs are score-only kills to
 *  hold the operator budget within ~100k sats/year of total payout.
 *  Boss dropped 10 → 5 to fit the ~25 sats per full-run target alongside
 *  the per-wave sat budget and the lower vein jackpot. */
export const UFO_SATS: Record<UfoType, number> = {
  cruiser: 0, elite: 1, tank: 0, sniper: 1, boss: 5,
};
export const UFO_FIRST_SPAWN_MS = 12_000;
export const UFO_RESPAWN_BASE_MS = 18_000;
export const UFO_RESPAWN_PER_WAVE_MS = 1200;
export const UFO_RESPAWN_MIN_MS = 6500;

/**
 * UFO type assigned to each wave. One species per wave keeps each fight legible
 * and lets the player learn that wave's threat. Debuts: cruiser (1), elite (4),
 * tank (7), sniper (10). Wave 25 minions are sniper to harass under the boss.
 */
export const UFO_TYPE_BY_WAVE: readonly UfoType[] = [
  'cruiser',  // 1
  'cruiser',  // 2
  'cruiser',  // 3
  'elite',    // 4 — debut
  'cruiser',  // 5
  'cruiser',  // 6
  'tank',     // 7 — debut
  'elite',    // 8
  'cruiser',  // 9 — breather
  'sniper',   // 10 — debut
  'tank',     // 11
  'elite',    // 12
  'sniper',   // 13
  'tank',     // 14
  'elite',    // 15
  'sniper',   // 16
  'tank',     // 17
  'elite',    // 18
  'sniper',   // 19
  'tank',     // 20
  'elite',    // 21
  'sniper',   // 22
  'tank',     // 23
  'sniper',   // 24
  'sniper',   // 25 — boss arena minion (boss itself spawned separately)
];

// ── Mines ─────────────────────────────────────────────────────────────────────

export const MINE_RADIUS = 11;
/** Effective range of the gravity well in px. Smaller = easier to skirt around. */
export const MINE_GRAVITY_RANGE = 150;
/** Peak inward acceleration in px/s² when ship is at the edge of range. Smaller = escapable. */
export const MINE_GRAVITY_STRENGTH = 180;
export const MINE_POINTS = 250;
export const MINE_SATS_DROP = 0;
/** Wave at which mines start appearing. */
export const MINE_FIRST_WAVE = 8;

// ── Combo / chain bonus ──────────────────────────────────────────────────────

/** Window after a kill in which the next kill counts as a chain. */
export const COMBO_WINDOW_MS = 3000;
/** Max chain multiplier — caps at ×5. */
export const COMBO_MAX = 5;

/**
 * Candidate static mine positions — chosen by hand to be tactically interesting:
 * quadrant centres, edge midpoints, between asteroid spawn lanes.
 * Per wave we pick N of these deterministically (wave-seeded).
 * Coordinates are within the 1280x720 playfield with healthy edge buffer.
 */
export const MINE_CANDIDATE_POSITIONS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 320, y: 180 },   // top-left quadrant centre
  { x: 960, y: 180 },   // top-right
  { x: 320, y: 540 },   // bottom-left
  { x: 960, y: 540 },   // bottom-right
  { x: 640, y: 200 },   // top-centre
  { x: 640, y: 520 },   // bottom-centre
  { x: 267, y: 360 },   // left-centre
  { x: 1013, y: 360 },  // right-centre
  { x: 480, y: 320 },   // inner ring NW
  { x: 800, y: 320 },   // inner ring NE
  { x: 480, y: 420 },   // inner ring SW
  { x: 800, y: 420 },   // inner ring SE
];

/**
 * Number of mines per wave (1-indexed by wave). 0 means no mines on this wave.
 * Very gradual ramp so the player learns layouts.
 */
export const MINE_COUNT_BY_WAVE: ReadonlyArray<number> = [
  0, 0, 0, 0, 0, 0, 0,  // waves 1-7: no mines
  1, 1, 1,              // 8-10: 1 mine
  2, 2,                 // 11-12: 2 mines
  2, 3,                 // 13-14: 3 mines
  3, 3,                 // 15-16
  4, 4,                 // 17-18
  4, 5,                 // 19-20
  5, 5,                 // 21-22
  6, 6,                 // 23-24
  0,                    // 25: boss arena (boss deploys its own mines)
];
