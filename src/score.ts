/**
 * Score persistence and Nostr leaderboard reads.
 *
 * Local: top-10 in localStorage.
 * Nostr: `fetchGlobalHighScores` pulls kind 30762 events from relays.
 *        The faucet game-signed scores until it closed on 23 October 2026;
 *        solo and co-op scores are now signed by the player and published
 *        from here.
 */

import type { SignetSession, NostrEvent } from 'signet-login';
import { GAME_ID, sessionCanSign } from './auth.js';
import { getActiveRelays } from './relays.js';
import type { SoloScoreInput, SoloScoreResult } from './faucet.js';

const HIGHSCORE_KEY = 'pallasite:highscores';
const COOP_HIGHSCORE_KEY = 'pallasite:highscores:coop-campaign';
const MAX_LOCAL = 10;

export type ScoreBoardId = 'solo' | 'coop-campaign';

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

function keyForBoard(board: ScoreBoardId = 'solo'): string {
  return board === 'coop-campaign' ? COOP_HIGHSCORE_KEY : HIGHSCORE_KEY;
}

export function getLocalHighScores(board: ScoreBoardId = 'solo'): HighScoreEntry[] {
  try {
    const raw = localStorage.getItem(keyForBoard(board));
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

export function addLocalHighScore(entry: HighScoreEntry, board: ScoreBoardId = 'solo'): HighScoreEntry[] {
  const existing = getLocalHighScores(board);
  existing.push(entry);
  existing.sort((a, b) => b.score - a.score);
  const trimmed = existing.slice(0, MAX_LOCAL);
  try {
    localStorage.setItem(keyForBoard(board), JSON.stringify(trimmed));
  } catch {
    // localStorage unavailable
  }
  return trimmed;
}

export function isHighScore(score: number, board: ScoreBoardId = 'solo'): boolean {
  const list = getLocalHighScores(board);
  if (list.length < MAX_LOCAL) return score > 0;
  return score > list[list.length - 1].score;
}

/** Wipe the local top-10 list. Doesn't touch profile cache, relays, or
 *  any Nostr-published scores — just the localStorage entry the title
 *  screen renders from. */
export function clearLocalHighScores(board: ScoreBoardId = 'solo'): void {
  try { localStorage.removeItem(keyForBoard(board)); } catch { /* ignore */ }
}

/**
 * A score event we read off the wire. Same shape as NostrEvent but pinned to
 * kind 30762 so the global-leaderboard code doesn't have to keep re-asserting.
 *
 * Note: sats-paying solo scores publish through the faucet's /api/claim flow
 * and are game-signed there. The only frontend score publish left here is the
 * no-payout co-op campaign board. Existing legacy player-signed events still
 * surface in the leaderboard during the migration window.
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
const globalCaches = new Map<ScoreBoardId, { at: number; entries: GlobalHighScore[] }>();

function scoreEventMatchesBoard(tags: string[][], board: ScoreBoardId): boolean {
  const mode = tagValue(tags, 'mode') ?? tagValue(tags, 'run');
  if (board === 'coop-campaign') return mode === 'coop-campaign';
  return mode !== 'coop-campaign';
}

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
  opts: { force?: boolean; timeoutMs?: number; limit?: number; board?: ScoreBoardId } = {},
): Promise<GlobalHighScore[]> {
  const board = opts.board ?? 'solo';
  const cached = globalCaches.get(board);
  if (!opts.force && cached && Date.now() - cached.at < GLOBAL_CACHE_TTL_MS) {
    return cached.entries;
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
      globalCaches.set(board, { at: Date.now(), entries });
      resolve(entries);
    };

    const timer = setTimeout(settle, timeoutMs);

    const consider = (event: ScoreEvent): void => {
      if (hasTagValue(event.tags, 'cheated', 'true')) return;
      if (!scoreEventMatchesBoard(event.tags, board)) return;
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
  opts: { relays?: readonly string[]; limit?: number; board?: ScoreBoardId } = {},
): () => void {
  const relays = opts.relays ?? getActiveRelays();
  const limit = opts.limit ?? 200;
  const board = opts.board ?? 'solo';
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
      globalCaches.set(board, { at: Date.now(), entries });
      onUpdate(entries);
    }, 200);
  };

  const consider = (event: ScoreEvent): boolean => {
    if (hasTagValue(event.tags, 'cheated', 'true')) return false;
    if (!scoreEventMatchesBoard(event.tags, board)) return false;
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

export interface CoopCampaignScoreInput {
  score: number;
  wave: number;
  durationMs: number;
  players: number;
  seed?: string | null;
  cheated?: boolean;
}

export interface ScorePublishResult {
  event: NostrEvent;
  publishedTo: string[];
  failed: string[];
}

function publishToRelay(url: string, event: NostrEvent, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err);
      return;
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('relay-timeout'));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = ev => {
      try {
        const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (Array.isArray(msg) && msg[0] === 'OK' && msg[1] === event.id) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          if (msg[2] === true) resolve();
          else reject(new Error(typeof msg[3] === 'string' ? msg[3] : 'rejected'));
        }
      } catch { /* ignore parse errors */ }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('relay-error')); };
  });
}

