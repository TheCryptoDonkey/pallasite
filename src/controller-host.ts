/**
 * Phone-as-controller — host (big-screen) side.
 *
 * Connects to the controller-ws relay as `role=host` with a fresh
 * random sessionId, hands that sessionId to the mobile via a QR code,
 * then forwards every input frame the relay delivers from the phone
 * into game state (state.targetHeading / state.thrustOverride for the
 * joystick, state.keys[Space] for fire, tryHyperspace / etc. for
 * one-shots).
 *
 * No persistence: closing the tab drops the WS, the server discards
 * the session, the next pair is a fresh QR.
 */

import {
  CONTROLLER_WS_ENDPOINT_DEFAULT,
  type ControllerInputKind,
  type PairingToken,
} from './controller-types.js';
import type { GameState } from './types.js';
import { tryHyperspace, tryActivateShield, pauseGame, resumeGame } from './game.js';

/** Fire button maps to Space (matches the keyboard handler). Thrust
 *  and heading go through state.thrustOverride / state.targetHeading
 *  so the joystick semantics work identically to the in-game touch
 *  joystick (touch.ts → attachJoystick). */
const FIRE_CODE = 'Space';

export interface ControllerHost {
  /** Random session identifier — shared with the phone via QR. */
  sessionId: string;
  /** WS endpoint we connected to. */
  ws: string;
  /** Encoded URL the mobile opens. */
  pairingUrl: string;
  /** True once the relay reports the phone is also connected. */
  paired: boolean;
  /** Most recent input received (perf-ms). */
  lastInputAt: number;
  /** Close the host (cancels the WS and clears held inputs). */
  close: () => void;
  /** Hook a callback for state changes — waiting → paired → closed. */
  onStatus: (cb: (s: ControllerHostStatus) => void) => void;
}

export type ControllerHostStatus =
  | { kind: 'waiting' }
  | { kind: 'paired' }
  | { kind: 'closed' };

export function startControllerHost(state: GameState, opts: { ws?: string } = {}): ControllerHost {
  const sessionId = randomSessionId();
  const wsUrl = opts.ws ?? CONTROLLER_WS_ENDPOINT_DEFAULT;
  const pairingUrl = encodePairingUrl({ sessionId, ws: wsUrl });

  let paired = false;
  let lastInputAt = 0;
  let statusCb: ((s: ControllerHostStatus) => void) | null = null;
  const fireStatus = (s: ControllerHostStatus): void => { try { statusCb?.(s); } catch { /* ignore */ } };

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectAttempt = 0;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (ws) try { ws.close(); } catch { /* ignore */ }
    // Release any held inputs so the game doesn't get stuck thrusting
    // forever after the controller is disconnected.
    state.keys[FIRE_CODE] = false;
    state.targetHeading = null;
    state.thrustOverride = false;
    fireStatus({ kind: 'closed' });
  };

  const connect = (): void => {
    if (closed) return;
    const url = `${wsUrl}?s=${encodeURIComponent(sessionId)}&r=host`;
    try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
    ws.onopen = () => {
      reconnectAttempt = 0;
      if (!paired) fireStatus({ kind: 'waiting' });
    };
    ws.onmessage = (ev) => {
      const data = typeof ev.data === 'string' ? ev.data : '';
      if (!data) return;
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { return; }
      if (!parsed || typeof parsed !== 'object') return;
      const obj = parsed as Record<string, unknown>;
      // Server-originated control frames carry a `type` field.
      if (typeof obj.type === 'string') {
        if (obj.type === 'peer-up') {
          if (!paired) { paired = true; fireStatus({ kind: 'paired' }); }
        } else if (obj.type === 'peer-down') {
          if (paired) {
            paired = false;
            state.keys[FIRE_CODE] = false;
            state.targetHeading = null;
            state.thrustOverride = false;
            fireStatus({ kind: 'waiting' });
          }
        }
        return;
      }
      // Otherwise it's an input frame from the phone.
      if (typeof obj.k !== 'string' || typeof obj.v !== 'string') return;
      applyInput(state, obj.k as ControllerInputKind, obj.v);
      lastInputAt = performance.now();
    };
    ws.onerror = () => { /* close handler will reconnect */ };
    ws.onclose = () => {
      if (paired) {
        // Lost the relay connection while paired — release inputs but
        // try to reconnect; phone may still be on the other side.
        state.keys[FIRE_CODE] = false;
        state.targetHeading = null;
        state.thrustOverride = false;
      }
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

  return {
    sessionId, ws: wsUrl, pairingUrl,
    get paired() { return paired; },
    get lastInputAt() { return lastInputAt; },
    close: cleanup,
    onStatus: (cb) => { statusCb = cb; },
  };
}

/** Apply a single controller input to the game. Joystick events drive
 *  state.targetHeading + state.thrustOverride exactly like the in-game
 *  touch joystick (touch.ts); discrete buttons go through state.keys
 *  or the helper functions the keyboard path uses. */
function applyInput(state: GameState, kind: ControllerInputKind, value: string): void {
  const on = value === '1';
  switch (kind) {
    case 'heading': {
      const angle = parseInt(value, 10) / 1000;
      if (Number.isFinite(angle)) state.targetHeading = angle;
      return;
    }
    case 'heading-end':
      state.targetHeading = null;
      state.thrustOverride = false;
      return;
    case 'thrust':
      state.thrustOverride = on;
      return;
    case 'fire':
      state.keys[FIRE_CODE] = on;
      return;
    case 'hyperspace':
      if (!on) return;
      if (state.phase === 'playing') tryHyperspace(state, performance.now());
      return;
    case 'shield':
      if (!on) return;
      if (state.phase === 'playing') tryActivateShield(state, performance.now());
      return;
    case 'pause':
      if (!on) return;
      if (state.phase === 'playing') pauseGame(state);
      else if (state.phase === 'paused') resumeGame(state);
      return;
  }
}

// ── Pairing URL helpers ──────────────────────────────────────────────────────

export function encodePairingUrl(token: PairingToken): string {
  const params = new URLSearchParams({ s: token.sessionId });
  // Carry the ws endpoint only when it's a non-default — production QRs
  // stay short (just ?s=abc12345).
  if (token.ws && token.ws !== CONTROLLER_WS_ENDPOINT_DEFAULT) {
    params.set('w', token.ws);
  }
  const host = window.location.hostname;
  const onPallasite = host === 'pallasite.app' || host.endsWith('.pallasite.app');
  if (onPallasite) {
    return `https://mobile.pallasite.app/?${params.toString()}`;
  }
  return `${window.location.origin}/controller?${params.toString()}`;
}

export function decodePairingUrl(url: string): PairingToken | null {
  try {
    const u = new URL(url);
    const s = u.searchParams.get('s');
    if (!s || !/^[a-z0-9]{4,32}$/i.test(s)) return null;
    const w = u.searchParams.get('w') ?? CONTROLLER_WS_ENDPOINT_DEFAULT;
    if (!/^wss?:\/\//.test(w)) return null;
    return { sessionId: s, ws: w };
  } catch {
    return null;
  }
}

function randomSessionId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
