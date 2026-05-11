/**
 * Daily streak — track consecutive days the player has completed a daily
 * run. The streak is the retention hook on the title screen: once the
 * player has a number to protect, missing a day costs them.
 *
 * Storage:
 *   pallasite:streak.current      — count of consecutive days
 *   pallasite:streak.best         — highest streak ever
 *   pallasite:streak.lastDay      — YYYY-MM-DD of the last completed run
 *
 * Streak rules:
 *   - First completed daily run: streak = 1
 *   - Same day repeat: streak unchanged
 *   - Next consecutive day: streak += 1
 *   - Skip a day or more: streak resets to 1
 */

const KEY_CURRENT = 'pallasite:streak.current';
const KEY_BEST    = 'pallasite:streak.best';
const KEY_LAST    = 'pallasite:streak.lastDay';

/** Launch epoch for the daily ordinal — "Pallasite #1" was 2026-04-01.
 *  Picked so the number is interesting (~40+) by the time players see it.
 *  Never change this — moving the epoch reshuffles every shared post. */
const EPOCH = '2026-04-01';

function readNumber(key: string): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return 0;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch { return 0; }
}

function writeNumber(key: string, value: number): void {
  try { localStorage.setItem(key, String(value)); } catch { /* ignore */ }
}

function readDay(): string | null {
  try { return localStorage.getItem(KEY_LAST); } catch { return null; }
}

function writeDay(day: string): void {
  try { localStorage.setItem(KEY_LAST, day); } catch { /* ignore */ }
}

export function getStreak(): number {
  return readNumber(KEY_CURRENT);
}

export function getBestStreak(): number {
  return readNumber(KEY_BEST);
}

/** Days difference between two YYYY-MM-DD strings, B - A. Returns Infinity
 *  on parse failure so a malformed previous day forces a streak reset. */
function dayDiff(a: string, b: string): number {
  const ta = Date.parse(a + 'T00:00:00Z');
  const tb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return Infinity;
  return Math.round((tb - ta) / 86_400_000);
}

/** Mark today's daily run as completed. Called from the gameover /
 *  completion path when the player has finished a daily run (any score,
 *  any wave). seed is YYYY-MM-DD per todayUTC(). */
export function markDailyCompleted(seed: string): void {
  const last = readDay();
  let current = getStreak();
  if (!last) {
    current = 1;
  } else {
    const diff = dayDiff(last, seed);
    if (diff === 0) {
      // Same day — streak unchanged, but normalise to at least 1.
      current = Math.max(1, current);
    } else if (diff === 1) {
      current += 1;
    } else {
      current = 1;
    }
  }
  writeNumber(KEY_CURRENT, current);
  writeDay(seed);
  if (current > getBestStreak()) writeNumber(KEY_BEST, current);
}

/** "Pallasite #N" ordinal from a YYYY-MM-DD seed. Days since EPOCH + 1
 *  so day-zero is #1. Negative results (pre-epoch dates) clamp to 1. */
export function getDailyOrdinal(seed: string): number {
  return Math.max(1, dayDiff(EPOCH, seed) + 1);
}

/** Compact score formatter — "8400" → "8.4k", "12450" → "12.4k", values
 *  under 10k stay raw. Used in the Wordle-style share text. */
function fmtScore(n: number): string {
  if (n < 10_000) return String(n);
  if (n < 1_000_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'm';
}

export interface RunRecap {
  seed: string;
  score: number;
  wave: number;
  bossDefeated: boolean;
  largestCombo: number;
  veinsBroken: number;
  /** True for completion runs; false for gameover. Drives 💀 vs 🏆. */
  cleared: boolean;
}

/**
 * Build the Wordle-style share text for a daily run. Single line so it
 * pastes well into any tweet / Slack / Bluesky / Mastodon. Emoji recap
 * encodes peak moments without spoilers — readers see "🪙🔥💀" and want
 * to know what those mean.
 *
 *   Pallasite #137 · W12 · 8.4k · 🪙🔥💀 · pallasite.app
 *
 * Emoji palette:
 *   💀 died (gameover)
 *   🏆 reached completion (W25 boss down)
 *   🪙 broke a pallasite vein
 *   🔥 hit max combo (≥5)
 *   ☄️ reached W25
 */
export function buildDailyShareText(r: RunRecap): string {
  const ordinal = getDailyOrdinal(r.seed);
  const emoji: string[] = [];
  if (r.cleared) emoji.push('🏆');
  else emoji.push('💀');
  if (r.veinsBroken > 0) emoji.push('🪙');
  if (r.largestCombo >= 5) emoji.push('🔥');
  if (r.wave >= 25 && !r.cleared) emoji.push('☄️');
  return `Pallasite #${ordinal} · W${r.wave} · ${fmtScore(r.score)} · ${emoji.join('')} · pallasite.app`;
}
