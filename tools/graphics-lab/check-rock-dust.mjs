import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';

export async function runRockDust(browser,base,out) {
  const page=await browser.newPage({viewport:{width:1440,height:900}}),urls={},errors=[];
  page.on('request',r=>{const p=new URL(r.url()).pathname;if(p.startsWith('/src/')&&!urls[p])urls[p]=r.url();});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/?graphicsReview=1`);
  await page.waitForFunction(()=>window.__pallasiteState?.phase==='playing');
  await page.evaluate(()=>window.__pallasiteState.phase='paused');
  const modules=Object.fromEntries(['game','seed','types','level-one-impacts','rock-dust','level-one-refresh','render','visual-style'].map(n=>[n,urls[`/src/${n}.ts`]??`${base}/src/${n}.ts`]));
  const result=await page.evaluate(async m=>{
    const g=await import(m.game),seed=await import(m.seed),types=await import(m.types),fx=await import(m['level-one-impacts']),dust=await import(m['rock-dust']);
    const saved=g.getSimModuleState(),rng=seed.getRngState(),id=g.getEntityIdCounter();
    const rows=[],sheet=document.createElement('canvas');sheet.width=1280;sheet.height=960;
    const ctx=sheet.getContext('2d');ctx.fillStyle='#09101b';ctx.fillRect(0,0,1280,960);
    function fixture(){const s=g.makeInitialState();g.startGame(s,12345);s.phase='playing';s.elapsed=10000;s.nextUfoSpawn=1e9;s.hitStopSteps=0;
      s.asteroids=[];s.ufos=[];s.mines=[];s.powerups=[];s.coins=[];s.bullets=[];
      s.players[0].ship.pos={x:100,y:100};s.players[0].ship.invulnerableUntil=1e9;return s;}
    function shoot(s,a){s.hitStopSteps=0;g.fireBullet(s,s.players[0]);s.bullets.at(-1).pos={...a.pos};g.updateGame(s);s.bullets=[];}
    try {
      for(const [i,type] of Object.keys(types.ASTEROID_TYPE_CONFIG).entries()) {
        const s=fixture(),a=g.spawnAsteroid('large',3,{x:150,y:100},{x:0,y:0},type);a.hp=a.hpMax=2;s.asteroids=[a];
        // A real non-fatal shot, then a real fatal shot through damageAsteroid.
        shoot(s,a);const hits=fx.liveRockImpacts(s).map(h=>({...h}));
        shoot(s,a);const bursts=fx.liveRockImpacts(s).map(h=>({...h}));
        const tagged=s.particles.filter(p=>fx.isRockDustParticle(p)).length;
        const before=JSON.stringify(s),renderRng=seed.getRngState();
        const tile=document.createElement('canvas');tile.width=320;tile.height=320;const c=tile.getContext('2d');
        const t=s.elapsed;s.elapsed=t+180;dust.drawRockDust(c,s,false,false);s.elapsed=t+650;dust.drawRockDust(c,s,false,false);s.elapsed=t;
        const visible=[...c.getImageData(0,0,320,320).data].filter((v,j)=>j%4===3&&v>0).length;
        const unchanged=before===JSON.stringify(s)&&renderRng===seed.getRngState();
        ctx.drawImage(tile,(i%4)*320,Math.floor(i/4)*320);ctx.fillStyle='#ebf4ff';ctx.font='18px sans-serif';ctx.fillText(type,(i%4)*320+18,Math.floor(i/4)*320+26);
        rows.push({type,hits,bursts,tagged,visible,unchanged});
      }
      const collision=fixture(),a=g.spawnAsteroid('medium',3,{x:600,y:350},{x:100,y:0},'iron'),b=g.spawnAsteroid('medium',3,{x:630,y:350},{x:-100,y:0},'carbonaceous');
      collision.asteroids=[a,b];g.updateGame(collision);
      const mixed=fx.liveRockImpacts(collision).map(h=>({...h}));
      const stress=fixture();for(let i=0;i<100;i++)fx.recordRockImpact(stress,{type:'volatile',kind:'break',radius:40,x:150,y:100,vx:0,vy:0,nx:0,ny:0,speed:90});
      const cap=fx.liveRockImpacts(stress).length;
      const reduced=document.createElement('canvas');reduced.width=320;reduced.height=200;
      stress.elapsed+=300;dust.drawRockDust(reduced.getContext('2d'),stress,true,true);
      const lowVisible=reduced.getContext('2d').getImageData(0,0,320,200).data.some((v,i)=>i%4===3&&v>0);
      stress.elapsed+=fx.ROCK_DUST_LIFETIME_MS;const expired=fx.liveRockImpacts(stress).length;
      fx.recordRockImpact(stress,{type:'stony',x:100,y:100,vx:0,vy:0,nx:1,ny:0,speed:60});fx.resetRockImpacts(stress);
      return {rows,mixed,cap,expired,reset:fx.liveRockImpacts(stress).length,lowVisible,sheet:sheet.toDataURL()};
    } finally {g.setSimModuleState(saved);seed.setRngState(rng);g.setEntityIdCounter(id);}
  },modules);
  assert.equal(result.rows.length,12);
  for(const r of result.rows){assert.ok(r.hits.some(h=>h.type===r.type&&!h.kind),`${r.type} nonfatal hit`);assert.ok(r.bursts.some(h=>h.type===r.type&&h.kind==='break'),`${r.type} breakup`);assert.ok(r.tagged>0);assert.ok(r.visible>100);assert.equal(r.unchanged,true);}
  assert.ok(result.mixed.some(h=>h.type==='iron'&&h.otherType==='carbonaceous'),'actual collision keeps both materials');
  assert.equal(result.cap,12);assert.equal(result.expired,0);assert.equal(result.reset,0);assert.equal(result.lowVisible,true);assert.deepEqual(errors,[]);
  await writeFile(new URL('asteroid-dust-materials.png',out),Buffer.from(result.sheet.split(',')[1],'base64'));delete result.sheet;
  await writeFile(new URL('asteroid-dust-verification.json',out),JSON.stringify({result,errors},null,2));
  console.log(JSON.stringify({materials:result.rows.map(r=>({type:r.type,visible:r.visible,tagged:r.tagged,unchanged:r.unchanged})),mixed:result.mixed,cap:result.cap,expired:result.expired,lowVisible:result.lowVisible,errors},null,2));
  await page.close();
}
