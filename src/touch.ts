/**
 * Touch controls — two input modes:
 *
 *   'buttons'  — discrete d-pad cluster (rotate L/R + thrust on the left,
 *                fire + hyper + shield on the right). Authentic to the 1979
 *                arcade cabinet's button layout. Tank-control feel preserved
 *                for purists.
 *
 *   'joystick' — heading-mode virtual stick (point in direction, ship rotates
 *                to face it; deflection past a threshold thrusts). Quick tap
 *                without drag fires a single shot from the left thumb. Right-
 *                thumb cluster keeps fire/hyper/shield. Maps angle directly,
 *                not L/R-rotate-then-thrust — far more intuitive for players
 *                who haven't memorised tank controls.
 *
 * Both modes funnel input into the same `state.keys` codes the keyboard
 * sets (joystick additionally drives `state.targetHeading` + `state.thrustOverride`).
 *
 * Mode toggle persists in localStorage; SETTINGS panel surfaces the choice.
 */

import type { GameState } from './types.js';
import * as audio from './audio.js';

export type TouchInputMode = 'buttons' | 'joystick';

const MODE_KEY = 'pallasite:touchMode';

export function getTouchMode(): TouchInputMode {
  try {
    const v = localStorage.getItem(MODE_KEY);
    if (v === 'buttons' || v === 'joystick') return v;
  } catch { /* ignore */ }
  // Mobile-first default: joystick maps better to a thumb than a d-pad.
  // Coarse pointer is the most reliable touch-primary signal — laptops with
  // touchscreens still report 'fine' as the primary, so this won't surprise
  // a hybrid-device user. Desktop default stays buttons (keyboard-equivalent).
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
    return 'joystick';
  }
  return 'buttons';
}

export function setTouchMode(m: TouchInputMode): void {
  try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ }
  const root = document.getElementById(ROOT_ID);
  if (root) root.dataset.mode = m;
}

const ROOT_ID = 'touch-controls';

interface ButtonSpec {
  cls: string;
  label: string;
  keys: string[];
  oneShot?: (state: GameState, now: number) => void;
}

/** Wire touch controls. Both input modes are rendered side-by-side; CSS
 *  hides the inactive set via the `data-mode` attribute on the root.
 *
 *  `getLocalSlot` returns which players[] slot the local touch input
 *  should target. Solo / couch passes a fixed-0 accessor; duel mode
 *  passes a closure over `mpSlot` so the slot-1 client's joystick
 *  writes to players[1] rather than into the partner's slot. */
export function setupTouchControls(
  state: GameState,
  hyperspace: (s: GameState, now: number) => void,
  activateShield: (s: GameState, now: number) => void,
  getLocalSlot: () => 0 | 1 = () => 0,
): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.dataset.mode = getTouchMode();

  const reveal = (): void => {
    document.body.classList.add('touch-active');
    window.removeEventListener('touchstart', reveal);
  };
  window.addEventListener('touchstart', reveal, { passive: true, once: true });

  // ── Buttons mode — left + right clusters ──
  const buttonsLeft  = createCluster('left  buttons-mode');
  const buttonsRight = createCluster('right buttons-mode');
  root.appendChild(buttonsLeft);
  root.appendChild(buttonsRight);

  const leftButtons: Array<{ parent: HTMLElement; spec: ButtonSpec }> = [
    { parent: buttonsLeft,  spec: { cls: 'thrust', label: '▲', keys: ['ArrowUp'] } },
    { parent: buttonsLeft,  spec: { cls: 'rotL',   label: '◀', keys: ['ArrowLeft'] } },
    { parent: buttonsLeft,  spec: { cls: 'rotR',   label: '▶', keys: ['ArrowRight'] } },
  ];
  const rightButtons: Array<{ parent: HTMLElement; spec: ButtonSpec }> = [
    { parent: buttonsRight, spec: { cls: 'fire',   label: 'FIRE', keys: ['Space'] } },
    { parent: buttonsRight, spec: { cls: 'hyper',  label: '⚡',   keys: [], oneShot: hyperspace } },
    { parent: buttonsRight, spec: { cls: 'shield', label: '⛨',   keys: [], oneShot: activateShield } },
  ];
  for (const { parent, spec } of [...leftButtons, ...rightButtons]) {
    attachButton(parent, spec, state, getLocalSlot);
  }

  // ── Joystick mode — left pad + right action cluster ──
  const pad = document.createElement('div');
  pad.className = 'joystick-pad joystick-mode';
  const knob = document.createElement('div');
  knob.className = 'joystick-knob';
  pad.appendChild(knob);
  root.appendChild(pad);
  attachJoystick(pad, knob, state, getLocalSlot);

  // Right cluster in joystick mode reuses fire/hyper/shield only
  const joyRight = createCluster('right joystick-mode joy-right');
  root.appendChild(joyRight);
  const joyRightButtons: Array<{ parent: HTMLElement; spec: ButtonSpec }> = [
    { parent: joyRight, spec: { cls: 'fire',   label: 'FIRE', keys: ['Space'] } },
    { parent: joyRight, spec: { cls: 'hyper',  label: '⚡',   keys: [], oneShot: hyperspace } },
    { parent: joyRight, spec: { cls: 'shield', label: '⛨',   keys: [], oneShot: activateShield } },
  ];
  for (const { parent, spec } of joyRightButtons) {
    attachButton(parent, spec, state, getLocalSlot);
  }
}

