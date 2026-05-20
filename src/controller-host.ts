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
  type RemoteEventTemplate,
  type RemoteSignedEvent,
  type SignerAnnounceFrame,
  type SignRequestFrame,
} from './controller-types.js';
import type { GameState } from './types.js';
import { localEdges } from './netcode.js';

/** Identity the host has been told the controller is carrying. Mirror
 *  of AnnouncedSigner from controller-mobile, re-declared here so the
 *  host side doesn't depend on the mobile module. */
export interface AnnouncedSigner {
  pubkey: string;
  npub?: string;
  name?: string;
  method?: SignerAnnounceFrame['method'];
  caps?: SignerAnnounceFrame['caps'];
}

/** Pallasite slot map — which standard slot maps to which game action.
 *  The host's spec advertises icons/labels for these slots; the PWA
 *  shows the matching buttons and emits slot-keyed events back.
 *
 *  We ship TWO specs: PLAY (joystick + face) and MENU (d-pad + face).
 *  The host watches game phase and re-sends whichever matches. The
 *  analog stick handles smooth heading; the d-pad handles discrete
 *  navigation with proper auto-repeat for selecting menu items + the
 *  3-character initials picker.
 *
 *  Face button colours match the in-game touch.ts palette (FIRE orange,
 *  SHIELD green, WARP purple) so the PWA reads as the same controller
 *  the player sees overlaid on the game canvas in touch mode. */
const FACE_BUTTONS: ControllerSpec['slots'] = {
  A: { icon: '●',  label: 'FIRE',   colour: '#ff8a3a' },  // south — primary (orange — matches in-game .touch-btn.fire)
  B: { icon: '⛨',  label: 'SHIELD', colour: '#58ff58' },  // east — secondary (green — matches .shield)
  X: { icon: '⚡', label: 'WARP',   colour: '#b48cff' },  // west — escape (purple — matches .hyper)
  Y: { icon: '⏸',  label: 'PAUSE',  colour: '#ffd84a' },  // north — rare
};

const PALLASITE_SPEC_PLAY: ControllerSpec = {
  name: 'PALLASITE',
  version: 1,
  slots: {
    joyL: { mode: 'heading', tapAction: 'A' },
    ...FACE_BUTTONS,
  },
};

// Menu-mode face buttons. A and Y are the only two that do anything
// useful when the host is on a menu screen (title, paused, gameover,
// completed): A fires synthetic Enter to activate the focused button,
// Y fires synthetic Escape to dismiss. B and X had no menu mapping
// previously but kept their PLAY labels ("SHIELD", "WARP") which read
// as broken to a player on the gameover screen looking for CLAIM.
// Re-label them so the controller surface always tells the truth
// about what each button does in the current context.
const MENU_FACE_BUTTONS: ControllerSpec['slots'] = {
  A: { icon: '✓',  label: 'SELECT', colour: '#58ff58' },  // south — confirm
  B: { icon: '·',  label: '',       colour: 'rgba(255,255,255,0.18)' },  // east — no-op in menus
  X: { icon: '·',  label: '',       colour: 'rgba(255,255,255,0.18)' },  // west — no-op in menus
  Y: { icon: '↩',  label: 'BACK',   colour: '#ffd84a' },  // north — escape / dismiss
};

const PALLASITE_SPEC_MENU: ControllerSpec = {
  name: 'PALLASITE · MENU',
  version: 1,
  slots: {
    // D-pad replaces the analog stick in menus + initials — discrete
    // press-and-hold-to-repeat instead of a finicky analog deflection.
    dpadU: { icon: '▲', label: '', colour: '#8cffb4' },
    dpadD: { icon: '▼', label: '', colour: '#8cffb4' },
    dpadL: { icon: '◀', label: '', colour: '#8cffb4' },
    dpadR: { icon: '▶', label: '', colour: '#8cffb4' },
    ...MENU_FACE_BUTTONS,
  },
};

const FIRE_CODE = 'Space';

