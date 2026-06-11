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
import type { RunMode } from './mode.js';

const API_BASE = '/api';

/** Public origin the faucet sees, used ONLY for the NIP-98 `u`-tag we sign
 *  (the actual fetch stays same-origin `/api/...`). On a normal web deploy this
 *  is the page origin. On the booth AppImage the page is served from
 *  `http://127.0.0.1:8123` but `/api` is reverse-proxied to the public faucet,
 *  so a `u` tag signed for localhost fails the faucet's url check (401
 *  `url_mismatch`) — every score/claim/withdraw silently rejected. The booth's
 *  static server injects `window.__PALLASITE_API_ORIGIN__` = the public faucet
 *  origin so the auth is signed for the host the faucet actually reconstructs. */
function apiOrigin(): string {
  const override = (globalThis as { __PALLASITE_API_ORIGIN__?: unknown }).__PALLASITE_API_ORIGIN__;
  return typeof override === 'string' && override ? override.replace(/\/+$/, '') : location.origin;
}

export interface GameInfo {
  pubkey: string;
  npub: string | null;
  relays: readonly string[];
  /** Pubkey allowed to access /admin. Null if not configured. */
  admin_pubkey: string | null;
}

/** True iff the supplied session pubkey matches the server's
 *  configured admin pubkey. Server still enforces the allowlist on
 *  every action; this is purely for client-side UI gating (showing
 *  the ADMIN button). */
export function isAdminSession(sessionPubkey: string | undefined | null): boolean {
  if (!sessionPubkey) return false;
  const admin = cachedGameInfo?.admin_pubkey;
  if (!admin) return false;
  return admin.toLowerCase() === sessionPubkey.toLowerCase();
}

let cachedGameInfo: GameInfo | null = null;

/**
 * Server-driven gameplay config. Client fetches at boot and caches.
 * Read-only from the client's perspective; admin mutates via the
 * /admin panel which goes through the NIP-98-authed settings API.
 *
 * Defaults match the server's SETTING_DEFAULTS so a fetch failure
 * (offline / faucet down) doesn't change in-game behaviour from
 * what a hardcoded build would have done.
 */
export interface GameConfig {
  /** Probability (0-1) that the W9 → W10 bonus level fires on
   *  wave-9 clear. 1.0 = always; default before the admin tunes it. */
  bonus_wave_chance: number;
  /** Per-UFO-kill chance (0-1) that a power-up drops. */
  powerup_drop_chance: number;
  /** 1-in-N sat drop selector. Lower = more sats. */
  sat_drop_denom: number;
  /** Ship lives at run start. 0 = inherit from the chosen difficulty
   *  (easy=5, normal=3, hard=2). >0 = global override, applied
   *  regardless of difficulty pick. */
  starting_lives: number;
  /** UFO timing (ms). */
  ufo_first_spawn_ms: number;
  ufo_respawn_base_ms: number;
  ufo_respawn_per_wave_ms: number;
  ufo_respawn_min_ms: number;
  /** Multiplier on per-wave asteroid count (base = min(13, 4+wave)). */
  asteroid_count_multiplier: number;
}

let cachedGameConfig: GameConfig = {
  bonus_wave_chance: 1.0,
  powerup_drop_chance: 0.30,
  sat_drop_denom: 8,
  starting_lives: 0,
  ufo_first_spawn_ms: 12_000,
  ufo_respawn_base_ms: 18_000,
  ufo_respawn_per_wave_ms: 1_200,
  ufo_respawn_min_ms: 6_500,
  asteroid_count_multiplier: 1.0,
};
let gameConfigFetched = false;

export function getGameConfig(): GameConfig {
  return cachedGameConfig;
}

