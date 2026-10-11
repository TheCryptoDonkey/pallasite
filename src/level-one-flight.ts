/** Shared Ultra presentation. Read real flight/combat state; never advance it. */
import type { Bullet, Coin, Debris, GameState, HyperspaceEffect, Particle, PowerUp, PowerUpType, Ship, Ufo } from './types.js';
import { POWERUP_CONFIG, SATBOOST_MUL } from './types.js';
import { shouldReduceMotion } from './a11y.js';
import { getQualityLevel } from './visual-style.js';
import { levelOneActive, levelOneLive, levelOneShipLive, levelOneUfoLive, levelOnePickupLive, ultraCategory, refreshedUfo, levelOneShipSprite, refreshedShip, levelOneDebrisSprite, levelOneDeathAtlas, levelOnePickupSprite, refreshedPowerup, levelOneCollectableLive, levelOneCollectableAtlas } from './level-one-refresh.js';
import { livePlayerBursts, liveMechanicalBursts, playerShard, playerBurstDuration, isPlayerBurstParticle } from './level-one-death.js';
import { SHIP_ART_SCALE, SHIP_BLENDER_SCALE, PICKUP_ART_SCALE, DEBRIS_KINDS, debrisKind, debrisScale, COLLECTABLE_ART_SCALE, collectableAlpha, collectablePhase } from './level-one-art.js';
import { MINERAL_SHARDS, DEFAULT_SHARD_TYPE, mineralShardPlate } from './mineral-shards.js';
import { levelOneProjectileSprite } from './level-one-refresh.js';
import { drawUltraAperture } from './ultra-warp.js';
import { drawRoundedPowerCell } from './powerup-art.js';

const TAU=Math.PI*2;
const glows=new Map<string,HTMLCanvasElement>();
let deathBlend:HTMLCanvasElement|undefined;
/** Blend adjacent baked volume frames in a tiny reusable surface. */
function drawDeathPlate(ctx:CanvasRenderingContext2D,atlas:HTMLImageElement,frame:number,x:number,y:number,size:number):void {
  const tile=atlas.width/6,first=Math.min(23,Math.floor(frame)),next=Math.min(23,first+1),fraction=Math.min(1,frame-first);
  deathBlend??=document.createElement('canvas');
  if(deathBlend.width!==tile){deathBlend.width=deathBlend.height=tile;}
  const c=deathBlend.getContext('2d')!;c.clearRect(0,0,tile,tile);c.globalCompositeOperation='lighter';
  c.globalAlpha=1-fraction;c.drawImage(atlas,(first%6)*tile,Math.floor(first/6)*tile,tile,tile,0,0,tile,tile);
  c.globalAlpha=fraction;c.drawImage(atlas,(next%6)*tile,Math.floor(next/6)*tile,tile,tile,0,0,tile,tile);
  ctx.drawImage(deathBlend,x,y,size,size);
}
function glow(color:string):HTMLCanvasElement {
  let canvas=glows.get(color);
  if(!canvas) {
    canvas=document.createElement('canvas');canvas.width=canvas.height=64;
    const c=canvas.getContext('2d')!,g=c.createRadialGradient(32,32,0,32,32,32);
    g.addColorStop(0,'#f3fdff');g.addColorStop(.12,color);g.addColorStop(.4,color);g.addColorStop(1,'transparent');
    c.fillStyle=g;c.fillRect(0,0,64,64);glows.set(color,canvas);
  }
  return canvas;
}
interface Exhaust {x:number;y:number;vx:number;vy:number;time:number;}
const wakes=new WeakMap<Ship,Exhaust[]>();
const stamps=new WeakMap<Ship,number>();
let flightTime=0;
let collectableTime=0,collectableLastElapsed:number|undefined;
export function updateLevelOneFlight(s:GameState):void {
  flightTime=s.elapsed;
  if(collectableLastElapsed===undefined||s.elapsed<collectableLastElapsed)collectableTime=s.elapsed;
  else if(s.phase!=='paused')collectableTime+=s.elapsed-collectableLastElapsed;
  collectableLastElapsed=s.elapsed;
  for(const {ship} of s.players) {
    if(!levelOneActive()||!ship.alive||ship.hyperspaceCloakMs>0||shouldReduceMotion()) {wakes.delete(ship);stamps.delete(ship);continue;}
    const wake=wakes.get(ship)??[];wakes.set(ship,wake);
    while(wake.length && (s.elapsed-wake[0].time>420||s.elapsed<wake[0].time))wake.shift();
    const previous=stamps.get(ship)??-100;
    if(ship.thrusting && (s.elapsed-previous>=35||s.elapsed<previous)) {
      const c=Math.cos(ship.rot),n=Math.sin(ship.rot);
      for(const side of [-1,1])wake.push({x:ship.pos.x-(c*12+n*side*3.1)*SHIP_ART_SCALE,y:ship.pos.y-(n*12-c*side*3.1)*SHIP_ART_SCALE,
        vx:ship.vel.x-c*70,vy:ship.vel.y-n*70,time:s.elapsed});
      if(wake.length>24)wake.splice(0,wake.length-24);stamps.set(ship,s.elapsed);
    }
  }
}