function createCluster(modifier: string): HTMLElement {
  const div = document.createElement('div');
  div.className = `touch-cluster ${modifier}`;
  return div;
}

function attachButton(parent: HTMLElement, spec: ButtonSpec, state: GameState, getLocalSlot: () => 0 | 1): void {
  const btn = document.createElement('button');
  btn.className = `touch-btn ${spec.cls}`;
  btn.textContent = spec.label;
  btn.type = 'button';
  parent.appendChild(btn);

  const press = (): void => {
    btn.classList.add('held');
    void audio.unlockAudio();
    const slot = getLocalSlot();
    for (const k of spec.keys) state.players[slot].keys[k] = true;
    if (spec.oneShot) spec.oneShot(state, state.elapsed);
  };
  const release = (): void => {
    btn.classList.remove('held');
    const slot = getLocalSlot();
    for (const k of spec.keys) state.players[slot].keys[k] = false;
  };

  btn.addEventListener('pointerdown',  e => { e.preventDefault(); press(); });
  btn.addEventListener('pointerup',     e => { e.preventDefault(); release(); });
  btn.addEventListener('pointercancel', e => { e.preventDefault(); release(); });
  btn.addEventListener('pointerleave',  () => release());
  btn.addEventListener('contextmenu',   e => e.preventDefault());
}

/**
 * Heading-mode virtual joystick with floating origin: the touchdown point
 * becomes the stick centre for that gesture (nipplejs `dynamic` mode), so
 * thumb position is never dictated by where CSS placed the pad. Stick angle
 * drives the ship's target heading; deflection magnitude past a threshold
 * engages thrust.
 *
 *   - Drag: sets `state.targetHeading` (game lerps ship rotation toward it
 *     at ~8 rad/s) and `state.thrustOverride` (true past THRUST_THRESHOLD).
 *   - Quick tap (released within TAP_TIME_MS, drag < TAP_MOVE_PX): fires one
 *     bullet from the left thumb without affecting heading.
 *   - Release: clears both state hooks so keyboard/no-input resumes.
 */