export async function fetchGameConfig(): Promise<GameConfig> {
  try {
    const res = await fetch(`${API_BASE}/game-config`, { cache: 'no-cache' });
    if (!res.ok) return cachedGameConfig;
    const data = (await res.json()) as { ok?: boolean; config?: Record<string, unknown> };
    if (!data.ok || !data.config) return cachedGameConfig;
    const cfg = data.config;
    const next: GameConfig = { ...cachedGameConfig };
    // Parse each known field. Type-check + clamp where it matters so
    // a fat-finger setting can't break gameplay. Unknown fields are
    // ignored (forward-compat).
    const num = (key: string, lo: number, hi: number, fallback: number): number => {
      const v = cfg[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
      return Math.max(lo, Math.min(hi, v));
    };
    next.bonus_wave_chance         = num('bonus_wave_chance',         0,        1,          next.bonus_wave_chance);
    next.powerup_drop_chance       = num('powerup_drop_chance',       0,        1,          next.powerup_drop_chance);
    next.sat_drop_denom            = num('sat_drop_denom',            1,        1_000_000,  next.sat_drop_denom);
    // starting_lives is a SENTINEL: 0 = inherit from difficulty,
    // >0 = override. Clamp lo=0 so the sentinel survives.
    next.starting_lives            = Math.floor(num('starting_lives', 0,        99,         next.starting_lives));
    next.ufo_first_spawn_ms        = num('ufo_first_spawn_ms',        0,        600_000,    next.ufo_first_spawn_ms);
    next.ufo_respawn_base_ms       = num('ufo_respawn_base_ms',       1_000,    600_000,    next.ufo_respawn_base_ms);
    next.ufo_respawn_per_wave_ms   = num('ufo_respawn_per_wave_ms',   0,        60_000,     next.ufo_respawn_per_wave_ms);
    next.ufo_respawn_min_ms        = num('ufo_respawn_min_ms',        1_000,    600_000,    next.ufo_respawn_min_ms);
    next.asteroid_count_multiplier = num('asteroid_count_multiplier', 0.1,      10,         next.asteroid_count_multiplier);
    cachedGameConfig = next;
    gameConfigFetched = true;
  } catch {
    // Fall through with whatever cache we had.
  }
  return cachedGameConfig;
}

/** True if fetchGameConfig has resolved at least once (success or
 *  fail-with-defaults). Lets the client decide whether to wait
 *  briefly before kicking off a run that would consult the config. */
export function isGameConfigReady(): boolean {
  return gameConfigFetched;
}

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
      admin_pubkey?: string | null;
    };
    if (!data.ok || typeof data.pubkey !== 'string' || !Array.isArray(data.relays)) {
      return null;
    }
    cachedGameInfo = {
      pubkey: data.pubkey,
      npub: data.npub ?? null,
      relays: data.relays,
      admin_pubkey: typeof data.admin_pubkey === 'string' ? data.admin_pubkey : null,
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
  /** Locked-in run mode (campaign / drift / arena). The faucet marks
   *  non-campaign runs with the standard NIP-12 ['t', mode] topic tag on
   *  the kind 30762 event — the same channel it already uses for the
   *  600bn flavour — so no bespoke tag is added to the gamestr schema. */
  mode?: RunMode;
  daily_seed?: string;
  /** Per-run id — the SAME value sent to /api/score. The faucet reuses it as
   *  the kind 30762 d-tag suffix so the claim REPLACES that run's 0-sat score
   *  placeholder instead of leaving a duplicate event on the relays. */
  run_id?: string;
  /** Deploy flavour the run came from. '600bn' routes through the
   *  Sanctum teaser daily-cap budget and stamps a `['t','600bn']` tag
   *  on the score event. Defaults server-side to 'main' when omitted. */
  room?: 'main' | '600bn';
  /** Display name + NIP-05 (gamestr-spec) — stamped as `playerName` / `nip05`
   *  tags on the kind 30762 so the leaderboard shows a name, not a pubkey. */
  player_name?: string;
  nip05?: string;
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
      /** Present on error === 'cooldown' (per-player velocity floor):
       *  ms the player must wait before this pubkey can claim again. */
      retry_after_ms?: number;
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

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  // Slice into a fresh ArrayBuffer so crypto.subtle never sees a
  // SharedArrayBuffer-backed view (typescript lib bundles widen
  // Uint8Array.buffer to ArrayBuffer | SharedArrayBuffer in newer
  // configs; SubtleCrypto rejects SharedArrayBuffer).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  const hash = await crypto.subtle.digest('SHA-256', ab);
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
  const url = `${apiOrigin()}${API_BASE}/claim`;
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
 * POST /api/heartbeat. Lightweight live-presence ping the watch
 * surface uses to render LIVE cards for in-progress runs. NIP-98
 * authed so the pubkey can't be impersonated.
 *
 * Errors are swallowed — heartbeats are best-effort, a transient
 * network glitch shouldn't disturb gameplay. Returns true when the
 * server accepted the heartbeat, false on any failure.
 */
export async function postHeartbeat(
  session: SignetSession,
  body: { score: number; wave: number; started_at: number; run_id: string; mode?: RunMode },
): Promise<boolean> {
  if (!session.signer.capabilities.canSignEvents) return false;
  const url = `${apiOrigin()}${API_BASE}/heartbeat`;
  const bodyJson = JSON.stringify(body);
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
    signedAuth = await Promise.race([
      session.signer.signEvent(authTemplate),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('signer-timeout')), 10_000);
      }),
    ]);
  } catch {
    return false;
  }
  try {
    const res = await fetch(`${API_BASE}/heartbeat`, {
      method: 'POST',
      headers: {
        authorization: `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`,
        'content-type': 'application/json',
      },
      body: bodyJson,
    });
    return res.ok;
  } catch {
    return false;
  }
}

