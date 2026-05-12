/**
 * Global serialised signEvent queue.
 *
 * NIP-46 / NIP-07 signers (bark, nsec.app, signet bunker) often get
 * stuck or rate-limit when hit with concurrent signEvent requests.
 * The heartbeat (4s), per-wave replay chunks, ghost publishes, NIP-53
 * announces, and user-initiated claim signs can all overlap in time.
 *
 * This module wraps a signer so every signEvent call is processed
 * strictly one-at-a-time, with a small post-sign delay to let the
 * signer's service-worker / port settle before the next call. Knock-on
 * effect: when bark's background script naps, only ONE request waits
 * on it instead of all of them piling up and timing out together.
 *
 * The wrapped signer keeps the same interface as the original — no
 * call site changes. Just wrap once at session-set time.
 */

import type { SignetSigner } from 'signet-login';
type Signer = SignetSigner;

/** Min gap between consecutive sign attempts in ms. Lets bark's service
 *  worker write its response back through the messaging port before
 *  the next request lands. 50ms is empirically enough; raising it
 *  helps with stuck signers at the cost of slowing batch publishes. */
const POST_SIGN_GAP_MS = 80;

interface QueuedSign {
  template: Parameters<Signer['signEvent']>[0];
  resolve: (event: Awaited<ReturnType<Signer['signEvent']>>) => void;
  reject: (err: unknown) => void;
}

const queue: QueuedSign[] = [];
let processing = false;
let inFlight = false;
let lastSignFinishedAt = 0;

function runQueue(orig: Signer['signEvent']): void {
  if (processing) return;
  processing = true;
  void (async () => {
    while (queue.length > 0) {
      const task = queue.shift()!;
      // Respect the post-sign gap even across re-entry.
      const gap = Math.max(0, POST_SIGN_GAP_MS - (Date.now() - lastSignFinishedAt));
      if (gap > 0) await new Promise((r) => setTimeout(r, gap));
      inFlight = true;
      try {
        const ev = await orig(task.template);
        task.resolve(ev);
      } catch (err) {
        task.reject(err);
      } finally {
        inFlight = false;
        lastSignFinishedAt = Date.now();
      }
    }
    processing = false;
  })();
}

/** Wrap a signer so its signEvent is serialised globally. Returns a
 *  new Signer object that delegates everything else (capabilities,
 *  encrypt/decrypt) straight to the original.
 *
 *  IMPORTANT: call exactly once per session at session-set time. The
 *  queue is module-scoped, so a second wrap layer creates a queue of
 *  queues and serialises through twice (correct but wasteful). */
export function serialiseSigner(signer: Signer): Signer {
  const origSignEvent = signer.signEvent.bind(signer);
  return new Proxy(signer, {
    get(target, prop, receiver): unknown {
      if (prop === 'signEvent') {
        return (template: Parameters<Signer['signEvent']>[0]) => new Promise<Awaited<ReturnType<Signer['signEvent']>>>((resolve, reject) => {
          queue.push({ template, resolve, reject });
          runQueue(origSignEvent);
        });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** Number of pending sign requests waiting on the queue (excluding any
 *  currently in flight). Surfaced for UI debugging — a stuck signer
 *  shows as a growing pending count. */
export function pendingSignCount(): number {
  return queue.length + (inFlight ? 1 : 0);
}
