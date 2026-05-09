/**
 * Touch controls — translucent on-screen buttons that translate touches into
 * the same `state.keys` codes the keyboard handlers set. The game loop reads
 * those keys uniformly, so combat logic doesn't need to know whether input
 * came from a finger or a key.
 *
 * Layout (matches the original 1979 arcade cabinet's discrete-button design):
 *   Bottom-left cluster — ◀ rotate-left, ▶ rotate-right, ▲ thrust
 *   Bottom-right cluster — FIRE (wide), ⚡ hyperspace, ⛨ shield
 *
 * The cluster only appears when a real touch is detected (we don't want to
 * show it on a hybrid laptop just because pointer events exist).
 */

import type { GameState } from './types.js';
import * as audio from './audio.js';

interface ButtonSpec {
  /** Class name for layout placement + colour */
  cls: string;
  /** Label shown inside the button */
  label: string;
  /** Key code(s) this button presses */
  keys: string[];
  /** Optional one-shot action triggered on press (instead of a held key) */
  oneShot?: (state: GameState, now: number) => void;
}

const ROOT_ID = 'touch-controls';

/** Wire touch controls. Call once at boot — buttons reveal themselves on
 *  the first real touch event. */
export function setupTouchControls(
  state: GameState,
  hyperspace: (s: GameState, now: number) => void,
  activateShield: (s: GameState, now: number) => void,
): void {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  // Reveal touch UI only when a touch genuinely happens. Hybrid devices
  // (touchscreen laptops) keep the keyboard hint until they actually tap.
  const reveal = (): void => {
    document.body.classList.add('touch-active');
    window.removeEventListener('touchstart', reveal);
  };
  window.addEventListener('touchstart', reveal, { passive: true, once: true });

  const left = document.createElement('div');
  left.className = 'touch-cluster left';
  const right = document.createElement('div');
  right.className = 'touch-cluster right';
  root.appendChild(left);
  root.appendChild(right);

  const buttons: Array<{ parent: HTMLElement; spec: ButtonSpec }> = [
    { parent: left,  spec: { cls: 'thrust',  label: '▲',     keys: ['ArrowUp'] } },
    { parent: left,  spec: { cls: 'rotL',    label: '◀',     keys: ['ArrowLeft'] } },
    { parent: left,  spec: { cls: 'rotR',    label: '▶',     keys: ['ArrowRight'] } },
    { parent: right, spec: { cls: 'fire',    label: 'FIRE',  keys: ['Space'] } },
    { parent: right, spec: { cls: 'hyper',   label: '⚡',     keys: [], oneShot: hyperspace } },
    { parent: right, spec: { cls: 'shield',  label: '⛨',     keys: [], oneShot: activateShield } },
  ];

  for (const { parent, spec } of buttons) {
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

    // Use pointer events so iOS Safari, Android, and stylus all behave
    btn.addEventListener('pointerdown', e => { e.preventDefault(); press(); });
    btn.addEventListener('pointerup',     e => { e.preventDefault(); release(); });
    btn.addEventListener('pointercancel', e => { e.preventDefault(); release(); });
    btn.addEventListener('pointerleave',  () => release());
    // Belt and braces: prevent the browser's contextmenu + selection on long-press
    btn.addEventListener('contextmenu', e => e.preventDefault());
  }
}
