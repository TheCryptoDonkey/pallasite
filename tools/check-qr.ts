/**
 * Round trip for the game's QR codes: render with src/qr.ts (the encoder,
 * @forgesworn/qr) onto a recording canvas, rasterise it, and read it back
 * with jsQR, the decoder the scanner uses.
 *
 * Run with `pnpm run test:qr`.
 */
import jsQR from 'jsqr';
import { renderQrCanvas, renderQrSvg } from '../src/qr';

interface Rect { x: number; y: number; w: number; h: number; fill: string }

function fakeCanvas(): { canvas: HTMLCanvasElement; rects: Rect[] } {
  const rects: Rect[] = [];
  const ctx = {
    fillStyle: '' as string,
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, fill: this.fillStyle }); },
  };
  const canvas = { width: 0, height: 0, style: {} as Record<string, string>, getContext: () => ctx };
  return { canvas: canvas as unknown as HTMLCanvasElement, rects };
}

/** Paints the recorded rectangles into RGBA pixels (light #fff5d8, dark #0a0418 as in the game). */
function rasterise(width: number, rects: Rect[]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * width * 4);
  const rgb = (hex: string): [number, number, number] => [
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
  ];
  for (const r of rects) {
    const [R, G, B] = rgb(r.fill);
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const i = (y * width + x) * 4;
        px[i] = R; px[i + 1] = G; px[i + 2] = B; px[i + 3] = 255;
      }
    }
  }
  return px;
}

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`);
  if (!ok) failed++;
};

const cases: Array<{ name: string; text: string; width: number; margin: number; dark: string; light: string }> = [
  { name: 'duel invite (220px, margin 1)', text: 'https://pallasite.app/?join=abc123def456&slot=1', width: 220, margin: 1, dark: '#000000', light: '#ffffff' },
  { name: 'sanctum card (140px, margin 0, game colours)', text: 'https://600.wtf', width: 140, margin: 0, dark: '#0a0418', light: '#fff5d8' },
  { name: 'upper-case lightning invoice-like payload', text: `LNBC1${'QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L'.repeat(5)}`, width: 330, margin: 2, dark: '#000000', light: '#ffffff' },
];

for (const c of cases) {
  const { canvas, rects } = fakeCanvas();
  renderQrCanvas(canvas, c.text, { width: c.width, margin: c.margin, dark: c.dark, light: c.light });
  const sized = canvas.width === c.width && canvas.height === c.width
    && (canvas.style as unknown as Record<string, string>).width === `${c.width}px`;
  check(`${c.name}: canvas sized`, sized);
  // jsQR wants a quiet zone it can see; pad margin-0 codes with light pixels the way the card's CSS padding does.
  const pad = 24;
  const total = c.width + pad * 2;
  const inner = rasterise(c.width, rects);
  const px = new Uint8ClampedArray(total * total * 4);
  const [lr, lg, lb] = [c.light.slice(1, 3), c.light.slice(3, 5), c.light.slice(5, 7)].map((h) => parseInt(h, 16));
  for (let i = 0; i < total * total; i++) { px[i * 4] = lr; px[i * 4 + 1] = lg; px[i * 4 + 2] = lb; px[i * 4 + 3] = 255; }
  for (let y = 0; y < c.width; y++) {
    for (let x = 0; x < c.width; x++) {
      const s = (y * c.width + x) * 4;
      const d = ((y + pad) * total + x + pad) * 4;
      px[d] = inner[s]; px[d + 1] = inner[s + 1]; px[d + 2] = inner[s + 2]; px[d + 3] = inner[s + 3];
    }
  }
  const found = jsQR(px, total, total, { inversionAttempts: 'attemptBoth' });
  check(`${c.name}: jsQR round trip`, found?.data === c.text, `got ${JSON.stringify(found?.data)}`);
}

const svg = renderQrSvg('lightning:name@example.com', { margin: 2, ecc: 'M' });
check('svg renders one path with 2-module quiet zone', svg.startsWith('<svg') && svg.includes('<path') && svg.includes('M2 2'), svg.slice(0, 120));

if (failed > 0) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log('QR checks passed');
