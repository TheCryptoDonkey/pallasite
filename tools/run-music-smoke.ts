/**
 * Music boot/recovery smoke.
 *
 * Catches the recurring failure where a browser blocks or suspends the
 * HTMLAudioElement backing music, while the game loop believes the current
 * track is already active and therefore never replays it.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5205;
const VITE_BASE = `http://127.0.0.1:${VITE_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const MUSIC_READY_TIMEOUT_MS = 20_000;

interface MusicProbe {
  audioContext: string;
  phase: string;
  wave: number;
  music: {
    currentId: string | null;
    paused: boolean | null;
    direct: boolean | null;
    volume: number | null;
    muted: boolean | null;
    readyState: number | null;
    networkState: number | null;
    failedFlag: boolean | null;
    loadedCount: number;
    src: string | null;
    playingIds: string[];
    audibleIds: string[];
  };
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

function killGroup(p: ChildProcess): void {
  if (p.killed || p.pid === undefined) return;
  try { process.kill(-p.pid, 'SIGTERM'); }
  catch { try { p.kill('SIGTERM'); } catch { /* already dead */ } }
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await wait(150);
  }
  throw new Error(`Vite not ready at ${url}: ${String(lastErr)}`);
}

async function probe(page: Page): Promise<MusicProbe> {
  return await page.evaluate(() => {
    const p = (window as unknown as { __pallasiteMusicProbe?: () => MusicProbe }).__pallasiteMusicProbe;
    if (!p) throw new Error('missing __pallasiteMusicProbe');
    return p();
  });
}

async function waitForActiveMusic(page: Page, expectedTrack: string | RegExp, label: string): Promise<MusicProbe> {
  const handle = await page.waitForFunction(
    (expected) => {
      const p = (window as unknown as { __pallasiteMusicProbe?: () => MusicProbe }).__pallasiteMusicProbe?.();
      if (!p) return false;
      const id = p.music.currentId;
      const trackOk = typeof expected === 'string'
        ? id === expected
        : id !== null && new RegExp(expected.source, expected.flags).test(id);
      return trackOk
        && p.audioContext === 'running'
        && p.music.paused === false
        && p.music.muted !== true
        && (p.music.volume ?? 1) > 0.05
        && (p.music.readyState ?? 0) >= 1
        && p.music.failedFlag !== true
        && p.music.audibleIds.length === 1
        && p.music.audibleIds[0] === p.music.currentId;
    },
    typeof expectedTrack === 'string' ? expectedTrack : { source: expectedTrack.source, flags: expectedTrack.flags },
    { timeout: MUSIC_READY_TIMEOUT_MS, polling: 100 },
  ).catch(async (err) => {
    const p = await probe(page).catch((e) => ({ error: String(e) }));
    throw new Error(`${label} music did not become active: ${err instanceof Error ? err.message : String(err)}\n${JSON.stringify(p, null, 2)}`);
  });
  await handle.dispose();
  return probe(page);
}

async function clickButton(page: Page, text: string): Promise<void> {
  await page.locator('button').filter({ hasText: text }).first().click({ timeout: 10_000 });
}

async function openMusicPlayerFromLogo(page: Page): Promise<void> {
  const logo = page.locator('.title-logo').first();
  const box = await logo.boundingBox();
  if (!box) throw new Error('title logo not found for music player long-press');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await wait(850);
  await page.mouse.up();
  await page.getByText('SOUNDTRACK').waitFor({ timeout: 10_000 });
}

function logBrowserErrors(page: Page): void {
  page.on('console', (msg) => {
    if (msg.type() === 'error') process.stderr.write(`[browser:${msg.type()}] ${msg.text()}\n`);
  });
}

async function installMusicSmokeSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
    if (!s) throw new Error('missing pallasite state');
    s.session = {
      pubkey: '0'.repeat(64),
      displayName: 'MUSIC QA',
      method: 'guest',
      signer: { capabilities: { canSignEvents: false } },
    };
  });
}

