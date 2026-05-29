/**
 * Render the high-resolution Pallasite merch logo.
 *
 * Source art is deliberately split:
 *   - generated photoreal pallasite emblem
 *   - generated photoreal pallasite texture
 *   - deterministic local typography, so PALLASITE is always spelt correctly
 *
 * Outputs are print-scale PNGs under originals/merch/.
 */

import sharp from 'sharp';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const OUT_DIR = resolve(ROOT, 'originals', 'merch');
const EMBLEM = resolve(OUT_DIR, 'pallasite-shirt-emblem-transparent.png');
const ROUND_EXCITING_ART = resolve(OUT_DIR, 'pallasite-shirt-exciting-gpt-image-2-round-transparent.png');
const LEGACY_EXCITING_ART = resolve(OUT_DIR, 'pallasite-shirt-exciting-gpt-image-2-transparent.png');
const EXCITING_ART = existsSync(ROUND_EXCITING_ART) ? ROUND_EXCITING_ART : LEGACY_EXCITING_ART;
const TEXTURE = resolve(OUT_DIR, 'pallasite-shirt-wordmark-texture.png');

const MASTER_W = 6000;
const MASTER_H = 4500;
const DENSITY = 300;
const UPLOAD_W = 1500;
const UPLOAD_H = 3000;
const UPLOAD_DENSITY = 150;

mkdirSync(OUT_DIR, { recursive: true });

for (const path of [EMBLEM, TEXTURE]) {
  if (!existsSync(path)) {
    throw new Error(`Missing required source: ${path}`);
  }
}

const svg = (body: string, width: number, height: number): Buffer => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,
);

