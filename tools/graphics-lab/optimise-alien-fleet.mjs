import sharp from 'sharp';
import {copyFile,stat,writeFile} from 'node:fs/promises';
const art=new URL('./assets/',import.meta.url),out=new URL('../../public/graphics/level-one/',import.meta.url),manifest=[];
for(const kind of ['cruiser','elite','tank','sniper','boss']) {
  const name=kind==='cruiser'?'ufo':`ufo-${kind}`,model=kind==='cruiser'?'ufo-cinematic':name;
  await copyFile(new URL(`${model}.glb`,art),new URL(`${model}.glb`,out));
  manifest.push({name:`${model}.glb`,bytes:(await stat(new URL(`${model}.glb`,out))).size});
  for(const tile of [128,256]) {
    const plate=kind==='cruiser'?'ufo-cruiser':name;
    await sharp(new URL(`frames/campaign/${plate}.png`,art).pathname).resize(tile).webp({quality:90,alphaQuality:100}).toFile(new URL(`${name}-${tile}.webp`,out).pathname);
    manifest.push({name:`${name}-${tile}.webp`,bytes:(await stat(new URL(`${name}-${tile}.webp`,out))).size});
  }
}
await writeFile(new URL('alien-fleet-manifest.json',art),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