function attachJoystick(pad: HTMLElement, knob: HTMLElement, state: GameState, getLocalSlot: () => 0 | 1): void {
  const MAX_RADIUS       = 70;    // px — knob travel; bumped from 60 for finger comfort
  const HEADING_DEADZONE = 0.18;  // ignore micro-drift before steering kicks in
  const THRUST_THRESHOLD = 0.45;  // half-push or more = engage thrust
  const TAP_TIME_MS      = 220;   // press shorter than this with no drag = fire
  const TAP_MOVE_PX      = 8;     // total movement allowed before tap is "drag"
  const SNAP_BACK_MS     = 140;   // CSS transition 120ms + small margin to safely remove class
  // Resolve the local-slot PlayerState on EVERY event, never cache. Two
  // reasons:
  //   1) startGame() rebuilds s.players from scratch (`s.players = []`
  //      then push), so a closure-captured reference from boot points
  //      at a dead object after the first IGNITE and joystick writes
  //      silently no-op.
  //   2) In duel mode the local slot is mpSlot (0 or 1), not always 0.
  //      Hardcoding `state.players[0]` made the slot-1 client's joystick
  //      drive the partner's slot — which got overwritten by the
  //      partner's lockstep input every frame, so the joystick appeared
  //      dead to the slot-1 player.
  const p0 = (): typeof state.players[number] => state.players[getLocalSlot()];

  let activeId: number | null = null;
  let originX = 0, originY = 0;
  let padCx = 0, padCy = 0;     // pad's CSS centre, cached at pointerdown so pointermove doesn't trigger layout reads each frame
  let pressedAt = 0;
  let maxDriftPx = 0;
  let didEngage = false;  // true once we cross the heading deadzone — disables tap-fire

  function clearMotion(): void {
    const p = p0();
    p.targetHeading = null;
    p.thrustOverride = false;
  }

  pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    activeId = e.pointerId;
    const rect = pad.getBoundingClientRect();
    padCx = rect.left + rect.width / 2;
    padCy = rect.top + rect.height / 2;
    originX = e.clientX;
    originY = e.clientY;
    pressedAt = performance.now();
    maxDriftPx = 0;
    didEngage = false;
    pad.setPointerCapture(e.pointerId);
    void audio.unlockAudio();
    pad.classList.add('active');
    // Snap the knob to under the finger (no animation) so the visual centre is
    // where the user touched, not where CSS positioned the pad.
    knob.classList.remove('snapping');
    knob.style.transform = `translate(${(originX - padCx).toFixed(1)}px, ${(originY - padCy).toFixed(1)}px)`;
  });

  pad.addEventListener('pointermove', e => {
    if (e.pointerId !== activeId) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDriftPx) maxDriftPx = dist;
    const clipped = Math.min(dist || 1, MAX_RADIUS);
    const clipDx = (dx / (dist || 1)) * clipped;
    const clipDy = (dy / (dist || 1)) * clipped;
    // Knob translate is relative to its CSS home (pad centre); compose the
    // floating-origin offset with the clipped drag delta.
    const knobX = (originX - padCx) + clipDx;
    const knobY = (originY - padCy) + clipDy;
    knob.style.transform = `translate(${knobX.toFixed(1)}px, ${knobY.toFixed(1)}px)`;
    const magnitude = clipped / MAX_RADIUS;  // 0..1
    const p = p0();
    if (magnitude > HEADING_DEADZONE) {
      didEngage = true;
      // Canvas y-down means Math.atan2(dy, dx) returns angle in canvas frame —
      // matches ship.rot which is also in canvas-frame radians.
      p.targetHeading = Math.atan2(dy, dx);
      p.thrustOverride = magnitude > THRUST_THRESHOLD;
    } else {
      // Inside deadzone — release motion so ship coasts straight
      p.targetHeading = null;
      p.thrustOverride = false;
    }
  });

  function release(e: PointerEvent): void {
    if (e.pointerId !== activeId) return;
    activeId = null;
    knob.classList.add('snapping');
    knob.style.transform = '';
    setTimeout(() => knob.classList.remove('snapping'), SNAP_BACK_MS);
    pad.classList.remove('active');
    clearMotion();
    // Tap-to-fire: short press without engaging the heading deadzone fires once.
    const heldMs = performance.now() - pressedAt;
    if (!didEngage && heldMs < TAP_TIME_MS && maxDriftPx < TAP_MOVE_PX) {
      // Pulse Space for one frame so the existing fire-on-keydown path triggers.
      // Game reads keys[Space] in its update loop; clearing in a microtask lets
      // exactly one frame see it as held (which is enough for the fire cooldown
      // path to issue one bullet).
      const p = p0();
      p.keys.Space = true;
      requestAnimationFrame(() => { p0().keys.Space = false; });
    }
  }
  pad.addEventListener('pointerup',     release);
  pad.addEventListener('pointercancel', release);
  pad.addEventListener('pointerleave',  release);
  pad.addEventListener('contextmenu',   e => e.preventDefault());

  // PWA backgrounded mid-press: synthesise a release so the knob isn't stuck
  // and the ship doesn't keep thrusting in the void while the user takes a call.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && activeId !== null) {
      release({ pointerId: activeId } as PointerEvent);
    }
  });
}
