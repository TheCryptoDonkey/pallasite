/**
 * Reproduce the production "P2 never moved" bug. Drives a real 2P duel
 * against pallasite.app: two browser contexts go to the lobby, host the
 * same session, both reach 'playing', then we sample each peer's view
 * of BOTH ships' frame numbers over several seconds. If lockstep is
 * working, each peer's view of frame N matches the other's. If P2 is
 * "stuck" on either screen, peer A's view of slot 1 won't advance.
 *
 * Run via `pnpm exec tsx tools/check-prod-duel.ts`. Read-only — opens
 * sessions with random IDs, never logs in.
 */

import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const TARGET = process.env.TARGET ?? 'https://pallasite.app';
const REACH_PLAYING_TIMEOUT_MS = 30_000;
const PLAY_DURATION_MS = 10_000;

interface Probe {
  phase: string;
  frame: number;
  ship0: { x: number; y: number; rot: number; alive: boolean } | null;
  ship1: { x: number; y: number; rot: number; alive: boolean } | null;
  peerActive: boolean;
}

async function pullProbe(page: Page): Promise<Probe> {
  // page.evaluate body is fully inlined — no nested functions — because
  // tsx/esbuild's `keep-names` helper leaks into the serialised script
  // and the production page doesn't have `__name` defined.
  return page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: {
      phase: string;
      frame: number;
      players: Array<{ ship: { pos: { x: number; y: number }; rot: number; alive: boolean } } | undefined>;
    } }).__pallasiteState;
    const peerActive = !!(window as unknown as { __pallasitePeerActive?: boolean }).__pallasitePeerActive;
    const p0 = s?.players?.[0];
    const p1 = s?.players?.[1];
    return {
      phase: s?.phase ?? 'unknown',
      frame: s?.frame ?? -1,
      ship0: p0 ? { x: p0.ship.pos.x, y: p0.ship.pos.y, rot: p0.ship.rot, alive: p0.ship.alive } : null,
      ship1: p1 ? { x: p1.ship.pos.x, y: p1.ship.pos.y, rot: p1.ship.rot, alive: p1.ship.alive } : null,
      peerActive,
    };
  });
}

