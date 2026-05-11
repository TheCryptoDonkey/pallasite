/**
 * Phone-as-controller — mobile side.
 *
 * Connects to the controller-ws relay as `role=phone` with the
 * sessionId read from the URL. From then on every input event is
 * just a JSON.stringify({k, v}) on the open socket — no signing, no
 * relay-broadcast indirection, ~30-50ms typical end-to-end on a
 * landlocked LTE connection (closer to ~10ms on the same Wi-Fi).
 */

import {
  type ControllerInputKind,
  type ControllerInputFrame,
  type PairingToken,
} from './controller-types.js';

export interface ControllerClient {
  /** True once the relay reports the host is also connected. */
  paired: boolean;
  /** Send one input event. Returns immediately; publish is fire-and-
   *  forget. Backlog is dropped if the socket is disconnected for more
   *  than a brief moment (controller input is time-sensitive). */
  sendInput: (kind: ControllerInputKind, value: string) => void;
  /** Force-close the WS. */
  close: () => void;
  /** Hook for status changes — useful for the connection chip. */
  onStatus: (cb: (s: ControllerClientStatus) => void) => void;
}

export type ControllerClientStatus =
  | { kind: 'connecting' }
  | { kind: 'waiting' }   // socket open, waiting for host to pair
  | { kind: 'paired' }
  | { kind: 'reconnecting' }
  | { kind: 'closed' };

/** Open the WS, set up listeners, return a client handle. */
export function startControllerClient(token: PairingToken): ControllerClient {
  let ws: WebSocket | null = null;
  let closed = false;
  let paired = false;
  let reconnectAttempt = 0;
  let statusCb: ((s: ControllerClientStatus) => void) | null = null;
  const fireStatus = (s: ControllerClientStatus): void => { try { statusCb?.(s); } catch { /* ignore */ } };
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
      if (typeof obj.type !== 'string') return;
      if (obj.type === 'peer-up') {
        if (!paired) { paired = true; fireStatus({ kind: 'paired' }); }
      } else if (obj.type === 'peer-down') {
        if (paired) { paired = false; fireStatus({ kind: 'waiting' }); }
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

  const sendInput = (kind: ControllerInputKind, value: string): void => {
    if (closed) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const frame: ControllerInputFrame = { k: kind, v: value };
    try { ws.send(JSON.stringify(frame)); } catch { /* ignore */ }
  };

  const close = (): void => {
    closed = true;
    if (ws) try { ws.close(); } catch { /* ignore */ }
    fireStatus({ kind: 'closed' });
  };

  return {
    get paired() { return paired; },
    sendInput,
    close,
    onStatus: (cb) => { statusCb = cb; },
  };
}
