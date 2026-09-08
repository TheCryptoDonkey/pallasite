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
  window.dispatchEvent(new Event('pallasite:release-touch'));
  if (root) root.dataset.mode = m;
}

const ROOT_ID = 'touch-controls';

interface ButtonSpec {
  cls: string;
  label: string;
  keys: string[];
  oneShot?: (state: GameState, now: number) => void;
}

/** Mirror writers touch.ts uses in peer mode so the joystick / button
 *  state isn't lost to the delayed-input apply step. Solo and couch
 *  pass `null` for `mirror` — the writes then only go to PlayerState as
 *  they did pre-multiplayer. */
type TouchKeyWriter = (slot: number, code: string, owner: object, pressed: boolean) => void;

export interface TouchInputMirror {
  setHeading(slot: number, heading: number | null): void;
  setThrust(slot: number, thrust: boolean): void;
  setKey(slot: number, code: string, pressed: boolean): void;
}

/** Wire touch controls. Both input modes are rendered side-by-side; CSS
 *  hides the inactive set via the `data-mode` attribute on the root.
 *
 *  `getLocalSlot` returns which players[] slot the local touch input
 *  should target. Solo / couch passes a fixed-0 accessor; duel mode
 *  passes a closure over `mpSlot` so the slot-1 client's joystick
 *  writes to players[1] rather than into the partner's slot.
 *
 *  `mirror` is the peer-mode local input mirror; main.ts passes it when
 *  the lockstep loop is active so joystick heading + thrust + tap-fire
 *  survive the per-tick apply step that clobbers p.* fields. */
export function setupTouchControls(
  state: GameState,
  hyperspace: (s: GameState, now: number) => void,
  activateShield: (s: GameState, now: number) => void,
  getLocalSlot: () => number = () => 0,
  mirror: TouchInputMirror | null = null,
): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;
  root.dataset.mode = getTouchMode();
  // A joystick tap and a held FIRE button can own Space simultaneously.
  // Releasing one source must not cancel the other thumb's held shot.
  const keyOwners = new Map<string, Set<object>>();
  const writeKey: TouchKeyWriter = (slot, code, owner, pressed) => {
    const id = `${slot}:${code}`;
    const owners = keyOwners.get(id) ?? new Set<object>();
    if (pressed) owners.add(owner); else owners.delete(owner);
    if (owners.size) keyOwners.set(id, owners); else keyOwners.delete(id);
    const player = state.players[slot];
    if (player) player.keys[code] = owners.size > 0;
    mirror?.setKey(slot, code, owners.size > 0);
  };

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
    attachButton(parent, spec, state, getLocalSlot, writeKey);
  }

  // ── Joystick mode — left pad + right action cluster ──
  const pad = document.createElement('div');
  pad.className = 'joystick-pad joystick-mode';
  const knob = document.createElement('div');
  knob.className = 'joystick-knob';
  pad.appendChild(knob);
  root.appendChild(pad);
  attachJoystick(pad, knob, state, getLocalSlot, mirror, writeKey);

  // Right cluster in joystick mode reuses fire/hyper/shield only
  const joyRight = createCluster('right joystick-mode joy-right');
  root.appendChild(joyRight);
  const joyRightButtons: Array<{ parent: HTMLElement; spec: ButtonSpec }> = [
    { parent: joyRight, spec: { cls: 'fire',   label: 'FIRE', keys: ['Space'] } },
    { parent: joyRight, spec: { cls: 'hyper',  label: '⚡',   keys: [], oneShot: hyperspace } },
    { parent: joyRight, spec: { cls: 'shield', label: '⛨',   keys: [], oneShot: activateShield } },
  ];
  for (const { parent, spec } of joyRightButtons) {
    attachButton(parent, spec, state, getLocalSlot, writeKey);
  }
}

function createCluster(modifier: string): HTMLElement {
  const div = document.createElement('div');
  div.className = `touch-cluster ${modifier}`;
  return div;
}

