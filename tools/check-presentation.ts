/** Local browser acceptance: real menu start, responsive controls, boss phases,
 * quality switching and WebGL loss. Emulation is not physical-device proof. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, webkit, type Page } from 'playwright';
const base = 'http://127.0.0.1:5194';
const out = 'tools/record-out/presentation';
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5194', '--strictPort'], { stdio: 'pipe', detached: true });
const results: unknown[] = [];
await mkdir(out, { recursive: true });
async function loadModule(page: Page, name: string, action: string) {
  return page.evaluate(async ({name, action}) => {
    const mod = await import(`/src/${name}.ts`);
    return new Function('mod', 's', action)(mod, (window as any).__pallasiteState);
  }, {name, action});
}
async function start(page: Page) {
  await page.goto(base + '/?menu=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window as any).__pallasiteState);
  await page.evaluate(() => {
    (window as any).__pallasiteState.session = {pubkey:'0'.repeat(64),displayName:'LOCAL QA',method:'guest',signer:{capabilities:{canSignEvents:false}}};
    localStorage.setItem('pallasite:displayMode', 'modern');
  });
  await page.getByRole('button', {name:/^PLAY/}).click();
  await page.getByRole('button', {name:'CAMPAIGN',exact:true}).click();
  await page.getByRole('button', {name:/IGNITE/}).click();
  await page.getByText('Skip intro', {exact:true}).click();
  await page.waitForFunction(() => { const s=(window as any).__pallasiteState; return s.wave===1 && (s.phase==='wavestart'||s.phase==='playing') && !document.querySelector('.overlay'); });
  await loadModule(page, 'game', "begin(); function begin(){mod.beginWave(s,25);s.cheatedThisRun=true;s.phase='playing';s.players[0].ship.invulnerableUntil=1e9;} ");
  await page.evaluate(() => { (window as any).__pallasiteFit(); });
  await page.waitForFunction(() => document.body.dataset.phase === 'playing');
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* boot */ }
    await wait(100);
  }
  assert.ok(ready, 'local Vite server started');
  for (const test of [
    {name:'no-webgl',engine:chromium,width:1280,height:720,dpr:1.5,touch:false},
    {name:'desktop',engine:chromium,width:1440,height:900,dpr:2,touch:false},
    {name:'phone-small',engine:chromium,width:320,height:568,dpr:2,touch:true},
    {name:'phone',engine:chromium,width:390,height:844,dpr:3,touch:true},
    {name:'ipad',engine:webkit,width:1024,height:1366,dpr:2,touch:true},
    {name:'safari-phone',engine:webkit,width:390,height:844,dpr:3,touch:true},
    {name:'safari-landscape',engine:webkit,width:812,height:303,dpr:3,touch:true},
  ]) {
    const browser = await test.engine.launch({args:test.name==='no-webgl'?['--disable-webgl']:[]});
    try {
      const context = await browser.newContext({viewport:{width:test.width,height:test.height},deviceScaleFactor:test.dpr,hasTouch:test.touch,isMobile:test.touch,serviceWorkers:'block',
        ...(test.touch ? {userAgent:test.name==='ipad' ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'} : {})});
      // This acceptance run never publishes or depends on external services.
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await context.routeWebSocket(/.*/, socket => socket.close());
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await start(page);
      await loadModule(page, 'visual-style', "mod.setQualityPreference('high');");
      await page.waitForTimeout(1000);
      const mesh = await page.evaluate(() => (window as any).__pallasiteRenderProbe().webglOverlayReady);
      if (test.engine === chromium) assert.equal(mesh,test.name!=='no-webgl','3D availability matches browser capability');
      // Suppress only the transient achievement toast for clean visual evidence.
      await page.evaluate(() => { (window as any).__pallasiteState.toast=null; });
      await page.screenshot({path:`${out}/${test.name}-forge.png`});
      const frameTimes = await page.evaluate<number[]>(`new Promise(resolve => {
        const times=[]; let previous=performance.now();
        function tick(now) { times.push(now-previous); previous=now; if(times.length===90) resolve(times); else requestAnimationFrame(tick); }
        requestAnimationFrame(tick);
      })`);
      frameTimes.sort((a,b)=>a-b);
      const timing={medianMs:frameTimes[45],p95Ms:frameTimes[85],over50ms:frameTimes.filter(ms=>ms>50).length};
      const before = await page.evaluate(() => ({frame:(window as any).__pallasiteState.frame,pixels:(document.querySelector('#game') as HTMLCanvasElement).width*(document.querySelector('#game') as HTMLCanvasElement).height}));
      assert.ok(before.pixels <= 3_210_000, 'retina backing store obeys high pixel budget');
      await loadModule(page, 'visual-style', "mod.setQualityPreference('low');");
      await page.waitForTimeout(200);
      const after = await page.evaluate(() => ({frame:(window as any).__pallasiteState.frame,pixels:(document.querySelector('#game') as HTMLCanvasElement).width*(document.querySelector('#game') as HTMLCanvasElement).height}));
      assert.ok(after.pixels <= 903_000 && after.pixels < before.pixels, 'low quality reduces backing pixels');
      assert.ok(after.frame > before.frame, 'quality switch preserves advancing simulation');
      assert.equal(await loadModule(page,'visual-style',"return mod.getVisualStyle('ship');"),'shaded','low budget sheds mesh driver costs');
      assert.equal(await loadModule(page,'visual-style',"return mod.getVisualStyleRaw('ship');"),'mesh','saved art preference remains intact');
      await page.screenshot({path:`${out}/${test.name}-low.png`});
      if (test.touch) {
        await loadModule(page, 'touch', "mod.setTouchMode('joystick');document.body.classList.add('touch-active');");
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        const input = await page.evaluate(() => {
          const s = (window as any).__pallasiteState;
          const pad = document.querySelector('.joystick-pad') as HTMLElement;
          const fire = document.querySelector('.joy-right .fire') as HTMLElement;
          const p = pad.getBoundingClientRect(), f = fire.getBoundingClientRect();
          const cx = p.x + p.width/2, cy=p.y+p.height/2;
          const canvas=document.querySelector('#game') as HTMLCanvasElement;
          const matrix=canvas.getContext('2d')!.getTransform();
          const bounds=canvas.getBoundingClientRect();
          const ship=s.players[0].ship.pos;
          const shipX=bounds.x+(matrix.a*ship.x+matrix.e)/canvas.width*bounds.width;
          const shipY=bounds.y+(matrix.d*ship.y+matrix.f)/canvas.height*bounds.height;
          const thumbClear=Math.hypot(shipX-cx,shipY-cy)>45;
          pad.dispatchEvent(new PointerEvent('pointerdown',{pointerId:1,clientX:cx+45,clientY:cy,bubbles:true}));
          fire.dispatchEvent(new PointerEvent('pointerdown',{pointerId:2,bubbles:true}));
          const moving = s.players[0].thrustOverride && s.players[0].keys.Space;
          window.dispatchEvent(new PointerEvent('pointerup',{pointerId:99}));
          const unrelatedHeld = s.players[0].keys.Space;
          window.dispatchEvent(new Event('blur'));
          const released = !s.players[0].thrustOverride && !s.players[0].keys.Space && !pad.classList.contains('active');
          pad.dispatchEvent(new PointerEvent('pointerdown',{pointerId:3,clientX:cx,clientY:cy,bubbles:true}));
          window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:3}));
          const cancelledWithoutShot = !s.players[0].keys.Space;
          return {moving,unrelatedHeld,released,cancelledWithoutShot,thumbClear,overlap:p.right>f.left,bounds:[p.x,p.y,p.right,p.bottom,f.x,f.y,f.right,f.bottom],viewport:[innerWidth,innerHeight]};
        });
        assert.ok(input.moving && input.unrelatedHeld && input.released && input.cancelledWithoutShot, JSON.stringify(input));
        assert.equal(input.overlap, false, 'thumb clusters do not overlap');
        assert.ok(input.thumbClear,'Forge spawn is visible clear of the steering thumb');
        assert.ok(input.bounds[0]>=0 && input.bounds[4]>=0 && input.bounds[6]<=input.viewport[0] && input.bounds[7]<=input.viewport[1]);
        const ownership=await page.evaluate(async () => {
          const s=(window as any).__pallasiteState;
          const pad=document.querySelector('.joystick-pad') as HTMLElement;
          const fire=document.querySelector('.joy-right .fire') as HTMLElement;
          const r=pad.getBoundingClientRect();
          pad.dispatchEvent(new PointerEvent('pointerdown',{pointerId:6,clientX:r.x+r.width/2,clientY:r.y+r.height/2,bubbles:true}));
          window.dispatchEvent(new PointerEvent('pointerup',{pointerId:6}));
          fire.dispatchEvent(new PointerEvent('pointerdown',{pointerId:7,bubbles:true}));
          await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
          const held=s.players[0].keys.Space;
          window.dispatchEvent(new PointerEvent('pointerup',{pointerId:7}));
          return held&&!s.players[0].keys.Space;
        });
        assert.ok(ownership,'tap release preserves the other thumb holding FIRE');
        await page.getByRole('button', {name:/RESUME/}).click();
        await page.waitForFunction(()=>(window as any).__pallasiteState.phase==='playing');
        await page.locator('.joystick-pad').waitFor({state:'visible'});
        if (test.engine===chromium) {
          const cdp=await context.newCDPSession(page);
          const points=await page.evaluate(() => {
            const p=document.querySelector('.joystick-pad')!.getBoundingClientRect();
            const f=document.querySelector('.joy-right .fire')!.getBoundingClientRect();
            return [{x:p.x+p.width/2+40,y:p.y+p.height/2,id:1},{x:f.x+f.width/2,y:f.y+f.height/2,id:2}];
          });
          await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:points});
          await page.waitForTimeout(80);
          const realInput=await page.evaluate(()=>{const s=(window as any).__pallasiteState;const p=s.players[0];return {phase:s.phase,thrust:p.thrustOverride,fire:p.keys.Space,active:document.querySelector('.joystick-pad')!.classList.contains('active')};});
          assert.ok(realInput.thrust&&realInput.fire,'real two-finger touch: '+JSON.stringify({realInput,points}));
          await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
          assert.ok(await page.evaluate(()=>{const p=(window as any).__pallasiteState.players[0];return !p.thrustOverride&&!p.keys.Space;}),'real touch release clears input');
          await cdp.detach();
        }
        await page.screenshot({path:`${out}/${test.name}-touch.png`});
        await page.evaluate(async () => { if(document.fullscreenElement) await document.exitFullscreen(); });
        await page.setViewportSize({width:test.height,height:test.width});
        await page.waitForTimeout(200);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'rotation causes no horizontal page overflow');
        await page.screenshot({path:`${out}/${test.name}-landscape.png`});
        await page.setViewportSize({width:test.width,height:test.height});
        const resume = page.getByRole('button', {name:/RESUME/});
        if (await resume.isVisible()) await resume.click();
      }
      // Exercise the actual phase transitions, without waiting to play 25 waves.
      await page.evaluate(() => {
        const s=(window as any).__pallasiteState;
        s.asteroids.filter((a:any)=>a.stationPart==='emitter').slice(0,6).forEach((a:any)=>{a.alive=false;});
        const core=s.asteroids.find((a:any)=>a.stationPart==='core');core.hp=core.hpMax*0.5;
      });
      await page.waitForFunction(()=>(window as any).__pallasiteState.forgeBreached);
      await page.waitForFunction(()=>(window as any).__pallasiteState.forgePulseAt>0);
      await page.evaluate(() => {
        const s=(window as any).__pallasiteState;
        s.forgePulseAt=s.elapsed+700;
      });
      await page.screenshot({path:`${out}/${test.name}-charge.png`});
      await page.evaluate(() => {const s=(window as any).__pallasiteState;const a=s.asteroids.find((a:any)=>a.stationPart==='core');a.hp=a.hpMax*0.3;});
      await page.waitForFunction(()=>(window as any).__pallasiteState.forgeMeltdown);
      await page.screenshot({path:`${out}/${test.name}-meltdown.png`});
      await page.evaluate(() => {const s=(window as any).__pallasiteState;const a=s.asteroids.find((a:any)=>a.stationPart==='core');a.hp=a.hpMax*0.15;});
      await page.waitForFunction(()=>(window as any).__pallasiteState.forgeEscaped);
      assert.equal(await page.evaluate(()=>(window as any).__pallasiteState.forgePulseAt),0,'chase cancels radial pulse');
      await page.screenshot({path:`${out}/${test.name}-chase.png`});
      let loss = mesh ? 'not exercised in WebKit' : 'not applicable without WebGL';
      if (mesh && test.engine === chromium) {
        await loadModule(page,'visual-style',"mod.setQualityPreference('high');");
        await page.waitForFunction(()=>(window as any).__pallasiteRenderProbe().shipTier==='mesh');
        const supported = await page.evaluate(() => {
          const canvas=document.querySelector('#game3d') as HTMLCanvasElement;
          const gl=canvas.getContext('webgl2');
          const ext=gl?.getExtension('WEBGL_lose_context');
          (window as any).__qaLoseContext=ext;
          ext?.loseContext();return !!ext;
        });
        assert.ok(supported,'context loss extension available');
        await page.waitForFunction(()=>!(window as any).__pallasiteRenderProbe().webglOverlayReady);
        await page.screenshot({path:`${out}/${test.name}-fallback.png`});
        await page.evaluate(()=>(window as any).__qaLoseContext.restoreContext());
        await page.waitForFunction(()=>(window as any).__pallasiteRenderProbe().webglOverlayReady);
        loss='fallback and restore passed';
      }
      await loadModule(page, 'ui', "s.phase='paused';mod.renderSettings(()=>{});");
      await page.locator('#graphics-quality').selectOption('balanced');
      assert.equal(await loadModule(page,'visual-style', 'return mod.getQualityPreference();'),'balanced');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'settings have no page overflow');
      const overflowing = await page.evaluate(() => Array.from(document.querySelectorAll('.overlay select,.overlay input[type="range"]')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.left<0||r.right>innerWidth);}).length);
      assert.equal(overflowing,0,'settings controls fit screen');
      assert.deepEqual(errors,[],`${test.name} page errors`);
      results.push({name:test.name,engine:test.engine.name(),mesh,loss,before,after,timing,status:'PASS'});
      await writeFile(`${out}/report.json`,JSON.stringify(results,null,2));
      console.log('PASS',test.name,loss);
    } finally {await browser.close();}
  }
  await writeFile(`${out}/report.json`,JSON.stringify(results,null,2));
} finally {
  if (server.pid) {try {process.kill(-server.pid,'SIGTERM');} catch { /* exited */ }}
}