export type SoloScoreResult =
  | { ok: true; id: string; published: { ok: number; total: number } }
  | { ok: false; error: string; detail?: string };

export interface SoloScoreInput {
  score: number;
  wave: number;
  duration_ms: number;
  /** Unique per-run id (e.g. String(runStartedAt)) — widens the kind 30762
   *  d-tag so each run persists as its own addressable event. */
  run_id: string;
  started_at?: number;
  finished_at?: number;
  mode?: RunMode;
  room?: 'main' | '600bn';
  /** Display name + NIP-05 (gamestr-spec) — the faucet stamps these as
   *  `playerName` / `nip05` tags so the score shows a name, not a raw pubkey. */
  player_name?: string;
  nip05?: string;
  cheated?: boolean;
}

/**
 * POST /api/score — game-signed solo score on every game-over, decoupled from
 * the payout flow. The player NIP-98 auths (identity proof only); the faucet
 * game-signs + publishes the kind 30762 (verified on Gamestr) with no payout,
 * so scores reach the leaderboard whether or not the player claims sats.
 *
 * Best-effort: callers fire-and-forget. Returns `not_deployed` on 404 so a
 * client running ahead of the faucet rollout degrades quietly.
 */
export async function submitSoloScore(
  session: SignetSession,
  input: SoloScoreInput,
): Promise<SoloScoreResult> {
  if (!session.signer.capabilities.canSignEvents) return { ok: false, error: 'no_signer' };
  const url = `${apiOrigin()}${API_BASE}/score`;
  const bodyJson = JSON.stringify(input);
  const payloadHash = await sha256Hex(bodyJson);
  const authTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', payloadHash]],
  };
  let signedAuth;
  try {
    signedAuth = await Promise.race([
      session.signer.signEvent(authTemplate),
      new Promise<never>((_, reject) => { window.setTimeout(() => reject(new Error('signer-timeout')), 30_000); }),
    ]);
  } catch (err) {
    return { ok: false, error: 'sign_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/score`, {
      method: 'POST',
      headers: {
        authorization: `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`,
        'content-type': 'application/json',
      },
      body: bodyJson,
    });
  } catch (err) {
    return { ok: false, error: 'network_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { ok: false, error: 'not_deployed' };
  let data: unknown;
  try { data = await res.json(); } catch { return { ok: false, error: 'bad_response', detail: `HTTP ${res.status}` }; }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'bad_response' };
  return data as SoloScoreResult;
}

export type CoopScoreResult =
  | { ok: true; published: { id: string; variant: 'individual' | 'team'; ok: number; total: number }[] }
  | { ok: false; error: string; detail?: string };

export interface CoopScoreInput {
  score: number;
  wave: number;
  duration_ms: number;
  daily_seed?: string;
  cheated?: boolean;
  /** When present, the server ALSO game-signs a combined TEAM event tagged
   *  with every member. Only the submitter who's in `members` triggers it. */
  team?: { score: number; members: string[] };
}

