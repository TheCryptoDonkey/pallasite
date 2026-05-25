/**
 * Spectator late-join: prove a peerwatch that connects AFTER the duel
 * has already started still catches up and plays the live sim.
 *
 * The original peerwatch protocol fanned out new frames only — nothing
 * was buffered. A spectator that joined a few hundred ms into the run
 * missed frame 0..N from each peer, its inputLog stall-checked forever
 * at frame 5 (the activeDelay), and state.frame never advanced past 5.
 *
 * Fix lives in the broker: keep a small ring of recent peer frames per
 * session and replay them on peerwatch attach. This test starts the
 * peers first, lets them play for a fixed window, THEN attaches the
 * spectator and asserts it reaches a sensible frame count. Without the
 * replay buffer the spectator stalls at ~5; with it, it catches up.
 *
 * Run via `pnpm run test:spectate-latejoin`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5181;
const BROKER_PORT = 8789;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const BROKER_READY_TIMEOUT_MS = 10_000;
const REACH_PLAYING_TIMEOUT_MS = 25_000;
/** How long the peers play BEFORE the spectator joins — enough to
 *  guarantee they're well past frame 5 (the stall window). 3s @ 60Hz
 *  = ~180 frames. */
const PRE_SPECTATOR_DELAY_MS = 3_000;
/** How long the spectator gets to catch up after attaching. */
const SPECTATOR_CATCHUP_MS = 6_000;
/** The spectator must reach at least this frame count for the run to
 *  pass. Picked well above 5 (the stall window) but below what the
 *  peers will reach in the catch-up window — proves the broker
 *  replayed missed frames AND the spectator stayed alive long enough
 *  to play them. */
const SPECTATOR_MIN_FRAME = 100;

async function startVite(): Promise<ChildProcess> {
  const vite = spawn('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--force'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  vite.stderr?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[vite] ${s}`); });
  return vite;
}
async function startBroker(): Promise<ChildProcess> {
  const broker = spawn('node', ['controller-ws/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(BROKER_PORT), HOST: '127.0.0.1' },
    detached: true,
  });
  broker.stderr?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[broker] ${s}`); });
  return broker;
}
function killGroup(p: ChildProcess): void {
  if (p.killed || p.pid === undefined) return;
  try { process.kill(-p.pid, 'SIGTERM'); }
  catch { try { p.kill('SIGTERM'); } catch { /* already dead */ } }
}
async function waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await wait(150);
  }
  throw new Error(`${label} not ready at ${url}`);
}

async function pilot(page: Page): Promise<void> {
  // Tap a couple of keys so the peers actually generate input frames.
  // Pure idle would still work for the buffer mechanic, but having
  // varied input proves the spectator replays each peer's slot correctly.
  for (let i = 0; i < 10; i++) {
    await page.keyboard.down('ArrowLeft');
    await wait(120);
    await page.keyboard.up('ArrowLeft');
    await wait(80);
    await page.keyboard.down('Space');
    await wait(120);
    await page.keyboard.up('Space');
    await wait(80);
  }
}

interface StateProbe {
  phase: string;
  frame: number;
  peerActive: boolean;
  /** [slot0Count, slot1Count] — number of frames in [0..800] each slot has a value for. */
  inputLog0: [number, number] | null;
  firstNonEmpty0: number;
  firstNonEmpty1: number;
}

async function pullState(page: Page): Promise<StateProbe> {
  return page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { phase: string; frame: number } }).__pallasiteState;
    const peerActive = !!(window as unknown as { __pallasitePeerActive?: boolean }).__pallasitePeerActive;
    const probeFn = (window as unknown as { __pallasiteInputLogProbe?: (a: number, b: number) => Array<[number, number, number]> | null }).__pallasiteInputLogProbe;
    // Probe a wide range and count how many frames each slot has data for.
    const probe = typeof probeFn === 'function' ? probeFn(0, 800) : null;
    let slot0Count = 0, slot1Count = 0;
    let firstNonEmpty0 = -1, firstNonEmpty1 = -1;
    if (probe) {
      for (const [f, sl, v] of probe) {
        if (v >= 0) {
          if (sl === 0) { slot0Count++; if (firstNonEmpty0 < 0) firstNonEmpty0 = f; }
          else if (sl === 1) { slot1Count++; if (firstNonEmpty1 < 0) firstNonEmpty1 = f; }
        }
      }
    }
    const inputLog0 = probe ? [slot0Count, slot1Count] as [number, number] : null;
    return {
      phase: s?.phase ?? 'unknown',
      frame: s?.frame ?? -1,
      peerActive,
      inputLog0,
      firstNonEmpty0,
      firstNonEmpty1,
    };
  });
}

interface Check { name: string; pass: boolean; detail: string; }
const checks: Check[] = [];
function pass(name: string, detail = ''): void { checks.push({ name, pass: true, detail }); }
function fail(name: string, detail = ''): void { checks.push({ name, pass: false, detail }); }

