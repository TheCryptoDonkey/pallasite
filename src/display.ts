/**
 * Display mode — chooses between the retro 1979 cabinet feel (pixelated
 * upscale, capped at the native world size) and a smooth high-resolution
 * rendering for modern monitors.
 *
 *   'retro'  — canvas capped at the native 1280×720 source, image-rendering:
 *              pixelated. Hard pixel boundaries on the upscale, faithful to
 *              the arcade.
 *   'modern' — canvas fills the viewport; the fixed 16:9 world is contain-
 *              scaled into it — edge-to-edge on a 16:9 screen, letterboxed
 *              off it — with smooth interpolation.
 *
 * The world is a fixed 16:9 shape (WORLD_W×WORLD_H) in both modes — gameplay
 * constants and entity positions don't change. Only the canvas backing store
 * and the CSS display size differ.
 */

import { getFlavour } from './flavour.js';

export type DisplayMode = 'retro' | 'modern';

const KEY = 'pallasite:displayMode';

export function getDisplayMode(): DisplayMode {
  // Fullscreen forces modern — the user explicitly asked for "full
  // screen" so they expect the canvas to fill the viewport. Retro mode
  // caps the canvas at 1280×720 and exposes the body's wave-background
  // around it, which reads as a coloured letterbox / "red square" in
  // the empty space. Modern overrides that. Check both the standard
  // and webkit-prefixed APIs because Safari only exposes the prefixed
  // one (`webkitFullscreenElement` / `webkitfullscreenchange`).
  if (typeof document !== 'undefined') {
    const d = document as Document & { webkitFullscreenElement?: Element };
    if (d.fullscreenElement || d.webkitFullscreenElement) return 'modern';
  }
  // 600bn Sanctum always uses modern (full-viewport, no retro letterbox)
  // regardless of device or saved pref — the conference deploy is
  // designed around the modern aspect, photoreal textures, etc.
  // Uses getFlavour() so all three 600bn subdomains (600b. / 600bn. /
  // 600.) are covered; the previous local hostname check only matched
  // 600b. and left 600bn.pallasite.app stuck in retro.
  if (getFlavour() === '600bn') {
    return 'modern';
  }
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'modern' || v === 'retro') return v;
  } catch { /* ignore */ }
  // Mobile-first default: 'modern' fills the viewport edge-to-edge, which
  // reads better on a phone than the centred letterbox 'retro' produces.
  // Desktops keep the arcade-cabinet feel by default.
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
    return 'modern';
  }
  return 'retro';
}

/** Save the user's explicit preference AND apply it. Persists to
 *  localStorage so subsequent sessions honour the choice. Called from
 *  the settings UI toggle. */
export function setDisplayMode(m: DisplayMode): void {
  try { localStorage.setItem(KEY, m); } catch { /* ignore */ }
  applyDisplayMode(m);
}

/** Mirror a computed mode to the body data-attribute without touching
 *  the saved preference. Used by boot + the fullscreenchange listener
 *  so a transient fullscreen entry doesn't permanently overwrite the
 *  user's "I prefer retro" choice. */
export function applyDisplayMode(m: DisplayMode): void {
  if (typeof document !== 'undefined') document.body.dataset.display = m;
}
