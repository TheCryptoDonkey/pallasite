/**
 * Seamless guest identity. Every visitor who doesn't already have a
 * Nostr signer gets a locally-generated secp256k1 keypair plus a chosen
 * display name on first ignite. The keypair lives in localStorage and
 * is re-used across sessions; the user never sees their npub unless
 * they go looking in the settings panel.
 *
 * The result is a SignetSession with method='guest' so every signed-in
 * downstream surface (score events, replay publishing, NIP-85 rating
 * submission, zaps received) just works — guests stop being second
 * class. The trade-off vs a real Nostr signer is portability: clearing
 * the browser storage or switching device drops the identity. We
 * surface that in the settings panel and offer an "upgrade to real
 * Nostr account" path that hands off to the standard NIP-07 / bunker
 * flow via signet-login.
 *
 * Security note: a localStorage nsec is *not* a high-security identity.
 * It's appropriate for game scores + ratings + receiving zaps; it is
 * NOT appropriate for holding meaningful funds or for events the player
 * would be embarrassed to have spoofed. A motivated attacker with
 * cross-site script access (XSS) can exfiltrate the nsec. We mitigate
 * by serving same-origin only and avoiding third-party script tags,
 * but the bar is consumer-grade, not bank-grade.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import type {
  EventTemplate,
  NostrEvent,
  SignetAuthEvent,
  SignetSession,
  SignetSigner,
} from 'signet-login';

const STORAGE_KEY = 'pallasite:guest:v1';

/** Cap on how long a name can be — prevents pathological localStorage
 *  bloat from a user pasting their entire diary into the prompt. */
const MAX_NAME_LEN = 64;

interface StoredGuest {
  /** 32-byte schnorr private key as 64-char lowercase hex. */
  nsecHex: string;
  /** Display name the player chose. Free-form, sanitised on read. */
  name: string;
  /** Unix-ms when the identity was first created — useful in the
   *  settings panel ("this device's Pallasite identity, created 2 weeks
   *  ago") so a user knows whether wiping would lose recent progress. */
  createdAt: number;
  /** Schema version — bump if we ever change the on-disk shape. */
  v: 1;
}

function readStored(): StoredGuest | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== 'object' ||
      typeof (parsed as StoredGuest).nsecHex !== 'string' ||
      !/^[0-9a-f]{64}$/i.test((parsed as StoredGuest).nsecHex) ||
      typeof (parsed as StoredGuest).name !== 'string'
    ) return null;
    const s = parsed as StoredGuest;
    return {
      nsecHex: s.nsecHex.toLowerCase(),
      name: s.name.slice(0, MAX_NAME_LEN),
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      v: 1,
    };
  } catch {
    return null;
  }
}

function writeStored(record: StoredGuest): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Storage might be full or blocked (private-mode quirks). The
    // signer still works for this session even if persistence fails;
    // we just lose the identity on reload. Acceptable degradation.
  }
}

/**
 * Wipe the local guest record. Returns true if something was removed.
 * Used by the settings panel's "start fresh" button.
 */
export function clearGuestIdentity(): boolean {
  const existed = readStored() !== null;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  return existed;
}

/**
 * Read the stored guest record without instantiating a signer. Used by
 * the title screen to decide whether to show a name prompt or a
 * "welcome back" line, and by the settings panel for disclosure.
 */
export function getGuestRecord(): { name: string; pubkey: string; createdAt: number } | null {
  const stored = readStored();
  if (!stored) return null;
  try {
    const sk = hexToBytes(stored.nsecHex);
    const pubkey = bytesToHex(schnorr.getPublicKey(sk));
    return { name: stored.name, pubkey, createdAt: stored.createdAt };
  } catch {
    return null;
  }
}

// ── Signer implementation ───────────────────────────────────────────────────

/**
 * Compute the NIP-01 event id over the canonical serialisation. Same
 * shape every Nostr signer in the wild uses: sha256 of
 * `JSON.stringify([0, pubkey, created_at, kind, tags, content])`.
 *
 * crypto.subtle.digest is async; we keep this fn async too so a future
 * switch to a sync sha256 (e.g. @noble/hashes) doesn't change the call
 * site shape.
 */
async function nip01EventId(
  pubkey: string,
  created_at: number,
  kind: number,
  tags: string[][],
  content: string,
): Promise<string> {
  const canonical = JSON.stringify([0, pubkey, created_at, kind, tags, content]);
  const bytes = new TextEncoder().encode(canonical);
  const hashAb = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(hashAb));
}