/**
 * POST /api/coop-score — the player NIP-98 auths (identity proof only); the
 * faucet GAME-signs + publishes the co-op kind 30762 score(s). This is the
 * game-signed replacement for the legacy frontend-signed co-op publish, so a
 * player's ESP32 / hardware signer never has to sign the score itself.
 *
 * Returns a recognisable `ok:false` (e.g. 'not_deployed' on 404) so callers can
 * fall back to the legacy publish while the endpoint rolls out.
 */
export async function submitCoopScore(
  session: SignetSession,
  input: CoopScoreInput,
): Promise<CoopScoreResult> {
  if (!session.signer.capabilities.canSignEvents) return { ok: false, error: 'no_signer' };
  const url = `${apiOrigin()}${API_BASE}/coop-score`;
  const bodyJson = JSON.stringify(input);
  const payloadHash = await sha256Hex(bodyJson);
  const authTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [['u', url], ['method', 'POST'], ['payload', payloadHash]],
  };
  let signedAuth;
  try {
    signedAuth = await Promise.race([
      session.signer.signEvent(authTemplate),
      new Promise<never>((_, reject) => { window.setTimeout(() => reject(new Error('signer-timeout')), 30_000); }),
    ]);
  } catch (err) {
    return { ok: false, error: 'sign_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/coop-score`, {
      method: 'POST',
      headers: {
        authorization: `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`,
        'content-type': 'application/json',
      },
      body: bodyJson,
    });
  } catch (err) {
    return { ok: false, error: 'network_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { ok: false, error: 'not_deployed' };
  let data: unknown;
  try { data = await res.json(); } catch { return { ok: false, error: 'bad_response', detail: `HTTP ${res.status}` }; }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'bad_response' };
  return data as CoopScoreResult;
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
  const url = `${apiOrigin()}${API_BASE}/withdraw`;
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

/** Input for /api/withdraw/lnurl — mint a single-use LNURL-w token
 *  drawing from the player's balance. The bech32 LNURL the server
 *  returns can be rendered as a QR and scanned by a wallet, which
 *  then pulls the sats via the LUD-03 dance (callback + invoice).
 *  Lets a guest cash out at a venue without typing a Lightning
 *  Address on the big screen. */
export interface LnurlWithdrawInput {
  amount_sats: number;
}

export type LnurlWithdrawResult =
  | {
      ok: true;
      lnurl: string;            // uppercase bech32, ready for QR rendering
      url: string;              // plain http(s) URL the LNURL wraps
      k1: string;               // 64-char hex correlation id (poll status)
      amount_sats: number;
      expires_at: number;       // unix ms
    }
  | { ok: false; error: string; detail?: string };

/**
 * POST /api/withdraw/lnurl — mint an LNURL-withdraw token tied to
 * the player's balance. Same NIP-98 signing pattern as submitWithdraw.
 * Server debits the balance synchronously so a concurrent
 * /api/withdraw can't double-spend.
 */
export async function requestLnurlWithdraw(
  session: SignetSession,
  input: LnurlWithdrawInput,
): Promise<LnurlWithdrawResult> {
  if (!session.signer.capabilities.canSignEvents) {
    return { ok: false, error: 'no_signer' };
  }
  const url = `${apiOrigin()}${API_BASE}/withdraw/lnurl`;
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
    return {
      ok: false,
      error: 'sign_failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const authToken = `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`;

  let res: Response;
  try {
    res = await fetch(`${API_BASE}/withdraw/lnurl`, {
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
  return data as LnurlWithdrawResult;
}

export type LnurlWithdrawStatus =
  | {
      ok: true;
      status: 'open' | 'paid' | 'expired' | 'refunded';
      consumed: boolean;
      payment_hash: string | null;
      amount_sats: number;
      expires_at: number;
    }
  | { ok: false; error: string };

/**
 * GET /api/withdraw/lnurl/:k1/status — public poll endpoint used by
 * the UI to detect when a wallet has actually pulled the sats. No
 * auth: the k1 secret is the only credential needed; without it you
 * can't even guess the token.
 */
export async function pollLnurlWithdrawStatus(k1: string): Promise<LnurlWithdrawStatus> {
  if (!/^[0-9a-f]{64}$/i.test(k1)) {
    return { ok: false, error: 'invalid_k1' };
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/withdraw/lnurl/${k1}/status`, { cache: 'no-store' });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network_error' };
  }
  let data: unknown;
  try { data = await res.json(); } catch { return { ok: false, error: 'bad_response' }; }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'bad_response' };
  return data as LnurlWithdrawStatus;
}

// ── /api/play — booth pay-to-play ──────────────────────────────────────────
// Mirror of the LNURL-withdraw poll, but INCOMING: the booth charges a fixed
// entry fee. POST mints a bolt11 invoice (amount fixed server-side); the client
// renders it as a QR and polls status until phoenixd reports it settled. No
// auth — minting only lets a player pay US, and the poll is useless without the
// 64-hex payment hash. The fee is plain revenue (no balance credited).

export type PlayInvoiceResult =
  | {
      ok: true;
      payment_hash: string;
      bolt11: string;
      amount_sats: number;
      expires_at: number; // unix ms
    }
  | { ok: false; error: string; detail?: string };

/** POST /api/play/invoice — mint a fixed-amount play invoice. */
export async function requestPlayInvoice(): Promise<PlayInvoiceResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/play/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
  } catch (err) {
    return { ok: false, error: 'network_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { ok: false, error: 'not_deployed' };
  let data: unknown;
  try { data = await res.json(); } catch { return { ok: false, error: 'bad_response', detail: `HTTP ${res.status}` }; }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'bad_response' };
  return data as PlayInvoiceResult;
}

export type PlayStatusResult =
  | { ok: true; paid: boolean; amount_sats: number; received_sats: number }
  | { ok: false; error: string; detail?: string };

/** GET /api/play/:hash/status — poll phoenixd settlement for a play invoice. */
export async function pollPlayStatus(paymentHash: string): Promise<PlayStatusResult> {
  if (!/^[0-9a-f]{64}$/i.test(paymentHash)) {
    return { ok: false, error: 'invalid_hash' };
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/play/${paymentHash.toLowerCase()}/status`, { cache: 'no-store' });
  } catch (err) {
    return { ok: false, error: 'network_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 404) return { ok: false, error: 'not_deployed' };
  let data: unknown;
  try { data = await res.json(); } catch { return { ok: false, error: 'bad_response', detail: `HTTP ${res.status}` }; }
  if (typeof data !== 'object' || data === null) return { ok: false, error: 'bad_response' };
  return data as PlayStatusResult;
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
  const url = `${apiOrigin()}${API_BASE}/checkin`;
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

export interface FlaggedEntry {
  pubkey: string;
  flag_reason: string | null;
  flagged_at: number | null;
  claim: {
    id: number;
    score: number;
    wave: number;
    seed: string | null;
    submitted_at: number | null;
    score_event_id: string | null;
    reject_reason: string | null;
  } | null;
}

export type FlaggedResult =
  | { ok: true; flagged: FlaggedEntry[] }
  | { ok: false; error: 'unauthorized' | 'network_error' | 'bad_response'; status?: number };

/**
 * GET /api/admin/flagged — operator-only list of currently flagged players
 * + their flagging claim (most recent credited row, which is the run whose
 * telemetry tripped the heuristic). Used by the admin panel to surface
 * runs for visual review in the existing replay theatre.
 */
export async function fetchFlagged(adminToken: string): Promise<FlaggedResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/admin/flagged`, {
      headers: { authorization: `Bearer ${adminToken}` },
      cache: 'no-cache',
    });
  } catch (err) {
    return { ok: false, error: 'network_error', ...(err ? {} : {}) };
  }
  if (res.status === 401) return { ok: false, error: 'unauthorized', status: 401 };
  if (!res.ok) return { ok: false, error: 'bad_response', status: res.status };
  try {
    const data = await res.json() as { ok?: boolean; flagged?: FlaggedEntry[] };
    if (!data.ok || !Array.isArray(data.flagged)) {
      return { ok: false, error: 'bad_response', status: res.status };
    }
    return { ok: true, flagged: data.flagged };
  } catch {
    return { ok: false, error: 'bad_response', status: res.status };
  }
}

export type DeleteFlagResult =
  | { ok: true; deletionEventId?: string; cleared: boolean }
  | { ok: false; error: 'unauthorized' | 'network_error' | 'bad_response' | 'not_found'; status?: number };

/**
 * POST /api/admin/delete-flag — operator-only deletion of a flagged
 * run. The faucet does two things on the server: (1) sign + publish a
 * NIP-09 kind 5 deletion event from the game pubkey referencing the
 * supplied kind 30762 score event id (and optionally the matching kind
 * 31764 review case + kind 30763 ghost + kind 30764 replay), (2) clear
 * the flag from its database so the run no longer appears in the admin
 * list.
 *
 * Expected request body: { score_event_id: string, reason?: string }
 * Expected response: { ok: true, deletion_event_id?: string, cleared: boolean }
 *
 * This endpoint must exist on the faucet for the UI to work — it is not
 * provided by this repo. See trott-business/docs/plans for the
 * implementation plan if/when it lands.
 */
export async function requestDeleteFlag(
  adminToken: string,
  input: { scoreEventId: string; reason?: string },
): Promise<DeleteFlagResult> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/admin/delete-flag`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        score_event_id: input.scoreEventId,
        reason: input.reason,
      }),
    });
  } catch {
    return { ok: false, error: 'network_error' };
  }
  if (res.status === 401) return { ok: false, error: 'unauthorized', status: 401 };
  if (res.status === 404) return { ok: false, error: 'not_found', status: 404 };
  if (!res.ok) return { ok: false, error: 'bad_response', status: res.status };
  try {
    const data = await res.json() as {
      ok?: boolean;
      deletion_event_id?: string;
      cleared?: boolean;
    };
    if (!data.ok) return { ok: false, error: 'bad_response', status: res.status };
    return {
      ok: true,
      deletionEventId: data.deletion_event_id,
      cleared: data.cleared === true,
    };
  } catch {
    return { ok: false, error: 'bad_response', status: res.status };
  }
}

export interface ReplayUploadResult {
  ok: true;
  sha256: string;
  size: number;
  url: string;
}

export type ReplayUploadError =
  | { ok: false; error: 'no_signer' }
  | { ok: false; error: 'sign_failed'; detail: string }
  | { ok: false; error: 'network_error'; detail: string }
  | { ok: false; error: 'server_error'; status: number; detail?: string };

/**
 * PUT /api/replay/{sha256} — content-addressed replay blob upload.
 *
 * Replaces the legacy per-wave chunking publish path. The whole gzipped
 * frame buffer goes up in ONE HTTP PUT, authenticated by a single NIP-98
 * sign. The server verifies sha256(body) matches the URL path before
 * accepting the bytes, so the URL alone commits to the contents — the
 * kind 30764 pointer event published after this returns can safely
 * reference the URL + hash.
 *
 * Why this exists: NIP-46 caps signEvent plaintext at 65535 bytes,
 * which forced replays to be chunked into 25+ events per run and signed
 * one-by-one. Bunker-backed signers (bark → upstream relay) ate ~30s of
 * round-trips per game and frequently wedged. Single PUT collapses
 * those 25 signs into 1.
 */
export async function uploadReplay(
  session: SignetSession,
  gzippedBytes: Uint8Array,
): Promise<ReplayUploadResult | ReplayUploadError> {
  if (!session.signer.capabilities.canSignEvents) {
    return { ok: false, error: 'no_signer' };
  }
  const sha256 = await sha256HexBytes(gzippedBytes);
  const url = `${apiOrigin()}${API_BASE}/replay/${sha256}`;

  // NIP-98 auth — kind 27235 with u + method tags. We don't include a
  // `payload` tag: the URL path already commits to sha256(body), the URL
  // is in the signed `u` tag, so payload-tag verification would be
  // redundant. The server-side replay handler skips it.
  const authTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', url],
      ['method', 'PUT'],
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
    return { ok: false, error: 'sign_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  const authToken = `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`;

  // Cast to ArrayBufferView keeps fetch's BodyInit type happy across
  // recent TS lib bundles that have started narrowing BodyInit away
  // from Uint8Array-with-SharedArrayBuffer-backing-store.
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        authorization: authToken,
        'content-type': 'application/octet-stream',
      },
      body: gzippedBytes as BodyInit,
    });
  } catch (err) {
    return { ok: false, error: 'network_error', detail: err instanceof Error ? err.message : String(err) };
  }
  if (!res.ok) {
    let detail: string | undefined;
    try { detail = (await res.json() as { error?: string }).error; } catch { /* ignore */ }
    return { ok: false, error: 'server_error', status: res.status, detail };
  }
  try {
    const data = await res.json() as { ok?: boolean; sha256?: string; size?: number; url?: string };
    if (!data.ok || !data.sha256 || typeof data.size !== 'number' || !data.url) {
      return { ok: false, error: 'server_error', status: res.status, detail: 'bad_response' };
    }
    return { ok: true, sha256: data.sha256, size: data.size, url: data.url };
  } catch {
    return { ok: false, error: 'server_error', status: res.status, detail: 'bad_response' };
  }
}

