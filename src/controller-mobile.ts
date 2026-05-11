/**
 * Phone-as-controller — PWA (mobile) side.
 *
 * Connects to the controller-ws relay as `role=phone` with the
 * sessionId from the URL, then exchanges JSON frames with the host.
 *
 * Two inbound message types:
 *   { type: 'peer-up' | 'peer-down' }     — connection state
 *   { type: 'controller-spec', spec: ... } — game's button layout
 *
 * Outbound:
 *   { k: <slot>, v: <value> }              — slot-keyed input frame
 */

import {
  type ControllerInputFrame,
  type ControllerSpec,
  type PairingToken,
} from './controller-types.js';

export interface ControllerClient {
  /** True once the relay reports the host is also connected. */
  paired: boolean;
  /** Current spec — null until the host sends one. */
  spec: ControllerSpec | null;
  /** Send one input event. Drops silently if the socket is closed. */
  sendInput: (slot: string, value: string) => void;
  /** Force-close the WS. */
  close: () => void;
  /** Status callback. */
  onStatus: (cb: (s: ControllerClientStatus) => void) => void;
  /** Spec callback — fires whenever a fresh spec arrives. */
  onSpec: (cb: (spec: ControllerSpec) => void) => void;
}

export type ControllerClientStatus =
  | { kind: 'connecting' }
  | { kind: 'waiting' }   // socket open, waiting for host to pair
  | { kind: 'paired' }
  | { kind: 'reconnecting' }
  | { kind: 'closed' };

export function startControllerClient(token: PairingToken): ControllerClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let paired = false;
  let spec: ControllerSpec | null = null;
  let reconnectAttempt = 0;
  let statusCb: ((s: ControllerClientStatus) => void) | null = null;
  let specCb: ((s: ControllerSpec) => void) | null = null;
  const fireStatus = (s: ControllerClientStatus): void => { try { statusCb?.(s); } catch { /* ignore */ } };
  const fireSpec = (s: ControllerSpec): void => { try { specCb?.(s); } catch { /* ignore */ } };
  const url = `${token.ws}?s=${encodeURIComponent(token.sessionId)}&r=phone`;

  const connect = (): void => {
    if (closed) return;
    fireStatus({ kind: reconnectAttempt > 0 ? 'reconnecting' : 'connecting' });
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      reconnectAttempt = 0;
      fireStatus(paired ? { kind: 'paired' } : { kind: 'waiting' });
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      if (!parsed || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      if (obj.type === 'peer-up') {
        if (!paired) { paired = true; fireStatus({ kind: 'paired' }); }
      } else if (obj.type === 'peer-down') {
        if (paired) { paired = false; fireStatus({ kind: 'waiting' }); }
      } else if (obj.type === 'controller-spec') {
        const incoming = obj.spec as ControllerSpec | undefined;
        if (incoming && typeof incoming === 'object' && incoming.slots) {
          spec = incoming;
          fireSpec(incoming);
        }
      }
    };
    ws.onerror = () => { /* close handler will reconnect */ };
    ws.onclose = () => {
      if (paired) { paired = false; }
      scheduleReconnect();
    };
  };
  const scheduleReconnect = (): void => {
    if (closed) return;
    reconnectAttempt += 1;
    const delay = Math.min(15_000, 500 * Math.pow(1.6, reconnectAttempt));
    window.setTimeout(connect, delay);
  };
  connect();

  const sendInput = (slot: string, value: string): void => {
    if (closed) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame: ControllerInputFrame = { k: slot, v: value };
    try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
  };

  const close = (): void => {
    closed = true;
    if (ws) try { ws.close(); } catch { /* ignore */ }
    fireStatus({ kind: 'closed' });
  };

  return {
    get paired() { return paired; },
    get spec() { return spec; },
    sendInput,
    close,
    onStatus: (cb) => { statusCb = cb; },
    onSpec: (cb) => { specCb = cb; },
  };
}
