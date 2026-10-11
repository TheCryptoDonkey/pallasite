import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const out=new URL('../record-out/graphics-refresh/',import.meta.url),results={};
try {
const page=await browser.newPage({viewport:{width:1440,height:900}}),modules={},errors=[];
page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/src/')&&!modules[p])modules[p]=r.url();});
page.on('pageerror',e=>errors.push(e.message));
await page.addInitScript(()=>localStorage.setItem('pallasite:quality','high'));
await page.goto('http://127.0.0.1:5180/?graphicsReview=1');
await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing'&&document.querySelector('#graphics-review-status')?.textContent.startsWith('Ultra · live 3D'),{},{timeout:45000});
await page.evaluate(()=>{const s=window.__pallasiteState;s.nextUfoSpawn=0;s.players[0].ship.invulnerableUntil=s.elapsed+60000;});
await page.waitForFunction(()=>window.__pallasiteState.ufos.length>0);
await page.evaluate(()=>{const s=window.__pallasiteState,u=s.ufos[0];u.pos={x:800,y:350};u.vel.y=50;u.zigTimer=60000;u.shootTimer=60000;});
await page.waitForTimeout(400);
const first=await page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),modules['/src/level-one-refresh.ts']);
assert.ok(Number.isFinite(first.ufos[0].rotorAngle),'upper rotor exists');
await page.evaluate(()=>{window.__pallasiteState.ufos[0].vel.y=-50;});
await page.waitForTimeout(600);
results.bank=await page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),modules['/src/level-one-refresh.ts']);
assert.ok(results.bank.ufos[0].pitch<-Math.PI/2,'steep course-change bank exposes underside');
assert.ok(results.bank.ufos[0].rotorAngle>first.ufos[0].rotorAngle,'upper section spins independently');
assert.ok(results.bank.ufos[0].shadowCasters>=10);
assert.equal(results.bank.ufoThrustMeshes,2);assert.ok(results.bank.ufos[0].undersideGlow.every(g=>g.z<-.3),'glow stays below the hull');assert.ok(results.bank.ufoLight>0);
await page.screenshot({path:new URL('ufo-underside-bank.png',out).pathname});
await page.keyboard.press('Escape');
await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');
await page.waitForTimeout(50);
const frozen=await page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),modules['/src/level-one-refresh.ts']);
await page.waitForTimeout(200);
const frozenAfter=await page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),modules['/src/level-one-refresh.ts']);
assert.deepEqual(frozenAfter.ufos,frozen.ufos,'bank and rotor freeze on pause');
await page.keyboard.press('Escape');
await page.waitForFunction(()=>window.__pallasiteState.phase==='playing');
await page.getByRole('button',{name:'Try power-ups',exact:true}).click();
await page.waitForTimeout(120);
results.pickups=await page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),modules['/src/level-one-refresh.ts']);
assert.equal(results.pickups.visiblePickups,6);assert.ok(results.pickups.pickupMaterialBatches.every(n=>n<=5));
await page.screenshot({path:new URL('sculpted-powerups.png',out).pathname});
// Exercise the actual practice crash control and verify the added cosmetic
// burst coexists with four authoritative hull-debris bodies.
await page.getByRole('button',{name:'Try ship crash',exact:true}).click();
await page.waitForFunction(()=>!window.__pallasiteState.players[0].ship.alive);
await page.waitForTimeout(350);
results.crash=await page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),modules['/src/level-one-refresh.ts']);
assert.equal(results.crash.deathBursts,1);assert.equal(results.crash.shrapnelInstances,12);
assert.equal(await page.evaluate(()=>window.__pallasiteState.debris.length),4);
await page.screenshot({path:new URL('reactor-player-crash.png',out).pathname});
// Isolated real renderer, fixed asteroid orientation, identical light and UFO
// pose. Crop a receiver region outside the visible UFO silhouette to measure
// its cast shadow separately from asteroid self-shadowing.
const shadow=await page.evaluate(async url=>{
const {createLevelOneRenderer}=await import(url);const r=await createLevelOneRenderer();
const s=structuredClone(window.__pallasiteState);s.elapsed=3000;s.powerups=[];s.debris=[];s.players[0].ship.alive=false;
s.asteroids=s.asteroids.slice(0,1);const a=s.asteroids[0];a.pos={x:640,y:360};a.radius=70;a.rot=0;a.alive=true;
const u=s.ufos[0];u.pos={x:612,y:328};u.radius=18;u.hitFlash=0;u.vel.y=0;s.ufos=[u];
const m=new DOMMatrix();r.render(s,1280,720,m,[0],[0],true,0,false);
const withUfo=r.canvas.toDataURL();s.ufos=[];r.render(s,1280,720,m,[0],[0],true,0,false);
const withoutUfo=r.canvas.toDataURL();r.dispose();return {withUfo,withoutUfo};
},modules['/src/webgl/level-one.ts']);
for(const [name,data] of Object.entries(shadow))await writeFile(new URL(`shadow-${name}.png`,out),Buffer.from(data.split(',')[1],'base64'));
const region={left:635,top:328,width:35,height:45};
const on=await sharp(Buffer.from(shadow.withUfo.split(',')[1],'base64')).extract(region).removeAlpha().raw().toBuffer();
const off=await sharp(Buffer.from(shadow.withoutUfo.split(',')[1],'base64')).extract(region).removeAlpha().raw().toBuffer();
let darker=0,delta=0;for(let i=0;i<on.length;i+=3){const d=off[i]+off[i+1]+off[i+2]-on[i]-on[i+1]-on[i+2];if(d>30)darker++;delta+=Math.max(0,d);}
results.shadow={darkerPixels:darker,brightnessDelta:delta};assert.ok(darker>35,'UFO casts a visible shadow on the asteroid outside its silhouette');
assert.deepEqual(errors,[]);results.errors=errors;
await writeFile(new URL('refinements-verification.json',out),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await browser.close();}
