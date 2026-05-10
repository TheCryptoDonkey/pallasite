/**
 * Score persistence and Nostr leaderboard reads.
 *
 * Local: top-10 in localStorage.
 * Nostr: read-only — `fetchGlobalHighScores` pulls kind 30762 events
 *        from relays. Publishing now happens server-side via the faucet's
 *        /api/claim flow (see src/faucet.ts), so this module no longer
 *        signs or sends events. Existing player-signed events from before
 *        the cutover still surface in the leaderboard during the migration
 *        window.
 */

import { GAME_ID } from './auth.js';
import { getActiveRelays } from './relays.js';

const HIGHSCORE_KEY = 'pallasite:highscores';
const MAX_LOCAL = 10;

export interface HighScoreEntry {
  /** Initials or display name */
  name: string;
  score: number;
  sats: number;
  wave: number;
  /** ISO timestamp */
  at: string;
  /** Nostr pubkey if signed (may be local-only) */
  pubkey?: string;
  /** kind 30762 event id if published */
  eventId?: string;
}

export function getLocalHighScores(): HighScoreEntry[] {
  try {
    const raw = localStorage.getItem(HIGHSCORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is HighScoreEntry =>
      typeof e === 'object' && e !== null &&
      typeof (e as HighScoreEntry).name === 'string' &&
      typeof (e as HighScoreEntry).score === 'number',
    );
  } catch {
    return [];
  }
}

