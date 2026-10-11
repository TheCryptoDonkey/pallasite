/** Editable procedural masters for the Sanctum's relics. No simulation writes or RNG. */
import type { CouncilMemberRef } from './types.js';
import { getCouncil, getMemberImage } from './sanctum-avatars.js';
import { getFlavour } from './flavour.js';
import { isSanctumMode } from './mode.js';

export const SANCTUM_ART_REVISION = 'relic-1';
export const RELIC_FRAMES = 16;
export const RELIC_MATERIALS = {
  pallasite: { metal: '#c9a565', dark: '#433222', accent: '#bdce7b', roughness: .32 },
  iron: { metal: '#a8b5c5', dark: '#253140', accent: '#eebf99', roughness: .27 },
  chondrite: { metal: '#ad8f82', dark: '#38272c', accent: '#d9c5b2', roughness: .55 },
  stony: { metal: '#c0a485', dark: '#392d2b', accent: '#99c5c9', roughness: .65 },
} as const;
export function sanctumThemed(): boolean { return getFlavour() === '600bn' || isSanctumMode(); }
export function relicMaterial(member?: CouncilMemberRef) {
  const type = member?.asteroidType;
  return RELIC_MATERIALS[type && type in RELIC_MATERIALS ? type as keyof typeof RELIC_MATERIALS : 'pallasite'];
}
export interface RelicFaces { front: HTMLCanvasElement; back: HTMLCanvasElement; revision: number; }
const faces = new Map<string, RelicFaces>();
const portraits = new Set<string>();
const plates = new Map<string, HTMLCanvasElement>();
function memberKey(member: CouncilMemberRef): string {
  // Real roster identities only; a reused entity ID never becomes an art/cache key.
  return getCouncil().some(m => m.name === member.name && m.img === member.img) ? member.name : 'unknown';
}
function canvas(): HTMLCanvasElement {
  const c = document.createElement('canvas'); c.width = c.height = 256; return c;
}
function ring(ctx: CanvasRenderingContext2D, radius: number, width: number, colour: string): void {
  ctx.strokeStyle = colour; ctx.lineWidth = width; ctx.beginPath(); ctx.arc(128,128,radius,0,Math.PI*2); ctx.stroke();
}
function base(ctx: CanvasRenderingContext2D, member?: CouncilMemberRef): void {
  const m = relicMaterial(member);
  ctx.clearRect(0,0,256,256);
  const g = ctx.createLinearGradient(24,12,224,244);
  g.addColorStop(0,'#fff0cc'); g.addColorStop(.18,m.metal); g.addColorStop(.46,m.dark);
  g.addColorStop(.63,m.metal); g.addColorStop(1,m.dark);
  ctx.fillStyle=g;ctx.beginPath();ctx.arc(128,128,122,0,Math.PI*2);ctx.fill();
  ring(ctx,119,3,'#f1d4a3');ring(ctx,109,4,m.dark);ring(ctx,105,1,m.accent);
  // Deterministic hammered metal, engraved radial notches and mineral inlays.
  for(let i=0;i<64;i++) {
    const a=i*Math.PI*2/64,x=Math.cos(a),y=Math.sin(a);
    ctx.strokeStyle=i%4?'rgba(12,9,14,.6)':m.accent;ctx.lineWidth=i%4?1:2;
    ctx.beginPath();ctx.moveTo(128+x*111,128+y*111);ctx.lineTo(128+x*117,128+y*117);ctx.stroke();
  }
  for(let i=0;i<80;i++) {
    const a=i*2.399963,r=110+8*Math.sin(i*1.7);
    ctx.fillStyle=i%2?'rgba(255,242,215,.16)':'rgba(4,8,12,.22)';
    ctx.fillRect(128+Math.cos(a)*r,128+Math.sin(a)*r,1,1);
  }
  ctx.fillStyle=m.dark;ctx.beginPath();ctx.arc(128,128,101,0,Math.PI*2);ctx.fill();
}
function lettering(ctx: CanvasRenderingContext2D, text: string, y: number, size: number, colour: string): void {
  ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`bold ${size}px Georgia, serif`;
  ctx.fillStyle=colour;ctx.fillText(text,128,y,184);
}
function paintMember(f:RelicFaces, member:CouncilMemberRef, portrait:CanvasImageSource|null):void {
  const m=relicMaterial(member),c=f.front.getContext('2d')!;base(c,member);
  c.save();c.beginPath();c.arc(128,119,79,0,Math.PI*2);c.clip();
  if(portrait){c.drawImage(portrait,49,40,158,158);
    const g=c.createLinearGradient(0,40,0,198);g.addColorStop(0,'rgba(255,227,185,.12)');g.addColorStop(.65,'transparent');g.addColorStop(1,'rgba(6,7,15,.6)');c.fillStyle=g;c.fillRect(49,40,158,158);
  }else lettering(c,member.name.slice(0,2).toUpperCase(),119,46,m.accent);
  c.restore();c.strokeStyle=m.accent;c.lineWidth=2;c.beginPath();c.arc(128,119,81,0,Math.PI*2);c.stroke();
  lettering(c,member.name.toUpperCase(),213,13,'#f6e4c5');
  lettering(c,member.role,26,11,m.accent);
  const b=f.back.getContext('2d')!;base(b,member);
  ring(b,87,1,m.accent);lettering(b,'THE COUNCIL',60,13,m.accent);
  lettering(b,member.role,118,43,'#f4dfbd');
  const words=member.archetype.toUpperCase().split(' '),mid=Math.ceil(words.length/2);
  lettering(b,words.slice(0,mid).join(' '),164,12,m.accent);lettering(b,words.slice(mid).join(' '),181,12,m.accent);
  lettering(b,'600 · THE SIGNAL',210,10,'#f4dfbd');
  f.revision++;
}
export function councilRelicFaces(member:CouncilMemberRef):RelicFaces {
  const key=memberKey(member);let f=faces.get(key);
  if(!f){f={front:canvas(),back:canvas(),revision:0};faces.set(key,f);paintMember(f,member,null);}
  const portrait=getMemberImage(member.name);
  if(portrait&&!portraits.has(key)) {
    paintMember(f,member,portrait);portraits.add(key);
    for(const k of plates.keys())if(k.startsWith(`${key}:`))plates.delete(k);
  }
  return f;
}
export function signalRelicFaces(bitcoin=false):RelicFaces {
  const key=bitcoin?'bitcoin':'signal';let f=faces.get(key);if(f)return f;
  f={front:canvas(),back:canvas(),revision:1};faces.set(key,f);
  for(const c of [f.front,f.back])base(c.getContext('2d')!);
  const a=f.front.getContext('2d')!,b=f.back.getContext('2d')!;
  if(bitcoin) {
    lettering(a,'₿',128,114,'#f4c86b');ring(a,89,1,'#957244');
    lettering(b,'₿',128,114,'#f4c86b');ring(b,89,1,'#957244');
  }else {
    ['600','000','000','000'].forEach((s,i)=>lettering(a,s,77+i*34,34,'#f8d88a'));
    lettering(a,'THE SIGNAL',32,10,'#e2b678');
    ring(b,89,1,'#c7a361');
    for(let i=0;i<12;i++){const angle=i*Math.PI/6-Math.PI/2;b.strokeStyle='#ddbc7a';b.lineWidth=i%3?1.5:3;
      b.beginPath();b.moveTo(128+Math.cos(angle)*77,128+Math.sin(angle)*77);b.lineTo(128+Math.cos(angle)*85,128+Math.sin(angle)*85);b.stroke();}
    lettering(b,'TIME LOCKED',88,12,'#f3d6a0');
    for(const [angle,length,width] of [[120,64,3],[130,43,5]]){const r=(angle-90)*Math.PI/180;b.strokeStyle='#ffe5aa';b.lineWidth=width;b.lineCap='round';b.beginPath();b.moveTo(128,128);b.lineTo(128+Math.cos(r)*length,128+Math.sin(r)*length);b.stroke();}
    lettering(b,'04:20',183,17,'#f3d6a0');
  }
  return f;
}
/** Sixteen bounded lighting/tilt plates per identity. Portraits remain readable. */
export function relicPlate(member:CouncilMemberRef|null, frame:number, bitcoin=false):HTMLCanvasElement {
  frame=((Math.floor(frame)%RELIC_FRAMES)+RELIC_FRAMES)%RELIC_FRAMES;
  const f=member?councilRelicFaces(member):signalRelicFaces(bitcoin),key=`${member?memberKey(member):bitcoin?'bitcoin':'signal'}:${frame}`;
  let p=plates.get(key);if(p)return p;
  p=document.createElement('canvas');p.width=p.height=128;const c=p.getContext('2d')!,phase=frame*Math.PI*2/RELIC_FRAMES;
  const yaw=member?Math.sin(phase)*.65:phase;
  const squeeze=Math.max(.08,Math.abs(Math.cos(yaw))),tilt=member?Math.sin(phase)*.12:.08;
  c.translate(64,64);c.rotate(tilt);c.scale(squeeze,1);
  const m=relicMaterial(member??undefined),g=c.createLinearGradient(-58,-58,58,58);
  g.addColorStop(0,m.metal);g.addColorStop(.5,m.dark);g.addColorStop(1,m.metal);
  c.fillStyle=g;c.beginPath();c.ellipse(2,4,60,60,0,0,Math.PI*2);c.fill();
  c.drawImage(Math.cos(yaw)<0?f.back:f.front,-60,-60,120,120);
  const light=c.createLinearGradient(-60,-60,60,60);light.addColorStop(0,'rgba(255,246,226,.15)');light.addColorStop(.5,'transparent');light.addColorStop(1,'rgba(3,8,17,.24)');
  c.fillStyle=light;c.beginPath();c.arc(0,0,57,0,Math.PI*2);c.fill();
  plates.set(key,p);return p;
}
export function sanctumArtDiagnostics(){return {revision:SANCTUM_ART_REVISION,identities:faces.size,plates:plates.size,maxPlates:14*RELIC_FRAMES,portraits:portraits.size};}