export function drawLevelOneCollectable(ctx:CanvasRenderingContext2D,c:Coin):boolean {
  if(!ultraCategory('particle'))return false;
  const live=levelOneCollectableLive(c),atlas=live?null:levelOneCollectableAtlas(c.kind);
  if(c.kind==='sat'&&!live&&!atlas)return false;
  const type=c.sourceType??DEFAULT_SHARD_TYPE;
  const alpha=collectableAlpha(c.ttl),radius=c.radius*COLLECTABLE_ART_SCALE,color=c.kind==='sat'?'#e8a529':MINERAL_SHARDS[type].colour;
  ctx.save();ctx.translate(c.pos.x,c.pos.y);ctx.shadowBlur=0;
  ctx.globalCompositeOperation='lighter';ctx.globalAlpha=alpha*.16;ctx.drawImage(glow(color),-radius*1.8,-radius*1.8,radius*3.6,radius*3.6);
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=alpha;
  if(!live&&c.kind==='dust') {
    const phase=shouldReduceMotion()?0:collectableTime*.0011+collectablePhase(c),frame=((Math.floor(phase/TAU*16)%16)+16)%16;
    const width=radius*2.8;ctx.drawImage(mineralShardPlate(type,frame),-width/2,-width/2,width,width);
  } else if(atlas){const tile=atlas.width/4,phase=shouldReduceMotion()?0:collectableTime*.0011+collectablePhase(c),frame=((Math.floor(phase/TAU*16)%16)+16)%16;
    const width=radius*2.8;ctx.drawImage(atlas,frame%4*tile,Math.floor(frame/4)*tile,tile,tile,-width/2,-width/2,width,width);}
  // The sat value stays readable when the coin turns edge-on.
  if(c.kind==='sat') {
    ctx.font='bold 7px system-ui';ctx.textAlign='center';ctx.textBaseline='top';ctx.lineWidth=2.5;ctx.strokeStyle='#07121b';ctx.fillStyle='#ffd782';
    const label=`${c.value} SAT`;ctx.strokeText(label,0,radius+3);ctx.fillText(label,0,radius+3);
  }
  ctx.restore();return true;
}

