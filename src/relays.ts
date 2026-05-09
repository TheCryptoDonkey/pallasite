/**
 * Active relay list — persisted to localStorage so the user's preferred set
 * survives reloads. Falls back to DEFAULT_RELAYS when no override is saved.
 *
 * Callers (score.ts, social.ts, zap.ts) read via `getActiveRelays()` at the
 * point of publish, so a settings change takes effect on the next event
 * without needing to plumb the list through ten layers of state.
 */

import { DEFAULT_RELAYS } from './credits.js';

const STORAGE_KEY = 'pallasite:relays';

function isWssUrl(s: string): boolean {
  return /^wss:\/\/[a-z0-9.\-]+(:\d+)?(\/[\w\-/.]*)?$/i.test(s);
}

/** The relay list to use right now — user override or defaults. */
export function getActiveRelays(): readonly string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_RELAYS;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_RELAYS;
    const cleaned = parsed.filter((s): s is string => typeof s === 'string' && isWssUrl(s));
    return cleaned.length > 0 ? cleaned : DEFAULT_RELAYS;
  } catch {
    return DEFAULT_RELAYS;
  }
}

/** Persist a user-chosen list. Empty list resets to defaults. Invalid URLs
 *  are silently dropped. Returns the cleaned list that was saved. */
export function setActiveRelays(list: readonly string[]): string[] {
  const cleaned = Array.from(new Set(list.map(s => s.trim()).filter(isWssUrl)));
  if (cleaned.length === 0) {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
    return [...DEFAULT_RELAYS];
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned)); } catch { /* ignore */ }
  return cleaned;
}

/** Reset to the bundled default set. */
export function resetRelays(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}
