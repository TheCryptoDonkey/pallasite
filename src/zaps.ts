/**
 * Watch-page zap aggregator. Subscribes to kind 9735 (NIP-57 zap receipt)
 * across the default relay set, filtered to a known set of player pubkeys
 * (the recipients from kind 30762 score events). Walks each receipt's
 * `description` tag — which contains the original kind 9734 zap request
 * as a JSON string — to recover the msat amount and recipient pubkey,
 * then aggregates totals per recipient.
 *
 * Lives client-side for v1 — every visitor re-aggregates. The faucet
 * version with SQLite caching is a follow-up if/when this gets slow.
 *
 * Why not parse bolt11 directly? The receipt has a `bolt11` tag with the
 * paid invoice, but BOLT-11 amount encoding is a fiddly base32-multiplier
 * format. NIP-57 mandates that the description contains the zap request
 * with an `amount` tag in msats, so we read that instead. ~40 lines saved.
 */
import type { NostrEvent } from 'signet-login';
import { DEFAULT_RELAYS } from './credits.js';

export const ZAP_RECEIPT_KIND = 9735;
export const ZAP_REQUEST_KIND = 9734;

export interface ZapTotals {
  /** Total sats received across all observed receipts. */
  sats: number;
  /** Number of distinct zap receipts. */
  count: number;
}

/** A single emit: aggregated totals keyed by recipient pubkey. */
export type ZapTotalsByPubkey = ReadonlyMap<string, ZapTotals>;

function readTag(tags: string[][], name: string): string | null {
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') return t[1];
  return null;
}

/**
 * Parse a kind 9735 receipt's `description` tag (the nested kind 9734
 * zap request, serialised as JSON) and return {recipient, sats} when the
 * receipt is well-formed. NIP-57 says the description's zap request is
 * authoritative for amount + recipient; the receipt's outer event is
 * signed by the LN provider, not the zapper.
 */
export function parseZapReceipt(event: NostrEvent): { recipient: string; sats: number } | null {
  if (event.kind !== ZAP_RECEIPT_KIND) return null;
  const desc = readTag(event.tags, 'description');
  if (!desc) return null;
  let zapReq: { kind?: number; tags?: string[][] };
  try { zapReq = JSON.parse(desc); } catch { return null; }
  if (!zapReq || zapReq.kind !== ZAP_REQUEST_KIND || !Array.isArray(zapReq.tags)) return null;
  const recipient = readTag(zapReq.tags, 'p');
  const amountStr = readTag(zapReq.tags, 'amount');
  if (!recipient || !/^[0-9a-f]{64}$/i.test(recipient)) return null;
  if (!amountStr) return null;
  const msats = parseInt(amountStr, 10);
  if (!Number.isFinite(msats) || msats <= 0) return null;
  // Floor — partial sats happen in theory but in practice all amounts are
  // whole-sat multiples of 1000 msats. Cap absurd values to defend against
  // a malformed receipt blowing up the leaderboard.
  const sats = Math.min(Math.floor(msats / 1000), 100_000_000);
  if (sats <= 0) return null;
  return { recipient: recipient.toLowerCase(), sats };
}

/**
 * Open a persistent subscription to kind 9735 zap receipts for the given
 * set of recipient pubkeys. Aggregates totals per recipient and calls
 * `onUpdate` with the latest snapshot whenever new receipts land. Emits
 * are debounced ~250ms so the initial backfill coalesces into one paint.
 *
 * Returns an unsubscribe. Caller should re-subscribe (close + reopen)
 * when the player set materially changes — relay REQ filters are fixed
 * at subscribe time. For the watch page we accept "join after first
 * batch arrives" semantics; late-arriving players won't have zap totals
 * surfaced until the next page-mount.
 */
export function subscribeZapTotals(
  recipientPubkeys: readonly string[],
  onUpdate: (totals: ZapTotalsByPubkey) => void,
  opts: { relays?: readonly string[]; limit?: number } = {},
): () => void {
  let closed = false;
  let pendingEmit: number | null = null;
  const sockets: WebSocket[] = [];
  const totals = new Map<string, ZapTotals>();
  // De-dupe across relays — the same receipt can land on every relay in
  // the set, so a Set keyed on event id keeps each receipt counted once.
  const seenEventIds = new Set<string>();

  if (recipientPubkeys.length === 0) {
    onUpdate(totals);
    return () => { /* nothing to tear down */ };
  }

  // Normalise to lowercase hex — the parsed receipt recipient is already
  // lowercased, so callers passing mixed-case pubkeys still match.
  const pubkeySet = new Set(recipientPubkeys.map((p) => p.toLowerCase()));

  const scheduleEmit = (): void => {
    if (closed || pendingEmit !== null) return;
    pendingEmit = window.setTimeout(() => {
      pendingEmit = null;
      if (closed) return;
      onUpdate(totals);
    }, 250);
  };

  const apply = (event: NostrEvent): void => {
    if (seenEventIds.has(event.id)) return;
    seenEventIds.add(event.id);
    const parsed = parseZapReceipt(event);
    if (!parsed) return;
    if (!pubkeySet.has(parsed.recipient)) return;
    const cur = totals.get(parsed.recipient);
    if (cur) {
      cur.sats += parsed.sats;
      cur.count += 1;
    } else {
      totals.set(parsed.recipient, { sats: parsed.sats, count: 1 });
    }
    scheduleEmit();
  };

  const relays = opts.relays ?? DEFAULT_RELAYS;
  // Bigger limit than the score subscription — zap receipts accrue at a
  // higher rate per player than runs do, and we want the historical
  // total, not just the recent slice.
  const filter = {
    kinds: [ZAP_RECEIPT_KIND],
    '#p': Array.from(pubkeySet),
    limit: opts.limit ?? 1000,
  };

  const connect = (url: string, attempt = 0): void => {
    if (closed) return;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { scheduleReconnect(url, attempt); return; }
    sockets.push(ws);
    const subId = 'z' + Math.random().toString(36).slice(2, 10);
    // Liveness watchdog — relays sometimes go silent without a close
    // frame. Match the score subscription's approach (90s idle = bounce).
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
          apply(msg[2] as NostrEvent);
        }
      } catch { /* ignore parse errors */ }
    };
    ws.onerror = () => { /* swallow — onclose handles reconnect */ };
    ws.onclose = () => {
      window.clearInterval(livenessTimer);
      scheduleReconnect(url, attempt + 1);
    };
  };

  const scheduleReconnect = (url: string, attempt: number): void => {
    if (closed) return;
    const delay = Math.min(30_000, 1000 * Math.pow(1.6, attempt));
    window.setTimeout(() => connect(url, attempt), delay);
  };

  for (const url of relays) connect(url);

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
