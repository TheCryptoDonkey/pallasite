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

/** Background output — 1920x1080 is 1.5x the 1280x720 world, crisp on
 *  modern landscape screens. True 16:9, so cover-fit cleanly scales the
 *  QHD master with no crop; the full-quality master stays in originals/. */
const BG_W = 1920;
const BG_H = 1080;
/** Asteroid surface textures keep their legacy target — they are polygon
 *  fills / mesh diffuse maps, not 16:9 art, so they sit outside the
 *  background rework and the previous pipeline dimensions are preserved. */
const ASTEROID_W = 1280;
const ASTEROID_H = 960;
/** Defender wide-tile output. Source from the generator is 3072x1024;
 *  the runtime composites it via the seamless-tile path so it stays at
 *  3:1 aspect, no cover-fit crop. */
const DEFENDER_W = 3072;
const DEFENDER_H = 1024;
/** WebP quality — 78 is a sweet spot of detail vs file size for nebulae. */
const QUALITY = 78;

if (!existsSync(SRC_DIR)) {
  console.error(`Source directory not found: ${SRC_DIR}`);
  console.error('Run npm run gen-backgrounds first, or move PNGs into ./originals/.');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

const files = readdirSync(SRC_DIR).filter(f => /^(wave-\d+|sanctum|sanctum-space|defender-tile|asteroid-(stony|iron|chondrite|pallasite|carbonaceous|mesosiderite|achondrite))\.(png|jpg|jpeg|webp)$/i.test(f));
if (files.length === 0) {
  console.error('No matching originals (wave-N / sanctum / sanctum-space / defender-tile / asteroid-TYPE) found.');
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
  /** Output dimensions — 16:9 for backgrounds, legacy size for asteroids. */
  w: number;
  h: number;
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
      w: BG_W,
      h: BG_H,
    });
    continue;
  }
  const namedMatch = file.match(/^(sanctum(?:-space)?|defender-tile|asteroid-(?:stony|iron|chondrite|pallasite|carbonaceous|mesosiderite|achondrite))\./i);
  if (namedMatch) {
    if (onlyWave !== null) continue;
    const name = namedMatch[1].toLowerCase();
    const isAsteroid = name.startsWith('asteroid-');
    const isDefender = name === 'defender-tile';
    jobs.push({
      label: name,
      order: Infinity,
      src: join(SRC_DIR, file),
      dst: join(OUT_DIR, `${name}.webp`),
      w: isAsteroid ? ASTEROID_W : isDefender ? DEFENDER_W : BG_W,
      h: isAsteroid ? ASTEROID_H : isDefender ? DEFENDER_H : BG_H,
    });
  }
}
jobs.sort((a, b) => a.order - b.order);

if (jobs.length === 0) {
  console.error(`No matching wave (${onlyWave ?? 'any'}).`);
  process.exit(1);
}

console.log(`Optimising ${jobs.length} image${jobs.length === 1 ? '' : 's'} → WebP q${QUALITY} (backgrounds ${BG_W}x${BG_H})`);
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
    .resize(job.w, job.h, { fit: 'cover', position: 'centre' })
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
