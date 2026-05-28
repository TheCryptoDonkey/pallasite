/**
 * N-player deathmatch lockstep smoke.
 *
 * Starts the local broker + Vite app, opens four real browser clients into
 * one deathmatch session, drives a little input on every slot, and checks
 * that all clients advance without stalls/desyncs while holding four slots
 * in their input logs. Then repeats with two human slots and two AI-filled
 * slots to prove incomplete lobbies still start deterministically. It also
 * covers the lobby flow where P2 joins before the host presses READY.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5186;
const BROKER_PORT = 8794;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const PLAYERS = 4;

function startVite(): ChildProcess {
  const p = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  p.stdout?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[vite] ${s}`); });
  p.stderr?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[vite] ${s}`); });
  return p;
}

function startBroker(): ChildProcess {
  const p = spawn('node', ['controller-ws/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(BROKER_PORT), HOST: '127.0.0.1' },
    detached: true,
  });
  p.stdout?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[broker] ${s}`); });
  p.stderr?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[broker] ${s}`); });
  return p;
}

function killGroup(p: ChildProcess): void {
  if (p.pid === undefined || p.killed) return;
  try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch { /* ignore */ } }
}

async function waitForHttp(url: string, ok: (status: number) => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (ok(r.status)) return;
    } catch (e) {
      lastErr = e;
    }
    await wait(150);
  }
  throw new Error(`${url} not ready: ${String(lastErr)}`);
}

async function probe(page: Page, players = PLAYERS): Promise<{
  frame: number;
  phase: string;
  peerActive: boolean;
  desync: boolean;
  stall: string | null;
  players: number;
  aiPlayers: number;
  inputCounts: number[];
}> {
  return page.evaluate((players) => {
    const s = (window as any).__pallasiteState;
    const probeLog = (window as any).__pallasiteInputLogProbe as ((from: number, to: number) => Array<[number, number, number]> | null) | undefined;
    const counts = new Array(players).fill(0);
    const rows = probeLog ? probeLog(0, 90) : null;
    if (rows) {
      for (const [, slot, encoded] of rows) if (slot >= 0 && slot < players && encoded >= 0) counts[slot]++;
    }
    return {
      frame: s?.frame ?? -1,
      phase: s?.phase ?? 'unknown',
      peerActive: !!(window as any).__pallasitePeerActive,
      desync: document.body.hasAttribute('data-peer-desync'),
      stall: document.body.getAttribute('data-peer-stall'),
      players: Array.isArray(s?.players) ? s.players.length : 0,
      aiPlayers: Array.isArray(s?.players) ? s.players.filter((p: any) => p?.ai === true).length : -1,
      inputCounts: counts,
    };
  }, players);
}

