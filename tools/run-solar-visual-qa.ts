/**
 * Focused deathmatch solar scenery QA.
 *
 * Runs the real app in Chromium, enters a small AI deathmatch, moves the
 * follow camera to Sol / Earth+Moon / Jupiter / Saturn, and captures evidence
 * screenshots. The central pixel checks are deliberately simple: they catch
 * blank/cropped/subtle-body regressions while the screenshots remain the
 * human-readable artefact for visual tuning.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5199;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const REACH_PLAYING_TIMEOUT_MS = 20_000;
const WEBGL_READY_TIMEOUT_MS = 12_000;
const WORLD_W = 4096;
const WORLD_H = 4096;
const SOLAR_DAYS_PER_MS = 0.0012;

type BodyKind = 'sol' | 'earth' | 'jupiter' | 'saturn';
interface Body { kind: BodyKind; x: number; y: number; radius: number }

const PLANETS = [
  { kind: 'earth' as const, orbitRx: 870, orbitRy: 520, periodDays: 365.256, epoch: 0.35, radius: 58 },
  { kind: 'jupiter' as const, orbitRx: 1990, orbitRy: 1190, periodDays: 4332.590, epoch: 0.62, radius: 185 },
  { kind: 'saturn' as const, orbitRx: 2760, orbitRy: 1640, periodDays: 10759.220, epoch: 1.14, radius: 118 },
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
  await wait(650);
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: any }).__pallasiteState;
    const p = s?.players?.[0];
    if (p) p.ship.alive = false;
  });
  await wait(120);
}

async function sampleBodyPixels(page: Page, body: Body): Promise<{ bright: number; coloured: number; max: number }> {
  return page.evaluate((kind) => {
    const c = document.getElementById('game') as HTMLCanvasElement | null;
    if (!c) throw new Error('missing #game canvas');
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('missing 2D context');
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let bright = 0;
    let coloured = 0;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const red = data[i];
      const green = data[i + 1];
      const blue = data[i + 2];
      const hi = Math.max(red, green, blue);
      const lo = Math.min(red, green, blue);
      if (hi > max) max = hi;
      if (kind === 'sol') {
        if (red > 170 && green > 85 && blue < 130) bright++;
        if (red > 140 && green > 60 && blue < 120 && red - blue > 55) coloured++;
      } else if (kind === 'earth') {
        const ocean = blue > 90 && green > 65 && red < 145 && blue - red > 24;
        const land = green > 105 && red < 145 && blue < 170 && green - red > 18;
        if (ocean || land) bright++;
        if (ocean || land) coloured++;
      } else if (kind === 'jupiter') {
        const band = red > 112 && green > 68 && blue < 145 && red - blue > 18;
        if (band) bright++;
        if (band && red - green < 95) coloured++;
      } else {
        const ringOrDisc = red > 130 && green > 92 && blue < 150 && red - blue > 18;
        if (ringOrDisc) bright++;
        if (ringOrDisc && green - blue > 4) coloured++;
      }
    }
    return { bright, coloured, max };
  }, body.kind);
}

async function runCase(page: Page, body: Body): Promise<{ label: string; screenshot: string; bright: number; coloured: number; max: number }> {
  await focusBody(page, body);
  const sample = await sampleBodyPixels(page, body);
  const screenshot = `/tmp/pallasite-solar-${body.kind}.png`;
  await page.screenshot({ path: screenshot, fullPage: false });
  const minBright = body.kind === 'sol' ? 3000 : body.kind === 'earth' ? 550 : body.kind === 'jupiter' ? 2600 : 900;
  const minColour = body.kind === 'sol' ? 1200 : body.kind === 'earth' ? 400 : body.kind === 'jupiter' ? 900 : 500;
  if (sample.bright < minBright || sample.coloured < minColour || sample.max < 120) {
    throw new Error(`${body.kind} too subtle or missing: bright=${sample.bright}/${minBright} coloured=${sample.coloured}/${minColour} max=${sample.max}`);
  }
  return { label: body.kind, screenshot, ...sample };
}

async function main(): Promise<void> {
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
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
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
    await wait(400);
    const now = await page.evaluate(() => (window as unknown as { __pallasiteState?: { elapsed?: number } }).__pallasiteState?.elapsed ?? 0);
    const bodies = solarBodies(now);
    process.stdout.write(`webgl overlay ready: ${webglReady}\n`);
    for (const body of bodies) {
      const r = await runCase(page, body);
      process.stdout.write(`${r.label.padEnd(7)} bright=${String(r.bright).padStart(5)} coloured=${String(r.coloured).padStart(5)} max=${String(r.max).padStart(3)} screenshot=${r.screenshot}\n`);
    }
    await context.close();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    kill();
  }
}

main().catch((e) => {
  process.stderr.write(`solar visual QA failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
