/**
 * Production playability smoke for pallasite.app.
 *
 * Exercises the deployed app with service workers blocked so the run tests
 * the current network build, not a stale cached bundle. It starts campaign
 * through the real UI, starts local AI-filled deathmatch at 2/4/64 players,
 * measures render/sim health, probes local thrust, and writes screenshots to
 * tools/record-out.
 *
 * Run:
 *   pnpm exec tsx tools/check-prod-playability.ts
 *   TARGET=https://staging.example pnpm exec tsx tools/check-prod-playability.ts
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';

const TARGET = (process.env.TARGET ?? 'https://pallasite.app').replace(/\/$/, '');
const OUT_DIR = resolve(process.cwd(), 'tools/record-out');
const VIEWPORT = { width: 1280, height: 720 } as const;
const REACH_PLAYING_TIMEOUT_MS = 30_000;
const WEBGL_READY_TIMEOUT_MS = 15_000;
const DEFAULT_DURATION_MS = 5_000;

type CaseKind = 'campaign' | 'deathmatch';

interface Sample {
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
  shipTier: string | null;
  asteroidTier: string | null;
  webglReady: boolean;
}

interface Metrics {
  wallMs: number;
  rafFrames: number;
  avgFps: number;
  simFps: number;
  longFrames50: number;
  longFrames100: number;
  maxFrameMs: number;
  start: Sample;
  end: Sample;
}

interface MovementProbe {
  speed: number;
  distance: number;
  frames: number;
}

interface SmokeResult {
  name: string;
  kind: CaseKind;
  requestedPlayers: number;
  expectedAi: number | null;
  pageErrors: string[];
  consoleErrors: string[];
  networkErrors: string[];
  screenshot: string;
  metrics: Metrics;
  movement: MovementProbe | null;
  webglReady: boolean;
  hardOk: boolean;
  healthy: boolean;
}

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function parseDurationMs(): number {
  const raw = argValue('duration');
  if (!raw) return DEFAULT_DURATION_MS;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) ? Math.max(2_000, n) : DEFAULT_DURATION_MS;
}

function visualStyle(theme: string): string {
  return JSON.stringify({
    asteroid: 'mesh',
    ship: 'mesh',
    bullet: 'mesh',
    particle: 'mesh',
    theme,
    asciiCols: 96,
    bitDepth: 4,
    bitColour: false,
  });
}

function guestSession(): unknown {
  return {
    pubkey: '0'.repeat(64),
    displayName: 'PROD QA',
    method: 'guest',
    signer: { capabilities: { canSignEvents: false } },
  };
}

async function newPage(browser: Browser, mode: 'campaign' | 'deathmatch', theme: string): Promise<{ page: Page; pageErrors: string[]; consoleErrors: string[]; networkErrors: string[] }> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });
  await context.addInitScript(({ selectedMode, selectedStyle }) => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:mode', selectedMode);
    localStorage.setItem('pallasite:visualStyle', selectedStyle);
  }, { selectedMode: mode, selectedStyle: visualStyle(theme) });
  const page = await context.newPage();
  page.on('pageerror', (e: Error) => pageErrors.push(e.message));
  page.on('response', (res) => {
    if (res.status() >= 400) networkErrors.push(`${res.status()} ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText ?? '';
    if (reason === 'net::ERR_ABORTED') return;
    networkErrors.push(`failed ${req.url()} ${reason}`.trim());
  });
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    if (msg.type() === 'error' && !text.startsWith('Failed to load resource:')) consoleErrors.push(text);
  });
  return { page, pageErrors, consoleErrors, networkErrors };
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

async function clickButtonContaining(page: Page, label: string): Promise<void> {
  await page.evaluate((text) => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => (b.textContent ?? '').includes(text));
    if (!btn) throw new Error(`button not found: ${text}`);
    (btn as HTMLButtonElement).click();
  }, label);
}

async function startCampaign(page: Page): Promise<void> {
  await page.goto(`${TARGET}/?prodQa=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((session) => {
    const state = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
    if (!state) throw new Error('missing pallasite state');
    state.session = session;
    localStorage.setItem('pallasite:mode', 'campaign');
  }, guestSession());
  await clickButtonContaining(page, 'PLAY');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'CAMPAIGN'),
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(() => {
    const campaign = Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').trim() === 'CAMPAIGN');
    if (!campaign) throw new Error('CAMPAIGN button not found');
    (campaign as HTMLButtonElement).click();
  });
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('IGNITE')),
    undefined,
    { timeout: 10_000 },
  );
  await clickButtonContaining(page, 'IGNITE');
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: unknown[] } }).__pallasiteState;
      return !!s && (s.phase === 'wavestart' || s.phase === 'playing') && s.players?.length === 1;
    },
    undefined,
    { timeout: REACH_PLAYING_TIMEOUT_MS },
  );
  await wait(1_100);
  await page.keyboard.press('ArrowUp').catch(() => undefined);
  await page.waitForFunction(
    () => (window as unknown as { __pallasiteState?: { phase?: string } }).__pallasiteState?.phase === 'playing',
    undefined,
    { timeout: REACH_PLAYING_TIMEOUT_MS },
  );
}

async function startDeathmatch(page: Page, players: number): Promise<void> {
  const params = new URLSearchParams({
    mode: 'deathmatch',
    autoStart: '1',
    deathmatchPlayers: String(players),
    aiFill: '1',
    humanSlots: '0',
    deathmatchTime: '300',
    deathmatchKills: '80',
    prodQa: String(Date.now()),
  });
  await page.goto(`${TARGET}/?${params.toString()}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.focus());
  await page.waitForFunction(
    (expected) => {
      const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: Array<{ ai?: boolean }> } }).__pallasiteState;
      return s?.phase === 'playing'
        && s.players?.length === expected
        && s.players[0]?.ai !== true
        && s.players.filter((p) => p.ai === true).length === expected - 1;
    },
    players,
    { timeout: REACH_PLAYING_TIMEOUT_MS },
  );
}

async function measurePage(page: Page, durationMs: number): Promise<Metrics> {
  const script = `
    (() => new Promise((resolve) => {
      const measureMs = ${JSON.stringify(durationMs)};
      const snap = () => {
        const s = window.__pallasiteState;
        const probe = window.__pallasiteRenderProbe?.() ?? null;
        const players = Array.isArray(s?.players) ? s.players : [];
        const asteroids = Array.isArray(s?.asteroids) ? s.asteroids : [];
        return {
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
          shipTier: probe?.shipTier ?? null,
          asteroidTier: probe?.asteroidTier ?? null,
          webglReady: probe?.webglOverlayReady === true,
        };
      };

      const startAt = performance.now();
      const start = snap();
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
        if (now - startAt >= measureMs) {
          const wallMs = now - startAt;
          const end = snap();
          resolve({
            wallMs,
            rafFrames,
            avgFps: rafFrames / (wallMs / 1000),
            simFps: (end.frame - start.frame) / (wallMs / 1000),
            longFrames50,
            longFrames100,
            maxFrameMs,
            start,
            end,
          });
        } else {
          requestAnimationFrame(tick);
        }
      };
      requestAnimationFrame(tick);
    }))()
  `;
  return await page.evaluate(script) as Metrics;
}

async function probeMovement(page: Page, frames = 30): Promise<MovementProbe> {
  const startFrame = await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: {
      phase?: string;
      frame?: number;
      asteroids?: unknown[];
      ufos?: unknown[];
      mines?: unknown[];
      bullets?: unknown[];
      enemyBullets?: unknown[];
      coins?: unknown[];
      powerups?: unknown[];
      particles?: unknown[];
      debris?: unknown[];
      players?: Array<{
        ai?: boolean;
        keys: Record<string, boolean>;
        ship: {
          alive: boolean;
          pos: { x: number; y: number };
          vel: { x: number; y: number };
          rot: number;
          rotVel: number;
          invulnerableUntil: number;
          hyperspaceCloakMs: number;
        };
      }>;
      elapsed?: number;
      deathmatchRules?: unknown;
    } }).__pallasiteState;
    if (!s?.players?.[0]) throw new Error('missing player');
    s.phase = 'playing';
    const deathmatch = !!s.deathmatchRules;
    if (deathmatch) {
      s.asteroids = [];
    } else if (Array.isArray(s.asteroids)) {
      for (let i = 0; i < s.asteroids.length; i++) {
        const a = s.asteroids[i] as { alive?: boolean; pos?: { x: number; y: number }; vel?: { x: number; y: number }; depth?: number };
        a.alive = true;
        if (a.pos) {
          a.pos.x = 1120 + (i % 3) * 34;
          a.pos.y = 560 + Math.floor(i / 3) * 34;
        }
        if (a.vel) {
          a.vel.x = 0;
          a.vel.y = 0;
        }
        a.depth = 3;
      }
    }
    s.ufos = [];
    s.mines = [];
    s.bullets = [];
    s.enemyBullets = [];
    s.coins = [];
    s.powerups = [];
    s.particles = [];
    s.debris = [];
    for (let i = 1; i < s.players.length; i++) {
      s.players[i].ship.alive = false;
    }
    const p = s.players[0];
    p.ai = false;
    p.keys = {};
    p.ship.alive = true;
    p.ship.pos.x = 640;
    p.ship.pos.y = 360;
    p.ship.vel.x = 0;
    p.ship.vel.y = 0;
    p.ship.rot = 0;
    p.ship.rotVel = 0;
    p.ship.hyperspaceCloakMs = 0;
    p.ship.invulnerableUntil = (s.elapsed ?? 0) + 30_000;
    return s.frame ?? 0;
  });
  await page.evaluate(() => window.focus());
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'ArrowUp',
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    }));
  });
  await page.waitForFunction(
    ({ start, count }) => {
      const s = (window as unknown as { __pallasiteState?: { frame?: number } }).__pallasiteState;
      return Number(s?.frame ?? 0) >= start + count;
    },
    { start: startFrame, count: frames },
    { timeout: 8_000 },
  );
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keyup', {
      code: 'ArrowUp',
      key: 'ArrowUp',
      bubbles: true,
      cancelable: true,
    }));
  }).catch(() => undefined);
  return page.evaluate(({ start, count }) => {
    const s = (window as unknown as { __pallasiteState?: { frame?: number; players?: Array<{ keys: Record<string, boolean>; ship: { pos: { x: number; y: number }; vel: { x: number; y: number } } }> } }).__pallasiteState;
    const p = s?.players?.[0];
    if (!p) throw new Error('missing player after movement probe');
    return {
      speed: Math.hypot(p.ship.vel.x, p.ship.vel.y),
      distance: Math.hypot(p.ship.pos.x - 640, p.ship.pos.y - 360),
      frames: Number(s?.frame ?? start) - start || count,
    };
  }, { start: startFrame, count: frames });
}

async function saveScreenshot(page: Page, path: string): Promise<string> {
  try {
    const client = await page.context().newCDPSession(page);
    const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(path, Buffer.from(shot.data, 'base64'));
    await client.detach();
    return path;
  } catch (e) {
    process.stderr.write(`[screenshot warning] cdp ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
  try {
    await page.screenshot({ path, fullPage: false, timeout: 5_000 });
    return path;
  } catch (e) {
    process.stderr.write(`[screenshot warning] playwright ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    return `${path} (capture failed)`;
  }
}

async function runCampaign(browser: Browser, durationMs: number): Promise<SmokeResult> {
  const { page, pageErrors, consoleErrors, networkErrors } = await newPage(browser, 'campaign', 'none');
  try {
    await startCampaign(page);
    const webglReady = await waitForWebGL(page);
    await wait(500);
    const screenshot = resolve(OUT_DIR, 'prod-playability-campaign.png');
    const screenshotPath = await saveScreenshot(page, screenshot);
    const movement = await probeMovement(page);
    const metrics = await measurePage(page, durationMs);
    const hardOk = pageErrors.length === 0
      && metrics.end.phase === 'playing'
      && metrics.end.players === 1
      && movement.speed > 70
      && movement.distance > 20;
    const healthy = hardOk && metrics.avgFps >= 45 && metrics.simFps >= 55 && metrics.longFrames100 <= 1;
    return { name: 'campaign-standard', kind: 'campaign', requestedPlayers: 1, expectedAi: 0, pageErrors, consoleErrors, networkErrors, screenshot: screenshotPath, metrics, movement, webglReady, hardOk, healthy };
  } finally {
    await page.context().close();
  }
}

async function runDeathmatch(browser: Browser, players: number, durationMs: number, theme: 'none' | 'crt'): Promise<SmokeResult> {
  const { page, pageErrors, consoleErrors, networkErrors } = await newPage(browser, 'deathmatch', theme);
  try {
    await startDeathmatch(page, players);
    const webglReady = await waitForWebGL(page);
    await wait(500);
    const screenshot = resolve(OUT_DIR, `prod-playability-deathmatch-${players}p-${theme}.png`);
    const screenshotPath = await saveScreenshot(page, screenshot);
    const movement = players <= 4 ? await probeMovement(page) : null;
    const metrics = await measurePage(page, durationMs);
    const expectedAi = players - 1;
    const hardOk = pageErrors.length === 0
      && metrics.end.phase === 'playing'
      && metrics.end.players === players
      && metrics.end.aiPlayers === expectedAi
      && metrics.end.alive >= 1
      && (webglReady || metrics.end.webglReady)
      && (!movement || (movement.speed > 70 && movement.distance > 20));
    const healthy = hardOk && metrics.avgFps >= 45 && metrics.simFps >= 55 && metrics.longFrames100 <= 2;
    return { name: `deathmatch-${players}p-${theme}`, kind: 'deathmatch', requestedPlayers: players, expectedAi, pageErrors, consoleErrors, networkErrors, screenshot: screenshotPath, metrics, movement, webglReady, hardOk, healthy };
  } finally {
    await page.context().close();
  }
}

function printResult(r: SmokeResult): void {
  const tag = r.healthy ? 'HEALTHY' : r.hardOk ? 'SLOW' : 'FAIL';
  const move = r.movement
    ? ` move=${r.movement.speed.toFixed(1)}px/s/${r.movement.distance.toFixed(1)}px`
    : '';
  process.stdout.write(
    `[${tag}] ${r.name}  render=${r.metrics.avgFps.toFixed(1)}fps sim=${r.metrics.simFps.toFixed(1)}fps `
    + `players=${r.metrics.end.players} ai=${r.metrics.end.aiPlayers}${move} `
    + `long>50=${r.metrics.longFrames50} max=${r.metrics.maxFrameMs.toFixed(1)}ms `
    + `mesh=${r.metrics.end.shipTier}/${r.metrics.end.asteroidTier}/${r.metrics.end.webglReady ? 'ready' : 'cold'}\n`,
  );
  process.stdout.write(`       screenshot ${r.screenshot}\n`);
  for (const e of r.pageErrors) process.stdout.write(`       pageerror ${e}\n`);
  for (const e of r.networkErrors.slice(0, 4)) process.stdout.write(`       network ${e}\n`);
  if (r.networkErrors.length > 4) process.stdout.write(`       network ... ${r.networkErrors.length - 4} more\n`);
  for (const e of r.consoleErrors.slice(0, 4)) process.stdout.write(`       console ${e}\n`);
  if (r.consoleErrors.length > 4) process.stdout.write(`       console ... ${r.consoleErrors.length - 4} more\n`);
}

async function main(): Promise<void> {
  const durationMs = parseDurationMs();
  await mkdir(OUT_DIR, { recursive: true });
  process.stdout.write(`production playability smoke target=${TARGET} duration=${durationMs}ms\n`);
  const browser = await chromium.launch({
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  try {
    const results: SmokeResult[] = [];
    results.push(await runCampaign(browser, durationMs));
    printResult(results.at(-1)!);
    results.push(await runDeathmatch(browser, 2, durationMs, 'none'));
    printResult(results.at(-1)!);
    results.push(await runDeathmatch(browser, 4, durationMs, 'crt'));
    printResult(results.at(-1)!);
    results.push(await runDeathmatch(browser, 64, durationMs, 'crt'));
    printResult(results.at(-1)!);

    process.stdout.write('\n=== production playability summary ===\n');
    for (const r of results) printResult(r);
    const hardFails = results.filter((r) => !r.hardOk);
    const slow = results.filter((r) => r.hardOk && !r.healthy);
    process.stdout.write(`hard failures: ${hardFails.length}\n`);
    process.stdout.write(`slow/warn cases: ${slow.length}\n`);
    if (hardFails.length > 0) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`production playability smoke failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