class GuestSigner implements SignetSigner {
  readonly pubkey: string;
  // The 'guest' method isn't in signet-login's LoginMethod union today
  // (it predates this feature), so we cast through `unknown`. Downstream
  // code path-matches on the string value, not the type, so this is
  // safe at runtime — and the cast is the single seam to update once
  // signet-login adds the literal.
  readonly method = 'guest' as unknown as SignetSigner['method'];
  readonly capabilities = {
    canSignEvents: true,
    // NIP-44 deferred. Adding it needs ChaCha20-Poly1305 + secp256k1
    // ECDH + HKDF — straightforward with @noble/ciphers, but no current
    // surface in Pallasite requires it for guests (jury voting is
    // gated to real signers anyway). Flip on when the rating system
    // wants veiled ballots from guest accounts.
    hasNip44: false,
  };

  private readonly sk: Uint8Array;

  constructor(privkeyHex: string) {
    this.sk = hexToBytes(privkeyHex);
    this.pubkey = bytesToHex(schnorr.getPublicKey(this.sk));
  }

  async signEvent(template: EventTemplate): Promise<NostrEvent> {
    const created_at = template.created_at ?? Math.floor(Date.now() / 1000);
    const tags = template.tags ?? [];
    const content = template.content;
    const id = await nip01EventId(this.pubkey, created_at, template.kind, tags, content);
    const sig = bytesToHex(schnorr.sign(hexToBytes(id), this.sk));
    return {
      id,
      pubkey: this.pubkey,
      kind: template.kind,
      created_at,
      tags,
      content,
      sig,
    };
  }

  async close(): Promise<void> {
    // No persistent connection to tear down — local schnorr signer.
    // Defined for SignetSigner interface compliance.
  }
}

// ── Session factory ─────────────────────────────────────────────────────────

/**
 * Build a synthetic SignetAuthEvent (kind 21236) for the guest session.
 * signet-login uses this event in the standard path to prove the
 * signer's identity at handshake time; downstream code (jury,
 * delegations) reads tags but doesn't re-verify, so a self-signed
 * one is fine for the guest path.
 */
async function buildGuestAuthEvent(signer: GuestSigner): Promise<SignetAuthEvent> {
  const ev = await signer.signEvent({
    kind: 21236,
    content: '',
    tags: [
      ['app', 'pallasite'],
      ['method', 'guest'],
      // Single-use challenge — random nonce so re-issued auth events
      // don't collide on event id. Not load-bearing for guests but
      // mirrors the standard signet auth-event shape.
      ['challenge', crypto.randomUUID()],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  return ev as SignetAuthEvent;
}

/**
 * Load the existing guest session from localStorage, OR create a new
 * one with the given name and persist it. Returns a SignetSession
 * compatible with every downstream code path.
 *
 * `name` is required when creating fresh — the title screen prompts
 * for it. If a record already exists the stored name wins (the caller
 * can update it via setGuestName later).
 */
export async function loadOrCreateGuest(opts: { name: string }): Promise<SignetSession> {
  let stored = readStored();
  if (!stored) {
    const sk = new Uint8Array(32);
    crypto.getRandomValues(sk);
    // Defensive — schnorr.getPublicKey throws on zero / curve-order
    // keys. Astronomically unlikely with 32 bytes of entropy, but the
    // retry costs nothing.
    try { schnorr.getPublicKey(sk); }
    catch { return loadOrCreateGuest(opts); }
    stored = {
      nsecHex: bytesToHex(sk),
      name: opts.name.trim().slice(0, MAX_NAME_LEN) || 'Anonymous',
      createdAt: Date.now(),
      v: 1,
    };
    writeStored(stored);
  }
  const signer = new GuestSigner(stored.nsecHex);
  const authEvent = await buildGuestAuthEvent(signer);
  return {
    pubkey: signer.pubkey,
    method: signer.method,
    signer,
    authEvent,
    displayName: stored.name,
  };
}

/**
 * Update the stored display name without rotating the keypair. Used
 * when the player edits their name in settings — keeps the same npub
 * so prior scores + zaps + ratings still attach to them.
 */
export function setGuestName(name: string): { ok: boolean; name?: string } {
  const stored = readStored();
  if (!stored) return { ok: false };
  const cleaned = name.trim().slice(0, MAX_NAME_LEN);
  if (!cleaned) return { ok: false };
  const updated: StoredGuest = { ...stored, name: cleaned };
  writeStored(updated);
  return { ok: true, name: cleaned };
}

/**
 * Detect whether a SignetSession came from the local guest path.
 * Settings UI uses this to decide whether to show the "upgrade to
 * real Nostr account" affordance.
 */
export function isGuestSession(session: SignetSession | null): boolean {
  if (!session) return false;
  return (session.method as unknown as string) === 'guest';
}
