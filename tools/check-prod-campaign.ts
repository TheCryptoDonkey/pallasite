/**
 * Production solo-campaign regression smoke.
 *
 * Starts the deployed app through the real PLAY -> CAMPAIGN -> IGNITE UI,
 * with service workers blocked, and proves the solo campaign is isolated
 * from deathmatch state, has decoded critical art before play, keeps the
 * desktop/mobile HUD visible, preserves movement feel, and can restart from
 * both game-over and completion flows.
 *
 * Run:
 *   pnpm exec tsx tools/check-prod-campaign.ts
 *   TARGET=https://staging.example pnpm exec tsx tools/check-prod-campaign.ts
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from 'playwright';

const TARGET = (process.env.TARGET ?? 'https://pallasite.app').replace(/\/$/, '');
const OUT_DIR = resolve(process.cwd(), 'tools/record-out');
const REACH_PLAYING_TIMEOUT_MS = 30_000;
const ASSET_READY_TIMEOUT_MS = 40_000;
const HUD_MIN_PIXELS = 16;

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: 390, height: 844 },
} as const;

interface Diagnostics {
  pageErrors: string[];
  consoleErrors: string[];
  networkErrors: string[];
}

interface HudProbe {
  width: number;
  height: number;
  left: number;
  center: number;
  right: number;
}

interface MovementProbe {
  speed: number;
  distance: number;
  frames: number;
}

interface CampaignStateProbe {
  phase: string | null;
  players: number;
  aiPlayers: number;
  storedMode: string | null;
  urlMode: string | null;
  deathmatchPlayers: string | null;
  deathmatchRules: boolean;
  wave: number;
}

interface AssetProbe {
  campaignCriticalReady?: boolean;
  campaignCriticalLoaded?: string[];
  campaignCriticalFailed?: string[];
  webglReady?: boolean;
}

function isTransientRelayConsole(text: string): boolean {
  return text.startsWith("WebSocket connection to 'wss://")
    && (
      text.includes('nos.lol')
      || text.includes('nostr.wine')
      || text.includes('relay.damus.io')
      || text.includes('relay.nostr.band')
    );
}

function visualStyle(): string {
  return JSON.stringify({
    asteroid: 'mesh',
    ship: 'mesh',
    bullet: 'mesh',
    particle: 'mesh',
    theme: 'none',
    asciiCols: 96,
    bitDepth: 4,
    bitColour: false,
  });
}

function guestSession(): unknown {
  return {
    pubkey: '0'.repeat(64),
    displayName: 'CAMPAIGN QA',
    method: 'guest',
    signer: { capabilities: { canSignEvents: false } },
  };
}

async function newCampaignPage(browser: Browser, label: keyof typeof VIEWPORTS, poisonedDeathmatch = false): Promise<{ context: BrowserContext; page: Page; diagnostics: Diagnostics }> {
  const diagnostics: Diagnostics = { pageErrors: [], consoleErrors: [], networkErrors: [] };
  const context = await browser.newContext({
    viewport: VIEWPORTS[label],
    deviceScaleFactor: 1,
    isMobile: label === 'mobile',
    hasTouch: label === 'mobile',
    serviceWorkers: 'block',
  });
  await context.addInitScript(({ mode, style }) => {
    localStorage.setItem('pallasite:onboarded', '1');
    localStorage.setItem('pallasite:daily', '0');
    localStorage.setItem('pallasite:displayMode', 'modern');
    localStorage.setItem('pallasite:mode', mode);
    localStorage.setItem('pallasite:visualStyle', style);
  }, { mode: poisonedDeathmatch ? 'deathmatch' : 'campaign', style: visualStyle() });
  const page = await context.newPage();
  page.on('pageerror', (e: Error) => diagnostics.pageErrors.push(e.message));
  page.on('console', (msg: ConsoleMessage) => {
    const text = msg.text();
    if (isTransientRelayConsole(text)) return;
    if (msg.type() === 'error' && !text.startsWith('Failed to load resource:')) diagnostics.consoleErrors.push(text);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) diagnostics.networkErrors.push(`${res.status()} ${res.url()}`);
  });
  page.on('requestfailed', (req) => {
    const reason = req.failure()?.errorText ?? '';
    if (reason === 'net::ERR_ABORTED') return;
    diagnostics.networkErrors.push(`failed ${req.url()} ${reason}`.trim());
  });
  return { context, page, diagnostics };
}

async function clickButton(page: Page, label: string, exact = false): Promise<void> {
  await page.evaluate(({ text, exactMatch }) => {
    const btn = Array.from(document.querySelectorAll('button'))
      .find((b) => {
        const content = (b.textContent ?? '').trim();
        return exactMatch ? content === text : content.includes(text);
      });
    if (!btn) throw new Error(`button not found: ${text}`);
    (btn as HTMLButtonElement).click();
  }, { text: label, exactMatch: exact });
}

async function waitForCampaignAssets(page: Page): Promise<AssetProbe> {
  await page.waitForFunction(
    () => {
      const probe = (window as unknown as { __pallasiteAssetsProbe?: () => AssetProbe }).__pallasiteAssetsProbe?.();
      return probe?.campaignCriticalReady === true;
    },
    undefined,
    { timeout: ASSET_READY_TIMEOUT_MS },
  );
  return await page.evaluate(() => {
    return (window as unknown as { __pallasiteAssetsProbe?: () => AssetProbe }).__pallasiteAssetsProbe?.() ?? {};
  });
}

async function startCampaign(page: Page, poisonedDeathmatch: boolean): Promise<{ assets: AssetProbe; state: CampaignStateProbe }> {
  const params = poisonedDeathmatch
    ? '?mode=deathmatch&deathmatchPlayers=4&aiFill=1&deathmatchTime=300'
    : '?campaignSmoke=1';
  await page.goto(`${TARGET}/${params}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((session) => {
    const state = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
    if (!state) throw new Error('missing pallasite state');
    state.session = session;
  }, guestSession());
  const assets = await waitForCampaignAssets(page);
  await clickButton(page, 'PLAY');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').trim() === 'CAMPAIGN'),
    undefined,
    { timeout: 10_000 },
  );
  await clickButton(page, 'CAMPAIGN', true);
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes('IGNITE')),
    undefined,
    { timeout: 10_000 },
  );
  await clickButton(page, 'IGNITE');
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
  const state = await campaignState(page);
  return { assets, state };
}

async function campaignState(page: Page): Promise<CampaignStateProbe> {
  return await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: {
      phase?: string;
      wave?: number;
      players?: Array<{ ai?: boolean }>;
      deathmatchRules?: unknown;
    } }).__pallasiteState;
    const params = new URLSearchParams(window.location.search);
    return {
      phase: s?.phase ?? null,
      players: s?.players?.length ?? 0,
      aiPlayers: s?.players?.filter((p) => p.ai === true).length ?? 0,
      storedMode: localStorage.getItem('pallasite:mode'),
      urlMode: params.get('mode'),
      deathmatchPlayers: params.get('deathmatchPlayers'),
      deathmatchRules: !!s?.deathmatchRules,
      wave: s?.wave ?? 0,
    };
  });
}

async function sampleHud(page: Page): Promise<HudProbe> {
  return await page.evaluate(() => {
    const canvas = document.getElementById('game') as HTMLCanvasElement | null;
    if (!canvas) throw new Error('missing game canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('missing 2d context');
    const w = canvas.width;
    const h = canvas.height;
    const bandH = Math.min(110, Math.max(70, Math.floor(h * 0.16)));
    const railW = Math.min(260, Math.max(120, Math.floor(w * 0.28)));
    const regions = [
      [0, 0, railW, bandH],
      [Math.floor(w / 2 - railW / 2), 0, railW, bandH],
      [w - railW, 0, railW, bandH],
    ];
    const counts = [0, 0, 0];
    for (let r = 0; r < regions.length; r++) {
      const [x0, y0, rw, rh] = regions[r];
      const data = ctx.getImageData(Math.max(0, x0), Math.max(0, y0), Math.max(1, rw), Math.max(1, rh)).data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] > 120 && data[i] + data[i + 1] + data[i + 2] > 170) counts[r]++;
      }
    }
    return {
      width: w,
      height: h,
      left: counts[0],
      center: counts[1],
      right: counts[2],
    };
  });
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
    } }).__pallasiteState;
    if (!s?.players?.[0]) throw new Error('missing player');
    s.phase = 'playing';
    if (Array.isArray(s.asteroids)) {
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
  return await page.evaluate(({ start, count }) => {
    const s = (window as unknown as { __pallasiteState?: { frame?: number; players?: Array<{ ship: { pos: { x: number; y: number }; vel: { x: number; y: number } } }> } }).__pallasiteState;
    const p = s?.players?.[0];
    if (!p) throw new Error('missing player after movement probe');
    return {
      speed: Math.hypot(p.ship.vel.x, p.ship.vel.y),
      distance: Math.hypot(p.ship.pos.x - 640, p.ship.pos.y - 360),
      frames: Number(s?.frame ?? start) - start || count,
    };
  }, { start: startFrame, count: frames });
}

async function forcePhaseAndRestart(page: Page, phase: 'gameover' | 'completed'): Promise<CampaignStateProbe> {
  await page.evaluate((nextPhase) => {
    const s = (window as unknown as { __pallasiteState?: {
      phase?: string;
      wave?: number;
      bossDefeated?: boolean;
      players?: Array<{ score: number; sats: number; lives: number; ship: { alive: boolean } }>;
    } }).__pallasiteState;
    if (!s?.players?.[0]) throw new Error('missing player');
    s.wave = nextPhase === 'completed' ? 25 : Math.max(1, s.wave ?? 1);
    s.bossDefeated = nextPhase === 'completed';
    s.players[0].score = Math.max(1200, s.players[0].score);
    s.players[0].sats = 0;
    s.players[0].lives = nextPhase === 'gameover' ? 0 : Math.max(1, s.players[0].lives);
    s.players[0].ship.alive = nextPhase !== 'gameover';
    s.phase = nextPhase;
  }, phase);
  const label = phase === 'completed' ? 'PALLASITE COMPLETE' : 'GAME OVER';
  await page.waitForFunction(
    (text) => document.body.innerText.includes(text),
    label,
    { timeout: 10_000 },
  );
  await clickButton(page, phase === 'completed' ? 'IGNITE AGAIN' : 'SPAWN AGAIN');
  await page.waitForFunction(
    () => {
      const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: unknown[]; deathmatchRules?: unknown } }).__pallasiteState;
      return !!s && (s.phase === 'wavestart' || s.phase === 'playing') && s.players?.length === 1 && !s.deathmatchRules;
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
  return await campaignState(page);
}

function assertCampaignState(label: string, s: CampaignStateProbe, expectUrlCleared: boolean): void {
  if (s.phase !== 'playing') throw new Error(`${label}: expected playing, got ${JSON.stringify(s)}`);
  if (s.players !== 1 || s.aiPlayers !== 0) throw new Error(`${label}: expected one human player, got ${JSON.stringify(s)}`);
  if (s.deathmatchRules) throw new Error(`${label}: deathmatch rules leaked into campaign ${JSON.stringify(s)}`);
  if (s.storedMode !== 'campaign') throw new Error(`${label}: stored mode not campaign ${JSON.stringify(s)}`);
  if (expectUrlCleared && (s.urlMode !== null || s.deathmatchPlayers !== null)) {
    throw new Error(`${label}: deathmatch URL params were not cleared ${JSON.stringify(s)}`);
  }
}

function assertHud(label: string, hud: HudProbe): void {
  if (hud.left < HUD_MIN_PIXELS || hud.center < HUD_MIN_PIXELS || hud.right < HUD_MIN_PIXELS) {
    throw new Error(`${label}: HUD regions too sparse ${JSON.stringify(hud)}`);
  }
}

function assertMovement(label: string, movement: MovementProbe): void {
  if (movement.speed < 80 || movement.speed > 280 || movement.distance < 18 || movement.distance > 120) {
    throw new Error(`${label}: movement outside campaign baseline ${JSON.stringify(movement)}`);
  }
}

function assertDiagnostics(label: string, diagnostics: Diagnostics): void {
  if (diagnostics.pageErrors.length > 0) throw new Error(`${label}: page errors ${diagnostics.pageErrors.join(' | ')}`);
  if (diagnostics.consoleErrors.length > 0) throw new Error(`${label}: console errors ${diagnostics.consoleErrors.join(' | ')}`);
}

async function captureScreenshot(page: Page, path: string): Promise<string> {
  try {
    await page.screenshot({ path, fullPage: false, timeout: 5_000 });
    return path;
  } catch (err) {
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    return `${path} (skipped: ${msg})`;
  }
}

async function runDesktop(browser: Browser): Promise<void> {
  const { context, page, diagnostics } = await newCampaignPage(browser, 'desktop', true);
  try {
    const { assets, state } = await startCampaign(page, true);
    assertCampaignState('desktop polluted-start campaign', state, true);
    if (!assets.campaignCriticalReady || (assets.campaignCriticalFailed?.length ?? 0) > 0) {
      throw new Error(`desktop assets not ready ${JSON.stringify(assets)}`);
    }
    await wait(500);
    const hud = await sampleHud(page);
    assertHud('desktop HUD', hud);
    const movement = await probeMovement(page);
    assertMovement('desktop movement', movement);
    const shot = resolve(OUT_DIR, 'prod-campaign-desktop.png');
    const shotResult = await captureScreenshot(page, shot);
    const afterGameOver = await forcePhaseAndRestart(page, 'gameover');
    assertCampaignState('desktop gameover restart', afterGameOver, false);
    const afterCompletion = await forcePhaseAndRestart(page, 'completed');
    assertCampaignState('desktop completion restart', afterCompletion, false);
    assertDiagnostics('desktop', diagnostics);
    process.stdout.write(`[PASS] desktop campaign assets=${assets.campaignCriticalLoaded?.length ?? 0} hud=${hud.left}/${hud.center}/${hud.right} movement=${movement.speed.toFixed(1)}px/s/${movement.distance.toFixed(1)}px screenshot=${shotResult}\n`);
  } finally {
    await context.close();
  }
}

async function runMobile(browser: Browser): Promise<void> {
  const { context, page, diagnostics } = await newCampaignPage(browser, 'mobile', false);
  try {
    const { assets, state } = await startCampaign(page, false);
    assertCampaignState('mobile campaign', state, false);
    if (!assets.campaignCriticalReady || (assets.campaignCriticalFailed?.length ?? 0) > 0) {
      throw new Error(`mobile assets not ready ${JSON.stringify(assets)}`);
    }
    await wait(500);
    const hud = await sampleHud(page);
    assertHud('mobile HUD', hud);
    const movement = await probeMovement(page);
    assertMovement('mobile movement', movement);
    const shot = resolve(OUT_DIR, 'prod-campaign-mobile.png');
    const shotResult = await captureScreenshot(page, shot);
    assertDiagnostics('mobile', diagnostics);
    process.stdout.write(`[PASS] mobile campaign assets=${assets.campaignCriticalLoaded?.length ?? 0} hud=${hud.left}/${hud.center}/${hud.right} movement=${movement.speed.toFixed(1)}px/s/${movement.distance.toFixed(1)}px screenshot=${shotResult}\n`);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  process.stdout.write(`production campaign smoke target=${TARGET}\n`);
  const browser = await chromium.launch({
    args: [
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });
  try {
    await runDesktop(browser);
    await runMobile(browser);
    process.stdout.write('Production campaign smoke PASS\n');
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`production campaign smoke failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
