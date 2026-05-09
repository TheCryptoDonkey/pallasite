/**
 * Relay state — persisted to localStorage. Two-tier model:
 *
 *   knownRelays  — every relay the user is aware of (defaults + custom-added).
 *                  Toggleable. Custom ones are deletable.
 *   activeRelays — subset of knownRelays that's currently enabled. Publishers
 *                  (score.ts, social.ts, zap.ts) hit `getActiveRelays()` at
 *                  call time so settings changes take effect on the next event.
 */

import { DEFAULT_RELAYS } from './credits.js';

const STORAGE_KEY = 'pallasite:relays:v2';
// Legacy key from v1 (just an array of enabled URLs) — read once on first
// load, migrate forward, then ignored.
const LEGACY_KEY = 'pallasite:relays';

interface RelayState {
  known: string[];
  active: string[];
}

function isWssUrl(s: string): boolean {
  return /^wss:\/\/[a-z0-9.\-]+(:\d+)?(\/[\w\-/.]*)?$/i.test(s);
}

function defaultsState(): RelayState {
  return { known: [...DEFAULT_RELAYS], active: [...DEFAULT_RELAYS] };
}

function load(): RelayState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Partial<RelayState>;
        const knownIn = Array.isArray(p.known) ? p.known.filter((s): s is string => typeof s === 'string' && isWssUrl(s)) : [];
        const activeIn = Array.isArray(p.active) ? p.active.filter((s): s is string => typeof s === 'string' && isWssUrl(s)) : [];
        // Always merge in the defaults so a new bundled relay is discoverable
        const known = Array.from(new Set([...knownIn, ...DEFAULT_RELAYS]));
        const active = activeIn.filter(u => known.includes(u));
        return { known, active: active.length > 0 ? active : [...known] };
      }
    }
    // Migrate v1 (flat array of enabled URLs)
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const parsed: unknown = JSON.parse(legacy);
      if (Array.isArray(parsed)) {
        const cleaned = parsed.filter((s): s is string => typeof s === 'string' && isWssUrl(s));
        const known = Array.from(new Set([...cleaned, ...DEFAULT_RELAYS]));
        const state: RelayState = { known, active: cleaned.length > 0 ? cleaned : [...known] };
        save(state);
        try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
        return state;
      }
    }
  } catch { /* ignore */ }
  return defaultsState();
}

function save(state: RelayState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

/** The relay list to use right now — the active subset of known. */
export function getActiveRelays(): readonly string[] {
  const state = load();
  return state.active.length > 0 ? state.active : state.known;
}

/** Every relay the user has on file (defaults + their custom-added). */
export function getKnownRelays(): readonly string[] {
  return load().known;
}

/** True if `url` is currently enabled. */
export function isRelayEnabled(url: string): boolean {
  return load().active.includes(url);
}

/** True if `url` is part of the bundled defaults (vs user-added). */
export function isDefaultRelay(url: string): boolean {
  return (DEFAULT_RELAYS as readonly string[]).includes(url);
}

/** Toggle a relay on/off. No-op if the URL isn't known. */
export function setRelayEnabled(url: string, enabled: boolean): void {
  const state = load();
  if (!state.known.includes(url)) return;
  state.active = enabled
    ? Array.from(new Set([...state.active, url]))
    : state.active.filter(u => u !== url);
  save(state);
}

/** Add a new (presumably custom) relay URL. Returns the cleaned list of
 *  known relays, or null if the input was rejected as malformed. */
export function addRelay(url: string): readonly string[] | null {
  const trimmed = url.trim();
  if (!isWssUrl(trimmed)) return null;
  const state = load();
  if (!state.known.includes(trimmed)) state.known = [...state.known, trimmed];
  if (!state.active.includes(trimmed)) state.active = [...state.active, trimmed];
  save(state);
  return state.known;
}

/** Remove a custom relay entirely. No-op for defaults — those can only be
 *  toggled off, not deleted. */
export function removeRelay(url: string): void {
  if (isDefaultRelay(url)) return;
  const state = load();
  state.known = state.known.filter(u => u !== url);
  state.active = state.active.filter(u => u !== url);
  save(state);
}

/** Reset to the bundled default set, dropping any user customisations. */
export function resetRelays(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(LEGACY_KEY); } catch { /* ignore */ }
}
