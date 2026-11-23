/** Once the faucet has answered 410, nothing asks the player to sign for it again. */
import assert from 'node:assert/strict';
import type { SignetSession } from 'signet-login';
import { fetchGameInfo, isFaucetClosed, postHeartbeat, submitCoopScore, submitSoloScore, uploadReplay } from '../src/faucet.js';

const pubkey = 'a'.repeat(64);
let signs = 0;
const session: SignetSession = {
  pubkey, method: 'bunker', authEvent: { pubkey, id: '', sig: '', kind: 21236, created_at: 1, tags: [], content: '' },
  signer: { pubkey, method: 'bunker', capabilities: { canSignEvents: true, hasNip44: false },
    async close() {}, async signEvent() { signs++; throw new Error('the closed faucet must not ask for a signature'); } },
};
const beforeHttp = globalThis.fetch;
let requests = 0;
try {
  globalThis.fetch = async () => { requests++; return new Response('The Pallasite faucet has closed.', { status: 410 }); };
  assert.equal(isFaucetClosed(), false);
  assert.equal(await fetchGameInfo(), null);
  assert.equal(isFaucetClosed(), true);
  console.log('PASS a 410 from the faucet marks it closed');

  requests = 0;
  const solo = await submitSoloScore(session, { score: 125, wave: 2, duration_ms: 9000, run_id: '123456789', mode: 'campaign' });
  assert.deepEqual(solo, { ok: false, error: 'faucet_closed', status: 410 });
  // `not_deployed` is the result the co-op recap already answers with a player-signed publish.
  assert.deepEqual(await submitCoopScore(session, { score: 10, wave: 1, duration_ms: 1000 }), { ok: false, error: 'not_deployed' });
  assert.equal(await postHeartbeat(session, { score: 1, wave: 1, started_at: 1, run_id: '1' }), false);
  assert.deepEqual(await uploadReplay(session, new Uint8Array([1, 2, 3])), { ok: false, error: 'server_error', status: 410, detail: 'faucet_closed' });
  assert.equal(signs, 0);
  assert.equal(requests, 0);
  console.log('PASS score, co-op score, heartbeat and replay calls neither sign nor send once the faucet is closed');
} finally { globalThis.fetch = beforeHttp; }
