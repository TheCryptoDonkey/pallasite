import { makeInitialState } from '/src/game.ts';
import { render, setRenderMode, setHudHidden, preloadBackgroundReady } from '/src/render.ts';
import { setForcedVisualTier, ensureWebGLForCurrentStyle, isWebGLOverlayReady } from '/src/visual-style.ts';
import { rockOffsets, impactAge, lifetime, fragment, dustOpacity } from './impact.js';

const look = new URLSearchParams(location.search).get('look');
const after = look !== 'before';
const previous = look === 'previous';
const canvas = document.getElementById('game');
const overlay = document.getElementById('game3d');
const ctx = canvas.getContext('2d');
const state = makeInitialState();
state.phase = 'playing'; state.wave = 1; state.elapsed = 8000;
state.players[0].ship.alive = true;
state.players[0].ship.invulnerableUntil = 0;
state.players[0].ship.thrusting = true;
state.players[0].ship.rot = .25;
state.players[0].ship.pos = { x: 640, y: 445 };
let config = { scene: 'belt', budget: 'balanced', paused: false };
let loaded = false;
let assets = {};
let assetsReady = false;
let bgWidth = 1600;
let kb = 0;
let assetVersion = 0;
let lastReport = 0;
let durations = [];
let cinematic = null;
let cinematicPromise = null;
const puff=document.createElement('canvas');puff.width=puff.height=64;
const puffContext=puff.getContext('2d');const puffGradient=puffContext.createRadialGradient(32,32,0,32,32,32);
puffGradient.addColorStop(0,'rgba(195,177,150,.16)');puffGradient.addColorStop(.4,'rgba(195,177,150,.05)');puffGradient.addColorStop(1,'rgba(195,177,150,0)');puffContext.fillStyle=puffGradient;puffContext.fillRect(0,0,64,64);
const manifest = await fetch('./assets/manifest.json').then(r => r.json());
function image(name) { return new Promise((resolve, reject) => { const img = new Image(); img.onload = async () => { await img.decode(); resolve(img); }; img.onerror = () => reject(new Error('Missing asset: ' + name)); img.src = './assets/' + name; }); }
async function loadAssets() {
  const version = ++assetVersion;
  assetsReady = false;
  parent.postMessage({type:'loading'},location.origin);
  const bg = config.budget === 'low' ? 960 : config.budget === 'high' ? 'native' : 1600;
  const size = config.budget === 'high' || config.scene === 'detail' ? 256 : 128;
  const ultra = config.budget === 'high';
  const names = ultra ? [`background-${bg}.webp`] : [`background-${bg}.webp`, `ship-atlas-${size}.webp`, `stony-atlas-${size}.webp`, `pallasite-atlas-${size}.webp`];
  const images = await Promise.all(names.map(image));
  if (ultra) {
    cinematicPromise ??= import('./cinematic.js').then(mod => mod.createCinematic(overlay,previous));
    try { cinematic = await cinematicPromise; }
    catch(error) {
      if(version!==assetVersion)return;
      config={...config,budget:'balanced'};
      parent.postMessage({type:'fallback',message:'Live 3D unavailable; using baked assets.'},location.origin);
      return loadAssets();
    }
  }
  if (version !== assetVersion) return;
  assets = Object.fromEntries(['background', 'ship', 'stony', 'pallasite'].map((name, i) => [name, images[i]]));
  const consumed = ultra ? [...names, ...['ship','stony','pallasite'].map(name=>`${name}-${previous&&name!=='ship'?'previous':'cinematic'}.glb`)] : names;
  kb = Math.round(consumed.reduce((sum, name) => sum + (manifest.files.find(f => f.name === name)?.bytes ?? 0), 0)/1024);
  bgWidth = images[0].naturalWidth;
  assetsReady = true;
}
const baseRocks = Array.from({ length: 80 }, (_, i) => {
  const x = 90 + ((i * 173 + 48) % 1100), y = 110 + ((i * 137 + 62) % 490);
  const radius = i % 4 === 0 ? 42 : i % 3 === 0 ? 22 : 30;
  return { id: i + 100, pos: { x, y }, vel: { x: 0, y: 0 }, radius, alive: true, size: radius > 30 ? 'large' : 'medium', type: i % 3 === 0 ? 'pallasite' : 'stony', hp: 1, hpMax: 1, hitFlash: 0, rot: i * 1.13, rotVel: .2, shape: Array.from({length: 12}, (_, k) => .84 + .13 * Math.sin(k*2.4+i)), hue: 0, isVein: false, depth: 3 };
});
function buildScene(time) {
  const close = config.scene === 'detail';
  const inspect = config.scene.startsWith('inspect-');
  const collision = config.scene === 'collision';
  const portrait = innerHeight > innerWidth;
  const count = inspect ? 1 : close || collision ? 2 : config.scene === 'stress' ? 80 : 12;
  state.asteroids = baseRocks.slice(0, count).map((rock, i) => ({ ...rock, radius: close ? 110 : rock.radius,
    type: close ? (i === 0 ? 'stony' : 'pallasite') : rock.type,
    rot: rock.rot + time * .0001,
    pos: close ? portrait ? {x:640,y:i===0?185:555} : { x: i === 0 ? 265 : 1015, y: 360 } : { x: rock.pos.x + Math.sin(time*.00015+i)*22, y: rock.pos.y + Math.cos(time*.00013+i)*18 } }));
  state.players[0].ship.pos = { x: 640, y: close ? 350 : 445 };
  state.players[0].ship.thrusting = !close;
  if(inspect){state.asteroids[0].radius=235;state.asteroids[0].type=config.scene==='inspect-stony'?'stony':'pallasite';state.asteroids[0].pos={x:640,y:360};state.players[0].ship.pos={x:1010,y:570};}
  if(collision) {
    const offsets=rockOffsets(time/1000);
    state.asteroids.forEach((rock,i)=>{rock.radius=i===0?130:100;rock.type=i===0?'stony':'pallasite';rock.pos=portrait?{x:640,y:360+offsets[i]}:{x:640+offsets[i],y:360};});
    state.players[0].ship.pos={x:portrait?770:1040,y:portrait?360:530};
  }
  // Magnification is equal on both sides, so the material study is fair.
  state.players[0].ship.radius = close ? 50 : 12;
  state.players[0].ship.rot = close ? 0 : .25 + Math.sin(time*.00018)*.35;
  state.elapsed = time;
  state.bullets = close || collision || inspect ? [] : Array.from({length:4}, (_, i) => ({id:300+i,alive:true,pos:{x:635+i*4,y:385-i*38},vel:{x:0,y:-520},radius:2,ttl:500,owner:0}));
  document.getElementById('scene-name').textContent = inspect ? 'ULTRA / '+state.asteroids[0].type.toUpperCase()+' INSPECTION' : collision ? 'ULTRA / COLLISION VIGNETTE' : close ? 'MATERIAL STUDY / 4× VIEW' : config.scene === 'stress' ? 'DENSITY STUDY / 80 ROCKS' : 'ESQUEL / ASTEROID BELT';
}
function geometry() {
  const w = innerWidth, h = innerHeight;
  const dpr = Math.min(devicePixelRatio || 1, config.budget === 'low' ? 1 : config.budget === 'high' ? 2 : 1.5);
  const portrait = h > w;
  const scale = portrait ? h / 720 : Math.min(w/1280, h/720);
  const tx = (w - 1280*scale)/2, ty = (h - 720*scale)/2;
  if (canvas.width !== Math.round(w*dpr) || canvas.height !== Math.round(h*dpr)) {
    canvas.width = Math.round(w*dpr); canvas.height = Math.round(h*dpr);
    overlay.width = canvas.width; overlay.height = canvas.height;
  }
  return { w,h,dpr,scale,tx,ty };
}
function sprite(img, x, y, diameter, rotation) {
  const step = Math.PI * 2 / 32;
  const yaw = Math.round(-rotation / step);
  const frame = ((yaw % 32) + 32) % 32;
  const size = img.width / 8;
  ctx.save(); ctx.translate(x, y); ctx.rotate(rotation + yaw * step);
  ctx.drawImage(img, (frame % 8) * size, Math.floor(frame / 8) * size, size, size, -diameter/2, -diameter/2, diameter, diameter); ctx.restore();
}
function drawAfter(g, time) {
  if(config.budget==='high' && cinematic) {
    overlay.style.display='block';cinematic.render(g,state,time,config);return;
  }
  overlay.style.display='none';
  ctx.setTransform(g.dpr,0,0,g.dpr,0,0);
  const bg = assets.background;
  const cover = Math.max(g.w/bg.width,g.h/bg.height);
  ctx.drawImage(bg,(g.w-bg.width*cover)/2,(g.h-bg.height*cover)/2,bg.width*cover,bg.height*cover);
  ctx.fillStyle='rgba(0,4,9,.18)'; ctx.fillRect(0,0,g.w,g.h);
  ctx.setTransform(g.dpr*g.scale,0,0,g.dpr*g.scale,g.tx*g.dpr,g.ty*g.dpr);
  for (const rock of state.asteroids) sprite(assets[rock.type],rock.pos.x,rock.pos.y,rock.radius*3.15/1.06,rock.rot);
  const ship = state.players[0].ship;
  if (config.scene !== 'detail') {
    ctx.save();ctx.translate(ship.pos.x,ship.pos.y);ctx.rotate(ship.rot+Math.PI/2);
    ctx.fillStyle='#84d9e6';ctx.beginPath();ctx.moveTo(-3,13);ctx.lineTo(0,26+Math.sin(time*.02)*3);ctx.lineTo(3,13);ctx.fill();ctx.restore();
  }
  sprite(assets.ship,ship.pos.x,ship.pos.y,ship.radius*3.35/1.38*4/3,ship.rot+Math.PI/2);
  const age=impactAge(time/1000);
  if(config.scene==='collision'&&config.debris!==false&&age>=0&&age<lifetime) {
    const portrait=g.h>g.w,low=config.budget==='low';
    ctx.save();
    ctx.globalAlpha=dustOpacity(age);
    for(let i=0;i<(low?16:32);i++) {
      const p=fragment(i,age,portrait,true),r=3+age*5+(i%4);
      ctx.drawImage(puff,p.x-r,p.y-r,r*2,r*2);
    }
    ctx.globalAlpha=Math.min(1,(lifetime-age)/.4);ctx.fillStyle='#bcb4a4';
    for(let i=0;i<(low?8:16);i++){const p=fragment(i,age,portrait);ctx.save();ctx.translate(p.x,p.y);ctx.rotate(age*(i%3+1)+i);ctx.fillRect(-p.size/2,-p.size/4,p.size,p.size/2);ctx.restore();}
    ctx.restore();
  }
  ctx.fillStyle='#d4f3ea';
  for(const bullet of state.bullets)ctx.fillRect(bullet.pos.x-1,bullet.pos.y-4,2,8);
}
function draw(time) {
  if (!loaded || (after && !assetsReady)) return;
  buildScene(time);
  const g=geometry();
  const start=performance.now();
  if(after)drawAfter(g,time);
  else {
    setForcedVisualTier(config.budget==='low' ? 'shaded' : 'mesh');
    setRenderMode({kind:'modern',vw:g.w,vh:g.h,dpr:g.dpr,scale:g.scale,tx:g.tx,ty:g.ty,insets:{top:0,right:0,bottom:0,left:0}});
    setHudHidden(true);
    if(config.scene==='detail') {
      // Existing mesh ship geometry is a fixed size: scale only its render
      // mesh for the close-up fixture, never a gameplay state or defaults.
      render(canvas,state,time);
      const handle = window.__overlay;
      if(handle?.shipMeshes[0])handle.shipMeshes[0].scale.setScalar(50/12);
      render(canvas,state,time);
    } else {
      const handle = window.__overlay;
      if(handle?.shipMeshes[0])handle.shipMeshes[0].scale.setScalar(1);
      render(canvas,state,time);
    }
    overlay.style.display=config.budget==='low' ? 'none' : 'block';
    setForcedVisualTier(null);
  }
  durations.push(performance.now()-start);
  if(durations.length>180)durations.shift();
  const labels=document.getElementById('labels');
  if(config.scene==='detail' && g.w>g.h) {
    labels.innerHTML=[['STONY',265],['DELTA',640],['PALLASITE',1015]].map(([name,x])=>`<span class="label" style="left:${x*g.scale+g.tx}px;top:${540*g.scale+g.ty}px">${name}</span>`).join('');
  }else labels.innerHTML='';
  if(performance.now()-lastReport>1000) {
    lastReport=performance.now(); const sorted=[...durations].sort((a,b)=>a-b);
    parent.postMessage({type:'stats',renderer:after?config.budget==='high'?previous?'Previous Ultra':'Ultra live 3D':'Baked 3D atlas':config.budget==='low'?'Current shaded':isWebGLOverlayReady()?'Current 3D':'Current fallback',ms:sorted[Math.floor(sorted.length/2)],kb,bgWidth},location.origin);
  }
}
window.addEventListener('message', event => {
  if(event.origin!==location.origin || event.source!==parent)return;
  if(event.data.type==='config') {
    const changed=config.scene!==event.data.scene || config.budget!==event.data.budget;
    config=event.data; if(changed) {durations=[]; if(after)void loadAssets().catch(reportError);}
  }
  if(event.data.type==='tick')draw(event.data.time);
});
function reportError(error) {parent.postMessage({type:'error',message:error.message},location.origin);}
try {
  if(after) {overlay.style.display='none';await loadAssets();}
  else {await preloadBackgroundReady(1);await ensureWebGLForCurrentStyle();const mod=await import('/src/webgl/overlay.ts');window.__overlay=mod.getReadyOverlay();}
  loaded=true; parent.postMessage({type:'ready'},location.origin);
} catch(error) {reportError(error);}
