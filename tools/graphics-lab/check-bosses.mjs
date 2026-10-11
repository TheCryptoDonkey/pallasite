import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:5180',out=new URL('../record-out/graphics-refresh/',import.meta.url);
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const result={errors:[],levels:[]};
const urls={};
async function diagnostics(page){return page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),urls['/src/level-one-refresh.ts']);}
async function waitScene(page,test){const until=Date.now()+30000;while(Date.now()<until){const d=await diagnostics(page);if(test(d))return d;await page.waitForTimeout(100);}throw new Error('Scene failed to settle');}
async function wave(page,n,paused=true){await page.evaluate(async({url,n,paused})=>{const s=window.__pallasiteState;(await import(url)).beginWave(s,n);s.phase=paused?'paused':'playing';s.nextUfoSpawn=s.elapsed+120000;s.players.forEach(p=>{p.ship.invulnerableUntil=0;p.ship.shieldUp=false;p.ship.vel={x:0,y:0};});},{url:urls['/src/game.ts'],n,paused});}
try {
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  page.on('request',r=>{const path=new URL(r.url()).pathname;if(path.startsWith('/src/')&&!urls[path])urls[path]=r.url();});
  page.on('pageerror',e=>result.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text()))result.errors.push(m.text());});
  await page.addInitScript(()=>{localStorage.setItem('pallasite:quality','high');localStorage.setItem('pallasite:difficulty','normal');});
  await page.goto(`${base}/?graphicsReview=1`);await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing');
  await waitScene(page,d=>d?.visibleRocks>0);
  for(const n of [17,25,20,14]) {
    await wave(page,n);
    const prefix=n===25?'forge':'station';
    const d=await waitScene(page,d=>d?.wave===n&&d.visibleShips>0&&(n===17||n===25?d.stationAssets.includes(`${prefix}-core`)&&d.stationAssets.includes(`${prefix}-emitter`):d.visibleMines>0));
    const bodies=await page.evaluate(()=>{const s=window.__pallasiteState;return {mines:s.mines.map(m=>({radius:m.radius,range:m.gravityRange})),parts:s.asteroids.filter(a=>a.stationPart).map(a=>({part:a.stationPart,rot:a.rot,slot:a.stationSlot}))};});
    if(n===20)assert.ok(bodies.mines.every(m=>m.radius===20&&m.range===150));
    if(n===14){assert.ok(bodies.mines.some(m=>m.radius===18));assert.ok(bodies.mines.some(m=>m.radius===11));}
    assert.ok(bodies.parts.filter(a=>a.part!=='core').every(a=>a.rot===a.slot));
    result.levels.push({wave:n,bodies,renderer:d});
    await page.screenshot({path:new URL(`boss-detail-${n}-ultra.png`,out).pathname});
    const before=await page.evaluate(()=>JSON.stringify({rocks:window.__pallasiteState.asteroids,mines:window.__pallasiteState.mines,rng:window.__pallasiteState.rng}));
    await page.evaluate(async url=>(await import(url)).setQualityPreference('low'),urls['/src/visual-style.ts']);await page.waitForTimeout(250);
    assert.equal(await diagnostics(page),null);
    assert.equal(await page.evaluate(()=>JSON.stringify({rocks:window.__pallasiteState.asteroids,mines:window.__pallasiteState.mines,rng:window.__pallasiteState.rng})),before);
    await page.screenshot({path:new URL(`boss-detail-${n}-low.png`,out).pathname});
    await page.evaluate(async url=>(await import(url)).setQualityPreference('high'),urls['/src/visual-style.ts']);await waitScene(page,d=>d?.wave===n);
  }
  // Actual final boss transition creates larger nodes with the same escapable pull.
  await wave(page,25,false);await page.evaluate(()=>{const s=window.__pallasiteState;s.players[0].ship.invulnerableUntil=s.elapsed+120000;const core=s.asteroids.find(a=>a.stationPart==='core');core.hp=Math.floor(core.hpMax*.3);});
  await page.waitForFunction(()=>window.__pallasiteState.forgeMeltdown);
  await page.evaluate(()=>{window.__pallasiteState.phase='paused';});
  result.meltdown=await page.evaluate(()=>window.__pallasiteState.mines.map(m=>({radius:m.radius,range:m.gravityRange,strength:m.gravityStrength})));
  assert.equal(result.meltdown.length,5);assert.ok(result.meltdown.every(m=>m.radius===22&&m.range===240&&m.strength===155));
  await waitScene(page,d=>d?.visibleMines===5);await page.screenshot({path:new URL('boss-detail-25-meltdown.png',out).pathname});
  // Larger real alien bodies, shared rotor/underglow and bounded draw budgets.
  await wave(page,12,false);await page.evaluate(()=>{const s=window.__pallasiteState;s.players[0].ship.invulnerableUntil=s.elapsed+120000;s.nextUfoSpawn=0;});
  await page.waitForFunction(()=>window.__pallasiteState.ufos.length>0);
  await page.evaluate(async()=>{const {UFO_RADIUS}=await import('/src/types.ts');const s=window.__pallasiteState,u=s.ufos[0];s.phase='paused';s.asteroids=[];s.mines=[];s.players[0].ship.pos={x:640,y:600};s.ufos=['cruiser','elite','tank','sniper','boss'].map((type,i)=>({...structuredClone(u),type,radius:UFO_RADIUS[type],id:1000+i,pos:{x:170+i*220,y:300},hitFlash:0}));});
  const fleet=await waitScene(page,d=>d?.visibleUfos===5);result.aliens=await page.evaluate(()=>window.__pallasiteState.ufos.map(u=>({type:u.type,radius:u.radius})));
  assert.deepEqual(result.aliens.map(u=>u.radius),[30,19,40,21,64]);assert.deepEqual(fleet.ufos.map(u=>u.scale).sort((a,b)=>a-b),[19,21,30,40,64]);assert.equal(fleet.ufoThrustMeshes,10);
  await page.screenshot({path:new URL('boss-detail-alien-fleet.png',out).pathname});
  // The well cue is a real visible raster, remains frozen when paused and
  // outlines the actual influence radius rather than an invented larger field.
  result.field=await page.evaluate(async url=>{const {drawUltraGravityField}=await import(url),canvas=document.createElement('canvas');canvas.width=canvas.height=400;const c=canvas.getContext('2d');const m={pos:{x:200,y:200},radius:20,gravityRange:150,age:3200};drawUltraGravityField(c,m);const a=c.getImageData(0,0,400,400).data;let lit=0,boundary=0;for(let y=0;y<400;y++)for(let x=0;x<400;x++){if(a[(y*400+x)*4+3]>0){lit++;if(Math.abs(Math.hypot(x-200,y-200)-150)<2)boundary++;}}const first=canvas.toDataURL();c.clearRect(0,0,400,400);drawUltraGravityField(c,m);return {lit,boundary,frozen:first===canvas.toDataURL()};},urls['/src/level-one-refresh.ts']);
  assert.ok(result.field.lit>1000&&result.field.boundary>100);assert.ok(result.field.frozen);
  // Farther approaches must keep the pilot and rig together on a narrow screen.
  await page.setViewportSize({width:390,height:844});
  for(const n of [17,25]) {
    await wave(page,n);
    await page.waitForTimeout(500);
    await page.screenshot({path:new URL(`boss-approach-${n}-portrait.png`,out).pathname});
  }
  assert.deepEqual(result.errors,[]);await writeFile(new URL('boss-detail-verification.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify({levels:result.levels.map(l=>({wave:l.wave,calls:l.renderer.calls,mines:l.bodies.mines})),aliens:result.aliens,meltdown:result.meltdown,field:result.field,errors:result.errors},null,2));
}finally{await browser.close();}
