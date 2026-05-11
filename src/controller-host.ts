/**
 * Phone-as-controller — host (big-screen) side.
 *
 * Generates an ephemeral session keypair, hands the pubkey + relay to
 * the mobile via QR code, then listens on a single relay subscription
 * for CONTROLLER_CLAIM and CONTROLLER_INPUT events addressed to the
 * session pubkey. The first valid claim from any author latches that
 * author as the paired controller; subsequent input events from that
 * author are translated into game state (state.keys[] + special-action
 * helpers) exactly as if the player were pressing keyboard keys.
 *
 * No persistence: closing the tab discards the keypair. Re-pairing
 * means a fresh QR scan.
 */

import { schnorr } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import {
  CONTROLLER_INPUT_KIND,
  CONTROLLER_CLAIM_KIND,
  CONTROLLER_TAG,
  type ControllerInputKind,
  type PairingToken,
} from './controller-types.js';
import { EXPERIMENTAL_RELAYS } from './credits.js';
import type { GameState } from './types.js';
import { tryHyperspace, tryActivateShield, pauseGame, resumeGame } from './game.js';

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

/** Map a controller input kind to the keyboard code the game already
 *  understands. Hold-style inputs set/clear state.keys[code]; one-shots
 *  call the matching helper directly. */
const HOLD_CODE: Record<'left' | 'right' | 'thrust' | 'fire', string> = {
  left: 'ArrowLeft',
  right: 'ArrowRight',
  thrust: 'ArrowUp',
  fire: 'Space',
};

export interface ControllerHost {
  /** Ephemeral session pubkey (hex). Goes into the QR code. */
  sessionPubkey: string;
  /** Random short identifier for the pairing channel. */
  sessionId: string;
  /** The relay this host is listening on. */
  relay: string;
  /** Encoded URL the mobile opens. */
  pairingUrl: string;
  /** Pubkey of the mobile once paired, else null. */
  pairedWith: string | null;
  /** Most recent input received (perf-ms). */
  lastInputAt: number;
  /** Close the host (cancels the subscription and forgets keys). */
  close: () => void;
  /** Hook a callback for state changes — connecting → paired → input. */
  onStatus: (cb: (s: ControllerHostStatus) => void) => void;
}

export type ControllerHostStatus =
  | { kind: 'waiting' }
  | { kind: 'paired'; pairPubkey: string }
  | { kind: 'closed' };

/** Start a host listener. Generates a fresh keypair, opens a relay
 *  subscription, and returns the handle. The caller is responsible for
 *  rendering the pairing UI from `host.pairingUrl`. */
export function startControllerHost(state: GameState, opts: { relay?: string } = {}): ControllerHost {
  const sessionPrivkey = new Uint8Array(32);
  crypto.getRandomValues(sessionPrivkey);
  const sessionPubkey = bytesToHex(schnorr.getPublicKey(sessionPrivkey));
  const sessionId = randomSessionId();
  const relay = opts.relay ?? EXPERIMENTAL_RELAYS[0];
  const pairingUrl = encodePairingUrl({ hostPubkey: sessionPubkey, sessionId, relay });

  let pairedWith: string | null = null;
  let lastInputAt = 0;
  let statusCb: ((s: ControllerHostStatus) => void) | null = null;
  const fireStatus = (s: ControllerHostStatus): void => { try { statusCb?.(s); } catch { /* ignore */ } };

  let ws: WebSocket | null = null;
  let closed = false;
  const subId = 'ch' + Math.random().toString(36).slice(2, 10);

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    sessionPrivkey.fill(0);
    if (ws) try { ws.close(); } catch { /* ignore */ }
    // Release any held keys so the game doesn't get stuck thrusting
    // forever after the controller is disconnected.
    for (const code of Object.values(HOLD_CODE)) state.keys[code] = false;
    fireStatus({ kind: 'closed' });
  };

  try { ws = new WebSocket(relay); } catch { cleanup(); }
  if (!ws) {
    return { sessionPubkey, sessionId, relay, pairingUrl, pairedWith, lastInputAt,
      close: cleanup, onStatus: (cb) => { statusCb = cb; } };
  }
  ws.onopen = () => {
    if (!ws || closed) return;
    try {
      ws.send(JSON.stringify([
        'REQ',
        subId,
        {
          kinds: [CONTROLLER_INPUT_KIND, CONTROLLER_CLAIM_KIND],
          '#p': [sessionPubkey],
          '#s': [sessionId],
          since: Math.floor(Date.now() / 1000) - 5,
        },
      ]));
    } catch { /* ignore */ }
    fireStatus({ kind: 'waiting' });
  };
  ws.onmessage = (ev) => {
    try {
      const msg: unknown = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
      if (!Array.isArray(msg) || msg[0] !== 'EVENT' || msg[1] !== subId) return;
      const event = msg[2] as NostrEvent;
      if (!isPlausibleEvent(event)) return;
      // Verify the event signature locally — relay trust is one thing,
      // controller input dispatch is another. Bad sig → silently drop.
      if (!verifyEventSignature(event)) return;
      // Filter by the expected tags.
      if (!hasTag(event.tags, 'p', sessionPubkey)) return;
      if (!hasTag(event.tags, 's', sessionId)) return;

      if (event.kind === CONTROLLER_CLAIM_KIND) {
        if (pairedWith && pairedWith !== event.pubkey) return; // first claim wins
        pairedWith = event.pubkey;
        fireStatus({ kind: 'paired', pairPubkey: event.pubkey });
        return;
      }
      if (event.kind === CONTROLLER_INPUT_KIND) {
        if (!pairedWith || event.pubkey !== pairedWith) return;
        const k = tagValue(event.tags, 'k') as ControllerInputKind | undefined;
        const v = tagValue(event.tags, 'v');
        if (!k) return;
        applyInput(state, k, v === '1' ? 1 : 0);
        lastInputAt = performance.now();
      }
    } catch { /* ignore */ }
  };
  ws.onerror = () => { /* leave waiting state — user can re-pair */ };

  return {
    sessionPubkey, sessionId, relay, pairingUrl, pairedWith, lastInputAt,
    close: cleanup,
    onStatus: (cb) => { statusCb = cb; },
  };
}

