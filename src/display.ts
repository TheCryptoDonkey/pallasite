/**
 * Display mode — chooses between the retro 1979 cabinet feel (capped 960×720
 * pixelated upscale) and a smooth high-resolution rendering for modern monitors.
 *
 *   'retro'  — capped at 960×720 display size, image-rendering: pixelated.
 *              Hard pixel boundaries on the upscale, faithful to the arcade.
 *   'modern' — uncapped (canvas fills the viewport's 4:3 inscribed area),
 *              backing store supersampled 1.5×, smooth interpolation.
 *              Wave backgrounds (1280×960 source) render with less downscale loss.
 *
 * The world coordinate system stays 960×720 in both modes — gameplay constants
 * and entity positions don't change. Only the canvas backing store and the
 * CSS display size differ.
 */

export type DisplayMode = 'retro' | 'modern';

const KEY = 'pallasite:displayMode';

export function getDisplayMode(): DisplayMode {
  // Fullscreen forces modern — the user explicitly asked for "full
  // screen" so they expect the canvas to fill the viewport. Retro mode
  // caps the canvas at 960×720 and exposes the body's wave-background
  // around it, which reads as a coloured letterbox / "red square" in
  // the empty space. Modern overrides that.
  if (typeof document !== 'undefined' && document.fullscreenElement) {
    return 'modern';
  }
  // 600bn Sanctum always uses modern (full-viewport, no 4:3 letterbox)
  // regardless of device or saved pref — the conference deploy is
  // designed around the modern aspect, photoreal textures, etc.
  if (typeof window !== 'undefined'
      && window.location.hostname.toLowerCase().startsWith('600b.')) {
    return 'modern';
  }
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'modern' || v === 'retro') return v;
  } catch { /* ignore */ }
  // Mobile-first default: 'modern' fills the viewport edge-to-edge, which
  // reads better on a phone than the centred 4:3 letterbox 'retro' produces.
  // Desktops keep the arcade-cabinet feel by default.
  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
    return 'modern';
  }
  return 'retro';
}

export function setDisplayMode(m: DisplayMode): void {
  try { localStorage.setItem(KEY, m); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.body.dataset.display = m;
}
