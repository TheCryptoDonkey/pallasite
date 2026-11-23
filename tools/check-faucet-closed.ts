/** Once the faucet has answered 410, nothing asks the player to sign for it again. */
import assert from 'node:assert/strict';
import type { SignetSession } from 'signet-login';
import { fetchGameInfo, isFaucetClosed, postHeartbeat, submitCoopScore, submitSoloScore } from '../src/faucet.js';

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
  assert.equal(signs, 0);
  assert.equal(requests, 0);
  console.log('PASS score, co-op score and heartbeat calls neither sign nor send once the faucet is closed');
} finally { globalThis.fetch = beforeHttp; }

// ── Player-signed solo scores ────────────────────────────────────────────────
// The score module reaches build constants that only the bundler defines.
Object.assign(globalThis, { __BUILD_ID__: 'test', __BUILD_DATE__: 'test' });
const { publishSoloScore, publishCoopCampaignScore } = await import('../src/score.js');
import type { NostrEvent } from 'signet-login';

const run = { score: 125, wave: 2, duration_ms: 9400, run_id: '123456789', mode: 'drift' as const, room: '600bn' as const,
  player_name: 'Pilot', nip05: 'pilot@example.com', started_at: 1_700_000_000, finished_at: 1_700_000_009 };
const signerFor = (signAs: string): SignetSession => ({ ...session, signer: { ...session.signer,
  async signEvent(template) { return { ...template, pubkey: signAs, id: 'e'.repeat(64), sig: 'f'.repeat(128), created_at: template.created_at ?? 1, tags: template.tags ?? [], content: template.content ?? '' } as NostrEvent; } } });
const sent: NostrEvent[] = [];
const relays = ['wss://one.example', 'wss://two.example'];
const publish = async (url: string, event: NostrEvent): Promise<void> => { if (url === relays[1]) throw new Error('rejected'); sent.push(event); };

const published = await publishSoloScore(signerFor(pubkey), run, { relays, publish });
assert.deepEqual(published, { ok: true, id: 'e'.repeat(64), published: { ok: 1, total: 2 } });
assert.equal(sent.length, 1);
const tag = (name: string): string[] => sent[0].tags.filter(t => t[0] === name).map(t => t[1]);
assert.equal(sent[0].kind, 30762);
assert.equal(sent[0].created_at, 1_700_000_009);
assert.deepEqual(tag('d'), [`pallasite:${pubkey}:wave-2:daily-123456789`]);
assert.deepEqual(tag('p'), [pubkey]);
assert.deepEqual(tag('game'), ['pallasite']);
assert.deepEqual(tag('score'), ['125']);
assert.deepEqual(tag('sats'), ['0']);
assert.deepEqual(tag('duration'), ['9']);
assert.deepEqual(tag('playerName'), ['Pilot']);
assert.deepEqual(tag('t'), ['pallasite', 'arcade', 'asteroids', '600bn', 'drift']);
console.log('PASS a solo score is signed by the player with its own per-run address and the leaderboard tags');

sent.length = 0;
assert.deepEqual(await publishSoloScore(signerFor('b'.repeat(64)), run, { relays, publish }), { ok: false, error: 'wrong_signer' });
assert.deepEqual(await publishSoloScore(signerFor(pubkey), { ...run, cheated: true }, { relays, publish }), { ok: false, error: 'cheated_run', status: 400 });
assert.equal((await publishSoloScore(signerFor(pubkey), run, { relays: [relays[1]], publish })).ok, false);
assert.equal(sent.length, 0);
console.log('PASS another account\'s signature, a cheated run and a relay refusal publish nothing as a success');

const coop = await publishCoopCampaignScore(signerFor(pubkey), { score: 900, wave: 4, durationMs: 60_000, players: 2 }, []);
assert.deepEqual(coop?.event.tags.filter(t => t[0] === 'd').map(t => t[1]), [`pallasite:${pubkey}:coop:wave-4`]);
console.log('PASS a co-op score has an address, so it no longer replaces the player\'s other scores');