async function main(): Promise<void> {
  const vite = await startVite();
  let browser: Browser | null = null;
  try {
    await waitForHttp(`${VITE_BASE}/`, VITE_READY_TIMEOUT_MS);
    browser = await chromium.launch({
      headless: true,
      args: ['--autoplay-policy=user-gesture-required'],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: 'block',
    });
    await context.addInitScript(() => {
      localStorage.setItem('pallasite:onboarded', '1');
      localStorage.setItem('pallasite:daily', '0');
      localStorage.setItem('pallasite:displayMode', 'modern');
      localStorage.setItem('pallasite:mode', 'campaign');
      localStorage.setItem('pallasite:audio', JSON.stringify({ master: 0.7, music: 0.55, sfx: 0.85, muted: false }));
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
    logBrowserErrors(page);
    await page.goto(`${VITE_BASE}/?musicSmoke=1&dbg=audio`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof (window as unknown as { __pallasiteMusicProbe?: unknown }).__pallasiteMusicProbe === 'function');
    await page.mouse.click(640, 360);
    const title = await waitForActiveMusic(page, 'pallasite-idle', 'title');
    console.log(`title music ok: ${title.music.currentId} ready=${title.music.readyState} loaded=${title.music.loadedCount}`);

    await openMusicPlayerFromLogo(page);
    await page.getByText('SLOW GRAVITY').click({ timeout: 10_000 });
    const preview = await waitForActiveMusic(page, 'slow-gravity', 'music player preview');
    await wait(6_500);
    const sustained = await waitForActiveMusic(page, 'slow-gravity', 'music player sustained preview');
    console.log(`music player ok: ${sustained.music.currentId} still active after preview hold, loaded=${preview.music.loadedCount}`);
    await clickButton(page, 'BACK');
    const backTitle = await waitForActiveMusic(page, 'pallasite-idle', 'music player back');
    console.log(`music player back ok: ${backTitle.music.currentId}`);

    await page.evaluate(() => {
      const poison = (window as unknown as { __pallasiteMusicPoison?: () => unknown }).__pallasiteMusicPoison;
      if (!poison) throw new Error('missing __pallasiteMusicPoison');
      poison();
    });
    const poisoned = await probe(page);
    if (poisoned.audioContext === 'running' || poisoned.music.paused === false) {
      throw new Error(`poison did not suspend/pause music: ${JSON.stringify(poisoned, null, 2)}`);
    }
    await page.mouse.click(640, 360);
    const recovered = await waitForActiveMusic(page, 'pallasite-idle', 'gesture recovery');
    console.log(`gesture recovery ok: ctx=${recovered.audioContext} paused=${recovered.music.paused} ready=${recovered.music.readyState}`);

    await installMusicSmokeSession(page);
    await clickButton(page, 'PLAY');
    await clickButton(page, 'CAMPAIGN');
    await clickButton(page, 'IGNITE');
    await page.waitForFunction(() => {
      const p = (window as unknown as { __pallasiteMusicProbe?: () => MusicProbe }).__pallasiteMusicProbe?.();
      return p?.phase === 'wavestart' || p?.phase === 'playing';
    }, undefined, { timeout: 20_000 });
    const wave = await waitForActiveMusic(page, 'slow-orbit', 'wave 1');
    console.log(`wave music ok: ${wave.music.currentId} phase=${wave.phase} ready=${wave.music.readyState} audible=${wave.music.audibleIds.join(',')}`);

    await page.close();

    const sanctumPage = await context.newPage();
    logBrowserErrors(sanctumPage);
    await sanctumPage.goto(`${VITE_BASE}/?musicSmoke=1&dbg=audio`, { waitUntil: 'domcontentloaded' });
    await sanctumPage.waitForFunction(() => typeof (window as unknown as { __pallasiteMusicProbe?: unknown }).__pallasiteMusicProbe === 'function');
    await sanctumPage.mouse.click(640, 360);
    const sanctumTitle = await waitForActiveMusic(sanctumPage, 'pallasite-idle', 'sanctum title');
    console.log(`sanctum title music ok: ${sanctumTitle.music.currentId}`);

    await installMusicSmokeSession(sanctumPage);
    await clickButton(sanctumPage, 'PLAY');
    await clickButton(sanctumPage, 'SANCTUM');
    await clickButton(sanctumPage, 'IGNITE');
    await sanctumPage.waitForFunction(() => {
      const p = (window as unknown as { __pallasiteMusicProbe?: () => MusicProbe }).__pallasiteMusicProbe?.();
      return p?.phase === 'wavestart' || p?.phase === 'playing' || p?.phase === 'sanctum';
    }, undefined, { timeout: 20_000 });
    const sanctumWave = await waitForActiveMusic(sanctumPage, 'the-cult', 'sanctum wave 1');
    console.log(`sanctum wave music ok: ${sanctumWave.music.currentId} phase=${sanctumWave.phase} ready=${sanctumWave.music.readyState} audible=${sanctumWave.music.audibleIds.join(',')}`);
    await sanctumPage.close();
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    killGroup(vite);
  }
}

void main();
