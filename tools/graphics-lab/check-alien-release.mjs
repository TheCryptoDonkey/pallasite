/** Exact deployed bytes and actual live-browser pickup collection. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const base=process.env.TARGET??'https://pallasite.app',expected=process.argv[2];assert.ok(expected,'Pass deployed SHA');
const out=new URL('../record-out/graphics-refresh/',import.meta.url);await mkdir(out,{recursive:true});
const types=['cruiser','elite','tank','sniper','boss'],radii=[30,19,40,21,64],hp=[1,1,3,1,25];
const assets=(await readdir(new URL('../../dist/assets/',import.meta.url))).filter(n=>/\.(js|css)$/.test(n));
const files=['sw.js',...assets.map(n=>`assets/${n}`),...types.flatMap(type=>{
  const name=type==='cruiser'?'ufo':`ufo-${type}`;return [`graphics/level-one/${type==='cruiser'?'ufo-cinematic':name}.glb`,...['128','256'].map(n=>`graphics/level-one/${name}-${n}.webp`)];
})];
assert.equal((await(await fetch(`${base}/version.json`,{cache:'no-store'})).json()).build,expected.slice(0,7));
for(const path of files){
  const r=await fetch(`${base}/${path}`,{cache:'no-store',signal:AbortSignal.timeout(30000)});assert.equal(r.status,200,path);
  assert.doesNotMatch(r.headers.get('content-type')??'',/text\/html/);
  const hash=b=>createHash('sha256').update(b).digest('hex');
  assert.equal(hash(Buffer.from(await r.arrayBuffer())),hash(await readFile(new URL(`../../dist/${path}`,import.meta.url))),path);
}
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[],errors=[];
try {
  for(const mode of ['desktop','phone']) {
    const mobile=mode==='phone',page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
    page.on('pageerror',e=>errors.push({mode,error:e.message}));
    await page.addInitScript(()=>localStorage.setItem('pallasite:quality','high'));
    await page.goto(`${base}/?graphicsReview=1`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing');
    await page.evaluate(()=>{const s=window.__pallasiteState;s.cheatedThisRun=true;s.players[0].ship.alive=true;s.players[0].ship.invulnerableUntil=1e9;});
    const before=await page.evaluate(()=>({...window.__pallasiteState.players[0].ship.pos,fired:window.__pallasiteState.bulletsFiredThisWave}));
    await page.keyboard.down('ArrowUp');await page.keyboard.down('Space');await page.waitForTimeout(400);await page.keyboard.up('Space');await page.keyboard.up('ArrowUp');
    const flight=await page.evaluate(()=>({pos:{...window.__pallasiteState.players[0].ship.pos},fired:window.__pallasiteState.bulletsFiredThisWave}));
    assert.ok(Math.hypot(flight.pos.x-before.x,flight.pos.y-before.y)>1);assert.ok(flight.fired>before.fired);
    await page.getByRole('button',{name:'Try power-ups',exact:true}).click();
    const collection=await page.evaluate(()=>{
      const s=window.__pallasiteState,p=s.players[0],drop=s.powerups.find(d=>d.type==='rapid');
      p.ship.pos={x:640,y:540};p.ship.vel={x:0,y:0};p.thrustOverride=0;p.targetHeading=null;p.ship.thrusting=false;
      drop.pos={x:760,y:540};drop.vel={x:0,y:0};s.powerups=[drop];s.ufos=[];s.enemyBullets=[];s.bullets=[];s.hitStopSteps=0;s.nextUfoSpawn=1e9;
      s.asteroids=s.asteroids.slice(0,1);s.asteroids[0].pos={x:100,y:100};s.asteroids[0].vel={x:0,y:0};
      return p.runStats.powerupsCollected;
    });
    await page.waitForFunction(n=>window.__pallasiteState.players[0].runStats.powerupsCollected===n+1,collection,{timeout:15000});
    assert.ok(await page.evaluate(()=>window.__pallasiteState.players[0].rapidExpiresAt>window.__pallasiteState.elapsed));
    await page.evaluate(()=>window.__pallasiteState.nextUfoSpawn=0);await page.waitForFunction(()=>window.__pallasiteState.ufos.length>0);
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');
    await page.evaluate(({types,radii,hp})=>{
      const s=window.__pallasiteState,template=s.ufos[0];
      s.ufos=types.map((type,i)=>({...structuredClone(template),id:90000+i,type,radius:radii[i],hp:hp[i],alive:true,pos:{x:220+i*210,y:350},vel:{x:35,y:0},shootTimer:2000,lifetime:1e9,bossPhase:1,hitFlash:0}));
      s.players[0].ship.pos={x:640,y:540};s.players[0].ship.vel={x:0,y:0};s.enemyBullets=[];s.bullets=[];s.coins=[];s.particles=[];
    },{types,radii,hp});
    await page.addStyleTag({content:'#ui-root{visibility:hidden!important} #game,#game3d{filter:none!important;opacity:1!important}'});
    await page.waitForFunction(mobile=>document.querySelector('#graphics-review-status')?.textContent.startsWith(mobile?'Baked 3D':'Ultra · live 3D'),mobile,{timeout:60000});
    if(!mobile)await page.waitForFunction(()=>['ufo-elite','ufo-tank','ufo-sniper','ufo-boss'].every(n=>performance.getEntriesByType('resource').some(r=>r.name.includes(`${n}.glb?art=fleet-2`))));
    await page.waitForTimeout(1500);
    await page.screenshot({path:new URL(`alien-release-${mode}.png`,out).pathname});
    if(mobile)for(const [i,type] of types.entries()){
      await page.evaluate(x=>window.__pallasiteState.players[0].ship.pos.x=x,220+i*210);await page.waitForTimeout(450);
      await page.screenshot({path:new URL(`alien-release-phone-${type}.png`,out).pathname});
    }
    const scene=await page.evaluate(()=>({types:window.__pallasiteState.ufos.map(u=>u.type),status:document.querySelector('#graphics-review-status').textContent,width:document.documentElement.scrollWidth}));
    assert.deepEqual(scene.types,types);if(mobile)assert.equal(scene.width,390);
    rows.push({mode,flight,magneticCollection:true,scene});await page.close();
  }
  assert.deepEqual(errors,[]);const result={base,build:expected,verifiedAssets:files.length,rows,errors};
  await writeFile(new URL('alien-release-verification.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
