/**
 * Read full-quality PNG originals from `originals/`, write optimised WebPs to
 * `public/backgrounds/`. Run after generate-backgrounds (or any time you swap
 * an original).
 *
 * Usage:
 *   npm run optimise-backgrounds
 *   npm run optimise-backgrounds -- --wave 6
 *   npm run optimise-backgrounds -- --force        # regenerate even if newer
 */

import { readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, 'originals');
const OUT_DIR = join(ROOT, 'public/backgrounds');

const args = process.argv.slice(2);
const force = args.includes('--force');
const waveArgIdx = args.indexOf('--wave');
const onlyWave = waveArgIdx >= 0 ? parseInt(args[waveArgIdx + 1], 10) : null;

/** Output dimensions — 1280x960 covers up to ~1.3x DPI of the 960x720 canvas. */
const TARGET_W = 1280;
const TARGET_H = 960;
/** WebP quality — 78 is a sweet spot of detail vs file size for nebulae. */
const QUALITY = 78;

if (!existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  console.error('Run npm run gen-backgrounds first, or move PNGs into ./originals/.');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(SRC_DIR).filter(f => /^(wave-\d+|sanctum)\.(png|jpg|jpeg|webp)$/i.test(f));
if (files.length === 0) {
  console.error('No wave-N.png or sanctum.png originals found.');
  process.exit(1);
}

interface Job {
  /** Display label for log lines — 'wave-7' or 'sanctum'. */
  label: string;
  /** Sort key — wave number for wave-N, Infinity for named targets so
   *  they appear last in the log. */
  order: number;
  src: string;
  dst: string;
}
const jobs: Job[] = [];
for (const file of files) {
  const waveMatch = file.match(/^wave-(\d+)\./i);
  if (waveMatch) {
    const wave = parseInt(waveMatch[1], 10);
    if (onlyWave !== null && wave !== onlyWave) continue;
    jobs.push({
      label: `wave-${wave}`,
      order: wave,
      src: join(SRC_DIR, file),
      dst: join(OUT_DIR, `wave-${wave}.webp`),
    });
    continue;
  }
  if (/^sanctum\./i.test(file)) {
    // --wave N is wave-only; sanctum only runs in the unfiltered pass
    // so a `optimise-backgrounds -- --wave 7` doesn't accidentally
    // touch the Sanctum file.
    if (onlyWave !== null) continue;
    jobs.push({
      label: 'sanctum',
      order: Infinity,
      src: join(SRC_DIR, file),
      dst: join(OUT_DIR, 'sanctum.webp'),
    });
  }
}
jobs.sort((a, b) => a.order - b.order);

if (jobs.length === 0) {
  console.error(`No matching wave (${onlyWave ?? 'any'}).`);
  process.exit(1);
}

console.log(`Optimising ${jobs.length} background${jobs.length === 1 ? '' : 's'} → ${TARGET_W}x${TARGET_H} WebP q${QUALITY}`);
console.log('');

let totalIn = 0;
let totalOut = 0;

for (const job of jobs) {
  const srcStat = statSync(job.src);
  totalIn += srcStat.size;

  if (!force && existsSync(job.dst)) {
    const dstStat = statSync(job.dst);
    if (dstStat.mtimeMs >= srcStat.mtimeMs) {
      console.log(`  ${job.label}: up to date (${(dstStat.size / 1024).toFixed(1)} KB)`);
      totalOut += dstStat.size;
      continue;
    }
  }

  process.stdout.write(`  ${job.label}: optimising… `);
  await sharp(job.src)
    .resize(TARGET_W, TARGET_H, { fit: 'cover', position: 'centre' })
    .webp({ quality: QUALITY, effort: 5 })
    .toFile(job.dst);

  const dstStat = statSync(job.dst);
  totalOut += dstStat.size;
  const ratio = ((1 - dstStat.size / srcStat.size) * 100).toFixed(1);
  console.log(
    `${(srcStat.size / 1024).toFixed(0)} KB → ${(dstStat.size / 1024).toFixed(1)} KB (-${ratio}%)`,
  );
}

console.log('');
console.log(
  `Total: ${(totalIn / 1024 / 1024).toFixed(1)} MB → ${(totalOut / 1024 / 1024).toFixed(2)} MB ` +
  `(${((1 - totalOut / totalIn) * 100).toFixed(1)}% saved)`,
);
