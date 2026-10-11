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
  return { ok: true, id: 'c'.repeat(64), published: { ok: 1, total: 1 } };
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
await restored.retry(saved, session(accountA), async () => ({ ok: true, id: 'invalid-id', published: { ok: 1, total: 1 } }));
await restored.retry(saved, session(accountA), async () => ({ ok: true, id: 'c'.repeat(64), published: { ok: 2, total: 1 } }));
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

// Rejection status and timestamps remain with the original earned receipt.
data.clear();
const review = new SoloScoreOutbox(storage);
const dated = review.enqueue(accountA, { ...input, run_id: '100', started_at: 1791700000, finished_at: 1791700009 });
review.enqueue(accountA, { ...input, run_id: '101' });
review.enqueue(accountB, { ...input, run_id: '102' });
await review.retry(dated, session(accountA), async () => ({ ok: false, error: 'invalid_score', status: 422 }));
const afterReject = new SoloScoreOutbox(storage);
const rejected = afterReject.pending(accountA).find(r => r.input.run_id === '100')!;
assert.equal(rejected.rejected, true);
assert.equal(rejected.lastError, 'invalid_score');
assert.equal(rejected.input.finished_at, 1791700009);
assert.equal(afterReject.remove(rejected, accountB), false);
assert.equal(afterReject.remove(rejected, accountA), true);
assert.deepEqual(new SoloScoreOutbox(storage).pending(accountA).map(r => r.input.run_id), ['101']);
assert.equal(new SoloScoreOutbox(storage).pending(accountB).some(r => r.input.run_id === '102'), true);
console.log('PASS permanent rejection and original dates survive reload; selected owner removal preserves other runs and accounts');

const working = afterReject.pending(accountA)[0];
let finish!: () => void;
const waiting = new Promise<void>(resolve => { finish = resolve; });
const inFlight = afterReject.retry(working, session(accountA), async () => { await waiting; return { ok: false, error: 'network_error' }; });
assert.equal(afterReject.remove(working, accountA), false);
finish(); await inFlight;
assert.equal(afterReject.pending(accountA).length, 1);
console.log('PASS a receipt cannot be removed during its active submission');

const brokenText = JSON.stringify([{ invalid: true }, { pubkey: accountA, input: { ...input, run_id: '103' } }]);
data.set(SOLO_SCORE_OUTBOX_KEY, brokenText);
const protectedOutbox = new SoloScoreOutbox(storage);
assert.equal(protectedOutbox.storageProblem, 'corrupt');
assert.equal(protectedOutbox.durable, false);
const readable = protectedOutbox.pending(accountA)[0];
protectedOutbox.enqueue(accountA, { ...input, run_id: '104' });
assert.equal(protectedOutbox.remove(readable, accountA), false);
assert.equal(data.get(SOLO_SCORE_OUTBOX_KEY), brokenText);
assert.equal(protectedOutbox.pending(accountA).length, 2);
console.log('PASS malformed existing storage is preserved byte for byte, with new runs retained for this visit');

const failureData = new Map<string, string>();
let failWrites = false;
const unstable = new SoloScoreOutbox(() => ({ getItem: key => failureData.get(key) ?? null, setItem: (key, value) => { if (failWrites) throw new Error('quota'); failureData.set(key, value); } }));
const removable = unstable.enqueue(accountA, { ...input, run_id: '105' });
failWrites = true;
assert.equal(unstable.remove(removable, accountA), false);
assert.equal(unstable.pending(accountA).length, 1);
assert.equal(JSON.parse(failureData.get(SOLO_SCORE_OUTBOX_KEY)!).length, 1);
console.log('PASS a failed removal write retains the original receipt');

const authenticated = session(accountA);
authenticated.signer.signEvent = async template => ({ ...template, pubkey: accountA, id: '', sig: '', created_at: 1, tags: template.tags ?? [] });
const beforeHttp = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: false, error: 'invalid_score' }), { status: 422 });
  assert.deepEqual(await submitSoloScore(authenticated, saved.input), { ok: false, error: 'invalid_score', status: 422 });
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, id: 'misleading', published: { ok: 1, total: 1 } }), { status: 500 });
  assert.deepEqual(await submitSoloScore(authenticated, saved.input), { ok: false, error: 'bad_response', status: 500 });
  console.log('PASS HTTP rejection status is retained and an error-status success body cannot confirm publication');

  const timeoutData = new Map<string, string>();
  const timed = new SoloScoreOutbox(() => ({ getItem: key => timeoutData.get(key) ?? null, setItem: (key, value) => { timeoutData.set(key, value); } }));
  const timedReceipt = timed.enqueue(accountA, { ...input, run_id: '106' });
  globalThis.fetch = async (_url, options) => {
    assert(options?.signal);
    return new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }));
  };
  // Keep Node alive while its real AbortSignal deadline proves retry release.
  const watchdog = setTimeout(() => { throw new Error('HTTP deadline did not release'); }, 20_000);
  try {
    const start = Date.now();
    assert.equal((await timed.retry(timedReceipt, authenticated, submitSoloScore)).ok, false);
    assert(Date.now() - start >= 14_000 && Date.now() - start < 20_000);
    assert.equal(timed.pending(accountA).length, 1);
    globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, id: 'd'.repeat(64), published: { ok: 1, total: 1 } }));
    assert.equal((await timed.retry(timedReceipt, authenticated, submitSoloScore)).ok, true);
    assert.equal(timed.pending(accountA).length, 0);
  } finally { clearTimeout(watchdog); }
  console.log('PASS a stalled HTTP submission times out, retains its receipt and releases a successful retry');
} finally { globalThis.fetch = beforeHttp; }