export interface ControllerHost {
  sessionId: string;
  ws: string;
  pairingUrl: string;
  paired: boolean;
  lastInputAt: number;
  /** Latest identity the phone has announced. null = no signer / revoked. */
  signer: AnnouncedSigner | null;
  /**
   * Ask the phone to sign an event template. Returns the signed event
   * or rejects on timeout / phone-side error / pair-down mid-request.
   * Caller is responsible for matching kinds and validating the
   * returned event's pubkey matches host.signer.pubkey if that matters.
   * Throws 'no-pair' if the controller isn't paired, 'no-signer' if no
   * identity has been announced, 'sign-timeout' if the phone doesn't
   * respond in time, 'sign-failed: <msg>' on phone-side errors.
   */
  signEvent: (template: RemoteEventTemplate) => Promise<RemoteSignedEvent>;
  close: () => void;
  onStatus: (cb: (s: ControllerHostStatus) => void) => void;
  /** Fires when the phone announces a signer (or revokes it via null).
   *  Multi-subscriber: each call adds another listener. Returns a fn
   *  to remove that listener. Late subscribers fire immediately with
   *  the current signer if non-null. */
  onSigner: (cb: (signer: AnnouncedSigner | null) => void) => () => void;
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
  let signer: AnnouncedSigner | null = null;
  let statusCb: ((s: ControllerHostStatus) => void) | null = null;
  const signerCbs = new Set<(s: AnnouncedSigner | null) => void>();
  const fireStatus = (s: ControllerHostStatus): void => { try { statusCb?.(s); } catch { /* ignore */ } };
  const fireSigner = (s: AnnouncedSigner | null): void => {
    for (const cb of signerCbs) {
      try { cb(s); } catch { /* ignore */ }
    }
  };

