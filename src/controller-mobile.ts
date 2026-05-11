/**
 * Phone-as-controller — mobile (controller) side.
 *
 * The mobile page generates its own ephemeral keypair on load, reads
 * the host pubkey + relay from the URL query string, then publishes:
 *   1. one CONTROLLER_CLAIM event ("I am your controller, sessionId=X")
 *   2. CONTROLLER_INPUT events as the player presses buttons
 *
 * All signing happens locally with @noble/curves schnorr — no signer
 * round-trips, no popups. The host verifies signatures before
 * accepting any input, so a malicious relay can't inject events.
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

interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface ControllerClient {
  pairPubkey: string;
  /** Send one input event. Returns immediately — publish is fire-and-
   *  forget; we don't await OK from the relay because latency matters
   *  more than guaranteed delivery for controller input. value is a
   *  string so we can carry analog data (joystick angle) alongside
   *  booleans without a wire-format change. */
  sendInput: (kind: ControllerInputKind, value: string) => void;
  /** Force-close the relay socket and wipe the ephemeral key. */
  close: () => void;
}

/** Open the relay socket, generate the pair keypair, send the claim
 *  event. Returns a client handle the UI can use to send inputs. */
export function startControllerClient(token: PairingToken): ControllerClient {
  const pairPrivkey = new Uint8Array(32);
  crypto.getRandomValues(pairPrivkey);
  const pairPubkey = bytesToHex(schnorr.getPublicKey(pairPrivkey));

  let ws: WebSocket | null = null;
  let connected = false;
  let queued: NostrEvent[] = [];
  let closed = false;

  const open = (): void => {
    try { ws = new WebSocket(token.relay); } catch { return; }
    ws.onopen = () => {
      if (closed) return;
      connected = true;
      // Send claim first, then drain any queued inputs.
      const claim = signClaimEvent(pairPrivkey, pairPubkey, token);
      try { ws!.send(JSON.stringify(['EVENT', claim])); } catch { /* ignore */ }
      for (const ev of queued) {
        try { ws!.send(JSON.stringify(['EVENT', ev])); } catch { /* ignore */ }
      }
      queued = [];
    };
    ws.onerror = () => { /* keep waiting; user can re-pair */ };
    ws.onclose = () => {
      connected = false;
      // Auto-reconnect on transient drops — matches the player's
      // expectation that the controller "just works" while the page
      // is open. 1s backoff.
      if (!closed) setTimeout(open, 1000);
    };
  };
  open();

  const sendInput = (kind: ControllerInputKind, value: string): void => {
    if (closed) return;
    const event = signInputEvent(pairPrivkey, pairPubkey, token, kind, value);
    if (connected && ws) {
      try { ws.send(JSON.stringify(['EVENT', event])); } catch { /* ignore */ }
    } else {
      // Queue up to 16 events while disconnected so the first burst on
      // reconnect still lands. Beyond that we drop — controller input
      // is time-sensitive and old events would just confuse the host.
      if (queued.length < 16) queued.push(event);
    }
  };

  const close = (): void => {
    closed = true;
    pairPrivkey.fill(0);
    if (ws) try { ws.close(); } catch { /* ignore */ }
  };

  return { pairPubkey, sendInput, close };
}

// ── Event signing helpers ───────────────────────────────────────────────────

function signClaimEvent(privkey: Uint8Array, pubkey: string, token: PairingToken): NostrEvent {
  return finalise(privkey, pubkey, {
    kind: CONTROLLER_CLAIM_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['p', token.hostPubkey],
      ['s', token.sessionId],
      ['t', CONTROLLER_TAG],
    ],
  });
}

function signInputEvent(
  privkey: Uint8Array,
  pubkey: string,
  token: PairingToken,
  kind: ControllerInputKind,
  value: string,
): NostrEvent {
  return finalise(privkey, pubkey, {
    kind: CONTROLLER_INPUT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['p', token.hostPubkey],
      ['s', token.sessionId],
      ['t', CONTROLLER_TAG],
      ['k', kind],
      ['v', value],
    ],
  });
}

function finalise(
  privkey: Uint8Array,
  pubkey: string,
  template: { kind: number; created_at: number; content: string; tags: string[][] },
): NostrEvent {
  const serialised = JSON.stringify([0, pubkey, template.created_at, template.kind, template.tags, template.content]);
  const id = bytesToHex(sha256(utf8ToBytes(serialised)));
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), privkey));
  return { ...template, pubkey, id, sig };
}