/** Apply a single controller input to the game. Hold-style inputs map
 *  to state.keys[code]; one-shots invoke the matching helper directly.
 *  Phase guards mirror the keyboard path so a stray "fire" arriving
 *  during pause doesn't fire bullets. */
function applyInput(state: GameState, kind: ControllerInputKind, value: 0 | 1): void {
  switch (kind) {
    case 'left':
    case 'right':
    case 'thrust':
    case 'fire': {
      state.keys[HOLD_CODE[kind]] = value === 1;
      return;
    }
    case 'hyperspace':
      if (value !== 1) return;
      if (state.phase === 'playing') tryHyperspace(state, performance.now());
      return;
    case 'shield':
      if (value !== 1) return;
      if (state.phase === 'playing') tryActivateShield(state, performance.now());
      return;
    case 'pause':
      if (value !== 1) return;
      if (state.phase === 'playing') pauseGame(state);
      else if (state.phase === 'paused') resumeGame(state);
      return;
  }
}

// ── Pairing URL helpers ──────────────────────────────────────────────────────

export function encodePairingUrl(token: PairingToken): string {
  const params = new URLSearchParams({
    h: token.hostPubkey,
    s: token.sessionId,
    r: token.relay,
  });
  return `${window.location.origin}/controller?${params.toString()}`;
}

export function decodePairingUrl(url: string): PairingToken | null {
  try {
    const u = new URL(url);
    const h = u.searchParams.get('h');
    const s = u.searchParams.get('s');
    const r = u.searchParams.get('r');
    if (!h || !/^[0-9a-f]{64}$/i.test(h)) return null;
    if (!s || !/^[a-z0-9]{4,16}$/i.test(s)) return null;
    if (!r || !/^wss?:\/\//.test(r)) return null;
    return { hostPubkey: h, sessionId: s, relay: r };
  } catch {
    return null;
  }
}

function randomSessionId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);  // 8 hex chars — short, URL-safe
}

// ── Tag + event helpers ──────────────────────────────────────────────────────

function tagValue(tags: string[][], name: string): string | undefined {
  for (const t of tags) if (t[0] === name && typeof t[1] === 'string') return t[1];
  return undefined;
}

function hasTag(tags: string[][], name: string, value: string): boolean {
  for (const t of tags) if (t[0] === name && t[1] === value) return true;
  return false;
}

function isPlausibleEvent(e: unknown): e is NostrEvent {
  if (typeof e !== 'object' || e === null) return false;
  const r = e as Record<string, unknown>;
  return typeof r.id === 'string'
    && typeof r.pubkey === 'string'
    && typeof r.created_at === 'number'
    && typeof r.kind === 'number'
    && Array.isArray(r.tags)
    && typeof r.content === 'string'
    && typeof r.sig === 'string';
}

function verifyEventSignature(e: NostrEvent): boolean {
  try {
    const serialised = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
    const computed = bytesToHex(sha256(utf8ToBytes(serialised)));
    if (computed !== e.id) return false;
    return schnorr.verify(hexToBytes(e.sig), hexToBytes(e.id), hexToBytes(e.pubkey));
  } catch {
    return false;
  }
}

void CONTROLLER_TAG;
