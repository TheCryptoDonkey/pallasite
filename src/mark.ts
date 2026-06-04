/**
 * Pallasite Mark — the player's self-published wave-25 ending choice (a NIP-85
 * kind 30382 assertion, signed by their own key). 'return' = carried the chain
 * home; 'forged' = stepped through the gate and became one of the makers.
 * Cosmetic + narrative; no authority issues it. The LOCAL mark (ui.ts
 * `pallasite:mark`) is written first (Slice 5); this is the publish layer.
 *
 * This is the *claim* layer only — a self-signed assertion, not proof. The
 * zero-trust version (a `run_id` linking to a re-simulatable input-log replay)
 * is a separate dependency: today's kind 30764 replay is a forgeable world-state
 * stream (`docs/b3-verifiable-replay.md`). When a `run_id` is available it's
 * linked via an `e` tag so the verifiable layer can read it later.
 *
 * See docs/pallasite-arc.md §6–7. Best-effort: relay failures are swallowed so
 * the completion screen never breaks.
 */
import type { SignetSession, NostrEvent } from 'signet-login';
import { GAME_ID } from './auth.js';
import { getActiveRelays } from './relays.js';
import { EXPERIMENTAL_RELAYS } from './credits.js';

/** NIP-85 addressable assertion. The Mark is a self-assertion (d = own pubkey),
 *  so re-completing replaces it with the latest choice. */
const PALLASITE_MARK_KIND = 30382;

/** Open a relay, send the event, resolve on OK-accept. Same shape as the
 *  publishToRelay copies in score.ts / ghost.ts / guest.ts. */
function publishToRelay(url: string, event: NostrEvent, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
    const timer = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } reject(new Error('relay-timeout')); }, timeoutMs);
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

export interface MarkPublishResult {
  /** The signed kind 30382 event (always present — the Mark is sealed locally
   *  even if no relay accepts it). */
  event: NostrEvent;
  /** True once at least one relay accepted the event. False = signed but
   *  unreachable relays; the Mark still stands locally. */
  relayed: boolean;
}

/** Sign + broadcast the Pallasite Mark (kind 30382). Returns the signed event +
 *  whether any relay accepted it, or null when the session can't sign at all.
 *  Best-effort across relays. `runId` (the kind 30764 replay event id) is linked
 *  when available. Throws only if signing itself fails. */
export async function publishPallasiteMark(
  session: SignetSession,
  mark: 'return' | 'forged',
  runId?: string,
): Promise<MarkPublishResult | null> {
  if (!session.signer.capabilities.canSignEvents) return null;

  const tags: string[][] = [
    ['d', session.pubkey],          // self-assertion — the latest Mark replaces
    ['pallasite_mark', mark],
    ['at_wave', '25'],
    ['game', GAME_ID],
    ['t', 'pallasite'],
  ];
  // The run reference: `run_id` is the doc's named field (docs/pallasite-arc.md
  // §7), `e` is the Nostr-idiomatic event pointer relays index for fetch-by-ref.
  // Linked only when the verifiable layer supplies a replay id; the basic claim
  // ships without it (today's kind 30764 replay is forgeable — see b3 doc).
  if (runId) { tags.push(['run_id', runId], ['e', runId]); }

  const content = mark === 'forged'
    ? 'Stepped through the gate at wave 25. Forgesworn.'
    : 'Carried the chain home from wave 25.';

  const signed = await session.signer.signEvent({ kind: PALLASITE_MARK_KIND, content, tags });

  const relays = new Set<string>([...getActiveRelays(), ...EXPERIMENTAL_RELAYS]);
  const results = await Promise.allSettled([...relays].map(url => publishToRelay(url, signed)));
  return { event: signed, relayed: results.some(r => r.status === 'fulfilled') };
}
