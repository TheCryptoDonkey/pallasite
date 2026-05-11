/**
 * Pallasite watch — public live spectator surface served at
 * watch.pallasite.app.
 *
 * Subscribes to kind 30762 score events from the faucet's game pubkey
 * and surfaces one card per recently-active player (latest run, newest
 * first). Visitors can WATCH the ghost replay in the existing theatre
 * and ZAP the player via NIP-57. The dev's own zap-the-dev path
 * stays untouched on the title screen — this is recipient-aware
 * zapping for the players themselves.
 *
 * v1 is "recent runs" rather than literally-live in-progress play:
 * kind 30762 events are signed by the GAME pubkey (the faucet's hot
 * signer) and only published at claim time (state='final'). True
 * "in progress" cards would need active-state events emitted during
 * play — that's a follow-up where the faucet accepts heartbeats from
 * the client and re-broadcasts state='active' on a timer.
 */

import type { NostrEvent } from 'signet-login';
import { EXPERIMENTAL_RELAYS } from './credits.js';
import { fetchGameInfo } from './faucet.js';

export const SCORE_EVENT_KIND = 30762;
export const GAME_ID = 'pallasite';

/** A single most-recent score event per player. */
export interface WatchEntry {
  pubkey: string;
  score: number;
  wave: number;
  sats: number;
  /** Unix-sec — event's created_at. */
  createdAt: number;
  /** kind 30762 event id — reachable ghost via the e-tag chain in C3/jury.
   *  Only resolves to a ghost when state === 'final'; active runs have no
   *  ghost yet because the kind 30763 is published at end-of-run. */
  eventId: string;
  /** Optional daily seed identifier (also doubles as run_id for live events). */
  seed: string | null;
  /** State tag from the score event. 'active' = in-progress (no ghost yet),
   *  'final' = run claimed (ghost should exist on relays), null = unknown. */
  state: 'active' | 'final' | null;
  /** True when state==='active' AND the event is fresh enough that the
   *  player is plausibly still in the run. */
  isLive: boolean;
}

/** Live entries older than this with no fresh heartbeat are considered
 *  stale and rendered as recently-active rather than LIVE. */
export const LIVE_FRESHNESS_MS = 45_000;

/** Active events older than this are treated as orphans — the player
 *  almost certainly finished the run without claiming (no kind 30762
 *  final landed, no kind 30763 ghost was published), so the card has
 *  nothing to show. Drops them from the watch surface. */
export const ORPHANED_ACTIVE_MAX_AGE_MS = 5 * 60_000;

const DISMISSED_STORAGE_KEY = 'pallasite:watch-dismissed:v1';

/** Hide an event from the watch surface for this browser. Per-event-id
 *  blocklist in localStorage — purely a UI convenience, not a NIP-09
 *  deletion. (For a proper cross-client deletion we'd publish a kind 5
 *  NIP-09 event from the game pubkey via a faucet admin endpoint.) */
export function dismissWatchEntry(eventId: string): void {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    if (!list.includes(eventId)) list.push(eventId);
    localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(list));
  } catch { /* ignore */ }
}

