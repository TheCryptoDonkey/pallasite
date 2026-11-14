// QR encoding for the game's own codes, from @forgesworn/qr. Encoder only:
// the camera scanner still decodes with jsQR.
import { drawCanvas, encode, toSvg } from '@forgesworn/qr';

type Ecc = 'L' | 'M' | 'Q' | 'H';

export interface QrCanvasOptions {
  /** Canvas width and height in CSS pixels, quiet zone included. */
  width: number;
  /** Quiet zone in modules. */
  margin: number;
  dark?: string;
  light?: string;
  /** Error correction level. Defaults to 'M', as the old encoder did. */
  ecc?: Ecc;
}

/** Draws `text` onto `canvas` and pins its CSS size to `width`, as the old
 *  encoder did. Throws if the text does not fit a QR code. */
export function renderQrCanvas(canvas: HTMLCanvasElement, text: string, opts: QrCanvasOptions): void {
  const qr = encode(text, { ecc: opts.ecc ?? 'M' });
  drawCanvas(canvas, qr, { width: opts.width, margin: opts.margin, dark: opts.dark ?? '#000000', light: opts.light ?? '#ffffff' });
  canvas.style.width = `${opts.width}px`;
  canvas.style.height = `${opts.width}px`;
}

/** An SVG string for `text`, one module per user unit. */
export function renderQrSvg(text: string, opts: { margin: number; dark?: string; light?: string; ecc?: Ecc }): string {
  const qr = encode(text, { ecc: opts.ecc ?? 'M' });
  return toSvg(qr, { margin: opts.margin, dark: opts.dark ?? '#000000', light: opts.light ?? '#ffffff' });
}