async function main(): Promise<void> {
  process.stdout.write(`target: ${TARGET}\n`);

  // Pick a random session id — same on both peers so they pair.
  const session = randomBytes(4).toString('hex');
  process.stdout.write(`session: ${session}\n`);

  const browser: Browser = await chromium.launch();
  try {
    // Block service-worker registration so the test doesn't get caught
    // in the controllerchange → reload cycle that fires on a fresh
    // chromium with no prior SW. Real users on the second+ visit
    // already have the SW controlling and skip this dance.
    const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    // Lightweight visual style — disable the WebGL mesh overlay + CRT postFX
    // so the test isolates netcode behaviour from rendering cost. Real users
    // still get the CRT theme; this is purely to remove a confound when
    // diagnosing the 2P duel desync.
    const lightVisual = JSON.stringify({ asteroid: 'vector', ship: 'vector', bullet: 'vector', particle: 'vector', theme: 'none', asciiCols: 80, bitDepth: 8, bitColour: false });
    await ctxA.addInitScript((v) => { try { localStorage.setItem('pallasite:visualStyle', v); } catch { /* ignore */ } }, lightVisual);
    await ctxB.addInitScript((v) => { try { localStorage.setItem('pallasite:visualStyle', v); } catch { /* ignore */ } }, lightVisual);
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    const interesting = (msg: import('playwright').ConsoleMessage): boolean => {
      const t = msg.text();
      const type = msg.type();
      if (type === 'error' || type === 'warning') return true;
      return /\bduel\b|\bpeer\b|\bspectate\b|\bpeer-stall\b/i.test(t);
    };
    pageA.on('console', (m) => { if (interesting(m)) process.stderr.write(`[A/${m.type()}] ${m.text()}\n`); });
    pageB.on('console', (m) => { if (interesting(m)) process.stderr.write(`[B/${m.type()}] ${m.text()}\n`); });
    // Worker console messages fire on the worker, not the page, in newer
    // Playwright. Attach to each worker as it spawns.
    pageA.on('worker', (w) => w.on('console', (m) => process.stderr.write(`[A/worker/${m.type()}] ${m.text()}\n`)));
    pageB.on('worker', (w) => w.on('console', (m) => process.stderr.write(`[B/worker/${m.type()}] ${m.text()}\n`)));

    // Bypass the duel lobby — go straight to the game with peer params,
    // same shape the e2e harnesses use. The lobby's only job is to
    // assemble this URL anyway; from the game's perspective it's
    // identical.
    const broker = TARGET.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace('pallasite.app', 'controller.pallasite.app');
    const peerEnc = encodeURIComponent(broker);
    const urlA = `${TARGET}/?peer=${peerEnc}&session=${session}&slot=0`;
    const urlB = `${TARGET}/?peer=${peerEnc}&session=${session}&slot=1`;
    await Promise.all([pageA.goto(urlA, { waitUntil: 'load' }), pageB.goto(urlB, { waitUntil: 'load' })]);

    const waitPlaying = (page: Page, tag: string): Promise<void> => page.waitForFunction(
      () => (window as unknown as { __pallasiteState?: { phase: string } }).__pallasiteState?.phase === 'playing',
      undefined,
      { timeout: REACH_PLAYING_TIMEOUT_MS },
    ).then(() => process.stdout.write(`  ${tag} playing\n`));
    await Promise.all([waitPlaying(pageA, 'A'), waitPlaying(pageB, 'B')]);
    await wait(800);
    const [baselineA, baselineB] = await Promise.all([pullProbe(pageA), pullProbe(pageB)]);

    // Hold thrust through the whole measurement window. Production relay
    // stalls can make 2s of wall-clock pulses cover only a handful of sim
    // frames; measuring from a pre-input baseline avoids false "stuck"
    // verdicts when a ship moved before the first 1s sample.
    await Promise.all([pageA.keyboard.down('ArrowUp'), pageB.keyboard.down('ArrowUp')]);

    // Sample state every second for the duration.
    const samples: Array<{ t: number; a: Probe; b: Probe }> = [];
    const start = Date.now();
    while (Date.now() - start < PLAY_DURATION_MS) {
      await wait(1000);
      const [a, b] = await Promise.all([pullProbe(pageA), pullProbe(pageB)]);
      samples.push({ t: Date.now() - start, a, b });
      process.stdout.write(`t=${(samples.at(-1)!.t / 1000).toFixed(1)}s  A:frame=${a.frame} peerActive=${a.peerActive} ship0@(${a.ship0?.x.toFixed(0)},${a.ship0?.y.toFixed(0)}) ship1@(${a.ship1?.x.toFixed(0)},${a.ship1?.y.toFixed(0)})  B:frame=${b.frame} peerActive=${b.peerActive} ship0@(${b.ship0?.x.toFixed(0)},${b.ship0?.y.toFixed(0)}) ship1@(${b.ship1?.x.toFixed(0)},${b.ship1?.y.toFixed(0)})\n`);
    }
    await Promise.all([pageA.keyboard.up('ArrowUp'), pageB.keyboard.up('ArrowUp')]).catch(() => null);

    // Analysis: did EACH peer see BOTH ships' frames advance?
    const aFirst = baselineA;
    const aLast = samples.at(-1)!.a;
    const bFirst = baselineB;
    const bLast = samples.at(-1)!.b;

    // Pull wire trace from each peer to see what was actually on the wire.
    const trace = async (page: Page): Promise<{ trace: unknown[]; counters: unknown; isConnected: boolean }> => page.evaluate(() => {
      const ref = (window as unknown as { __pallasiteTestHooks?: { peerRef?: { getWireTrace?: () => unknown[]; getWireCounters?: () => unknown; isConnected?: () => boolean } } }).__pallasiteTestHooks?.peerRef;
      return {
        trace: ref?.getWireTrace ? ref.getWireTrace() : [],
        counters: ref?.getWireCounters ? ref.getWireCounters() : null,
        isConnected: ref?.isConnected ? ref.isConnected() : false,
      };
    });
    const [tA, tB] = await Promise.all([trace(pageA), trace(pageB)]);
    process.stdout.write(`\nA wire entries=${tA.trace.length} isConnected=${tA.isConnected} counters=${JSON.stringify(tA.counters)}\n`);
    process.stdout.write(`B wire entries=${tB.trace.length} isConnected=${tB.isConnected} counters=${JSON.stringify(tB.counters)}\n`);
    process.stdout.write(`A last 6 entries:\n`);
    for (const e of tA.trace.slice(-6)) process.stdout.write(`  ${JSON.stringify(e)}\n`);
    process.stdout.write(`B last 6 entries:\n`);
    for (const e of tB.trace.slice(-6)) process.stdout.write(`  ${JSON.stringify(e)}\n`);
    process.stdout.write('\n=== analysis ===\n');
    const aSimAdvanced = aLast.frame - aFirst.frame;
    const bSimAdvanced = bLast.frame - bFirst.frame;
    process.stdout.write(`A sim advanced ${aSimAdvanced} frames over ${(samples.at(-1)!.t / 1000).toFixed(1)}s\n`);
    process.stdout.write(`B sim advanced ${bSimAdvanced} frames over ${(samples.at(-1)!.t / 1000).toFixed(1)}s\n`);
    const aSlot1Moved = Math.hypot((aLast.ship1?.x ?? 0) - (aFirst.ship1?.x ?? 0), (aLast.ship1?.y ?? 0) - (aFirst.ship1?.y ?? 0));
    const bSlot0Moved = Math.hypot((bLast.ship0?.x ?? 0) - (bFirst.ship0?.x ?? 0), (bLast.ship0?.y ?? 0) - (bFirst.ship0?.y ?? 0));
    process.stdout.write(`A's view of slot 1 (B's ship) moved ${aSlot1Moved.toFixed(1)}px — ${aSlot1Moved > 10 ? 'OK' : 'STUCK'}\n`);
    process.stdout.write(`B's view of slot 0 (A's ship) moved ${bSlot0Moved.toFixed(1)}px — ${bSlot0Moved > 10 ? 'OK' : 'STUCK'}\n`);
    process.stdout.write(`A peerActive at end: ${aLast.peerActive}\n`);
    process.stdout.write(`B peerActive at end: ${bLast.peerActive}\n`);

    const verdict = aSlot1Moved > 10 && bSlot0Moved > 10 && aLast.peerActive && bLast.peerActive;
    if (verdict) process.stdout.write('\nproduction 2P duel is healthy.\n');
    else process.stdout.write('\nproduction 2P duel is BROKEN.\n');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
