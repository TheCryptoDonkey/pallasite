/**
 * Daily seed mode — deterministic gameplay rolls keyed to UTC date.
 *
 * Provides `gameRng()` to replace `Math.random()` in gameplay-critical paths
 * (type picks, spawn positions, drop rolls, hyperspace malfunction). Visual
 * jitter — asteroid shape, particle direction, blink phases — stays on
 * `Math.random()` since it doesn't affect fairness.
 *
 * When daily mode is off, `gameRng()` falls through to Math.random() so the
 * game runs as before.
 */

const STORAGE_KEY = 'pallasite:daily';

let rngState: number | null = null;
let activeSeed: string | null = null;

function fnv1a32(str: string): number {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Lock in a deterministic seed (or null to disable daily mode). */
export function setDailySeed(seedString: string | null): void {
  if (seedString === null) {
    rngState = null;
    activeSeed = null;
    return;
  }
  rngState = fnv1a32(seedString);
  activeSeed = seedString;
}

/**
 * Seed the RNG for one run and return the 32-bit seed used. A daily run keys
 * off the UTC date so everyone shares the field; otherwise a fresh random seed
 * is picked. Either way the seed is returned so the run can record it — a
 * recorded run re-simulates exactly from this value (B3 verifiable replay).
 *
 * Does not touch `activeSeed`: that stays the daily date string for the score
 * tag, managed by setDailySeed.
 */
export function seedRun(forced?: number): number {
  const seed = forced !== undefined
    ? forced >>> 0
    : getStoredDailyPref()
      ? fnv1a32(todayUTC())
      : (Math.random() * 0x100000000) >>> 0;
  rngState = seed;
  return seed;
}

/**
 * Returns a pseudorandom number in [0, 1). Deterministic when a daily seed has
 * been set; otherwise falls through to Math.random().
 *
 * Algorithm: Mulberry32 — fast, adequate distribution for game spawns.
 */
export function gameRng(): number {
  if (rngState === null) return Math.random();
  rngState = (rngState + 0x6D2B79F5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Today's UTC date as YYYY-MM-DD. Stable for ~24h windows. */
export function todayUTC(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Currently active seed (null when daily mode is off). For telemetry/score tag. */
export function getActiveSeed(): string | null {
  return activeSeed;
}

/** The live 32-bit RNG state. Exposed for the determinism harness so a
 *  re-simulation can be checked for divergence at the RNG level, not just
 *  via its downstream effect on gameplay. */
export function getRngState(): number | null {
  return rngState;
}

/** Stored preference for daily mode (persists across sessions). */
export function getStoredDailyPref(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setStoredDailyPref(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // ignore
  }
}
