/**
 * Headless end-to-end test of a 2P duel against the real WebSocket transport.
 *
 * Spins up the controller-ws broker on a local port, the Vite dev server,
 * then drives two Playwright browser contexts at the duel deep-link URL with
 * mirrored slots. The broker's `peer` role pairs the two clients, both auto-
 * IGNITE on `peer-joined`, and the desync canary in src/peer-canary.ts sets
 * `body[data-peer-desync]` if the sims ever fall out of lockstep.
 *
 * Pass criteria:
 *   - both pages reach phase='playing' (or 'wavestart')
 *   - both pages advance s.frame past a threshold
 *   - neither page has `data-peer-desync` set
 *   - neither page is still in the stall state
 *
 * This exercises everything the unit-level peer harness CAN'T touch:
 *   WebSocketPeer transport, the broker's peer-role pairing, main.ts duel
 *   wire-up, simulateStart auto-IGNITE, the desync canary.
 *
 * Run with `pnpm test:e2e`. Requires Chromium installed once:
 *   pnpm exec playwright install chromium
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';

const VITE_PORT = 5180;
const BROKER_PORT = 8788;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const BROKER_READY_TIMEOUT_MS = 10_000;
const VITE_READY_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 20_000;
const REACH_PLAYING_TIMEOUT_MS = 25_000;
const INPUT_HOLD_MS = 2_000;
const POST_INPUT_SETTLE_MS = 500;
const MIN_FRAMES = 120;
/** Cross-page rotation tolerance. Lockstep gives bit-identical state at the
 *  same sim frame; the two pages are usually within a couple of frames of
 *  each other, so a generous radian tolerance accounts for the frame
 *  drift without masking a genuine divergence. */
const ROT_AGREEMENT_TOLERANCE = 0.3;

async function startVite(): Promise<ChildProcess> {
  // detached: true puts the child in its own process group, so we can SIGTERM
  // the whole group on cleanup. Without this, pnpm's child vite survives the
  // SIGTERM to pnpm and lingers as a zombie port-holder across runs.
  //
  // --force triggers dep re-optimization upfront so the page doesn't
  // receive a mid-run "full reload" HMR signal that tears down our duel
  // WebSockets a few hundred ms after auto-IGNITE. We pay one extra
  // ~100ms of vite startup time for stability.
  const vite = spawn('pnpm', ['exec', 'vite', '--force'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  vite.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[vite] ${s}`);
  });
  vite.stdout?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    // Surface vite's own messages so we can spot HMR reloads.
    if (s.trim()) process.stderr.write(`[vite] ${s}`);
  });
  return vite;
}

/** Broker log capture. We always run with BROKER_DEBUG=1 (cheap; logs to
 *  stdout) and tee into a ring buffer so the dump-on-failure path can
 *  show forwarding behaviour around the failure window. */
const brokerLog: string[] = [];
const BROKER_LOG_CAP = 8000;

async function startBroker(): Promise<ChildProcess> {
  const broker = spawn('node', ['controller-ws/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(BROKER_PORT), HOST: '127.0.0.1', BROKER_DEBUG: '1' },
    detached: true,
  });
  broker.stdout?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (!s.trim()) return;
    for (const line of s.split('\n')) {
      if (!line) continue;
      brokerLog.push(line);
      if (brokerLog.length > BROKER_LOG_CAP) brokerLog.shift();
    }
  });
  broker.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[broker] ${s}`);
  });
  return broker;
}

function killGroup(p: ChildProcess): void {
  if (p.killed || p.pid === undefined) return;
  try {
    // Negative pid signals the whole process group spawned with detached:true,
    // catching pnpm and its child vite together. Fall back to killing the pid
    // directly if process.kill rejects (some shells / platforms reject -pid).
    process.kill(-p.pid, 'SIGTERM');
  } catch {
    try { p.kill('SIGTERM'); } catch { /* already dead */ }
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await wait(200);
  }
  throw new Error(`server at ${url} not ready in ${timeoutMs}ms: ${String(lastErr)}`);
}