export function drawLevelOneShip(ctx:CanvasRenderingContext2D,ship:Ship,now:number,elapsed:number,forceSprite=false,tint?:string):boolean {
  if(!refreshedShip())return false;
  if(!ship.alive||ship.hyperspaceCloakMs>0)return true;
  if(ship.invulnerableUntil>elapsed && Math.floor(now/80)%2===0)return true;
  const low=getQualityLevel()==='low', reduced=shouldReduceMotion();
  ctx.save();ctx.shadowBlur=0;ctx.globalCompositeOperation='lighter';
  if(!low&&!reduced)for(const p of wakes.get(ship)??[]) {
    const age=(elapsed-p.time)/1000,alpha=Math.max(0,1-age/.42);
    if(age<0||!alpha)continue;
    const x=p.x+p.vx*age,y=p.y+p.vy*age,r=1.3+age*5;
    ctx.globalAlpha=alpha*alpha*.22;ctx.drawImage(glow('#329fc9'),x-r,y-r,r*2,r*2);
  }
  ctx.globalAlpha=1;ctx.translate(ship.pos.x,ship.pos.y);ctx.rotate(ship.rot);ctx.translate(-ship.recoilOffset,0);
  ctx.save();ctx.scale(SHIP_ART_SCALE,SHIP_ART_SCALE);
  if(ship.thrusting) {
    const pulse=reduced?1:.9+.1*Math.sin(elapsed*.075);
    for(const side of [-1,1]) {
      ctx.globalAlpha=.35;ctx.drawImage(glow('#298dce'),-33,side*3.1-9,32,18);
      ctx.globalAlpha=.95;
      ctx.drawImage(glow('#69dcff'),-12-16*pulse,side*3.1-2.5,16*pulse,5);
      ctx.fillStyle='#eefeff';ctx.beginPath();ctx.moveTo(-11.7,side*3.1-1.1);
      ctx.lineTo(-18*pulse,side*3.1);ctx.lineTo(-11.7,side*3.1+1.1);ctx.fill();
    }
  }
  // Short transverse jets sell rotation without implying altered traction.
  if(!low&&!reduced&&Math.abs(ship.rotVel)>.4) {
    const side=Math.sign(ship.rotVel),power=Math.min(1,Math.abs(ship.rotVel)/3);
    ctx.globalAlpha=power*.8;
    for(const [x,y,dir] of [[5,-side*4,-side],[-9,side*8,side]]) {
      ctx.save();ctx.translate(x,y);ctx.rotate(dir*Math.PI/2);
      ctx.drawImage(glow('#b9e8ff'),-1,-2,7*power,4);ctx.restore();
    }
  }
  ctx.restore();
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;
  if(!levelOneShipLive(ship)||forceSprite) {
    const sprite=levelOneShipSprite();
    if(sprite) {ctx.save();ctx.rotate(Math.PI/2);
      // The baked plate includes camera margins (3.35 Blender units).
      const size=3.35*SHIP_BLENDER_SCALE;ctx.drawImage(sprite,-size/2,-size/2,size,size);ctx.restore();}
    if(tint){ctx.strokeStyle=tint;ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(-8,-6);ctx.lineTo(8,-2);ctx.moveTo(-8,6);ctx.lineTo(8,2);ctx.stroke();}
  }
  if(ship.recoilOffset>.05&&!reduced) {
    const flash=ship.recoilOffset/1.8;ctx.globalCompositeOperation='lighter';ctx.globalAlpha=flash*.65;
    ctx.drawImage(glow('#ffd9a3'),8,-9,18,18);ctx.globalAlpha=flash;
    ctx.fillStyle='#fff6dd';ctx.beginPath();ctx.moveTo(15,-1.4);ctx.lineTo(21+flash*3,0);ctx.lineTo(15,1.4);ctx.fill();
  }
  ctx.restore();return true;
}

export function drawLevelOneShield(ctx:CanvasRenderingContext2D,ship:Ship,elapsed:number):boolean {
  if(!refreshedShip())return false;
  if(!ship.alive||!ship.shieldUp||ship.hyperspaceCloakMs>0||levelOneShipLive(ship))return true;
  const r=ship.radius*2.2,hit=ship.shieldHitFlash,fade=Math.min(1,Math.max(0,(ship.shieldExpiresAt-elapsed)/300));
  ctx.save();ctx.translate(ship.pos.x,ship.pos.y);ctx.shadowBlur=0;
  const g=ctx.createRadialGradient(0,0,r*.55,0,0,r);g.addColorStop(0,'rgba(72,161,220,0)');
  g.addColorStop(.8,`rgba(79,170,242,${(.06+hit*.2)*fade})`);g.addColorStop(1,`rgba(149,228,255,${(.5+hit*.3)*fade})`);
  ctx.fillStyle=g;ctx.beginPath();ctx.arc(0,0,r,0,TAU);ctx.fill();
  ctx.strokeStyle='#94dfff';ctx.lineWidth=.7+hit;ctx.globalAlpha=fade*.6;
  ctx.beginPath();ctx.arc(0,0,r,0,TAU);ctx.stroke();
  ctx.restore();return true;
}