function attachButton(parent: HTMLElement, spec: ButtonSpec, state: GameState, getLocalSlot: () => number, writeKey: TouchKeyWriter): void {
  const btn = document.createElement('button');
  btn.className = `touch-btn ${spec.cls}`;
  btn.textContent = spec.label;
  btn.type = 'button';
  parent.appendChild(btn);

  let activeId: number | null = null;
  let pressedSlot = 0;
  const release = (): void => {
    if (activeId === null) return;
    activeId = null;
    btn.classList.remove('held');
    for (const k of spec.keys) {
      writeKey(pressedSlot, k, btn, false);
    }
  };
  btn.setAttribute('aria-label', ({ rotL: 'Rotate left', rotR: 'Rotate right', thrust: 'Thrust', fire: 'Fire', hyper: 'Hyperspace', shield: 'Shield' } as Record<string, string>)[spec.cls] ?? spec.label);
  btn.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    release();
    activeId = e.pointerId;
    pressedSlot = getLocalSlot();
    const player = state.players[pressedSlot];
    if (!player) { release(); return; }
    btn.classList.add('held');
    void audio.unlockAudio();
    for (const k of spec.keys) {
      writeKey(pressedSlot, k, btn, true);
    }
    if (spec.oneShot) spec.oneShot(state, state.elapsed);
  });
  const end = (e: PointerEvent): void => { if (e.pointerId === activeId) release(); };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  window.addEventListener('blur', release);
  window.addEventListener('resize', release);
  window.addEventListener('pallasite:release-touch', release);
  document.addEventListener('visibilitychange', () => { if (document.hidden) release(); });
  btn.addEventListener('contextmenu',   e => e.preventDefault());
}

/**
 * Heading-mode virtual joystick — an ABSOLUTE arcade stick: heading + thrust
 * come from the finger's offset from the pad's fixed CENTRE (push toward where
 * you want to go), not from a floating touch-down point. The full 70px throw
 * sits inside the 168px pad, so a normal push never needs to leave it.
 *
 *   - Push: sets `state.targetHeading` (game lerps ship rotation toward it at
 *     8 rad/s) and `state.thrustOverride` (true past THRUST_THRESHOLD).
 *   - Quick tap near centre (released within TAP_TIME_MS, drift < TAP_MOVE_PX):
 *     fires one bullet from the left thumb without affecting heading.
 *   - Release: clears both state hooks so keyboard/no-input resumes.
 *
 * The live drag is tracked on the WINDOW for the gesture's lifetime, so an
 * overshoot past the pad keeps steering instead of dropping. This is the iOS
 * fix: the previous wiring listened on the pad and released on `pointerleave`,
 * and with a floating origin the thumb crossed the pad edge almost immediately
 * — Safari's `setPointerCapture` doesn't reliably hold a touch pointer, so the
 * leave fired and the stick died mid-flight ("joystick is broken" on iPhone).
 */
