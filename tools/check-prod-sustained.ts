/**
 * Sustained WS traffic test against the production broker. Two peers
 * exchange frames at a high rate for several seconds and we count
 * every message sent vs received. If messages get lost, we isolate
 * whether the broker / network is the culprit (vs the browser).
 *
 * Run via `pnpm exec tsx tools/check-prod-sustained.ts`.
 */

import { randomBytes } from 'node:crypto';

const BROKER = process.env.BROKER ?? 'wss://controller.pallasite.app';
const DURATION_MS = 5_000;
const SEND_INTERVAL_MS = 17;  // ~60Hz

interface Peer {
  ws: WebSocket;
  slot: 0 | 1;
  recv: Array<{ frame: number; t: number }>;
  sent: Array<{ frame: number; t: number }>;
  partnerJoined: boolean;
}

function open(session: string, slot: 0 | 1): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BROKER}/?s=${session}&r=peer`);
    const peer: Peer = { ws, slot, recv: [], sent: [], partnerJoined: false };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello-peer', session, slot, version: 1 }));
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const t = performance.now();
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let msg: { type: string; frame?: number };
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'peer-joined') {
        peer.partnerJoined = true;
        resolve(peer);
      } else if (msg.type === 'frame' && msg.frame !== undefined) {
        peer.recv.push({ frame: msg.frame, t });
      }
    });
    ws.addEventListener('error', () => reject(new Error(`peer ${slot} ws error`)));
    setTimeout(() => { if (!peer.partnerJoined) reject(new Error(`peer ${slot} hello-peer timeout`)); }, 5_000);
  });
}

async function main(): Promise<void> {
  const session = `sust-${randomBytes(4).toString('hex')}`;
  process.stdout.write(`broker: ${BROKER}\nsession: ${session}\n`);

  // Open BOTH peers. The first one will hang on partnerJoined until the
  // second connects, so we have to open them concurrently.
  const [pA, pB] = await Promise.all([open(session, 0), open(session, 1)]);
  process.stdout.write(`paired\n`);

  // Drive at SEND_INTERVAL_MS, alternating slot to mimic 2P lockstep.
  let frame = 0;
  const startWall = performance.now();
  const send = (p: Peer): void => {
    if (p.ws.readyState !== WebSocket.OPEN) return;
    const msg = { type: 'frame', frame, slot: p.slot, input: 0 };
    p.ws.send(JSON.stringify(msg));
    p.sent.push({ frame, t: performance.now() });
    frame++;
  };
  const timer = setInterval(() => {
    send(pA);
    send(pB);
    if (performance.now() - startWall > DURATION_MS) {
      clearInterval(timer);
    }
  }, SEND_INTERVAL_MS);

  await new Promise<void>((resolve) => setTimeout(resolve, DURATION_MS + 1000));

  // Analyse.
  process.stdout.write(`\n=== analysis ===\n`);
  process.stdout.write(`A sent ${pA.sent.length}  received ${pA.recv.length}  (lost ${pA.sent.length - pA.recv.length})\n`);
  process.stdout.write(`B sent ${pB.sent.length}  received ${pB.recv.length}  (lost ${pB.sent.length - pB.recv.length})\n`);
  process.stdout.write(`(B-frames-arrived-at-A = ${pA.recv.length}, A-frames-arrived-at-B = ${pB.recv.length})\n`);
  const aLastRecv = pA.recv.at(-1);
  const bLastRecv = pB.recv.at(-1);
  process.stdout.write(`A's last recv at t=${(aLastRecv?.t ?? 0).toFixed(0)}ms (frame ${aLastRecv?.frame})\n`);
  process.stdout.write(`B's last recv at t=${(bLastRecv?.t ?? 0).toFixed(0)}ms (frame ${bLastRecv?.frame})\n`);

  // Did messages stop arriving prematurely?
  const aGapToEnd = performance.now() - (aLastRecv?.t ?? 0);
  const bGapToEnd = performance.now() - (bLastRecv?.t ?? 0);
  if (aGapToEnd > 500) process.stdout.write(`A: no recv in last ${aGapToEnd.toFixed(0)}ms — MESSAGE LOSS or STREAM DIED\n`);
  if (bGapToEnd > 500) process.stdout.write(`B: no recv in last ${bGapToEnd.toFixed(0)}ms — MESSAGE LOSS or STREAM DIED\n`);

  pA.ws.close();
  pB.ws.close();
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
