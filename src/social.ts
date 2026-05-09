/**
 * Nostr social actions — follow (NIP-02), share (kind 1), endorse (NIP-85).
 *
 * All three are signed by the active SignetSession and published to the same
 * relay set. Follow fetches the player's existing kind 3 first so we append
 * rather than overwrite. Endorse uses kind 30382 per nostr-veil's NIP-85
 * builder convention.
 */

import type { SignetSession, NostrEvent } from 'signet-login';
import { getActiveRelays } from './relays.js';

export interface PublishResult {
  event: NostrEvent;
  publishedTo: string[];
  failed: string[];
}

// ── Relay primitives ─────────────────────────────────────────────────────────

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

async function publishAll(event: NostrEvent, relays: readonly string[]): Promise<PublishResult> {
  const publishedTo: string[] = [];
  const failed: string[] = [];
  await Promise.all(relays.map(url => publishToRelay(url, event).then(
    () => publishedTo.push(url),
    () => failed.push(url),
  )));
  return { event, publishedTo, failed };
}

/** Query relays for the latest event matching a filter. Returns null on EOSE with no matches. */
function queryLatest(url: string, filter: Record<string, unknown>, timeoutMs = 4000): Promise<NostrEvent | null> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      resolve(null);
      return;
    }
    const subId = 'q' + Math.random().toString(36).slice(2, 10);
    let latest: NostrEvent | null = null;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      resolve(latest);
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, filter]));
    ws.onmessage = ev => {
      try {
        const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const e = msg[2] as NostrEvent;
          if (!latest || e.created_at > latest.created_at) latest = e;
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          clearTimeout(timer);
          try { ws.close(); } catch { /* ignore */ }
          resolve(latest);
        }
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); resolve(null); };
  });
}

async function fetchLatestFromAny(filter: Record<string, unknown>, relays: readonly string[]): Promise<NostrEvent | null> {
  const results = await Promise.all(relays.map(r => queryLatest(r, filter)));
  let latest: NostrEvent | null = null;
  for (const e of results) {
    if (e && (!latest || e.created_at > latest.created_at)) latest = e;
  }
  return latest;
}

// ── Follow (NIP-02 kind 3) ───────────────────────────────────────────────────

/**
 * Append `targetPubkey` to the player's contact list and re-publish kind 3.
 *
 * Fetches the most recent kind 3 first so we preserve existing follows + the
 * relay-list metadata commonly stored in the content field. If the player has
 * no contact list yet, creates a fresh one with just this entry.
 */
export async function followUser(
  session: SignetSession,
  targetPubkey: string,
  relays: readonly string[] = getActiveRelays(),
): Promise<PublishResult & { alreadyFollowing: boolean }> {
  const existing = await fetchLatestFromAny(
    { kinds: [3], authors: [session.pubkey], limit: 1 },
    relays,
  );

  let tags: string[][] = [];
  let content = '';
  if (existing) {
    tags = existing.tags.map(t => [...t]);
    content = existing.content;
    const alreadyFollowing = tags.some(t => t[0] === 'p' && t[1] === targetPubkey);
    if (alreadyFollowing) {
      return { event: existing, publishedTo: [], failed: [], alreadyFollowing: true };
    }
  }
  tags.push(['p', targetPubkey]);

  const signed = await session.signer.signEvent({ kind: 3, content, tags });
  const result = await publishAll(signed, relays);
  return { ...result, alreadyFollowing: false };
}

// ── Share (kind 1 note) ──────────────────────────────────────────────────────

export async function shareCompletion(
  session: SignetSession,
  data: { score: number; sats: number; wave: number; runTimeSec: number },
  relays: readonly string[] = getActiveRelays(),
): Promise<PublishResult> {
  const min = Math.floor(data.runTimeSec / 60);
  const sec = data.runTimeSec % 60;
  const timeStr = `${min}:${sec.toString().padStart(2, '0')}`;
  const isComplete = data.wave >= 25;

  const headline = isComplete
    ? `Pallasite — completed all 24 specimens + Event Horizon in ${timeStr}.`
    : `Pallasite — wave ${data.wave}, score ${data.score.toLocaleString()}, ${data.sats} sats in ${timeStr}.`;

  const body = `${headline}\n\nShoot rocks. Stack sats.\n\n#pallasite`;

  const signed = await session.signer.signEvent({
    kind: 1,
    content: body,
    tags: [
      ['t', 'pallasite'],
      ['t', 'arcade'],
      ['t', 'lightning'],
      ['t', 'nostr'],
    ],
  });
  return publishAll(signed, relays);
}

// ── Endorse (NIP-85 kind 30382 user assertion) ───────────────────────────────

/**
 * Publish a NIP-85 user assertion endorsing `subjectPubkey`.
 *
 * Tag layout matches nostr-veil's `buildUserAssertion`: d-tag and p-tag both
 * point to the subject pubkey, plus metric tags. The signer is the provider.
 *
 * @param rank 0-100 score; mapped from player's furthest wave reached
 * @param endorsementContext free-form tag describing why (e.g. 'pallasite-complete')
 */
export async function endorseSubject(
  session: SignetSession,
  subjectPubkey: string,
  rank: number,
  endorsementContext: string,
  relays: readonly string[] = getActiveRelays(),
): Promise<PublishResult> {
  const clampedRank = Math.max(0, Math.min(100, Math.round(rank)));
  const signed = await session.signer.signEvent({
    kind: 30382,
    content: '',
    tags: [
      ['d', subjectPubkey],
      ['p', subjectPubkey],
      ['rank', clampedRank.toString()],
      ['context', endorsementContext],
      ['t', 'pallasite'],
    ],
  });
  return publishAll(signed, relays);
}

/**
 * Convert the player's furthest wave reached into a rank score 0-100.
 * Reaching wave 25 (boss) caps at 100; lower waves scale linearly.
 */
export function rankFromWave(wave: number): number {
  if (wave >= 25) return 100;
  if (wave <= 0) return 0;
  return Math.round((wave / 25) * 95);  // 95 max if not completed; full 100 only on completion
}
