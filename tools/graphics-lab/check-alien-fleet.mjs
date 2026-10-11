import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
const base=process.env.PALLASITE_REVIEW_URL??'http://127.0.0.1:5181';
const out=new URL('../record-out/graphics-refresh/',import.meta.url);await mkdir(out,{recursive:true});
const rows=[],errors=[],types=['cruiser','elite','tank','sniper','boss'];
const modes=process.argv.find(a=>a.startsWith('--modes='))?.slice(8).split(',')??['ultra','low','phone','missing','no-webgl'];
for(const mode of modes) {
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try {
    const mobile=mode==='phone',page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
    const urls={};page.on('request',r=>{const u=new URL(r.url());if(u.pathname.startsWith('/src/')&&!urls[u.pathname])urls[u.pathname]=r.url();});
    page.on('pageerror',e=>errors.push({mode,error:e.message}));
    await page.addInitScript(mode=>{
      localStorage.setItem('pallasite:quality',mode==='low'?'low':'high');localStorage.setItem('pallasite:difficulty','normal');
      if(mode==='no-webgl'){const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){return /webgl/i.test(t)?null:get.call(this,t,...a);};}
    },mode);
    if(mode==='missing')await page.route('**/graphics/level-one/ufo-*',r=>r.abort());
    await page.goto(`${base}/?graphicsReview=1`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing');
    const modules=Object.fromEntries(['game','render','seed','level-one-refresh','visual-style','alien-art','types','a11y'].map(n=>[n,urls[`/src/${n}.ts`]]));
    assert.ok(Object.values(modules).every(Boolean),'use active source module graph');
    await page.evaluate(()=>{const s=window.__pallasiteState;s.cheatedThisRun=true;s.players[0].ship.alive=true;s.players[0].ship.invulnerableUntil=1e9;});
    await page.keyboard.down('ArrowUp');await page.keyboard.down('Space');await page.waitForTimeout(250);await page.keyboard.up('Space');await page.keyboard.up('ArrowUp');
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');
    const setup=await page.evaluate(async ({m,types})=>{
      const s=window.__pallasiteState,g=await import(m.game),t=await import(m.types);
      s.phase='playing';s.hitStopSteps=0;s.nextUfoSpawn=0;g.updateGame(s);s.phase='paused';
      const template=s.ufos[0];if(!template)throw Error('real UFO spawn required');
      s.ufos=types.map((type,i)=>({...structuredClone(template),id:50000+i,type,pos:{x:220+i*210,y:350},vel:{x:35,y:0},radius:t.UFO_RADIUS[type],hp:t.UFO_HP[type],hitFlash:0,bossPhase:1,shootTimer:2000,lifetime:1e9}));
      s.players[0].ship.pos={x:640,y:540};s.players[0].ship.vel={x:0,y:0};s.players[0].ship.alive=true;
      s.bullets=[];s.enemyBullets=[];s.coins=[];s.particles=[];s.powerups=[];
      s.asteroids=s.asteroids.slice(0,1);s.asteroids[0].pos={x:120,y:100};s.asteroids[0].vel={x:0,y:0};
      return {radius:s.ufos.map(u=>u.radius),template:structuredClone(s.ufos[0])};
    },{m:modules,types});
    await page.addStyleTag({content:'#ui-root,#graphics-review-toolbar{visibility:hidden!important} #game,#game3d{filter:none!important;opacity:1!important}'});
    if(mode==='ultra')await page.waitForFunction(async m=>{const d=(await import(m['level-one-refresh'])).levelOneDiagnostics();return d?.ufoTypes.length===5;},modules,{timeout:60000});
    else await page.waitForTimeout(1000);
    const inspect=()=>page.evaluate(async m=>{const r=await import(m['level-one-refresh']),a=await import(m['alien-art']);return {phase:window.__pallasiteState.phase,rocks:window.__pallasiteState.asteroids.length,live:r.levelOneLive(),d:r.levelOneDiagnostics(),art:a.alienArtDiagnostics(),claimed:window.__pallasiteState.ufos.map(u=>r.refreshedUfo(u))};},modules);
    await page.waitForTimeout(750);await page.screenshot({path:new URL(`alien-fleet-${mode}.png`,out).pathname});
    const first=await inspect();assert.deepEqual(first.claimed,[true,true,true,true,true]);
    if(mode==='ultra'){assert.equal(first.d.alienArtRevision,'fleet-2');assert.equal(first.d.visibleUfos,5);assert.equal(first.d.ufoThrustMeshes,10);}
    if(mode==='missing')assert.equal(first.art.fallbacks,5);
    await page.screenshot({path:new URL(`alien-fleet-${mode}.png`,out).pathname});
    if(mobile)for(const [i,type] of types.entries()) {
      await page.evaluate(x=>window.__pallasiteState.players[0].ship.pos.x=x,220+i*210);await page.waitForTimeout(450);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
      await page.screenshot({path:new URL(`alien-fleet-phone-${type}.png`,out).pathname});
    }
    const paused=await page.evaluate(()=>JSON.stringify(window.__pallasiteState.ufos));await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>JSON.stringify(window.__pallasiteState.ufos)),paused,'pause keeps fleet simulation still');
    await page.evaluate(async m=>(await import(m.a11y)).setReducedMotionPref('on'),modules);await page.waitForTimeout(150);
    await page.screenshot({path:new URL(`alien-fleet-${mode}-reduced.png`,out).pathname});
    await page.evaluate(async m=>(await import(m.a11y)).setReducedMotionPref('off'),modules);
    const checks=await page.evaluate(async m=>{
      const s=window.__pallasiteState,g=await import(m.game),r=await import(m.render),seed=await import(m.seed),a=await import(m['alien-art']);
      const before=JSON.stringify(s),rng=seed.getRngState(),c=document.createElement('canvas');c.width=1280;c.height=720;
      for(let i=0;i<5;i++)r.render(c,s,s.elapsed+i*200);
      const invariant=JSON.stringify(s)===before&&seed.getRngState()===rng;
      for(let i=0;i<1000;i++)a.alienFallback(['cruiser','elite','tank','sniper','boss'][i%5]);
      // Actual shooting against every class, using its real HP and collision radius.
      const kills=[];s.phase='playing';s.nextUfoSpawn=1e9;
      for(const u of [...s.ufos]) {
        s.ufos=[u];u.pos={x:640,y:320};u.vel={x:0,y:0};u.shootTimer=1e9;
        const p=s.players[0];p.ship.pos={x:640,y:320+u.radius+p.ship.radius+7};p.ship.vel={x:0,y:0};p.ship.rot=-Math.PI/2;
        let shots=0;while(u.alive&&shots++<40){s.hitStopSteps=0;p.fireCooldownUntil=0;g.fireBullet(s,p);g.updateGame(s);}
        kills.push({type:u.type,dead:!u.alive,shots});
      }
      // A 120px fly-by pulls a real spherical drop in without pilot input.
      s.phase='playing';s.hitStopSteps=0;s.powerups=[{type:'rapid',pos:{x:760,y:540},vel:{x:0,y:0},radius:14,alive:true,collected:false,ttl:14000}];
      const sphere=s.powerups[0],p=s.players[0];p.ship.pos={x:640,y:540};p.ship.vel={x:0,y:0};
      for(let i=0;i<100;i++){s.hitStopSteps=0;g.updateGame(s);}
      s.phase='paused';return {invariant,kills,pulled:sphere.collected,art:a.alienArtDiagnostics()};
    },modules);
    assert.equal(checks.invariant,true);assert.ok(checks.kills.every(k=>k.dead),JSON.stringify(checks.kills));assert.ok(checks.pulled);assert.equal(checks.art.fallbacks,5);
    if(mode==='ultra'){
      await page.evaluate(u=>{const s=window.__pallasiteState;s.ufos=Array.from({length:24},(_,i)=>({...structuredClone(u),id:70000+i,alive:true,pos:{x:220+i%6*160,y:150+Math.floor(i/6)*130}}));},setup.template);
      await page.waitForTimeout(500);const overflow=await inspect();assert.equal(overflow.d.visibleUfos,16);assert.equal(overflow.claimed.length,24);
      await page.screenshot({path:new URL('alien-fleet-overflow.png',out).pathname});
      await page.evaluate(async m=>(await import(m['visual-style'])).setAllVisualStyles('vector'),modules);await page.waitForTimeout(150);
      assert.equal((await inspect()).live,false,'saved Classic remains available');
      await page.evaluate(async m=>(await import(m['visual-style'])).setAllVisualStyles('mesh'),modules);await page.waitForTimeout(150);
      assert.equal((await inspect()).live,true,'Ultra can be restored');
    }
    rows.push({mode,setup,first,checks});await page.close();
  }finally{await browser.close();}
}
assert.deepEqual(errors,[]);const result={base,rows,errors};await writeFile(new URL('alien-fleet-verification.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify({base,modes:rows.map(r=>r.mode),kills:rows[0].checks.kills,magneticCollection:rows.every(r=>r.checks.pulled),errors},null,2));