export function addLocalHighScore(entry: HighScoreEntry): HighScoreEntry[] {
  const existing = getLocalHighScores();
  existing.push(entry);
  existing.sort((a, b) => b.score - a.score);
  const trimmed = existing.slice(0, MAX_LOCAL);
  try {
    localStorage.setItem(HIGHSCORE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage unavailable
  }
  return trimmed;
}

export function isHighScore(score: number): boolean {
  const list = getLocalHighScores();
  if (list.length < MAX_LOCAL) return score > 0;
  return score > list[list.length - 1].score;
}

/** Wipe the local top-10 list. Doesn't touch profile cache, relays, or
 *  any Nostr-published scores — just the localStorage entry the title
 *  screen renders from. */
export function clearLocalHighScores(): void {
  try { localStorage.removeItem(HIGHSCORE_KEY); } catch { /* ignore */ }
}

/**
 * A score event we read off the wire. Same shape as NostrEvent but pinned to
 * kind 30762 so the global-leaderboard code doesn't have to keep re-asserting.
 *
 * Note: the frontend no longer publishes player-signed score events — the
 * faucet's /api/claim flow signs game-side via NIP-46 bunker. This module
 * is read-only; existing player-signed events still surface in the
 * leaderboard fallback during the migration window.
 */
interface ScoreEvent {
  id: string;
  pubkey: string;
  kind: 30762;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

function isScoreEvent(value: unknown): value is ScoreEvent {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return e.kind === 30762
    && typeof e.id === 'string'
    && typeof e.pubkey === 'string'
    && typeof e.created_at === 'number'
    && Array.isArray(e.tags);
}

function tagValue(tags: string[][], name: string): string | undefined {
  for (const t of tags) {
    if (t[0] === name && typeof t[1] === 'string') return t[1];
  }
  return undefined;
}

function hasTagValue(tags: string[][], name: string, value: string): boolean {
  for (const t of tags) {
    if (t[0] === name && t[1] === value) return true;
  }
  return false;
}

/**
 * One entry on the global leaderboard. Pubkey is hex (no display name yet —
 * the UI layer resolves kind 0 separately so name fetches don't block the
 * scores from rendering).
 */
export interface GlobalHighScore {
  pubkey: string;
  score: number;
  sats: number;
  wave: number;
  /** ISO timestamp of the event's `created_at`. */
  at: string;
  eventId: string;
}

const GLOBAL_CACHE_TTL_MS = 30_000;
let globalCache: { at: number; entries: GlobalHighScore[] } | null = null;

/**
 * Pull kind 30762 score events for this game from the active relays and
 * collapse them into a per-player best-score leaderboard.
 *
 * - Filters out events tagged `cheated:true`.
 * - Keeps the highest score per pubkey across all that player's runs.
 * - Caches the result for 30s so navigating in and out of the title screen
 *   doesn't re-query relays.
 *
 * Resolves with `[]` rather than rejecting if relays are unreachable — the
 * leaderboard should fail quietly, not crash the title screen.
 */
export async function fetchGlobalHighScores(
  relays: readonly string[] = getActiveRelays(),
  opts: { force?: boolean; timeoutMs?: number; limit?: number } = {},
): Promise<GlobalHighScore[]> {
  if (!opts.force && globalCache && Date.now() - globalCache.at < GLOBAL_CACHE_TTL_MS) {
    return globalCache.entries;
  }
  if (relays.length === 0) return [];

  const timeoutMs = opts.timeoutMs ?? 5000;
  const limit = opts.limit ?? 200;

  return new Promise<GlobalHighScore[]>(resolve => {
    const sockets: WebSocket[] = [];
    const bestByPubkey = new Map<string, GlobalHighScore>();
    let settled = false;
    let doneCount = 0;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach(s => { try { s.close(); } catch { /* ignore */ } });
      const entries = Array.from(bestByPubkey.values()).sort((a, b) => b.score - a.score);
      globalCache = { at: Date.now(), entries };
      resolve(entries);
    };

    const timer = setTimeout(settle, timeoutMs);

    const consider = (event: ScoreEvent): void => {
      if (hasTagValue(event.tags, 'cheated', 'true')) return;
      const scoreStr = tagValue(event.tags, 'score');
      const score = scoreStr ? parseInt(scoreStr, 10) : NaN;
      if (!Number.isFinite(score) || score <= 0) return;
      // Player attribution: the `p` tag is the player's pubkey on game-signed
      // events (event.pubkey is the game key, same for everyone). Legacy
      // player-signed events also carry a `p` tag that equals event.pubkey,
      // so this works for both. Fall back to event.pubkey if `p` is absent.
      const playerPubkey = tagValue(event.tags, 'p') ?? event.pubkey;
      if (!/^[0-9a-f]{64}$/i.test(playerPubkey)) return;
      const existing = bestByPubkey.get(playerPubkey);
      if (existing && existing.score >= score) return;
      bestByPubkey.set(playerPubkey, {
        pubkey: playerPubkey,
        score,
        sats: parseInt(tagValue(event.tags, 'sats') ?? '0', 10) || 0,
        wave: parseInt(tagValue(event.tags, 'wave') ?? '0', 10) || 0,
        at: new Date(event.created_at * 1000).toISOString(),
        eventId: event.id,
      });
    };

    for (const url of relays) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        doneCount += 1;
        if (doneCount >= relays.length) settle();
        continue;
      }
      sockets.push(ws);
      const subId = 'g' + Math.random().toString(36).slice(2, 10);
      let relayDone = false;
      const markDone = (): void => {
        if (relayDone) return;
        relayDone = true;
        doneCount += 1;
        if (doneCount >= relays.length) settle();
      };

      ws.onopen = () => {
        // NIP-01 only indexes single-letter tags, so `#game` is not a valid
        // server-side filter. New publishes carry `#t=pallasite` for precise
        // server-side narrowing; we also accept `#t=asteroids` so historical
        // events from before the pallasite tag was added still surface. The
        // post-filter on `game=pallasite` keeps us honest if other kind 30762
        // games happen to share either of those `t` values.
        ws.send(JSON.stringify(['REQ', subId, {
          kinds: [30762],
          '#t': ['pallasite', 'asteroids'],
          limit,
        }]));
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: unknown;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const event = msg[2];
          if (isScoreEvent(event) && hasTagValue(event.tags, 'game', GAME_ID)) consider(event);
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          markDone();
        }
      };

      ws.onerror = markDone;
      ws.onclose = markDone;
    }
  });
}

