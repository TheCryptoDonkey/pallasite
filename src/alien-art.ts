import type { UfoType } from './types.js';
import { ULTRA_UFOS } from './ultra-materials.js';

export const ALIEN_ART_REVISION='fleet-2';
const plates=new Map<UfoType,HTMLCanvasElement>();
export function alienArtDiagnostics(){return {revision:ALIEN_ART_REVISION,fallbacks:plates.size,maxFallbacks:5};}
/** Five finite, immediately available silhouettes while authored art loads. */
export function alienFallback(type:UfoType):HTMLCanvasElement {
  const cached=plates.get(type);if(cached)return cached;
  const canvas=document.createElement('canvas');canvas.width=canvas.height=128;
  const c=canvas.getContext('2d')!;c.translate(64,64);c.scale(45,45);
  const accent=`#${ULTRA_UFOS[type].accent.toString(16).padStart(6,'0')}`;
  const metal=c.createLinearGradient(-1,-1,1,1);metal.addColorStop(0,'#d0d9dc');metal.addColorStop(.4,'#657c8c');metal.addColorStop(1,'#192532');
  c.lineWidth=.022;c.strokeStyle='#bdab84';c.fillStyle=metal;
  c.beginPath();c.ellipse(0,0,.99,.83,0,0,Math.PI*2);c.fill();c.stroke();
  if(type==='elite')for(const side of [-1,1])for(const fore of [-1,1]){
    c.beginPath();c.moveTo(side*.55,fore*.15);c.lineTo(side*1.17,fore*.64);c.lineTo(side*.98,fore*.79);c.lineTo(side*.60,fore*.45);c.closePath();c.fill();c.stroke();
  }
  if(type==='tank'||type==='boss')for(let i=0;i<(type==='tank'?8:4);i++){
    c.save();c.rotate(i*Math.PI*2/(type==='tank'?8:4)+(type==='boss'?Math.PI/4:0));
    c.fillStyle=metal;c.fillRect(.69,-.23,.48,.46);c.strokeRect(.69,-.23,.48,.46);
    c.fillStyle='#14212b';c.fillRect(.84,-.14,.24,.28);c.fillStyle=accent;c.fillRect(1.07,-.1,.045,.2);c.restore();
  }
  if(type==='sniper')for(const side of [-1,1]){
    c.fillStyle=metal;c.fillRect(side*.57-.1,-.6,.2,1.65);c.strokeRect(side*.57-.1,-.6,.2,1.65);
    c.fillStyle='#111e2a';c.fillRect(side*.57-.055,-.5,.11,1.42);c.fillStyle=accent;c.fillRect(side*.57-.055,1,.11,.04);
  }
  c.strokeStyle='#14212b';c.lineWidth=.028;
  for(let i=0;i<8;i++){const a=i*Math.PI/4;c.beginPath();c.moveTo(Math.cos(a)*.43,Math.sin(a)*.36);c.lineTo(Math.cos(a)*.93,Math.sin(a)*.77);c.stroke();}
  c.strokeStyle=accent;c.lineWidth=.027;c.beginPath();c.ellipse(0,0,.40,.34,0,0,Math.PI*2);c.stroke();
  const glass=c.createRadialGradient(-.12,-.13,.01,0,0,.34);glass.addColorStop(0,'#9baab9');glass.addColorStop(.23,accent);glass.addColorStop(1,'#111929');
  c.fillStyle=glass;c.beginPath();c.ellipse(0,0,.34,.29,0,0,Math.PI*2);c.fill();
  if(type==='boss'){c.strokeStyle='#e6c781';c.lineWidth=.05;c.beginPath();c.ellipse(0,0,.53,.45,0,0,Math.PI*2);c.stroke();}
  plates.set(type,canvas);return canvas;
}
