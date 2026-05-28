/**
 * Production multiplayer smoke for pallasite.app + controller.pallasite.app.
 *
 * Covers real browser lockstep for co-op/deathmatch join flows and a short
 * raw WebSocket fan-out probe for 4/8/16/64 relay pressure.
 *
 * Run:
 *   pnpm exec tsx tools/check-prod-multiplayer.ts
 *   TARGET=https://staging.example BROKER=wss://controller.example pnpm exec tsx tools/check-prod-multiplayer.ts
 */

import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const TARGET = (process.env.TARGET ?? 'https://pallasite.app').replace(/\/$/, '');
const BROKER = (process.env.BROKER ?? 'wss://controller.pallasite.app').replace(/\/$/, '');
const VIEWPORT = { width: 1280, height: 720 } as const;
const START_TIMEOUT_MS = 35_000;

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function intArg(name: string, fallback: number, min: number, max: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseCounts(name: string, fallback: number[]): number[] {
  const raw = argValue(name);
  if (!raw) return fallback;
  const counts = raw.split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(2, Math.min(64, Math.floor(n))));
  return Array.from(new Set(counts)).sort((a, b) => a - b);
}

const BROWSER_DURATION_MS = intArg('browserDuration', 6_000, 2_000, 30_000);
const SCALE_DURATION_MS = intArg('scaleDuration', 1_500, 750, 10_000);
const SCALE_RATE_HZ = intArg('scaleRate', 20, 5, 60);
const SCALE_BATCH = intArg('scaleBatch', 4, 1, 16);
const SCALE_COUNTS = parseCounts('scale', [4, 8, 16, 64]);
const ONLY_CASES = new Set((argValue('only') ?? 'all').split(',').map((v) => v.trim()).filter(Boolean));
const NAV_OPTS = { waitUntil: 'commit' as const, timeout: 60_000 };
const NAV_RETRIES = 3;

interface PeerDebugProbe {
  active?: boolean;
  frame?: number;
  inputDelay?: number;
  stallFrames?: number;
  stallCount?: number;
  maxStallFrames?: number;
  resendCount?: number;
  resendFrameCount?: number;
  localLatest?: number;
  remoteLatest?: number;
  localRemoteFrameGap?: number | null;
  slotFrameSpread?: number | null;
  lastReceivedFrame?: number;
}

interface PageProbe {
  frame: number;
  phase: string;
  peerActive: boolean;
  desync: boolean;
  stall: string | null;
  players: number;
  aiPlayers: number;
  inputCounts: number[];
  debug: PeerDebugProbe | null;
}

interface ClientPage {
  label: string;
  page: Page;
  context: BrowserContext;
  pageErrors: string[];
  consoleErrors: string[];
}

interface BrowserCaseResult {
  name: string;
  pages: PageProbe[];
  overlaySamples: number;
  maxStallFrames: number;
  maxFrameGap: number;
  totalResends: number;
}

function visualStyle(): string {
  return JSON.stringify({
    asteroid: 'vector',
    ship: 'vector',
    bullet: 'vector',
    particle: 'vector',
    theme: 'none',
    asciiCols: 96,
    bitDepth: 4,
    bitColour: false,
  });
}

async function newClient(browser: Browser, label: string): Promise<ClientPage> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });
  await context.addInitScript((style) => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:visualStyle', style);
  }, visualStyle());
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' && !text.startsWith('Failed to load resource:')) consoleErrors.push(text);
    if (text.includes('[duel]') || text.includes('[spectate]') || text.includes('[peer]') || text.includes('session-error')) {
      process.stderr.write(`[${label} ${msg.type()}] ${text}\n`);
    }
  });
  return { label, page, context, pageErrors, consoleErrors };
}

