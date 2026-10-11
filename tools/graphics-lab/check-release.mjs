/** Verify the deployed commit, every shipped Ultra asset, and real gameplay. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const base=process.env.TARGET??'https://pallasite.app';
const expected=process.argv[2];assert.ok(expected,'Pass the deployed commit SHA');
const out=new URL('../record-out/graphics-refresh/',import.meta.url);await mkdir(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
async function network(path) {
  const response=await fetch(new URL(path,base),{cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200,`${path} HTTP status`);return response;
}
const version=await(await network('/version.json')).json();assert.equal(version.build,expected.slice(0,7));
const files=(await readdir(new URL('../../public/graphics/level-one/',import.meta.url))).map(f=>`graphics/level-one/${f}`);
files.push('backgrounds/drift-lagoon.webp','backgrounds/drift-rings.webp','backgrounds/drift-galaxy.webp','backgrounds/warp-tunnel-ultra.webp','signet-login.iife.js','sw.js');
const verified=[];
for(let start=0;start<files.length;start+=8)await Promise.all(files.slice(start,start+8).map(async path=>{
  const local=await readFile(new URL(`../../public/${path}`,import.meta.url)),response=await network(`/${path}`),remote=Buffer.from(await response.arrayBuffer());
  assert.equal(hash(remote),hash(local),`${path} deployed bytes`);
  verified.push({path,bytes:remote.length,sha256:hash(remote)});
}));
const html=await(await network('/?menu=1')).text();const bundle=html.match(/src="(\/assets\/index-[^"]+\.js)"/);assert.ok(bundle,'deployed entry bundle');
const main=await network(bundle[1]);assert.match(main.headers.get('content-type')??'',/javascript/);const js=await main.text();assert.ok(js.includes(expected.slice(0,7)),'bundle has the deployed build identity');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const errors=[],scenes=[];
try {
  const page=await browser.newPage({viewport:{width:1440,height:900},serviceWorkers:'block'});
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error'&&/THREE|shader|WebGL/i.test(m.text()))errors.push(m.text());});
  await page.addInitScript(()=>{localStorage.setItem('pallasite:quality','high');localStorage.setItem('pallasite:difficulty','normal');});
  await page.goto(`${base}/?graphicsReview=1`,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing'&&document.querySelector('#graphics-review-status')?.textContent.startsWith('Ultra · live 3D'),{},{timeout:60000});
  await page.getByRole('button',{name:'Try power-ups',exact:true}).click();await page.getByRole('button',{name:'Try collectables',exact:true}).click();
  await page.waitForTimeout(350);
  const pickupCount=await page.evaluate(()=>window.__pallasiteState.powerups.length);assert.equal(pickupCount,6);
  await page.screenshot({path:new URL('release-ultra-pickups.png',out).pathname});
  await page.evaluate(()=>{window.__pallasiteState.players[0].ship.invulnerableUntil=1e9;});
  const before=await page.evaluate(()=>({...window.__pallasiteState.players[0].ship.pos}));
  await page.keyboard.down('ArrowUp');await page.keyboard.down('Space');await page.waitForTimeout(300);await page.keyboard.up('ArrowUp');await page.keyboard.up('Space');
  const flight=await page.evaluate(()=>({pos:window.__pallasiteState.players[0].ship.pos,fired:window.__pallasiteState.bulletsFiredThisWave}));
  assert.ok(Math.hypot(flight.pos.x-before.x,flight.pos.y-before.y)>5);assert.ok(flight.fired>0);
  for(const wave of [26,28,30]) {
    await page.getByLabel('Preview level').selectOption(String(wave));
    await page.waitForFunction(w=>window.__pallasiteState.wave===w&&window.__pallasiteState.phase==='playing',wave,{timeout:30000});
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');await page.waitForTimeout(100);
    const scene=await page.evaluate(()=>({wave:window.__pallasiteState.wave,background:document.body.style.backgroundImage,rocks:window.__pallasiteState.asteroids.filter(a=>(a.depth??3)===3&&!a.isVein).length}));
    assert.ok(scene.background.includes('drift-'));assert.ok(scene.rocks>=8&&scene.rocks<=11);scenes.push(scene);
    await page.screenshot({path:new URL(`release-drift-${wave}.png`,out).pathname});
  }
  const phone=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true,serviceWorkers:'block'});
  phone.on('pageerror',e=>errors.push(e.message));await phone.goto(`${base}/?graphicsReview=1`);
  await phone.waitForFunction(()=>window.__pallasiteState?.phase==='playing'&&document.querySelector('#graphics-review-status')?.textContent.startsWith('Baked 3D'),{},{timeout:60000});
  await phone.getByRole('button',{name:'Try collectables',exact:true}).click();await phone.waitForTimeout(150);
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth),390);
  await phone.screenshot({path:new URL('release-phone-shards.png',out).pathname});
  assert.deepEqual(errors,[]);
  const result={base,version,verified:verified.sort((a,b)=>a.path.localeCompare(b.path)),entry:bundle[1],pickupCount,flight,scenes,phone:true,errors};
  await writeFile(new URL('release-verification.json',out),JSON.stringify(result,null,2));
  console.log(JSON.stringify({...result,verifiedAssets:verified.length,verified:undefined},null,2));
}finally{await browser.close();}
