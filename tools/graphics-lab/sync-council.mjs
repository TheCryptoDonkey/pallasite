/** Refresh the bundled 600.wtf roster and local portraits. Explicit authoring
 * command only; gameplay never requests third-party membership or images. */
import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import sharp from 'sharp';
const root=new URL('../../',import.meta.url);
const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(30000)});assert.ok(r.ok,`${url}: ${r.status}`);return r;};
const [site,nip]=await Promise.all([
  get('https://600.wtf/members.json').then(r=>r.json()),
  get('https://600.wtf/.well-known/nostr.json').then(r=>r.json()),
]);
const old=JSON.parse(await readFile(new URL('src/sanctum-roster.json',root),'utf8'));
assert.ok(site.members.length>0);assert.equal(new Set(site.members.map(m=>m.name)).size,site.members.length);
const members=[],portraits=[];
for(const m of site.members){
  const prior=old.members.find(o=>o.name===m.name||(m.name==='darren'&&o.name==='TheCryptoDonkey'));
  const source=new URL(m.img,'https://600.wtf/');assert.equal(source.origin,'https://600.wtf');
  const slug=source.pathname.split('/').at(-1).replace(/\.[^.]+$/,'');assert.match(slug,/^[\w-]+$/);
  const img=`/600bn/img/current-${slug}.webp`;
  const pubkey=nip.names[m.nostr.split('@')[0]]??prior?.pubkey;
  assert.match(pubkey??'',/^[a-f0-9]{64}$/,`No published key for ${m.name}`);
  const bytes=await sharp(Buffer.from(await(await get(source)).arrayBuffer())).resize(320,320,{fit:'cover'}).webp({quality:88}).toBuffer();
  portraits.push({img,bytes});
  members.push({name:m.name,role:m.role,archetype:prior?.archetype??m.nickname??'600 Council',img,pubkey,asteroidType:prior?.asteroidType??'stony',nostr:m.nostr});
}
for(const {img,bytes} of portraits)await writeFile(new URL(`public${img}`,root),bytes);
const manifest=JSON.stringify({...old,source:'https://600.wtf/members.json',updated:new Date().toISOString().slice(0,10),members},null,2)+'\n';
await writeFile(new URL('src/sanctum-roster.json',root),manifest);
await writeFile(new URL('public/600bn/council.json',root),manifest);
console.log(`Synced ${members.length} members; 320px WebP portraits, quality 88`);
