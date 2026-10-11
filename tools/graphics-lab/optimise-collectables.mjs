import sharp from 'sharp';
import {copyFile,stat} from 'node:fs/promises';
const assets=new URL('./assets/',import.meta.url),out=new URL('../../public/graphics/level-one/',import.meta.url);
for(const kind of ['sat','dust']) {
  await copyFile(new URL(`collectable-${kind}.glb`,assets),new URL(`collectable-${kind}.glb`,out));
  for(const tile of [64,128]) {
    const frames=[];
    for(let i=0;i<16;i++)frames.push({input:await sharp(new URL(`frames/collectables/${kind}-${String(i).padStart(2,'0')}.png`,assets).pathname).resize(tile).toBuffer(),left:i%4*tile,top:Math.floor(i/4)*tile});
    const name=`collectable-${kind}-${tile}.webp`;
    await sharp({create:{width:tile*4,height:tile*4,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(frames).webp({quality:90,alphaQuality:100}).toFile(new URL(name,out).pathname);
    console.log(name,(await stat(new URL(name,out))).size);
  }
}