export function drawLevelOneBullet(ctx:CanvasRenderingContext2D,b:Bullet,friendly:boolean):boolean {
  if(!ultraCategory('bullet'))return false;
  if(!b.alive)return true;
  if(b.homing||b.shard){
    const sprite=levelOneProjectileSprite(!!b.shard);if(!sprite)return false;
    ctx.save();ctx.translate(b.pos.x,b.pos.y);ctx.rotate(Math.atan2(b.vel.y,b.vel.x));ctx.shadowBlur=0;
    if(b.homing){const size=Math.max(14,b.radius*5.5);ctx.globalCompositeOperation='lighter';ctx.globalAlpha=.55;ctx.drawImage(glow('#ff873d'),-size*.9,-size*.16,size*.8,size*.32);
      ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.drawImage(sprite,-size/2,-size/2,size,size);
    }else {const tile=sprite.width/4,frame=shouldReduceMotion()?0:Math.floor(flightTime*.01)%16,size=b.radius*3;
      ctx.drawImage(sprite,frame%4*tile,Math.floor(frame/4)*tile,tile,tile,-size/2,-size/2,size,size);}
    ctx.restore();return true;
  }
  const speed=Math.max(1,Math.hypot(b.vel.x,b.vel.y)),length=Math.min(25,Math.max(9,speed*.025));
  const low=getQualityLevel()==='low',accent=friendly?'#71deff':'#ff976c';
  ctx.save();ctx.shadowBlur=0;ctx.translate(b.pos.x,b.pos.y);ctx.rotate(Math.atan2(b.vel.y,b.vel.x));
  ctx.globalCompositeOperation='lighter';
  if(!low) {ctx.globalAlpha=.5;ctx.drawImage(glow(accent),-length-3,-4,length+8,8);}
  ctx.globalAlpha=1;ctx.lineCap='round';ctx.strokeStyle=accent;ctx.lineWidth=2.6;
  ctx.beginPath();ctx.moveTo(-length,0);ctx.lineTo(0,0);ctx.stroke();
  ctx.strokeStyle=friendly?'#e7fdff':'#fff2db';ctx.lineWidth=1;
  ctx.beginPath();ctx.moveTo(-length*.6,0);ctx.lineTo(1,0);ctx.stroke();ctx.restore();return true;
}

export function drawLevelOneTeleport(ctx:CanvasRenderingContext2D,e:HyperspaceEffect,now:number):boolean {
  if(!ultraCategory('ship'))return false;
  const age=(now-e.startMs)/(e.kind==='collapse'?350:400);
  if(age<0||age>=1)return true;
  const reduced=shouldReduceMotion(),low=getQualityLevel()==='low';
  const collapse=e.kind==='collapse',accent=e.malfunction?'#ff684f':'#71dfff';
  const envelope=Math.sin(Math.PI*age),radius=reduced?24:collapse?46*Math.pow(1-age,.7)+3:4+65*(1-Math.pow(1-age,3));
  ctx.save();ctx.translate(e.x,e.y);ctx.shadowBlur=0;ctx.globalCompositeOperation='lighter';
  ctx.globalAlpha=envelope*.55;ctx.drawImage(glow(accent),-radius,-radius,radius*2,radius*2);
  drawUltraAperture(ctx,radius,reduced?0:age*2,envelope*.9,accent,!low&&!reduced);
  ctx.strokeStyle=accent;
  if(!low&&!reduced) {
    for(let i=0;i<14;i++) {
      const angle=i*2.39996+age*(collapse?1.5:-.5),r=radius*(.5+(i%4)*.16);
      ctx.globalAlpha=(1-age)*(.3+(i%3)*.15);ctx.lineWidth=i%3?.65:1.2;
      ctx.beginPath();ctx.moveTo(Math.cos(angle)*r,Math.sin(angle)*r*.72);
      ctx.lineTo(Math.cos(angle)*r*(collapse?.7:1.16),Math.sin(angle)*r*.72*(collapse?.7:1.16));ctx.stroke();
    }
    // A short anamorphic flare local to the jump, never a screen wash.
    ctx.globalAlpha=envelope*.4;ctx.drawImage(glow(accent),-radius*1.6,-3,radius*3.2,6);
  }
  ctx.restore();return true;
}

