/** Exact-build acceptance on the actual Sanctum host, without source-module imports. */
import {chromium} from 'playwright';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const base=process.env.TARGET??'https://600b.pallasite.app',expected=process.argv[2];
assert.ok(expected,'Pass the deployed commit SHA');
const out=new URL('../record-out/graphics-refresh/',import.meta.url);await mkdir(out,{recursive:true});
const digest=b=>createHash('sha256').update(b).digest('hex');
const members=JSON.parse(await readFile(new URL('../../public/600bn/council.json',import.meta.url),'utf8')).members;
async function verify(path,local) {
  const response=await fetch(new URL(path,base),{cache:'no-store',signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200,path);assert.doesNotMatch(response.headers.get('content-type')??'',/text\/html/);
  assert.equal(digest(Buffer.from(await response.arrayBuffer())),digest(await readFile(local)),`${path} exact bytes`);
}
assert.equal((await(await fetch(`${base}/version.json`,{cache:'no-store'})).json()).build,expected.slice(0,7));
const assets=(await readdir(new URL('../../dist/assets/',import.meta.url))).filter(p=>/\.(js|css)$/.test(p));
for(const name of assets)await verify(`/assets/${name}`,new URL(`../../dist/assets/${name}`,import.meta.url));
for(const path of ['backgrounds/sanctum-space.webp','600bn/council.json','sw.js',...members.map(m=>m.img.slice(1))])await verify(`/${path}`,new URL(`../../public/${path}`,import.meta.url));
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}),rows=[],errors=[];
try {
  for(const mode of ['desktop','phone']) {
    const mobile=mode==='phone',page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1440,height:900},isMobile:mobile,hasTouch:mobile,serviceWorkers:'block'});
    page.on('pageerror',e=>errors.push({mode,error:e.message}));
    await page.addInitScript(()=>{localStorage.setItem('pallasite:quality','high');localStorage.setItem('pallasite:difficulty','normal');});
    await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'ENTER ▶',exact:true}).waitFor();
    assert.equal(await page.getByRole('img',{name:'600 billion · The Signal',exact:true}).count(),1);
    await page.screenshot({path:new URL(`sanctum-release-${mode}-title.png`,out).pathname});
    await page.goto(`${base}/?graphicsReview=1`,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(mobile=>window.__pallasiteState?.phase==='playing'&&document.querySelector('#graphics-review-status')?.textContent.startsWith(mobile?'Baked 3D':'Ultra · live 3D'),mobile,{timeout:60000});
    await page.evaluate(()=>{const s=window.__pallasiteState;s.cheatedThisRun=true;s.players[0].ship.invulnerableUntil=1e9;});
    const before=await page.evaluate(()=>({...window.__pallasiteState.players[0].ship.pos,fired:window.__pallasiteState.bulletsFiredThisWave}));
    await page.keyboard.down('ArrowUp');await page.keyboard.down('Space');await page.waitForTimeout(400);await page.keyboard.up('Space');await page.keyboard.up('ArrowUp');
    const flight=await page.evaluate(()=>({pos:window.__pallasiteState.players[0].ship.pos,fired:window.__pallasiteState.bulletsFiredThisWave}));
    assert.ok(Math.hypot(flight.pos.x-before.x,flight.pos.y-before.y)>1);assert.ok(flight.fired>before.fired);
    await page.getByRole('button',{name:'Try collectables',exact:true}).click();
    await page.evaluate(()=>window.__pallasiteState.nextUfoSpawn=0);await page.waitForFunction(()=>window.__pallasiteState.ufos.length>0);
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');
    await page.addStyleTag({content:'#ui-root{visibility:hidden!important} #game,#game3d{filter:none!important;opacity:1!important}'});
    await page.evaluate(members=>{
      const s=window.__pallasiteState,template=s.asteroids.find(a=>(a.depth??3)===3);
      s.asteroids=members.map((member,i)=>{
        const type=member.asteroidType;
        return {...structuredClone(template),id:100000+i,alive:true,pos:{x:140+i%6*195,y:105+Math.floor(i/6)*100},vel:{x:0,y:0},rot:i*2.399963,rotVel:1.2+i%6*.2,depth:3,type,size:'large',radius:38,hp:3,hpMax:3,hitFlash:0,councilMember:{...member,asteroidType:type}};
      });
      s.bullets=[];s.players[0].ship.pos={x:640,y:610};s.players[0].ship.vel={x:0,y:0};s.ufos=s.ufos.slice(0,1);s.ufos[0].pos={x:1170,y:600};
    },members);
    await page.waitForTimeout(600);
    const scene=await page.evaluate(()=>({members:window.__pallasiteState.asteroids.filter(a=>a.councilMember).map(a=>a.councilMember.name),drops:window.__pallasiteState.coins.length,background:document.body.style.backgroundImage,status:document.querySelector('#graphics-review-status').textContent,width:document.documentElement.scrollWidth}));
    assert.equal(scene.members.length,members.length);assert.ok(scene.drops>0);assert.ok(scene.background.includes('sanctum-space'));if(mobile)assert.equal(scene.width,390);
    await page.screenshot({path:new URL(`sanctum-release-${mode}.png`,out).pathname});
    const pose=await page.evaluate(()=>window.__pallasiteState.asteroids.map(a=>a.rot));
    const frame=await page.evaluate(()=>document.querySelector('#game').toDataURL());
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='playing');await page.waitForTimeout(450);
    await page.keyboard.press('Escape');await page.waitForFunction(()=>window.__pallasiteState.phase==='paused');await page.waitForTimeout(100);
    const after=await page.evaluate(()=>window.__pallasiteState.asteroids.map(a=>a.rot));
    assert.ok(after.every((rot,i)=>rot!==pose[i]),'all council members tumble during real play');
    assert.notEqual(await page.evaluate(()=>document.querySelector('#game').toDataURL()),frame,'live composed art moves');
    await page.waitForTimeout(150);assert.deepEqual(await page.evaluate(()=>window.__pallasiteState.asteroids.map(a=>a.rot)),after,'pause freezes the tumble');
    await page.screenshot({path:new URL(`sanctum-release-${mode}-tumble.png`,out).pathname});
    rows.push({mode,flight,scene,tumble:true,pause:true});await page.close();
  }
  assert.deepEqual(errors,[]);const result={base,build:expected,verifiedAssets:assets.length+members.length+3,rows,errors};
  await writeFile(new URL('sanctum-release-verification.json',out),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close();}