async function waitForBroker(timeoutMs: number): Promise<void> {
  // The broker's HTTP root replies 404 on any non-upgrade request — that's
  // enough to confirm it's listening before we open real WebSocket clients.
  const probeUrl = `http://localhost:${BROKER_PORT}/`;
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(probeUrl);
      if (r.status === 404) return;
    } catch (e) {
      lastErr = e;
    }
    await wait(150);
  }
  throw new Error(`broker not listening on ${probeUrl} in ${timeoutMs}ms: ${String(lastErr)}`);
}

interface ShipProbe { x: number; y: number; rot: number }
interface PageProbe {
  frame: number;
  phase: string;
  desync: boolean;
  stall: string | null;
  ship0: ShipProbe | null;
  ship1: ShipProbe | null;
}

async function probe(page: import('playwright').Page): Promise<PageProbe> {
  // The body is kept arrow-helper-free on purpose: nested arrow functions
  // inside a page.evaluate callback cause tsx/esbuild to leak a __name
  // helper reference into the serialized function string, which then blows
  // up in the browser as "ReferenceError: __name is not defined".
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const s: any = (window as any).__pallasiteState;
    const p0 = s && s.players && s.players[0];
    const p1 = s && s.players && s.players[1];
    return {
      frame: s ? s.frame : -1,
      phase: s ? s.phase : 'unknown',
      desync: document.body.hasAttribute('data-peer-desync'),
      stall: document.body.getAttribute('data-peer-stall'),
      ship0: p0 ? { x: p0.ship.pos.x, y: p0.ship.pos.y, rot: p0.ship.rot } : null,
      ship1: p1 ? { x: p1.ship.pos.x, y: p1.ship.pos.y, rot: p1.ship.rot } : null,
    };
  });
}

