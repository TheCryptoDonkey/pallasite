/**
 * Touch controls — two input modes:
 *
 *   'buttons'  — discrete d-pad cluster (rotate L/R + thrust on the left,
 *                fire + hyper + shield on the right). Authentic to the 1979
 *                arcade cabinet's button layout.
 *
 *   'joystick' — left-thumb virtual joystick (drag for rotate + thrust),
 *                right-thumb action cluster (fire + hyper + shield). One-stick
 *                steering for players who prefer modern mobile shooters.
 *
 * Both modes funnel input into the same `state.keys` codes the keyboard
 * sets, so combat logic doesn't need to know how the player is steering.
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
 *  hides the inactive set via the `data-mode` attribute on the root. */
export function setupTouchControls(
  state: GameState,
  hyperspace: (s: GameState, now: number) => void,
  activateShield: (s: GameState, now: number) => void,
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
    attachButton(parent, spec, state);
  }

  // ── Joystick mode — left pad + right action cluster ──
  const pad = document.createElement('div');
  pad.className = 'joystick-pad joystick-mode';
  const knob = document.createElement('div');
  knob.className = 'joystick-knob';
  pad.appendChild(knob);
  root.appendChild(pad);
  attachJoystick(pad, knob, state);

  // Right cluster in joystick mode reuses fire/hyper/shield only
  const joyRight = createCluster('right joystick-mode joy-right');
  root.appendChild(joyRight);
  const joyRightButtons: Array<{ parent: HTMLElement; spec: ButtonSpec }> = [
    { parent: joyRight, spec: { cls: 'fire',   label: 'FIRE', keys: ['Space'] } },
    { parent: joyRight, spec: { cls: 'hyper',  label: '⚡',   keys: [], oneShot: hyperspace } },
    { parent: joyRight, spec: { cls: 'shield', label: '⛨',   keys: [], oneShot: activateShield } },
  ];
  for (const { parent, spec } of joyRightButtons) {
    attachButton(parent, spec, state);
  }
}

function createCluster(modifier: string): HTMLElement {
  const div = document.createElement('div');
  div.className = `touch-cluster ${modifier}`;
  return div;
}

function attachButton(parent: HTMLElement, spec: ButtonSpec, state: GameState): void {
  const btn = document.createElement('button');
  btn.className = `touch-btn ${spec.cls}`;
  btn.textContent = spec.label;
  btn.type = 'button';
  parent.appendChild(btn);

  const press = (): void => {
    btn.classList.add('held');
    void audio.unlockAudio();
    for (const k of spec.keys) state.keys[k] = true;
    if (spec.oneShot) spec.oneShot(state, performance.now());
  };
  const release = (): void => {
    btn.classList.remove('held');
    for (const k of spec.keys) state.keys[k] = false;
  };

  btn.addEventListener('pointerdown',  e => { e.preventDefault(); press(); });
  btn.addEventListener('pointerup',     e => { e.preventDefault(); release(); });
  btn.addEventListener('pointercancel', e => { e.preventDefault(); release(); });
  btn.addEventListener('pointerleave',  () => release());
  btn.addEventListener('contextmenu',   e => e.preventDefault());
}

/**
 * Virtual joystick: drag from the pad centre to set rotation + thrust.
 * X axis maps to ArrowLeft/Right above a deadzone; Y axis maps to ArrowUp
 * (thrust) when pulled toward the top. Down does nothing — Asteroids has
 * no reverse thrust. The knob visually tracks the finger inside a fixed
 * radius; release returns it to centre and clears all input.
 */
function attachJoystick(pad: HTMLElement, knob: HTMLElement, state: GameState): void {
  const MAX_RADIUS = 60;     // px — max knob travel from centre
  const X_DEADZONE = 0.25;   // ignore tiny drift on rotation
  const Y_DEADZONE = 0.30;   // thrust needs a clear pull upward

  let activeId: number | null = null;
  let originX = 0, originY = 0;

  function clearKeys(): void {
    state.keys.ArrowLeft = false;
    state.keys.ArrowRight = false;
    state.keys.ArrowUp = false;
  }

  pad.addEventListener('pointerdown', e => {
    e.preventDefault();
    activeId = e.pointerId;
    const rect = pad.getBoundingClientRect();
    originX = rect.left + rect.width / 2;
    originY = rect.top + rect.height / 2;
    pad.setPointerCapture(e.pointerId);
    void audio.unlockAudio();
    pad.classList.add('active');
  });

  pad.addEventListener('pointermove', e => {
    if (e.pointerId !== activeId) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    const dist = Math.hypot(dx, dy) || 1;
    const clipped = Math.min(dist, MAX_RADIUS);
    const kx = (dx / dist) * clipped;
    const ky = (dy / dist) * clipped;
    knob.style.transform = `translate(${kx.toFixed(1)}px, ${ky.toFixed(1)}px)`;
    const nx = kx / MAX_RADIUS;
    const ny = ky / MAX_RADIUS;
    state.keys.ArrowLeft  = nx < -X_DEADZONE;
    state.keys.ArrowRight = nx >  X_DEADZONE;
    state.keys.ArrowUp    = ny < -Y_DEADZONE;
  });

  function release(e: PointerEvent): void {
    if (e.pointerId !== activeId) return;
    activeId = null;
    knob.style.transform = '';
    pad.classList.remove('active');
    clearKeys();
  }
  pad.addEventListener('pointerup',     release);
  pad.addEventListener('pointercancel', release);
  pad.addEventListener('pointerleave',  release);
  pad.addEventListener('contextmenu',   e => e.preventDefault());
}
