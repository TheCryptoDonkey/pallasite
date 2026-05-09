/**
 * Difficulty settings — multipliers applied across the game at relevant sites.
 *
 * Selection persists in localStorage, but is only "locked in" at startGame —
 * mid-run difficulty changes are not supported.
 */

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface DifficultyMods {
  /** Lives at the start of a run. */
  livesStart: number;
  /** Multiplier on asteroid speed. <1 easier, >1 harder. */
  asteroidSpeedMul: number;
  /** Multiplier on the UFO respawn interval. Larger = longer waits = easier. */
  ufoIntervalMul: number;
  /** Multiplier on UFO shot spread. Larger = sloppier shots = easier. */
  ufoSpreadMul: number;
  /** Multiplier on UFO bullet speed. Larger = harder to dodge. */
  ufoBulletSpeedMul: number;
  /** Multiplier on mine gravity strength. Larger = stronger pull. */
  mineGravityMul: number;
  /** Multiplier on shield cooldown after burst. Smaller = re-up sooner. */
  shieldCooldownMul: number;
  /** Multiplier on hyperspace cooldown. Smaller = re-warp sooner. */
  hyperspaceCooldownMul: number;
  /** Multiplier on player bullet speed. Larger = easier to lead targets. */
  bulletSpeedMul: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyMods> = {
  easy: {
    livesStart: 5,
    asteroidSpeedMul: 0.70,
    ufoIntervalMul: 1.6,
    ufoSpreadMul: 1.7,
    ufoBulletSpeedMul: 0.85,
    mineGravityMul: 0.7,
    shieldCooldownMul: 0.65,
    hyperspaceCooldownMul: 0.55,
    bulletSpeedMul: 1.18,
  },
  normal: {
    livesStart: 3,
    asteroidSpeedMul: 1.0,
    ufoIntervalMul: 1.0,
    ufoSpreadMul: 1.0,
    ufoBulletSpeedMul: 1.0,
    mineGravityMul: 1.0,
    shieldCooldownMul: 1.0,
    hyperspaceCooldownMul: 1.0,
    bulletSpeedMul: 1.0,
  },
  hard: {
    livesStart: 2,
    asteroidSpeedMul: 1.18,
    ufoIntervalMul: 0.65,
    ufoSpreadMul: 0.6,
    ufoBulletSpeedMul: 1.15,
    mineGravityMul: 1.25,
    shieldCooldownMul: 1.35,
    hyperspaceCooldownMul: 1.4,
    bulletSpeedMul: 1.0,
  },
};

const KEY = 'pallasite:difficulty';

export function getStoredDifficulty(): Difficulty {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'easy' || v === 'normal' || v === 'hard') return v;
  } catch { /* ignore */ }
  return 'normal';
}

export function setStoredDifficulty(d: Difficulty): void {
  try { localStorage.setItem(KEY, d); } catch { /* ignore */ }
}

/**
 * Currently active mods. Captured at startGame and held in module state.
 * Anything reading `currentMods()` after startGame gets the locked-in values
 * for that run.
 */
let active: DifficultyMods = DIFFICULTIES.normal;

export function lockInDifficulty(d: Difficulty): void {
  active = DIFFICULTIES[d];
}

export function currentMods(): DifficultyMods {
  return active;
}
