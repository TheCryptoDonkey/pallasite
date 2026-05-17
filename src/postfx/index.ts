/**
 * Post-process presentation themes: a finished game canvas in, a styled
 * canvas out.
 *
 * Deliberately game-agnostic. This module imports nothing from the game,
 * and every effect is a pure 2D-canvas pass, so the whole thing can later
 * lift out into a shared package other games drop in.
 */

export type ThemeId =
  | 'none' | 'crt' | 'synthwave' | 'thermal' | 'gameboy' | 'gameboycolor'
  | 'hologram' | 'blueprint' | 'ascii' | 'handdrawn'
  | 'vhs' | 'nightvision' | 'comic' | 'onebit';

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
  { id: 'gameboycolor', label: 'GB COLOR' },
  { id: 'hologram', label: 'HOLOGRAM' },
  { id: 'blueprint', label: 'BLUEPRINT' },
  { id: 'ascii', label: 'ASCII' },
  { id: 'handdrawn', label: 'HAND DRAWN' },
  { id: 'vhs', label: 'VHS' },
  { id: 'nightvision', label: 'NIGHT VISION' },
  { id: 'comic', label: 'COMIC' },
  { id: 'onebit', label: '1-BIT' },
];

/** Coerce an unknown value (e.g. a stale localStorage entry) into a ThemeId.
 *  Any id present in THEMES is accepted; everything else falls back to 'none'. */
export function coerceThemeId(v: unknown): ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v) ? (v as ThemeId) : 'none';
}

/** ASCII presentation resolution: the character-grid column count. Exposed
 *  so the game can offer it as a slider — finer grids cost frame budget. */
export const ASCII_COLS = { min: 80, max: 320, step: 20, default: 160 } as const;

/** Per-call tuning passed to applyPostFx. All fields optional; an omitted
 *  field falls back to the effect's built-in default. */
export interface PostFxOptions {
  /** ASCII character-grid column count (see ASCII_COLS). */
  asciiCols?: number;
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
export function applyPostFx(canvas: HTMLCanvasElement, theme: ThemeId, nowMs: number, opts?: PostFxOptions): void {
  if (theme === 'none') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (theme === 'crt') applyCrt(ctx, canvas, nowMs);
  else if (theme === 'synthwave') applySynthwave(ctx, canvas, nowMs);
  else if (theme === 'thermal') applyThermal(ctx, canvas);
  else if (theme === 'gameboy') applyGameBoy(ctx, canvas);
  else if (theme === 'gameboycolor') applyGameBoyColor(ctx, canvas);
  else if (theme === 'hologram') applyHologram(ctx, canvas, nowMs);
  else if (theme === 'blueprint') applyBlueprint(ctx, canvas);
  else if (theme === 'ascii') applyAscii(ctx, canvas, opts?.asciiCols ?? ASCII_COLS.default);
  else if (theme === 'handdrawn') applyHandDrawn(ctx, canvas, nowMs);
  else if (theme === 'vhs') applyVhs(ctx, canvas, nowMs);
  else if (theme === 'nightvision') applyNightvision(ctx, canvas, nowMs);
  else if (theme === 'comic') applyComic(ctx, canvas);
  else if (theme === 'onebit') applyOnebit(ctx, canvas);
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
  const k = w / 1280;
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
  const k = w / 1280;
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
  const shades = [[14, 50, 24], [36, 94, 50], [78, 166, 86], [130, 216, 128]];
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
  lutPass(ctx, canvas, 760, true, HEAT_LUT);
}

/** Game Boy DMG: 160-wide chunky pixels, four-shade green. */
function applyGameBoy(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  lutPass(ctx, canvas, 480, false, GB_LUT);
}

/** Game Boy Color: keeps the real hues but coarsens the palette and uses
 *  the same chunky low-res pixels as the DMG mode, with a slight LCD wash
 *  (lifted black floor) so it reads as backlit handheld glass. */
function applyGameBoyColor(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const lowW = 480;
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
  // Per-channel quantise to a coarse palette, keeping hue, then lift the
  // black floor a touch for the LCD wash.
  const steps = 6;
  const q = 255 / (steps - 1);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 18 + Math.round(d[i] / q) * q * 0.93;
    d[i + 1] = 20 + Math.round(d[i + 1] / q) * q * 0.93;
    d[i + 2] = 26 + Math.round(d[i + 2] / q) * q * 0.93;
  }
  bctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(buf, 0, 0, lowW, lowH, 0, 0, w, h);
  ctx.restore();
}