/**
 * Sign and publish a solo score as the player. The faucet used to game-sign
 * these; it closed on 23 October 2026, so the player's own key now vouches
 * for the run. Same tags and per-run `d` address the faucet used, so a retry
 * replaces itself instead of adding a duplicate.
 */
export async function publishSoloScore(
  session: SignetSession,
  input: SoloScoreInput,
  opts: { relays?: readonly string[]; publish?: (url: string, event: NostrEvent) => Promise<void> } = {},
): Promise<SoloScoreResult> {
  if (!sessionCanSign(session)) return { ok: false, error: 'no_signer' };
  // The leaderboard drops cheated runs, so never ask anyone to sign one.
  if (input.cheated) return { ok: false, error: 'cheated_run', status: 400 };
  const score = Math.floor(input.score);
  if (!Number.isFinite(score) || score <= 0) return { ok: false, error: 'invalid_score', status: 400 };
  // Saved receipts carry Unix seconds or milliseconds, depending on their age.
  const seconds = (v: number | undefined): number | undefined => v === undefined ? undefined : v >= 100_000_000_000 ? Math.floor(v / 1000) : v;
  const startedAt = seconds(input.started_at), finishedAt = seconds(input.finished_at);
  const wave = Math.max(0, Math.floor(input.wave));
  const tags: string[][] = [
    ['d', `${GAME_ID}:${session.pubkey}:wave-${wave}:daily-${input.run_id}`],
    ['game', GAME_ID],
    ['score', String(score)],
    ['p', session.pubkey],
    ['sats', '0'],
    ['state', 'final'],
    ['wave', String(wave)],
    ['duration', String(Math.round(Math.max(0, input.duration_ms) / 1000))],
    ...(input.player_name ? [['playerName', input.player_name]] : []),
    ...(input.nip05 ? [['nip05', input.nip05]] : []),
    ['t', 'pallasite'],
    ['t', 'arcade'],
    ['t', 'asteroids'],
    ...(input.room === '600bn' ? [['t', '600bn']] : []),
    ...(input.mode && input.mode !== 'campaign' ? [['t', input.mode]] : []),
    ...(startedAt !== undefined ? [['run_started_at', String(startedAt)]] : []),
    ...(finishedAt !== undefined ? [['run_finished_at', String(finishedAt)]] : []),
  ];
  let signed: NostrEvent;
  try {
    signed = await Promise.race([
      session.signer.signEvent({ kind: 30762, created_at: finishedAt ?? Math.floor(Date.now() / 1000), content: '', tags }),
      new Promise<never>((_, reject) => { setTimeout(() => reject(new Error('signer-timeout')), 30_000); }),
    ]);
  } catch (err) {
    return { ok: false, error: 'sign_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  if (signed.pubkey !== session.pubkey) return { ok: false, error: 'wrong_signer' };
  const relays = opts.relays ?? getActiveRelays();
  const publish = opts.publish ?? publishToRelay;
  const accepted = (await Promise.all(relays.map(url => publish(url, signed).then(() => true, () => false)))).filter(Boolean).length;
  if (accepted === 0) return { ok: false, error: 'relays_rejected' };
  return { ok: true, id: signed.id, published: { ok: accepted, total: relays.length } };
}

export async function publishCoopCampaignScore(
  session: SignetSession,
  input: CoopCampaignScoreInput,
  relays: readonly string[] = getActiveRelays(),
): Promise<ScorePublishResult | null> {
  // Legacy frontend-signed fallback (the primary coop path is game-signed
  // server-side — see ui.ts). An auth-only session can't sign it; return null
  // so the caller keeps the local score and prompts for a live signer instead
  // of throwing.
  if (!sessionCanSign(session)) return null;
  const score = Math.max(0, Math.floor(input.score));
  const wave = Math.max(0, Math.floor(input.wave));
  const duration = Math.max(0, Math.floor(input.durationMs));
  const players = Math.max(2, Math.floor(input.players));
  const tags: string[][] = [
    // Kind 30762 is addressable: without a `d` tag every score a player
    // signs replaces their last one, solo or co-op. Same shape the faucet used.
    ['d', `${GAME_ID}:${session.pubkey}:coop:wave-${wave}`],
    ['t', 'pallasite'],
    ['t', 'coop-campaign'],
    ['game', GAME_ID],
    ['mode', 'coop-campaign'],
    ['p', session.pubkey],
    ['score', String(score)],
    ['sats', '0'],
    ['wave', String(wave)],
    ['duration', String(duration)],
    ['players', String(players)],
  ];
  if (input.seed) tags.push(['seed', input.seed]);
  if (input.cheated) tags.push(['cheated', 'true']);

  const signed = await session.signer.signEvent({
    kind: 30762,
    content: JSON.stringify({
      game: GAME_ID,
      mode: 'coop-campaign',
      score,
      sats: 0,
      wave,
      duration_ms: duration,
      players,
    }),
    tags,
  });

  const publishedTo: string[] = [];
  const failed: string[] = [];
  await Promise.all(relays.map(url => publishToRelay(url, signed).then(
    () => publishedTo.push(url),
    () => failed.push(url),
  )));
  return { event: signed, publishedTo, failed };
}