export function getDismissedWatchEntries(): ReadonlySet<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_STORAGE_KEY);
    if (!raw) return new Set();
    const list = JSON.parse(raw);
    return Array.isArray(list) ? new Set(list.filter((v): v is string => typeof v === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

interface ScoreEvent extends NostrEvent {
  kind: typeof SCORE_EVENT_KIND;
}

function readTag(tags: string[][], name: string): string | null {
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') return t[1];
  return null;
}

function hasTagValue(tags: string[][], name: string, value: string): boolean {
  for (const t of tags) if (t[0] === name && t[1] === value) return true;
  return false;
}

function parseEntry(event: ScoreEvent, nowMs: number = Date.now()): WatchEntry | null {
  if (event.kind !== SCORE_EVENT_KIND) return null;
  if (!hasTagValue(event.tags, 'game', GAME_ID)) return null;
  if (hasTagValue(event.tags, 'cheated', 'true')) return null;
  // Active events may have score=0 in the very first second of a run; for
  // finals we still want score>0 to weed out 0-score garbage. Differentiate
  // the validation based on the state tag.
  const stateTag = readTag(event.tags, 'state');
  const isActive = stateTag === 'active';
  const score = parseInt(readTag(event.tags, 'score') ?? '', 10);
  if (!Number.isFinite(score)) return null;
  if (!isActive && score <= 0) return null;
  const playerPubkey = readTag(event.tags, 'p');
  if (!playerPubkey || !/^[0-9a-f]{64}$/i.test(playerPubkey)) return null;
  const ageMs = nowMs - event.created_at * 1000;
  // Drop orphaned actives — old state='active' events from runs the
  // player never finished/claimed. They have no companion kind 30763
  // ghost (gamestr-spec replay) so the card would forever show
  // 'IN PROGRESS' with no replay to open.
  if (isActive && ageMs > ORPHANED_ACTIVE_MAX_AGE_MS) return null;
  const isLive = isActive && ageMs < LIVE_FRESHNESS_MS;
  const stateOut: 'active' | 'final' | null =
    isActive ? 'active' : stateTag === 'final' ? 'final' : null;
  return {
    pubkey: playerPubkey,
    score,
    wave: parseInt(readTag(event.tags, 'wave') ?? '0', 10) || 0,
    sats: parseInt(readTag(event.tags, 'sats') ?? '0', 10) || 0,
    createdAt: event.created_at,
    eventId: event.id,
    seed: readTag(event.tags, 'seed'),
    state: stateOut,
    isLive,
  };
}

/** Snapshot of the subscription's progress, for surface-level status copy. */
export interface SubscriptionStatus {
  /** Total relays we've attempted to connect to. */
  relaysAttempted: number;
  /** Relays that have signalled EOSE (initial backfill done). */
  relaysSettled: number;
  /** True once at least one relay has settled with no matching events. */
  emptyConfirmed: boolean;
}

/**
 * Open a persistent live subscription to kind 30762 events from the
 * game pubkey. `onUpdate` is called with the latest deduplicated list
 * (one entry per pubkey, newest run wins) whenever the set changes.
 * Updates are debounced ~200ms to coalesce the initial backfill.
 *
 * `onStatus` (optional) is called as relays connect and settle so the
 * surface can show "Connecting..." → "Connected to N relays" → "No
 * runs yet" rather than getting stuck on the initial copy when the
 * filter genuinely returns zero events. The path that previously hid
 * the empty-set case is fixed here too: we treat the first EOSE as
 * confirmation that the relay has nothing matching, not as an error.
 *
 * Returns an unsubscribe — call when the surface unmounts.
 */
export function subscribeRecentRuns(
  onUpdate: (entries: WatchEntry[]) => void,
  opts: {
    relays?: readonly string[];
    limit?: number;
    onStatus?: (s: SubscriptionStatus) => void;
  } = {},
): () => void {
  let closed = false;
  let pendingEmit: number | null = null;
  const sockets: WebSocket[] = [];
  const latestByPubkey = new Map<string, WatchEntry>();
  const settledRelays = new Set<string>();
  let attempted = 0;

  const scheduleEmit = (): void => {
    if (closed || pendingEmit !== null) return;
    pendingEmit = window.setTimeout(() => {
      pendingEmit = null;
      if (closed) return;
      const entries = Array.from(latestByPubkey.values()).sort(
        (a, b) => b.createdAt - a.createdAt,
      );
      onUpdate(entries);
    }, 200);
  };

  const emitStatus = (): void => {
    if (!opts.onStatus || closed) return;
    opts.onStatus({
      relaysAttempted: attempted,
      relaysSettled: settledRelays.size,
      emptyConfirmed: settledRelays.size > 0 && latestByPubkey.size === 0,
    });
  };

  const consider = (entry: WatchEntry): void => {
    const existing = latestByPubkey.get(entry.pubkey);
    if (existing && existing.createdAt >= entry.createdAt) return;
    latestByPubkey.set(entry.pubkey, entry);
    scheduleEmit();
    emitStatus();
  };

  void (async () => {
    const info = await fetchGameInfo();
    if (closed) return;
    if (!info) {
      onUpdate([]);
      emitStatus();
      return;
    }
    // Read live-presence + recent finals from the experimental relay
    // during the roll-out. getActiveRelays is still consulted at the
    // call site if the caller wants to broaden later.
    const relays = opts.relays ?? EXPERIMENTAL_RELAYS;
    if (relays.length === 0) {
      onUpdate([]);
      emitStatus();
      return;
    }
    // Filter intentionally omits #t: the faucet's t-tags are
    // arcade/asteroids/lightning, not the game id. Author+kind is already
    // tight (only the game pubkey signs kind 30762 for Pallasite), and the
    // `game=pallasite` tag is verified in parseEntry.
    const filter = {
      kinds: [SCORE_EVENT_KIND],
      authors: [info.pubkey],
      limit: opts.limit ?? 200,
    };
    // Auto-reconnect — relays drop idle WebSockets after ~5 min and the
    // user's tab can sit open much longer than that. Some relays go
    // silent without sending a close frame, so we ALSO run a liveness
    // watchdog: if no messages arrive in 90s, force-close + reconnect.
    // Exponential backoff capped at 30s for the connect retries.
    const connect = (url: string, attempt = 0): void => {
      if (closed) return;
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { scheduleReconnect(url, attempt); return; }
      if (attempt === 0) {
        attempted += 1;
        sockets.push(ws);
      } else {
        const idx = sockets.findIndex((s) => s.readyState !== WebSocket.OPEN);
        if (idx >= 0) sockets[idx] = ws; else sockets.push(ws);
      }
      const subId = 'w' + Math.random().toString(36).slice(2, 10);
      const markSettled = (): void => {
        if (settledRelays.has(url)) return;
        settledRelays.add(url);
        emitStatus();
      };
      // Liveness watchdog — bounce the socket if it goes silent.
      let lastActivity = Date.now();
      const livenessTimer = window.setInterval(() => {
        if (closed) return;
        if (Date.now() - lastActivity < 90_000) return;
        try { ws.close(); } catch { /* ignore */ }
      }, 30_000);
      ws.onopen = () => {
        try { ws.send(JSON.stringify(['REQ', subId, filter])); } catch { /* ignore */ }
        lastActivity = Date.now();
      };
      ws.onmessage = (ev) => {
        lastActivity = Date.now();
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2] as ScoreEvent;
            const entry = parseEntry(e);
            if (entry) consider(entry);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markSettled();
          }
        } catch { /* ignore parse errors */ }
      };
      ws.onerror = markSettled;
      ws.onclose = () => {
        window.clearInterval(livenessTimer);
        markSettled();
        scheduleReconnect(url, attempt + 1);
      };
    };
    const scheduleReconnect = (url: string, attempt: number): void => {
      if (closed) return;
      const delay = Math.min(30_000, 1000 * Math.pow(1.6, attempt));
      window.setTimeout(() => connect(url, attempt), delay);
    };
    for (const url of relays) connect(url);
    emitStatus();
  })();

  return (): void => {
    closed = true;
    if (pendingEmit !== null) {
      window.clearTimeout(pendingEmit);
      pendingEmit = null;
    }
    for (const ws of sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
  };
}

/** Human-readable "X min ago" / "just now" string for a unix-sec timestamp. */
export function timeAgo(unixSec: number, nowMs: number = Date.now()): string {
  const ageSec = Math.max(0, (nowMs - unixSec * 1000) / 1000);
  if (ageSec < 30) return 'just now';
  if (ageSec < 60) return `${Math.round(ageSec)}s ago`;
  if (ageSec < 3600) return `${Math.round(ageSec / 60)}m ago`;
  if (ageSec < 86_400) return `${Math.round(ageSec / 3600)}h ago`;
  return `${Math.round(ageSec / 86_400)}d ago`;
}
