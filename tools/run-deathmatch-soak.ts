/**
 * N-player deathmatch multiplayer soak.
 *
 * Covers two different risks:
 *  - real browser lockstep + late spectator under deterministic relay jitter;
 *  - broker transport fan-out at larger N without paying for 64 Chromium tabs.
 *
 * Defaults target the product envelope: 4P browser lockstep and 4P broker
 * fan-out. Use explicit flags such as `--broker=16,64` only as stress tests
 * for headroom, not as release criteria.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5191;
const BROKER_PORT = 8799;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function intArg(name: string, fallback: number, min: number, max: number): number {
  const raw = argValue(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseCounts(name: string, fallback: number[]): number[] {
  const raw = argValue(name);
  if (!raw) return fallback;
  const out = raw.split(',')
    .map((v) => Number(v.trim()))
    .filter((v) => Number.isFinite(v))
    .map((v) => Math.max(2, Math.min(64, Math.floor(v))));
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

const BROWSER_COUNTS = parseCounts('browser', [4]);
const BROKER_COUNTS = parseCounts('broker', [4]);
const BROWSER_DURATION_MS = intArg('browserDuration', 4_500, 1_500, 30_000);
const BROKER_DURATION_MS = intArg('brokerDuration', 2_000, 1_000, 20_000);
const BROKER_RATE_HZ = intArg('brokerRate', 60, 5, 60);
const BROKER_BATCH_SIZE = intArg('brokerBatch', 4, 1, 16);
const FORWARD_DELAY_MS = intArg('delay', 60, 0, 1_000);
const FORWARD_JITTER_MS = intArg('jitter', 120, 0, 2_000);
const INPUT_DELAY_FRAMES = intArg('inputDelay', 30, 0, 60);

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
    detached: true,
    env: {
      ...process.env,
      PORT: String(BROKER_PORT),
      HOST: '127.0.0.1',
      PEER_FORWARD_DELAY_MS: String(FORWARD_DELAY_MS),
      PEER_FORWARD_JITTER_MS: String(FORWARD_JITTER_MS),
    },
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

interface BrokerMetrics {
  process?: { rssBytes?: number; cpuRecentPercent?: number };
  sessions?: { total?: number; peerSessions?: number; peers?: number; peerWatchers?: number };
  sockets?: { total?: number; open?: number; maxBufferedAmount?: number };
  peer?: {
    configuredForwardDelayMs?: number;
    configuredForwardJitterMs?: number;
    forwardAttempts?: number;
    forwarded?: number;
    forwardedBytes?: number;
    droppedBufferedAmount?: number;
    maxBufferedAmountObserved?: number;
    forwardLatencyMs?: { p50?: number; p95?: number; p99?: number; max?: number };
  };
}

async function fetchBrokerMetrics(): Promise<BrokerMetrics | null> {
  try {
    const response = await fetch(`http://localhost:${BROKER_PORT}/metrics`, { cache: 'no-store' });
    if (!response.ok) return null;
    return await response.json() as BrokerMetrics;
  } catch {
    return null;
  }
}

function metricDelta(after: number | undefined, before: number | undefined): number | null {
  if (typeof after !== 'number' || typeof before !== 'number') return null;
  return after - before;
}

function fmtMetric(value: number | null, fallback: number | undefined): string {
  if (value !== null) return String(value);
  return typeof fallback === 'number' ? String(fallback) : '-';
}

function printBrokerMetrics(label: string, after: BrokerMetrics | null, before: BrokerMetrics | null): void {
  if (!after) {
    process.stdout.write(`[broker-metrics] ${label}: unavailable\n`);
    return;
  }
  const latency = after.peer?.forwardLatencyMs;
  const configuredDelay = `${after.peer?.configuredForwardDelayMs ?? '-'}/${after.peer?.configuredForwardJitterMs ?? '-'}`;
  const rssMb = typeof after.process?.rssBytes === 'number' ? (after.process.rssBytes / 1024 / 1024).toFixed(1) : '-';
  const bytes = metricDelta(after.peer?.forwardedBytes, before?.peer?.forwardedBytes);
  process.stdout.write(
    `[broker-metrics] ${label}: attempts=${fmtMetric(metricDelta(after.peer?.forwardAttempts, before?.peer?.forwardAttempts), after.peer?.forwardAttempts)}`
    + ` forwarded=${fmtMetric(metricDelta(after.peer?.forwarded, before?.peer?.forwarded), after.peer?.forwarded)}`
    + ` bytes=${fmtMetric(bytes, after.peer?.forwardedBytes)}`
    + ` drops=${fmtMetric(metricDelta(after.peer?.droppedBufferedAmount, before?.peer?.droppedBufferedAmount), after.peer?.droppedBufferedAmount)}`
    + ` latency p50/p95/p99=${latency?.p50 ?? '-'}/${latency?.p95 ?? '-'}/${latency?.p99 ?? '-'}ms max=${latency?.max ?? '-'}ms`
    + ` configuredDelay=${configuredDelay}ms`
    + ` cpu=${after.process?.cpuRecentPercent ?? '-'}% rss=${rssMb}MB`
    + ` sockets=${after.sockets?.open ?? '-'}/${after.sockets?.total ?? '-'} maxBuf=${after.sockets?.maxBufferedAmount ?? '-'} observedMaxBuf=${after.peer?.maxBufferedAmountObserved ?? '-'}`
    + ` sessions=${after.sessions?.peerSessions ?? '-'}/${after.sessions?.total ?? '-'} peers=${after.sessions?.peers ?? '-'} watchers=${after.sessions?.peerWatchers ?? '-'}\n`,
  );
}

async function primeContext(browser: Browser): Promise<import('playwright').BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:mode', 'deathmatch');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:visualStyle', JSON.stringify({
      asteroid: 'vector',
      ship: 'vector',
      bullet: 'vector',
      particle: 'vector',
      theme: 'none',
      asciiCols: 96,
      bitDepth: 4,
      bitColour: false,
    }));
  });
  return ctx;
}

interface BrowserProbe {
  frame: number;
  phase: string;
  peerActive: boolean;
  desync: boolean;
  stall: string | null;
  players: number;
  aiPlayers: number;
  inputCounts: number[];
  wireCounters: {
    sentFrameCount: number;
    recvFrameCount: number;
    wsSentFrameCount: number;
    wsRecvFrameCount: number;
    wsSentFramePayloadCount: number;
    wsRecvFramePayloadCount: number;
    bufferedAmount: number;
    readyState: number;
    binaryFramesActive: boolean;
  } | null;
}

async function probeBrowser(page: Page, players: number): Promise<BrowserProbe> {
  return page.evaluate((expectedPlayers) => {
    const s = (window as any).__pallasiteState;
    const probeLog = (window as any).__pallasiteInputLogProbe as ((from: number, to: number) => Array<[number, number, number]> | null) | undefined;
    const peerRef = (window as any).__pallasiteTestHooks?.peerRef;
    const counts = new Array(expectedPlayers).fill(0);
    const frame = Number(s?.frame ?? -1);
    const to = Math.max(0, Math.min(600, frame));
    const rows = probeLog ? probeLog(0, to) : null;
    if (rows) {
      for (const [, slot, encoded] of rows) {
        if (slot >= 0 && slot < expectedPlayers && encoded >= 0) counts[slot]++;
      }
    }
    let wireCounters = null;
    try {
      const raw = peerRef?.getWireCounters ? peerRef.getWireCounters() : null;
      if (raw && typeof raw === 'object') {
        wireCounters = {
          sentFrameCount: Number(raw.sentFrameCount ?? 0),
          recvFrameCount: Number(raw.recvFrameCount ?? 0),
          wsSentFrameCount: Number(raw.wsSentFrameCount ?? 0),
          wsRecvFrameCount: Number(raw.wsRecvFrameCount ?? 0),
          wsSentFramePayloadCount: Number(raw.wsSentFramePayloadCount ?? 0),
          wsRecvFramePayloadCount: Number(raw.wsRecvFramePayloadCount ?? 0),
          bufferedAmount: Number(raw.bufferedAmount ?? -1),
          readyState: Number(raw.readyState ?? -1),
          binaryFramesActive: raw.binaryFramesActive === true,
        };
      }
    } catch {
      wireCounters = null;
    }
    return {
      frame,
      phase: s?.phase ?? 'unknown',
      peerActive: !!(window as any).__pallasitePeerActive,
      desync: document.body.hasAttribute('data-peer-desync'),
      stall: document.body.getAttribute('data-peer-stall'),
      players: Array.isArray(s?.players) ? s.players.length : 0,
      aiPlayers: Array.isArray(s?.players) ? s.players.filter((p: any) => p?.ai === true).length : -1,
      inputCounts: counts,
      wireCounters,
    };
  }, players);
}

function deathmatchParams(session: string, players: number, slot?: number, spectate = false): string {
  const params = new URLSearchParams({
    players: String(players),
    deathmatchPlayers: String(players),
    mode: 'deathmatch',
    inputDelay: String(INPUT_DELAY_FRAMES),
    deathmatchTime: '300',
    deathmatchKills: '250',
    deathmatchRespawns: '99',
    wiretrace: '1',
    peerBatch: '1',
  });
  if (spectate) {
    params.set('spectate', session);
    params.set('peer', `${BROKER_URL}/?s=${encodeURIComponent(session)}&r=peerwatch&binaryFrames=1`);
  } else {
    params.set('peer', BROKER_URL);
    params.set('session', session);
    params.set('slot', String(slot ?? 0));
  }
  return `${VITE_BASE}/?${params.toString()}`;
}

async function driveBrowserInputs(pages: Page[], durationMs: number): Promise<void> {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space'];
  await Promise.all(pages.map((page, i) => page.keyboard.down(keys[i % keys.length])));
  await wait(durationMs);
  await Promise.all(pages.map((page, i) => page.keyboard.up(keys[i % keys.length]).catch(() => undefined)));
}

async function runBrowserCase(browser: Browser, players: number): Promise<void> {
  const session = `dm${players}-${randomBytes(4).toString('hex')}`;
  const pages: Page[] = [];
  const contexts: import('playwright').BrowserContext[] = [];
  const metricsBefore = await fetchBrokerMetrics();
  process.stdout.write(`\n[browser ${players}P] session=${session} delay=${FORWARD_DELAY_MS}+${FORWARD_JITTER_MS}ms inputDelay=${INPUT_DELAY_FRAMES}f\n`);

  for (let slot = 0; slot < players; slot++) {
    const ctx = await primeContext(browser);
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => process.stderr.write(`[B${players}/P${slot + 1}] ${e.message}\n`));
    page.on('console', (msg) => {
      const text = msg.text();
      if (text.includes('[duel]') || text.includes('[peer]') || text.includes('session-error')) {
        process.stderr.write(`[B${players}/P${slot + 1} ${msg.type()}] ${text}\n`);
      }
    });
    pages.push(page);
  }
  await Promise.all(pages.map((page, slot) => page.goto(deathmatchParams(session, players, slot), { waitUntil: 'load' })));

  await Promise.all(pages.map((page) => page.waitForFunction(
    (expectedPlayers) => {
      const s = (window as any).__pallasiteState;
      return !!(window as any).__pallasitePeerActive && s?.phase === 'playing' && s?.players?.length === expectedPlayers;
    },
    players,
    { timeout: 45_000 },
  )));

  const inputPromise = driveBrowserInputs(pages, Math.max(1_500, Math.floor(BROWSER_DURATION_MS * 0.7))).catch(() => undefined);
  await wait(1_500);

  const spectatorCtx = await primeContext(browser);
  contexts.push(spectatorCtx);
  const spectator = await spectatorCtx.newPage();
  spectator.on('pageerror', (e) => process.stderr.write(`[B${players}/S] ${e.message}\n`));
  spectator.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[spectate]') || text.includes('[peer]')) {
      process.stderr.write(`[B${players}/S ${msg.type()}] ${text}\n`);
    }
  });
  await spectator.goto(deathmatchParams(session, players, undefined, true), { waitUntil: 'load' });
  try {
    await spectator.waitForFunction(
      (expectedPlayers) => {
        const s = (window as any).__pallasiteState;
        return !!(window as any).__pallasitePeerActive && s?.phase === 'playing' && s?.players?.length === expectedPlayers;
      },
      players,
      { timeout: 45_000 },
    );
  } catch (e) {
    const peerProbes = await Promise.all(pages.map((page) => probeBrowser(page, players).catch((err) => ({ error: String(err) }))));
    const specProbe = await probeBrowser(spectator, players).catch((err) => ({ error: String(err) }));
    process.stderr.write(`[browser ${players}P] spectator startup failed\n`);
    process.stderr.write(`  peers=${JSON.stringify(peerProbes)}\n`);
    process.stderr.write(`  spectator=${JSON.stringify(specProbe)}\n`);
    throw e;
  }

  await wait(BROWSER_DURATION_MS);
  await inputPromise;
  await wait(Math.max(800, FORWARD_DELAY_MS + FORWARD_JITTER_MS + 400));

  const probes = await Promise.all(pages.map((page) => probeBrowser(page, players)));
  const spectatorProbe = await probeBrowser(spectator, players);
  const frames = probes.map((p) => p.frame);
  const minFrame = Math.min(...frames);
  const maxFrame = Math.max(...frames);

  for (let i = 0; i < probes.length; i++) {
    const p = probes[i];
    const c = p.wireCounters;
    const wire = c
      ? ` wire=${c.wsSentFrameCount}/${c.wsSentFramePayloadCount} recv=${c.wsRecvFrameCount}/${c.wsRecvFramePayloadCount} binary=${c.binaryFramesActive ? 'yes' : 'no'} buf=${c.bufferedAmount}`
      : ' wire=-';
    process.stdout.write(`  P${i + 1}: frame=${p.frame} phase=${p.phase} stall=${p.stall ?? '-'} desync=${p.desync} inputs=${p.inputCounts.join('/')}${wire}\n`);
    if (!p.peerActive) throw new Error(`${players}P P${i + 1} peer inactive`);
    if (p.phase !== 'playing') throw new Error(`${players}P P${i + 1} phase=${p.phase}`);
    if (p.players !== players) throw new Error(`${players}P P${i + 1} player count=${p.players}`);
    if (p.aiPlayers !== 0) throw new Error(`${players}P P${i + 1} has AI slots`);
    if (p.stall) throw new Error(`${players}P P${i + 1} stalled`);
    if (p.desync) throw new Error(`${players}P P${i + 1} desynced`);
    if (p.frame < 120) throw new Error(`${players}P P${i + 1} did not advance enough`);
    if (p.inputCounts.some((count) => count < 80)) throw new Error(`${players}P P${i + 1} sparse input log: ${p.inputCounts.join('/')}`);
    if (players > 2) {
      if (!c) throw new Error(`${players}P P${i + 1} missing wire counters`);
      if (c.wsSentFrameCount < 120) throw new Error(`${players}P P${i + 1} sent too few logical frames: ${c.wsSentFrameCount}`);
      if (c.wsSentFramePayloadCount <= 0) throw new Error(`${players}P P${i + 1} sent no frame payloads`);
      if (!c.binaryFramesActive) throw new Error(`${players}P P${i + 1} did not negotiate binary frame wire`);
      if (players > 8 && c.wsSentFramePayloadCount >= Math.floor(c.wsSentFrameCount * 0.85)) {
        throw new Error(`${players}P P${i + 1} batching ineffective: frames=${c.wsSentFrameCount} payloads=${c.wsSentFramePayloadCount}`);
      }
      if (c.bufferedAmount > 32768) throw new Error(`${players}P P${i + 1} socket backlog too high: ${c.bufferedAmount}`);
    }
  }
  process.stdout.write(`  S:  frame=${spectatorProbe.frame} phase=${spectatorProbe.phase} stall=${spectatorProbe.stall ?? '-'} inputs=${spectatorProbe.inputCounts.join('/')}\n`);
  if (!spectatorProbe.peerActive) throw new Error(`${players}P spectator peer inactive`);
  if (spectatorProbe.phase !== 'playing') throw new Error(`${players}P spectator phase=${spectatorProbe.phase}`);
  if (spectatorProbe.players !== players) throw new Error(`${players}P spectator player count=${spectatorProbe.players}`);
  if (spectatorProbe.stall) throw new Error(`${players}P spectator stalled`);
  if (spectatorProbe.frame < 100) throw new Error(`${players}P spectator did not catch up`);
  if (minFrame - spectatorProbe.frame > 360) throw new Error(`${players}P spectator lag too high: ${minFrame - spectatorProbe.frame}`);
  if (maxFrame - minFrame > 180) throw new Error(`${players}P peer frame spread too high: ${minFrame}..${maxFrame}`);

  for (const ctx of contexts) await ctx.close().catch(() => undefined);
  printBrokerMetrics(`browser ${players}P`, await fetchBrokerMetrics(), metricsBefore);
  process.stdout.write(`[browser ${players}P] PASS frameSpread=${maxFrame - minFrame} spectatorLag=${minFrame - spectatorProbe.frame}\n`);
}

interface SoakPeer {
  ws: WebSocket;
  slot: number;
  joined: Set<number>;
  recvBySlot: number[];
  lastFrameBySlot: number[];
}

interface BrokerWireMsg {
  type?: string;
  players?: number;
  slot?: number;
  frame?: number;
  base?: number;
  input?: number;
  inputs?: unknown;
  code?: string;
}

function recordBrokerFrames(recvBySlot: number[], lastFrameBySlot: number[], players: number, msg: BrokerWireMsg): void {
  if (typeof msg.slot !== 'number' || msg.slot < 0 || msg.slot >= players) return;
  if (msg.type === 'frame' && typeof msg.frame === 'number') {
    recvBySlot[msg.slot]++;
    lastFrameBySlot[msg.slot] = Math.max(lastFrameBySlot[msg.slot], msg.frame);
    return;
  }
  if (msg.type === 'frames' && typeof msg.base === 'number' && Array.isArray(msg.inputs)) {
    const count = msg.inputs.length;
    if (count <= 0) return;
    recvBySlot[msg.slot] += count;
    lastFrameBySlot[msg.slot] = Math.max(lastFrameBySlot[msg.slot], msg.base + count - 1);
  }
}

function openSoakPeer(session: string, slot: number, players: number): Promise<SoakPeer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BROKER_URL}/?s=${session}&r=peer`);
    const peer: SoakPeer = {
      ws,
      slot,
      joined: new Set([slot]),
      recvBySlot: new Array(players).fill(0),
      lastFrameBySlot: new Array(players).fill(-1),
    };
    const timeout = setTimeout(() => reject(new Error(`broker ${players}P slot ${slot} join timeout`)), 10_000);
    const maybeReady = () => {
      if (peer.joined.size >= players) {
        clearTimeout(timeout);
        resolve(peer);
      }
    };
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello-peer', session, slot, version: 1, players }));
      maybeReady();
    });
    ws.addEventListener('message', (ev: MessageEvent) => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let msg: BrokerWireMsg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'peer-joined' && typeof msg.slot === 'number') {
        peer.joined.add(msg.slot);
        maybeReady();
      } else if (msg.type === 'frame' || msg.type === 'frames') {
        recordBrokerFrames(peer.recvBySlot, peer.lastFrameBySlot, players, msg);
      } else if (msg.type === 'session-error') {
        reject(new Error(`broker ${players}P slot ${slot} session-error ${msg.code ?? ''}`));
      }
    });
    ws.addEventListener('error', () => reject(new Error(`broker ${players}P slot ${slot} ws error`)));
  });
}

interface SoakWatcher {
  ws: WebSocket;
  readyPlayers: number;
  joined: Set<number>;
  recvBySlot: number[];
  lastFrameBySlot: number[];
}

function openSoakWatcher(session: string, players: number): Promise<SoakWatcher> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BROKER_URL}/?s=${session}&r=peerwatch`);
    const watcher: SoakWatcher = {
      ws,
      readyPlayers: 0,
      joined: new Set(),
      recvBySlot: new Array(players).fill(0),
      lastFrameBySlot: new Array(players).fill(-1),
    };
    const timeout = setTimeout(() => reject(new Error(`broker ${players}P watcher timeout`)), 10_000);
    const maybeReady = () => {
      if (watcher.readyPlayers === players && watcher.joined.size >= players) {
        clearTimeout(timeout);
        resolve(watcher);
      }
    };
    ws.addEventListener('message', (ev: MessageEvent) => {
      const text = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let msg: BrokerWireMsg;
      try { msg = JSON.parse(text); } catch { return; }
      if (msg.type === 'peerwatch-ready') {
        watcher.readyPlayers = Math.max(2, Math.min(64, Math.floor(Number(msg.players) || 2)));
        maybeReady();
      } else if (msg.type === 'peer-joined' && typeof msg.slot === 'number') {
        watcher.joined.add(msg.slot);
        maybeReady();
      } else if (msg.type === 'frame' || msg.type === 'frames') {
        recordBrokerFrames(watcher.recvBySlot, watcher.lastFrameBySlot, players, msg);
      }
    });
    ws.addEventListener('error', () => reject(new Error(`broker ${players}P watcher ws error`)));
  });
}

async function runBrokerCase(players: number): Promise<void> {
  const session = `wire${players}-${randomBytes(4).toString('hex')}`;
  const payloadIntervalMs = Math.max(1, Math.round((1000 * BROKER_BATCH_SIZE) / BROKER_RATE_HZ));
  const metricsBefore = await fetchBrokerMetrics();
  process.stdout.write(`\n[broker ${players}P] session=${session} rate=${BROKER_RATE_HZ}Hz batch=${BROKER_BATCH_SIZE} payloadEvery=${payloadIntervalMs}ms delay=${FORWARD_DELAY_MS}+${FORWARD_JITTER_MS}ms\n`);
  const peers = await Promise.all(Array.from({ length: players }, (_, slot) => openSoakPeer(session, slot, players)));

  let frame = 0;
  let sentFrames = 0;
  let sentPayloads = 0;
  const timer = setInterval(() => {
    const base = frame;
    for (const p of peers) {
      if (p.ws.readyState === WebSocket.OPEN) {
        if (BROKER_BATCH_SIZE === 1) {
          p.ws.send(JSON.stringify({ type: 'frame', frame: base, slot: p.slot, input: p.slot + 1 }));
        } else {
          const inputs = Array.from({ length: BROKER_BATCH_SIZE }, (_, i) => ((p.slot + 1) << 8) | ((base + i) & 255));
          p.ws.send(JSON.stringify({ type: 'frames', slot: p.slot, base, inputs }));
        }
      }
    }
    frame += BROKER_BATCH_SIZE;
    sentFrames += BROKER_BATCH_SIZE;
    sentPayloads++;
  }, payloadIntervalMs);

  await wait(Math.min(1_000, Math.max(350, Math.floor(BROKER_DURATION_MS / 3))));
  const watcher = await openSoakWatcher(session, players);
  await wait(BROKER_DURATION_MS);
  clearInterval(timer);
  await wait(Math.max(800, FORWARD_DELAY_MS + FORWARD_JITTER_MS + 500));

  const minExpected = Math.max(1, Math.floor(sentFrames * 0.72));
  for (const p of peers) {
    for (let slot = 0; slot < players; slot++) {
      if (slot === p.slot) continue;
      const got = p.recvBySlot[slot];
      if (got < minExpected) {
        throw new Error(`broker ${players}P peer ${p.slot} saw sparse slot ${slot}: got ${got}, expected >=${minExpected} of ${sentFrames}`);
      }
    }
  }
  const watcherMin = Math.max(1, Math.floor(sentFrames * 0.60));
  for (let slot = 0; slot < players; slot++) {
    const got = watcher.recvBySlot[slot];
    if (got < watcherMin) {
      throw new Error(`broker ${players}P watcher saw sparse slot ${slot}: got ${got}, expected >=${watcherMin} of ${sentFrames}`);
    }
  }

  for (const p of peers) p.ws.close();
  watcher.ws.close();
  const peerTotals = peers.map((p) => p.recvBySlot.reduce((sum, n, slot) => sum + (slot === p.slot ? 0 : n), 0));
  const watcherTotal = watcher.recvBySlot.reduce((sum, n) => sum + n, 0);
  if (BROKER_BATCH_SIZE > 1 && sentPayloads >= sentFrames) {
    throw new Error(`broker ${players}P batching ineffective: frames=${sentFrames} payloads=${sentPayloads}`);
  }
  printBrokerMetrics(`broker ${players}P`, await fetchBrokerMetrics(), metricsBefore);
  process.stdout.write(`[broker ${players}P] PASS sentFrames=${sentFrames} sentPayloads=${sentPayloads} peerRecv=${Math.min(...peerTotals)}..${Math.max(...peerTotals)} watcherRecv=${watcherTotal}\n`);
}

async function main(): Promise<void> {
  process.stdout.write(
    `deathmatch soak: browser=${BROWSER_COUNTS.join(',') || '-'} broker=${BROKER_COUNTS.join(',') || '-'} `
    + `brokerRate=${BROKER_RATE_HZ}Hz brokerBatch=${BROKER_BATCH_SIZE} delay=${FORWARD_DELAY_MS} jitter=${FORWARD_JITTER_MS} inputDelay=${INPUT_DELAY_FRAMES}\n`,
  );
  const vite = startVite();
  const broker = startBroker();
  const cleanup = () => { killGroup(vite); killGroup(broker); };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  let browser: Browser | null = null;
  try {
    await Promise.all([
      waitForHttp(`${VITE_BASE}/`, (s) => s < 500, 30_000),
      waitForHttp(`http://localhost:${BROKER_PORT}/`, (s) => s === 404, 10_000),
    ]);
    await fetch(`${VITE_BASE}/src/main.ts`).catch(() => undefined);
    await wait(750);

    browser = await chromium.launch();
    for (const count of BROWSER_COUNTS) await runBrowserCase(browser, count);
    for (const count of BROKER_COUNTS) await runBrokerCase(count);
    process.stdout.write('\nDeathmatch multiplayer soak PASS\n');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    cleanup();
  }
}

main().catch((e) => {
  process.stderr.write(`deathmatch soak failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
