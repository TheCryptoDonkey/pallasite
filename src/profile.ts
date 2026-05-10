/**
 * NIP-01 kind-0 profile fetcher.
 *
 * Given a hex pubkey, resolve the user's display name + avatar from a handful
 * of relays. Cached for 24h in localStorage so repeat sessions are instant.
 *
 * Pure browser — no nostr-tools dependency. Direct WebSocket REQ/EVENT/EOSE.
 */

const RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.nostr.band',
  'wss://nos.lol',
  'wss://nostr.wine',
];

export interface NostrProfile {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  nip05?: string;
  about?: string;
  /** LUD-16 lightning address from the kind 0 profile. Used as the default
   *  payout target for faucet claims; falls back to a manual input if absent. */
  lud16?: string;
  /** Unix-ms when this profile was fetched. */
  fetchedAt: number;
}

const CACHE_PREFIX = 'pallasite:profile:';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function getCachedProfile(pubkey: string): NostrProfile | null {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + pubkey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as NostrProfile;
    if (typeof parsed.fetchedAt !== 'number') return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveProfile(profile: NostrProfile): void {
  try {
    localStorage.setItem(CACHE_PREFIX + profile.pubkey, JSON.stringify(profile));
  } catch {
    // localStorage full or unavailable — silently skip
  }
}

interface Kind0Event {
  id: string;
  pubkey: string;
  kind: 0;
  created_at: number;
  content: string;
  tags: string[][];
  sig: string;
}

function isKind0Event(value: unknown): value is Kind0Event {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return e.kind === 0 && typeof e.pubkey === 'string' && typeof e.content === 'string' &&
    typeof e.created_at === 'number';
}

function parseProfile(pubkey: string, event: Kind0Event): NostrProfile | null {
  try {
    const content: unknown = JSON.parse(event.content);
    if (typeof content !== 'object' || content === null) return null;
    const c = content as Record<string, unknown>;
    const profile: NostrProfile = { pubkey, fetchedAt: Date.now() };
    if (typeof c.name === 'string') profile.name = c.name.slice(0, 64);
    if (typeof c.display_name === 'string') profile.display_name = c.display_name.slice(0, 64);
    if (typeof c.displayName === 'string') profile.display_name = c.displayName.slice(0, 64);
    if (typeof c.picture === 'string' && /^https?:\/\//i.test(c.picture) && c.picture.length < 1024) {
      profile.picture = c.picture;
    }
    if (typeof c.nip05 === 'string') profile.nip05 = c.nip05.slice(0, 128);
    if (typeof c.about === 'string') profile.about = c.about.slice(0, 280);
    if (
      typeof c.lud16 === 'string' &&
      /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(c.lud16) &&
      c.lud16.length < 128
    ) {
      profile.lud16 = c.lud16;
    }
    return profile;
  } catch {
    return null;
  }
}

/**
 * Fetch the most recent kind-0 event for `pubkey` from a quorum of relays.
 * Returns the parsed profile, or null if none found within the timeout.
 *
 * Uses a cache; pass `{ force: true }` to bypass.
 */
export async function fetchProfile(
  pubkey: string,
  opts: { force?: boolean; relays?: string[]; timeoutMs?: number } = {},
): Promise<NostrProfile | null> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;

  if (!opts.force) {
    const cached = getCachedProfile(pubkey);
    if (cached) return cached;
  }

  const relays = opts.relays ?? RELAYS;
  const timeoutMs = opts.timeoutMs ?? 4000;

  return new Promise<NostrProfile | null>(resolve => {
    let bestEvent: Kind0Event | null = null;
    const sockets: WebSocket[] = [];
    let settled = false;
    let eoseCount = 0;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach(s => { try { s.close(); } catch { /* ignore */ } });
      if (bestEvent) {
        const profile = parseProfile(pubkey, bestEvent);
        if (profile) {
          saveProfile(profile);
          resolve(profile);
          return;
        }
      }
      resolve(null);
    };

    const timer = setTimeout(settle, timeoutMs);

    for (const url of relays) {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        continue;
      }
      sockets.push(ws);
      const subId = 'p' + Math.random().toString(36).slice(2, 10);

      ws.onopen = () => {
        ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]));
      };

      ws.onmessage = (ev: MessageEvent) => {
        let msg: unknown;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { return; }
        if (!Array.isArray(msg)) return;
        if (msg[0] === 'EVENT' && msg[1] === subId) {
          const event = msg[2];
          if (isKind0Event(event) && event.pubkey === pubkey) {
            if (!bestEvent || event.created_at > bestEvent.created_at) {
              bestEvent = event;
            }
          }
        } else if (msg[0] === 'EOSE' && msg[1] === subId) {
          eoseCount += 1;
          // Settle if we got something AND at least one relay finished, or all relays finished
          if (bestEvent && eoseCount >= 1) {
            // Give other relays 200ms more to send a newer event
            setTimeout(settle, 200);
          } else if (eoseCount >= relays.length) {
            settle();
          }
        }
      };

      ws.onerror = () => {
        eoseCount += 1;
        if (eoseCount >= relays.length) settle();
      };
    }
  });
}

/** Pick the best display name available, falling back to a short pubkey. */
export function bestName(profile: NostrProfile | null, fallbackPubkey: string): string {
  if (profile?.display_name && profile.display_name.trim()) return profile.display_name.trim();
  if (profile?.name && profile.name.trim()) return profile.name.trim();
  return fallbackPubkey.slice(0, 8).toUpperCase();
}
