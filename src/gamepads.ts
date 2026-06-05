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
 * Aim model: push the left stick to point-and-fly (heading + thrust together,
 * the walk-up-friendly twin-stick feel); the right trigger thrusts straight
 * ahead Asteroids-style when the stick is centred.
 */

import type { GameState } from './types.js';
import { tryHyperspace, tryActivateShield } from './game.js';

const FIRE_CODE = 'Space';
const DEADZONE = 0.30;
const MENU_PHASES = new Set(['title', 'paused', 'gameover', 'completed']);

/** How pollGamepads should route input this frame. In peer mode it writes the
 *  lockstep mirrors; otherwise it writes the player objects directly. */
export interface GamepadRouting {
  /** Pad index i drives game slot pilotSlots[i] — couch [0,1], a linked booth
   *  its owned slots, solo / duel just [mpSlot]. */
  pilotSlots: number[];
  peerActive: boolean;
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
  menuDir: 'up' | 'down' | 'left' | 'right' | null;
}

const memory: PadMemory[] = [];

function freshMemory(): PadMemory {
  return { engaged: false, fire: false, shield: false, hyper: false, pause: false, menuDir: null };
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

  const fire = pressed(pad, 0) || pressed(pad, 7) || pressed(pad, 5);   // A / RT / RB
  const shield = pressed(pad, 1) || pressed(pad, 4);                    // B / LB
  const hyper = pressed(pad, 2) || pressed(pad, 6);                     // X / LT
  const pause = pressed(pad, 3) || pressed(pad, 9);                     // Y / Start
  const thrust = pressed(pad, 7) || pressed(pad, 0);                    // RT / A — straight-ahead thrust

  // Don't touch this slot until the pad has actually been used, so a pad that
  // is connected but idle can't override a keyboard player on the same slot.
  if (!mem.engaged) {
    if (mag > DEADZONE || fire || shield || hyper || pause) mem.engaged = true;
    else return;
  }

  // Route to the lockstep mirror (peer) or the live player (direct).
  const setHeading = (h: number | null): void => { if (peer) routing.localHeading[slot] = h; else player.targetHeading = h; };
  const setThrust = (t: boolean): void => { if (peer) routing.localThrust[slot] = t; else player.thrustOverride = t; };
  const setFire = (f: boolean): void => { if (peer) { const k = routing.localKeys[slot]; if (k) k[FIRE_CODE] = f; } else player.keys[FIRE_CODE] = f; };

  if (MENU_PHASES.has(state.phase)) {
    // Menu phases: the stick / d-pad walk the overlay buttons, A / Start
    // confirm, B / Y dismiss — a kiosk is fully driveable from the pad (e.g.
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
    if ((fire || pause) && !(mem.fire || mem.pause)) dispatchKey(pause && !fire ? 'Escape' : 'Enter');
    if (shield && !mem.shield) dispatchKey('Escape');
    // Park the in-game holds so nothing carries into the next run.
    setHeading(null); setThrust(false); setFire(false);
    mem.fire = fire; mem.shield = shield; mem.hyper = hyper; mem.pause = pause;
    return;
  }
  mem.menuDir = null;

  // ── Playing ──────────────────────────────────────────────────────────
  if (mag > DEADZONE) { setHeading(Math.atan2(ay, ax)); setThrust(true); }
  else { setHeading(null); setThrust(thrust); }
  setFire(fire);

  // Edge-triggered one-shots. In peer mode raise the lockstep edge flag (applied
  // deterministically from the input log); otherwise fire straight, exactly as
  // the keydown handler does in couch / solo.
  if (state.phase === 'playing') {
    if (shield && !mem.shield) { if (peer) routing.edgeFlags[slot].shield = true; else tryActivateShield(state, state.elapsed, player); }
    if (hyper && !mem.hyper) { if (peer) routing.edgeFlags[slot].hyperspace = true; else tryHyperspace(state, state.elapsed, player); }
    if (pause && !mem.pause) dispatchKey('Escape');
  }

  mem.fire = fire; mem.shield = shield; mem.hyper = hyper; mem.pause = pause;
}
