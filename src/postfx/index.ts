/**
 * Post-process presentation themes: a finished game canvas in, a styled
 * canvas out.
 *
 * Deliberately game-agnostic. This module imports nothing from the game,
 * and every effect is a pure 2D-canvas pass, so the whole thing can later
 * lift out into a shared package other games drop in.
 */

export type ThemeId = 'none' | 'crt';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
}

/** Selectable themes, in settings-panel order. 'none' is the untouched look. */
export const THEMES: readonly ThemeInfo[] = [
  { id: 'none', label: 'STANDARD' },
  { id: 'crt', label: 'CRT' },
];

/** Coerce an unknown value (e.g. a stale localStorage entry) into a ThemeId. */
export function coerceThemeId(v: unknown): ThemeId {
  return v === 'crt' ? 'crt' : 'none';
}

// Scratch canvas holding a clean snapshot of the frame, so a multi-pass
// effect samples the original rather than a half-processed result.
let scratch: HTMLCanvasElement | null = null;
function getScratch(w: number, h: number): HTMLCanvasElement {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  return scratch;
}

/** Apply the active theme's post-process pass to a finished frame, in place. */
export function applyPostFx(canvas: HTMLCanvasElement, theme: ThemeId, nowMs: number): void {
  if (theme === 'none') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (theme === 'crt') applyCrt(ctx, canvas, nowMs);
}

/**
 * CRT vector / phosphor look: additive bloom so bright strokes bleed light
 * the way a real vector monitor's phosphor did, a barely-there brightness
 * flicker, and a soft tube vignette. No scanlines, since those belong to a
 * raster CRT rather than a vector one.
 */
function applyCrt(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, nowMs: number): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  // Blur radius scales with resolution so the bloom reads the same at any dpr.
  const k = w / 960;
  const flicker = 0.985 + 0.015 * Math.sin(nowMs * 0.05);

  // Snapshot the clean frame so both blurred passes sample the original.
  const sc = getScratch(w, h);
  const scx = sc.getContext('2d');
  if (!scx) return;
  scx.setTransform(1, 0, 0, 1, 0, 0);
  scx.clearRect(0, 0, w, h);
  scx.drawImage(canvas, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Additive bloom: a tight inner glow plus a wide halo.
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${(2.2 * k).toFixed(2)}px)`;
  ctx.globalAlpha = 0.55 * flicker;
  ctx.drawImage(sc, 0, 0);
  ctx.filter = `blur(${(6.5 * k).toFixed(2)}px)`;
  ctx.globalAlpha = 0.4 * flicker;
  ctx.drawImage(sc, 0, 0);

  // Soft vignette darkening the tube edges.
  ctx.filter = 'none';
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const grad = ctx.createRadialGradient(w / 2, h / 2, h * 0.36, w / 2, h / 2, h * 0.78);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}
