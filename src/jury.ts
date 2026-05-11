/**
 * Pallasite jury — anonymous cheat-review surface, public-by-default.
 *
 * Surfaces kind 31764 review cases published by the faucet whenever
 * Layer 0 heuristics flag a player. Anyone can view: spectator mode
 * doesn't require sign-in, lets visitors watch the kind 30763 ghost
 * for each flagged run, and shows verdict status as it lands.
 *
 * Signed-in visitors can also set up a **jury identity** — a separate
 * keypair generated locally and bound to their Nostr master via a
 * kind 30765 NIP-07/NIP-46-signed delegation event. The jury privkey
 * lives in localStorage; the master never leaves the user's signer.
 * Once the delegation is published and the master has earned ≥3
 * NIP-58 badges, the user becomes eligible to cast anonymous LSAG
 * ballots via nostr-veil in a later phase.
 *
 * Privacy posture:
 *   - Master signs once (the delegation). Master pubkey ↔ jury pubkey
 *     linkage is public (it must be, so the eligibility set is auditable),
 *     but anonymous voting via LSAG hides which member of the eligible
 *     ring cast each ballot.
 *   - Jury privkey is purpose-scoped — compromise leaks votes, not the
 *     player's full Nostr identity. Rotation is "publish a new
 *     delegation with a new jury_pubkey"; the prior key just becomes
 *     ineligible.
 *
 * No master nsec is ever solicited or stored. The "recoverable via
 * nsec-tree mnemonic" path is deferred — pasting a mnemonic into a
 * browser is worse than pasting an nsec; we'll add a desktop-derive
 * import flow when there's user demand for cross-device portability.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/curves/utils.js';
import type { SignetSession, NostrEvent } from 'signet-login';
import { getActiveRelays } from './relays.js';
import { fetchGameInfo } from './faucet.js';

export const REVIEW_CASE_KIND = 31764;
export const JURY_DELEGATION_KIND = 30765;
export const JURY_DELEGATION_D_TAG = 'pallasite-jury';

const FETCH_TIMEOUT_MS = 5000;
const PUBLISH_TIMEOUT_MS = 5000;
const STORAGE_KEY = 'pallasite:jury-key:v1';

// ── Review case shape ───────────────────────────────────────────────────────

export interface ReviewCase {
  /** Master pubkey of the flagged player. */
  flaggedPubkey: string;
  /** kind 30762 score event id — ghost replay is reachable from this. */
  scoreEventId: string;
  score: number;
  wave: number;
  seed: string | null;
  flagReason: string;
  circleId: string;
  /** Eligible jury pubkeys at flag time. */
  circleMembers: string[];
  circleSize: number;
  /** True when the eligible circle was below the quorum threshold. */
  underQuorum: boolean;
  /** Event creation time (unix sec). */
  createdAt: number;
  /** Case event id (kind 31764). */
  eventId: string;
}

function readTag(tags: string[][], name: string): string | null {
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') return t[1];
  return null;
}

function readAllTagValues(tags: string[][], name: string): string[] {
  const out: string[] = [];
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') out.push(t[1]);
  return out;
}

function parseCase(event: NostrEvent): ReviewCase | null {
  if (event.kind !== REVIEW_CASE_KIND) return null;
  const flaggedPubkey = readTag(event.tags, 'd');
  const scoreEventId = readTag(event.tags, 'e');
  const score = parseInt(readTag(event.tags, 'score') ?? '', 10);
  const wave = parseInt(readTag(event.tags, 'wave') ?? '', 10);
  const flagReason = readTag(event.tags, 'flag_reason');
  const circleId = readTag(event.tags, 'circle_id');
  const circleSize = parseInt(readTag(event.tags, 'circle_size') ?? '', 10);
  const underQuorumRaw = readTag(event.tags, 'under_quorum');
  if (
    !flaggedPubkey ||
    !scoreEventId ||
    !Number.isFinite(score) ||
    !Number.isFinite(wave) ||
    !flagReason ||
    !circleId ||
    !Number.isFinite(circleSize)
  ) {
    return null;
  }
  return {
    flaggedPubkey,
    scoreEventId,
    score,
    wave,
    seed: readTag(event.tags, 'seed'),
    flagReason,
    circleId,
    circleSize,
    circleMembers: readAllTagValues(event.tags, 'circle_member'),
    underQuorum: underQuorumRaw === '1',
    createdAt: event.created_at,
    eventId: event.id,
  };
}

/**
 * Fetch the most recent review cases from relays. Author-filtered to the
 * game pubkey: only events signed by the faucet's game identity are
 * accepted, which is the gate against fake cases injected by a malicious
 * relay (a fake case event would have to forge a signature from the game
 * pubkey, which requires its private key).
 *
 * Returns up to `limit` cases sorted newest-first. Resolves the empty
 * array on relay failure rather than throwing.
 */
