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
  try {
    return localStorage.getItem(KEY) === 'modern' ? 'modern' : 'retro';
  } catch {
    return 'retro';
  }
}

export function setDisplayMode(m: DisplayMode): void {
  try { localStorage.setItem(KEY, m); } catch { /* ignore */ }
  if (typeof document !== 'undefined') document.body.dataset.display = m;
}