export function drawLevelOneDebris(ctx:CanvasRenderingContext2D,debris:ReadonlyArray<Debris>):boolean {
  if(!ultraCategory('ship'))return false;
  if(levelOneLive())return true;
  const atlas=levelOneDebrisSprite();if(!atlas)return false;
  ctx.save();ctx.shadowBlur=0;
  for(let i=0;i<debris.length;i++) {
    const d=debris[i],alpha=Math.max(0,Math.min(1,d.ttl/d.maxTtl));if(alpha<.05)continue;
    const age=(d.maxTtl-d.ttl)/1000,frame=Math.floor(age*10)%16,row=DEBRIS_KINDS.indexOf(debrisKind(i,d.length));
    const size=debrisScale(d.length)*1.45;
    ctx.save();ctx.globalAlpha=alpha;ctx.translate(d.pos.x,d.pos.y);ctx.rotate(d.rot);
    ctx.drawImage(atlas,frame*128,row*128,128,128,-size/2,-size/2,size,size);ctx.restore();
  }
  ctx.restore();return true;
}

/** Cached underside reactor glow for the baked tiers. */
export function drawLevelOneUfoThrust(ctx:CanvasRenderingContext2D,u:Ufo):void {
  if(!refreshedUfo(u)||levelOneUfoLive(u)||!u.alive)return;
  const speed=Math.hypot(u.vel.x,u.vel.y),power=Math.min(1,speed/100),r=u.radius;
  ctx.save();ctx.translate(u.pos.x,u.pos.y+r*.12);ctx.shadowBlur=0;
  ctx.globalCompositeOperation='lighter';
  const width=r*(2.7+power*.2),height=r*1.75;
  ctx.globalAlpha=.34+power*.13;ctx.drawImage(glow('#7952ee'),-width/2,-height/2,width,height);
  ctx.globalAlpha=.3+power*.12;ctx.drawImage(glow('#326fff'),-r*.7,-r*.42,r*1.4,r*.84);
  ctx.restore();
}

/** Render the classic particle paths as tiny cooling metal, rather than neon balls. */
export function drawLevelOneCrashParticle(ctx:CanvasRenderingContext2D,p:Particle,trails:boolean):boolean {
  if(!ultraCategory('ship')||!isPlayerBurstParticle(p))return false;
  const life=Math.max(0,p.ttl/p.maxTtl),age=1-life;
  if(life<.05)return true;
  const hot=age<.18;
  const blue=p.colour==='#58ff58'&&p.size>2.5;
  ctx.globalAlpha=life*(hot?.85:.65);ctx.strokeStyle=ctx.fillStyle=hot?(blue?'#b2e8ff':'#ffe5b4'):
    blue?(age<.55?'#429eff':'#294b79'):(age<.55?'#f47731':'#a83222');
  const length=trails?Math.min(5,Math.hypot(p.vel.x,p.vel.y)*.012*life):0;
  if(length>1){const a=Math.atan2(p.vel.y,p.vel.x);ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(p.pos.x,p.pos.y);
    ctx.lineTo(p.pos.x-Math.cos(a)*length,p.pos.y-Math.sin(a)*length);ctx.stroke();}
  ctx.fillRect(p.pos.x,p.pos.y,Math.max(.55,p.size*.35),Math.max(.45,p.size*.22));
  return true;
}

