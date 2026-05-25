/**
 * Render the Pallasite icon assets at the PNG sizes the manifest expects.
 * Run via `pnpm exec tsx tools/render-icons.ts` whenever a source changes.
 *
 * Sources (rich first, simple second — both required):
 *   originals/app-icon.png    — photoreal pallasite specimen (preferred rich source)
 *   tools/icon-rich.svg       — hand-illustrated fallback if no photoreal exists
 *   tools/icon.svg            — simple favicon-grade artwork (16-192px)
 *
 * Outputs to public/:
 *   icon.svg                — simple SVG (scalable favicon; browsers prefer it at 16/32)
 *   icon-rich.svg           — rich SVG  (kept for completeness)
 *   icon-192.png            — simple, Android home screen
 *   icon-512.png            — rich,   PWA install / splash
 *   icon-512-maskable.png   — rich,   Android maskable (20% safe-area padding)
 *   apple-touch-icon.png    — rich,   iOS home screen (180×180)
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const simpleSvgPath = resolve(here, 'icon.svg');
const richSvgPath   = resolve(here, 'icon-rich.svg');
const photorealPath = resolve(here, '..', 'originals', 'app-icon.png');
const outDir        = resolve(here, '..', 'public');
mkdirSync(outDir, { recursive: true });

const simpleSvg = readFileSync(simpleSvgPath);

// Prefer the photoreal original (gpt-image-2 hero render) for the rich source.
// Fall back to the hand-illustrated SVG if it hasn't been generated yet.
const hasPhotoreal = existsSync(photorealPath);
const richSource   = hasPhotoreal ? readFileSync(photorealPath) : readFileSync(richSvgPath);
const richLabel    = hasPhotoreal ? 'photoreal' : 'svg';
console.log(`Rich source: ${richLabel} (${hasPhotoreal ? photorealPath : richSvgPath})`);

interface Target {
  source: 'simple' | 'rich';
  size: number;
  name: string;
  padPercent?: number;
}

const targets: Target[] = [
  { source: 'simple', size: 192, name: 'icon-192.png' },
  { source: 'rich',   size: 512, name: 'icon-512.png' },
  { source: 'rich',   size: 180, name: 'apple-touch-icon.png' },
  // Maskable: 20% safe-area padding so Android clipping shapes don't crop content
  { source: 'rich',   size: 512, name: 'icon-512-maskable.png', padPercent: 20 },
];

for (const t of targets) {
  const src = t.source === 'rich' ? richSource : simpleSvg;
  const pad = t.padPercent ? Math.round((t.size * t.padPercent) / 100) : 0;
  const innerSize = t.size - pad * 2;
  const inner = await sharp(src).resize(innerSize, innerSize).png().toBuffer();
  const out = await sharp({
    create: {
      width: t.size,
      height: t.size,
      channels: 4,
      // Pure black: maskable safe area matches the deep-space background
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([{ input: inner, left: pad, top: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(outDir, t.name), out);
  console.log(`✓ ${t.name} (${t.size}×${t.size}${pad ? `, ${t.padPercent}% safe area` : ''}, ${t.source === 'rich' ? richLabel : 'svg'})`);
}

// Mirror the source SVGs into public/ so they can be served directly.
copyFileSync(simpleSvgPath, resolve(outDir, 'icon.svg'));
copyFileSync(richSvgPath,   resolve(outDir, 'icon-rich.svg'));
console.log('✓ icon.svg');
console.log('✓ icon-rich.svg');

// ─── Controller PWA icon ────────────────────────────────────────────────
// If a photoreal controller hero exists, derive the PNG icon sizes the
// controller manifest + iOS apple-touch swap need. Falls back to the
// hand-drawn /kempston.svg if the photoreal hasn't been generated.
const controllerHeroPath = resolve(here, '..', 'originals', 'controller-icon.png');
if (existsSync(controllerHeroPath)) {
  const hero = readFileSync(controllerHeroPath);
  interface CtrlTarget { size: number; name: string; padPercent?: number; }
  const ctrlTargets: CtrlTarget[] = [
    { size: 192, name: 'kempston-192.png' },
    { size: 512, name: 'kempston-512.png' },
    { size: 180, name: 'kempston-apple-touch.png' },
    { size: 512, name: 'kempston-512-maskable.png', padPercent: 20 },
  ];
  for (const t of ctrlTargets) {
    const pad = t.padPercent ? Math.round((t.size * t.padPercent) / 100) : 0;
    const innerSize = t.size - pad * 2;
    const inner = await sharp(hero).resize(innerSize, innerSize).png().toBuffer();
    const out = await sharp({
      create: { width: t.size, height: t.size, channels: 4, background: { r: 2, g: 5, b: 13, alpha: 1 } },
    })
      .composite([{ input: inner, left: pad, top: pad }])
      .png({ compressionLevel: 9 })
      .toBuffer();
    writeFileSync(resolve(outDir, t.name), out);
    console.log(`✓ ${t.name} (${t.size}×${t.size}${pad ? `, ${t.padPercent}% safe area` : ''}, controller-photoreal)`);
  }
} else {
  console.log('· skipped controller PNGs (no originals/controller-icon.png)');
}

// ─── Open Graph card ────────────────────────────────────────────────────
// gpt-image-2 outputs 1536×1024 (3:2). OG/Twitter cards want 1200×630 (~1.9:1).
// We crop the source backdrop down, then composite the canonical logo.webp
// wordmark + tagline on top — keeps brand typography locked across surfaces.
const ogCardPath  = resolve(here, '..', 'originals', 'og-card.png');
const wordmarkPath = resolve(here, '..', 'public',    'logo.webp');
if (existsSync(ogCardPath)) {
  const card = readFileSync(ogCardPath);
  const meta = await sharp(card).metadata();
  const srcW = meta.width  ?? 1536;
  const srcH = meta.height ?? 1024;
  // Centre-crop a band whose aspect matches 1200×630, then resize.
  const bandH = Math.round((srcW * 630) / 1200);
  const cropTop = Math.max(0, Math.round((srcH - bandH) / 2));
  const backdrop = await sharp(card)
    .extract({ left: 0, top: cropTop, width: srcW, height: Math.min(bandH, srcH) })
    .resize(1200, 630)
    .png()
    .toBuffer();

  // Composite the canonical wordmark (right two-thirds).
  // logo.webp is 960×293 with alpha. Scale to ~620×189 and place to the right of the slice.
  const wmW = 620, wmH = Math.round(293 * (wmW / 960));
  const wmX = 540,  wmY = 200;
  const wordmark = await sharp(wordmarkPath).resize(wmW, wmH).png().toBuffer();

  // Tagline rendered via SVG so we get crisp typography that survives PNG export.
  const taglineSvg = Buffer.from(`
<svg xmlns="http://www.w3.org/2000/svg" width="620" height="60">
  <text x="0" y="40"
        font-family="ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
        font-size="32" font-weight="600" letter-spacing="6"
        fill="#7fffb0" fill-opacity="0.92">SHOOT ROCKS. STACK SATS.</text>
</svg>`);
  const taglineY = wmY + wmH + 24;

  const og = await sharp(backdrop)
    .composite([
      { input: wordmark,    left: wmX, top: wmY },
      { input: taglineSvg,  left: wmX, top: taglineY },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(outDir, 'og-image.png'), og);
  console.log(`✓ og-image.png (1200×630, backdrop + composited wordmark)`);
} else {
  console.log('· skipped og-image.png (no originals/og-card.png)');
}
