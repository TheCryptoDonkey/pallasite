import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import sharp from 'sharp';

/** Compare the final warp frame with the real next-wave renderer, including
 *  full-screen gutters, crop and exposure on wide and portrait viewports. */
export async function runWarpArrival(browser,base,out) {
  const page=await browser.newPage({viewport:{width:1440,height:900}}),urls={},errors=[];
  page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/src/')&&!urls[p])urls[p]=r.url();});
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('pallasite:quality','high'));
  await page.goto(`${base}/?graphicsReview=1`);await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing');
  await page.evaluate(()=>{window.__pallasiteState.phase='paused';});
  const modules=Object.fromEntries(['render','types','seed','ultra-warp','visual-style','a11y'].map(n=>[n,urls[`/src/${n}.ts`]??`${base}/src/${n}.ts`]));
  const results=[];
  const cases=[
    {name:'desktop',width:1440,height:900,kind:'modern',quality:'high',wave:2},
    {name:'wide',width:1920,height:800,kind:'modern',quality:'high',wave:28},
    {name:'portrait',width:390,height:844,kind:'modern',quality:'balanced',wave:26},
    {name:'reduced',width:1440,height:900,kind:'modern',quality:'high',wave:30,reduced:true},
    {name:'retro',width:1280,height:720,kind:'retro',quality:'high',wave:2},
  ];
  for(const fixture of cases) {
    const result=await page.evaluate(async({m,f})=>{
      const r=await import(m.render),types=await import(m.types),seed=await import(m.seed),w=await import(m['ultra-warp']);
      (await import(m['visual-style'])).setQualityPreference(f.quality);
      (await import(m.a11y)).setReducedMotionPref(f.reduced?'on':'off');
      await r.preloadBackgroundReady(f.wave);await w.preloadUltraWarpArt();
      const scale=Math.min(f.width/1280,f.height/720);
      r.setRenderMode({kind:f.kind,vw:f.width,vh:f.height,dpr:1,scale,tx:(f.width-1280*scale)/2,ty:(f.height-720*scale)/2,insets:{top:0,right:0,bottom:0,left:0},follow:f.height>f.width});
      r.setHudHidden(true);
      const s=structuredClone(window.__pallasiteState);s.phase='warp';s.phaseStart=0;s.warpTargetWave=f.wave;
      s.asteroids=[];s.ufos=[];s.mines=[];s.powerups=[];s.coins=[];s.bullets=[];s.enemyBullets=[];s.particles=[];s.debris=[];
      s.hyperspaceEffects=[];s.shockwaveRings=[];s.players[0].ship.alive=false;s.players[0].combo=0;
      const c=document.createElement('canvas');c.width=f.width;c.height=f.height;const ctx=c.getContext('2d');
      const frames=[],pixels=[];const rng=seed.getRngState();
      for(const p of [.8,.9,.96,.99,1]){s.elapsed=p*types.WARP_MS;r.render(c,s,20000);frames.push(c.toDataURL());pixels.push(ctx.getImageData(0,0,c.width,c.height).data);}
      s.wave=f.wave;s.phase='wavestart';s.phaseStart=s.elapsed;r.render(c,s,20000);const next=ctx.getImageData(0,0,c.width,c.height).data;
      const deltas=pixels.map(data=>{
        let edge=0,full=0,edgeCount=0,opaque=true;
        for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const i=(y*c.width+x)*4;
          const d=(Math.abs(data[i]-next[i])+Math.abs(data[i+1]-next[i+1])+Math.abs(data[i+2]-next[i+2]))/3;
          full+=d;if(x<30||x>=c.width-30||y<30||y>=c.height-30){edge+=d;edgeCount++;if(data[i+3]!==255)opaque=false;}}
        return {edge:edge/edgeCount,full:full/(c.width*c.height),opaque};
      });
      const unchanged=seed.getRngState()===rng;
      return {deltas,frames,next:c.toDataURL(),unchanged};
    },{m:modules,f:fixture});
    assert.equal(result.unchanged,true);
    assert.ok(result.deltas.every(d=>d.opaque),'no exposed rectangular/letterbox edges');
    assert.ok(result.deltas.at(-1).edge<.5,`${fixture.name}: final edge matches next level: ${JSON.stringify(result.deltas)}`);
    assert.ok(result.deltas.at(-1).full<.5,`${fixture.name}: final crop and exposure match next level`);
    assert.ok(result.deltas[3].edge<1,`${fixture.name}: no late border jump`);
    assert.ok(result.deltas[3].full<result.deltas[0].full,'arrival converges smoothly');
    const thumbs=await Promise.all([...result.frames,result.next].map(async(data,i)=>({input:await sharp(Buffer.from(data.split(',')[1],'base64')).resize(480,300,{fit:'contain',background:'#000'}).toBuffer(),left:(i%3)*480,top:Math.floor(i/3)*300})));
    await sharp({create:{width:1440,height:600,channels:3,background:'#000'}}).composite(thumbs).png().toFile(new URL(`warp-arrival-${fixture.name}.png`,out).pathname);
    results.push({fixture,...result,frames:undefined,next:undefined});
  }
  assert.deepEqual(errors,[]);
  await writeFile(new URL('warp-arrival-verification.json',out),JSON.stringify({results,errors},null,2));
  console.log(JSON.stringify({results,errors},null,2));await page.close();
}