/** Blender hot gas and inertial hull bodies share the real impact location. */
export function drawLevelOneDeath(ctx:CanvasRenderingContext2D,s:GameState):void {
  if(!ultraCategory('ship'))return;
  const atlas=levelOneDeathAtlas(),debris=levelOneDebrisSprite(),low=getQualityLevel()==='low',reduced=shouldReduceMotion();
  ctx.save();ctx.shadowBlur=0;
  for(const b of [...livePlayerBursts(s),...liveMechanicalBursts(s)]) {
    const scale='scale' in b&&typeof b.scale==='number'?b.scale:1,mechanical='mechanical' in b;
    const age=(s.elapsed-b.time)/1000,duration=playerBurstDuration(b),fade=Math.max(0,1-age/duration),x=b.x+b.vx*.5*age,y=b.y+b.vy*.5*age;
    const gasDuration=b.final?2.6:1.15;
    if(atlas&&age<gasDuration) {
      // Fast initial expansion, then slower cooling: never crawl out as a puff.
      const frame=Math.min(23,Math.pow(age/gasDuration,.48)*23),size=(reduced?(b.final?190:100):(b.final?400:170))*scale;
      ctx.save();ctx.translate(x,y);ctx.rotate(b.rot+.65);ctx.globalCompositeOperation='source-over';
      ctx.globalAlpha=Math.pow(Math.max(0,1-age/gasDuration),.45)*.95;
      drawDeathPlate(ctx,atlas,frame,-size/2,-size/2,size);ctx.restore();
      // Delayed local venting from the ruptured core, using the same baked plate.
      if(b.final&&!low&&!reduced&&age>.16&&age<1.3) {
        const t=age-.16,f=Math.min(23,Math.pow(t/1.3,.55)*23),r=225*scale;
        ctx.save();ctx.translate(x+Math.cos(b.rot+1.2)*t*35,y+Math.sin(b.rot+1.2)*t*35);ctx.rotate(b.rot-1.4);
        ctx.globalAlpha=(1-t/1.3)*.48;drawDeathPlate(ctx,atlas,f,-r/2,-r/2,r);ctx.restore();
      }
    }
    ctx.globalCompositeOperation='lighter';
    const flash=Math.max(0,1-age/(b.final?.38:.2)),flashSize=(b.final?150:65)*scale;ctx.globalAlpha=flash*flash*(reduced?.25:.55);
    ctx.drawImage(glow('#ffd4a1'),x-flashSize/2,y-flashSize/2,flashSize,flashSize);
    // A blue core vent accompanies the orange/red thermal breakup.
    const ion=Math.max(0,1-age/(b.final?.55:.3)),ionSize=b.final?85:35;
    ctx.globalAlpha=ion*ion*(reduced?.15:.45);
    ctx.drawImage(glow('#268fff'),x+Math.cos(b.rot+.8)*12-ionSize/2,y+Math.sin(b.rot+.8)*12-ionSize/2,ionSize,ionSize);
    if(!reduced&&!mechanical)for(let i=0;i<(low?(b.final?10:6):(b.final?24:12));i++) {
      const p=playerShard(b,i,age),a=b.rot+i*2.399963;
      if(!levelOneLive()&&debris) {
        const frame=(i+Math.floor(age*12))%16,size=p.size*3;
        ctx.save();ctx.globalCompositeOperation='source-over';ctx.globalAlpha=fade;ctx.translate(p.x,p.y);ctx.rotate(p.rot);
        ctx.drawImage(debris,frame*128,3*128,128,128,-size/2,-size/2,size,size);ctx.restore();
      }
      // Hot ejecta cool rapidly; longer final-death streaks stay narrow and uneven.
      ctx.globalAlpha=Math.max(0,1-age/(b.final?1.4:.65))*.65;ctx.strokeStyle=i%5===0?'#4aaeff':age<.18?'#ffd9a3':i%3===0?'#b73b27':'#e7873d';ctx.lineWidth=.55;
      const trail=(b.final?9:4)*(1+(i%3)*.3)*Math.max(0,1-age/1.4);
      ctx.beginPath();ctx.moveTo(p.x,p.y);ctx.lineTo(p.x-Math.cos(a)*trail,p.y-Math.sin(a)*trail);ctx.stroke();
    }
  }
  ctx.restore();
}

