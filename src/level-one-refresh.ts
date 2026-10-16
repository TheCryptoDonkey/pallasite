import type { Asteroid, Coin, GameState, PowerUpType, Ufo } from './types.js';
import { UFO_HP } from './types.js';
import { UFO_PLATE_WIDTH, PICKUP_KINDS, COLLECTABLE_KINDS, stationArt, PICKUP_ART_REVISION } from './level-one-art.js';
import { shouldReduceMotion } from './a11y.js';
import { getQualityLevel, getVisualStyle, mobile3dRequested, mobileRuntimeActive, mobileShadowsRequested } from './visual-style.js';
import { drawRockDust } from './rock-dust.js';
import { livePlayerBursts } from './level-one-death.js';
import { ULTRA_UFOS } from './ultra-materials.js';
import { sanctumThemed, relicPlate } from './sanctum-art.js';
import { ALIEN_ART_REVISION, alienFallback } from './alien-art.js';

const root = '/graphics/level-one/';
let enabled = true;
const images = new Map<string, HTMLImageElement>();
let live: Awaited<ReturnType<typeof import('./webgl/level-one.js').createLevelOneRenderer>> | undefined;
let loading = false;
let failed = false;
let active = false;
let liveFrame = false;
let shadows = true;
let backgroundWave=0;
/** Live 3D needs high quality on desktop; phones only run it when opted in. */
function liveAllowed(): boolean {
  return mobileRuntimeActive() ? mobile3dRequested() && getQualityLevel() !== 'low' : getQualityLevel() === 'high';
}
let relicTime=0,relicLastElapsed:number|undefined;
function image(name: string): HTMLImageElement | null {
  if(name.startsWith('pickup-'))name+=`?art=${PICKUP_ART_REVISION}`;
  if(name.startsWith('ufo-'))name+=`?art=${ALIEN_ART_REVISION}`;
  let img = images.get(name);
  if (!img) { img = new Image(); img.src = root + name; images.set(name, img); }
  return img.complete && img.naturalWidth > 0 ? img : null;
}
export function setLevelOneLook(value: boolean): void { enabled = value; }
export function levelOneActive(): boolean { return active; }
export function levelOneLive(): boolean { return liveFrame; }
export function ultraCategory(category:'asteroid'|'ship'|'bullet'|'particle'):boolean {return active&&getVisualStyle(category)!=='vector';}
export function levelOneDiagnostics() { return active && liveFrame ? live?.diagnostics() : null; }
export function levelOneShipSprite(): HTMLImageElement | null {
  return active ? image(getQualityLevel() === 'low' ? 'ship-128.webp' : 'ship-256.webp') ?? image('ship-128.webp') : null;
}
export function refreshedShip(): boolean { return ultraCategory('ship') && (liveFrame || !!levelOneShipSprite()); }
export function levelOneShipLive(ship:GameState['players'][number]['ship']):boolean{return liveFrame&&!!live?.hasShip(ship);}
export function refreshedUfo(_u?:Ufo): boolean {
  return ultraCategory('ship');
}
export function levelOneUfoLive(u:Ufo):boolean{return liveFrame&&!!live?.hasUfo(u);}
export function levelOnePickupSprite(type:PowerUpType='rapid'):HTMLImageElement|null {return active?image(`pickup-${type}-${getQualityLevel()==='low'?128:256}.webp`)??image(`pickup-${type}-128.webp`):null;}
export function refreshedPowerup(_type:PowerUpType='rapid'):boolean{return ultraCategory('particle');}
export function levelOnePickupLive(p:GameState['powerups'][number]):boolean{return liveFrame&&!!live?.hasPickup(p);}
export function levelOneDebrisSprite():HTMLImageElement|null{return active?image('debris-atlas.webp'):null;}
export function levelOneCollectableLive(c:Coin):boolean{return ultraCategory('particle')&&liveFrame&&!!live?.hasCollectable(c);}
export function levelOneCollectableAtlas(kind:Coin['kind']):HTMLImageElement|null{return active?image(`collectable-${kind}-${getQualityLevel()==='low'?64:128}.webp`)??image(`collectable-${kind}-64.webp`):null;}
export function levelOneProjectileSprite(shard:boolean):HTMLImageElement|null{return ultraCategory('bullet')?image(shard?'rock-pallasite-64.webp':'missile-128.webp'):null;}
const deathPlate=(tile:number)=>`death-atlas-${tile}.webp?art=thermal-3`;
export function levelOneDeathAtlas():HTMLImageElement|null{return active?image(deathPlate(getQualityLevel()==='low'?128:256))??image(deathPlate(128)):null;}
export function drawLevelOneUfo(ctx:CanvasRenderingContext2D,u:Ufo):boolean {
  if(!refreshedUfo(u))return false;
  if(!u.alive)return true;
  const themed=sanctumThemed();
  if(!themed&&u.hp<UFO_HP[u.type]&&(u.type==='tank'||u.type==='boss')) {
    ctx.save();ctx.translate(u.pos.x,u.pos.y);ctx.lineWidth=1.5;ctx.strokeStyle='#d5e2e9';ctx.globalAlpha=.18;
    ctx.beginPath();ctx.arc(0,0,u.radius*1.32,0,Math.PI*2);ctx.stroke();
    ctx.strokeStyle=`#${ULTRA_UFOS[u.type].accent.toString(16).padStart(6,'0')}`;ctx.globalAlpha=.8;
    ctx.beginPath();ctx.arc(0,0,u.radius*1.32,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,u.hp/UFO_HP[u.type]));ctx.stroke();ctx.restore();
  }
  if(levelOneUfoLive(u))return true;
  if(themed) {
    const frame=shouldReduceMotion()?0:Math.floor(relicTime*.00035/Math.PI*8);
    ctx.save();ctx.translate(u.pos.x,u.pos.y);const width=u.radius*3.45;
    ctx.drawImage(relicPlate(null,frame),-width/2,-width/2,width,width);
    if(u.hitFlash>0){ctx.globalCompositeOperation='lighter';ctx.globalAlpha=Math.min(1,u.hitFlash*.35);ctx.drawImage(relicPlate(null,frame),-width/2,-width/2,width,width);}
    ctx.restore();return true;
  }
  const variant=u.type==='cruiser'?'ufo':ULTRA_UFOS[u.type].asset;
  const sprite=image(`${variant}-${getQualityLevel()==='low'?128:256}.webp`)??image(`${variant}-128.webp`)??alienFallback(u.type);
  const width=u.radius*UFO_PLATE_WIDTH;
  ctx.save();ctx.translate(u.pos.x,u.pos.y);
  if(!shouldReduceMotion())ctx.rotate(Math.max(-.12,Math.min(.12,u.vel.y*.003)));
  ctx.drawImage(sprite,-width/2,-width/2,width,width);
  const charge=Math.max(0,Math.min(1,1-u.shootTimer/360));
  if(charge>0){ctx.globalAlpha=charge*.3;ctx.strokeStyle=`#${ULTRA_UFOS[u.type].accent.toString(16).padStart(6,'0')}`;ctx.lineWidth=1.3;
    ctx.beginPath();ctx.ellipse(0,0,u.radius*.36,u.radius*.30,0,0,Math.PI*2);ctx.stroke();ctx.globalAlpha=1;}
  if(u.hitFlash>0){ctx.globalCompositeOperation='lighter';ctx.globalAlpha=u.hitFlash*.3;ctx.drawImage(sprite,-width/2,-width/2,width,width);}
  ctx.restore();return true;
}
export function setLevelOneShadows(value: boolean): void { shadows = value; }
export function levelOneStatus(): string {
  return !enabled ? 'Current look' : !active ? 'Classic graphics'
    : liveFrame ? `Ultra · live 3D${shadows ? ' · shadows' : ''}`
    : failed ? 'Baked 3D · WebGL fallback' : loading ? 'Baked 3D · loading Ultra' : 'Baked 3D';
}
export function prepareLevelOne(s: GameState): void {
  backgroundWave=s.phase==='title'?0:s.wave;
  if(relicLastElapsed===undefined||s.elapsed<relicLastElapsed)relicTime=s.elapsed;
  else if(s.phase!=='paused')relicTime+=s.elapsed-relicLastElapsed;
  relicLastElapsed=s.elapsed;
  active = enabled && ['asteroid','ship','bullet','particle'].some(c=>getVisualStyle(c as 'asteroid'|'ship'|'bullet'|'particle')!=='vector');
  liveFrame = false;
  if (!active) return;
  for(const a of s.asteroids)if(!a.councilMember)image(a.stationPart?`${stationArt(a,backgroundWave)}-${getQualityLevel()==='low'?128:256}.webp`:`rock-${a.type}-${getQualityLevel()==='low'?64:128}.webp`);
  for(const u of s.ufos)if(u.type!=='cruiser'&&refreshedUfo(u))image(`${ULTRA_UFOS[u.type].asset}-${getQualityLevel()==='low'?128:256}.webp`);
  if(s.mines.some(m=>m.alive))image(`mine-${getQualityLevel()==='low'?128:256}.webp`);
  image('ship-128.webp');
  image('ufo-128.webp');
  for(const type of PICKUP_KINDS)image(`pickup-${type}-128.webp`);
  for(const kind of COLLECTABLE_KINDS)image(`collectable-${kind}-64.webp`);
  if(getQualityLevel()!=='low')for(const kind of COLLECTABLE_KINDS)image(`collectable-${kind}-128.webp`);
  image('debris-atlas.webp');
  image(deathPlate(128));
  if (getQualityLevel() !== 'low') image('ship-256.webp');
  if (getQualityLevel() !== 'low') image('ufo-256.webp');
  if (getQualityLevel() !== 'low')for(const type of PICKUP_KINDS)image(`pickup-${type}-256.webp`);
  if (getQualityLevel() !== 'low') image(deathPlate(256));
  if(s.wave===1&&s.phase!=='title'&&!sanctumThemed())image(getQualityLevel() === 'low' ? 'background-960.webp' : 'background-native.webp');
  if (liveAllowed() && !live && !loading && !failed) {
    loading = true;
    void import('./webgl/level-one.js').then(m => m.createLevelOneRenderer())
      .then(r => { live = r; }).catch(() => { failed = true; })
      .finally(() => { loading = false; });
  }
}
export function levelOneBackground(wave=backgroundWave): HTMLImageElement | null {
  if(sanctumThemed())return null;
  return active && wave===1 ? image(getQualityLevel() === 'low' ? 'background-960.webp' : 'background-native.webp') : null;
}
export function refreshedRock(a: Asteroid): boolean {
  if(a.councilMember)return ultraCategory('asteroid')&&(a.depth??3)===3;
  return ultraCategory('asteroid')
    && ((liveFrame&&!!live?.hasRock(a)) || !!image(a.stationPart?`${stationArt(a,backgroundWave)}-${getQualityLevel()==='low'?128:256}.webp`:`rock-${a.type}-${getQualityLevel()==='low'?64:128}.webp`));
}
// Baked rock atlases (the 2D path phones use) carry their own lighting, so a
// plain rotate spins the highlight with the rock. Each atlas gets LIT_POSES
// pre-rotated copies with a camera-fixed key light and terminator painted on,
// built lazily the first time a pose is drawn.
const LIT_POSES = 32, LIT_STEP = Math.PI * 2 / LIT_POSES, LIT_PAD = 1.15;
const litPoses = new WeakMap<HTMLImageElement, HTMLCanvasElement[]>();
function litRock(atlas: HTMLImageElement, pose: number): HTMLCanvasElement {
  let poses = litPoses.get(atlas);
  if (!poses) { poses = []; litPoses.set(atlas, poses); }
  const cached = poses[pose];
  if (cached) return cached;
  const tile = atlas.width / 4, size = Math.ceil(tile * LIT_PAD), r = tile / 2.35;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
  const c = canvas.getContext('2d')!;
  // Atlas frames share one orientation, so any frame works; the counter-
  // rotation picks the matching one so subtle per-frame lighting still reads.
  const frame = ((Math.round(-pose * 16 / LIT_POSES) % 16) + 16) % 16;
  c.translate(size / 2, size / 2); c.rotate(pose * LIT_STEP);
  c.drawImage(atlas, (frame % 4) * tile, Math.floor(frame / 4) * tile, tile, tile, -tile / 2, -tile / 2, tile, tile);
  c.setTransform(1, 0, 0, 1, size / 2, size / 2);
  c.globalCompositeOperation = 'source-atop';
  const light = c.createRadialGradient(-r * .4, -r * .45, r * .1, -r * .4, -r * .45, r * 1.15);
  light.addColorStop(0, 'rgba(255,240,220,.28)'); light.addColorStop(.45, 'rgba(255,240,220,.09)'); light.addColorStop(1, 'rgba(255,240,220,0)');
  c.fillStyle = light; c.fillRect(-size / 2, -size / 2, size, size);
  const dark = c.createRadialGradient(r * .5, r * .55, r * .1, r * .5, r * .55, r * 1.4);
  dark.addColorStop(0, 'rgba(0,0,0,.55)'); dark.addColorStop(.5, 'rgba(0,0,0,.25)'); dark.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = dark; c.fillRect(-size / 2, -size / 2, size, size);
  poses[pose] = canvas;
  return canvas;
}
let shadowSprite: HTMLCanvasElement | undefined;
/** Soft contact shadow, offset down-right to match the upper-left key light. */
function rockShadow(): HTMLCanvasElement {
  if (shadowSprite) return shadowSprite;
  shadowSprite = document.createElement('canvas'); shadowSprite.width = shadowSprite.height = 64;
  const c = shadowSprite.getContext('2d')!, g = c.createRadialGradient(32, 32, 6, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,.42)'); g.addColorStop(.6, 'rgba(0,0,0,.2)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
  return shadowSprite;
}
export function drawLevelOneRock(ctx: CanvasRenderingContext2D, a: Asteroid): boolean {
  if (!refreshedRock(a)) return false;
  if(a.councilMember) {
    ctx.save();ctx.translate(a.pos.x,a.pos.y);ctx.shadowBlur=0;
    if(a.radius>=20){ctx.font='bold 9px system-ui';ctx.textAlign='center';ctx.textBaseline='top';ctx.lineWidth=3;ctx.strokeStyle='#090e16';ctx.fillStyle='#e9d5b6';
      const label=`${a.councilMember.name} · ${a.councilMember.role}`;ctx.strokeText(label,0,a.radius*1.28);ctx.fillText(label,0,a.radius*1.28);}
    if(a.hpMax>1){ctx.strokeStyle='#d88c79';ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(0,0,a.radius*1.14,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(0,a.hp/a.hpMax));ctx.stroke();}
    ctx.restore();
  }
  if(a.isVein){ctx.save();ctx.translate(a.pos.x,a.pos.y);ctx.strokeStyle='#ffd782';ctx.globalAlpha=.65;ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(0,0,a.radius*1.2,0,Math.PI*2*Math.max(0,a.hp/a.hpMax));ctx.stroke();ctx.restore();}
  if (liveFrame && live?.hasRock(a)) return true;
  if(a.councilMember) {
    const reduced=shouldReduceMotion();
    const frame=reduced?0:Math.round(a.rot / (Math.PI*2)*16);
    const plate=relicPlate(a.councilMember,frame),width=a.radius*2.16;
    ctx.save();ctx.translate(a.pos.x,a.pos.y);ctx.rotate(reduced?0:a.rot);ctx.drawImage(plate,-width/2,-width/2,width,width);
    if(a.hitFlash>0){ctx.globalCompositeOperation='lighter';ctx.globalAlpha=Math.min(1,a.hitFlash*.3);ctx.drawImage(plate,-width/2,-width/2,width,width);}
    ctx.restore();return true;
  }
  if(a.stationPart){const sprite=image(`${stationArt(a,backgroundWave)}-${getQualityLevel()==='low'?128:256}.webp`)??image(`${stationArt(a,backgroundWave)}-128.webp`);if(!sprite)return false;
    const width=a.stationPart==='arm'?114:a.radius*2.7;
    ctx.save();ctx.translate(a.pos.x,a.pos.y);ctx.rotate(a.stationPart==='core'?0:a.rot);ctx.drawImage(sprite,-width/2,-width/2,width,width);ctx.restore();return true;}
  const atlas = image(`rock-${a.type}-${getQualityLevel()==='low'?64:128}.webp`);
  if (!atlas) return false;
  // Spin snaps to a cached pose and only the small residual rotates live, so
  // the baked key light and drop shadow stay camera-fixed while the rock turns.
  const pose = Math.round(a.rot / LIT_STEP);
  const lit = litRock(atlas, ((pose % LIT_POSES) + LIT_POSES) % LIT_POSES);
  ctx.save(); ctx.translate(a.pos.x, a.pos.y);
  const diameter = a.radius * 2.35;
  const shade = rockShadow();
  ctx.drawImage(shade, a.radius * .18 - a.radius * 1.1, a.radius * .24 - a.radius * 1.1, a.radius * 2.2, a.radius * 2.2);
  ctx.rotate(a.rot - pose * LIT_STEP);
  const drawn = diameter * LIT_PAD;
  ctx.drawImage(lit, -drawn / 2, -drawn / 2, drawn, drawn);
  if (a.hitFlash > 0) { ctx.globalAlpha *= a.hitFlash * .35; ctx.fillStyle = '#ffe9c6'; ctx.beginPath(); ctx.arc(0,0,a.radius,0,Math.PI*2); ctx.fill(); }
  ctx.restore(); return true;
}
export function drawLevelOneMeshes(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement,
  s: GameState, xs: number[], ys: number[], now: number, effectsState=s): void {
  if (!active || !live || !liveAllowed()) return;
  try {
    const transform = ctx.getTransform();
    const phone=mobileRuntimeActive(),mesh=(c:'asteroid'|'ship'|'particle')=>phone||getVisualStyle(c)==='mesh';
    const view={...s,asteroids:mesh('asteroid')?s.asteroids:[],ufos:mesh('ship')&&refreshedUfo()?s.ufos:[],
      players:mesh('ship')?s.players:[],powerups:mesh('particle')?s.powerups:[],coins:mesh('particle')?s.coins:[],
      debris:mesh('ship')?s.debris:[],mines:mesh('asteroid')?s.mines:[]};
    live.render(view, canvas.width, canvas.height, transform, xs, ys, shadows&&(!phone||mobileShadowsRequested()), now, shouldReduceMotion(),ultraCategory('ship')?livePlayerBursts(effectsState):[]);
    // The existing clip remains in force; identity avoids applying the world
    // transform twice. Rocks stay beneath bullets, ships, effects and HUD.
    ctx.save(); ctx.setTransform(1,0,0,1,0,0); ctx.drawImage(live.canvas,0,0,canvas.width,canvas.height); ctx.restore();
    liveFrame = true;
  } catch { failed = true; live.dispose(); live = undefined; }
}
export function drawUltraMineBody(ctx:CanvasRenderingContext2D,m:GameState['mines'][number]):boolean {
  if(!ultraCategory('asteroid'))return false;
  if(liveFrame&&live?.hasMine(m))return true;
  const sprite=image(`mine-${getQualityLevel()==='low'?128:256}.webp`)??image('mine-128.webp');if(!sprite)return false;
  ctx.save();ctx.translate(m.pos.x,m.pos.y);ctx.rotate(shouldReduceMotion()?0:m.age*.0003);const width=m.radius*2.7;ctx.drawImage(sprite,-width/2,-width/2,width,width);ctx.restore();return true;
}
let wellGlow:HTMLCanvasElement|undefined;
/** Cached accretion light and a stable boundary at the actual pull range. */
export function drawUltraGravityField(ctx:CanvasRenderingContext2D,m:GameState['mines'][number]):boolean {
  if(!ultraCategory('asteroid'))return false;
  if(!wellGlow){wellGlow=document.createElement('canvas');wellGlow.width=wellGlow.height=128;
    const c=wellGlow.getContext('2d')!,g=c.createRadialGradient(64,64,8,64,64,64);
    g.addColorStop(0,'rgba(255,180,100,.4)');g.addColorStop(.25,'rgba(235,82,80,.22)');
    g.addColorStop(.55,'rgba(99,105,235,.16)');g.addColorStop(1,'rgba(99,105,235,0)');
    c.fillStyle=g;c.fillRect(0,0,128,128);}
  const reduced=shouldReduceMotion(),low=getQualityLevel()==='low',t=reduced?0:m.age*.001;
  const strong=(m.gravityStrength??0)>100,r=m.radius,halo=r*(strong?4.8:4);
  ctx.save();ctx.translate(m.pos.x,m.pos.y);ctx.shadowBlur=0;
  ctx.globalCompositeOperation='lighter';ctx.drawImage(wellGlow,-halo,-halo,halo*2,halo*2);
  ctx.strokeStyle=strong?'rgba(255,176,123,.3)':'rgba(190,133,227,.23)';ctx.lineWidth=.9;
  ctx.setLineDash([8,12]);ctx.beginPath();ctx.arc(0,0,m.gravityRange,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
  const rings=low||reduced?2:3;
  for(let i=0;i<rings;i++) {
    const phase=reduced?(i+1)/(rings+1):1-((t*.32+i/rings)%1);
    const radius=r*1.55+(m.gravityRange-r*1.55)*phase;
    ctx.strokeStyle=`rgba(194,139,225,${.12+(1-phase)*.16})`;ctx.lineWidth=.8;
    ctx.beginPath();ctx.arc(0,0,radius,0,Math.PI*2);ctx.stroke();
  }
  // Bright inner rim stays visible against both dark space and bright nebulae.
  ctx.strokeStyle='rgba(255,169,119,.75)';ctx.lineWidth=1.2;
  for(let i=0;i<2;i++){const a=t*.45+i*Math.PI;ctx.beginPath();ctx.ellipse(0,0,r*1.65,r*1.15,.3,a,a+2.2);ctx.stroke();}
  ctx.restore();return true;
}
export function drawLevelOneImpacts(ctx: CanvasRenderingContext2D, s: GameState): void {
  if (!ultraCategory('asteroid')) return;
  drawRockDust(ctx, s, getQualityLevel() === 'low', shouldReduceMotion());
}