/**
 * Hologram: cyan monochrome with additive bloom, fine scanlines, a slow
 * scan-sweep band and a faint flicker, for a ship's tactical-display look.
 */
function applyHologram(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, nowMs: number): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const k = w / 1280;
  const sc = getScratch(w, h);
  const scx = sc.getContext('2d');
  if (!scx) return;
  scx.setTransform(1, 0, 0, 1, 0, 0);
  scx.clearRect(0, 0, w, h);
  scx.drawImage(canvas, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Additive bloom.
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${(2.5 * k).toFixed(2)}px)`;
  ctx.globalAlpha = 0.5;
  ctx.drawImage(sc, 0, 0);
  ctx.filter = 'none';

  // Recolour to cyan, luminance preserved.
  ctx.globalCompositeOperation = 'color';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#3ad6ff';
  ctx.fillRect(0, 0, w, h);

  // Scanlines.
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(0,20,30,0.35)';
  const step = Math.max(2, Math.round(3 * k));
  for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, 1);

  // Scan-sweep: a soft bright band travelling down.
  const sweepY = (nowMs * 0.1) % (h + 200) - 100;
  ctx.globalCompositeOperation = 'lighter';
  const sweep = ctx.createLinearGradient(0, sweepY - 80 * k, 0, sweepY + 80 * k);
  sweep.addColorStop(0, 'rgba(60,220,255,0)');
  sweep.addColorStop(0.5, 'rgba(120,240,255,0.22)');
  sweep.addColorStop(1, 'rgba(60,220,255,0)');
  ctx.fillStyle = sweep;
  ctx.fillRect(0, sweepY - 80 * k, w, 160 * k);

  // Flicker plus vignette.
  ctx.globalCompositeOperation = 'source-over';
  const flick = 0.04 + 0.04 * Math.sin(nowMs * 0.08);
  ctx.fillStyle = `rgba(0,40,60,${flick.toFixed(3)})`;
  ctx.fillRect(0, 0, w, h);
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.42, w / 2, h / 2, h * 0.82);
  vig.addColorStop(0, 'rgba(0,8,16,0)');
  vig.addColorStop(1, 'rgba(0,8,16,0.6)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

/**
 * Blueprint: a drafting-table look. Recolour the frame to monochrome
 * blue, lift the dark field to blueprint paper-blue, lay a faint grid.
 */
function applyBlueprint(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const k = w / 1280;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Monochrome blue, luminance preserved.
  ctx.globalCompositeOperation = 'color';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#5a9be8';
  ctx.fillRect(0, 0, w, h);

  // Lift the dark field to blueprint paper-blue.
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = '#133f86';
  ctx.fillRect(0, 0, w, h);

  // Drafting grid.
  ctx.globalCompositeOperation = 'source-over';
  ctx.strokeStyle = 'rgba(200,225,255,0.16)';
  ctx.lineWidth = Math.max(1, k);
  const cell = Math.round(48 * k);
  ctx.beginPath();
  for (let x = cell; x < w; x += cell) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = cell; y < h; y += cell) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();

  // Vignette.
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.45, w / 2, h / 2, h * 0.85);
  vig.addColorStop(0, 'rgba(6,20,50,0)');
  vig.addColorStop(1, 'rgba(6,20,50,0.45)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

// ── ASCII ────────────────────────────────────────────────────────────
const ASCII_RAMP = ' .:-=+*#%@';
const ASCII_CELL = 24;
let asciiAtlas: HTMLCanvasElement | null = null;

/** Lazily render the brightness ramp into a glyph atlas, one cell per
 *  character, so the per-frame pass only does drawImage, not fillText. */
function getAsciiAtlas(): HTMLCanvasElement {
  if (asciiAtlas) return asciiAtlas;
  const c = document.createElement('canvas');
  c.width = ASCII_CELL * ASCII_RAMP.length;
  c.height = ASCII_CELL;
  const cx = c.getContext('2d');
  if (cx) {
    cx.font = `bold ${Math.round(ASCII_CELL * 0.95)}px ui-monospace, monospace`;
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillStyle = '#ffffff';
    for (let i = 0; i < ASCII_RAMP.length; i++) {
      cx.fillText(ASCII_RAMP[i], i * ASCII_CELL + ASCII_CELL / 2, ASCII_CELL / 2 + 1);
    }
  }
  asciiAtlas = c;
  return asciiAtlas;
}

/** ASCII: sample the frame into a high-resolution character grid, stamp
 *  ramp glyphs, and tint each glyph by its cell hue over a dimmed ghost
 *  of the real frame. */
function applyAscii(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, requestedCols: number): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const cols = Math.max(ASCII_COLS.min, Math.min(ASCII_COLS.max, Math.round(requestedCols)));
  const rows = Math.max(1, Math.round(cols * (h / w) / 1.6));
  const buf = getPixelBuf(cols, rows);
  const bctx = buf.getContext('2d', { willReadFrequently: true });
  if (!bctx) return;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.imageSmoothingEnabled = true;
  bctx.clearRect(0, 0, cols, rows);
  bctx.drawImage(canvas, 0, 0, w, h, 0, 0, cols, rows);
  const img = bctx.getImageData(0, 0, cols, rows);
  const d = img.data;
  const atlas = getAsciiAtlas();
  const last = ASCII_RAMP.length - 1;
  const cw = w / cols;
  const ch = h / rows;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  // Dim the real frame rather than erasing it: the characters carry the
  // look, but a faint ghost of the actual game underneath keeps the ship
  // and bullets trackable enough to play.
  ctx.fillStyle = 'rgba(2,8,5,0.8)';
  ctx.fillRect(0, 0, w, h);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = (r * cols + c) * 4;
      const lum = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      const idx = Math.round(Math.min(1, lum / 255 * 1.8) * last);
      if (idx <= 0) continue;
      ctx.drawImage(atlas, idx * ASCII_CELL, 0, ASCII_CELL, ASCII_CELL, c * cw, r * ch, cw, ch);
      // Push the cell colour to full brightness so the glyph tint reads
      // as a vivid hue, not the dim space-averaged colour.
      const m = Math.max(d[i], d[i + 1], d[i + 2], 1);
      const boost = 255 / m;
      d[i] *= boost;
      d[i + 1] *= boost;
      d[i + 2] *= boost;
    }
  }
  // Tint each glyph by its cell colour: multiply the brightness-normalised
  // cell grid over the white characters so the ASCII carries the real hues.
  bctx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = 'multiply';
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buf, 0, 0, cols, rows, 0, 0, w, h);
  ctx.restore();
}

let paperTex: HTMLCanvasElement | null = null;
/** Lazily build a small tiling paper-grain texture: mostly bright with a
 *  sparse scatter of darker flecks, so multiplying it onto the cream base
 *  reads as fibrous stock rather than a flat fill. */
function getPaperTexture(): HTMLCanvasElement {
  if (paperTex) return paperTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const cx = c.getContext('2d');
  if (cx) {
    const img = cx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      // Bright pixels are a near no-op under multiply; the sparse darker
      // flecks are what the eye reads as paper fibre.
      const v = Math.random() > 0.9
        ? 198 + Math.floor(Math.random() * 34)
        : 246 + Math.floor(Math.random() * 9);
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
  }
  paperTex = c;
  return paperTex;
}

/** Hand-drawn: a graphite-and-ink sketch on grained cream paper. Inverts
 *  the frame so bright strokes become ink, warms it towards sepia, then
 *  multiplies it onto textured paper in wavy strips — twice and slightly
 *  offset, so the linework reads as sketched rather than printed. */
function applyHandDrawn(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, nowMs: number): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const k = w / 1280;
  const sc = getScratch(w, h);
  const scx = sc.getContext('2d');
  if (!scx) return;
  scx.setTransform(1, 0, 0, 1, 0, 0);
  scx.clearRect(0, 0, w, h);
  scx.drawImage(canvas, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Warm cream paper.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#e8debb';
  ctx.fillRect(0, 0, w, h);

  // Paper grain — a tiled speckle multiplied down so the page reads as
  // fibrous stock rather than a flat fill.
  const grain = ctx.createPattern(getPaperTexture(), 'repeat');
  if (grain) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.7;
    ctx.fillStyle = grain;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
  }

  // Ink: invert the frame so bright strokes go dark, warm it towards
  // sepia and punch the contrast so the lines read as confident ink.
  // Drawn in wavy strips so straight lines pick up a wobble; a second
  // fainter offset pass gives the linework a sketched double-stroke.
  ctx.globalCompositeOperation = 'multiply';
  ctx.filter = 'invert(1) sepia(0.55) contrast(2.25)';
  const strips = 48;
  const stripH = h / strips;
  const amp = 3.4 * k;
  const wob = (s: number, phase: number): number =>
    Math.sin(s * 0.5 + nowMs * 0.0011 + phase) * amp
    + Math.sin(s * 1.7 + nowMs * 0.0007 + phase) * amp * 0.5;
  for (let s = 0; s < strips; s++) {
    const sy = s * stripH;
    ctx.drawImage(sc, 0, sy, w, stripH + 1, wob(s, 0), sy, w, stripH + 1);
  }
  ctx.globalAlpha = 0.5;
  for (let s = 0; s < strips; s++) {
    const sy = s * stripH;
    ctx.drawImage(sc, 0, sy, w, stripH + 1, wob(s, 2.4) + 1.5 * k, sy + 0.9 * k, w, stripH + 1);
  }
  ctx.globalAlpha = 1;
  ctx.filter = 'none';

  // Soft page vignette — a gentle warm darkening towards the edges.
  ctx.globalCompositeOperation = 'multiply';
  const vig = ctx.createRadialGradient(w / 2, h / 2, h * 0.6, w / 2, h / 2, h * 1.05);
  vig.addColorStop(0, 'rgba(255,255,255,1)');
  vig.addColorStop(1, 'rgba(216,205,170,1)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  ctx.restore();
}

// ── VHS / camcorder ──────────────────────────────────────────────────

/**
 * VHS: an analogue-tape look. Runs on a downscaled buffer (tape is soft):
 * splits the colour channels sideways for chroma bleed, dusts in luma
 * noise, and tears a wandering tracking-error band across the picture.
 * Finished with soft scanlines and a camcorder PLAY tag.
 */
function applyVhs(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, nowMs: number): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const lowW = 640;
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
  const src = new Uint8ClampedArray(d); // clean copy to sample neighbours from
  const split = Math.max(1, Math.round(lowW / 320)); // chroma offset
  // Tracking-error band — a strip that tears sideways, wandering down-frame.
  const trackY = ((nowMs * 0.045) % (lowH + 80)) - 40;
  for (let y = 0; y < lowH; y++) {
    const row = y * lowW;
    const bandDist = Math.abs(y - trackY);
    let shift = Math.round(Math.sin(y * 0.08 + nowMs * 0.003) * 1.3); // base wobble
    if (bandDist < 16) {
      const f = 1 - bandDist / 16;
      shift += Math.round(f * f * 17 * Math.sin(nowMs * 0.021 + y * 0.4));
    }
    const scan = (y & 1) === 0 ? 1 : 0.87; // soft scanline
    for (let x = 0; x < lowW; x++) {
      const o = (row + x) * 4;
      const xr = Math.min(lowW - 1, Math.max(0, x + shift + split));
      const xg = Math.min(lowW - 1, Math.max(0, x + shift));
      const xb = Math.min(lowW - 1, Math.max(0, x + shift - split));
      const n = (Math.random() - 0.5) * 44; // tape luma noise
      d[o] = (src[(row + xr) * 4] + n) * scan;
      d[o + 1] = (src[(row + xg) * 4 + 1] + n) * scan;
      d[o + 2] = (src[(row + xb) * 4 + 2] + n) * scan;
    }
  }
  bctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf, 0, 0, lowW, lowH, 0, 0, w, h);
  // Camcorder on-screen tag.
  const k = w / 1280;
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.shadowColor = 'rgba(0,0,0,0.65)';
  ctx.shadowBlur = 4 * k;
  ctx.font = `bold ${Math.round(30 * k)}px ui-monospace, monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('▶ PLAY', 30 * k, 26 * k);
  ctx.shadowBlur = 0;
  ctx.restore();
}

