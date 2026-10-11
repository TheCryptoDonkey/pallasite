import sharp from 'sharp';
import {copyFile,stat,writeFile} from 'node:fs/promises';
const art=new URL('./assets/',import.meta.url),out=new URL('../../public/graphics/level-one/',import.meta.url);
const types=['stony','iron','chondrite','pallasite','carbonaceous','mesosiderite','achondrite','kinetic','volatile','ballast','tektite','lodestone'];
const manifest=[];
for(const type of types)for(const tile of [64,128]){
  const frames=await Promise.all(Array.from({length:16},async(_,i)=>({input:await sharp(new URL(`frames/campaign/${type}-${String(i).padStart(2,'0')}.png`,art).pathname).resize(tile).png().toBuffer(),left:i%4*tile,top:Math.floor(i/4)*tile})));
  const name=`rock-${type}-${tile}.webp`;
  await sharp({create:{width:tile*4,height:tile*4,channels:4,background:'#00000000'}}).composite(frames).webp({quality:88,alphaQuality:100}).toFile(new URL(name,out).pathname);
  manifest.push({name,bytes:(await stat(new URL(name,out))).size});
}
for(const name of ['ufo-elite','ufo-tank','ufo-sniper','ufo-boss','station-core','station-arm','station-emitter','forge-core','forge-emitter','mine','missile']){
  await copyFile(new URL(`${name}.glb`,art),new URL(`${name}.glb`,out));
  manifest.push({name:`${name}.glb`,bytes:(await stat(new URL(`${name}.glb`,out))).size});
  for(const tile of [128,256]){
    await sharp(new URL(`frames/campaign/${name}.png`,art).pathname).resize(tile).webp({quality:90,alphaQuality:100}).toFile(new URL(`${name}-${tile}.webp`,out).pathname);
    manifest.push({name:`${name}-${tile}.webp`,bytes:(await stat(new URL(`${name}-${tile}.webp`,out))).size});
  }
}
await copyFile(new URL('pallasite-cinematic.glb',art),new URL('pallasite-cinematic.glb',out));
await writeFile(new URL('campaign-manifest.json',art),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({files:manifest.length,compressedBytes:manifest.reduce((sum,f)=>sum+f.bytes,0)},null,2));
await import('./optimise-alien-fleet.mjs');