async function runAllHumanScenario(browserInstance: Browser): Promise<void> {
  const session = randomBytes(4).toString('hex');
  const pages: Page[] = [];
  const gotos: Array<Promise<unknown>> = [];
  for (let slot = 0; slot < PLAYERS; slot++) {
    const ctx = await browserInstance.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => process.stderr.write(`[P${slot + 1}] ${e.message}\n`));
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
        process.stderr.write(`[P${slot + 1} ${msg.type()}] ${text}\n`);
      }
    });
    const url = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&slot=${slot}&players=${PLAYERS}&deathmatchPlayers=${PLAYERS}&mode=deathmatch&wiretrace=1&peerBatch=1`;
    pages.push(page);
    gotos.push(page.goto(url, { waitUntil: 'load' }));
  }
  await Promise.all(gotos);

  try {
    await Promise.all(pages.map((page) => page.waitForFunction(
      (players) => {
        const s = (window as any).__pallasiteState;
        return !!(window as any).__pallasitePeerActive && s?.phase === 'playing' && s?.players?.length === players;
      },
      PLAYERS,
      { timeout: 30_000 },
    )));
  } catch (e) {
    const probes = await Promise.all(pages.map((page) => probe(page)));
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      process.stderr.write(`startup P${i + 1}: frame=${p.frame} phase=${p.phase} peer=${p.peerActive} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
    }
    throw e;
  }

  await Promise.all([
    pages[0].keyboard.down('ArrowLeft'),
    pages[1].keyboard.down('ArrowRight'),
    pages[2].keyboard.down('ArrowUp'),
    pages[3].keyboard.down('Space'),
  ]);
  await wait(2200);
  await Promise.all(pages.map((page) => page.keyboard.up('ArrowLeft').catch(() => undefined)));
  await Promise.all(pages.map((page) => page.keyboard.up('ArrowRight').catch(() => undefined)));
  await Promise.all(pages.map((page) => page.keyboard.up('ArrowUp').catch(() => undefined)));
  await Promise.all(pages.map((page) => page.keyboard.up('Space').catch(() => undefined)));
  await wait(800);

  const probes = await Promise.all(pages.map((page) => probe(page)));
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    process.stdout.write(`P${i + 1}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
  }
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    if (!p.peerActive) throw new Error(`P${i + 1} peer inactive`);
    if (p.phase !== 'playing') throw new Error(`P${i + 1} not playing`);
    if (p.frame < 60) throw new Error(`P${i + 1} did not advance far enough`);
    if (p.players !== PLAYERS) throw new Error(`P${i + 1} wrong player count`);
    if (p.aiPlayers !== 0) throw new Error(`P${i + 1} still has AI-controlled network slots`);
    if (p.stall) throw new Error(`P${i + 1} stalled`);
    if (p.desync) throw new Error(`P${i + 1} desynced`);
    if (p.inputCounts.some((count) => count < 50)) throw new Error(`P${i + 1} missing input history`);
  }
  await Promise.all(pages.map((page) => page.context().close().catch(() => undefined)));
  process.stdout.write('N-player deathmatch lockstep PASS\n');
}

async function runAiFillScenario(browserInstance: Browser): Promise<void> {
  const session = randomBytes(4).toString('hex');
  const pages: Page[] = [];
  for (const slot of [1, 0]) {
    const ctx = await browserInstance.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => process.stderr.write(`[AI-fill P${slot + 1}] ${e.message}\n`));
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
        process.stderr.write(`[AI-fill P${slot + 1} ${msg.type()}] ${text}\n`);
      }
    });
    const humanSlots = slot === 0 ? '&humanSlots=0,1' : '';
    const url = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&slot=${slot}&players=${PLAYERS}&deathmatchPlayers=${PLAYERS}&mode=deathmatch&wiretrace=1&peerBatch=1&aiFill=1${humanSlots}`;
    pages.push(page);
    await page.goto(url, { waitUntil: 'load' });
  }
  try {
    await Promise.all(pages.map((page) => page.waitForFunction(
      (players) => {
        const s = (window as any).__pallasiteState;
        return !!(window as any).__pallasitePeerActive && s?.phase === 'playing' && s?.players?.length === players;
      },
      PLAYERS,
      { timeout: 30_000 },
    )));
  } catch (e) {
    const probes = await Promise.all(pages.map((page) => probe(page)));
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      process.stderr.write(`AI-fill startup P${i === 0 ? 2 : 1}: frame=${p.frame} phase=${p.phase} peer=${p.peerActive} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
    }
    throw e;
  }
  await Promise.all([
    pages[0].keyboard.down('ArrowRight'),
    pages[1].keyboard.down('ArrowLeft'),
  ]);
  await wait(2200);
  await Promise.all(pages.map((page) => page.keyboard.up('ArrowRight').catch(() => undefined)));
  await Promise.all(pages.map((page) => page.keyboard.up('ArrowLeft').catch(() => undefined)));
  await wait(800);
  const probes = await Promise.all(pages.map((page) => probe(page)));
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    process.stdout.write(`AI-fill P${i === 0 ? 2 : 1}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
    if (!p.peerActive) throw new Error(`AI-fill P${i + 1} peer inactive`);
    if (p.phase !== 'playing') throw new Error(`AI-fill P${i + 1} not playing`);
    if (p.frame < 60) throw new Error(`AI-fill P${i + 1} did not advance far enough`);
    if (p.players !== PLAYERS) throw new Error(`AI-fill P${i + 1} wrong player count`);
    if (p.aiPlayers !== 2) throw new Error(`AI-fill P${i + 1} expected two AI-filled slots`);
    if (p.stall) throw new Error(`AI-fill P${i + 1} stalled`);
    if (p.desync) throw new Error(`AI-fill P${i + 1} desynced`);
    if (p.inputCounts[0] < 50 || p.inputCounts[1] < 50) throw new Error(`AI-fill P${i + 1} missing human input history`);
  }
  const lateCtx = await browserInstance.newContext({ serviceWorkers: 'block' });
  const latePage = await lateCtx.newPage();
  latePage.on('pageerror', (e) => process.stderr.write(`[AI-fill late P3] ${e.message}\n`));
  latePage.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
      process.stderr.write(`[AI-fill late P3 ${msg.type()}] ${text}\n`);
    }
  });
  const lateUrl = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&slot=2&players=${PLAYERS}&deathmatchPlayers=${PLAYERS}&mode=deathmatch&wiretrace=1&peerBatch=1&aiFill=1`;
  await latePage.goto(lateUrl, { waitUntil: 'load' });
  await latePage.waitForFunction(
    (players) => {
      const s = (window as any).__pallasiteState;
      return !!(window as any).__pallasitePeerActive && s?.phase === 'playing' && s?.players?.length === players;
    },
    PLAYERS,
    { timeout: 30_000 },
  );
  pages.push(latePage);
  await latePage.keyboard.down('ArrowUp');
  await wait(4200);
  await latePage.keyboard.up('ArrowUp').catch(() => undefined);
  await Promise.all(pages.map((page) => page.waitForFunction(
    () => {
      const s = (window as any).__pallasiteState;
      return Array.isArray(s?.players) && s.players.length === 4 && s.players.filter((p: any) => p?.ai === true).length === 1;
    },
    undefined,
    { timeout: 10_000 },
  )));
  const takeoverProbes = await Promise.all(pages.map((page) => probe(page)));
  for (let i = 0; i < takeoverProbes.length; i++) {
    const p = takeoverProbes[i];
    const label = i === 2 ? 'late P3' : `P${i === 0 ? 2 : 1}`;
    process.stdout.write(`AI-fill takeover ${label}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
    if (!p.peerActive) throw new Error(`AI-fill takeover ${label} peer inactive`);
    if (p.phase !== 'playing') throw new Error(`AI-fill takeover ${label} not playing`);
    if (p.players !== PLAYERS) throw new Error(`AI-fill takeover ${label} wrong player count`);
    if (p.aiPlayers !== 1) throw new Error(`AI-fill takeover ${label} expected one remaining AI slot`);
    if (p.stall) throw new Error(`AI-fill takeover ${label} stalled`);
    if (p.desync) throw new Error(`AI-fill takeover ${label} desynced`);
  }
  await lateCtx.close().catch(() => undefined);
  await Promise.all(pages.map((page) => page.context().close().catch(() => undefined)));
  process.stdout.write('AI-filled deathmatch lockstep PASS\n');
}

