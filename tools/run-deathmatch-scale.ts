/**
 * Real-browser deathmatch scale probe.
 *
 * Boots the actual Vite app in Chromium, starts local deathmatch with N AI ships,
 * waits for the WebGL mesh overlay, and measures render + sim health while
 * the game plays. This is intentionally not a pure logic harness: it catches
 * the class of bugs where state is fine but the canvas/mesh path is not.
 *
 * Run:
 *   pnpm run scale:deathmatch
 *   pnpm run scale:deathmatch -- --players=4 --duration=12000
 *   pnpm run scale:deathmatch -- --players=8,16,32 --duration=12000  # stress only
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5198;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const REACH_PLAYING_TIMEOUT_MS = 20_000;
const WEBGL_READY_TIMEOUT_MS = 12_000;
const DEFAULT_DURATION_MS = 10_000;
const DEFAULT_PLAYER_COUNTS = [4];
const MAX_PLAYERS = 64;
const THEME_IDS = new Set(['none', 'crt', 'synthwave', 'thermal', 'gameboy', 'gameboycolor', 'hologram', 'blueprint', 'ascii', 'handdrawn', 'vhs', 'nightvision', 'comic', 'bitdepth']);

interface Sample {
  t: number;
  phase: string;
  frame: number;
  runTimeMs: number;
  players: number;
  aiPlayers: number;
  alive: number;
  asteroids: number;
  terrain: number;
  bullets: number;
  particles: number;
  debris: number;
  respawns: number;
  shipTier: string | null;
  asteroidTier: string | null;
  webglReady: boolean;
}

interface BrowserRunMetrics {
  wallMs: number;
  rafFrames: number;
  avgFps: number;
  simFps: number;
  longFrames50: number;
  longFrames100: number;
  maxFrameMs: number;
  start: Sample;
  end: Sample;
  samples: Sample[];
}

interface ScaleResult extends BrowserRunMetrics {
  requestedPlayers: number;
  pageErrors: string[];
  screenshot: string;
  hardOk: boolean;
  healthy: boolean;
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function parsePlayerCounts(): number[] {
  const raw = argValue('players');
  if (!raw) return DEFAULT_PLAYER_COUNTS;
  const out = raw.split(',')
    .map((part) => Math.floor(Number(part.trim())))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(2, Math.min(MAX_PLAYERS, n)));
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

function parseDurationMs(): number {
  const raw = argValue('duration');
  if (!raw) return DEFAULT_DURATION_MS;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(2000, n) : DEFAULT_DURATION_MS;
}

function parseTheme(): string {
  const raw = argValue('theme');
  return raw && THEME_IDS.has(raw) ? raw : 'crt';
}

async function startVite(): Promise<ChildProcess> {
  const vite = spawn('pnpm', ['exec', 'vite', '--force', '--host', '127.0.0.1', '--port', String(VITE_PORT), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const probe = (window as any).__pallasiteRenderProbe?.();
      return probe?.webglOverlayReady === true;
    },
    undefined,
    { timeout: WEBGL_READY_TIMEOUT_MS },
  ).then(() => true).catch(() => false);
}

async function measureDeathmatch(page: Page, durationMs: number): Promise<BrowserRunMetrics> {
  const script = `
    (() => new Promise((resolve) => {
      const measureMs = ${JSON.stringify(durationMs)};
      const snap = (t) => {
        const s = window.__pallasiteState;
        const probe = window.__pallasiteRenderProbe?.() ?? null;
        const players = Array.isArray(s?.players) ? s.players : [];
        const asteroids = Array.isArray(s?.asteroids) ? s.asteroids : [];
        const pending = Array.isArray(s?.pendingTransitions) ? s.pendingTransitions : [];
        return {
          t: Math.round(t),
          phase: String(s?.phase ?? 'missing'),
          frame: Math.round(Number(s?.frame ?? 0)),
          runTimeMs: Math.round(Number(s?.runTimeMs ?? 0)),
          players: players.length,
          aiPlayers: players.filter((p) => p?.ai === true).length,
          alive: players.filter((p) => p?.ship?.alive === true).length,
          asteroids: asteroids.length,
          terrain: asteroids.filter((a) => a?.terrain === true && a?.alive === true).length,
          bullets: Array.isArray(s?.bullets) ? s.bullets.length : 0,
          particles: Array.isArray(s?.particles) ? s.particles.length : 0,
          debris: Array.isArray(s?.debris) ? s.debris.length : 0,
          respawns: pending.filter((tr) => tr?.kind === 'respawn').length,
          shipTier: probe?.shipTier ?? null,
          asteroidTier: probe?.asteroidTier ?? null,
          webglReady: probe?.webglOverlayReady === true,
        };
      };

      const startAt = performance.now();
      const start = snap(0);
      const samples = [start];
      let nextSampleAt = startAt + 1000;
      let rafFrames = 0;
      let longFrames50 = 0;
      let longFrames100 = 0;
      let maxFrameMs = 0;
      let last = startAt;

      const tick = (now) => {
        const dt = now - last;
        last = now;
        if (rafFrames > 0) {
          if (dt > maxFrameMs) maxFrameMs = dt;
          if (dt > 50) longFrames50++;
          if (dt > 100) longFrames100++;
        }
        rafFrames++;

        while (now >= nextSampleAt) {
          samples.push(snap(nextSampleAt - startAt));
          nextSampleAt += 1000;
        }

        if (now - startAt >= measureMs) {
          const wallMs = now - startAt;
          const end = snap(wallMs);
          const avgFps = rafFrames / (wallMs / 1000);
          const simFps = (end.frame - start.frame) / (wallMs / 1000);
          resolve({
            wallMs,
            rafFrames,
            avgFps,
            simFps,
            longFrames50,
            longFrames100,
            maxFrameMs,
            start,
            end,
            samples,
          });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    }))()
  `;
  return await page.evaluate(script) as BrowserRunMetrics;
}

async function runCase(browser: Browser, requestedPlayers: number, durationMs: number, theme: string): Promise<ScaleResult> {
  const pageErrors: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await context.addInitScript((selectedTheme) => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:mode', 'deathmatch');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:visualStyle', JSON.stringify({
      asteroid: 'mesh',
      ship: 'mesh',
      bullet: 'mesh',
      particle: 'mesh',
      theme: selectedTheme,
      asciiCols: 96,
      bitDepth: 4,
      bitColour: false,
    }));
  }, theme);
  const page = await context.newPage();
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));

  try {
    const url = `${VITE_BASE}/?mode=deathmatch&autoStart=1&deathmatchPlayers=${requestedPlayers}&deathmatchAi=all`;
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(() => window.focus());
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (players) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = (window as any).__pallasiteState;
        return s?.phase === 'playing' && s.players?.length === players;
      },
      requestedPlayers,
      { timeout: REACH_PLAYING_TIMEOUT_MS },
    );

    const webglReady = await waitForWebGL(page);
    await wait(500);

    const metrics = await measureDeathmatch(page, durationMs);

    const screenshot = `/tmp/pallasite-deathmatch-scale-${requestedPlayers}.png`;
    await page.screenshot({ path: screenshot, fullPage: false });
    const hardOk = pageErrors.length === 0
      && metrics.end.phase === 'playing'
      && metrics.end.players === requestedPlayers
      && metrics.end.aiPlayers === requestedPlayers
      && metrics.end.runTimeMs - metrics.start.runTimeMs > durationMs * 0.75
      && (webglReady || metrics.end.webglReady);
    const healthy = hardOk && metrics.avgFps >= 45 && metrics.simFps >= 55 && metrics.longFrames100 === 0;
    return { ...metrics, requestedPlayers, pageErrors, screenshot, hardOk, healthy };
  } finally {
    await context.close();
  }
}

function printResult(r: ScaleResult): void {
  const tag = r.healthy ? 'HEALTHY' : r.hardOk ? 'SLOW' : 'FAIL';
  process.stdout.write(
    `[${tag}] ${String(r.requestedPlayers).padStart(2)} players  `
    + `render=${r.avgFps.toFixed(1)}fps  sim=${r.simFps.toFixed(1)}fps  `
    + `alive=${String(r.end.alive).padStart(2)}/${r.end.players}  `
    + `rocks=${String(r.end.asteroids).padStart(2)} terrain=${r.end.terrain}  `
    + `bullets=${String(r.end.bullets).padStart(3)} particles=${String(r.end.particles).padStart(3)}  `
    + `long>50=${r.longFrames50} max=${r.maxFrameMs.toFixed(1)}ms  `
    + `mesh=${r.end.shipTier}/${r.end.asteroidTier}/${r.end.webglReady ? 'ready' : 'cold'}\n`,
  );
  process.stdout.write(`       screenshot ${r.screenshot}\n`);
  if (r.pageErrors.length > 0) {
    for (const err of r.pageErrors) process.stdout.write(`       pageerror ${err}\n`);
  }
}

async function main(): Promise<void> {
  const players = parsePlayerCounts();
  const durationMs = parseDurationMs();
  const theme = parseTheme();
  process.stdout.write(`deathmatch scale probe: players=${players.join(',')} duration=${durationMs}ms theme=${theme}\n`);

  let vite: ChildProcess | null = null;
  if (await httpReady(VITE_BASE + '/')) {
    process.stdout.write(`using existing Vite at ${VITE_BASE}\n`);
  } else {
    process.stdout.write('starting Vite...\n');
    vite = await startVite();
  }

  const kill = (): void => { killGroup(vite); };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  let exitCode = 0;
  try {
    await waitForHttp(VITE_BASE + '/', VITE_READY_TIMEOUT_MS);
    const browser = await chromium.launch();
    try {
      const results: ScaleResult[] = [];
      for (const count of players) {
        process.stdout.write(`running ${count}-player case...\n`);
        const result = await runCase(browser, count, durationMs, theme);
        results.push(result);
        printResult(result);
        if (!result.hardOk) exitCode = 1;
      }

      process.stdout.write('\n=== deathmatch scale summary ===\n');
      for (const r of results) printResult(r);
      const biggestHealthy = results.filter((r) => r.healthy).at(-1)?.requestedPlayers ?? 0;
      const biggestHardOk = results.filter((r) => r.hardOk).at(-1)?.requestedPlayers ?? 0;
      process.stdout.write(`largest healthy case: ${biggestHealthy || 'none'} players\n`);
      process.stdout.write(`largest correct-but-maybe-slow case: ${biggestHardOk || 'none'} players\n`);
    } finally {
      await browser.close();
    }
  } catch (e) {
    process.stderr.write(`deathmatch scale error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    kill();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
