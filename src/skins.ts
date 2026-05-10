/**
 * Cosmetic ship skins. Players unlock skins by hitting on-chain milestones
 * (lifetime sats banked, wave 25 cleared) and the active selection re-tints
 * the ship + thrust flame in render.ts.
 *
 * Storage is dual:
 *   - localStorage authoritative for the active selection (per device).
 *   - kind 30764 Nostr event with d="pallasite-skins" carries the unlock
 *     set across devices. Fetch on title load merges remote into local;
 *     publish on new unlock pushes the updated set out to relays.
 *
 * Bullets stay red across all skins -- enemy/player bullet colour is a
 * readability convention, not a cosmetic surface. Skin only re-paints the
 * ship outline, the thrust flame, and the additive bloom behind it.
 */

import type { SignetSession, NostrEvent } from 'signet-login';
import { GAME_ID } from './auth.js';
import { getActiveRelays } from './relays.js';

export type SkinId = 'default' | 'ironclad' | 'halo';

export interface SkinPalette {
  ship: string;
  shipShadow: string;
  thrust: string;
  thrustShadow: string;
  /** Inner bloom colour used by the thrust additive halo. */
  bloomCore: string;
  /** Outer bloom colour at the gradient mid stop. */
  bloomMid: string;
}

export type UnlockCriteria =
  | { kind: 'always' }
  | { kind: 'lifetime-sats'; threshold: number }
  | { kind: 'wave-cleared'; wave: number };

export interface SkinDef {
  id: SkinId;
  label: string;
  /** One-line brand-voice description. Used on the settings card. */
  description: string;
  /** Used on the locked card to tell the player how to earn it. */
  unlockHint: string;
  unlock: UnlockCriteria;
  palette: SkinPalette;
}

export const SKINS: readonly SkinDef[] = [
  {
    id: 'default',
    label: 'STANDARD',
    description: 'The default green outline.',
    unlockHint: 'Always yours.',
    unlock: { kind: 'always' },
    palette: {
      ship: '#58ff58',
      shipShadow: '#58ff58',
      thrust: '#ffd84a',
      thrustShadow: '#ffd84a',
      bloomCore: 'rgba(255,216,74,0.55)',
      bloomMid: 'rgba(255,140,30,0.22)',
    },
  },
  {
    id: 'ironclad',
    label: 'IRONCLAD',
    description: 'Iron-orange. Heavier in the void.',
    unlockHint: 'Bank 100,000 sats.',
    unlock: { kind: 'lifetime-sats', threshold: 100_000 },
    palette: {
      ship: '#ff7a3a',
      shipShadow: '#ff7a3a',
      thrust: '#ffd84a',
      thrustShadow: '#ff7a3a',
      bloomCore: 'rgba(255,160,80,0.55)',
      bloomMid: 'rgba(220,90,30,0.22)',
    },
  },
  {
    id: 'halo',
    label: 'HALO',
    description: 'Cyan, cold. Stands out against any wave.',
    unlockHint: 'Clear wave 25.',
    unlock: { kind: 'wave-cleared', wave: 25 },
    palette: {
      ship: '#5be0ff',
      shipShadow: '#5be0ff',
      thrust: '#cfeefb',
      thrustShadow: '#5be0ff',
      bloomCore: 'rgba(150,230,255,0.55)',
      bloomMid: 'rgba(60,160,220,0.22)',
    },
  },
];

const ACTIVE_KEY = 'pallasite:skin-active';
const UNLOCKED_KEY = 'pallasite:skin-unlocks';
const SKIN_KIND = 30764;
const SKIN_DTAG = 'pallasite-skins';

// In-memory caches. localStorage reads are synchronous and slow on mobile
// Safari (1-5ms per call), and getActiveSkin runs every frame from drawShip.
// Without this cache, the renderer would hit storage 60+ times a second and
// burn most of a frame budget on a value that almost never changes.
let cachedUnlockSet: Set<SkinId> | null = null;
let cachedActiveSkin: SkinDef | null = null;

function readUnlockSet(): Set<SkinId> {
  if (cachedUnlockSet) return cachedUnlockSet;
  const set = new Set<SkinId>(['default']);
  try {
    const raw = localStorage.getItem(UNLOCKED_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const id of parsed) {
          if (typeof id === 'string' && SKINS.some(s => s.id === id)) set.add(id as SkinId);
        }
      }
    }
  } catch { /* fall through to default-only */ }
  cachedUnlockSet = set;
  return set;
}

function writeUnlockSet(set: Set<SkinId>): void {
  cachedUnlockSet = new Set(set);
  try { localStorage.setItem(UNLOCKED_KEY, JSON.stringify([...set])); } catch { /* ignore */ }
}

/** Drop the in-memory caches. Used after a remote sync merges new unlocks
 *  so the next read picks the fresh state up. */
function invalidateCaches(): void {
  cachedUnlockSet = null;
  cachedActiveSkin = null;
}

export function getUnlockedSkins(): Set<SkinId> {
  return readUnlockSet();
}

export function isSkinUnlocked(id: SkinId): boolean {
  return readUnlockSet().has(id);
}

/**
 * Mark a skin as unlocked locally. Returns true when the skin was newly
 * unlocked this call (caller may want to fire a celebratory toast or kick
 * off a Nostr publish), false when it was already unlocked.
 */
