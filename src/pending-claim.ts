/**
 * Pending-claim recovery.
 *
 * If a sats claim fails after the run is over (signer rejected, network
 * blip, recap idle-skip fired before retry), the run state is gone and
 * the player has no way to retry — the sats they earned in that run are
 * effectively orphaned. The faucet has a 5-minute (started_at, finished_at)
 * replay window, so anything saved within that window can be resubmitted
 * verbatim and the server will accept it.
 *
 * We persist the full ClaimInput payload to localStorage at the moment
 * the player taps CLAIM, before submitClaim() fires. On terminal failures
 * we drop it (cap reached / cheated / payload-invalid won't get better on
 * retry). On transient failures (signer hiccup, network) we keep it. The
 * title screen looks for a fresh entry on next mount and offers a one-tap
 * retry banner above the IGNITE button.
 *
 * Keyed by the player pubkey so signing out / switching identity can't
 * surface someone else's pending claim.
 */

import type { ClaimInput } from './faucet.js';

const KEY = 'pallasite:pendingClaim';

/** Server side rejects claims older than 5 min (STALE_RUN_MS). We
 *  preserve a small headroom so we don't surface a banner that will
 *  immediately fail with stale_run. */
const TTL_MS = 4 * 60 * 1000 + 30 * 1000;

export interface PendingClaim {
  pubkey: string;
  payload: ClaimInput;
  savedAt: number;
}

function read(): PendingClaim | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingClaim;
    if (!parsed || typeof parsed.pubkey !== 'string' || !parsed.payload) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Save a pending claim. Overwrites any previous entry — the most recent
 *  unclaimed run is the only one worth retrying. */
export function savePendingClaim(pubkey: string, payload: ClaimInput): void {
  try {
    const record: PendingClaim = { pubkey, payload, savedAt: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    // Quota / disabled storage — silently skip; the in-memory claim flow
    // still works, only the cross-navigation recovery is lost.
  }
}

export function clearPendingClaim(): void {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** Read a pending claim for the given pubkey, but only if it is still
 *  within the server replay window. Anything older is dropped on read
 *  so we don't leave stale entries hanging around. */
export function getFreshPendingClaim(pubkey: string): PendingClaim | null {
  const rec = read();
  if (!rec) return null;
  if (rec.pubkey !== pubkey) return null;
  if (Date.now() - rec.savedAt > TTL_MS) {
    clearPendingClaim();
    return null;
  }
  return rec;
}

/** Errors where retrying would just fail again — clear immediately so
 *  the banner doesn't keep nagging the player. */
const TERMINAL_ERRORS: ReadonlySet<string> = new Set([
  'cap_reached',
  'cheated_run',
  'invalid_score',
  'invalid_duration',
  'invalid_run_clock',
  'stale_run',
  'invalid_lightning_address',
  'invalid_payload',
  'player_flagged',
  'replay_of_failed_claim',
  'service_not_configured',
]);

export function isTerminalClaimError(error: string): boolean {
  return TERMINAL_ERRORS.has(error);
}
