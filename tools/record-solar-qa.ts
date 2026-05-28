/**
 * Record a focused solar-system scenery QA clip from the real app.
 *
 * The capture path records the composited game canvas directly, then
 * transcodes the image sequence to MP4. Output:
 * tools/record-out/solar-system-qa.mp4.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5201;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const REACH_PLAYING_TIMEOUT_MS = 20_000;
const WEBGL_READY_TIMEOUT_MS = 12_000;
const WORLD_W = 4096;
const WORLD_H = 4096;
const SOLAR_DAYS_PER_MS = 0.0012;
const RECORD_FPS = 24;
const SEGMENT_MS = 1_650;
const VIEWPORT = { width: 1280, height: 720 } as const;
const OUT_DIR = resolve(process.cwd(), 'tools/record-out');
const FINAL_MP4 = resolve(OUT_DIR, 'solar-system-qa.mp4');

type BodyKind = 'sol' | 'mercury' | 'venus' | 'earth' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'pluto' | 'belt';
interface Body { kind: BodyKind; x: number; y: number; radius: number }

const PLANETS = [
  { kind: 'mercury' as const, orbitRx: 360, orbitRy: 214, periodDays: 87.969, epoch: 0.92, radius: 24 },
  { kind: 'venus' as const, orbitRx: 560, orbitRy: 330, periodDays: 224.701, epoch: 1.70, radius: 42 },
  { kind: 'earth' as const, orbitRx: 870, orbitRy: 520, periodDays: 365.256, epoch: 0.35, radius: 58 },
  { kind: 'mars' as const, orbitRx: 1180, orbitRy: 705, periodDays: 686.980, epoch: 1.05, radius: 34 },
  { kind: 'jupiter' as const, orbitRx: 1990, orbitRy: 1190, periodDays: 4332.590, epoch: 0.62, radius: 185 },
  { kind: 'saturn' as const, orbitRx: 2760, orbitRy: 1640, periodDays: 10759.220, epoch: 1.14, radius: 118 },
  { kind: 'uranus' as const, orbitRx: 3220, orbitRy: 1920, periodDays: 30688.500, epoch: 0.54, radius: 84 },
  { kind: 'pluto' as const, orbitRx: 3500, orbitRy: 2080, periodDays: 90560.000, epoch: 0.83, radius: 30 },
];

function solarAngle(now: number, periodDays: number, epoch: number): number {
  return epoch + ((now * SOLAR_DAYS_PER_MS) / periodDays) * Math.PI * 2;
}

function solarBodies(now: number): Body[] {
  const sun = { x: WORLD_W * 0.13, y: WORLD_H * 0.16 };
  return [
    { kind: 'sol', x: sun.x, y: sun.y, radius: 68 },
    ...PLANETS.map((p) => {
      const angle = solarAngle(now, p.periodDays, p.epoch);
      return {
        kind: p.kind,
        x: sun.x + Math.cos(angle) * p.orbitRx,
        y: sun.y + Math.sin(angle) * p.orbitRy,
        radius: p.radius,
      };
    }),
    { kind: 'belt', x: sun.x + 1460, y: sun.y, radius: 240 },
  ];
}

async function startVite(): Promise<ChildProcess> {
  const vite = spawn('pnpm', ['exec', 'vite', '--force', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  vite.stdout?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[vite] ${s}`);
  });
  vite.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[vite] ${s}`);
  });
  return vite;
}

function killGroup(p: ChildProcess | null): void {
  if (!p || p.killed || p.pid === undefined) return;
  try { process.kill(-p.pid, 'SIGTERM'); }
  catch { try { p.kill('SIGTERM'); } catch { /* already dead */ } }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await wait(150);
  }
  throw new Error(`vite not ready at ${url} in ${timeoutMs}ms: ${String(lastErr)}`);
}

async function httpReady(url: string): Promise<boolean> {
  try {
    const r = await fetch(url);
    return r.status < 500;
  } catch {
    return false;
  }
}

async function waitForWebGL(page: Page): Promise<boolean> {
  return page.waitForFunction(
    () => {
      const probe = (window as unknown as { __pallasiteRenderProbe?: () => { webglOverlayReady?: boolean } }).__pallasiteRenderProbe?.();
      return probe?.webglOverlayReady === true;
    },
    undefined,
    { timeout: WEBGL_READY_TIMEOUT_MS },
  ).then(() => true).catch(() => false);
}

async function focusBody(page: Page, body: Body): Promise<void> {
  await page.evaluate(({ x, y }) => {
    const s = (window as unknown as { __pallasiteState?: any }).__pallasiteState;
    const p = s?.players?.[0];
    if (!s || !p) throw new Error('missing Pallasite state/player');
    p.ship.alive = true;
    p.ship.pos.x = x;
    p.ship.pos.y = y;
    p.ship.vel.x = 0;
    p.ship.vel.y = 0;
    p.ship.invulnerableUntil = s.elapsed + 30_000;
    p.keys = {};
    p.thrustOverride = false;
    p.targetHeading = null;
    s.cameraTrauma = 0;
    s.asteroids = [];
    s.bullets = [];
    s.enemyBullets = [];
    s.particles = [];
    s.debris = [];
    for (let i = 1; i < s.players.length; i++) {
      s.players[i].ship.alive = false;
      s.players[i].lives = Math.max(1, s.players[i].lives ?? 1);
    }
  }, { x: body.x, y: body.y });
  await wait(580);
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: any }).__pallasiteState;
    const p = s?.players?.[0];
    if (p) p.ship.alive = false;
  });
  await wait(120);
}

