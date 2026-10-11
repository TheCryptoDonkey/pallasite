import { WORLD_W, WORLD_H, WARP_MS, type GameState } from './types.js';
import { shouldReduceMotion } from './a11y.js';
import { getQualityLevel, reducedFxActive, mobileRuntimeActive } from './visual-style.js';

const TAU=Math.PI*2;
const glows=new Map<string,HTMLCanvasElement>();
function glow(colour:string):HTMLCanvasElement {
  let c=glows.get(colour);
  if(!c){c=document.createElement('canvas');c.width=c.height=256;
    const ctx=c.getContext('2d')!,g=ctx.createRadialGradient(128,128,0,128,128,128);
    g.addColorStop(0,'#ebfcff');g.addColorStop(.08,colour);g.addColorStop(.35,colour);g.addColorStop(1,'transparent');
    ctx.fillStyle=g;ctx.fillRect(0,0,256,256);glows.set(colour,c);}
  return c;
}

/** A lit, layered energy aperture shared by the tunnel and ship teleports. */
export function drawUltraAperture(ctx:CanvasRenderingContext2D,r:number,phase:number,alpha:number,colour='#72dcff',detail=true):void {
  ctx.save();ctx.shadowBlur=0;ctx.globalAlpha=alpha;ctx.globalCompositeOperation='lighter';
  ctx.globalAlpha=alpha*.22;ctx.drawImage(glow(colour),-r*1.28,-r*.86,r*2.56,r*1.72);
  ctx.globalAlpha=alpha;ctx.globalCompositeOperation='source-over';
  const rim=ctx.createLinearGradient(-r,-r*.7,r,r*.7);
  rim.addColorStop(0,'#152638');rim.addColorStop(.23,'#c5edfa');rim.addColorStop(.43,'#285c77');
  rim.addColorStop(.65,'#07121e');rim.addColorStop(.86,'#a0c9de');rim.addColorStop(1,'#20374b');
  ctx.strokeStyle=rim;ctx.lineWidth=Math.max(1,r*.035);
  ctx.beginPath();ctx.ellipse(0,0,r,r*.72,0,0,TAU);ctx.stroke();
  ctx.strokeStyle=colour;ctx.lineWidth=Math.max(.8,r*.008);
  ctx.beginPath();ctx.ellipse(0,0,r*.965,r*.69,0,0,TAU);ctx.stroke();
  if(detail){ctx.globalCompositeOperation='lighter';
    for(let i=0;i<3;i++){
      const a=phase+i*TAU/3;ctx.strokeStyle=i===1?'#ffd9ad':'#cdf5ff';ctx.lineWidth=Math.max(1,r*.018);
      ctx.beginPath();ctx.ellipse(0,0,r*1.04,r*.75,0,a,a+.72);ctx.stroke();
    }}
  ctx.restore();
}

// Fixed ornamental paths. Presentation never consumes gameplay RNG or advances stars per frame.
const streaks=Array.from({length:120},(_,i)=>({angle:i*2.399963,phase:((i*73)%127)/127,speed:.45+(i%7)*.055}));
let rockAtlas:HTMLImageElement|undefined;
let backdrop:HTMLImageElement|undefined;
let artReady:Promise<void>|undefined;
export function preloadUltraWarpArt():Promise<void> {
  if(shouldReduceMotion())return Promise.resolve();
  if(!artReady){
    backdrop=new Image();rockAtlas=new Image();
    artReady=Promise.all([[backdrop,'/backgrounds/warp-tunnel-ultra.webp'],[rockAtlas,'/graphics/level-one/rock-pallasite-128.webp']].map(([image,url])=>
      new Promise<void>(resolve=>{const img=image as HTMLImageElement;img.onload=()=>resolve();img.onerror=()=>resolve();img.src=url as string;}))).then(()=>{});
  }
  return artReady;
}
let diagnostic={rings:0,streaks:0,flybys:0,reducedMotion:false,backdrop:false};
export function ultraWarpDiagnostics(){return {...diagnostic};}

let tunnelLayer:HTMLCanvasElement|undefined;
const smoothstep=(t:number)=>t*t*(3-2*t);

/** Composite the whole tunnel over the exact next-level background. The fixed
 *  reusable surface makes opacity apply to every ring, glow and flyby together. */
export function drawUltraWarp(ctx:CanvasRenderingContext2D,s:GameState):void {
  const p=Math.max(0,Math.min(1,(s.elapsed-s.phaseStart)/WARP_MS));
  const fade=shouldReduceMotion()?smoothstep(p):smoothstep(Math.max(0,Math.min(1,(p-.62)/.38)));
  if(fade===1)return;
  if(!tunnelLayer){tunnelLayer=document.createElement('canvas');tunnelLayer.width=WORLD_W;tunnelLayer.height=WORLD_H;}
  const layer=tunnelLayer.getContext('2d')!;
  layer.clearRect(0,0,WORLD_W,WORLD_H);
  paintTunnel(layer,s);
  ctx.save();ctx.globalAlpha=1-fade;ctx.drawImage(tunnelLayer,0,0);ctx.restore();
}

