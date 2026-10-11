import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base='http://127.0.0.1:5180',out=new URL('../record-out/graphics-refresh/',import.meta.url);
await mkdir(out,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const results={errors:[],artRequests:[]};
try {
  if(process.argv.includes('--collectables')) {
    await browser.close();await import('./check-collectables.mjs');process.exit(0);
  }
  if(process.argv.includes('--dust')) {
    await (await import('./check-rock-dust.mjs')).runRockDust(browser,base,out);
    await browser.close();process.exit(0);
  }
  if(process.argv.includes('--arrival')) {
    await (await import('./check-warp-arrival.mjs')).runWarpArrival(browser,base,out);
    await browser.close();process.exit(0);
  }
  if(process.argv.includes('--harnesses')) {
    const verdicts=[];
    for(const name of ['forge','determinism','lockstep','peer','regression','rollback','wavestart']) {
      const p=await browser.newPage();await p.goto(`${base}/${name}-harness.html`);
      await p.waitForFunction(()=>/-(PASS|FAIL|ERROR)$/.test(document.title),{},{timeout:60000});
      const verdict=await p.title(),detail=await p.locator('#out').textContent();
      verdicts.push({name,verdict,detail});console.log(verdict);if(!verdict.endsWith('-PASS'))console.log(detail);
      await p.close();
    }
    await writeFile(new URL('drift-simulation-harnesses.json',out),JSON.stringify(verdicts,null,2));
    await browser.close();process.exit(verdicts.every(v=>v.verdict.endsWith('-PASS'))?0:1);
  }
  const page=await browser.newPage({viewport:{width:1440,height:900}}),urls={};
  page.on('pageerror',e=>results.errors.push(e.message));
  page.on('request',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/src/')&&!urls[u.pathname])urls[u.pathname]=r.url();
    if(/pickup-|\/backgrounds\/drift-/.test(u.pathname))results.artRequests.push(u.pathname+u.search);});
  await page.addInitScript(()=>{localStorage.setItem('pallasite:quality','high');localStorage.setItem('pallasite:difficulty','normal');});
  await page.goto(`${base}/?graphicsReview=1`);
  await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing'&&document.querySelector('#graphics-review-status')?.textContent.startsWith('Ultra · live 3D'),{},{timeout:45000});
  const modules=Object.fromEntries(['game','seed','mode','difficulty','types','render','visual-style','a11y','level-one-refresh','level-one-flight','ultra-warp','peer-canary'].map(n=>[n,urls[`/src/${n}.ts`]??`${base}/src/${n}.ts`]));
  await page.getByRole('button',{name:'Try power-ups',exact:true}).click();
  await page.waitForTimeout(300);
  results.rounded=await page.evaluate(async u=>(await import(u)).levelOneDiagnostics(),modules['level-one-refresh']);
  assert.equal(results.rounded.visiblePickups,6);
  assert.ok(results.artRequests.filter(u=>u.includes('pickup-')).every(u=>u.includes('art=rounded-2')),'all spherical assets have fresh URLs');
  await page.screenshot({path:new URL('rounded-powerups-current.png',out).pathname});

  // Use actual seeded wave construction, defenses, enemy timers and pickup collection.
  results.balance=await page.evaluate(async m=>{
    const g=await import(m.game),d=await import(m.difficulty),mode=await import(m.mode),seed=await import(m.seed),types=await import(m.types),canary=await import(m['peer-canary']);
    const saved=g.getSimModuleState(),rng=seed.getRngState(),id=g.getEntityIdCounter(),oldMode=mode.currentMode();
    const rows=[];
    try {
      for(const difficulty of ['easy','normal','hard'])for(const wave of [26,27,28,29,30,31,1000,1000000]){
        localStorage.setItem('pallasite:difficulty',difficulty);
        const s=g.makeInitialState();g.startGame(s,12345,{runMode:'drift'});g.beginWave(s,wave);
        const mods=d.currentMods(),p=s.players[0],rocks=s.asteroids.filter(a=>(a.depth??3)===3&&!a.isVein);
        const max=Math.max(...rocks.map(a=>Math.hypot(a.vel.x,a.vel.y)));
        const heart=s.powerups.find(p=>p.type==='extralife');
        const startDelay=s.nextUfoSpawn;
        const kicked=g.spawnAsteroid('small',wave,{x:100,y:100},{x:5000,y:1000},'stony');
        g.tryActivateShield(s,s.elapsed,p);const shield=p.ship.shieldReadyAt-s.elapsed-types.SHIELD_DURATION_MS;
        g.tryHyperspace(s,s.elapsed,p);const warp=p.ship.hyperspaceReadyAt-s.elapsed;
        if(heart){p.ship.pos={...heart.pos};p.ship.hyperspaceCloakMs=0;s.phase='playing';g.updateGame(s);}
        rows.push({difficulty,wave,count:rocks.length,max,maxAllowed:155*mods.asteroidSpeedMul,kicked:Math.hypot(kicked.vel.x,kicked.vel.y),kickAllowed:265*mods.asteroidSpeedMul,heart:!!heart,lives:p.lives,
          shield,expectedShield:types.SHIELD_COOLDOWN_MS*mods.shieldCooldownMul*.75,warp,expectedWarp:types.HYPERSPACE_COOLDOWN_MS*mods.hyperspaceCooldownMul*.75,startDelay});
      }
      // A real 30-second late-wave simulation must repeat from the same seed.
      const run=()=>{const s=g.makeInitialState();g.startGame(s,987654,{runMode:'drift'});g.beginWave(s,1000);s.phase='playing';s.players[0].ship.invulnerableUntil=1e9;
        for(let i=0;i<1800;i++)g.updateGame(s);return {hash:canary.hashState(s),rng:seed.getRngState(),ufoTypes:s.ufos.map(u=>u.type),delay:s.nextUfoSpawn};};
      const a=run(),b=run();return {rows,repeat:[a,b]};
    }finally{localStorage.setItem('pallasite:difficulty','normal');d.lockInDifficulty('normal');mode.lockInMode(oldMode);g.setSimModuleState(saved);seed.setRngState(rng);g.setEntityIdCounter(id);}
  },modules);
  for(const r of results.balance.rows){
    assert.ok(r.count>=8&&r.count<=11);assert.ok(r.max<=r.maxAllowed+1e-6);assert.ok(r.kicked<=r.kickAllowed+1e-6);
    assert.ok(Math.abs(r.shield-r.expectedShield)<1e-6);assert.ok(Math.abs(r.warp-r.expectedWarp)<1e-6);
    if((r.wave-26)%5===0){assert.equal(r.heart,r.difficulty!=='easy');assert.equal(r.lives,{easy:5,normal:4,hard:3}[r.difficulty]);}
    assert.ok(r.startDelay>5000);
  }
  assert.deepEqual(results.balance.repeat[0],results.balance.repeat[1],'late-wave gameplay remains deterministic');

  for(const wave of [26,28,30]){
    await page.getByLabel('Preview level').selectOption(String(wave));
    await page.waitForFunction(n=>window.__pallasiteState.wave===n,wave);
    await page.evaluate(async({m,wave})=>{const g=await import(m.game);g.skipWarp(window.__pallasiteState);window.__pallasiteState.phase='paused';await(await import(m.render)).preloadBackgroundReady(wave);},{m:modules,wave});
    await page.waitForTimeout(250);
    assert.deepEqual(await page.evaluate(()=>({wave:window.__pallasiteState.wave,phase:window.__pallasiteState.phase})),{wave,phase:'paused'});
    assert.ok((await page.evaluate(()=>document.body.style.backgroundImage)).includes('drift-'),'actual scene uses an endless background');
    await page.screenshot({path:new URL(`drift-${wave}.png`,out).pathname});
  }
  results.backgrounds=await page.evaluate(()=>document.body.style.backgroundImage);
  assert.ok(results.backgrounds.includes('drift-galaxy'));
  assert.ok(results.artRequests.some(u=>u.includes('drift-lagoon'))&&results.artRequests.some(u=>u.includes('drift-rings'))&&results.artRequests.some(u=>u.includes('drift-galaxy')));

  // Snapshot/RNG invariance across repeated renders of the actual warp scene.
  results.warp=await page.evaluate(async m=>{
    const seed=await import(m.seed),r=await import(m.render),w=await import(m['ultra-warp']);
    await w.preloadUltraWarpArt();await r.preloadBackgroundReady(28);
    const s=structuredClone(window.__pallasiteState);s.phase='warp';s.phaseStart=s.elapsed-2400;s.warpTargetWave=28;
    const before=JSON.stringify(s),rng=seed.getRngState();
    const c=document.createElement('canvas');c.width=1280;c.height=720;r.setHudHidden(true);
    for(let i=0;i<3;i++)r.render(c,s,performance.now()+i*100);
    r.setHudHidden(false);
    const data=c.toDataURL();return {same:JSON.stringify(s)===before,rngSame:rng===seed.getRngState(),diagnostics:w.ultraWarpDiagnostics(),data};
  },modules);
  assert.equal(results.warp.same,true);assert.equal(results.warp.rngSame,true);assert.equal(results.warp.diagnostics.rings,14);assert.equal(results.warp.diagnostics.backdrop,true);assert.ok(results.warp.diagnostics.flybys>0);
  await writeFile(new URL('ultra-warp-tunnel.png',out),Buffer.from(results.warp.data.split(',')[1],'base64'));delete results.warp.data;
  await page.emulateMedia({reducedMotion:'reduce'});
  results.reduced=await page.evaluate(async m=>{const s=structuredClone(window.__pallasiteState);s.phase='warp';s.phaseStart=s.elapsed-2400;s.warpTargetWave=28;const c=document.createElement('canvas');c.width=1280;c.height=720;
    (await import(m.render)).render(c,s,performance.now());return(await import(m['ultra-warp'])).ultraWarpDiagnostics();},modules);
  assert.equal(results.reduced.streaks,0);assert.equal(results.reduced.flybys,0);

  // Fail all new pickup art: an immediate rounded cell stays visible, never the old mesh.
  const fallback=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),fallbackUrls={};
  fallback.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/src/')&&!fallbackUrls[p])fallbackUrls[p]=r.url();});
  await fallback.route('**/graphics/level-one/pickup-*',r=>r.abort());
  await fallback.goto(`${base}/?graphicsReview=1`);await fallback.waitForFunction(()=>window.__pallasiteState?.phase==='playing');
  await fallback.getByRole('button',{name:'Try power-ups',exact:true}).click();
  await fallback.waitForTimeout(300);
  results.fallback=await fallback.evaluate(async u=>{
    const refresh=await import(u['/src/level-one-refresh.ts']),flight=await import(u['/src/level-one-flight.ts']),s=window.__pallasiteState;
    const c=document.createElement('canvas');c.width=1280;c.height=720;const ctx=c.getContext('2d');
    const shown=s.powerups.map(p=>flight.drawLevelOnePowerup(ctx,p));const pixels=ctx.getImageData(0,0,c.width,c.height).data;let visible=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])visible++;
    return {shown,visible,refreshed:s.powerups.map(p=>refresh.refreshedPowerup(p.type))};
  },fallbackUrls);
  assert.ok(results.fallback.shown.every(Boolean));assert.ok(results.fallback.refreshed.every(Boolean));assert.ok(results.fallback.visible>2000);
  await fallback.screenshot({path:new URL('rounded-powerups-no-assets-phone.png',out).pathname});
  await fallback.close();assert.deepEqual(results.errors,[]);
  await writeFile(new URL('drift-warp-verification.json',out),JSON.stringify(results,null,2));
  console.log(JSON.stringify({errors:results.errors,rounded:results.rounded.visiblePickups,balanceCases:results.balance.rows.length,deterministic:results.balance.repeat,backgrounds:results.backgrounds,warp:results.warp,reduced:results.reduced,fallback:results.fallback},null,2));
}finally{await browser.close();}