async function runTwoPlayerLateTakeoverScenario(browserInstance: Browser): Promise<void> {
  const session = randomBytes(4).toString('hex');
  const hostCtx = await browserInstance.newContext({ serviceWorkers: 'block' });
  const lateCtx = await browserInstance.newContext({ serviceWorkers: 'block' });
  const host = await hostCtx.newPage();
  const late = await lateCtx.newPage();
  const pages = [host, late];
  for (let i = 0; i < pages.length; i++) {
    pages[i].on('pageerror', (e) => process.stderr.write(`[2P late P${i + 1}] ${e.message}\n`));
    pages[i].on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
        process.stderr.write(`[2P late P${i + 1} ${msg.type()}] ${text}\n`);
      }
    });
  }

  const base = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&players=2&deathmatchPlayers=2&mode=deathmatch&wiretrace=1&peerBatch=1&aiFill=1`;
  await host.goto(`${base}&slot=0&humanSlots=0`, { waitUntil: 'load' });
  await host.waitForFunction(
    () => {
      const s = (window as any).__pallasiteState;
      return !!(window as any).__pallasitePeerActive && s?.phase === 'playing' && s?.players?.length === 2 && s.players.filter((p: any) => p?.ai === true).length === 1;
    },
    undefined,
    { timeout: 30_000 },
  );
  await wait(1800);

  await late.goto(`${base}&slot=1`, { waitUntil: 'load' });
  await Promise.all(pages.map((page) => page.waitForFunction(
    () => {
      const s = (window as any).__pallasiteState;
      return !!(window as any).__pallasitePeerActive && s?.phase === 'playing' && s?.players?.length === 2;
    },
    undefined,
    { timeout: 30_000 },
  )));
  await Promise.all(pages.map((page) => page.waitForFunction(
    () => {
      const s = (window as any).__pallasiteState;
      return Array.isArray(s?.players) && s.players.length === 2 && s.players.filter((p: any) => p?.ai === true).length === 0;
    },
    undefined,
    { timeout: 30_000 },
  )));

  await Promise.all([
    host.keyboard.down('ArrowLeft'),
    late.keyboard.down('ArrowRight'),
  ]);
  await wait(4200);
  await Promise.all([
    host.keyboard.up('ArrowLeft').catch(() => undefined),
    late.keyboard.up('ArrowRight').catch(() => undefined),
  ]);
  await wait(800);

  const probes = await Promise.all(pages.map((page) => probe(page, 2)));
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    process.stdout.write(`2P late takeover P${i + 1}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
    if (!p.peerActive) throw new Error(`2P late takeover P${i + 1} peer inactive`);
    if (p.phase !== 'playing') throw new Error(`2P late takeover P${i + 1} not playing`);
    if (p.frame < 120) throw new Error(`2P late takeover P${i + 1} did not advance far enough`);
    if (p.players !== 2) throw new Error(`2P late takeover P${i + 1} wrong player count`);
    if (p.aiPlayers !== 0) throw new Error(`2P late takeover P${i + 1} still has AI-controlled slot`);
    if (p.stall) throw new Error(`2P late takeover P${i + 1} stalled`);
    if (p.desync) throw new Error(`2P late takeover P${i + 1} desynced`);
    if (p.inputCounts.some((count) => count < 50)) throw new Error(`2P late takeover P${i + 1} missing input history`);
  }
  await Promise.all(pages.map((page) => page.context().close().catch(() => undefined)));
  process.stdout.write('2P late takeover deathmatch lockstep PASS\n');
}

