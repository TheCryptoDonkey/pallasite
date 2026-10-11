import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import sharp from 'sharp';

const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const out=new URL('../record-out/graphics-refresh/',import.meta.url),results={},errors=[];
try {
  results.palette={};
  for(const tile of [128,256]) {
    const {data,info}=await sharp(new URL(`../../public/graphics/level-one/death-atlas-${tile}.webp`,import.meta.url).pathname).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(info.width,tile*6);assert.equal(info.height,tile*4);
    let orange=0,red=0,blue=0;
    for(let i=0;i<data.length;i+=4){const [r,g,b,a]=data.subarray(i,i+4);if(a<40)continue;
      if(r>90&&r>g*1.15&&g>b*1.2)orange++;
      if(r>90&&r>g*1.7&&r>b*1.4)red++;
      if(b>90&&b>r*1.4&&b>g*1.1)blue++;
    }
    assert.ok(orange>300&&red>300&&blue>100,'compressed explosion retains orange, red and blue');
    results.palette[tile]={orange,red,blue};
  }
  for(const mode of ['ultra','low','reduced']) {
    const page=await browser.newPage({viewport:{width:1440,height:900}}),modules={};
    page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/src/')&&!modules[p])modules[p]=r.url();});
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(mode=>{
      localStorage.setItem('pallasite:quality',mode==='low'?'low':'high');
      localStorage.setItem('pallasite:difficulty','normal');
      localStorage.setItem('pallasite:a11y',JSON.stringify({reducedMotion:mode==='reduced'?'on':'off',palette:'default'}));
    },mode);
    await page.goto(`http://127.0.0.1:5180/?graphicsReview=1&deathCheck=${mode}`);
    await page.waitForFunction(mode=>window.__pallasiteState?.phase==='playing'&&document.querySelector('#graphics-review-status')?.textContent.startsWith(mode==='low'?'Baked 3D':'Ultra · live 3D'),mode,{timeout:45000});
    const positionImpact=()=>{
      const s=window.__pallasiteState;s.asteroids=s.asteroids.slice(0,2);s.ufos=[];s.nextUfoSpawn=s.elapsed+60000;
      s.asteroids.forEach((a,i)=>{a.pos={x:640+i*190,y:360};a.vel={x:0,y:0};});
      s.players[0].ship.pos={x:400,y:350};s.players[0].ship.vel={x:0,y:0};s.players[0].ship.invulnerableUntil=s.elapsed+60000;
    };
    await page.evaluate(positionImpact);await page.waitForTimeout(220);
    await page.getByRole('button',{name:'Try ship crash',exact:true}).click();
    await page.waitForFunction(()=>!window.__pallasiteState.players[0].ship.alive);
    await page.waitForTimeout(180);
    const normal=await page.evaluate(async urls=>{
      const s=window.__pallasiteState,d=await import(urls['/src/level-one-death.ts']);
      return {burst:d.livePlayerBursts(s)[0],tagged:s.particles.filter(d.isPlayerBurstParticle).length,
        debris:s.debris.length,renderer:(await import(urls['/src/level-one-refresh.ts'])).levelOneDiagnostics()};
    },modules);
    assert.equal(normal.burst.final,false);assert.ok(normal.tagged>0);assert.equal(normal.debris,4);
    if(mode!=='low')assert.equal(normal.renderer.shrapnelInstances,mode==='reduced'?0:12);
    await page.screenshot({path:new URL(`crash-refined-${mode}.png`,out).pathname});
    await page.getByRole('button',{name:'Restart level 1',exact:true}).click();
    await page.waitForFunction(()=>window.__pallasiteState.phase==='playing');
    await page.evaluate(positionImpact);await page.waitForTimeout(250);
    await page.getByRole('button',{name:'Try final death',exact:true}).click();
    await page.waitForFunction(()=>window.__pallasiteState.phase==='deathreplay');
    assert.equal(await page.evaluate(async url=>(await import(url)).livePlayerBursts(window.__pallasiteState).length,modules['/src/level-one-death.ts']),1,'live final explosion is visible before rewind');
    await page.waitForTimeout(180);
    assert.ok(await page.evaluate(()=>window.__pallasiteState.deathReplay.liveImpactUntil>window.__pallasiteState.elapsed));
    await page.screenshot({path:new URL(`final-death-${mode}-live.png`,out).pathname});
    await page.waitForFunction(()=>window.__pallasiteState.deathReplay.liveImpactUntil===undefined);
    assert.equal(await page.evaluate(async url=>(await import(url)).livePlayerBursts(window.__pallasiteState).length,modules['/src/level-one-death.ts']),0,'no live crash ghosts in replay prelude');
    await page.waitForFunction(()=>window.__pallasiteState.deathReplay.explosionSpawned,{},{timeout:20000});
    await page.waitForTimeout(250);
    const final=await page.evaluate(async urls=>{
      const s=window.__pallasiteState;return {burst:(await import(urls['/src/level-one-death.ts'])).livePlayerBursts(s)[0],
        phase:s.phase,renderer:(await import(urls['/src/level-one-refresh.ts'])).levelOneDiagnostics()};
    },modules);
    assert.equal(final.burst.final,true);
    if(mode!=='low'){assert.equal(final.renderer.finalDeathBursts,1);assert.equal(final.renderer.shrapnelInstances,mode==='reduced'?0:24);}
    await page.screenshot({path:new URL(`final-death-${mode}-rupture.png`,out).pathname});
    await page.waitForTimeout(1500);
    const aftermath=await page.evaluate(async url=>({phase:window.__pallasiteState.phase,bursts:(await import(url)).livePlayerBursts(window.__pallasiteState).length}),modules['/src/level-one-death.ts']);
    assert.equal(aftermath.phase,'deathreplay');assert.equal(aftermath.bursts,1,'final aftermath outlasts an ordinary crash');
    await page.screenshot({path:new URL(`final-death-${mode}-aftermath.png`,out).pathname});
    await page.waitForFunction(()=>window.__pallasiteState.phase==='gameover',{},{timeout:8000});
    const hold=await page.evaluate(time=>window.__pallasiteState.elapsed-time,final.burst.time);
    assert.ok(hold>=2900&&hold<3250,'three-second aftermath also fits a short practice replay');
    assert.equal(await page.evaluate(async url=>(await import(url)).livePlayerBursts(window.__pallasiteState).length,modules['/src/level-one-death.ts']),0);
    if(mode==='ultra') {
      await page.evaluate(async url=>(await import(url)).startDeathReplay(window.__pallasiteState),modules['/src/game.ts']);
      assert.equal(await page.evaluate(async url=>(await import(url)).livePlayerBursts(window.__pallasiteState).length,modules['/src/level-one-death.ts']),0);
      await page.waitForFunction(()=>window.__pallasiteState.deathReplay.explosionSpawned,{},{timeout:20000});
      assert.equal(await page.evaluate(async url=>(await import(url)).livePlayerBursts(window.__pallasiteState).filter(b=>b.final).length,modules['/src/level-one-death.ts']),1,'replaying rearms exactly one final burst');
    }
    results[mode]={normal,final,aftermath};await page.close();
  }
  assert.deepEqual(errors,[]);results.errors=errors;
  await writeFile(new URL('death-verification.json',out),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