  // Pending sign-requests waiting on the phone. Keyed by request id.
  // Each entry resolves the corresponding signEvent promise when a
  // sign-response arrives, or rejects on timeout / pair-down / close.
  interface PendingSign {
    resolve: (event: RemoteSignedEvent) => void;
    reject: (err: Error) => void;
    timer: number;
  }
  const pendingSigns = new Map<string, PendingSign>();
  /** Per-request timeout. Generous because the phone may be on a cold
   *  NIP-46 bunker connection — bunker handshakes can run 5-10s before
   *  the first signEvent resolves. The phone is also subject to its
   *  own sign-queue, so multiple inflight requests on the host stack
   *  up serially on the phone. 30s tolerates both. */
  const SIGN_TIMEOUT_MS = 30_000;
  const rejectAllPending = (err: Error): void => {
    for (const [id, p] of pendingSigns) {
      window.clearTimeout(p.timer);
      try { p.reject(err); } catch { /* ignore */ }
      pendingSigns.delete(id);
    }
  };

  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectAttempt = 0;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (ws) try { ws.close(); } catch { /* ignore */ }
    window.clearInterval(phaseWatchTimer);
    clearDpadRepeats();
    state.players[0].keys[FIRE_CODE] = false;
    state.players[0].targetHeading = null;
    state.players[0].thrustOverride = false;
    // Any in-flight signEvent calls die with the host. Reject them so
    // callers (claim, replay, heartbeat) surface a clean error instead
    // of hanging on a closed WS.
    rejectAllPending(new Error('host-closed'));
    if (signer) { signer = null; fireSigner(null); }
    fireStatus({ kind: 'closed' });
  };

  let lastSpecKind: 'play' | 'menu' | null = null;
  const sendSpec = (): void => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const wantKind: 'play' | 'menu' = MENU_PHASES.has(state.phase) ? 'menu' : 'play';
    if (wantKind === lastSpecKind) return;
    lastSpecKind = wantKind;
    const spec = wantKind === 'menu' ? PALLASITE_SPEC_MENU : PALLASITE_SPEC_PLAY;
    try {
      ws.send(JSON.stringify({ type: 'controller-spec', spec }));
    } catch { /* ignore */ }
  };
  // Watch game phase — when it crosses the menu/play boundary, push a
  // fresh spec so the PWA swaps between joystick (play) and d-pad
  // (menu) layouts. 4Hz poll is cheap and the swap is rare enough that
  // the latency is invisible.
  const phaseWatchTimer = window.setInterval(() => {
    if (paired) sendSpec();
  }, 250);

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
            state.players[0].keys[FIRE_CODE] = false;
            state.players[0].targetHeading = null;
            state.players[0].thrustOverride = false;
            fireStatus({ kind: 'waiting' });
            // Pair lost — drop the remote identity. The phone will
            // re-announce on reconnect if it still has a session.
            if (signer) {
              signer = null;
              fireSigner(null);
            }
            // Reject any in-flight sign-requests — the phone can't
            // respond from a closed peer. Callers retry their own way
            // (or surface 'phone disconnected' to the player).
            rejectAllPending(new Error('peer-disconnected'));
          }
        } else if (obj.type === 'signer-announce') {
          const pubkey = typeof obj.pubkey === 'string' ? obj.pubkey : '';
          if (/^[0-9a-f]{64}$/i.test(pubkey)) {
            const next: AnnouncedSigner = {
              pubkey: pubkey.toLowerCase(),
              ...(typeof obj.npub === 'string' ? { npub: obj.npub } : {}),
              ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
              ...(typeof obj.method === 'string' ? { method: obj.method as AnnouncedSigner['method'] } : {}),
              ...(obj.caps && typeof obj.caps === 'object'
                ? { caps: obj.caps as AnnouncedSigner['caps'] }
                : {}),
            };
            const changed = !signer || signer.pubkey !== next.pubkey
              || signer.name !== next.name || signer.method !== next.method;
            signer = next;
            if (changed) fireSigner(next);
          }
        } else if (obj.type === 'signer-revoke') {
          if (signer) {
            signer = null;
            fireSigner(null);
          }
        } else if (obj.type === 'sign-response') {
          const id = typeof obj.id === 'string' ? obj.id : '';
          const p = id ? pendingSigns.get(id) : undefined;
          if (!p) return;  // stale / unknown id — drop silently
          pendingSigns.delete(id);
          window.clearTimeout(p.timer);
          if (obj.ok === true && obj.event && typeof obj.event === 'object') {
            // Trust the phone's event but sanity-check the shape so a
            // malformed frame doesn't crash downstream verifiers.
            const ev = obj.event as Record<string, unknown>;
            const shapeOk = typeof ev.id === 'string' && typeof ev.pubkey === 'string'
              && typeof ev.kind === 'number' && typeof ev.created_at === 'number'
              && typeof ev.content === 'string' && typeof ev.sig === 'string'
              && Array.isArray(ev.tags);
            if (shapeOk) p.resolve(ev as unknown as RemoteSignedEvent);
            else p.reject(new Error('sign-failed: malformed-response'));
          } else {
            const errMsg = typeof obj.error === 'string' ? obj.error : 'unknown-error';
            p.reject(new Error(`sign-failed: ${errMsg}`));
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
        state.players[0].keys[FIRE_CODE] = false;
        state.players[0].targetHeading = null;
        state.players[0].thrustOverride = false;
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

  const signEvent = (template: RemoteEventTemplate): Promise<RemoteSignedEvent> => {
    return new Promise<RemoteSignedEvent>((resolve, reject) => {
      if (closed) { reject(new Error('host-closed')); return; }
      if (!paired) { reject(new Error('no-pair')); return; }
      if (!signer) { reject(new Error('no-signer')); return; }
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error('no-ws')); return; }
      const id = crypto.randomUUID();
      const frame: SignRequestFrame = { type: 'sign-request', id, template };
      const timer = window.setTimeout(() => {
        if (pendingSigns.delete(id)) reject(new Error('sign-timeout'));
      }, SIGN_TIMEOUT_MS);
      pendingSigns.set(id, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        pendingSigns.delete(id);
        window.clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  return {
    sessionId, ws: wsUrl, pairingUrl,
    get paired() { return paired; },
    get lastInputAt() { return lastInputAt; },
    get signer() { return signer; },
    signEvent,
    close: cleanup,
    onStatus: (cb) => { statusCb = cb; },
    onSigner: (cb) => {
      signerCbs.add(cb);
      // Fire immediately with the current state — late subscribers
      // (the pairing dialog mounts after the host starts) shouldn't
      // miss an announce that already arrived.
      if (signer) {
        try { cb(signer); } catch { /* ignore */ }
      }
      return () => { signerCbs.delete(cb); };
    },
  };
}

/** Phases that have an overlay menu the joystick should drive
 *  (synthetic arrow keys + Enter / Escape). Anything else is gameplay. */
const MENU_PHASES = new Set(['title', 'paused', 'gameover', 'completed']);
let lastMenuCardinal: 'up' | 'down' | 'left' | 'right' | null = null;

/** D-pad button → repeating keyboard arrow. The press starts an
 *  immediate ArrowX key, then a delayed auto-repeat at standard
 *  keyboard cadence (~250ms initial delay, ~80ms repeat). Release
 *  cancels both timers. Multiple held directions stack independently. */
const DPAD_CODE: Record<string, string> = {
  dpadU: 'ArrowUp',
  dpadD: 'ArrowDown',
  dpadL: 'ArrowLeft',
  dpadR: 'ArrowRight',
};
const dpadRepeats = new Map<string, { initial: number; interval: number | null }>();
function clearDpadRepeats(): void {
  for (const { initial, interval } of dpadRepeats.values()) {
    window.clearTimeout(initial);
    if (interval !== null) window.clearInterval(interval);
  }
  dpadRepeats.clear();
}
function startDpadRepeat(slot: string): void {
  const code = DPAD_CODE[slot];
  if (!code) return;
  // Cancel any existing repeat for this slot (debounce repeated press).
  const existing = dpadRepeats.get(slot);
  if (existing) {
    window.clearTimeout(existing.initial);
    if (existing.interval !== null) window.clearInterval(existing.interval);
  }
  dispatchKey(code);
  const initial = window.setTimeout(() => {
    const entry = dpadRepeats.get(slot);
    if (!entry) return;
    entry.interval = window.setInterval(() => dispatchKey(code), 80);
  }, 250);
  dpadRepeats.set(slot, { initial, interval: null });
}
function stopDpadRepeat(slot: string): void {
  const entry = dpadRepeats.get(slot);
  if (!entry) return;
  window.clearTimeout(entry.initial);
  if (entry.interval !== null) window.clearInterval(entry.interval);
  dpadRepeats.delete(slot);
}

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
  const p0 = state.players[0];
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
      p0.targetHeading = angle;
      return;
    }
    case 'joyL-thrust':
      if (inMenu) return;
      p0.thrustOverride = on;
      return;
    case 'joyL-end':
      p0.targetHeading = null;
      p0.thrustOverride = false;
      lastMenuCardinal = null;
      return;
    case 'joyL-tap':
      if (!on) return;
      if (inMenu) { dispatchKey('Enter'); return; }
      p0.keys[FIRE_CODE] = true;
      window.setTimeout(() => { p0.keys[FIRE_CODE] = false; }, 60);
      return;
    // ── Face buttons ────────────────────────────────────────────────
    case 'A':
      if (inMenu) {
        if (on) dispatchKey('Enter');
        return;
      }
      p0.keys[FIRE_CODE] = on;
      return;
    case 'B':
      if (!on) return;
      if (state.phase === 'playing') localEdges[0].shield = true;
      return;
    case 'X':
      if (!on) return;
      if (state.phase === 'playing') localEdges[0].hyperspace = true;
      return;
    case 'Y':
      if (!on) return;
      // Universally Escape — game's keydown handler interprets per
      // phase (pauses playing, resumes paused, dismisses overlays).
      dispatchKey('Escape');
      return;
    // ── D-pad — arrow keys with keyboard-style auto-repeat ─────────
    case 'dpadU':
    case 'dpadD':
    case 'dpadL':
    case 'dpadR':
      if (on) startDpadRepeat(slot);
      else stopDpadRepeat(slot);
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
