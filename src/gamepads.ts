/**
 * Physical gamepads — local couch / kiosk + linked-booth input.
 *
 * Polled once per animation frame (gamepads have no event stream for held
 * state). pollGamepads is handed the slots its local pilots drive: pad 0 → the
 * first, pad 1 → the second. In peer/lockstep mode it writes the input MIRRORS
 * (localHeading / localThrust / localKeys + edgeFlags) that the lockstep
 * samples — so a linked booth's two pads feed its two owned slots
 * deterministically. In couch / solo it pokes the player objects directly and
 * fires edge actions synchronously, exactly as the keydown handler does.
 *
 * A pad is only driven once it shows activity, so one merely plugged in never
 * zeroes a keyboard player on the same slot.
 *
 * Three flight models (Settings; booth forces 'flydirect'):
 *   flydirect — point-and-fly: push the left stick to aim AND thrust together
 *               (pickup-and-go; most intuitive for a walk-up).
 *   throttle  — left stick aims only, right trigger throttles (precise; hold a
 *               firing line). Matches Nova Drift's "Directional" preset.
 *   classic   — the d-pad is the arcade rotate cluster (left/right turn, up
 *               thrusts), with the left stick as a forgiving fallback and the
 *               right trigger also thrusting. Matches Asteroids: Recharged.
 * The right stick is a twin-stick aim+fire overlay in all three.
 *
 * Buttons are remappable (getPadBindings); auto-thrust turns the throttle into a
 * tap-to-cruise toggle (accessibility, XAG-107). The digital fallback for the
 * analog thrust trigger is to rebind thrust to any button, and/or auto-thrust.
 */

import type { GameState } from './types.js';
import { tryHyperspace, tryActivateShield } from './game.js';

const FIRE_CODE = 'Space';
const DEADZONE = 0.30;
const MENU_PHASES = new Set(['title', 'paused', 'gameover', 'completed']);

// ── Flight model ────────────────────────────────────────────────────────────
export type PadFlightMode = 'flydirect' | 'throttle' | 'classic';
const FLIGHT_MODE_KEY = 'pallasite:padFlightMode';
let flightModeCache: PadFlightMode | null = null;

export function getPadFlightMode(): PadFlightMode {
  if (flightModeCache) return flightModeCache;
  try {
    const v = localStorage.getItem(FLIGHT_MODE_KEY);
    if (v === 'flydirect' || v === 'throttle' || v === 'classic') return (flightModeCache = v);
  } catch { /* ignore */ }
  return (flightModeCache = 'flydirect');
}

export function setPadFlightMode(m: PadFlightMode): void {
  flightModeCache = m;
  try { localStorage.setItem(FLIGHT_MODE_KEY, m); } catch { /* ignore */ }
}

// ── Auto-thrust (accessibility: tap to cruise rather than hold the trigger) ───
const AUTO_THRUST_KEY = 'pallasite:padAutoThrust';
let autoThrustCache: boolean | null = null;

export function getPadAutoThrust(): boolean {
  if (autoThrustCache !== null) return autoThrustCache;
  try { return (autoThrustCache = localStorage.getItem(AUTO_THRUST_KEY) === '1'); } catch { /* ignore */ }
  return (autoThrustCache = false);
}

export function setPadAutoThrust(on: boolean): void {
  autoThrustCache = on;
  try { localStorage.setItem(AUTO_THRUST_KEY, on ? '1' : '0'); } catch { /* ignore */ }
}

// ── Remappable button bindings ───────────────────────────────────────────────
export type PadAction = 'fire' | 'thrust' | 'shield' | 'hyperspace' | 'pause';
export const PAD_ACTIONS: readonly PadAction[] = ['fire', 'thrust', 'shield', 'hyperspace', 'pause'];

/** Human label for each standard-mapping button index (used by the rebind UI). */
export const PAD_BUTTON_NAMES: Readonly<Record<number, string>> = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT',
  8: 'View', 9: 'Menu', 10: 'L3', 11: 'R3', 12: 'D-Up', 13: 'D-Down', 14: 'D-Left', 15: 'D-Right', 16: 'Guide',
};

