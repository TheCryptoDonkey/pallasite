// Post-activation probe for the lockstep peer role. Run by activate-release.sh
// against the freshly restarted broker; a non-zero exit rolls the release back.
//
// Two regressions have shipped past /healthz with a healthy-looking broker:
//  1. A human taking over an AI-filled slot mid-round replays a catch-up burst
//     well above the controller message budget; refusing it (1008 message-budget)
//     makes late joins loop on reconnect.
//  2. A booth owning several slots sends `frame-set`; a broker that ignores it
//     leaves linked booths unable to see each other's inputs.
import { WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';

const base = (process.argv[2] ?? 'ws://127.0.0.1:8788/').replace(/\/$/, '');
const BURST = 600;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const fail = message => { console.error(`peer probe failed: ${message}`); process.exit(1); };
const session = label => `probe-${label}-${randomBytes(6).toString('hex')}`;

function peer(name, hello) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${base}/?s=${name}&r=peer`);
    ws.frames = []; ws.closed = null;
    ws.on('error', () => {});
    ws.on('message', data => { try { ws.frames.push(JSON.parse(data.toString())); } catch {} });
    ws.on('close', (code, reason) => { ws.closed = { code, reason: String(reason) }; });
    const timer = setTimeout(() => fail('timed out connecting'), 10_000);
    ws.on('open', () => { clearTimeout(timer); ws.send(JSON.stringify(hello)); resolve(ws); });
  });
}

// 1. Catch-up burst must not be refused.
const burst = await peer(session('burst'), { type: 'hello-peer', slot: 0, version: 1, players: 2 });
for (let frame = 0; frame < BURST; frame++) burst.send(JSON.stringify({ type: 'frame', frame, slot: 0, input: 1 }));
await wait(500);
if (burst.closed || burst.readyState !== WebSocket.OPEN) fail(`peer closed during a ${BURST}-message burst (${burst.closed?.code} ${burst.closed?.reason})`);
burst.close();

// 2. A multi-slot owner's frame-set must reach the other booth.
const room = session('set');
const booth = await peer(room, { type: 'hello-peer', slot: 0, version: 1, players: 4, ownedSlots: [0, 1] });
const other = await peer(room, { type: 'hello-peer', slot: 2, version: 1, players: 4 });
await wait(300);
booth.send(JSON.stringify({ type: 'frame-set', frame: 5, entries: [[0, 7], [1, 9]] }));
await wait(500);
if (!other.frames.some(frame => frame.type === 'frame-set')) fail('frame-set from a multi-slot booth was not relayed');
booth.close(); other.close();
console.log(`peer probe passed: ${BURST}-message burst accepted, frame-set relayed`);
setTimeout(() => process.exit(0), 50);