async function runTwoPlayerPrejoinedStartScenario(browserInstance: Browser): Promise<void> {
  const session = randomBytes(4).toString('hex');
  const joinCtx = await browserInstance.newContext({ serviceWorkers: 'block' });
  const hostCtx = await browserInstance.newContext({ serviceWorkers: 'block' });
  const joiner = await joinCtx.newPage();
  const host = await hostCtx.newPage();
  const pages = [host, joiner];
  for (let i = 0; i < pages.length; i++) {
    const label = i === 0 ? 'host P1' : 'prejoined P2';
    pages[i].on('pageerror', (e) => process.stderr.write(`[2P ${label}] ${e.message}\n`));
    pages[i].on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
        process.stderr.write(`[2P ${label} ${msg.type()}] ${text}\n`);
      }
    });
  }

  const base = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&players=2&deathmatchPlayers=2&mode=deathmatch&wiretrace=1&peerBatch=1&aiFill=1`;
  await joiner.goto(`${base}&slot=1`, { waitUntil: 'load' });
  await wait(1200);
  await host.goto(`${base}&slot=0&humanSlots=0,1`, { waitUntil: 'load' });
  await Promise.all(pages.map((page) => page.waitForFunction(
    () => {
      const s = (window as any).__pallasiteState;
      return !!(window as any).__pallasitePeerActive
        && s?.phase === 'playing'
        && s?.players?.length === 2
        && s.players.filter((p: any) => p?.ai === true).length === 0;
    },
    undefined,
    { timeout: 30_000 },
  )));

  await Promise.all([
    host.keyboard.down('ArrowLeft'),
    joiner.keyboard.down('ArrowRight'),
  ]);
  await wait(4200);
  await Promise.all([
    host.keyboard.up('ArrowLeft').catch(() => undefined),
    joiner.keyboard.up('ArrowRight').catch(() => undefined),
  ]);
  await wait(800);

  const probes = await Promise.all(pages.map((page) => probe(page, 2)));
  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const label = i === 0 ? 'host P1' : 'prejoined P2';
    process.stdout.write(`2P prejoined ${label}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
    if (!p.peerActive) throw new Error(`2P prejoined ${label} peer inactive`);
    if (p.phase !== 'playing') throw new Error(`2P prejoined ${label} not playing`);
    if (p.frame < 120) throw new Error(`2P prejoined ${label} did not advance far enough`);
    if (p.players !== 2) throw new Error(`2P prejoined ${label} wrong player count`);
    if (p.aiPlayers !== 0) throw new Error(`2P prejoined ${label} has AI-controlled slot`);
    if (p.stall) throw new Error(`2P prejoined ${label} stalled`);
    if (p.desync) throw new Error(`2P prejoined ${label} desynced`);
    if (p.inputCounts.some((count) => count < 50)) throw new Error(`2P prejoined ${label} missing input history`);
  }
  await Promise.all(pages.map((page) => page.context().close().catch(() => undefined)));
  process.stdout.write('2P prejoined deathmatch lockstep PASS\n');
}

async function main(): Promise<void> {
  const vite = startVite();
  const broker = startBroker();
  const cleanup = () => { killGroup(vite); killGroup(broker); };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  let browser: Browser | null = null;
  try {
    await Promise.all([
      waitForHttp(`${VITE_BASE}/`, s => s < 500, 30_000),
      waitForHttp(`http://localhost:${BROKER_PORT}/`, s => s === 404, 10_000),
    ]);
    await fetch(`${VITE_BASE}/src/main.ts`).catch(() => undefined);
    await wait(750);

    const browserInstance = await chromium.launch();
    browser = browserInstance;
    const warmCtx = await browserInstance.newContext({ serviceWorkers: 'block' });
    const warmPage = await warmCtx.newPage();
    await warmPage.goto(`${VITE_BASE}/`, { waitUntil: 'load' });
    await wait(3000);
    await warmCtx.close();
    await runAllHumanScenario(browserInstance);
    await runAiFillScenario(browserInstance);
    await runTwoPlayerLateTakeoverScenario(browserInstance);
    await runTwoPlayerPrejoinedStartScenario(browserInstance);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    cleanup();
  }
}

main().catch((e) => {
  process.stderr.write(`N-player deathmatch e2e failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
