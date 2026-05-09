/**
 * Render the master SVG icon at the PWA-required PNG sizes plus
 * apple-touch-icon. Run via `pnpm exec tsx tools/render-icons.ts` whenever
 * the SVG changes. Output committed to public/.
 *
 * Sizes:
 *   192 — Android home screen
 *   512 — splash + maskable
 *   180 — apple-touch-icon (iOS)
 *   maskable-512 — same 512 with extra padding so safe area survives clipping
 */

import sharp from 'sharp';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, 'icon.svg');
const outDir = resolve(here, '..', 'public');
mkdirSync(outDir, { recursive: true });

const svg = readFileSync(svgPath);

interface Target { size: number; name: string; padPercent?: number; }
const targets: Target[] = [
  { size: 192, name: 'icon-192.png' },
  { size: 512, name: 'icon-512.png' },
  { size: 180, name: 'apple-touch-icon.png' },
  // Maskable: 20% safe-area padding so clipping shapes don't crop the crystal
  { size: 512, name: 'icon-512-maskable.png', padPercent: 20 },
];

for (const t of targets) {
  const pad = t.padPercent ? Math.round((t.size * t.padPercent) / 100) : 0;
  const innerSize = t.size - pad * 2;
  const inner = await sharp(svg).resize(innerSize, innerSize).png().toBuffer();
  const out = await sharp({
    create: {
      width: t.size,
      height: t.size,
      channels: 4,
      // Pure black so maskable safe area matches the SVG's dark background
      background: { r: 0, g: 0, b: 0, alpha: 1 },
    },
  })
    .composite([{ input: inner, left: pad, top: pad }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  writeFileSync(resolve(outDir, t.name), out);
  console.log(`✓ ${t.name} (${t.size}×${t.size}${pad ? `, ${t.padPercent}% safe area` : ''})`);
}

// Also drop the master SVG itself so modern browsers can pick it up
writeFileSync(resolve(outDir, 'icon.svg'), svg);
console.log('✓ icon.svg');