async function alphaFill(alphaPng: Buffer, width: number, height: number, color: string): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: color,
    },
  })
    .composite([{ input: alphaPng, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function textMask(width: number, height: number, opts: {
  text: string;
  fontSize: number;
  y: number;
  letterSpacing: number;
  textLength?: number;
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
}): Promise<Buffer> {
  const fill = opts.fill ?? '#ffffff';
  const stroke = opts.stroke
    ? `stroke="${opts.stroke}" stroke-width="${opts.strokeWidth ?? 0}" stroke-linejoin="round" paint-order="stroke fill"`
    : '';
  const textLength = opts.textLength
    ? `textLength="${opts.textLength}" lengthAdjust="spacingAndGlyphs"`
    : '';

  return sharp(svg(`
    <text x="50%" y="${opts.y}"
      text-anchor="middle"
      dominant-baseline="middle"
      font-family="Arial Black, Impact, Avenir Next Condensed, Helvetica Neue, sans-serif"
      font-size="${opts.fontSize}"
      font-weight="900"
      letter-spacing="${opts.letterSpacing}"
      ${textLength}
      ${stroke}
      fill="${fill}">${opts.text}</text>
  `, width, height))
    .png()
    .toBuffer();
}

async function maskedTexture(mask: Buffer, width: number, height: number): Promise<Buffer> {
  const texture = await sharp(TEXTURE)
    .resize(width, height, { fit: 'cover' })
    .modulate({ brightness: 1.08, saturation: 1.18 })
    .linear(1.08, -8)
    .sharpen({ sigma: 1.15, m1: 0.7, m2: 2.0 })
    .ensureAlpha()
    .toBuffer();

  return sharp(texture)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

async function render(): Promise<void> {
  const master = sharp({
    create: {
      width: MASTER_W,
      height: MASTER_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  const emblemSize = 1760;
  const emblem = await sharp(EMBLEM)
    .resize(emblemSize, emblemSize, { fit: 'contain' })
    .sharpen({ sigma: 0.8, m1: 0.45, m2: 1.4 })
    .png()
    .toBuffer();

  const halo = svg(`
    <defs>
      <radialGradient id="halo" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#f8ffb8" stop-opacity="0.30"/>
        <stop offset="42%" stop-color="#7fffb0" stop-opacity="0.20"/>
        <stop offset="72%" stop-color="#40d8ff" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="#40d8ff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <ellipse cx="1120" cy="1120" rx="1120" ry="1060" fill="url(#halo)"/>
  `, 2240, 2240);

  const wordW = 5480;
  const wordH = 860;
  const wordMask = await textMask(wordW, wordH, {
    text: 'PALLASITE',
    fontSize: 650,
    y: 465,
    letterSpacing: 38,
    textLength: 5200,
  });
  const wordStrokeMask = await textMask(wordW, wordH, {
    text: 'PALLASITE',
    fontSize: 650,
    y: 465,
    letterSpacing: 38,
    textLength: 5200,
    stroke: '#ffffff',
    strokeWidth: 24,
    fill: '#ffffff',
  });
  const wordGlowAlpha = await sharp(wordStrokeMask).blur(18).png().toBuffer();
  const wordOuterGlow = await alphaFill(wordGlowAlpha, wordW, wordH, '#65f5c266');
  const wordColdGlow = await alphaFill(await sharp(wordMask).blur(7).png().toBuffer(), wordW, wordH, '#55dfff55');
  const wordStroke = await alphaFill(wordStrokeMask, wordW, wordH, '#ecfff866');
  const wordFill = await maskedTexture(wordMask, wordW, wordH);
  const wordHighlight = await alphaFill(wordMask, wordW, wordH, '#ffffff24');

  const taglineW = 3900;
  const taglineH = 250;
  const taglineMask = await textMask(taglineW, taglineH, {
    text: 'SHOOT ROCKS. STACK SATS.',
    fontSize: 112,
    y: 124,
    letterSpacing: 22,
    textLength: 3520,
  });
  const taglineGlow = await alphaFill(await sharp(taglineMask).blur(8).png().toBuffer(), taglineW, taglineH, '#7fffb05c');
  const taglineFill = await alphaFill(taglineMask, taglineW, taglineH, '#baffcfdd');

  const composites: sharp.OverlayOptions[] = [
    { input: halo, left: 1880, top: 190 },
    { input: emblem, left: Math.round((MASTER_W - emblemSize) / 2), top: 340 },
    { input: wordOuterGlow, left: 260, top: 2060 },
    { input: wordColdGlow, left: 260, top: 2060 },
    { input: wordStroke, left: 260, top: 2060 },
    { input: wordFill, left: 260, top: 2060 },
    { input: wordHighlight, left: 260, top: 2060, blend: 'screen' },
    { input: taglineGlow, left: Math.round((MASTER_W - taglineW) / 2), top: 3070 },
    { input: taglineFill, left: Math.round((MASTER_W - taglineW) / 2), top: 3070 },
  ];

  const transparent = await master
    .composite(composites)
    .png({ compressionLevel: 9 })
    .withMetadata({ density: DENSITY })
    .toBuffer();

  const transparentPath = resolve(OUT_DIR, 'pallasite-shirt-logo-transparent-6000.png');
  writeFileSync(transparentPath, transparent);

  const blackPreview = await sharp(transparent)
    .flatten({ background: '#02050d' })
    .resize(2400, 1800)
    .webp({ quality: 92 })
    .toBuffer();

  const previewPath = resolve(OUT_DIR, 'pallasite-shirt-logo-black-preview-2400.webp');
  writeFileSync(previewPath, blackPreview);

  const squarePreview = await sharp(transparent)
    .resize(2400, 1800)
    .extend({
      top: 300,
      bottom: 300,
      left: 0,
      right: 0,
      background: '#02050d',
    })
    .flatten({ background: '#02050d' })
    .webp({ quality: 92 })
    .toBuffer();

  const squarePreviewPath = resolve(OUT_DIR, 'pallasite-shirt-logo-square-preview-2400.webp');
  writeFileSync(squarePreviewPath, squarePreview);

  const uploadDir = resolve(OUT_DIR, 'upload');
  mkdirSync(uploadDir, { recursive: true });
  const uploadPath = resolve(uploadDir, 'pallasite-shirt-upload-1500x3000-150dpi.png');
  const excitingUploadPath = resolve(uploadDir, 'pallasite-shirt-upload-exciting-gpt-image-2-1500x3000-150dpi.png');

  const uploadBase = sharp({
    create: {
      width: UPLOAD_W,
      height: UPLOAD_H,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  });

  let uploadPng: Buffer;
  if (existsSync(EXCITING_ART)) {
    const excitingArt = await sharp(EXCITING_ART)
      .resize({ width: 1380, height: 2100, fit: 'inside', withoutEnlargement: false })
      .sharpen({ sigma: 0.75, m1: 0.55, m2: 1.5 })
      .png()
      .toBuffer();
    const excitingMeta = await sharp(excitingArt).metadata();

    const uploadWordW = 1260;
    const uploadWordH = 320;
    const uploadWordMask = await textMask(uploadWordW, uploadWordH, {
      text: 'PALLASITE',
      fontSize: 240,
      y: 178,
      letterSpacing: 12,
      textLength: 1185,
    });
    const uploadWordStrokeMask = await textMask(uploadWordW, uploadWordH, {
      text: 'PALLASITE',
      fontSize: 240,
      y: 178,
      letterSpacing: 12,
      textLength: 1185,
      stroke: '#ffffff',
      strokeWidth: 10,
      fill: '#ffffff',
    });
    const uploadWordGlow = await alphaFill(await sharp(uploadWordStrokeMask).blur(9).png().toBuffer(), uploadWordW, uploadWordH, '#67ffc977');
    const uploadWordStroke = await alphaFill(uploadWordStrokeMask, uploadWordW, uploadWordH, '#effff080');
    const uploadWordFill = await maskedTexture(uploadWordMask, uploadWordW, uploadWordH);
    const uploadWordHighlight = await alphaFill(uploadWordMask, uploadWordW, uploadWordH, '#ffffff1f');

    const uploadTagW = 980;
    const uploadTagH = 110;
    const uploadTagMask = await textMask(uploadTagW, uploadTagH, {
      text: 'SHOOT ROCKS. STACK SATS.',
      fontSize: 37,
      y: 55,
      letterSpacing: 7,
      textLength: 920,
    });
    const uploadTagGlow = await alphaFill(await sharp(uploadTagMask).blur(5).png().toBuffer(), uploadTagW, uploadTagH, '#7fffb066');
    const uploadTagFill = await alphaFill(uploadTagMask, uploadTagW, uploadTagH, '#caffd8e6');

    uploadPng = await uploadBase
      .composite([
        { input: excitingArt, left: Math.round((UPLOAD_W - (excitingMeta.width ?? 1380)) / 2), top: 70 },
        { input: uploadWordGlow, left: Math.round((UPLOAD_W - uploadWordW) / 2), top: 2135 },
        { input: uploadWordStroke, left: Math.round((UPLOAD_W - uploadWordW) / 2), top: 2135 },
        { input: uploadWordFill, left: Math.round((UPLOAD_W - uploadWordW) / 2), top: 2135 },
        { input: uploadWordHighlight, left: Math.round((UPLOAD_W - uploadWordW) / 2), top: 2135, blend: 'screen' },
        { input: uploadTagGlow, left: Math.round((UPLOAD_W - uploadTagW) / 2), top: 2505 },
        { input: uploadTagFill, left: Math.round((UPLOAD_W - uploadTagW) / 2), top: 2505 },
      ])
      .png({ compressionLevel: 9 })
      .withMetadata({ density: UPLOAD_DENSITY })
      .toBuffer();

    writeFileSync(excitingUploadPath, uploadPng);
  } else {
    const uploadLogo = await sharp(transparent)
      .resize({ width: 1420, fit: 'inside' })
      .png()
      .toBuffer();
    const uploadMeta = await sharp(uploadLogo).metadata();
    uploadPng = await uploadBase
      .composite([{
        input: uploadLogo,
        left: Math.round((UPLOAD_W - (uploadMeta.width ?? 1420)) / 2),
        top: 520,
      }])
      .png({ compressionLevel: 9 })
      .withMetadata({ density: UPLOAD_DENSITY })
      .toBuffer();
  }

  uploadPng = await sharp(uploadPng)
    .png({ compressionLevel: 9 })
    .withMetadata({ density: UPLOAD_DENSITY })
    .toBuffer();

  writeFileSync(uploadPath, uploadPng);

  console.log(`Wrote ${transparentPath}`);
  console.log(`Wrote ${previewPath}`);
  console.log(`Wrote ${squarePreviewPath}`);
  console.log(`Wrote ${uploadPath}`);
  if (existsSync(EXCITING_ART)) console.log(`Wrote ${excitingUploadPath}`);
}

void render();