/** Default action → standard-mapping button indices. */
const DEFAULT_BINDINGS: Record<PadAction, readonly number[]> = {
  fire:       [6, 0],   // LT / A
  thrust:     [7],      // RT
  shield:     [5, 1],   // RB / B
  hyperspace: [4, 2],   // LB / X
  pause:      [3, 9],   // Y / Menu
};
const BINDINGS_KEY = 'pallasite:padBindings';
let bindingsCache: Record<PadAction, number[]> | null = null;

export function getPadBindings(): Record<PadAction, number[]> {
  if (bindingsCache) return bindingsCache;
  const merged = {} as Record<PadAction, number[]>;
  for (const a of PAD_ACTIONS) merged[a] = [...DEFAULT_BINDINGS[a]];
  try {
    const raw = localStorage.getItem(BINDINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Record<PadAction, unknown>>;
      for (const a of PAD_ACTIONS) {
        const v = parsed[a];
        if (Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number')) merged[a] = v as number[];
      }
    }
  } catch { /* ignore */ }
  return (bindingsCache = merged);
}

export function getPadDefaultBindings(): Record<PadAction, number[]> {
  const out = {} as Record<PadAction, number[]>;
  for (const a of PAD_ACTIONS) out[a] = [...DEFAULT_BINDINGS[a]];
  return out;
}

export function setPadBinding(action: PadAction, buttons: number[]): void {
  const b = getPadBindings();
  b[action] = buttons.length ? buttons.slice() : [...DEFAULT_BINDINGS[action]];
  bindingsCache = b;
  try { localStorage.setItem(BINDINGS_KEY, JSON.stringify(b)); } catch { /* ignore */ }
}

export function resetPadBindings(): void {
  bindingsCache = null;
  try { localStorage.removeItem(BINDINGS_KEY); } catch { /* ignore */ }
}

/** While the rebind UI is capturing the next button press, suppress all pad
 *  routing so the press doesn't also drive menu navigation. */
let inputSuppressed = false;
export function setPadInputSuppressed(v: boolean): void { inputSuppressed = v; }

/** How pollGamepads should route input this frame. In peer mode it writes the
 *  lockstep mirrors; otherwise it writes the player objects directly. */
export interface GamepadRouting {
  /** Pad index i drives game slot pilotSlots[i] — couch [0,1], a linked booth
   *  its owned slots, solo / duel just [mpSlot]. */
  pilotSlots: number[];
  peerActive: boolean;
  /** Effective left-stick flight model this frame (booth → always 'flydirect'). */
  flightMode: PadFlightMode;
  /** Tap-to-cruise instead of holding the throttle (booth → always false). */
  autoThrust: boolean;
  localKeys: Record<string, boolean>[];
  localHeading: (number | null)[];
  localThrust: boolean[];
  edgeFlags: Array<{ shield: boolean; hyperspace: boolean }>;
}

interface PadMemory {
  engaged: boolean;
  fire: boolean;
  shield: boolean;
  hyper: boolean;
  pause: boolean;
  thrust: boolean;
  /** Auto-thrust cruise toggle state. */
  cruise: boolean;
  /** Keys this pad is currently holding, so it only ever releases its OWN
   *  presses and never clears a key a keyboard co-driver on the slot holds. */
  heldKeys: Record<string, boolean>;
  menuDir: 'up' | 'down' | 'left' | 'right' | null;
  /** Edge memory for the menu confirm (A) and back (B) buttons. Kept separate
   *  from the in-game fire/shield/pause edges so a quirky pad can't mask them. */
  menuA: boolean;
  menuB: boolean;
}

const memory: PadMemory[] = [];

function freshMemory(): PadMemory {
  return { engaged: false, fire: false, shield: false, hyper: false, pause: false, thrust: false, cruise: false, heldKeys: {}, menuDir: null, menuA: false, menuB: false };
}

function dispatchKey(code: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { code, key: code, bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code, key: code, bubbles: true }));
}

function pressed(pad: Gamepad, i: number): boolean {
  const b = pad.buttons[i];
  return !!b && (b.pressed || b.value > 0.5);
}

