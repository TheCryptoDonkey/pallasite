/**
 * Pallasite-faucet HTTP client.
 *
 * Three endpoints used by the frontend:
 *   GET  /api/game-pubkey  — bootstrap the game's signing identity
 *   GET  /api/pool         — float / paid lifetime numbers for the title chip
 *   POST /api/claim        — NIP-98-authed claim submit, returns payout
 *
 * All requests are same-origin: in dev, Vite proxies /api/* to the local
 * faucet on 127.0.0.1:8787; in prod, nginx proxies /api/* to the faucet
 * unit on the same box. No CORS, no cross-origin cookies.
 */

import type { SignetSession } from 'signet-login';

const API_BASE = '/api';

export interface GameInfo {
  pubkey: string;
  npub: string | null;
  relays: readonly string[];
}

let cachedGameInfo: GameInfo | null = null;

export async function fetchGameInfo(): Promise<GameInfo | null> {
  if (cachedGameInfo) return cachedGameInfo;
  try {
    const res = await fetch(`${API_BASE}/game-pubkey`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok?: boolean;
      pubkey?: string;
      npub?: string | null;
      relays?: string[];
    };
    if (!data.ok || typeof data.pubkey !== 'string' || !Array.isArray(data.relays)) {
      return null;
    }
    cachedGameInfo = {
      pubkey: data.pubkey,
      npub: data.npub ?? null,
      relays: data.relays,
    };
    return cachedGameInfo;
  } catch {
    return null;
  }
}

export interface PoolStatus {
  paused: boolean;
  /** Sats already paid out today (cap counter). */
  daily_spent_sats?: number;
  /** Daily payout cap, beyond which the faucet rejects further claims. */
  daily_cap_sats?: number;
  /** Unix-ms when today's counter resets (next 00:00 UTC). */
  daily_reset_at?: number;
}

export async function fetchPool(): Promise<PoolStatus | null> {
  try {
    const res = await fetch(`${API_BASE}/pool`, { cache: 'no-cache' });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      ok?: boolean;
      paused?: boolean;
      daily_spent_sats?: number;
      daily_cap_sats?: number;
      daily_reset_at?: number;
    };
    if (!data.ok) return null;
    return {
      paused: Boolean(data.paused),
      ...(typeof data.daily_spent_sats === 'number'
        ? { daily_spent_sats: data.daily_spent_sats }
        : {}),
      ...(typeof data.daily_cap_sats === 'number'
        ? { daily_cap_sats: data.daily_cap_sats }
        : {}),
      ...(typeof data.daily_reset_at === 'number'
        ? { daily_reset_at: data.daily_reset_at }
        : {}),
    };
  } catch {
    return null;
  }
}

export type PlayerTier = 'anon' | 'nip05' | 'close' | 'verified';

export interface PlayerStatus {
  pubkey: string;
  tier: PlayerTier;
  /** Sats credited but not yet withdrawn — the player's spendable bank. */
  balance_sats: number;
  /** Lifetime total ever credited (covers both withdrawn and held in balance).
   *  Compared against `lifetime_cap_sats` for the tier-progress display. */
  lifetime_paid_sats: number;
  lifetime_cap_sats: number;
  multiplier: number;
  claims_count: number;
  best_score: number;
  best_wave: number;
  flagged: boolean;
}

const VALID_TIERS: ReadonlySet<PlayerTier> = new Set([
  'anon',
  'nip05',
  'close',
  'verified',
]);