function attachJoystick(pad: HTMLElement, knob: HTMLElement, state: GameState, getLocalSlot: () => number, mirror: TouchInputMirror | null, writeKey: TouchKeyWriter): void {
  const MAX_RADIUS       = 70;    // px — knob travel; bumped from 60 for finger comfort
  const HEADING_DEADZONE = 0.18;  // ignore micro-drift before steering kicks in
  const THRUST_THRESHOLD = 0.45;  // half-push or more = engage thrust
  const TAP_TIME_MS      = 220;   // press shorter than this with no drag = fire
  const TAP_MOVE_PX      = 8;     // total movement allowed before tap is "drag"
  const SNAP_BACK_MS     = 140;   // CSS transition 120ms + small margin to safely remove class
  // Local-slot PlayerState resolved on every event via getLocalSlot(),
  // never cached. Solo/couch always returns 0; duel returns mpSlot.

  let activeId: number | null = null;
  let gestureSlot = 0;
  let tapFrame: number | null = null;
  let tapSlot = 0;
  let padCx = 0, padCy = 0;     // pad's CSS centre = the stick's fixed origin, cached at pointerdown so pointermove doesn't trigger a layout read each frame
  let pressedAt = 0;
  let maxDriftPx = 0;
  let didEngage = false;  // true once we cross the heading deadzone — disables tap-fire

  function clearMotion(): void {
    const slot = gestureSlot;
    const p = state.players[slot];
    if (!p) return;
    p.targetHeading = null;
    p.thrustOverride = false;
    mirror?.setHeading(slot, null);
    mirror?.setThrust(slot, false);
  }

  // Drive heading + thrust from the finger's offset from pad centre (absolute).
  function applyFinger(clientX: number, clientY: number): void {
    const dx = clientX - padCx;
    const dy = clientY - padCy;
    const dist = Math.hypot(dx, dy);
    if (dist > maxDriftPx) maxDriftPx = dist;
    const clipped = Math.min(dist || 1, MAX_RADIUS);
    const clipDx = (dx / (dist || 1)) * clipped;
    const clipDy = (dy / (dist || 1)) * clipped;
    // Knob translate is relative to its CSS home (the pad centre).
    knob.style.transform = `translate(${clipDx.toFixed(1)}px, ${clipDy.toFixed(1)}px)`;
    const magnitude = clipped / MAX_RADIUS;  // 0..1
    const slot = gestureSlot;
    const p = state.players[slot];
    if (magnitude > HEADING_DEADZONE) {
      didEngage = true;
      // Canvas y-down means Math.atan2(dy, dx) returns angle in canvas frame —
      // matches ship.rot which is also in canvas-frame radians.
      const heading = Math.atan2(dy, dx);
      const thrust = magnitude > THRUST_THRESHOLD;
      p.targetHeading = heading;
      p.thrustOverride = thrust;
      mirror?.setHeading(slot, heading);
      mirror?.setThrust(slot, thrust);
    } else {
      // Inside deadzone — release motion so ship coasts straight
      p.targetHeading = null;
      p.thrustOverride = false;
      mirror?.setHeading(slot, null);
      mirror?.setThrust(slot, false);
    }
  }

  function onMove(e: PointerEvent): void {
    if (e.pointerId !== activeId) return;
    e.preventDefault();  // suppress iOS scroll / rubber-band during the drag
    applyFinger(e.clientX, e.clientY);
  }

  function endGesture(e: PointerEvent): void {
    if (e.pointerId !== activeId) return;
    activeId = null;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endGesture);
    window.removeEventListener('pointercancel', endGesture);
    knob.classList.add('snapping');
    knob.style.transform = '';
    setTimeout(() => knob.classList.remove('snapping'), SNAP_BACK_MS);
    pad.classList.remove('active');
    clearMotion();
    // Tap-to-fire: short press without engaging the heading deadzone fires once.
    const heldMs = performance.now() - pressedAt;
    if (e.type === 'pointerup' && !didEngage && heldMs < TAP_TIME_MS && maxDriftPx < TAP_MOVE_PX) {
      // Pulse Space for one frame so the existing fire-on-keydown path triggers.
      // Game reads keys[Space] in its update loop; clearing in a microtask lets
      // exactly one frame see it as held (which is enough for the fire cooldown
      // path to issue one bullet). Mirror writes go alongside so peer mode's
      // sample sees the Space too.
      const slot = gestureSlot;
      if (state.players[slot].keys.Space) return;
      tapSlot = slot;
      writeKey(slot, 'Space', knob, true);
      tapFrame = requestAnimationFrame(clearTap);
    }
  }

  pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    // Always (re)acquire — a fresh touch takes over the stick; never refuse it.
    // If a previous gesture's pointerup was dropped (iOS drops them on a system
    // edge-swipe or under load), refusing a new touch would strand the ship
    // flying with no way to retake control ("stuck, flies off, can't change
    // it"). endGesture's pointerId check stops a stale finger's late up from
    // clobbering this new gesture.
    if (e.button !== 0) return;
    cancelGesture();
    gestureSlot = getLocalSlot();
    activeId = e.pointerId;
    const rect = pad.getBoundingClientRect();
    padCx = rect.left + rect.width / 2;
    padCy = rect.top + rect.height / 2;
    pressedAt = performance.now();
    maxDriftPx = 0;
    didEngage = false;
    void audio.unlockAudio();
    pad.classList.add('active');
    knob.classList.remove('snapping');
    // Track the drag on the WINDOW so it survives the thumb leaving the pad.
    // Deliberately NO setPointerCapture: implicit touch capture already routes
    // the events, and an explicit capture that iOS only half-holds can swallow
    // the terminating pointerup — the exact stuck-stick we're avoiding. Stable
    // fn refs mean addEventListener de-dupes across re-acquires.
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', endGesture);
    window.addEventListener('pointercancel', endGesture);
    // Reflect the initial touch immediately (absolute aim from pad centre).
    applyFinger(e.clientX, e.clientY);
  });
  pad.addEventListener('contextmenu', e => e.preventDefault());

  function clearTap(): void {
    if (tapFrame === null) return;
    cancelAnimationFrame(tapFrame);
    tapFrame = null;
    writeKey(tapSlot, 'Space', knob, false);
  }
  function cancelGesture(): void {
    clearTap();
    if (activeId !== null) endGesture({ pointerId: activeId, type: 'pointercancel' } as PointerEvent);
  }
  window.addEventListener('blur', cancelGesture);
  window.addEventListener('resize', cancelGesture);
  window.addEventListener('pallasite:release-touch', cancelGesture);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancelGesture(); });
}
