import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import sharp from 'sharp';
const out=new URL('../record-out/graphics-refresh/',import.meta.url);await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results={waves:[],errors:[]},base='http://127.0.0.1:5180';
async function trackedPage(options={}){
  const page=await browser.newPage({viewport:{width:1440,height:900},...options}),urls={};
  page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/src/')&&!urls[p])urls[p]=r.url();});
  page.on('pageerror',e=>results.errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text())){
    if(page.expectedContextFailure&&m.text()==='THREE.WebGLRenderer: Error creating WebGL context.'){
      results.expectedUnavailableWebGL=(results.expectedUnavailableWebGL??0)+1;
    }else results.errors.push(m.text());
  }});
  page.urls=urls;return page;
}
const moduleUrl=(page,name)=>page.urls[`/src/${name}.ts`]??`${base}/src/${name}.ts`;
async function diag(page){return page.evaluate(async url=>(await import(url)).levelOneDiagnostics(),moduleUrl(page,'level-one-refresh'));}
async function waitDiag(page,predicate,timeout=20000){
  const until=Date.now()+timeout;let value;
  while(Date.now()<until){value=await diag(page);if(predicate(value))return value;await page.waitForTimeout(100);}
  throw new Error(`Ultra renderer did not reach fixture: ${JSON.stringify(value)}`);
}
async function wave(page,n,paused=true){
  await page.evaluate(async({url,n,paused})=>{const s=window.__pallasiteState,g=await import(url);g.beginWave(s,n);s.cheatedThisRun=true;s.phase=paused?'paused':'playing';s.players.forEach(p=>{p.ship.invulnerableUntil=s.elapsed+120000;p.ship.vel={x:0,y:0};});s.nextUfoSpawn=s.elapsed+120000;}, {url:moduleUrl(page,'game'),n,paused});
}
try {
  // Enter through the normal shipping menu, without the review query.
  const page=await trackedPage();await page.addInitScript(()=>{localStorage.setItem('pallasite:quality','high');localStorage.setItem('pallasite:difficulty','normal');});
  await page.goto(`${base}/?menu=1`);await page.waitForFunction(()=>window.__pallasiteState);
  await page.evaluate(()=>{window.__pallasiteState.session={pubkey:'0'.repeat(64),displayName:'LOCAL QA',method:'guest',signer:{capabilities:{canSignEvents:false}}};});
  await page.getByRole('button',{name:/^PLAY/}).click();await page.getByRole('button',{name:'CAMPAIGN',exact:true}).click();await page.getByRole('button',{name:/IGNITE/}).click();
  await page.getByText('Skip intro',{exact:true}).click();
  await page.waitForFunction(()=>window.__pallasiteState.phase==='playing'||window.__pallasiteState.phase==='wavestart');
  assert.equal(await page.locator('#graphics-review').count(),0);
  await wave(page,1);await waitDiag(page,d=>d?.visibleShips>0,45000);
  results.normalMenuUltra=true;
  for(let n=1;n<=25;n++){
    await wave(page,n);
    await waitDiag(page,d=>d&&d.wave===n&&d.visibleShips>0);
    await page.waitForTimeout(320);
    const d=await diag(page);assert.ok(d.rockCopies<=d.rockCapacity);assert.ok(d.width*d.height<=2560*1440+5000);
    const counts=await page.evaluate(()=>{const s=window.__pallasiteState;return {wave:s.wave,types:[...new Set(s.asteroids.filter(a=>a.alive).map(a=>a.stationPart??a.type))],mines:s.mines.length};});
    assert.equal(d.wave,n);assert.ok(d.rockTypes.every(type=>counts.types.includes(type)),`level ${n} has no previous-level meshes`);
    if(counts.types.includes('core')){
      const prefix=n===25?'forge':'station';
      await waitDiag(page,d=>d?.wave===n&&d.stationAssets.includes(`${prefix}-core`)&&d.stationAssets.includes(`${prefix}-emitter`)&&d.rockTypes.includes('core'));
    }
    results.waves.push({...counts,renderer:d});
    if([1,5,10,16,17,20,25].includes(n))await page.screenshot({path:new URL(`campaign-ultra-${n}.png`,out).pathname});
  }
  // Same real state before/after: changing the look cannot alter RNG or bodies.
  const stateBefore=await page.evaluate(()=>JSON.stringify({rng:window.__pallasiteState.rng,rocks:window.__pallasiteState.asteroids,players:window.__pallasiteState.players}));
  await page.evaluate(async url=>(await import(url)).setLevelOneLook(false),moduleUrl(page,'level-one-refresh'));await page.waitForTimeout(120);const before=await page.locator('#game').screenshot();
  await page.screenshot({path:new URL('campaign-forge-before.png',out).pathname});
  await page.evaluate(async url=>(await import(url)).setLevelOneLook(true),moduleUrl(page,'level-one-refresh'));await page.waitForTimeout(120);const after=await page.locator('#game').screenshot();
  assert.equal(await page.evaluate(()=>JSON.stringify({rng:window.__pallasiteState.rng,rocks:window.__pallasiteState.asteroids,players:window.__pallasiteState.players})),stateBefore);
  const a=await sharp(before).removeAlpha().raw().toBuffer(),b=await sharp(after).removeAlpha().raw().toBuffer();let changed=0;
  for(let i=0;i<a.length;i+=3)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>30)changed++;
  assert.ok(changed>10000);results.forgeComparisonPixels=changed;
  // Two pilots, two independently fading shields, colour identity and a large
  // camera offset. No slot disappears when the camera leaves the 1280px world.
  await page.evaluate(async({url,refresh})=>{const s=window.__pallasiteState,g=await import(url);g.startGame(s,0x123456,{players:2,runMode:'campaign',defender:false});g.beginWave(s,17);s.phase='paused';s.players.forEach((p,i)=>{p.ship.pos={x:420+i*300,y:580};p.ship.invulnerableUntil=0;p.ship.shieldUp=true;p.ship.shieldExpiresAt=s.elapsed+(i?100:1000);p.ship.shieldHitFlash=i?.5:0;});(await import(refresh)).prepareLevelOne(s);},{url:moduleUrl(page,'game'),refresh:moduleUrl(page,'level-one-refresh')});
  await page.waitForTimeout(350);results.multiplayer=await diag(page);assert.equal(results.multiplayer.visibleShips,2);assert.equal(results.multiplayer.visibleShields,2);
  await page.screenshot({path:new URL('campaign-two-pilots.png',out).pathname});
  // All twelve minerals and all five alien classes, not just the wave-one
  // cruiser. Retain actual entities' radii and presentation budgets.
  await wave(page,1);await page.evaluate(()=>{const s=window.__pallasiteState,base=s.asteroids[0],types=['stony','iron','chondrite','pallasite','carbonaceous','mesosiderite','achondrite','kinetic','volatile','ballast','tektite','lodestone'];
    s.asteroids=types.map((type,i)=>({...structuredClone(base),id:900+i,type,radius:43,pos:{x:140+(i%6)*195,y:220+Math.floor(i/6)*250},vel:{x:0,y:0},depth:3}));s.players[1].ship.alive=false;s.players[0].ship.pos={x:640,y:640};});
  await waitDiag(page,d=>d?.rockTypes.length===12);
  results.minerals=await diag(page);await page.screenshot({path:new URL('campaign-minerals-ultra.png',out).pathname});
  await page.evaluate(async({url})=>{const s=window.__pallasiteState,g=await import(url);g.beginWave(s,25);s.phase='playing';s.ufos=[];s.nextUfoSpawn=0;}, {url:moduleUrl(page,'game')});
  // Forge has no ambient UFO spawn; use a real earlier-level spawn first.
  await wave(page,12,false);await page.evaluate(()=>{window.__pallasiteState.nextUfoSpawn=0;});
  await page.waitForFunction(()=>window.__pallasiteState.ufos.length>0,{},{timeout:10000});
  await page.evaluate(async()=>{const {UFO_RADIUS}=await import('/src/types.ts');const s=window.__pallasiteState,u=s.ufos[0];s.phase='paused';s.asteroids=[];s.mines=[];s.ufos=['cruiser','elite','tank','sniper','boss'].map((type,i)=>({...structuredClone(u),id:1000+i,type,radius:UFO_RADIUS[type],pos:{x:180+i*220,y:330},hitFlash:0}));});
  results.aliens=await waitDiag(page,d=>d?.visibleUfos===5);assert.equal(results.aliens.ufoThrustMeshes,10);await page.screenshot({path:new URL('campaign-alien-fleet.png',out).pathname});
  // Dense scene remains bounded. Bodies outside the live-mesh budget retain
  // baked graphics, and the renderer reads state without changing gameplay.
  await wave(page,1);await page.evaluate(()=>{const s=window.__pallasiteState,a=s.asteroids[0];s.asteroids=Array.from({length:120},(_,i)=>({...structuredClone(a),id:2000+i,radius:14,pos:{x:70+i%15*78,y:170+Math.floor(i/15)*53},vel:{x:0,y:0}}));});
  await page.waitForTimeout(200);results.dense=await diag(page);assert.equal(results.dense.visibleRocks,48);assert.equal(results.dense.rockCopies,48);
  await page.screenshot({path:new URL('campaign-dense-ultra.png',out).pathname});
  // Budget switches retain mineral identity and all the scene bodies.
  const state=await page.evaluate(()=>JSON.stringify({asteroids:window.__pallasiteState.asteroids,rng:window.__pallasiteState.rng}));
  results.budgets={};for(const tier of ['balanced','low','high']){
    await page.evaluate(async({url,tier})=>(await import(url)).setQualityPreference(tier),{url:moduleUrl(page,'visual-style'),tier});await page.waitForTimeout(200);
    const d=await diag(page);assert.equal(await page.evaluate(()=>JSON.stringify({asteroids:window.__pallasiteState.asteroids,rng:window.__pallasiteState.rng})),state);results.budgets[tier]=d?{live:true,width:d.width,height:d.height}:{live:false};
    await page.screenshot({path:new URL(`campaign-dense-${tier}.png`,out).pathname});
  }
  // Classic remains selectable and does not submit Ultra frames.
  await page.evaluate(async url=>(await import(url)).setAllVisualStyles('vector'),moduleUrl(page,'visual-style'));await page.waitForTimeout(100);assert.equal(await diag(page),null);results.classicSelectable=true;
  await page.close();
  for(const mode of ['phone','no-webgl','failed-model','failed-later-model']){
    const p=await trackedPage(mode==='phone'?{viewport:{width:390,height:844},hasTouch:true,isMobile:true,deviceScaleFactor:2}:{});
    p.expectedContextFailure=mode==='no-webgl';
    await p.addInitScript(mode=>{localStorage.setItem('pallasite:quality','high');if(mode==='no-webgl'){const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type.startsWith('webgl')?null:get.call(this,type,...args);};}},mode);
    if(mode==='failed-model')await p.route('**/graphics/level-one/*.glb',r=>r.abort());
    if(mode==='failed-later-model'){await p.route('**/graphics/level-one/station-*.glb',r=>r.abort());await p.route('**/graphics/level-one/forge-*.glb',r=>r.abort());}
    await p.goto(`${base}/?graphicsReview=1`);await p.waitForFunction(()=>window.__pallasiteState?.phase==='playing');await wave(p,25,false);
    await p.waitForTimeout(600);
    const d=await diag(p),status=await p.locator('#graphics-review-status').textContent();
    assert.ok(await p.evaluate(()=>window.__pallasiteState.asteroids.some(a=>a.alive&&a.stationPart==='core')));
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth),mode==='phone'?390:1440);
    if(mode!=='failed-later-model')assert.equal(d,null);else if(d)assert.ok(!d.rockTypes.includes('core'));
    results[mode]={status,live:!!d};await p.screenshot({path:new URL(`campaign-forge-${mode}.png`,out).pathname});await p.close();
  }
  assert.deepEqual(results.errors,[]);await writeFile(new URL('campaign-verification.json',out),JSON.stringify(results,null,2));
  console.log(JSON.stringify({waves:results.waves.map(w=>({wave:w.wave,types:w.types,calls:w.renderer.calls,mines:w.renderer.visibleMines})),normalMenuUltra:results.normalMenuUltra,forgeComparisonPixels:changed,multiplayerShips:results.multiplayer.visibleShips,minerals:results.minerals.rockTypes,aliens:results.aliens.visibleUfos,dense:results.dense.rockCopies,budgets:results.budgets,fallbacks:['phone','no-webgl','failed-model','failed-later-model'].map(m=>({mode:m,...results[m]})),errors:results.errors},null,2));
} finally {await browser.close();}