async function recordSegment(page: Page, frameDir: string, startIndex: number, durationMs: number): Promise<number> {
  const frameCount = Math.round(durationMs * RECORD_FPS / 1000);
  await page.exposeBinding(`__pallasiteSaveSolarFrame${startIndex}`, async (_source, index: number, dataUrl: string) => {
    const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    writeFileSync(resolve(frameDir, `frame-${String(index).padStart(4, '0')}.jpg`), Buffer.from(b64, 'base64'));
  });
  const bindingName = `__pallasiteSaveSolarFrame${startIndex}`;
  const script = String.raw`(async () => {
    const duration = ${JSON.stringify(durationMs)};
    const fps = ${JSON.stringify(RECORD_FPS)};
    const start = ${JSON.stringify(startIndex)};
    const width = ${JSON.stringify(VIEWPORT.width)};
    const height = ${JSON.stringify(VIEWPORT.height)};
    const binding = ${JSON.stringify(bindingName)};
    const canvas = document.getElementById('game');
    const overlay = document.getElementById('game3d');
    const saveFrame = window[binding];
    if (!canvas || typeof saveFrame !== 'function') {
      throw new Error('recording canvas unavailable');
    }
    const recCanvas = document.createElement('canvas');
    recCanvas.width = width;
    recCanvas.height = height;
    const recCtx = recCanvas.getContext('2d', { alpha: false });
    if (!recCtx) {
      throw new Error('recording context unavailable');
    }
    const frameCountLocal = Math.round(duration * fps / 1000);
    const started = performance.now();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < frameCountLocal; i += 1) {
      const target = started + (i * 1000 / fps);
      const delay = target - performance.now();
      if (delay > 0) await sleep(delay);
      recCtx.setTransform(1, 0, 0, 1, 0, 0);
      recCtx.clearRect(0, 0, width, height);
      recCtx.drawImage(canvas, 0, 0, width, height);
      if (overlay && overlay.width > 0 && overlay.height > 0) {
        recCtx.drawImage(overlay, 0, 0, width, height);
      }
      await saveFrame(start + i, recCanvas.toDataURL('image/jpeg', 0.92));
    }
  })()`;
  await page.evaluate(script);
  return frameCount;
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const frameDir = resolve(OUT_DIR, `solar-system-qa-frames-${Date.now().toString(16)}`);
  mkdirSync(frameDir, { recursive: true });

  let vite: ChildProcess | null = null;
  if (await httpReady(`${VITE_BASE}/`)) {
    process.stdout.write(`using existing Vite at ${VITE_BASE}\n`);
  } else {
    process.stdout.write('starting Vite...\n');
    vite = await startVite();
  }
  const kill = (): void => { killGroup(vite); };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  let browser: Browser | null = null;
  try {
    await waitForHttp(`${VITE_BASE}/`, VITE_READY_TIMEOUT_MS);
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await context.addInitScript(() => {
      localStorage.setItem('pallasite:onboarded', '1');
      localStorage.setItem('pallasite:mode', 'deathmatch');
      localStorage.setItem('pallasite:daily', '0');
      localStorage.setItem('pallasite:displayMode', 'modern');
      localStorage.setItem('pallasite:visualStyle', JSON.stringify({
        asteroid: 'mesh',
        ship: 'mesh',
        bullet: 'mesh',
        particle: 'mesh',
        theme: 'none',
        asciiCols: 96,
        bitDepth: 4,
        bitColour: false,
      }));
    });
    const page = await context.newPage();
    page.on('pageerror', (e: Error) => process.stderr.write(`[pageerror] ${e.message}\n`));
    await page.goto(`${VITE_BASE}/?deathmatchPlayers=4&deathmatchAi=all&deathmatchKills=80&deathmatchTime=300`, { waitUntil: 'load' });
    await page.evaluate(() => window.focus());
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => {
        const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: unknown[] } }).__pallasiteState;
        return s?.phase === 'playing' && s.players?.length === 4;
      },
      undefined,
      { timeout: REACH_PLAYING_TIMEOUT_MS },
    );
    await page.evaluate(async () => {
      const render = await import('/src/render.ts');
      render.setHudHidden(true);
      const root = document.getElementById('ui-root');
      if (root) root.style.display = 'none';
    });
    const webglReady = await waitForWebGL(page);
    process.stdout.write(`webgl overlay ready: ${webglReady}\n`);

    let frame = 0;
    for (const kind of ['sol', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'pluto', 'belt'] as BodyKind[]) {
      const now = await page.evaluate(() => (window as unknown as { __pallasiteState?: { elapsed?: number } }).__pallasiteState?.elapsed ?? 0);
      const body = solarBodies(now).find((b) => b.kind === kind);
      if (!body) throw new Error(`missing solar body ${kind}`);
      process.stdout.write(`recording ${kind}...\n`);
      await focusBody(page, body);
      frame += await recordSegment(page, frameDir, frame, SEGMENT_MS);
    }
    await context.close();

    const ffmpeg = spawnSync('ffmpeg', [
      '-y',
      '-framerate', String(RECORD_FPS),
      '-i', resolve(frameDir, 'frame-%04d.jpg'),
      '-vf', 'format=yuv420p',
      '-movflags', '+faststart',
      FINAL_MP4,
    ], { stdio: 'inherit' });
    if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed with status ${ffmpeg.status}`);
    process.stdout.write(`solar QA MP4: ${FINAL_MP4}\n`);
    process.stdout.write(`frames: ${frameDir}\n`);
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    kill();
  }
}

main().catch((e) => {
  process.stderr.write(`solar recording failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