export async function fetchPlayer(pubkey: string): Promise<PlayerStatus | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  try {
    const res = await fetch(`${API_BASE}/player/${pubkey.toLowerCase()}`, {
      cache: 'no-cache',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<PlayerStatus> & { ok?: boolean };
    if (
      !data.ok ||
      typeof data.pubkey !== 'string' ||
      typeof data.lifetime_paid_sats !== 'number' ||
      typeof data.lifetime_cap_sats !== 'number' ||
      typeof data.tier !== 'string' ||
      !VALID_TIERS.has(data.tier as PlayerTier)
    ) {
      return null;
    }
    return {
      pubkey: data.pubkey,
      tier: data.tier as PlayerTier,
      balance_sats: data.balance_sats ?? 0,
      lifetime_paid_sats: data.lifetime_paid_sats,
      lifetime_cap_sats: data.lifetime_cap_sats,
      multiplier: data.multiplier ?? 0,
      claims_count: data.claims_count ?? 0,
      best_score: data.best_score ?? 0,
      best_wave: data.best_wave ?? 0,
      flagged: Boolean(data.flagged),
    };
  } catch {
    return null;
  }
}

export interface ClaimInput {
  score: number;
  wave: number;
  duration_ms: number;
  started_at: number;
  finished_at: number;
  sats_claimed: number;
  /** Optional now — the LN address is used at withdraw time, not claim
   *  time. Older clients that include it have it stored on the server
   *  claim row for audit. */
  lightning_address?: string;
  cheated?: boolean;
  daily_seed?: string;
  telemetry?: Record<string, unknown>;
}

export type ClaimResult =
  | {
      ok: true;
      /** Sats credited to balance on this claim, inclusive of pity. */
      payout_sats: number;
      score_event_id: string;
      /** Player's balance after this credit. */
      new_balance: number;
      /** Player's lifetime credit total (for tier-cap display). */
      lifetime_paid_sats: number;
      /** Pity bonus included in payout_sats (0 / missing when no pity). */
      pity_bonus?: number;
      status: 'credited';
      published?: { ok: number; total: number };
    }
  | {
      ok: false;
      error: string;
      detail?: string;
    };

export interface WithdrawInput {
  amount_sats: number;
  lightning_address: string;
}

export type WithdrawResult =
  | {
      ok: true;
      amount_sats: number;
      payment_hash: string;
      new_balance: number;
    }
  | { ok: false; error: string; detail?: string };

async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function utf8Base64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * POST /api/claim with a NIP-98-signed Authorization header.
 *
 * Returns a discriminated `ClaimResult`. Network and signing failures
 * are reflected as `ok: false` with a recognisable `error` string —
 * callers don't need to try/catch.
 */
export async function submitClaim(
  session: SignetSession,
  input: ClaimInput,
): Promise<ClaimResult> {
  if (!session.signer.capabilities.canSignEvents) {
    return { ok: false, error: 'no_signer' };
  }
  const url = `${location.origin}${API_BASE}/claim`;
  const bodyJson = JSON.stringify(input);
  const payloadHash = await sha256Hex(bodyJson);

  const authTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['payload', payloadHash],
    ],
  };

  let signedAuth;
  try {
    // Some NIP-07 extensions can hang if the host page is in a state where
    // popup approval can't fire (no recent user gesture, popup blocker,
    // service-worker restart). Wrap with a hard cap so the claim button
    // doesn't sit disabled forever — 30s is generous for any real signer.
    const SIGN_TIMEOUT_MS = 30_000;
    signedAuth = await Promise.race([
      session.signer.signEvent(authTemplate),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('signer-timeout')), SIGN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[claim] signEvent failed', {
      method: session.method,
      canSignEvents: session.signer.capabilities.canSignEvents,
      error: err,
    });
    return { ok: false, error: 'sign_failed', detail };
  }

  const authToken = `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/claim`, {
      method: 'POST',
      headers: {
        authorization: authToken,
        'content-type': 'application/json',
      },
      body: bodyJson,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'bad_response', detail: `HTTP ${res.status}` };
  }

  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'bad_response' };
  }
  return data as ClaimResult;
}

/**
 * POST /api/withdraw with a NIP-98-signed Authorization header. Debits
 * the player's accumulated balance and pays a Lightning invoice fetched
 * from the supplied LN address. Same NIP-98 signing pattern as submitClaim.
 */
export async function submitWithdraw(
  session: SignetSession,
  input: WithdrawInput,
): Promise<WithdrawResult> {
  if (!session.signer.capabilities.canSignEvents) {
    return { ok: false, error: 'no_signer' };
  }
  const url = `${location.origin}${API_BASE}/withdraw`;
  const bodyJson = JSON.stringify(input);
  const payloadHash = await sha256Hex(bodyJson);

  const authTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['payload', payloadHash],
    ],
  };

  let signedAuth;
  try {
    const SIGN_TIMEOUT_MS = 30_000;
    signedAuth = await Promise.race([
      session.signer.signEvent(authTemplate),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('signer-timeout')), SIGN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[withdraw] signEvent failed', {
      method: session.method,
      canSignEvents: session.signer.capabilities.canSignEvents,
      error: err,
    });
    return { ok: false, error: 'sign_failed', detail };
  }

  const authToken = `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/withdraw`, {
      method: 'POST',
      headers: {
        authorization: authToken,
        'content-type': 'application/json',
      },
      body: bodyJson,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'bad_response', detail: `HTTP ${res.status}` };
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'bad_response' };
  }
  return data as WithdrawResult;
}

export type CheckinResult =
  | {
      ok: true;
      credited: number;
      already_checked_in_today: boolean;
      new_balance: number;
    }
  | { ok: false; error: string; detail?: string };

/**
 * POST /api/checkin — daily check-in stipend. NIP-98 authed, idempotent
 * per UTC day. Credits 1 sat to balance for signed-in title visits.
 * Failures are silent (network blip, signer hiccup) — the chip just
 * doesn't update; the next day's call retries naturally.
 */
export async function submitCheckin(
  session: SignetSession,
): Promise<CheckinResult> {
  if (!session.signer.capabilities.canSignEvents) {
    return { ok: false, error: 'no_signer' };
  }
  const url = `${location.origin}${API_BASE}/checkin`;
  const bodyJson = '{}';
  const payloadHash = await sha256Hex(bodyJson);

  const authTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', url],
      ['method', 'POST'],
      ['payload', payloadHash],
    ],
  };

  let signedAuth;
  try {
    const SIGN_TIMEOUT_MS = 30_000;
    signedAuth = await Promise.race([
      session.signer.signEvent(authTemplate),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('signer-timeout')), SIGN_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    return {
      ok: false,
      error: 'sign_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const authToken = `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/checkin`, {
      method: 'POST',
      headers: {
        authorization: authToken,
        'content-type': 'application/json',
      },
      body: bodyJson,
    });
  } catch (err) {
    return {
      ok: false,
      error: 'network_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, error: 'bad_response', detail: `HTTP ${res.status}` };
  }
  if (typeof data !== 'object' || data === null) {
    return { ok: false, error: 'bad_response' };
  }
  return data as CheckinResult;
}