// ── Night vision ─────────────────────────────────────────────────────

let noiseTex: HTMLCanvasElement | null = null;
/** Small tiling monochrome-noise tile, drawn at a random offset each
 *  frame for cheap animated sensor grain. */
function getNoiseTexture(): HTMLCanvasElement {
  if (noiseTex) return noiseTex;
  const size = 168;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const cx = c.getContext('2d');
  if (cx) {
    const img = cx.createImageData(size, size);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = Math.floor(Math.random() * 256);
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
      d[i + 3] = 255;
    }
    cx.putImageData(img, 0, 0);
  }
  noiseTex = c;
  return noiseTex;
}

/**
 * Night vision: a light-amplified sensor look. Blow the highlights out
 * with additive bloom, lift the black floor, recolour to phosphor green,
 * lay scanlines and animated grain, then mask to a circular goggle
 * aperture with a faint reticle.
 */
function applyNightvision(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, nowMs: number): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const k = w / 1280;
  const sc = getScratch(w, h);
  const scx = sc.getContext('2d');
  if (!scx) return;
  scx.setTransform(1, 0, 0, 1, 0, 0);
  scx.clearRect(0, 0, w, h);
  scx.drawImage(canvas, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Heavy additive bloom — the amplifier blows highlights out.
  ctx.globalCompositeOperation = 'lighter';
  ctx.filter = `blur(${(2 * k).toFixed(2)}px)`;
  ctx.globalAlpha = 0.7;
  ctx.drawImage(sc, 0, 0);
  ctx.filter = `blur(${(7 * k).toFixed(2)}px)`;
  ctx.globalAlpha = 0.55;
  ctx.drawImage(sc, 0, 0);
  ctx.filter = 'none';

  // Lift the black floor (still additive) — an amplified sensor never
  // sits at true black.
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#0c220c';
  ctx.fillRect(0, 0, w, h);

  // Recolour to phosphor green, luminance preserved.
  ctx.globalCompositeOperation = 'color';
  ctx.fillStyle = '#3bff6e';
  ctx.fillRect(0, 0, w, h);

  // Animated sensor grain — a cached noise tile at a random offset.
  ctx.globalCompositeOperation = 'overlay';
  ctx.globalAlpha = 0.22;
  const noise = getNoiseTexture();
  const pat = ctx.createPattern(noise, 'repeat');
  if (pat) {
    const ox = Math.floor(Math.random() * noise.width);
    const oy = Math.floor(Math.random() * noise.height);
    ctx.save();
    ctx.translate(-ox, -oy);
    ctx.fillStyle = pat;
    ctx.fillRect(ox, oy, w, h);
    ctx.restore();
  }

  // Scanlines.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,14,0,0.3)';
  const step = Math.max(2, Math.round(3 * k));
  for (let y = 0; y < h; y += step) ctx.fillRect(0, y, w, 1);

  // Circular goggle aperture.
  const cx = w / 2;
  const cy = h / 2;
  const rad = Math.hypot(w, h) * 0.44;
  const mask = ctx.createRadialGradient(cx, cy, rad * 0.6, cx, cy, rad);
  mask.addColorStop(0, 'rgba(0,5,0,0)');
  mask.addColorStop(0.85, 'rgba(0,5,0,0.9)');
  mask.addColorStop(1, 'rgba(0,3,0,1)');
  ctx.fillStyle = mask;
  ctx.fillRect(0, 0, w, h);

  // Faint pulsing reticle.
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = `rgba(130,255,160,${(0.17 + 0.05 * Math.sin(nowMs * 0.004)).toFixed(3)})`;
  ctx.lineWidth = Math.max(1, k);
  const ret = h * 0.07;
  ctx.beginPath();
  ctx.moveTo(cx - ret, cy);
  ctx.lineTo(cx + ret, cy);
  ctx.moveTo(cx, cy - ret);
  ctx.lineTo(cx, cy + ret);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, ret * 0.62, 0, Math.PI * 2);
  ctx.stroke();

  ctx.restore();
}