async function gotoClient(client: ClientPage, url: string): Promise<void> {
  for (let attempt = 1; attempt <= NAV_RETRIES; attempt++) {
    try {
      await client.page.goto(url, NAV_OPTS);
      return;
    } catch (error) {
      if (attempt >= NAV_RETRIES) throw error;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[${client.label}] navigation retry ${attempt}/${NAV_RETRIES}: ${message.split('\n')[0]}\n`);
      await wait(500 * attempt);
    }
  }
}

function peerUrl(session: string, role = 'peer'): string {
  return `${BROKER}/?s=${encodeURIComponent(session)}&r=${role}`;
}

function appUrl(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    sp.set(key, String(value));
  }
  sp.set('prodQa', String(Date.now()));
  return `${TARGET}/?${sp.toString()}`;
}

function coopUrl(session: string, slot: number): string {
  return appUrl({
    peer: BROKER,
    session,
    slot,
    players: 2,
    mode: 'coop-campaign',
    wiretrace: 1,
    peerBatch: 1,
  });
}

function deathmatchPeerUrl(session: string, slot: number, players: number, opts: { aiFill?: boolean; humanSlots?: string } = {}): string {
  return appUrl({
    peer: BROKER,
    session,
    slot,
    players,
    deathmatchPlayers: players,
    mode: 'deathmatch',
    deathmatchTime: 300,
    deathmatchKills: 250,
    deathmatchRespawns: 99,
    wiretrace: 1,
    peerBatch: 1,
    aiFill: opts.aiFill ? 1 : undefined,
    humanSlots: opts.humanSlots,
  });
}

function spectateUrl(session: string, players: number, aiFill = false): string {
  return appUrl({
    peer: peerUrl(session, 'peerwatch'),
    spectate: session,
    players,
    deathmatchPlayers: players,
    mode: 'deathmatch',
    wiretrace: 1,
    peerBatch: 1,
    aiFill: aiFill ? 1 : undefined,
  });
}

async function probe(page: Page, players: number): Promise<PageProbe> {
  return page.evaluate((expectedPlayers) => {
    const s = (window as any).__pallasiteState;
    const inputProbe = (window as any).__pallasiteInputLogProbe as ((from: number, to: number) => Array<[number, number, number]> | null) | undefined;
    const debug = ((window as any).__pallasitePeerDebug?.() ?? null) as PeerDebugProbe | null;
    const counts = new Array(expectedPlayers).fill(0);
    const frame = Math.max(0, Math.floor(Number(s?.frame ?? 0)));
    const rows = inputProbe ? inputProbe(0, Math.min(180, frame)) : null;
    if (rows) {
      for (const [, slot, encoded] of rows) {
        if (slot >= 0 && slot < expectedPlayers && encoded >= 0) counts[slot]++;
      }
    }
    return {
      frame,
      phase: String(s?.phase ?? 'unknown'),
      peerActive: !!(window as any).__pallasitePeerActive,
      desync: document.body.hasAttribute('data-peer-desync'),
      stall: document.body.getAttribute('data-peer-stall'),
      players: Array.isArray(s?.players) ? s.players.length : 0,
      aiPlayers: Array.isArray(s?.players) ? s.players.filter((p: any) => p?.ai === true).length : -1,
      inputCounts: counts,
      debug,
    };
  }, players);
}

async function waitPlaying(client: ClientPage, players: number, expectedAi: number): Promise<void> {
  await client.page.waitForFunction(
    ({ players, expectedAi }) => {
      const s = (window as any).__pallasiteState;
      return !!(window as any).__pallasitePeerActive
        && s?.phase === 'playing'
        && s?.players?.length === players
        && s.players.filter((p: any) => p?.ai === true).length === expectedAi;
    },
    { players, expectedAi },
    { timeout: START_TIMEOUT_MS },
  );
}

async function driveInputs(clients: ClientPage[], durationMs: number): Promise<void> {
  const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Space'];
  await Promise.all(clients.map((client, i) => client.page.keyboard.down(keys[i % keys.length]).catch(() => undefined)));
  await wait(durationMs);
  await Promise.all(clients.map((client, i) => client.page.keyboard.up(keys[i % keys.length]).catch(() => undefined)));
}

async function sampleOverlay(clients: ClientPage[], durationMs: number): Promise<number> {
  let overlaySamples = 0;
  const ticks = Math.max(1, Math.ceil(durationMs / 100));
  for (let i = 0; i < ticks; i++) {
    await wait(100);
    const stalls = await Promise.all(clients.map((client) => client.page.evaluate(() => document.body.getAttribute('data-peer-stall'))));
    if (stalls.some(Boolean)) overlaySamples++;
  }
  return overlaySamples;
}

function summarise(name: string, probes: PageProbe[], overlaySamples: number): BrowserCaseResult {
  return {
    name,
    pages: probes,
    overlaySamples,
    maxStallFrames: Math.max(0, ...probes.map((p) => Number(p.debug?.maxStallFrames ?? 0))),
    maxFrameGap: Math.max(0, ...probes.map((p) => Math.abs(Number(p.debug?.localRemoteFrameGap ?? 0)))),
    totalResends: probes.reduce((sum, p) => sum + Number(p.debug?.resendCount ?? 0), 0),
  };
}

function assertBrowserCase(result: BrowserCaseResult, expected: { players: number; ai: number; humanSlots: number[]; spectator?: boolean }): void {
  for (let i = 0; i < result.pages.length; i++) {
    const p = result.pages[i];
    if (!p.peerActive) throw new Error(`${result.name} page ${i + 1} peer inactive`);
    if (p.phase !== 'playing') throw new Error(`${result.name} page ${i + 1} phase=${p.phase}`);
    if (p.players !== expected.players) throw new Error(`${result.name} page ${i + 1} players=${p.players}`);
    if (!expected.spectator && p.aiPlayers !== expected.ai) throw new Error(`${result.name} page ${i + 1} ai=${p.aiPlayers}`);
    if (p.stall) throw new Error(`${result.name} page ${i + 1} still showing sync overlay`);
    if (p.desync) throw new Error(`${result.name} page ${i + 1} desynced`);
    if (p.frame < 100) throw new Error(`${result.name} page ${i + 1} frame too low: ${p.frame}`);
    for (const slot of expected.humanSlots) {
      if ((p.inputCounts[slot] ?? 0) < 60) throw new Error(`${result.name} page ${i + 1} sparse slot ${slot}: ${p.inputCounts.join('/')}`);
    }
  }
  if (result.overlaySamples > 0) throw new Error(`${result.name} showed sync overlay in ${result.overlaySamples} samples`);
  if (result.maxStallFrames >= 180) throw new Error(`${result.name} max stall too high: ${result.maxStallFrames}f`);
}

function printBrowserResult(result: BrowserCaseResult): void {
  const lines = result.pages.map((p, i) => {
    const d = p.debug;
    return `    P${i + 1}: frame=${p.frame} ai=${p.aiPlayers} stall=${p.stall ?? '-'} desync=${p.desync}`
      + ` delay=${d?.inputDelay ?? '-'} maxStall=${d?.maxStallFrames ?? '-'}`
      + ` resends=${d?.resendCount ?? '-'}/${d?.resendFrameCount ?? '-'} gap=${d?.localRemoteFrameGap ?? '-'}`;
  });
  process.stdout.write(`[browser] ${result.name} PASS overlay=${result.overlaySamples} maxStall=${result.maxStallFrames}f gap=${result.maxFrameGap} resends=${result.totalResends}\n${lines.join('\n')}\n`);
}

function printBrowserFailure(result: BrowserCaseResult): void {
  const lines = result.pages.map((p, i) => {
    const d = p.debug;
    return `    P${i + 1}: frame=${p.frame} phase=${p.phase} players=${p.players} ai=${p.aiPlayers}`
      + ` peer=${p.peerActive} stall=${p.stall ?? '-'} desync=${p.desync}`
      + ` delay=${d?.inputDelay ?? '-'} stallCount=${d?.stallCount ?? '-'} maxStall=${d?.maxStallFrames ?? '-'}`
      + ` resends=${d?.resendCount ?? '-'}/${d?.resendFrameCount ?? '-'}`
      + ` gap=${d?.localRemoteFrameGap ?? '-'} spread=${d?.slotFrameSpread ?? '-'} inputs=${p.inputCounts.join('/')}`;
  });
  process.stderr.write(`[browser] ${result.name} FAIL overlay=${result.overlaySamples} maxStall=${result.maxStallFrames}f gap=${result.maxFrameGap} resends=${result.totalResends}\n${lines.join('\n')}\n`);
}

async function finishBrowserCase(name: string, clients: ClientPage[], players: number, expectedAi: number, humanSlots: number[]): Promise<BrowserCaseResult> {
  const inputPromise = driveInputs(clients.filter((c) => !c.label.includes('watch')), Math.floor(BROWSER_DURATION_MS * 0.75));
  const overlaySamples = await sampleOverlay(clients, BROWSER_DURATION_MS);
  await inputPromise.catch(() => undefined);
  const probes = await Promise.all(clients.map((client) => probe(client.page, players)));
  const result = summarise(name, probes, overlaySamples);
  try {
    assertBrowserCase(result, { players, ai: expectedAi, humanSlots });
  } catch (error) {
    printBrowserFailure(result);
    throw error;
  }
  printBrowserResult(result);
  return result;
}

async function closeClients(clients: ClientPage[]): Promise<void> {
  await Promise.all(clients.map((client) => client.context.close().catch(() => undefined)));
}

async function runCoop2(browser: Browser): Promise<BrowserCaseResult> {
  const session = `coop-${randomBytes(4).toString('hex')}`;
  const clients = [await newClient(browser, 'coop P1'), await newClient(browser, 'coop P2')];
  try {
    await Promise.all(clients.map((client, slot) => gotoClient(client, coopUrl(session, slot))));
    await Promise.all(clients.map((client) => waitPlaying(client, 2, 0)));
    return await finishBrowserCase('2P co-op', clients, 2, 0, [0, 1]);
  } finally {
    await closeClients(clients);
  }
}

async function runDeathmatchPrejoined2(browser: Browser): Promise<BrowserCaseResult> {
  const session = `dmpre-${randomBytes(4).toString('hex')}`;
  const joiner = await newClient(browser, 'prejoined P2');
  const host = await newClient(browser, 'prejoined P1');
  const clients = [host, joiner];
  try {
    await gotoClient(joiner, deathmatchPeerUrl(session, 1, 2, { aiFill: true }));
    await wait(1_800);
    await gotoClient(host, deathmatchPeerUrl(session, 0, 2, { aiFill: true, humanSlots: '0,1' }));
    await Promise.all(clients.map((client) => waitPlaying(client, 2, 0)));
    return await finishBrowserCase('2P deathmatch prejoined', clients, 2, 0, [0, 1]);
  } finally {
    await closeClients(clients);
  }
}

async function runDeathmatchLate2(browser: Browser): Promise<BrowserCaseResult> {
  const session = `dmlate-${randomBytes(4).toString('hex')}`;
  const host = await newClient(browser, 'late P1');
  const joiner = await newClient(browser, 'late P2');
  const clients = [host, joiner];
  try {
    await gotoClient(host, deathmatchPeerUrl(session, 0, 2, { aiFill: true, humanSlots: '0' }));
    await waitPlaying(host, 2, 1);
    await wait(1_800);
    await gotoClient(joiner, deathmatchPeerUrl(session, 1, 2, { aiFill: true }));
    await Promise.all(clients.map((client) => waitPlaying(client, 2, 0)));
    return await finishBrowserCase('2P deathmatch late takeover', clients, 2, 0, [0, 1]);
  } finally {
    await closeClients(clients);
  }
}

async function runDeathmatchAllHuman4(browser: Browser): Promise<BrowserCaseResult> {
  const session = `dm4-${randomBytes(4).toString('hex')}`;
  const clients = await Promise.all(Array.from({ length: 4 }, (_, slot) => newClient(browser, `4P P${slot + 1}`)));
  const watcher = await newClient(browser, '4P watch');
  try {
    await Promise.all(clients.map((client, slot) => gotoClient(client, deathmatchPeerUrl(session, slot, 4))));
    await Promise.all(clients.map((client) => waitPlaying(client, 4, 0)));
    await gotoClient(watcher, spectateUrl(session, 4));
    await waitPlaying(watcher, 4, 0);
    const all = [...clients, watcher];
    return await finishBrowserCase('4P deathmatch all-human + watch', all, 4, 0, [0, 1, 2, 3]);
  } finally {
    await closeClients([...clients, watcher]);
  }
}

async function runDeathmatchAiFill(browser: Browser, players: number): Promise<BrowserCaseResult> {
  const session = `aifill${players}-${randomBytes(4).toString('hex')}`;
  const clients = [await newClient(browser, `${players}P AI P1`), await newClient(browser, `${players}P AI P2`)];
  try {
    await gotoClient(clients[0], deathmatchPeerUrl(session, 0, players, { aiFill: true, humanSlots: '0,1' }));
    await gotoClient(clients[1], deathmatchPeerUrl(session, 1, players, { aiFill: true }));
    await Promise.all(clients.map((client) => waitPlaying(client, players, players - 2)));
    return await finishBrowserCase(`${players}P deathmatch AI-fill`, clients, players, players - 2, [0, 1]);
  } finally {
    await closeClients(clients);
  }
}

interface BrokerPeer {
  ws: WebSocket;
  slot: number;
  joined: Set<number>;
  recvBySlot: number[];
}

function parseWire(data: unknown): any | null {
  try {
    if (typeof data === 'string') return JSON.parse(data);
    if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function recordWire(recvBySlot: number[], msg: any): void {
  const slot = Number(msg?.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot >= recvBySlot.length) return;
  if (msg.type === 'frame') recvBySlot[slot]++;
  else if (msg.type === 'frames' && Array.isArray(msg.inputs)) recvBySlot[slot] += msg.inputs.length;
}

function openBrokerPeer(session: string, slot: number, players: number): Promise<BrokerPeer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(peerUrl(session));
    const peer: BrokerPeer = { ws, slot, joined: new Set([slot]), recvBySlot: new Array(players).fill(0) };
    const timeout = setTimeout(() => reject(new Error(`${players}P broker slot ${slot} join timeout`)), 12_000);
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
    ws.addEventListener('message', (ev) => {
      const msg = parseWire(ev.data);
      if (!msg) return;
      if (msg.type === 'peer-joined' && Number.isInteger(msg.slot)) {
        peer.joined.add(msg.slot);
        maybeReady();
      } else if (msg.type === 'frame' || msg.type === 'frames') {
        recordWire(peer.recvBySlot, msg);
      } else if (msg.type === 'session-error') {
        reject(new Error(`${players}P broker slot ${slot} session-error ${msg.code ?? ''}`));
      }
    });
    ws.addEventListener('error', () => reject(new Error(`${players}P broker slot ${slot} ws error`)));
  });
}

async function runBrokerScale(players: number): Promise<void> {
  const session = `scale${players}-${randomBytes(4).toString('hex')}`;
  const peers = await Promise.all(Array.from({ length: players }, (_, slot) => openBrokerPeer(session, slot, players)));
  const intervalMs = Math.max(20, Math.round((1000 * SCALE_BATCH) / SCALE_RATE_HZ));
  let frame = 0;
  let sentFrames = 0;
  let sentPayloads = 0;
  const timer = setInterval(() => {
    const base = frame;
    for (const peer of peers) {
      if (peer.ws.readyState !== WebSocket.OPEN) continue;
      if (SCALE_BATCH === 1) {
        peer.ws.send(JSON.stringify({ type: 'frame', frame: base, slot: peer.slot, input: peer.slot + 1 }));
      } else {
        const inputs = Array.from({ length: SCALE_BATCH }, (_, i) => ((peer.slot + 1) << 12) | ((base + i) & 0xfff));
        peer.ws.send(JSON.stringify({ type: 'frames', slot: peer.slot, base, inputs }));
      }
    }
    frame += SCALE_BATCH;
    sentFrames += SCALE_BATCH;
    sentPayloads++;
  }, intervalMs);
  await wait(SCALE_DURATION_MS);
  clearInterval(timer);
  await wait(1_000);

  const minExpected = Math.max(1, Math.floor(sentFrames * 0.45));
  const peerTotals: number[] = [];
  for (const peer of peers) {
    let total = 0;
    for (let slot = 0; slot < players; slot++) {
      if (slot === peer.slot) continue;
      const got = peer.recvBySlot[slot];
      if (got < minExpected) throw new Error(`${players}P broker peer ${peer.slot} sparse slot ${slot}: ${got}/${sentFrames}`);
      total += got;
    }
    peerTotals.push(total);
  }
  for (const peer of peers) peer.ws.close();
  process.stdout.write(`[scale] ${players}P PASS frames=${sentFrames} payloads=${sentPayloads} recv=${Math.min(...peerTotals)}..${Math.max(...peerTotals)}\n`);
}

async function main(): Promise<void> {
  const shouldRun = (name: string): boolean => ONLY_CASES.has('all') || ONLY_CASES.has(name);
  process.stdout.write(`prod multiplayer smoke target=${TARGET} broker=${BROKER} duration=${BROWSER_DURATION_MS}ms scale=${SCALE_COUNTS.join(',')} only=${Array.from(ONLY_CASES).join(',')}\n`);
  const browser = await chromium.launch();
  try {
    if (shouldRun('coop')) await runCoop2(browser);
    if (shouldRun('prejoined')) await runDeathmatchPrejoined2(browser);
    if (shouldRun('late')) await runDeathmatchLate2(browser);
    if (shouldRun('allhuman4')) await runDeathmatchAllHuman4(browser);
    if (shouldRun('aifill4')) await runDeathmatchAiFill(browser, 4);
    if (shouldRun('aifill8')) await runDeathmatchAiFill(browser, 8);
    if (shouldRun('scale')) for (const count of SCALE_COUNTS) await runBrokerScale(count);
  } finally {
    await browser.close().catch(() => undefined);
  }
  process.stdout.write('Production multiplayer smoke PASS\n');
}

main().catch((e) => {
  process.stderr.write(`Production multiplayer smoke failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