// ── /api/admin/v2/* — NIP-98 + pubkey-allowlist admin surface ──────

export type AdminStateResult =
  | {
      ok: true;
      limits: {
        daily_cap_sats: number;
        per_claim_cap_sats: number;
        hourly_cap_count: number;
        today_spent_sats: number;
        hour_claims_count: number;
        today_reset_at: number;
        hour_reset_at: number;
      };
      pool: { paused: boolean; total_paid_sats: number; last_synced_at: number };
      phoenixd: { balance_sat: number | null; fee_credit_sat: number | null };
      withdraw_tokens: { status: string; count: number; total: number }[];
      players: { flagged_count: number };
      presets: Record<string, {
        daily_cap_sats: number;
        per_claim_cap_sats: number;
        hourly_cap_count: number;
        pause: boolean;
      }>;
      settings: Record<string, number>;
      setting_defaults: Record<string, number>;
    }
  | { ok: false; error: string; status?: number };

export type AdminPlayer = {
  pubkey: string;
  tier: string;
  tier_override: string | null;
  balance_sats: number;
  lifetime_paid_sats: number;
  claims_count: number;
  flagged: boolean;
  best_score: number;
  best_wave: number;
  first_seen_at: number;
  last_claim_at: number | null;
  open_withdraw_tokens: number;
};