// ── Comic / halftone ─────────────────────────────────────────────────

let halftoneTex: HTMLCanvasElement | null = null;
/** A single tiling dot cell — multiplied over the comic page as a
 *  newsprint screen so the flat colours read as printed, not digital. */
function getHalftoneTexture(): HTMLCanvasElement {
  if (halftoneTex) return halftoneTex;
  const cell = 6;
  const c = document.createElement('canvas');
  c.width = cell;
  c.height = cell;
  const cx = c.getContext('2d');
  if (cx) {
    cx.fillStyle = '#ffffff';
    cx.fillRect(0, 0, cell, cell);
    cx.fillStyle = '#000000';
    cx.beginPath();
    cx.arc(cell / 2, cell / 2, cell * 0.34, 0, Math.PI * 2);
    cx.fill();
  }
  halftoneTex = c;
  return halftoneTex;
}

/**
 * Comic book: a printed-page look. The dark void becomes cream paper and
 * the bright vector strokes become bold ink — luminance posterised into
 * flat cel bands — then a tiling halftone dot screen is multiplied over
 * the page and a heavy panel border framed around it.
 */
function applyComic(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const k = w / 1280;

  // Flat cel pass on a half-res buffer: posterise luminance into bands
  // and remap cream-paper -> dark-ink, so a bright stroke prints as ink.
  const lowW = Math.max(2, Math.round(w / 2));
  const lowH = Math.max(2, Math.round(h / 2));
  const buf = getPixelBuf(lowW, lowH);
  const bctx = buf.getContext('2d', { willReadFrequently: true });
  if (!bctx) return;
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.imageSmoothingEnabled = true;
  bctx.clearRect(0, 0, lowW, lowH);
  bctx.drawImage(canvas, 0, 0, w, h, 0, 0, lowW, lowH);
  const img = bctx.getImageData(0, 0, lowW, lowH);
  const d = img.data;
  const levels = 4;
  for (let i = 0; i < d.length; i += 4) {
    const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
    const ink = Math.round(Math.pow(lum, 0.85) * (levels - 1)) / (levels - 1);
    d[i] = 240 + (24 - 240) * ink;
    d[i + 1] = 232 + (22 - 232) * ink;
    d[i + 2] = 208 + (30 - 208) * ink;
  }
  bctx.putImageData(img, 0, 0);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buf, 0, 0, lowW, lowH, 0, 0, w, h);

  // Newsprint halftone screen — a tiling dot pattern multiplied over the
  // whole page so the flats read as printed.
  const tex = getHalftoneTexture();
  const pat = ctx.createPattern(tex, 'repeat');
  if (pat) {
    const scl = Math.max(1, 2 * k);
    ctx.save();
    ctx.scale(scl, scl);
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = pat;
    ctx.fillRect(0, 0, w / scl, h / scl);
    ctx.restore();
  }

  // Heavy comic-panel border.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#14121a';
  ctx.lineWidth = Math.max(3, 9 * k);
  ctx.strokeRect(0, 0, w, h);

  ctx.restore();
}

// ── 1-bit ────────────────────────────────────────────────────────────

// 4x4 ordered-dither (Bayer) thresholds, normalised to 0..1.
const BAYER4: readonly number[] = [
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
].map((v) => (v + 0.5) / 16);

/**
 * 1-bit: quantise the frame to two warm-tinted inks through a 4x4
 * ordered-dither screen, the way a monochrome handheld or e-reader
 * does. Runs on a coarse buffer, upscaled with no smoothing so the
 * dither pattern stays crisp.
 */
function applyOnebit(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement): void {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;
  const lowW = 540;
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
  for (let y = 0; y < lowH; y++) {
    for (let x = 0; x < lowW; x++) {
      const i = (y * lowW + x) * 4;
      const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
      // Gamma-crush so the dark void falls to solid black and only real
      // scene content carries the dither.
      const v = Math.pow(lum, 1.2);
      const lit = v > BAYER4[(y & 3) * 4 + (x & 3)];
      d[i] = lit ? 244 : 15;
      d[i + 1] = lit ? 240 : 14;
      d[i + 2] = lit ? 228 : 20;
    }
  }
  bctx.putImageData(img, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(buf, 0, 0, lowW, lowH, 0, 0, w, h);
  ctx.restore();
}
