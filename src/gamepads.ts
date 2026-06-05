/**
 * Physical gamepads — local couch / kiosk input.
 *
 * Polled once per animation frame (gamepads have no event stream for held
 * state). The first connected pad drives P1, the second drives P2, mapped
 * straight onto the same player fields the phone-controller host writes
 * (`targetHeading` / `thrustOverride` / `keys[Space]` + shield/hyperspace),
 * so a TV booth with two pads behaves exactly like the touch / phone path.
 *
 * Self-gating:
 *   - No-op in peer/duel mode — lockstep owns the input pipeline there.
 *   - A slot is only driven once its pad shows activity, so a controller that
 *     is merely plugged in never zeroes a keyboard player's input.
 *
 * Aim model: push the left stick to point-and-fly (heading + thrust together,
 * the walk-up-friendly twin-stick feel); the right trigger thrusts straight
 * ahead Asteroids-style when the stick is centred.
 */

import type { GameState } from './types.js';
import { tryHyperspace, tryActivateShield } from './game.js';
import { isPeerActive } from './netcode.js';

const FIRE_CODE = 'Space';
const DEADZONE = 0.30;
const MENU_PHASES = new Set(['title', 'paused', 'gameover', 'completed']);

interface PadMemory {
  engaged: boolean;
  fire: boolean;
  shield: boolean;
  hyper: boolean;
  pause: boolean;
  menuDir: 'up' | 'down' | 'left' | 'right' | null;
}

const memory: PadMemory[] = [freshMemory(), freshMemory()];

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

/** Poll every connected pad and route it onto its player slot. Call once per
 *  rAF, before the sim steps run, so couch's direct-read input pipeline picks
 *  up the live pad state exactly as it does live keyboard state. */
export function pollGamepads(state: GameState): void {
  // Lockstep mode samples + sends input itself; never let a raw pad poke the
  // live player objects out from under it.
  if (isPeerActive()) return;
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return;

  const all = navigator.getGamepads();
  if (!all) return;
  const connected: Gamepad[] = [];
  for (const p of all) if (p && p.connected) connected.push(p);

  const maxSlots = Math.min(state.players.length, 2);
  for (let slot = 0; slot < maxSlots; slot++) {
    const pad = connected[slot];
    if (!pad) continue;
    applyPad(state, slot, pad);
  }
}

function applyPad(state: GameState, slot: number, pad: Gamepad): void {
  const player = state.players[slot];
  if (!player) return;
  const mem = memory[slot];

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

  if (MENU_PHASES.has(state.phase)) {
    // Menu phases: the stick / d-pad walk the overlay buttons, A / Start
    // confirm, B / Y dismiss — mirrors the phone controller's menu spec so a
    // kiosk is fully driveable from the pad (e.g. SPAWN AGAIN after a death).
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
    if ((fire || pause) && !(mem.fire || mem.pause)) {
      dispatchKey(pause && !fire ? 'Escape' : 'Enter');
    }
    if (shield && !mem.shield) dispatchKey('Escape');
    // Park the in-game holds so nothing carries into the next run.
    player.targetHeading = null;
    player.thrustOverride = false;
    player.keys[FIRE_CODE] = false;
    mem.fire = fire; mem.shield = shield; mem.hyper = hyper; mem.pause = pause;
    return;
  }

  mem.menuDir = null;

  // ── Playing ──────────────────────────────────────────────────────────
  if (mag > DEADZONE) {
    player.targetHeading = Math.atan2(ay, ax);
    player.thrustOverride = true;
  } else {
    player.targetHeading = null;
    player.thrustOverride = thrust;
  }
  player.keys[FIRE_CODE] = fire;

  // Edge-triggered one-shots, dispatched straight (couch is never peer-active
  // here, so the same direct calls the keydown handler makes are correct).
  if (state.phase === 'playing') {
    if (shield && !mem.shield) tryActivateShield(state, state.elapsed, player);
    if (hyper && !mem.hyper) tryHyperspace(state, state.elapsed, player);
    if (pause && !mem.pause) dispatchKey('Escape');
  }

  mem.fire = fire; mem.shield = shield; mem.hyper = hyper; mem.pause = pause;
}
