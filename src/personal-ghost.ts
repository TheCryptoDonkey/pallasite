/**
 * Personal ghost — save the player's own run locally and let them race
 * against it on the next attempt at the same daily seed. Distinct from
 * the leader ghost (which is fetched from Nostr relays via ghost.ts);
 * personal ghosts are device-local, never published.
 *
 * Off by default — most players don't want the extra ship overlay. A
 * settings toggle gates rendering; saving happens regardless once the
 * toggle has been flipped on at least once, so opting in mid-week starts
 * working from the next run.
 */

import type { GhostPoseSample } from './types.js';

const STORE_KEY = 'pallasite:ghost-personal';
const ENABLED_KEY = 'pallasite:ghost-personal-enabled';

/** Keep at most this many seed entries so localStorage doesn't bloat
 *  across months of daily runs. LRU by lastSavedAt — oldest seed drops
 *  when the cap is reached. */
const MAX_SEEDS = 8;

export interface PersonalGhost {
  /** Daily seed string the run was on (e.g. "2026-05-11"). */
  seed: string;
  /** Final score, wave, run duration — for display in a small label. */
  score: number;
  wave: number;
  durationMs: number;
  /** Pose stream — 4Hz. Same shape as the published v2 ghost. */
  poseSamples: GhostPoseSample[];
  /** When this entry was last written (ms). LRU eviction key. */
  lastSavedAt: number;
}

type Store = Record<string, PersonalGhost>;

function loadStore(): Store {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as Store;
  } catch { /* ignore */ }
  return {};
}

function saveStore(store: Store): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* quota */ }
}

/** Read the personal ghost for a given seed. Returns null when daily mode
 *  is off (seed null) or no entry has been saved yet. */
export function getPersonalGhost(seed: string | null): PersonalGhost | null {
  if (!seed) return null;
  const store = loadStore();
  return store[seed] ?? null;
}

/** Persist a run's pose stream against the daily seed. Only the latest
 *  attempt per seed is kept — the next run on the same seed overwrites,
 *  so the player is always racing their most recent attempt rather than
 *  an old high score they're already past. */
export function savePersonalGhost(g: PersonalGhost): void {
  if (!g.seed) return;
  if (g.poseSamples.length < 2) return;  // useless — at least 2 samples for interpolation
  const store = loadStore();
  store[g.seed] = { ...g, lastSavedAt: Date.now() };
  // LRU eviction: keep only the MAX_SEEDS most recently saved entries.
  const keys = Object.keys(store);
  if (keys.length > MAX_SEEDS) {
    keys.sort((a, b) => store[b].lastSavedAt - store[a].lastSavedAt);
    const drop = keys.slice(MAX_SEEDS);
    for (const k of drop) delete store[k];
  }
  saveStore(store);
}

export function isPersonalGhostEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

export function setPersonalGhostEnabled(on: boolean): void {
  try { localStorage.setItem(ENABLED_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}
