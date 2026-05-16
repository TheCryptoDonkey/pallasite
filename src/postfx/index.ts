/**
 * Post-process presentation themes: a finished game canvas in, a styled
 * canvas out.
 *
 * Deliberately game-agnostic. This module imports nothing from the game,
 * and every effect is a pure 2D-canvas pass, so the whole thing can later
 * lift out into a shared package other games drop in.
 */

export type ThemeId = 'none' | 'crt' | 'synthwave' | 'thermal' | 'gameboy';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
}

/** Selectable themes, in settings-panel order. 'none' is the untouched look. */
export const THEMES: readonly ThemeInfo[] = [
  { id: 'none', label: 'STANDARD' },
  { id: 'crt', label: 'CRT' },
  { id: 'synthwave', label: 'SYNTHWAVE' },
  { id: 'thermal', label: 'THERMAL' },
  { id: 'gameboy', label: 'GAME BOY' },
];

/** Coerce an unknown value (e.g. a stale localStorage entry) into a ThemeId.
 *  Any id present in THEMES is accepted; everything else falls back to 'none'. */
export function coerceThemeId(v: unknown): ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v) ? (v as ThemeId) : 'none';
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
  else if (theme === 'synthwave') applySynthwave(ctx, canvas, nowMs);
  else if (theme === 'thermal') applyThermal(ctx, canvas);
  else if (theme === 'gameboy') applyGameBoy(ctx, canvas);
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

/**
 * Synthwave look: a punchy neon bloom, a magenta-to-hot-horizon colour
 * grade, a sun glow rising from below the bottom edge, and a deep vignette.
 */
function applySynthwave(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, nowMs: number): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const k = w / 960;
  const pulse = 0.5 + 0.12 * Math.sin(nowMs * 0.0016);

  const sc = getScratch(w, h);
  const scx = sc.getContext('2d');
  if (!scx) return;
  scx.setTransform(1, 0, 0, 1, 0, 0);
  scx.clearRect(0, 0, w, h);
  scx.drawImage(canvas, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Punchy neon bloom.
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${(3 * k).toFixed(2)}px)`;
  ctx.globalAlpha = 0.6;
  ctx.drawImage(sc, 0, 0);
  ctx.filter = `blur(${(9 * k).toFixed(2)}px)`;
  ctx.globalAlpha = 0.5;
  ctx.drawImage(sc, 0, 0);
  ctx.filter = 'none';

  // Sunset sky: screen-blend an indigo-to-hot-horizon gradient so the
  // black void lifts into a graded synthwave sky while bright strokes
  // stay bright.
  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = 0.5;
  const grade = ctx.createLinearGradient(0, 0, 0, h);
  grade.addColorStop(0, '#3a1a6e');
  grade.addColorStop(0.55, '#ff2db4');
  grade.addColorStop(1, '#ff7a3c');
  ctx.fillStyle = grade;
  ctx.fillRect(0, 0, w, h);

  // Sun glow rising from below the bottom edge.
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = pulse;
  const sun = ctx.createRadialGradient(w / 2, h * 1.06, h * 0.08, w / 2, h * 1.06, h * 0.72);
  sun.addColorStop(0, 'rgba(255,150,80,0.85)');
  sun.addColorStop(0.5, 'rgba(255,60,160,0.32)');
  sun.addColorStop(1, 'rgba(255,60,160,0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, w, h);

  // Deep vignette.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.4, w / 2, h / 2, h * 0.85);
  vig.addColorStop(0, 'rgba(10,0,30,0)');
  vig.addColorStop(1, 'rgba(10,0,30,0.3)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

// ── Pixel-LUT modes ──────────────────────────────────────────────────
// Thermal and Game Boy work the same way: downscale the frame to a
// coarse buffer, remap every pixel's luminance through a colour LUT,
// then scale it back up. The low-res step is the look itself (a thermal
// camera and a DMG screen are both coarse) and keeps the per-frame
// pixel loop small enough to run every frame.

let pixelBuf: HTMLCanvasElement | null = null;
function getPixelBuf(w: number, h: number): HTMLCanvasElement {
  if (!pixelBuf) pixelBuf = document.createElement('canvas');
  if (pixelBuf.width !== w) pixelBuf.width = w;
  if (pixelBuf.height !== h) pixelBuf.height = h;
  return pixelBuf;
}

/** Build a 256-entry RGB lookup table by interpolating colour stops,
 *  each `[position 0..1, r, g, b]`. */
function buildRampLut(stops: ReadonlyArray<readonly number[]>): Uint8Array {
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let s = 0;
    while (s < stops.length - 2 && t > stops[s + 1][0]) s++;
    const a = stops[s];
    const b = stops[s + 1];
    const f = Math.max(0, Math.min(1, (t - a[0]) / ((b[0] - a[0]) || 1)));
    lut[i * 3] = Math.round(a[1] + (b[1] - a[1]) * f);
    lut[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * f);
    lut[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * f);
  }
  return lut;
}

// Ironbow-ish thermal ramp: cold indigo, through hot magenta and orange,
// to white-hot.
const HEAT_LUT = buildRampLut([
  [0.0, 16, 14, 52],
  [0.25, 72, 26, 130],
  [0.45, 190, 28, 92],
  [0.65, 255, 104, 28],
  [0.84, 255, 214, 70],
  [1.0, 255, 255, 238],
]);

// Game Boy DMG: four flat green shades, hard-quantised, no blend.
const GB_LUT = ((): Uint8Array => {
  const shades = [[15, 56, 15], [48, 98, 48], [139, 172, 15], [155, 188, 15]];
  const lut = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const s = shades[Math.min(3, i >> 6)];
    lut[i * 3] = s[0];
    lut[i * 3 + 1] = s[1];
    lut[i * 3 + 2] = s[2];
  }
  return lut;
})();

/** Downscale, luminance-remap through `lut`, upscale. `smooth` off gives
 *  hard chunky pixels (Game Boy); on gives a soft blur (thermal camera). */
function lutPass(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, lowW: number, smooth: boolean, lut: Uint8Array): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const lowH = Math.max(1, Math.round(lowW * h / w));
  const buf = getPixelBuf(lowW, lowH);
  const bctx = buf.getContext('2d', { willReadFrequently: true });
  if (!bctx) return;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.imageSmoothingEnabled = true;
  bctx.clearRect(0, 0, lowW, lowH);
  bctx.drawImage(canvas, 0, 0, w, h, 0, 0, lowW, lowH);
  const img = bctx.getImageData(0, 0, lowW, lowH);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    const li = ((lum | 0) & 255) * 3;
    d[i] = lut[li];
    d[i + 1] = lut[li + 1];
    d[i + 2] = lut[li + 2];
  }
  bctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = smooth;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(buf, 0, 0, lowW, lowH, 0, 0, w, h);
  ctx.restore();
}

/** Thermal camera: a coarse, soft luminance heat-map. */
function applyThermal(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  lutPass(ctx, canvas, 600, true, HEAT_LUT);
}

/** Game Boy DMG: 160-wide chunky pixels, four-shade green. */
function applyGameBoy(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  lutPass(ctx, canvas, 320, false, GB_LUT);
}
