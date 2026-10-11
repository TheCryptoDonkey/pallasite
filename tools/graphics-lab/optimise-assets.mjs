import sharp from 'sharp';
import { writeFile, stat } from 'node:fs/promises';

const root = new URL('./assets/', import.meta.url);
const files = [];
for (const name of ['ship', 'stony', 'pallasite']) {
  for (const width of [128, 256, 512, 1024]) {
    const output = new URL(`${name}-${width}.webp`, root);
    await sharp(new URL(`${name}.png`, root).pathname).resize(width).webp({ quality: 88, alphaQuality: 100 }).toFile(output.pathname);
    files.push({ name: `${name}-${width}.webp`, width, bytes: (await stat(output)).size });
  }
  for (const size of [128, 256]) {
    const frames = await Promise.all(Array.from({ length: 32 }, async (_, i) => ({
      input: await sharp(new URL(`frames/${name}/${String(i).padStart(2, '0')}.png`, root).pathname).resize(size).png().toBuffer(),
      left: (i % 8) * size, top: Math.floor(i / 8) * size,
    })));
    const output = new URL(`${name}-atlas-${size}.webp`, root);
    await sharp({ create: { width: size * 8, height: size * 4, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite(frames).webp({ quality: 86, alphaQuality: 100 }).toFile(output.pathname);
    files.push({ name: `${name}-atlas-${size}.webp`, width: size * 8, height: size * 4, frames: 32, frameSize: size, bytes: (await stat(output)).size });
  }
}
const master = await sharp(new URL('background-master.png', root).pathname).metadata();
for (const name of ['ship','stony','pallasite']) {
  const filename = `${name}-cinematic.glb`;
  files.push({ name: filename, bytes: (await stat(new URL(filename,root))).size });
}
for(const name of ['stony','pallasite']){const filename=`${name}-previous.glb`;files.push({name:filename,bytes:(await stat(new URL(filename,root))).size});}
for (const width of [960, 1600, 2560]) {
  const filename = width === 2560 ? 'background-native.webp' : `background-${width}.webp`;
  const output = new URL(filename, root);
  await sharp(new URL('background-master.png', root).pathname).resize({ width, withoutEnlargement: true }).webp({ quality: 84 }).toFile(output.pathname);
  const metadata = await sharp(output.pathname).metadata();
  files.push({ name: filename, width: metadata.width, height: metadata.height, bytes: (await stat(output)).size });
}
await writeFile(new URL('manifest.json', root), JSON.stringify({ master: { width: master.width, height: master.height }, files }, null, 2) + '\n');
console.log(JSON.stringify({ master: { width: master.width, height: master.height }, files }, null, 2));