export type AdminPlayerResult =
  | { ok: true; player: AdminPlayer }
  | { ok: false; error: string; status?: number };

/** Shared NIP-98 fetch helper for admin v2 endpoints. Signs, sends, JSON-parses.
 *  Returns the raw JSON or an error envelope. Same auth pattern as
 *  submitClaim / submitWithdraw, just generalised. */
async function adminFetch<T>(
  session: SignetSession,
  path: string,
  method: 'GET' | 'PUT' | 'POST',
  body?: unknown,
): Promise<T | { ok: false; error: string; status?: number }> {
  if (!session.signer.capabilities.canSignEvents) {
    return { ok: false, error: 'no_signer' };
  }
  const url = `${apiOrigin()}${API_BASE}/admin/v2${path}`;
  const bodyJson = body !== undefined ? JSON.stringify(body) : '';
  const payloadHash = bodyJson ? await sha256Hex(bodyJson) : '';
  const authTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['u', url],
      ['method', method],
      ...(payloadHash ? [['payload', payloadHash]] : []),
    ],
  };
  let signedAuth;
  try {
    signedAuth = await Promise.race([
      session.signer.signEvent(authTemplate),
      new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error('signer-timeout')), 30_000);
      }),
    ]);
  } catch (err) {
    return { ok: false, error: 'sign_failed', status: 0 };
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/admin/v2${path}`, {
      method,
      headers: {
        authorization: `Nostr ${utf8Base64(JSON.stringify(signedAuth))}`,
        ...(bodyJson ? { 'content-type': 'application/json' } : {}),
      },
      ...(bodyJson ? { body: bodyJson } : {}),
    });
  } catch {
    return { ok: false, error: 'network_error' };
  }
  try {
    const data = await res.json();
    return data as T;
  } catch {
    return { ok: false, error: 'bad_response', status: res.status };
  }
}

export async function fetchAdminState(session: SignetSession): Promise<AdminStateResult> {
  return adminFetch<AdminStateResult>(session, '/state', 'GET');
}

export type AdminCapsInput = {
  daily_cap_sats: number;
  per_claim_cap_sats: number;
  hourly_cap_count: number;
};

export async function setAdminCaps(
  session: SignetSession,
  caps: AdminCapsInput,
): Promise<{ ok: boolean; error?: string }> {
  const r = await adminFetch<{ ok: boolean; error?: string }>(session, '/caps', 'PUT', caps);
  return r as { ok: boolean; error?: string };
}

export async function setAdminPause(
  session: SignetSession,
  paused: boolean,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const body = reason ? { paused, reason } : { paused };
  const r = await adminFetch<{ ok: boolean; error?: string }>(session, '/pause', 'PUT', body);
  return r as { ok: boolean; error?: string };
}

export async function applyAdminPreset(
  session: SignetSession,
  profile: 'normal' | 'conference' | 'frozen',
): Promise<{ ok: boolean; error?: string }> {
  const r = await adminFetch<{ ok: boolean; error?: string }>(session, '/preset', 'POST', { profile });
  return r as { ok: boolean; error?: string };
}

/** Batched settings update — single signed request flips many knobs.
 *  Server rejects unknown keys and non-finite values per-row, so the
 *  result enumerates which entries landed and which were skipped. */
export async function saveAdminSettings(
  session: SignetSession,
  settings: { key: string; value: number }[],
): Promise<{ ok: boolean; applied?: { key: string; value: number }[]; skipped?: { key: string; reason: string }[]; error?: string }> {
  const r = await adminFetch<{
    ok: boolean;
    applied?: { key: string; value: number }[];
    skipped?: { key: string; reason: string }[];
    error?: string;
  }>(session, '/settings', 'PUT', { settings });
  return r as { ok: boolean; applied?: { key: string; value: number }[]; skipped?: { key: string; reason: string }[]; error?: string };
}

/** Player lookup. Pubkey must be 64-char hex (decode npub on the
 *  client first). Returns full player row + a count of open LNURL
 *  tokens so the admin doesn't accidentally adjust a balance mid-
 *  withdraw. */
export async function fetchAdminPlayer(
  session: SignetSession,
  pubkey: string,
): Promise<AdminPlayerResult> {
  return adminFetch<AdminPlayerResult>(session, `/player/${pubkey.toLowerCase()}`, 'GET');
}

export async function setAdminPlayerFlag(
  session: SignetSession,
  pubkey: string,
  flagged: boolean,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const body = reason ? { flagged, reason } : { flagged };
  const r = await adminFetch<{ ok: boolean; error?: string }>(
    session,
    `/player/${pubkey.toLowerCase()}/flag`,
    'POST',
    body,
  );
  return r as { ok: boolean; error?: string };
}

export async function adjustAdminPlayerBalance(
  session: SignetSession,
  pubkey: string,
  deltaSats: number,
  reason?: string,
): Promise<{ ok: boolean; balance_sats?: number; error?: string; detail?: string }> {
  const body = reason
    ? { delta_sats: deltaSats, reason }
    : { delta_sats: deltaSats };
  const r = await adminFetch<{ ok: boolean; balance_sats?: number; error?: string; detail?: string }>(
    session,
    `/player/${pubkey.toLowerCase()}/balance`,
    'POST',
    body,
  );
  return r as { ok: boolean; balance_sats?: number; error?: string; detail?: string };
}

export async function setAdminPlayerTier(
  session: SignetSession,
  pubkey: string,
  tier: 'anon' | 'nip05' | 'close' | 'verified' | null,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const body = reason ? { tier, reason } : { tier };
  const r = await adminFetch<{ ok: boolean; error?: string }>(
    session,
    `/player/${pubkey.toLowerCase()}/tier`,
    'POST',
    body,
  );
  return r as { ok: boolean; error?: string };
}
