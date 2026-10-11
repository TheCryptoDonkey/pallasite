/** Keep the synchronous bundle and published roster identical. */
import {readFile,access} from 'node:fs/promises';
import assert from 'node:assert/strict';
const read=async path=>JSON.parse(await readFile(new URL(path,import.meta.url),'utf8'));
const bundle=await read('../src/sanctum-roster.json');
assert.deepEqual(bundle,await read('../public/600bn/council.json'),'Bundled and public Sanctum manifests differ');
assert.equal(new Set(bundle.members.map(m=>m.name)).size,bundle.members.length);
for(const m of bundle.members){
  assert.match(m.pubkey,/^[0-9a-f]{64}$/);
  assert.ok(['stony','iron','chondrite','pallasite'].includes(m.asteroidType));
  assert.match(m.img,/^\/600bn\/img\/[\w.-]+$/);
  await access(new URL(`../public${m.img}`,import.meta.url));
}
console.log(`Sanctum roster: ${bundle.members.length} identities and portraits verified`);