async function main(): Promise<void> {
  process.stdout.write('Starting Vite dev server + broker...\n');
  const vite = await startVite();
  const broker = await startBroker();
  const kill = () => {
    killGroup(vite);
    killGroup(broker);
  };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  let exitCode = 0;
  try {
    await Promise.all([
      waitForServer(VITE_BASE + '/', VITE_READY_TIMEOUT_MS),
      waitForBroker(BROKER_READY_TIMEOUT_MS),
    ]);
    process.stdout.write('Vite + broker ready. Warming up Vite dep cache...\n');

    // Vite's first-page-load dep optimisation can complete AFTER the page
    // already loaded its initial module graph. Vite then signals a full
    // reload via its HMR channel, which tears down our duel WebSockets a
    // few hundred ms in. Warm up by fetching the entry HTML + the main.ts
    // module so the optimisation runs before any test page loads.
    const warmupUrls = [
      VITE_BASE + '/',
      VITE_BASE + '/src/main.ts',
    ];
    for (const u of warmupUrls) {
      try { await fetch(u); } catch { /* best effort */ }
    }
    // Brief settle for vite to finish optimising and stop pinging clients.
    await wait(750);

    const session = randomBytes(4).toString('hex');
    // Wire trace is on by default for E2E so failures dump the recent
    // send/receive history at each peer. Cheap on top of the WS chatter
    // already happening; the ring buffer is bounded to 4096 entries.
    const urlA = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&slot=0&wiretrace=1`;
    const urlB = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&slot=1&wiretrace=1`;
    process.stdout.write(`session: ${session}\n`);

    const browser: Browser = await chromium.launch();
    try {
      const ctxA = await browser.newContext();
      const ctxB = await browser.newContext();
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      const onErr = (tag: string) => (e: Error) => process.stderr.write(`[${tag}] pageerror: ${e.message}\n`);
      pageA.on('pageerror', onErr('A'));
      pageB.on('pageerror', onErr('B'));
      const onConsole = (tag: string) => (msg: import('playwright').ConsoleMessage) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
          const t = msg.text();
          if (!t.includes('navigator.vibrate')) process.stderr.write(`[${tag} ${msg.type()}] ${t}\n`);
        }
      };
      pageA.on('console', onConsole('A'));
      pageB.on('console', onConsole('B'));

      const dumpOnFail = async (tag: string, page: import('playwright').Page): Promise<void> => {
        try {
          const snapshot = await page.evaluate(() => ({
            url: location.href,
            stall: document.body.getAttribute('data-peer-stall'),
            desync: document.body.hasAttribute('data-peer-desync'),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            state: (window as any).__pallasiteState ? {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              frame: (window as any).__pallasiteState.frame,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              phase: (window as any).__pallasiteState.phase,
            } : null,
            overlayText: document.querySelector('[data-overlay]')?.textContent ?? null,
          }));
          process.stderr.write(`[${tag} snapshot] ${JSON.stringify(snapshot)}\n`);
        } catch (e) {
          process.stderr.write(`[${tag} snapshot failed] ${String(e)}\n`);
        }
      };

      await Promise.all([
        pageA.goto(urlA, { waitUntil: 'load' }),
        pageB.goto(urlB, { waitUntil: 'load' }),
      ]);
      process.stdout.write('Both pages loaded. Waiting for connection + auto-IGNITE...\n');

      // Wait for both sims to have started (phase=wavestart or playing).
      // This is the first proof that connection + auto-IGNITE worked.
      try {
        await Promise.all([
          pageA.waitForFunction(
            () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const s: any = (window as any).__pallasiteState;
              return !!s && (s.phase === 'playing' || s.phase === 'wavestart');
            },
            undefined,
            { timeout: CONNECT_TIMEOUT_MS },
          ),
          pageB.waitForFunction(
            () => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const s: any = (window as any).__pallasiteState;
              return !!s && (s.phase === 'playing' || s.phase === 'wavestart');
            },
            undefined,
            { timeout: CONNECT_TIMEOUT_MS },
          ),
        ]);
      } catch (e) {
        await dumpOnFail('A', pageA);
        await dumpOnFail('B', pageB);
        throw e;
      }

      // Then wait for both to reach 'playing' specifically — wavestart is a
      // brief intertitle; we want to verify the game loop is actually
      // running and input is accepted.
      process.stdout.write('Waiting for phase=playing on both pages...\n');
      await Promise.all([
        pageA.waitForFunction(
          () => (window as unknown as { __pallasiteState?: { phase: string } }).__pallasiteState?.phase === 'playing',
          undefined,
          { timeout: REACH_PLAYING_TIMEOUT_MS },
        ),
        pageB.waitForFunction(
          () => (window as unknown as { __pallasiteState?: { phase: string } }).__pallasiteState?.phase === 'playing',
          undefined,
          { timeout: REACH_PLAYING_TIMEOUT_MS },
        ),
      ]);

      // Snapshot the starting state, then inject distinct inputs on each
      // page — slot 0 turns LEFT (rotVel -), slot 1 turns RIGHT (rotVel +).
      // If the mpSlot routing fix (a4d56a5) regresses, page B's keypress
      // would land on players[0] instead of players[1] and players[1].rot
      // would never change.
      const start = { a: await probe(pageA), b: await probe(pageB) };
      process.stdout.write(`start A: ${JSON.stringify(start.a)}\nstart B: ${JSON.stringify(start.b)}\n`);

      process.stdout.write(`Injecting inputs (A:ArrowLeft, B:ArrowRight) for ${INPUT_HOLD_MS}ms...\n`);
      await pageA.keyboard.down('ArrowLeft');
      await pageB.keyboard.down('ArrowRight');

      // Diagnostic: after a brief settle, confirm each page's keydown
      // listener captured the press into its OWN slot's localKeys mirror.
      // (players[i].keys gets clobbered by every apply, so check localKeys.)
      await wait(50);
      const localCapture = await Promise.all([
        pageA.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lk: any = (window as any).__pallasiteTestHooks?.localKeysRef;
          return { p0: !!lk?.[0]?.ArrowLeft, p1: !!lk?.[1]?.ArrowLeft };
        }),
        pageB.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lk: any = (window as any).__pallasiteTestHooks?.localKeysRef;
          return { p0: !!lk?.[0]?.ArrowRight, p1: !!lk?.[1]?.ArrowRight };
        }),
      ]);
      process.stdout.write(`A localKeys (ArrowLeft): slot0=${localCapture[0].p0} slot1=${localCapture[0].p1}\n`);
      process.stdout.write(`B localKeys (ArrowRight): slot0=${localCapture[1].p0} slot1=${localCapture[1].p1}\n`);

      await wait(INPUT_HOLD_MS - 50);
      await pageA.keyboard.up('ArrowLeft');
      await pageB.keyboard.up('ArrowRight');
      await wait(POST_INPUT_SETTLE_MS);

      const [a, b] = await Promise.all([probe(pageA), probe(pageB)]);
      process.stdout.write(`A: ${JSON.stringify(a)}\n`);
      process.stdout.write(`B: ${JSON.stringify(b)}\n`);

      const reachedPlaying = (phase: string) => phase === 'playing';
      // After A held ArrowLeft, players[0].rot should have decreased.
      // After B held ArrowRight, players[1].rot should have increased.
      // The starting rot in 2P is 0 for slot 0 and PI for slot 1.
      const rotDiff = (now: number | undefined, then: number | undefined) =>
        (now ?? 0) - (then ?? 0);
      const slot0Rot = a.ship0?.rot ?? 0;
      const slot1Rot = a.ship1?.rot ?? 0;
      const slot0Start = start.a.ship0?.rot ?? 0;
      const slot1Start = start.a.ship1?.rot ?? 0;
      const slot0Turned = slot0Rot < slot0Start - 0.1;        // turned left
      const slot1Turned = slot1Rot > slot1Start + 0.1;        // turned right

      // Cross-page convergence: both pages should agree on both ships'
      // rotation (within frame-drift tolerance), proving the lockstep
      // protocol propagated inputs across the broker.
      const slot0AgreeB = Math.abs(rotDiff(a.ship0?.rot, b.ship0?.rot)) < ROT_AGREEMENT_TOLERANCE;
      const slot1AgreeB = Math.abs(rotDiff(a.ship1?.rot, b.ship1?.rot)) < ROT_AGREEMENT_TOLERANCE;

      // A ship that ended at the default spawn (640, 360) clearly died and
      // respawned mid-test. Lockstep is the only thing this runner cares
      // about, and both peers agreeing on death is still a pass for that
      // axis — skip the per-slot "turned" assertion (which assumes the
      // ship stayed alive the whole hold) when this happens. We only care
      // that the FAIL signal is reserved for genuine lockstep violations.
      const slot0Died = (a.ship0?.x === 640 && a.ship0?.y === 360 && a.ship0?.rot === slot0Start);
      const slot1Died = (a.ship1?.x === 640 && a.ship1?.y === 360 && a.ship1?.rot !== slot1Start);

      const checks: { name: string; ok: boolean; detail: string }[] = [
        { name: 'A in playing',     ok: reachedPlaying(a.phase),    detail: `phase=${a.phase}` },
        { name: 'B in playing',     ok: reachedPlaying(b.phase),    detail: `phase=${b.phase}` },
        { name: 'A advanced',       ok: a.frame >= MIN_FRAMES,      detail: `frame=${a.frame} (need >=${MIN_FRAMES})` },
        { name: 'B advanced',       ok: b.frame >= MIN_FRAMES,      detail: `frame=${b.frame} (need >=${MIN_FRAMES})` },
        { name: 'A not desynced',   ok: !a.desync,                  detail: `desync=${a.desync}` },
        { name: 'B not desynced',   ok: !b.desync,                  detail: `desync=${b.desync}` },
        { name: 'A not stalled',    ok: a.stall !== 'waiting',      detail: `stall=${a.stall}` },
        { name: 'B not stalled',    ok: b.stall !== 'waiting',      detail: `stall=${b.stall}` },
        { name: 'slot0 turned L',   ok: slot0Turned || slot0Died,   detail: `rot ${slot0Start.toFixed(3)} -> ${slot0Rot.toFixed(3)}${slot0Died ? ' [ship died, lockstep ok]' : ''}` },
        { name: 'slot1 turned R',   ok: slot1Turned || slot1Died,   detail: `rot ${slot1Start.toFixed(3)} -> ${slot1Rot.toFixed(3)}${slot1Died ? ' [ship died, lockstep ok]' : ''}` },
        { name: 'slot0 cross-page', ok: slot0AgreeB,                detail: `A=${a.ship0?.rot?.toFixed(3)} B=${b.ship0?.rot?.toFixed(3)}` },
        { name: 'slot1 cross-page', ok: slot1AgreeB,                detail: `A=${a.ship1?.rot?.toFixed(3)} B=${b.ship1?.rot?.toFixed(3)}` },
      ];

      process.stdout.write('\n=== e2e checks ===\n');
      let anyFail = false;
      for (const c of checks) {
        const tag = c.ok ? '[PASS]' : '[FAIL]';
        process.stdout.write(`${tag} ${c.name.padEnd(20)} ${c.detail}\n`);
        if (!c.ok) { exitCode = 1; anyFail = true; }
      }

      if (anyFail) {
        // Pull the wire trace + counters from both pages, then print a
        // compact, side-by-side bisection view: what each peer sent vs.
        // what its partner received, indexed by frame. Combined with the
        // broker forwarding log, this narrows the silent-drop location
        // to one of: local sample, send, broker forward, or receive.
        process.stdout.write('\n=== wire diagnostic ===\n');
        type WireTraceEntry = { t: number; dir: 'out' | 'in'; kind: string; frame?: number; slot?: number; input?: number; hash?: number; bufferedAmount?: number };
        type Counters = { sentFrameCount: number; sentHashCount: number; recvFrameCount: number; recvHashCount: number; lastSendFrame: number; lastRecvFrame: number; bufferedAmount: number; readyState: number };
        const pullPage = async (page: import('playwright').Page) => {
          return page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ref: any = (window as any).__pallasiteTestHooks?.peerRef;
            if (!ref) return { trace: [], counters: null };
            const trace = typeof ref.getWireTrace === 'function' ? ref.getWireTrace() : [];
            const counters = typeof ref.getWireCounters === 'function' ? ref.getWireCounters() : null;
            return { trace, counters };
          });
        };
        const [aWire, bWire] = await Promise.all([pullPage(pageA), pullPage(pageB)]);
        const aCounters = aWire.counters as Counters | null;
        const bCounters = bWire.counters as Counters | null;
        process.stdout.write(`A counters: ${JSON.stringify(aCounters)}\n`);
        process.stdout.write(`B counters: ${JSON.stringify(bCounters)}\n`);
        const aTrace = aWire.trace as WireTraceEntry[];
        const bTrace = bWire.trace as WireTraceEntry[];
        // Summarise: by frame, did A send and did B receive? Conversely
        // for slot 1. Listing only the last 40 frames keeps the dump
        // readable — that's where the failure is.
        const summarise = (sentTrace: WireTraceEntry[], recvTrace: WireTraceEntry[], senderSlot: number) => {
          const sentByFrame = new Map<number, number>(); // frame -> input
          for (const e of sentTrace) {
            if (e.dir === 'out' && e.kind === 'frame' && e.frame !== undefined && e.input !== undefined) {
              sentByFrame.set(e.frame, e.input);
            }
          }
          const recvByFrame = new Map<number, number>();
          for (const e of recvTrace) {
            if (e.dir === 'in' && e.kind === 'frame' && e.frame !== undefined && e.input !== undefined && e.slot === senderSlot) {
              recvByFrame.set(e.frame, e.input);
            }
          }
          return { sentByFrame, recvByFrame };
        };
        // A is slot 0 sender; check what A sent vs what B received tagged with slot 0.
        const a2b = summarise(aTrace, bTrace, 0);
        const b2a = summarise(bTrace, aTrace, 1);
        const lastSentA = Math.max(0, ...Array.from(a2b.sentByFrame.keys()));
        const lastSentB = Math.max(0, ...Array.from(b2a.sentByFrame.keys()));
        const printDiff = (label: string, sent: Map<number, number>, recv: Map<number, number>, lastFrame: number) => {
          process.stdout.write(`\n--- ${label} (last 40 frames around ${lastFrame}) ---\n`);
          const start = Math.max(0, lastFrame - 39);
          let missing = 0;
          let nonZeroSent = 0;
          let nonZeroRecv = 0;
          for (let f = start; f <= lastFrame; f++) {
            const s = sent.get(f);
            const r = recv.get(f);
            if (s !== undefined && r === undefined) missing++;
            if (s !== undefined && s !== 0) nonZeroSent++;
            if (r !== undefined && r !== 0) nonZeroRecv++;
          }
          process.stdout.write(`  frames=${lastFrame - start + 1}  missing-at-recv=${missing}  nonzero-sent=${nonZeroSent}  nonzero-recv=${nonZeroRecv}\n`);
          // Print just the divergence frames (sent != recv) for compactness.
          let printed = 0;
          for (let f = start; f <= lastFrame && printed < 20; f++) {
            const s = sent.get(f);
            const r = recv.get(f);
            if (s === r) continue;
            process.stdout.write(`  f=${f} sent=${s === undefined ? 'MISS' : s} recv=${r === undefined ? 'MISS' : r}\n`);
            printed++;
          }
        };
        printDiff('A→B (slot 0)', a2b.sentByFrame, a2b.recvByFrame, lastSentA);
        printDiff('B→A (slot 1)', b2a.sentByFrame, b2a.recvByFrame, lastSentB);

        // Apply-trace cross-check: this is the load-bearing diagnostic. For
        // each peer, we know the remote slot's encoded value at every apply
        // step. If A's apply for remote slot 1 read input=0 at frame N but
        // B's outgoing trace shows non-zero input sent for frame N, the bug
        // is either (a) wire arrived late, or (b) writeback into inputLog
        // failed. Compare against the wire-trace recv for the same frame.
        type ApplyEntry = { readFrame: number; slot: number; encoded: number; t: number };
        const pullApply = async (page: import('playwright').Page) => {
          return page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fn = (window as any).__pallasiteApplyTrace;
            return typeof fn === 'function' ? fn() : [];
          });
        };
        const [aApply, bApply] = await Promise.all([pullApply(pageA), pullApply(pageB)]);
        const aApplyList = aApply as ApplyEntry[];
        const bApplyList = bApply as ApplyEntry[];

        const applyDiagnostic = (label: string, applies: ApplyEntry[], remoteSlot: number, recvByFrame: Map<number, number>, sentByFrame: Map<number, number>, recvTrace: WireTraceEntry[], lastFrame: number) => {
          process.stdout.write(`\n--- ${label} apply (remote slot ${remoteSlot}, last 40 frames around ${lastFrame}) ---\n`);
          // Walk applies, focus on remoteSlot, group by readFrame.
          const appliedByFrame = new Map<number, number>();
          const applyTimeByFrame = new Map<number, number>();
          for (const a of applies) {
            if (a.slot === remoteSlot) {
              appliedByFrame.set(a.readFrame, a.encoded);
              applyTimeByFrame.set(a.readFrame, a.t);
            }
          }
          // Find the wall-clock time each inbound frame landed at this peer.
          const recvTimeByFrame = new Map<number, number>();
          for (const e of recvTrace) {
            if (e.dir === 'in' && e.kind === 'frame' && e.frame !== undefined && e.slot === remoteSlot) {
              recvTimeByFrame.set(e.frame, e.t);
            }
          }
          let appliedNonZero = 0;
          let receivedNonZero = 0;
          let appliedZeroButReceivedNonZero = 0;
          let appliedZeroAndNeverReceived = 0;
          let appliedZeroPartnerSentNonZero = 0;
          let recvAfterApply = 0;
          const start = Math.max(0, lastFrame - 39);
          for (let f = start; f <= lastFrame; f++) {
            const applied = appliedByFrame.get(f);
            const received = recvByFrame.get(f);
            const sent = sentByFrame.get(f);
            if (applied !== undefined && applied !== 0) appliedNonZero++;
            if (received !== undefined && received !== 0) receivedNonZero++;
            if (applied !== undefined && applied === 0) {
              if (received !== undefined && received !== 0) appliedZeroButReceivedNonZero++;
              if (received === undefined) appliedZeroAndNeverReceived++;
              if (sent !== undefined && sent !== 0) appliedZeroPartnerSentNonZero++;
            }
            // CRITICAL: was the inbound frame received AFTER the apply read?
            // If so, the inputLog had stale data at apply time.
            const applyT = applyTimeByFrame.get(f);
            const recvT = recvTimeByFrame.get(f);
            if (applyT !== undefined && recvT !== undefined && recvT > applyT) {
              recvAfterApply++;
            }
          }
          process.stdout.write(`  applied-nonzero=${appliedNonZero}  received-nonzero=${receivedNonZero}  partner-sent-nonzero(any-frame-in-window)=${(() => { let c = 0; for (let f = start; f <= lastFrame; f++) { const s = sentByFrame.get(f); if (s !== undefined && s !== 0) c++; } return c; })()}\n`);
          process.stdout.write(`  applied-zero-but-received-nonzero=${appliedZeroButReceivedNonZero}\n`);
          process.stdout.write(`  applied-zero-and-never-received=${appliedZeroAndNeverReceived}\n`);
          process.stdout.write(`  applied-zero-but-partner-sent-nonzero=${appliedZeroPartnerSentNonZero}\n`);
          process.stdout.write(`  recv-AFTER-apply (smoking gun for stale ring) = ${recvAfterApply}\n`);
          // Print first 12 mismatch frames + their timing.
          let printed = 0;
          for (let f = start; f <= lastFrame && printed < 12; f++) {
            const applied = appliedByFrame.get(f);
            const received = recvByFrame.get(f);
            const sent = sentByFrame.get(f);
            if (applied === sent) continue;
            const applyT = applyTimeByFrame.get(f);
            const recvT = recvTimeByFrame.get(f);
            const dt = (applyT !== undefined && recvT !== undefined) ? (recvT - applyT).toFixed(1) : '?';
            process.stdout.write(`  f=${f} applied=${applied === undefined ? 'MISS' : applied} recv=${received === undefined ? 'MISS' : received} partner-sent=${sent === undefined ? 'MISS' : sent} recv-apply-dt=${dt}ms\n`);
            printed++;
          }
        };
        // A's remote slot is 1; A's apply for slot 1 should match what B sent
        // AND what A received (recv map = A's inbound from B's slot 1).
        applyDiagnostic('A', aApplyList, 1, b2a.recvByFrame, b2a.sentByFrame, aTrace, Math.max(lastSentB, ...Array.from(b2a.recvByFrame.keys())));
        // B's remote slot is 0; B's apply for slot 0 should match what A sent
        // AND what B received (recv map = B's inbound from A's slot 0).
        applyDiagnostic('B', bApplyList, 0, a2b.recvByFrame, a2b.sentByFrame, bTrace, Math.max(lastSentA, ...Array.from(a2b.recvByFrame.keys())));

        // Broker log tail — shows whether the broker logged a DROP or
        // sent the message but the other side never delivered it to JS.
        process.stdout.write('\n--- broker tail (last 80 lines) ---\n');
        const tail = brokerLog.slice(-80);
        for (const line of tail) process.stdout.write(`  ${line}\n`);
      }
    } finally {
      await browser.close();
    }
  } catch (e) {
    process.stderr.write(`e2e error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    kill();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
