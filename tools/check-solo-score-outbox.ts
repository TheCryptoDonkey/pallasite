import assert from 'node:assert/strict';
import type { SignetSession } from 'signet-login';
import type { SoloScoreInput, SoloScoreResult } from '../src/faucet.js';
import { SoloScoreOutbox, SOLO_SCORE_OUTBOX_KEY } from '../src/solo-score-outbox.js';
import { submitSoloScore } from '../src/faucet.js';

const accountA = 'a'.repeat(64), accountB = 'b'.repeat(64);
function session(pubkey: string, canSignEvents = true): SignetSession {
  return { pubkey, method: 'bunker', authEvent: { pubkey, id: '', sig: '', kind: 21236, created_at: 1, tags: [], content: '' },
    signer: { pubkey, method: 'bunker', capabilities: { canSignEvents, hasNip44: false },
      async close() {}, async signEvent() { throw new Error('unused fixture signer'); } } };
}
const input: SoloScoreInput = { score: 125, wave: 2, duration_ms: 9000, run_id: '123456789', mode: 'campaign', player_name: 'Pilot', nip05: 'pilot@example.com' };
const data = new Map<string, string>();
const storage = () => ({ getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } });
const outbox = new SoloScoreOutbox(storage);
const receipt = outbox.enqueue(accountA, input);
input.score = 999;
let calls = 0;
const success = async (_session: SignetSession, run: SoloScoreInput): Promise<SoloScoreResult> => {
  calls++; assert.equal(_session.pubkey, accountA); assert.equal(run.score, 125);
  assert.equal(run.run_id, '123456789'); assert.equal(run.nip05, 'pilot@example.com');
  return { ok: true, id: 'fixture-event', published: { ok: 1, total: 1 } };
};
assert.equal((await outbox.retry(receipt, session(accountB), success)).ok, false);
const mismatched = session(accountA); mismatched.signer = session(accountB).signer;
assert.equal((await outbox.retry(receipt, mismatched, success)).ok, false);
assert.equal((await outbox.retry(receipt, session(accountA, false), success)).ok, false);
assert.equal(calls, 0);
assert.equal(outbox.pending(accountB).length, 0);
assert.equal(outbox.pending(accountA).length, 1);
console.log('PASS another account, a mismatched signer and auth-only identity cannot submit the receipt');

await outbox.retry(receipt, session(accountA), async () => ({ ok: false, error: 'sign_failed' }));
const restored = new SoloScoreOutbox(storage);
const saved = restored.pending(accountA)[0];
assert.equal(saved.input.score, 125);
assert.equal(saved.input.run_id, '123456789');
assert.equal(saved.pubkey, accountA);
console.log('PASS signer failure and reload preserve the earned snapshot and account');

await restored.retry(saved, session(accountA), async () => ({ ok: true, id: 'unpublished', published: { ok: 0, total: 2 } }));
await restored.retry(saved, session(accountA), async () => ({ ok: true } as SoloScoreResult));
assert.equal(restored.pending(accountA).length, 1);
console.log('PASS an unconfirmed relay publication remains available for retry');

let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const submit = async (selected: SignetSession, run: SoloScoreInput) => { await gate; return success(selected, run); };
const first = restored.retry(saved, session(accountA), submit);
const second = restored.retry(saved, session(accountA), submit);
assert.equal(first, second);
release(); await Promise.all([first, second]);
assert.equal(calls, 1);
assert.equal(new SoloScoreOutbox(storage).pending(accountA).length, 0);
console.log('PASS overlapping retry clicks publish once and clear only confirmed receipts');

const blocked = new SoloScoreOutbox(() => { throw new Error('storage unavailable'); });
const temporary = blocked.enqueue(accountA, { ...input, run_id: '2' });
assert.equal(blocked.durable, false);
await blocked.retry(temporary, session(accountA), async () => { throw new Error('network offline'); });
assert.equal(blocked.pending(accountA).length, 1);
console.log('PASS blocked storage retains the run for this visit and exposes its durability limit');

data.set(SOLO_SCORE_OUTBOX_KEY, JSON.stringify([{ pubkey: accountA, input: { ...input, score: -1 } }, { pubkey: accountB, input: { ...input, run_id: '3' } }]));
const guarded = new SoloScoreOutbox(storage);
assert.equal(guarded.pending(accountA).length, 0);
assert.equal(guarded.pending(accountB).length, 1);
console.log('PASS malformed persisted receipts are rejected without losing another account receipt');

// A provider can change its account after advertising the selected pubkey.
// The HTTP client must reject that returned signature before submitting it.
Object.assign(globalThis, { window: { setTimeout: () => 0 }, location: { origin: 'https://private-fixture.invalid' } });
const changed = session(accountA);
changed.signer.signEvent = async template => ({ ...template, pubkey: accountB, id: '', sig: '', created_at: 1, tags: template.tags ?? [] });
let requests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { requests++; throw new Error('unexpected fixture HTTP request'); };
try {
  assert.deepEqual(await submitSoloScore(changed, saved.input), { ok: false, error: 'wrong_signer' });
  assert.equal(requests, 0);
} finally { globalThis.fetch = originalFetch; }
console.log('PASS a provider returning another account signature cannot reach the score endpoint');
