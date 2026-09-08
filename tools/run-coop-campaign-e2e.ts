/**
 * Two-player co-op campaign lockstep smoke.
 *
 * Starts Vite + the local broker, opens two real browser clients into one
 * co-op campaign session, drives a little input on both slots, and checks the
 * run advances as a two-player campaign with no AI-controlled network slots.
 * --forge starts both clients in the same damaged-core fixture and compares
 * simulation history across HIGH desktop and LOW portrait presentation.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5188;
const BROKER_PORT = 8796;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const PLAYERS = 2;
const FORGE = process.argv.includes('--forge');
const PORTRAIT_VIEWPORT = { width: 390, height: 844 } as const;

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
  debug: { inputDelay?: number; stallCount?: number; maxStallFrames?: number } | null;
  display: {
    bodyDisplay: string | null;
    cssW: number;
    cssH: number;
    backingW: number;
    backingH: number;
    innerW: number;
    innerH: number;
  };
}> {
  return page.evaluate((players) => {
    const s = (window as any).__pallasiteState;
    const c = document.getElementById('game') as HTMLCanvasElement | null;
    const rect = c?.getBoundingClientRect();
    const probeLog = (window as any).__pallasiteInputLogProbe as ((from: number, to: number) => Array<[number, number, number]> | null) | undefined;
    const debug = (window as any).__pallasitePeerDebug?.() ?? null;
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
      debug,
      display: {
        bodyDisplay: document.body.dataset.display ?? null,
        cssW: rect?.width ?? 0,
        cssH: rect?.height ?? 0,
        backingW: c?.width ?? 0,
        backingH: c?.height ?? 0,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
      },
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
    const errors: string[] = [];
    const gotos: Array<Promise<unknown>> = [];
    for (let slot = 0; slot < PLAYERS; slot++) {
      const ctx = await browser.newContext({
        serviceWorkers: 'block',
        viewport: FORGE && slot === 0 ? { width: 1440, height: 900 } : PORTRAIT_VIEWPORT,
        deviceScaleFactor: 2,
      });
      if (FORGE) {
        await ctx.addInitScript((quality) => localStorage.setItem('pallasite:quality', quality), slot === 0 ? 'high' : 'low');
        // Identical deterministic opening fixture on both clients. Intercept the
        // development module so production never needs a network boss-skip hook.
        await ctx.route('**/src/game.ts', async route => {
          const response = await route.fetch();
          const body = await response.text();
          const opening = /beginWave\(s, 1\);/g;
          assert.equal([...body.matchAll(opening)].length, 1, 'unique campaign opening fixture');
          await route.fulfill({ response, body: body.replace(opening, `beginWave(s, 25);
            s.cheatedThisRun = true;
            for (const p of s.players) p.ship.invulnerableUntil = 1e9;
            const fixtureCore = s.asteroids.find(a => a.stationPart === 'core');
            fixtureCore.hp = fixtureCore.hpMax * 0.6;`) });
        });
      }
      const page = await ctx.newPage();
      page.on('pageerror', (e) => { errors.push(e.message); process.stderr.write(`[P${slot + 1}] ${e.message}\n`); });
      page.on('console', (msg) => {
        const text = msg.text();
        if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
          process.stderr.write(`[P${slot + 1} ${msg.type()}] ${text}\n`);
        }
      });
      const url = `${VITE_BASE}/?peer=${encodeURIComponent(BROKER_URL)}&session=${session}&slot=${slot}&players=${PLAYERS}&mode=coop-campaign&wiretrace=1&peerBatch=1${FORGE ? '&desync-hunt=1' : ''}`;
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

    await Promise.all(pages.map((page) => page.evaluate(() => {
      (window as any).__pallasiteFit?.();
    })));
    await wait(250);

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

    if (FORGE) {
      await Promise.all(pages.map(page => page.waitForFunction(() => (window as any).__pallasiteState.frame >= 900, null, { timeout: 90_000 })));
      const histories = await Promise.all(pages.map(page => page.evaluate(() => Array.from((window as any).__pallasiteCanaryHistory as Map<number, string>))));
      const other = new Map(histories[1]);
      const through = Math.min(...histories.map(rows => Math.max(...rows.map(([frame]) => frame)))) - 90;
      let matched = 0;
      let sawPulse = false;
      const pulseDeadlines = new Set<number>();
      for (const [frame, state] of histories[0]) {
        if (frame > through || !other.has(frame)) continue;
        assert.equal(state, other.get(frame), `Forge peers agree at confirmed frame ${frame}`);
        const snapshot = JSON.parse(state);
        assert.equal(snapshot.w, 25);
        sawPulse ||= snapshot.forge[3] > 0 && snapshot.ebul.length > 0;
        if (snapshot.forge[3] > 0) pulseDeadlines.add(snapshot.forge[3]);
        matched++;
      }
      assert.ok(matched >= 600, `at least 600 shared simulation frames (${matched})`);
      assert.ok(sawPulse, 'connected clients exercised the active core and projectiles');
      assert.ok(pulseDeadlines.size >= 3, 'core completed and rescheduled multiple warned pulses');
      const qualities = await Promise.all(pages.map(page => page.evaluate(async () => (await import('/src/visual-style.ts')).getQualityLevel())));
      assert.deepEqual(qualities, ['high', 'low']);
      process.stdout.write(`Forge HIGH desktop / LOW portrait: ${matched} matching simulation frames, active pulse PASS\n`);
    }

    const probes = await Promise.all(pages.map(probe));
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      const d = p.display;
      process.stdout.write(`P${i + 1}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers} sats=${p.sats.join('/')} stall=${p.stall ?? '-'} desync=${p.desync} delay=${p.debug?.inputDelay ?? '-'} maxStall=${p.debug?.maxStallFrames ?? '-'} inputs=${p.inputCounts.join('/')} display=${d.bodyDisplay} css=${Math.round(d.cssW)}x${Math.round(d.cssH)} backing=${d.backingW}x${d.backingH}\n`);
    }
    for (let i = 0; i < probes.length; i++) {
      const p = probes[i];
      const d = p.display;
      const cssAspect = d.cssH > 0 ? d.cssW / d.cssH : 0;
      const backingAspect = d.backingH > 0 ? d.backingW / d.backingH : 0;
      if (!p.peerActive) throw new Error(`P${i + 1} peer inactive`);
      if (p.phase !== 'playing') throw new Error(`P${i + 1} not playing`);
      if (p.frame < 80) throw new Error(`P${i + 1} did not advance far enough`);
      if (p.players !== PLAYERS) throw new Error(`P${i + 1} wrong player count`);
      if (p.aiPlayers !== 0) throw new Error(`P${i + 1} has AI-controlled network slots`);
      if (p.sats.some((n) => n !== 0)) throw new Error(`P${i + 1} accrued sats in co-op`);
      if (p.stall) throw new Error(`P${i + 1} stalled`);
      if (p.desync) throw new Error(`P${i + 1} desynced`);
      // Input delay is now broker-negotiated from the measured link. The local
      // e2e broker injects no latency, so adaptation drives it well below the
      // 24f static co-op tier — that lower delay is the latency win. Assert it
      // stays in the valid [floor, tier] band rather than pinning the old value.
      const coopDelay = p.debug?.inputDelay ?? 0;
      if (coopDelay < 2 || coopDelay > 24) throw new Error(`P${i + 1} co-op input delay out of band: ${coopDelay}`);
      if ((p.debug?.maxStallFrames ?? 0) > 90) throw new Error(`P${i + 1} co-op stalled too long: ${p.debug?.maxStallFrames}f`);
      if (p.inputCounts.some((count) => count < 70)) throw new Error(`P${i + 1} missing input history`);
      if (d.bodyDisplay !== 'modern') throw new Error(`P${i + 1} portrait co-op fell out of modern display: ${d.bodyDisplay}`);
      if (Math.abs(cssAspect - backingAspect) > 0.02) throw new Error(`P${i + 1} canvas stretched: css=${cssAspect.toFixed(3)} backing=${backingAspect.toFixed(3)}`);
      if (Math.abs(d.cssW - d.innerW) > 2 || Math.abs(d.cssH - d.innerH) > 2) throw new Error(`P${i + 1} portrait canvas not filling viewport: css=${d.cssW}x${d.cssH} viewport=${d.innerW}x${d.innerH}`);
    }
    assert.deepEqual(errors, [], 'no browser exceptions');
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