async function main(): Promise<void> {
  process.stdout.write('Starting Vite + broker...\n');
  const vite = await startVite();
  const broker = await startBroker();
  const kill = (): void => { killGroup(vite); killGroup(broker); };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  let exitCode = 0;
  try {
    await Promise.all([
      waitForHttp(VITE_BASE + '/', VITE_READY_TIMEOUT_MS, 'vite'),
      waitForHttp(`http://localhost:${BROKER_PORT}/`, BROKER_READY_TIMEOUT_MS, 'broker'),
    ]);

    const session = randomBytes(4).toString('hex');
    const peerEnc = encodeURIComponent(BROKER_URL);
    const peerWatchEnc = encodeURIComponent(`${BROKER_URL}/?s=${session}&r=peerwatch`);
    const urlA = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=0`;
    const urlB = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=1`;
    const urlSpec = `${VITE_BASE}/?spectate=${session}&peer=${peerWatchEnc}`;
    process.stdout.write(`session: ${session}\n`);

    const browser: Browser = await chromium.launch();
    try {
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      // Peers FIRST — spectator joins later.
      await Promise.all([pageA.goto(urlA, { waitUntil: 'load' }), pageB.goto(urlB, { waitUntil: 'load' })]);

      const waitPlaying = (page: Page, tag: string): Promise<void> => page.waitForFunction(
        () => (window as unknown as { __pallasiteState?: { phase: string } }).__pallasiteState?.phase === 'playing',
        undefined,
        { timeout: REACH_PLAYING_TIMEOUT_MS },
      ).then(() => process.stdout.write(`  ${tag} playing\n`));
      await Promise.all([waitPlaying(pageA, 'A'), waitPlaying(pageB, 'B')]);

      // Drive a bit of input so the peers have real frames on the wire.
      process.stdout.write('driving peers (no spectator yet)…\n');
      const pilotPromise = Promise.all([
        pilot(pageA).catch(() => { /* page may close on test end */ }),
        pilot(pageB).catch(() => { /* same */ }),
      ]);

      // Let the duel run for the configured window before the spectator joins.
      await wait(PRE_SPECTATOR_DELAY_MS);

      // Snapshot peers' frame count at the moment of attach so we know
      // how far behind the spectator starts.
      const aBefore = await pullState(pageA);
      const bBefore = await pullState(pageB);
      process.stdout.write(`peers at spectator-attach: A=${aBefore.frame} B=${bBefore.frame}\n`);

      // Now attach the spectator. This is the critical moment — broker
      // must have buffered enough frame history that the spectator
      // can pass its stall check at frame 5.
      const ctxS = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const pageS = await ctxS.newPage();
      pageS.on('console', (msg) => {
        const t = msg.type();
        if (t === 'warning' || t === 'error' || msg.text().includes('spectate')) {
          process.stderr.write(`[S/${t}] ${msg.text()}\n`);
        }
      });
      pageS.on('pageerror', (e) => process.stderr.write(`[S/pageerror] ${e.message}\n`));
      await pageS.goto(urlSpec, { waitUntil: 'load' });
      await waitPlaying(pageS, 'S');

      // Give the spectator the catch-up window to advance.
      await wait(SPECTATOR_CATCHUP_MS);
      // Allow pilots to settle out so we don't race their teardown.
      await Promise.race([pilotPromise, wait(500)]);

      const aAfter = await pullState(pageA);
      const bAfter = await pullState(pageB);
      const sAfter = await pullState(pageS);
      process.stdout.write(`final frames: A=${aAfter.frame} B=${bAfter.frame} S=${sAfter.frame}\n`);
      process.stdout.write(`S.peerActive=${sAfter.peerActive}  S.inputLog populated [slot0,slot1]=${JSON.stringify(sAfter.inputLog0)}  first non-empty: slot0@${sAfter.firstNonEmpty0} slot1@${sAfter.firstNonEmpty1}\n`);

      // === Assertions ===
      if (sAfter.phase === 'playing') pass('S still playing', `phase=${sAfter.phase}`);
      else fail('S still playing', `phase=${sAfter.phase}`);

      if (sAfter.frame > SPECTATOR_MIN_FRAME) {
        pass('S advanced past stall window', `frame=${sAfter.frame} > ${SPECTATOR_MIN_FRAME}`);
      } else {
        fail('S advanced past stall window', `frame=${sAfter.frame} (need > ${SPECTATOR_MIN_FRAME}) — broker likely not buffering missed frames`);
      }
      // S should be CLOSE to A/B; allow some lag for the catch-up window.
      const peerFrame = Math.min(aAfter.frame, bAfter.frame);
      const lag = peerFrame - sAfter.frame;
      if (lag < 200) pass('S within lag budget', `lag=${lag} frames`);
      else fail('S within lag budget', `lag=${lag} frames (need < 200)`);
    } finally {
      await browser.close();
    }
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    kill();
  }

  process.stdout.write('\n=== spectator late-join checks ===\n');
  let failed = 0;
  for (const c of checks) {
    const marker = c.pass ? '[PASS]' : '[FAIL]';
    process.stdout.write(`${marker} ${c.name.padEnd(32)} ${c.detail}\n`);
    if (!c.pass) failed++;
  }
  if (failed > 0 && exitCode === 0) exitCode = 1;
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