/** Bounded cinematic: reflective rings, curled light trails and real mineral flybys. */
function paintTunnel(ctx:CanvasRenderingContext2D,s:GameState):void {
  const p=Math.max(0,Math.min(1,(s.elapsed-s.phaseStart)/WARP_MS));
  const reduced=shouldReduceMotion(),lite=getQualityLevel()==='low'||reducedFxActive()||mobileRuntimeActive();
  const seconds=(s.elapsed-s.phaseStart)/1000,intensity=Math.sin(p*Math.PI);
  diagnostic={rings:reduced?1:lite?7:14,streaks:reduced?0:lite?40:120,flybys:0,reducedMotion:reduced,backdrop:false};
  ctx.save();ctx.fillStyle='#020611';ctx.fillRect(0,0,WORLD_W,WORLD_H);
  if(reduced){
    ctx.translate(WORLD_W/2,WORLD_H/2);
    drawUltraAperture(ctx,90,0,Math.sin(p*Math.PI)*.6,'#72dcff',false);
    ctx.restore();return;
  }
  const cx=WORLD_W/2,cy=WORLD_H/2;
  ctx.translate(cx,cy);
  void preloadUltraWarpArt();
  if(backdrop?.complete&&backdrop.naturalWidth>0){
    // The authored throat is at 37.5% of the plate; align it with the live aperture.
    const w=WORLD_W*(1.55+p*.3),h=w*backdrop.height/backdrop.width;
    ctx.save();ctx.rotate(Math.sin(seconds*.15)*.035);ctx.globalAlpha=.55+intensity*.28;
    ctx.drawImage(backdrop,-w*.375,-h*.5,w,h);ctx.restore();diagnostic.backdrop=true;
  }
  ctx.globalCompositeOperation='lighter';ctx.globalAlpha=.04+intensity*.10;
  ctx.drawImage(glow('#5583dd'),-540,-330,1080,660);
  ctx.globalAlpha=intensity*.08;ctx.drawImage(glow('#ad6cbb'),-310,-230,620,460);
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  // Far-to-near elliptical rings give the tunnel a clear depth and machined rim.
  const count=diagnostic.rings;
  for(let i=count-1;i>=0;i--){
    const depth=(i/count+seconds*.32)%1,r=24+Math.pow(depth,2.1)*880;
    const alpha=Math.min(1,depth*4)*(1-depth)*(.45+intensity*.5)*(diagnostic.backdrop ? .32 : 1);
    ctx.save();ctx.translate(Math.sin(depth*3+seconds*.35)*depth*34,Math.cos(depth*4)*depth*15);
    ctx.rotate(Math.sin(seconds*.18+depth)*.13);
    drawUltraAperture(ctx,r,seconds*.35+depth*3,alpha,'#72dcff',!lite);ctx.restore();
  }
  ctx.globalCompositeOperation='lighter';ctx.lineCap='round';
  for(let i=0;i<diagnostic.streaks;i++){
    const st=streaks[i],depth=(st.phase+seconds*st.speed)%1;
    const r=18+depth*depth*960,a=st.angle+depth*.72+seconds*.055;
    const prev=Math.max(0,depth-.028-intensity*.033),rr=18+prev*prev*960,aa=st.angle+prev*.72+seconds*.055;
    ctx.globalAlpha=Math.min(1,depth*3)*(1-p*.7)*.65;
    ctx.strokeStyle=i%5===0?'#ffce9a':i%3===0?'#b6a1eb':'#a2eaff';ctx.lineWidth=.6+depth*1.8;
    ctx.beginPath();ctx.moveTo(Math.cos(aa)*rr,Math.sin(aa)*rr*.72);ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r*.72);ctx.stroke();
  }
  ctx.globalAlpha=1;ctx.globalCompositeOperation='source-over';
  // Four textured flybys at most, using the same approved mineral atlas as combat.
  if(!lite){
    if(rockAtlas?.complete&&rockAtlas.naturalWidth>0&&p<.82){
      const tile=rockAtlas.width/4;
      for(let i=0;i<4;i++){
        const age=(seconds*.38+i*.27)%1;if(age<.12||age>.88)continue;
        const a=i*2.39996+.4,reach=65+age*age*850,size=10+age*age*115,frame=Math.floor(age*16)%16;
        ctx.save();ctx.translate(Math.cos(a)*reach,Math.sin(a)*reach*.8);ctx.rotate(age*(i%2?1:-1));
        ctx.globalAlpha=Math.min(1,age*3,(1-age)*5)*.7;
        ctx.drawImage(rockAtlas,frame%4*tile,Math.floor(frame/4)*tile,tile,tile,-size/2,-size/2,size,size);
        ctx.restore();diagnostic.flybys++;
      }}
  }
  ctx.translate(-cx,-cy);
  ctx.restore();
}
