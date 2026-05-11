/**
 * Phone-as-controller — host (big-screen) side.
 *
 * Connects to the controller-ws relay as `role=host` with a fresh
 * random sessionId, hands the QR to the mobile, then routes slot-keyed
 * input frames into game state via a slot-map the caller provides.
 *
 * The PWA renders a generic gamepad; the host tells it which slots to
 * show (and what icon/label per slot) via the ControllerSpec sent
 * immediately after pair. This keeps the PWA game-agnostic.
 */

import {
  CONTROLLER_WS_ENDPOINT_DEFAULT,
  type ControllerSpec,
  type PairingToken,
} from './controller-types.js';
import type { GameState } from './types.js';
import { tryHyperspace, tryActivateShield } from './game.js';

/** Pallasite slot map — which standard slot maps to which game action.
 *  The host's spec advertises icons/labels for these slots; the PWA
 *  shows the matching buttons and emits slot-keyed events back. Update
 *  this map AND the spec together if you re-skin the controller.
 *
 *  Slot vs action separation lets a different game reuse the same
 *  PWA — the future TROTT-style two-player or non-Pallasite arcade
 *  would have its own slot-map + spec without touching the PWA. */
const PALLASITE_SPEC: ControllerSpec = {
  name: 'PALLASITE',
  version: 1,
  slots: {
    joyL: { mode: 'heading', tapAction: 'A' },
    // All four actions live on the face-button diamond so the right
    // thumb reaches everything without leaving its rest position.
    // Stuffing SHIELD/WARP on shoulder buttons stranded them at the
    // top edge of the phone, out of natural reach in landscape grip.
    A: { icon: '●',  label: 'FIRE',   colour: '#ff5050' },  // south — primary
    B: { icon: '⛨',  label: 'SHIELD', colour: '#5b9dff' },  // east — secondary
    X: { icon: '⚡', label: 'WARP',   colour: '#b48cff' },  // west — escape
    Y: { icon: '⏸',  label: 'PAUSE',  colour: '#ffd84a' },  // north — rare
  },
};

const FIRE_CODE = 'Space';

export interface ControllerHost {
  sessionId: string;
  ws: string;
  pairingUrl: string;
  paired: boolean;
  lastInputAt: number;
  close: () => void;
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
    state.keys[FIRE_CODE] = false;
    state.targetHeading = null;
    state.thrustOverride = false;
    fireStatus({ kind: 'closed' });
  };

  const sendSpec = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'controller-spec', spec: PALLASITE_SPEC }));
    } catch { /* ignore */ }
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
      if (typeof obj.type === 'string') {
        if (obj.type === 'peer-up') {
          if (!paired) {
            paired = true;
            fireStatus({ kind: 'paired' });
            // Send the controller spec as soon as the phone is on. PWA
            // renders the layout from this — without it, the PWA shows
            // a "waiting for game" placeholder.
            sendSpec();
          }
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
      if (typeof obj.k !== 'string' || typeof obj.v !== 'string') return;
      applySlotInput(state, obj.k, obj.v);
      lastInputAt = performance.now();
    };
    ws.onerror = () => { /* close handler will reconnect */ };
    ws.onclose = () => {
      if (paired) {
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

/** Phases that have an overlay menu the joystick should drive
 *  (synthetic arrow keys + Enter / Escape). Anything else is gameplay. */
const MENU_PHASES = new Set(['title', 'paused', 'gameover', 'completed']);
let lastMenuCardinal: 'up' | 'down' | 'left' | 'right' | null = null;

function angleToCardinal(rad: number): 'up' | 'down' | 'left' | 'right' {
  const a = ((rad % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  if (a < Math.PI / 4 || a >= 7 * Math.PI / 4) return 'right';
  if (a < 3 * Math.PI / 4) return 'down';
  if (a < 5 * Math.PI / 4) return 'left';
  return 'up';
}
function dispatchKey(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
}

/** Map a slot-keyed input frame to a Pallasite game action. During
 *  gameplay this drives state.targetHeading / state.keys[Space] /
 *  tryHyperspace etc. During menu phases (title, paused, gameover,
 *  completed) the joystick fires synthetic arrow keys so the overlay's
 *  setupOverlayArrowNav handler walks through the buttons, A fires
 *  Enter to confirm, Y fires Escape to dismiss. */
function applySlotInput(state: GameState, slot: string, value: string): void {
  const on = value === '1';
  const inMenu = MENU_PHASES.has(state.phase);
  switch (slot) {
    // ── Joystick ────────────────────────────────────────────────────
    case 'joyL': {
      const angle = parseInt(value, 10) / 1000;
      if (!Number.isFinite(angle)) return;
      if (inMenu) {
        // Quantise to cardinal and fire one arrow per direction change.
        const card = angleToCardinal(angle);
        if (card !== lastMenuCardinal) {
          lastMenuCardinal = card;
          dispatchKey(
            card === 'up'    ? 'ArrowUp'
          : card === 'down'  ? 'ArrowDown'
          : card === 'left'  ? 'ArrowLeft'
          :                    'ArrowRight'
          );
        }
        return;
      }
      state.targetHeading = angle;
      return;
    }
    case 'joyL-thrust':
      if (inMenu) return;
      state.thrustOverride = on;
      return;
    case 'joyL-end':
      state.targetHeading = null;
      state.thrustOverride = false;
      lastMenuCardinal = null;
      return;
    case 'joyL-tap':
      if (!on) return;
      if (inMenu) { dispatchKey('Enter'); return; }
      state.keys[FIRE_CODE] = true;
      window.setTimeout(() => { state.keys[FIRE_CODE] = false; }, 60);
      return;
    // ── Face buttons ────────────────────────────────────────────────
    case 'A':
      if (inMenu) {
        if (on) dispatchKey('Enter');
        return;
      }
      state.keys[FIRE_CODE] = on;
      return;
    case 'B':
      if (!on) return;
      if (state.phase === 'playing') tryActivateShield(state, performance.now());
      return;
    case 'X':
      if (!on) return;
      if (state.phase === 'playing') tryHyperspace(state, performance.now());
      return;
    case 'Y':
      if (!on) return;
      // Universally Escape — game's keydown handler interprets per
      // phase (pauses playing, resumes paused, dismisses overlays).
      dispatchKey('Escape');
      return;
    case 'L1':
    case 'L2':
    case 'R1':
    case 'R2':
    case 'start':
    case 'select':
      return;
  }
}

// ── Pairing URL helpers ──────────────────────────────────────────────────────

export function encodePairingUrl(token: PairingToken): string {
  const params = new URLSearchParams({ s: token.sessionId });
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

// Re-export so consumers (notably renderControllerHostPairing) can
// reach the slot-config types without importing both modules.
export type { ControllerSpec, ControllerSlot } from './controller-types.js';
