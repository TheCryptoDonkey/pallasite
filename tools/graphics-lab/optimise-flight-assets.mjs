import sharp from 'sharp';
import {copyFile,stat} from 'node:fs/promises';
const assets=new URL('./assets/',import.meta.url),out=new URL('../../public/graphics/level-one/',import.meta.url);
for(const name of ['ufo','pickup']) {
  await copyFile(new URL(`${name}-cinematic.glb`,assets),new URL(`${name}-cinematic.glb`,out));
  for(const width of [128,256])await sharp(new URL(`${name}.png`,assets).pathname).resize(width).webp({quality:90,alphaQuality:100}).toFile(new URL(`${name}-${width}.webp`,out).pathname);
}
for(const type of ['rapid','satboost','nova','trident','magnet','extralife']) {
  await copyFile(new URL(`pickup-${type}.glb`,assets),new URL(`pickup-${type}.glb`,out));
  for(const width of [128,256])await sharp(new URL(`pickup-${type}.png`,assets).pathname).resize(width).webp({quality:90,alphaQuality:100}).toFile(new URL(`pickup-${type}-${width}.webp`,out).pathname);
}
for(const tile of [128,256]) {
  const frames=[];
  for(let frame=0;frame<24;frame++)frames.push({input:await sharp(new URL(`frames/death/${String(frame).padStart(2,'0')}.png`,assets).pathname).resize(tile).toBuffer(),left:(frame%6)*tile,top:Math.floor(frame/6)*tile});
  await sharp({create:{width:tile*6,height:tile*4,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(frames).webp({quality:90,alphaQuality:100}).toFile(new URL(`death-atlas-${tile}.webp`,out).pathname);
}
const kinds=['wing','engine','canopy','hull'];
for(const kind of kinds)await copyFile(new URL(`debris-${kind}.glb`,assets),new URL(`debris-${kind}.glb`,out));
const frames=[];
for(let row=0;row<kinds.length;row++)for(let frame=0;frame<16;frame++)frames.push({input:new URL(`frames/debris/${kinds[row]}-${String(frame).padStart(2,'0')}.png`,assets).pathname,left:frame*128,top:row*128});
await sharp({create:{width:2048,height:512,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(frames).webp({quality:90,alphaQuality:100}).toFile(new URL('debris-atlas.webp',out).pathname);
for(const filename of ['ufo-cinematic.glb','pickup-cinematic.glb',...kinds.map(k=>`debris-${k}.glb`),'debris-atlas.webp'])console.log(filename,(await stat(new URL(filename,out))).size);
