/**
 * Pallasite-faucet HTTP client.
 *
 * Sats payouts ended on 23 October 2026 and the faucet answers 410. The claim,
 * withdraw, balance, check-in and play-invoice calls were removed from this
 * client, and the admin panels went on 23 November; what remains is the
 * closure check, game config and the score, heartbeat and replay calls that a
 * closed faucet short-circuits.
 *
 * All requests are same-origin: in dev, Vite proxies /api/* to the local
 * faucet on 127.0.0.1:8787; in prod, nginx proxies /api/* to the faucet
 * unit on the same box. No CORS, no cross-origin cookies.
 */


const API_BASE = '/api';

/** Set by the first 410 from the faucet. A closed faucet stays closed for the
 *  page's lifetime, so later calls return before asking the player to sign. */
let faucetClosed = false;
export function isFaucetClosed(): boolean { return faucetClosed; }
function noteStatus(res: Response): Response {
  if (res.status === 410) faucetClosed = true;
  return res;
}

export interface GameInfo {
  pubkey: string;
  npub: string | null;
  relays: readonly string[];
  /** Pubkey allowed to access /admin. Null if not configured. */
  admin_pubkey: string | null;
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
    const res = noteStatus(await fetch(`${API_BASE}/game-config`, { cache: 'no-cache' }));
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
    const res = noteStatus(await fetch(`${API_BASE}/game-pubkey`, { cache: 'no-cache' }));
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

export type PlayerTier = 'anon' | 'nip05' | 'close' | 'verified';