export const levelOnePickupNames:Record<PowerUpType,{name:string;detail:string}>={
  rapid:{name:'RAPID FIRE',detail:'8 SEC'},satboost:{name:`SATS ×${SATBOOST_MUL}`,detail:'12 SEC'},
  nova:{name:'NOVA',detail:'CLEAR ROCKS'},trident:{name:'3-WAY FIRE',detail:'6 SEC'},
  magnet:{name:'LOOT MAGNET',detail:'8 SEC'},extralife:{name:'+1 LIFE',detail:'EXTRA SHIP'},
};
export function drawLevelOnePowerup(ctx:CanvasRenderingContext2D,p:PowerUp):boolean {
  if(!refreshedPowerup(p.type))return false;
  if(!p.alive||p.collected)return true;
  const color=POWERUP_CONFIG[p.type].colour,low=getQualityLevel()==='low';
  const fade=Math.min(1,Math.max(0,p.ttl/1600)),r=p.radius*PICKUP_ART_SCALE;
  ctx.save();ctx.translate(p.pos.x,p.pos.y);ctx.shadowBlur=0;ctx.globalAlpha=fade;
  if(!low){ctx.globalCompositeOperation='lighter';ctx.globalAlpha=fade*.22;
    const pulse=shouldReduceMotion()?1:1+.06*Math.sin(flightTime*.004);
    ctx.drawImage(glow(color),-r*2*pulse,-r*2*pulse,r*4*pulse,r*4*pulse);}
  ctx.globalCompositeOperation='source-over';ctx.globalAlpha=fade;
  if(!levelOnePickupLive(p)) {const sprite=levelOnePickupSprite(p.type);
    if(sprite)ctx.drawImage(sprite,-r*1.5,-r*1.5,r*3,r*3);
    else drawRoundedPowerCell(ctx,p.type,r);}
  // The semantic glyph is raised Blender geometry on the sphere itself.
  // A small matching glyph beside the label stays legible during its bank.
  ctx.save();ctx.translate(-r-8,r+12);ctx.scale(.55,.55);
  ctx.strokeStyle=color;ctx.fillStyle=color;ctx.lineWidth=1.8;ctx.lineCap='round';ctx.lineJoin='round';
  ctx.beginPath();
  if(p.type==='rapid') {ctx.moveTo(2,-7);ctx.lineTo(-5,1);ctx.lineTo(0,1);ctx.lineTo(-2,7);ctx.lineTo(5,-1);ctx.lineTo(0,-1);ctx.closePath();ctx.fill();}
  else if(p.type==='trident')for(const y of [-5,0,5]) {ctx.moveTo(-6,0);ctx.lineTo(5,y);ctx.lineTo(2,y-2);ctx.moveTo(5,y);ctx.lineTo(2,y+2);}
  else if(p.type==='magnet') {ctx.moveTo(-5,-5);ctx.lineTo(-5,1);ctx.bezierCurveTo(-5,7,5,7,5,1);ctx.lineTo(5,-5);ctx.moveTo(-7,-2);ctx.lineTo(-3,-2);ctx.moveTo(3,-2);ctx.lineTo(7,-2);}
  else if(p.type==='nova') {ctx.arc(0,0,3,0,TAU);for(let i=0;i<8;i++){const a=i*TAU/8;ctx.moveTo(Math.cos(a)*5,Math.sin(a)*5);ctx.lineTo(Math.cos(a)*8,Math.sin(a)*8);}}
  else if(p.type==='extralife') {ctx.moveTo(0,6);ctx.bezierCurveTo(-11,-1,-5,-10,0,-4);ctx.bezierCurveTo(5,-10,11,-1,0,6);ctx.closePath();ctx.fill();}
  if(p.type==='satboost'){ctx.font='bold 18px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('₿',0,0);}else ctx.stroke();
  ctx.restore();
  // Both a name and an effect cue: no memorising colours or obscure glyphs.
  const label=levelOnePickupNames[p.type];ctx.font='bold 9px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';
  const width=Math.max(ctx.measureText(label.name).width,ctx.measureText(label.detail).width)+12;
  ctx.fillStyle='rgba(3,11,18,.92)';ctx.fillRect(-width/2,r+4,width,25);
  ctx.strokeStyle=color;ctx.lineWidth=.65;ctx.strokeRect(-width/2,r+4,width,25);
  ctx.fillStyle='#effbff';ctx.fillText(label.name,0,r+11);
  ctx.font='8px system-ui';ctx.fillStyle=color;ctx.fillText(label.detail,0,r+22);
  ctx.restore();return true;
}

// Useful in the Chrome review harness without exposing or mutating sim data.
export function levelOneFlightDiagnostics(s:GameState) {
  return {time:flightTime,wakeSamples:wakes.get(s.players[0].ship)?.length??0,live:levelOneLive(),ship:refreshedShip()};
}
