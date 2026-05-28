/**
 * Two-player co-op campaign lockstep smoke.
 *
 * Starts Vite + the local broker, opens two real browser clients into one
 * co-op campaign session, drives a little input on both slots, and checks the
 * run advances as a two-player campaign with no AI-controlled network slots.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5188;
const BROKER_PORT = 8796;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const PLAYERS = 2;

function startVite(): ChildProcess {
  const p = spawn('pnpm', ['exec', 'vite', '--force', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
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

async function probe(page: Page): Promise<{
  frame: number;
  phase: string;
  peerActive: boolean;
  desync: boolean;
  stall: string | null;
  players: number;
  aiPlayers: number;
  sats: number[];
  inputCounts: number[];
}> {
  return page.evaluate((players) => {
    const s = (window as any).__pallasiteState;
    const probeLog = (window as any).__pallasiteInputLogProbe as ((from: number, to: number) => Array<[number, number, number]> | null) | undefined;
    const counts = new Array(players).fill(0);
    const rows = probeLog ? probeLog(0, 120) : null;
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
      sats: Array.isArray(s?.players) ? s.players.map((p: any) => Number(p?.sats ?? 0)) : [],
      inputCounts: counts,
    };
  }, PLAYERS);
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

    const session = randomBytes(4).toString('hex');
    browser = await chromium.launch();
    const pages: Page[] = [];
    const gotos: Array<Promise<unknown>> = [];
    for (let slot = 0; slot < PLAYERS; slot++) {
      const ctx = await browser.newContext({ serviceWorkers: 'block' });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => process.stderr.write(`[P${slot + 1}] ${e.message}\n`));
      page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
          process.stderr.write(`[P${slot + 1} ${msg.type()}] ${text}\n`);
        }
      });
      const url = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&slot=${slot}&players=${PLAYERS}&mode=coop-campaign&wiretrace=1&peerBatch=1`;
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
        { timeout: 35_000 },
      )));
    } catch (e) {
      const probes = await Promise.all(pages.map(probe));
      for (let i = 0; i < probes.length; i++) {
        const p = probes[i];
        process.stderr.write(`startup P${i + 1}: frame=${p.frame} phase=${p.phase} peer=${p.peerActive} players=${p.players} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
      }
      throw e;
    }

    await Promise.all([
      pages[0].keyboard.down('ArrowUp'),
      pages[1].keyboard.down('ArrowRight'),
    ]);
    await wait(2400);
    await Promise.all([
      pages[0].keyboard.up('ArrowUp'),
      pages[1].keyboard.up('ArrowRight'),
    ]);
    await wait(800);

    const probes = await Promise.all(pages.map(probe));
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      process.stdout.write(`P${i + 1}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers} sats=${p.sats.join('/')} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}\n`);
    }
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      if (!p.peerActive) throw new Error(`P${i + 1} peer inactive`);
      if (p.phase !== 'playing') throw new Error(`P${i + 1} not playing`);
      if (p.frame < 80) throw new Error(`P${i + 1} did not advance far enough`);
      if (p.players !== PLAYERS) throw new Error(`P${i + 1} wrong player count`);
      if (p.aiPlayers !== 0) throw new Error(`P${i + 1} has AI-controlled network slots`);
      if (p.sats.some((n) => n !== 0)) throw new Error(`P${i + 1} accrued sats in co-op`);
      if (p.stall) throw new Error(`P${i + 1} stalled`);
      if (p.desync) throw new Error(`P${i + 1} desynced`);
      if (p.inputCounts.some((count) => count < 70)) throw new Error(`P${i + 1} missing input history`);
    }
    process.stdout.write('Co-op campaign lockstep PASS\n');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    cleanup();
  }
}

main().catch((e) => {
  process.stderr.write(`Co-op campaign e2e failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
