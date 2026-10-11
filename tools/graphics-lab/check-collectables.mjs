import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const out=new URL('../record-out/graphics-refresh/',import.meta.url),results={},errors=[];
try {
  for(const mode of ['ultra','low','phone']) {
    const page=await browser.newPage({viewport:mode==='phone'?{width:390,height:844}:{width:1440,height:900},isMobile:mode==='phone',hasTouch:mode==='phone'}),modules={};
    page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/src/')&&!modules[p])modules[p]=r.url();});
    page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text()))errors.push(m.text());});
    await page.addInitScript(mode=>{localStorage.setItem('pallasite:quality',mode==='low'?'low':'high');localStorage.setItem('pallasite:difficulty','normal');},mode);
    await page.goto(`http://127.0.0.1:5180/?graphicsReview=1&collectableCheck=${mode}`);
    await page.waitForFunction(mode=>window.__pallasiteState?.phase==='playing'&&document.querySelector('#graphics-review-status')?.textContent.startsWith(mode==='ultra'?'Ultra · live 3D':'Baked 3D'),mode,{timeout:45000});
    await page.evaluate(()=>{const s=window.__pallasiteState;s.ufos=[];s.nextUfoSpawn=s.elapsed+60000;s.asteroids.forEach(a=>{a.pos={x:1100,y:80};a.vel={x:0,y:0};});s.players[0].ship.pos={x:200,y:360};s.players[0].ship.vel={x:0,y:0};s.players[0].ship.invulnerableUntil=s.elapsed+60000;});
    await page.getByRole('button',{name:'Try collectables',exact:true}).click();await page.waitForTimeout(300);
    assert.equal(await page.evaluate(()=>window.__pallasiteState.coins.length),6);
    const read=()=>page.evaluate(async urls=>{const s=window.__pallasiteState,m=await import(urls['/src/level-one-refresh.ts']);return {diagnostics:m.levelOneDiagnostics(),atlases:s.coins.map(c=>({kind:c.kind,width:m.levelOneCollectableAtlas(c.kind)?.width,live:m.levelOneCollectableLive(c)})),coins:JSON.stringify(s.coins),rng:s.rng};},modules);
    const initial=await read();
    assert.ok(initial.atlases.every(a=>a.width===(mode==='low'?256:512)));
    if(mode==='ultra'){assert.equal(initial.diagnostics.visibleCollectables,6);assert.deepEqual(initial.diagnostics.collectableMaterialBatches,[2,2]);assert.equal(initial.diagnostics.collectableInstances,6);}
    else assert.ok(initial.atlases.every(a=>!a.live));
    await page.screenshot({path:new URL(`collectables-${mode}.png`,out).pathname});
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');await page.waitForTimeout(80);
    const paused=await read();await page.waitForTimeout(350);const held=await read();assert.equal(held.coins,paused.coins);assert.equal(held.rng,paused.rng);
    if(mode==='ultra')assert.equal(held.diagnostics.collectableClock,paused.diagnostics.collectableClock);
    await page.getByRole('button',{name:'Show current',exact:true}).click();await page.waitForTimeout(150);assert.equal((await read()).coins,paused.coins);
    await page.screenshot({path:new URL(`collectables-${mode}-current.png`,out).pathname});
    await page.getByRole('button',{name:'Show refreshed',exact:true}).click();await page.getByRole('button',{name:'RESUME',exact:true}).click();
    const before=await page.evaluate(()=>({sats:window.__pallasiteState.players[0].sats,score:window.__pallasiteState.players[0].score,blocked:window.__pallasiteState.players[0].lurkSatsBlocked}));
    for(const kind of ['sat','dust']) {
      await page.evaluate(kind=>{const s=window.__pallasiteState;s.players[0].ship.pos={...s.coins.find(c=>c.kind===kind).pos};s.players[0].ship.vel={x:0,y:0};},kind);await page.waitForTimeout(80);
    }
    const after=await page.evaluate(()=>({count:window.__pallasiteState.coins.length,sats:window.__pallasiteState.players[0].sats,score:window.__pallasiteState.players[0].score,blocked:window.__pallasiteState.players[0].lurkSatsBlocked}));
    assert.equal(after.count,4);assert.equal(after.sats,before.sats,'unranked practice forfeits sat credit');assert.equal(after.blocked,before.blocked+1);assert.equal(after.score,before.score+10,'dust uses the real score pickup');
    // All twelve sources use their own colour/silhouette in both live and baked paths.
    const mineralEvidence=await page.evaluate(async urls=>{
      const types=await import(urls['/src/types.ts']),art=await import('/src/mineral-shards.ts'),seed=await import(urls['/src/seed.ts']);
      const s=window.__pallasiteState;s.phase='paused';
      s.coins=Object.keys(types.ASTEROID_TYPE_CONFIG).map((type,i)=>({kind:'dust',value:10,pos:{x:360+i%4*170,y:210+Math.floor(i/4)*150},vel:{x:0,y:0},radius:9,alive:true,collected:false,ttl:6000,sourceType:type}));
      const before=JSON.stringify(s),rng=seed.getRngState(),sheet=document.createElement('canvas');sheet.width=720;sheet.height=420;const ctx=sheet.getContext('2d');
      ctx.fillStyle='#09101b';ctx.fillRect(0,0,720,420);
      const signatures=s.coins.map((c,i)=>{const plate=art.mineralShardPlate(c.sourceType,0);ctx.drawImage(plate,180*(i%4)+58,140*Math.floor(i/4)+35,64,64);
        ctx.fillStyle='#edf5ff';ctx.font='14px sans-serif';ctx.fillText(c.sourceType,180*(i%4)+15,140*Math.floor(i/4)+123);return plate.toDataURL();});
      return {signatures,unchanged:before===JSON.stringify(s)&&rng===seed.getRngState(),sheet:sheet.toDataURL()};
    },modules);
    assert.equal(new Set(mineralEvidence.signatures).size,12,'each mineral has a distinct baked result');assert.equal(mineralEvidence.unchanged,true);
    if(mode==='ultra')await writeFile(new URL('collectable-mineral-shards.png',out),Buffer.from(mineralEvidence.sheet.split(',')[1],'base64'));
    await page.waitForTimeout(300);const minerals=await read();
    if(mode==='ultra'){assert.equal(minerals.diagnostics.visibleCollectables,12);assert.equal(minerals.diagnostics.collectableShardTypes.length,12);assert.deepEqual(minerals.diagnostics.collectableMaterialBatches,[2,2]);}
    await page.screenshot({path:new URL(`collectable-minerals-${mode}.png`,out).pathname});
    results[`${mode}Minerals`]={distinctBaked:12,unchanged:mineralEvidence.unchanged,diagnostics:minerals.diagnostics};
    await page.evaluate(()=>window.__pallasiteState.phase='playing');
    if(mode==='ultra') {
      await page.evaluate(()=>{const s=window.__pallasiteState;s.coins=Array.from({length:300},(_,i)=>({kind:'dust',value:1,pos:{x:350+i%20*22,y:180+Math.floor(i/20)*22},vel:{x:0,y:0},radius:9,alive:true,collected:false,ttl:6000,sourceType:'stony'}));s.players[0].ship.pos={x:100,y:100};s.players[0].ship.invulnerableUntil=0;});await page.waitForTimeout(100);
      const stress=await read();assert.equal(stress.diagnostics.collectableInstances,256);assert.equal(stress.atlases.filter(a=>!a.live).length,44,'overflow retains baked visibility');
      await page.evaluate(()=>{const s=window.__pallasiteState;s.coins=s.coins.slice(0,6);});await page.waitForTimeout(100);
      assert.equal(stress.diagnostics.calls,(await read()).diagnostics.calls,'300 dust pickups retain the same material draw count as six');results.stress=stress.diagnostics;
    }
    results[mode]={initial,after};await page.close();
  }
  assert.deepEqual(errors,[]);results.errors=errors;await writeFile(new URL('collectables-verification.json',out),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
} finally {await browser.close();}
