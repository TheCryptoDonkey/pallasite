/** Players sign and publish their own scores; nothing is sent to the closed faucet. */
import assert from 'node:assert/strict';
import type { NostrEvent, SignetSession } from 'signet-login';

const pubkey = 'a'.repeat(64);
const session: SignetSession = {
  pubkey, method: 'bunker', authEvent: { pubkey, id: '', sig: '', kind: 21236, created_at: 1, tags: [], content: '' },
  signer: { pubkey, method: 'bunker', capabilities: { canSignEvents: true, hasNip44: false },
    async close() {}, async signEvent() { throw new Error('unused fixture signer'); } },
};
// The score module reaches build constants that only the bundler defines.
Object.assign(globalThis, { __BUILD_ID__: 'test', __BUILD_DATE__: 'test' });
const { publishSoloScore, publishCoopCampaignScore } = await import('../src/score.js');

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
