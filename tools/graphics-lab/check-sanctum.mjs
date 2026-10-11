import {chromium,webkit} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';

const base=process.env.PALLASITE_REVIEW_URL??'http://127.0.0.1:5181';
const out=new URL('../record-out/graphics-refresh/',import.meta.url);
await mkdir(out,{recursive:true});
const rows=[],errors=[];
const modes=process.argv.find(a=>a.startsWith('--modes='))?.slice(8).split(',')??['ultra','low','phone','short','no-webgl','missing','late-portrait','webkit','mode-picker'];
for(const mode of modes) {
  const browser=await (mode==='webkit'?webkit:chromium).launch(mode==='webkit'?{headless:true}:{headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const mobile=mode==='phone'||mode==='webkit',page=await browser.newPage({viewport:mobile?{width:390,height:844}:mode==='short'?{width:844,height:390}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
    const urls={};page.on('request',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/src/')&&!urls[u.pathname])urls[u.pathname]=r.url();});
    page.on('pageerror',e=>errors.push({mode,error:e.message}));
    page.on('console',m=>{if(m.type()==='error'&&/shader|THREE.*Error/i.test(m.text())&&!(mode==='no-webgl'&&/creating WebGL context/i.test(m.text())))errors.push({mode,error:m.text()});});
    await page.addInitScript(mode=>{localStorage.setItem('pallasite:quality',mode==='low'?'low':'high');localStorage.setItem('pallasite:difficulty','normal');
      if(mode==='mode-picker')localStorage.setItem('pallasite:mode','sanctum');
      if(mode==='no-webgl'){const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){return /webgl/i.test(t)?null:get.call(this,t,...a);};}
    },mode);
    if(mode==='missing')await page.route('**/600bn/img/**',r=>r.abort());
    let releasePortraits;
    const portraitGate=new Promise(resolve=>{releasePortraits=resolve;});
    if(mode==='late-portrait')await page.route('**/600bn/img/**',async r=>{await portraitGate;await r.continue();});
    if(mode==='no-webgl')await page.route('**/*.glb*',r=>r.abort());
    await page.goto(`${base}/?flavour=${mode==='mode-picker'?'main&graphicsReview=1':'600bn'}${mobile?'&forceMobile=1':''}`,{waitUntil:'domcontentloaded'});
    if(mode!=='mode-picker'){
      await page.getByRole('button',{name:'ENTER ▶',exact:true}).waitFor();
      if(mode!=='late-portrait')await page.screenshot({path:new URL(`sanctum-${mode}-title.png`,out).pathname});
      await page.getByRole('button',{name:'ENTER ▶',exact:true}).click();
    }
    await page.waitForFunction(()=>window.__pallasiteState&&window.__pallasiteState.phase!=='title');
    await page.evaluate(()=>{window.__pallasiteState.cheatedThisRun=true;window.__pallasiteState.players[0].ship.invulnerableUntil=1e9;});
    await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing',null,{timeout:45000});
    const moduleUrl=n=>urls[`/src/${n}.ts`]??`${base}/src/${n}.ts`;
    const modules=Object.fromEntries(['game','render','seed','sanctum-avatars','sanctum-art','level-one-refresh','level-one-flight','visual-style','a11y'].map(n=>[n,moduleUrl(n)]));
    if(mode==='ultra'||mode==='short'||mode==='late-portrait'||mode==='missing'||mode==='mode-picker') {
      await page.waitForFunction(async u=>(await import(u)).levelOneLive(),modules['level-one-refresh'],{timeout:60000});
    }
    if(mode==='late-portrait') {
      await page.waitForFunction(async u=>(await import(u)).levelOneDiagnostics()?.councilRelics.length>0,modules['level-one-refresh']);
      assert.equal(await page.evaluate(async u=>(await import(u)).sanctumArtDiagnostics().portraits,modules['sanctum-art']),0);
      // Held image requests keep document load/font readiness pending. Capture
      // the real composed game canvas without waiting for that intentional gate.
      const loading=await page.evaluate(()=>document.querySelector('#game').toDataURL());
      await writeFile(new URL('sanctum-late-portrait-loading.png',out),Buffer.from(loading.split(',')[1],'base64'));
      releasePortraits();
      await page.waitForFunction(async u=>(await import(u)).sanctumArtDiagnostics().portraits>0,modules['sanctum-art']);
      await page.screenshot({path:new URL('sanctum-late-portrait-arrived.png',out).pathname});
    }
    // Real movement and shooting before a controlled unranked encounter.
    const before=await page.evaluate(()=>({...window.__pallasiteState.players[0].ship.pos,fired:window.__pallasiteState.bulletsFiredThisWave}));
    await page.keyboard.down('ArrowUp');await page.keyboard.down('Space');await page.waitForTimeout(350);await page.keyboard.up('Space');await page.keyboard.up('ArrowUp');
    const flight=await page.evaluate(()=>({pos:window.__pallasiteState.players[0].ship.pos,bullets:window.__pallasiteState.bullets.length,fired:window.__pallasiteState.bulletsFiredThisWave}));
    assert.ok(Math.hypot(flight.pos.x-before.x,flight.pos.y-before.y)>1,'real thrust moves the ship');
    assert.ok(flight.fired>before.fired,'real fire launches bullets');
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');
    await page.addStyleTag({content:'#ui-root{visibility:hidden!important} #game,#game3d{filter:none!important;opacity:1!important}'});
    const fixture=await page.evaluate(async m=>{
      const s=window.__pallasiteState,g=await import(m.game),a=await import(m['sanctum-avatars']);await a.loadCouncil();
      s.asteroids=a.getCouncil().map((member,i)=>g.spawnAsteroid('large',1,{x:260+(i%4)*250,y:165+Math.floor(i/4)*160},{x:0,y:0},member.asteroidType,{councilMember:{name:member.name,role:member.role,archetype:member.archetype,img:member.img,pubkey:member.pubkey,asteroidType:member.asteroidType}}));
      s.players[0].ship.pos={x:640,y:610};s.players[0].ship.vel={x:0,y:0};s.particles=[];s.bullets=[];
      // Spawn through the game, preserving real UFO construction/timing fields.
      s.nextUfoSpawn=0;s.phase='playing';g.updateGame(s);s.phase='paused';
      s.ufos=s.ufos.slice(0,1);if(s.ufos[0]){s.ufos[0].pos={x:1125,y:505};s.ufos[0].vel={x:0,y:0};}
      s.coins=Array.from({length:6},(_,i)=>({pos:{x:420+i*65,y:590},vel:{x:0,y:0},radius:7,alive:true,collected:false,ttl:6500,value:i%2?2:0,kind:i%2?'sat':'dust',sourceType:'iron'}));
      return {roster:a.getCouncil().map(a=>a.name),ufo:s.ufos.length};
    },modules);
    await page.waitForTimeout(450);
    const inspect=()=>page.evaluate(async m=>{const r=await import(m['level-one-refresh']),a=await import(m['sanctum-art']);return {live:r.levelOneLive(),diagnostics:r.levelOneDiagnostics(),art:a.sanctumArtDiagnostics(),background:document.body.style.backgroundImage};},modules);
    const first=await inspect();
    assert.ok(first.background.includes('sanctum-space'),'Sanctum backdrop survives Ultra override');
    if(mode==='ultra'){
      assert.equal(first.diagnostics.councilRelics.length,11);assert.equal(first.diagnostics.signalRelics,1);assert.equal(first.diagnostics.visibleCollectables,6);
      assert.deepEqual(first.diagnostics.collectableShardTypes,[],'themed dust retains Bitcoin identity');
    }
    assert.equal(first.art.portraits,mode==='missing'?0:11);
    await page.screenshot({path:new URL(`sanctum-${mode}.png`,out).pathname});
    const invariant=await page.evaluate(async m=>{
      const s=window.__pallasiteState,r=await import(m.render),seed=await import(m.seed),a=await import(m['sanctum-art']);
      const roster=(await import(m['sanctum-avatars'])).getCouncil();
      const before=JSON.stringify(s),rng=seed.getRngState();
      const c=document.createElement('canvas');c.width=1280;c.height=720;
      for(let i=0;i<8;i++)r.render(c,s,10000+i*120);
      // Exercise every plate frame/material without allocating by entity or time.
      for(let i=0;i<1000;i++){a.relicPlate(roster[i%11],i);a.relicPlate(null,i);a.relicPlate(null,i,true);}
      const old=JSON.parse(before);return {state:JSON.stringify(s)===before,changed:Object.keys(s).filter(k=>JSON.stringify(s[k])!==JSON.stringify(old[k])),rng:seed.getRngState()===rng,art:a.sanctumArtDiagnostics()};
    },modules);
    assert.equal(invariant.state,true,JSON.stringify(invariant));assert.equal(invariant.rng,true);assert.ok(invariant.art.plates<=invariant.art.maxPlates);
    let overflow;
    if(mode==='ultra') {
      await page.evaluate(()=>{const s=window.__pallasiteState;window.__sanctumSaved={asteroids:s.asteroids,coins:s.coins};
        s.asteroids=Array.from({length:72},(_,i)=>({...structuredClone(s.asteroids[i%11]),id:200000+i,radius:18,pos:{x:140+i%12*85,y:120+Math.floor(i/12)*80}}));
        s.coins=Array.from({length:300},(_,i)=>({...structuredClone(s.coins[i%6]),pos:{x:150+i%30*30,y:130+Math.floor(i/30)*45}}));
      });await page.waitForTimeout(200);
      overflow=await inspect();assert.equal(overflow.diagnostics.visibleRocks,48);assert.equal(overflow.diagnostics.visibleCollectables,256);
      assert.equal(await page.evaluate(async m=>{const r=await import(m['level-one-refresh']);return window.__pallasiteState.asteroids.filter(a=>r.refreshedRock(a)).length;},modules),72,'overflow members retain the plate path');
      await page.screenshot({path:new URL('sanctum-overflow.png',out).pathname});
      await page.evaluate(()=>{Object.assign(window.__pallasiteState,window.__sanctumSaved);delete window.__sanctumSaved;});
      await page.evaluate(async m=>(await import(m['visual-style'])).setAllVisualStyles('vector'),modules);await page.waitForTimeout(100);
      assert.equal(await page.evaluate(async m=>(await import(m['level-one-refresh'])).levelOneActive(),modules),false);
      await page.evaluate(async m=>(await import(m['visual-style'])).setAllVisualStyles('mesh'),modules);await page.waitForTimeout(150);
      assert.equal((await inspect()).live,true);
    }
    const paused=await page.evaluate(()=>JSON.stringify({rocks:window.__pallasiteState.asteroids,coins:window.__pallasiteState.coins}));await page.waitForTimeout(200);assert.equal(await page.evaluate(()=>JSON.stringify({rocks:window.__pallasiteState.asteroids,coins:window.__pallasiteState.coins})),paused);
    await page.evaluate(async m=>(await import(m.a11y)).setReducedMotionPref('on'),modules);await page.waitForTimeout(150);
    await page.screenshot({path:new URL(`sanctum-${mode}-reduced.png`,out).pathname});
    // A real fatal asteroid hit must preserve themed children and collectible rewards.
    const combat=await page.evaluate(async m=>{
      const s=window.__pallasiteState,g=await import(m.game),a=s.asteroids[0];a.hp=1;
      const name=a.councilMember.name,score=s.players[0].score;
      // Council sculptures shrink on successive real bullet contacts; identity survives.
      for(let i=0;i<3;i++){
        s.hitStopSteps=0;g.fireBullet(s,s.players[0]);s.bullets=[s.bullets.at(-1)];s.bullets[0].pos={...a.pos};s.bullets[0].vel={x:0,y:0};
        s.phase='playing';g.updateGame(s);s.phase='paused';
        if(i<2)assertIdentity(a,name);
      }
      function assertIdentity(a,name){if(a.councilMember.name!==name)throw new Error('shrink lost council identity');}
      const destroyed=!a.alive;
      const drops=s.coins.filter(c=>c.alive&&!c.collected);s.players[0].ship.pos={...drops.at(-1).pos};s.players[0].ship.hyperspaceCloakMs=0;s.hitStopSteps=0;
      s.phase='playing';g.updateGame(s);s.phase='paused';
      return {destroyed,score:s.players[0].score-score,collected:drops.filter(c=>c.collected||!c.alive).length};
    },modules);
    assert.ok(combat.destroyed);assert.ok(combat.score>0);assert.ok(combat.collected>0);
    rows.push({mode,fixture,flight,first,invariant,overflow,combat});console.log(`${mode}: passed`);
    await page.close();
  }finally{await browser.close();}
}
assert.deepEqual(errors,[]);
await writeFile(new URL('sanctum-verification.json',out),JSON.stringify({base,rows,errors},null,2));