/**
 * Open a live subscription to kind 30762 score events on the active relays
 * and emit `onUpdate` whenever the per-pubkey best leaderboard changes.
 *
 * Unlike `fetchGlobalHighScores`, this never closes on EOSE. Sockets stay
 * open and any new event a relay propagates flows straight to the consumer,
 * so the title-screen leaderboard reflects new scores as they land instead
 * of every 30s.
 *
 * Emits are debounced (~200ms) to coalesce the burst of events that arrives
 * during the initial backfill, and the per-pubkey best map is kept across
 * the whole subscription lifetime so a fresh score only emits if it actually
 * beats that player's previous best.
 *
 * Always call the returned unsubscribe when the consumer unmounts.
 */
export function subscribeGlobalHighScores(
  onUpdate: (entries: GlobalHighScore[]) => void,
  opts: { relays?: readonly string[]; limit?: number } = {},
): () => void {
  const relays = opts.relays ?? getActiveRelays();
  const limit = opts.limit ?? 200;
  if (relays.length === 0) {
    setTimeout(() => onUpdate([]), 0);
    return () => undefined;
  }

  const sockets: WebSocket[] = [];
  const bestByPubkey = new Map<string, GlobalHighScore>();
  let closed = false;
  let pendingEmit: number | null = null;

  const scheduleEmit = (): void => {
    if (closed || pendingEmit !== null) return;
    pendingEmit = window.setTimeout(() => {
      pendingEmit = null;
      if (closed) return;
      const entries = Array.from(bestByPubkey.values()).sort((a, b) => b.score - a.score);
      // Keep the legacy fetch cache warm so any sync reader sees the same data.
      globalCache = { at: Date.now(), entries };
      onUpdate(entries);
    }, 200);
  };

  const consider = (event: ScoreEvent): boolean => {
    if (hasTagValue(event.tags, 'cheated', 'true')) return false;
    const scoreStr = tagValue(event.tags, 'score');
    const score = scoreStr ? parseInt(scoreStr, 10) : NaN;
    if (!Number.isFinite(score) || score <= 0) return false;
    const playerPubkey = tagValue(event.tags, 'p') ?? event.pubkey;
    if (!/^[0-9a-f]{64}$/i.test(playerPubkey)) return false;
    const existing = bestByPubkey.get(playerPubkey);
    if (existing && existing.score >= score) return false;
    bestByPubkey.set(playerPubkey, {
      pubkey: playerPubkey,
      score,
      sats: parseInt(tagValue(event.tags, 'sats') ?? '0', 10) || 0,
      wave: parseInt(tagValue(event.tags, 'wave') ?? '0', 10) || 0,
      at: new Date(event.created_at * 1000).toISOString(),
      eventId: event.id,
    });
    return true;
  };

  for (const url of relays) {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { continue; }
    sockets.push(ws);
    const subId = 'gl' + Math.random().toString(36).slice(2, 10);

    ws.onopen = () => {
      ws.send(JSON.stringify(['REQ', subId, {
        kinds: [30762],
        '#t': ['pallasite', 'asteroids'],
        limit,
      }]));
    };

    ws.onmessage = (ev: MessageEvent) => {
      let msg: unknown;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
      if (!Array.isArray(msg)) return;
      // EVENT only — no EOSE handling, the subscription stays open for live
      // events. Relays that close the socket on idle will simply stop feeding;
      // the others continue.
      if (msg[0] === 'EVENT' && msg[1] === subId) {
        const event = msg[2];
        if (isScoreEvent(event) && hasTagValue(event.tags, 'game', GAME_ID)) {
          if (consider(event)) scheduleEmit();
        }
      }
    };

    ws.onerror = () => { /* best-effort across relays; silent on per-relay failure */ };
  }

  return () => {
    if (closed) return;
    closed = true;
    if (pendingEmit !== null) { clearTimeout(pendingEmit); pendingEmit = null; }
    sockets.forEach(s => { try { s.close(); } catch { /* ignore */ } });
  };
}