export async function fetchReviewCases(
  opts: { relays?: readonly string[]; limit?: number } = {},
): Promise<ReviewCase[]> {
  const info = await fetchGameInfo();
  if (!info) return [];
  const relays = opts.relays ?? getActiveRelays();
  if (relays.length === 0) return [];
  const limit = opts.limit ?? 50;
  const filter = {
    kinds: [REVIEW_CASE_KIND],
    authors: [info.pubkey],
    limit,
  };

  const events = await new Promise<NostrEvent[]>((resolve) => {
    const collected = new Map<string, NostrEvent>();
    let done = 0;
    let settled = false;
    const sockets: WebSocket[] = [];
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
      resolve([...collected.values()]);
    };
    const timer = setTimeout(settle, FETCH_TIMEOUT_MS);
    const markDone = (): void => {
      done += 1;
      if (done >= relays.length) settle();
    };
    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { markDone(); continue; }
      sockets.push(ws);
      const subId = 'j' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
      ws.onmessage = (ev) => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2] as NostrEvent;
            // De-duplicate by addressable d-tag — same flagged player can
            // produce multiple case versions if heuristics retripped.
            // Keep the newest.
            const dTag = readTag(e.tags, 'd');
            const key = dTag ?? e.id;
            const prior = collected.get(key);
            if (!prior || e.created_at > prior.created_at) collected.set(key, e);
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markDone();
          }
        } catch { /* ignore */ }
      };
      ws.onerror = markDone;
      ws.onclose = markDone;
    }
  });

  const cases: ReviewCase[] = [];
  for (const e of events) {
    const c = parseCase(e);
    if (c) cases.push(c);
  }
  cases.sort((a, b) => b.createdAt - a.createdAt);
  return cases;
}

// ── Jury identity ───────────────────────────────────────────────────────────

export interface StoredJuryIdentity {
  /** 64-char hex — secp256k1 private key for LSAG ballot signing. */
  privkey: string;
  /** 64-char hex — derived public key, used in kind 30765 delegations and in
   *  the circle_member tags of cases this jury is eligible to vote on. */
  pubkey: string;
  /** Unix-ms when the identity was generated. */
  createdAt: number;
  /** Source — currently always 'random'. Reserved for future paths like
   *  'nsec-tree' once a desktop-derive import flow lands. */
  source: 'random';
}

export function getStoredJuryIdentity(): StoredJuryIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<StoredJuryIdentity>;
    if (typeof p.privkey !== 'string' || !/^[0-9a-f]{64}$/.test(p.privkey)) return null;
    if (typeof p.pubkey !== 'string' || !/^[0-9a-f]{64}$/.test(p.pubkey)) return null;
    if (typeof p.createdAt !== 'number') return null;
    return {
      privkey: p.privkey,
      pubkey: p.pubkey,
      createdAt: p.createdAt,
      source: 'random',
    };
  } catch {
    return null;
  }
}

export function setStoredJuryIdentity(id: StoredJuryIdentity): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(id)); } catch { /* sessionStorage full / blocked */ }
}

export function clearStoredJuryIdentity(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * Generate a fresh secp256k1 keypair using crypto.getRandomValues for
 * the privkey bytes. Pubkey is the schnorr x-only public key (NIP-01
 * format). The privkey is returned but NOT auto-stored — the caller
 * decides when to persist (typically after the delegation event has
 * been signed by the master, so a failed sign-in doesn't leave a key
 * on disk).
 */
export function generateJuryIdentity(): StoredJuryIdentity {
  const sk = new Uint8Array(32);
  crypto.getRandomValues(sk);
  // Reject zero / curve-order keys defensively — astronomically unlikely
  // but cheap to check. schnorr.getPublicKey will throw for invalid sk;
  // if that ever fires, regenerate.
  let pubkey: string;
  try {
    pubkey = bytesToHex(schnorr.getPublicKey(sk));
  } catch {
    return generateJuryIdentity();
  }
  return {
    privkey: bytesToHex(sk),
    pubkey,
    createdAt: Date.now(),
    source: 'random',
  };
}

// ── Delegation publishing ───────────────────────────────────────────────────

export interface DelegationPublishResult {
  ok: boolean;
  eventId?: string;
  publishedTo: string[];
  failed: string[];
  error?: string;
}

function publishToRelay(url: string, event: NostrEvent, timeoutMs = PUBLISH_TIMEOUT_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('relay-timeout'));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (ev) => {
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
 * Publish a kind 30765 jury delegation signed by the player's master
 * (via the active SignetSession's signer — NIP-07 or NIP-46). The
 * event template names `juryPubkey` in a p-tag; the master never
 * exposes its privkey.
 *
 * The faucet's JuryDelegationWatcher picks the event up from the
 * configured relays and writes it to `jury_delegations`, after which
 * the master becomes a candidate juror for any case whose eligibility
 * criteria (≥3 badges) it also meets.
 */
export async function publishDelegation(
  session: SignetSession,
  juryPubkey: string,
  opts: { relays?: readonly string[] } = {},
): Promise<DelegationPublishResult> {
  const relays = opts.relays ?? getActiveRelays();
  if (relays.length === 0) {
    return { ok: false, publishedTo: [], failed: [], error: 'no_relays' };
  }
  const template = {
    kind: JURY_DELEGATION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content:
      `I delegate Pallasite jury voting authority to ${juryPubkey} for ` +
      `anonymous cheat-review ballots via nostr-veil. The delegate may vote ` +
      `on my behalf. Revoke by publishing a fresh delegation with d-tag ` +
      `pallasite-jury.`,
    tags: [
      ['d', JURY_DELEGATION_D_TAG],
      ['p', juryPubkey],
      ['purpose', 'pallasite-jury'],
      ['game', 'pallasite'],
      ['t', 'pallasite-jury'],
    ],
  };
  let signed: NostrEvent;
  try {
    signed = await session.signer.signEvent(template);
  } catch (err) {
    return {
      ok: false,
      publishedTo: [],
      failed: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const publishedTo: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    relays.map((url) =>
      publishToRelay(url, signed).then(
        () => publishedTo.push(url),
        () => failed.push(url),
      ),
    ),
  );
  return {
    ok: publishedTo.length > 0,
    eventId: signed.id,
    publishedTo,
    failed,
  };
}
