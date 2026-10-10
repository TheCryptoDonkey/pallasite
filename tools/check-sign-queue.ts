/** Concurrent requests must retain their own signer, including after rejection. */
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { EventTemplate, NostrEvent, SignetSigner } from 'signet-login';

Object.assign(globalThis, { window: globalThis });
const { serialiseSigner, pendingSignCount } = await import(process.env.SIGN_QUEUE_MODULE ?? '../src/sign-queue.js');
const template: EventTemplate = { kind: 27235, created_at: 1, tags: [['method', 'POST']], content: '' };
function signer(): SignetSigner {
  const key = schnorr.utils.randomSecretKey();
  const pubkey = bytesToHex(schnorr.getPublicKey(key));
  return {
    pubkey, method: 'bunker', capabilities: { canSignEvents: true, hasNip44: false },
    async close() {},
    async signEvent(input): Promise<NostrEvent> {
      const event = { ...input, created_at: input.created_at ?? 1, tags: input.tags ?? [], pubkey };
      const hash = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, event.created_at, event.kind, event.tags, event.content])));
      return { ...event, id: bytesToHex(hash), sig: bytesToHex(schnorr.sign(hash, key)) };
    },
  };
}
function verified(event: NostrEvent, expected: string): void {
  assert.equal(event.pubkey, expected, 'a queued request used another account');
  const hash = sha256(new TextEncoder().encode(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])));
  assert.equal(bytesToHex(hash), event.id);
  assert(schnorr.verify(hexToBytes(event.sig), hash, hexToBytes(event.pubkey)));
}
const a = signer();
const b = signer();
let release!: () => void;
const gate = new Promise<void>(resolve => { release = resolve; });
const original = a.signEvent.bind(a);
a.signEvent = async input => { await gate; return original(input); };
const wrappedA = serialiseSigner(a);
const wrappedB = serialiseSigner(b);
const first = wrappedA.signEvent(template);
const second = wrappedB.signEvent(template);
release();
const [firstEvent, secondEvent] = await Promise.all([first, second]);
verified(firstEvent, a.pubkey);
verified(secondEvent, b.pubkey);
console.log('PASS overlapping accounts retain their own canonical signatures');

const bad = signer();
bad.signEvent = async () => { throw new Error('fixture-signer-offline'); };
const failure = serialiseSigner(bad).signEvent(template);
// Attach the rejection observer before the queue proceeds.
const rejected = assert.rejects(failure, /fixture-signer-offline/);
const afterFailure = wrappedB.signEvent(template);
await rejected;
verified(await afterFailure, b.pubkey);
console.log('PASS a failed account does not sign or reject the next account request');

const [reenteredB, reenteredA] = await Promise.all([wrappedB.signEvent(template), wrappedA.signEvent(template)]);
verified(reenteredB, b.pubkey);
verified(reenteredA, a.pubkey);
assert.equal(pendingSignCount(), 0);
console.log('PASS queue re-entry preserves request ownership and drains');