/** Poll every connected pad and route it onto its pilot's slot. Call once per
 *  rAF, before the sim steps run. */
export function pollGamepads(state: GameState, routing: GamepadRouting): void {
  if (inputSuppressed) return;
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;
  const all = navigator.getGamepads();
  if (!all) return;
  const connected: Gamepad[] = [];
  for (const p of all) if (p && p.connected) connected.push(p);

  const maxPads = Math.min(connected.length, routing.pilotSlots.length);
  for (let padIndex = 0; padIndex < maxPads; padIndex++) {
    const slot = routing.pilotSlots[padIndex];
    if (slot < 0 || slot >= state.players.length) continue;
    while (memory.length <= padIndex) memory.push(freshMemory());
    applyPad(state, padIndex, slot, connected[padIndex], routing);
  }
}

function applyPad(state: GameState, padIndex: number, slot: number, pad: Gamepad, routing: GamepadRouting): void {
  const player = state.players[slot];
  if (!player) return;
  const mem = memory[padIndex];
  const peer = routing.peerActive;

  const ax = pad.axes[0] ?? 0;
  const ay = pad.axes[1] ?? 0;
  const mag = Math.hypot(ax, ay);

  // Right stick — twin-stick aim+fire overlay (axes 2/3 on a standard pad).
  const rx = pad.axes[2] ?? 0;
  const ry = pad.axes[3] ?? 0;
  const rmag = Math.hypot(rx, ry);

  const bindings = getPadBindings();
  const act = (a: PadAction): boolean => bindings[a].some((i) => pressed(pad, i));
  const fire = act('fire');
  const thrustBtn = act('thrust');
  const shield = act('shield');
  const hyper = act('hyperspace');
  const pause = act('pause');

  const dpad = pressed(pad, 12) || pressed(pad, 13) || pressed(pad, 14) || pressed(pad, 15);

  // Don't touch this slot until the pad has actually been used, so a pad that
  // is connected but idle can't override a keyboard player on the same slot.
  if (!mem.engaged) {
    if (mag > DEADZONE || rmag > DEADZONE || dpad || thrustBtn || fire || shield || hyper || pause) mem.engaged = true;
    else return;
  }

  // Route to the lockstep mirror (peer) or the live player (direct).
  const setHeading = (h: number | null): void => { if (peer) routing.localHeading[slot] = h; else player.targetHeading = h; };
  const setThrust = (t: boolean): void => { if (peer) routing.localThrust[slot] = t; else player.thrustOverride = t; };
  const writeKey = (code: string, v: boolean): void => { if (peer) { const k = routing.localKeys[slot]; if (k) k[code] = v; } else player.keys[code] = v; };
  // Only ever touch a key the pad is actually driving: set it on press, clear it
  // on the pad's OWN release. An idle pad must not wipe a key a keyboard player
  // on the same slot is holding (couch P1 / solo share a slot with the pad).
  const setKey = (code: string, v: boolean): void => {
    if (v) { mem.heldKeys[code] = true; writeKey(code, true); }
    else if (mem.heldKeys[code]) { mem.heldKeys[code] = false; writeKey(code, false); }
  };
  const setFire = (f: boolean): void => setKey(FIRE_CODE, f);
  // Classic rate-rotate routes through the same ArrowLeft/Right path the
  // keyboard uses, so its turn feel (and lockstep encoding) is identical.
  const setTurn = (dir: number): void => { setKey('ArrowLeft', dir < 0); setKey('ArrowRight', dir > 0); };

  if (MENU_PHASES.has(state.phase)) {
    // Menu phases: the stick / d-pad walk the overlay buttons, fire / pause
    // confirm, shield dismisses — a kiosk is fully driveable from the pad (e.g.
    // SPAWN AGAIN after a death). Synthetic keys go through the normal handlers.
    const dx = (pad.axes[0] ?? 0) + (pressed(pad, 15) ? 1 : 0) - (pressed(pad, 14) ? 1 : 0);
    const dy = (pad.axes[1] ?? 0) + (pressed(pad, 13) ? 1 : 0) - (pressed(pad, 12) ? 1 : 0);
    let dir: PadMemory['menuDir'] = null;
    if (Math.abs(dx) > 0.55 || Math.abs(dy) > 0.55) {
      dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    }
    if (dir && dir !== mem.menuDir) {
      dispatchKey(dir === 'up' ? 'ArrowUp' : dir === 'down' ? 'ArrowDown' : dir === 'left' ? 'ArrowLeft' : 'ArrowRight');
    }
    mem.menuDir = dir;
    // Confirm / back use the STANDARD face buttons by index — independent of
    // the in-game fire/shield/pause bindings and of each other. The old logic
    // gated fire→Enter behind !(mem.fire || mem.pause); a pad that resting-
    // reports its Start/extra button as 'pause' kept mem.pause true and so
    // masked confirm forever (A "did nothing" while B/arrows worked). A (0) =
    // select; B (1) / View (8) / Menu (9) = back.
    const aBtn = pressed(pad, 0);
    const bBtn = pressed(pad, 1) || pressed(pad, 8) || pressed(pad, 9);
    if (aBtn && !mem.menuA) dispatchKey('Enter');
    if (bBtn && !mem.menuB) dispatchKey('Escape');
    mem.menuA = aBtn; mem.menuB = bBtn;
    // Park the in-game holds so nothing carries into the next run.
    setHeading(null); setThrust(false); setFire(false); setTurn(0);
    mem.cruise = false;
    mem.fire = fire; mem.shield = shield; mem.hyper = hyper; mem.pause = pause; mem.thrust = thrustBtn;
    return;
  }
  mem.menuDir = null;

  // Auto-thrust: a tap of the throttle toggles a sustained cruise, so a player
  // never has to hold the trigger (XAG-107). Otherwise thrust is held-to-go.
  let throttle = thrustBtn;
  if (routing.autoThrust) {
    if (thrustBtn && !mem.thrust) mem.cruise = !mem.cruise;
    throttle = mem.cruise;
  }

  // ── Aim / turn ───────────────────────────────────────────────────────────
  // Right stick is the twin-stick overlay in every mode: push it to face that
  // way and auto-fire. Otherwise the flight model decides what the left stick
  // does: 'classic' rate-turns (arcade rotate buttons); the other two set an
  // absolute heading (point-and-fly / aim).
  const classic = routing.flightMode === 'classic';
  if (rmag > DEADZONE) {
    setHeading(Math.atan2(ry, rx)); setTurn(0); setFire(true);
  } else if (classic) {
    // Classic arcade: the d-pad is the rotate cluster (left/right), with the
    // left stick as a forgiving alternative; d-pad up also thrusts.
    setHeading(null);
    const left = pressed(pad, 14) || ax < -DEADZONE;
    const right = pressed(pad, 15) || ax > DEADZONE;
    setTurn(left === right ? 0 : left ? -1 : 1);
    setFire(fire);
  } else {
    setHeading(mag > DEADZONE ? Math.atan2(ay, ax) : null);
    setTurn(0);
    setFire(fire);
  }

  // Thrust: the throttle always drives. In 'flydirect' a left-stick push also
  // thrusts (point-and-fly), unless the right stick is steering the aim; in
  // 'classic' d-pad up thrusts like the arcade thrust button.
  const stickThrust = routing.flightMode === 'flydirect' && rmag <= DEADZONE && mag > DEADZONE;
  const dpadThrust = classic && pressed(pad, 12);
  setThrust(throttle || stickThrust || dpadThrust);

  // Edge-triggered one-shots. In peer mode raise the lockstep edge flag (applied
  // deterministically from the input log); otherwise fire straight, exactly as
  // the keydown handler does in couch / solo.
  if (state.phase === 'playing') {
    if (shield && !mem.shield) { if (peer) routing.edgeFlags[slot].shield = true; else tryActivateShield(state, state.elapsed, player); }
    if (hyper && !mem.hyper) { if (peer) routing.edgeFlags[slot].hyperspace = true; else tryHyperspace(state, state.elapsed, player); }
    if (pause && !mem.pause) dispatchKey('Escape');
  }

  mem.fire = fire; mem.shield = shield; mem.hyper = hyper; mem.pause = pause; mem.thrust = thrustBtn;
}