export function markSkinUnlocked(id: SkinId): boolean {
  const set = readUnlockSet();
  if (set.has(id)) return false;
  const next = new Set(set);
  next.add(id);
  writeUnlockSet(next);
  // Invalidate active cache too -- though setActive isn't auto-changed,
  // future calls that resolve through readUnlockSet should see the new set.
  cachedActiveSkin = null;
  return true;
}

export function getActiveSkinId(): SkinId {
  return getActiveSkin().id;
}

export function setActiveSkinId(id: SkinId): boolean {
  if (!isSkinUnlocked(id)) return false;
  try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* ignore */ }
  cachedActiveSkin = null;
  return true;
}

/**
 * Hot path -- called from drawShip every frame. Caches in memory so the
 * 60fps renderer doesn't hit localStorage at all in the common case. The
 * cache is invalidated on setActiveSkinId, markSkinUnlocked (in case the
 * active selection became valid), and after a Nostr sync merges new
 * unlocks. */
export function getActiveSkin(): SkinDef {
  if (cachedActiveSkin) return cachedActiveSkin;
  let resolved: SkinDef = SKINS[0];
  try {
    const raw = localStorage.getItem(ACTIVE_KEY);
    if (raw) {
      const found = SKINS.find(s => s.id === raw);
      if (found && readUnlockSet().has(found.id)) resolved = found;
    }
  } catch { /* fall through to default */ }
  cachedActiveSkin = resolved;
  return resolved;
}

// ── Nostr sync (kind 30764) ──────────────────────────────────────────────────

/**
 * Publish the current local unlock set as a kind 30764 replaceable event.
 * Best-effort: relay failures are swallowed since this is cosmetic state.
 *
 * Skips publishing the implicit "default" skin -- a kind 30764 event with
 * only ['skin', 'default'] would carry no information beyond identity.
 *
 * Returns the signed event when at least one non-default skin is unlocked
 * and the session can sign; null otherwise.
 */
export async function publishSkinUnlocks(session: SignetSession): Promise<NostrEvent | null> {
  if (!session.signer.capabilities.canSignEvents) return null;
  const unlocked = [...readUnlockSet()].filter(id => id !== 'default');
  if (unlocked.length === 0) return null;
  const tags: string[][] = [
    ['d', SKIN_DTAG],
    ['t', 'pallasite'],
    ['game', GAME_ID],
  ];
  for (const id of unlocked) tags.push(['skin', id]);
  const signed = await session.signer.signEvent({ kind: SKIN_KIND, content: '', tags });
  const relays = getActiveRelays();
  await Promise.all(relays.map(url => publishToRelay(url, signed).catch(() => undefined)));
  return signed;
}

/**
 * Fetch the player's kind 30764 unlock set from relays and merge into local.
 * Best-effort: returns the merged set on success, the existing local set on
 * failure. Used on title-screen load to pull skins earned on another device.
 */
export async function syncSkinUnlocksFromNostr(pubkey: string): Promise<Set<SkinId>> {
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) return readUnlockSet();
  const relays = getActiveRelays();
  if (relays.length === 0) return readUnlockSet();

  const events = await new Promise<NostrEvent[]>(resolve => {
    const collected: NostrEvent[] = [];
    let done = 0;
    const sockets: WebSocket[] = [];
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sockets.forEach(s => { try { s.close(); } catch { /* ignore */ } });
      resolve(collected);
    };
    const timer = setTimeout(settle, 4000);
    const markDone = (): void => {
      done += 1;
      if (done >= relays.length) settle();
    };
    for (const url of relays) {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { markDone(); continue; }
      sockets.push(ws);
      const subId = 'sk' + Math.random().toString(36).slice(2, 10);
      ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, {
        kinds: [SKIN_KIND],
        authors: [pubkey],
        '#d': [SKIN_DTAG],
        limit: 1,
      }]));
      ws.onmessage = ev => {
        try {
          const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          if (!Array.isArray(msg)) return;
          if (msg[0] === 'EVENT' && msg[1] === subId) {
            const e = msg[2];
            if (e && typeof e === 'object' && (e as NostrEvent).kind === SKIN_KIND) {
              collected.push(e as NostrEvent);
            }
          } else if (msg[0] === 'EOSE' && msg[1] === subId) {
            markDone();
          }
        } catch { /* ignore */ }
      };
      ws.onerror = markDone;
      ws.onclose = markDone;
    }
  });

  // Pick the most recent event; merge its skin tags into the local set.
  let latest: NostrEvent | null = null;
  for (const e of events) {
    if (!latest || e.created_at > latest.created_at) latest = e;
  }
  if (!latest) return readUnlockSet();
  const merged = new Set(readUnlockSet());
  let added = false;
  for (const t of latest.tags) {
    if (t[0] === 'skin' && typeof t[1] === 'string' && SKINS.some(s => s.id === t[1])) {
      const id = t[1] as SkinId;
      if (!merged.has(id)) { merged.add(id); added = true; }
    }
  }
  if (added) {
    writeUnlockSet(merged);
    invalidateCaches();
  }
  return merged;
}

function publishToRelay(url: string, event: NostrEvent, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
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
      } catch { /* ignore */ }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('relay-error')); };
  });
}
