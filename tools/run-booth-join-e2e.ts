/**
 * Headless end-to-end test of the Prague booth "press Ⓐ to join" wizard
 * (`?p1` / `?p2`).
 *
 * Drives the DOM-fallback path (cards/buttons are clickable as well as
 * pad-driven, so no real gamepad is needed):
 *
 *  - `/?p1` boots straight into the join screen (two P1/P2 slot cards, no
 *    auto-guest, no PLAY/2P buttons)
 *  - SOLO: click P1 → START → guest sign-in → pick a scheme → a 1-player
 *    campaign run starts
 *  - COUCH: click P1 + P2 → START · 2 PLAYERS → each pilot signs in (guest)
 *    and picks their OWN scheme in turn → a 2-player couch run starts with the
 *    two per-slot schemes recorded distinctly
 *
 * Runs vite only (solo/couch need no broker/peer). Same single-process pattern
 * as run-lobby-e2e.ts. Run with `pnpm run test:booth:join`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const VITE_PORT = 5182;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const RENDER_TIMEOUT_MS = 15_000;

async function startVite(): Promise<ChildProcess> {
  const vite = spawn('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort', '--force'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

async function waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch (e) { lastErr = e; }
    await wait(150);
  }
  throw new Error(`${label} not ready at ${url} in ${timeoutMs}ms: ${String(lastErr)}`);
}

interface CheckRow { name: string; ok: boolean; detail: string }
function reportCheck(rows: CheckRow[], name: string, ok: boolean, detail: string): void {
  rows.push({ name, ok, detail });
}

/** A fresh context (own localStorage, so each test signs in from scratch), with
 *  the first-run onboarding pre-dismissed — otherwise gateBehindOnboarding shows
 *  the onboarding overlay before the run starts (same flag the lobby e2e sets). */
async function freshContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { localStorage.setItem('pallasite:onboarded', '1'); } catch { /* ignore */ } });
  return ctx;
}

/** Click the first <button> whose text matches — robust across the wizard's
 *  re-renders (refs/locators go stale, text doesn't). */
async function clickByText(page: Page, txt: string, exact = false): Promise<boolean> {
  return page.evaluate(({ txt, exact }) => {
    const b = Array.from(document.querySelectorAll('button')).find((el) =>
      exact ? el.textContent?.trim() === txt : (el.textContent ?? '').includes(txt));
    if (b) { (b as HTMLButtonElement).click(); return true; }
    return false;
  }, { txt, exact });
}

async function waitForButton(page: Page, txt: string): Promise<void> {
  await page.waitForFunction(
    (t) => Array.from(document.querySelectorAll('button')).some((b) => (b.textContent ?? '').includes(t)),
    txt, { timeout: RENDER_TIMEOUT_MS },
  );
}

async function waitForHeading(page: Page, txt: string): Promise<void> {
  await page.waitForFunction((t) => document.querySelector('h2')?.textContent === t, txt, { timeout: RENDER_TIMEOUT_MS });
}

/** On a "PLAYER n — SIGN IN" screen: opt out of the relay follow, then submit
 *  the arcade name picker (empty → "Anonymous") to create a local guest. */
async function createGuest(page: Page): Promise<void> {
  await page.evaluate(() => {
    const follow = document.querySelector('input[data-follow-pallasite]') as HTMLInputElement | null;
    if (follow?.checked) follow.click();
    const done = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'DONE');
    (done as HTMLButtonElement | undefined)?.click();
  });
}

/** Run one joined pilot through sign-in (guest) + scheme pick. */
async function setupPilot(page: Page, n: number, scheme: string): Promise<void> {
  await waitForHeading(page, `PLAYER ${n} — SIGN IN`);
  await createGuest(page);
  await waitForHeading(page, `PLAYER ${n} — CONTROLS`);
  await clickByText(page, scheme);
}

async function readRun(page: Page): Promise<{ phase: string | null; players: number; slot0: string | null; slot1: string | null }> {
  return page.evaluate(() => {
    const w = window as unknown as { __pallasiteState?: { phase?: string; players?: unknown[] }; __pallasiteBoothPads?: () => { slot0?: string; slot1?: string } };
    const s = w.__pallasiteState;
    const booth = w.__pallasiteBoothPads?.() ?? {};
    return { phase: s?.phase ?? null, players: s?.players?.length ?? 0, slot0: booth.slot0 ?? null, slot1: booth.slot1 ?? null };
  });
}

async function waitForRun(page: Page, players: number): Promise<void> {
  await page.waitForFunction((n) => {
    const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: unknown[] } }).__pallasiteState;
    return !!s && (s.phase === 'playing' || s.phase === 'wavestart') && s.players?.length === n;
  }, players, { timeout: RENDER_TIMEOUT_MS });
}

async function main(): Promise<void> {
  process.stdout.write('Starting Vite...\n');
  const vite = await startVite();
  const kill = (): void => { killGroup(vite); };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  let exitCode = 0;
  const checks: CheckRow[] = [];
  try {
    await waitForHttp(VITE_BASE + '/', VITE_READY_TIMEOUT_MS, 'vite');
    process.stdout.write('Vite ready.\n');

    const browser: Browser = await chromium.launch();
    try {
      // ── Join screen renders (no auto-guest, no PLAY/2P buttons) ──────────
      const ctx0: BrowserContext = await freshContext(browser);
      const intro = await ctx0.newPage();
      intro.on('pageerror', (e: Error) => process.stderr.write(`[page] ${e.message}\n`));
      await intro.goto(`${VITE_BASE}/?p1`, { waitUntil: 'load' });
      await waitForButton(intro, 'PLAYER 1');
      const joinScreen = await intro.evaluate(() => {
        const text = document.body.innerText;
        const buttons = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());
        const s = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
        return {
          booth: text.includes('BTC PRAGUE') && text.includes('BOOTH 1'),
          p1: buttons.some((t) => t.includes('PLAYER 1') && t.includes('PRESS')),
          p2: buttons.some((t) => t.includes('PLAYER 2') && t.includes('PRESS')),
          link: buttons.some((t) => t.includes('LINK BOOTHS')),
          noPlayBtn: !buttons.some((t) => t === '▶ PLAY'),
          noAutoGuest: !s?.session,
        };
      });
      reportCheck(checks, 'join screen renders P1/P2 cards', joinScreen.booth && joinScreen.p1 && joinScreen.p2, JSON.stringify(joinScreen));
      reportCheck(checks, 'LINK BOOTHS kept as separate option', joinScreen.link, JSON.stringify(joinScreen));
      reportCheck(checks, 'no auto-guest / no PLAY button', joinScreen.noAutoGuest && joinScreen.noPlayBtn, JSON.stringify(joinScreen));
      await ctx0.close();

      // ── SOLO: P1 → START → guest → scheme → 1-player run ────────────────
      const ctx1 = await freshContext(browser);
      const solo = await ctx1.newPage();
      solo.on('pageerror', (e: Error) => process.stderr.write(`[solo] ${e.message}\n`));
      await solo.goto(`${VITE_BASE}/?p1`, { waitUntil: 'load' });
      await waitForButton(solo, 'PLAYER 1');
      await clickByText(solo, 'PLAYER 1');           // join P1
      await waitForButton(solo, 'START');
      await clickByText(solo, 'START');              // begin setup
      await setupPilot(solo, 1, 'AIM + THROTTLE');
      await waitForRun(solo, 1);
      const soloRun = await readRun(solo);
      reportCheck(checks, 'solo: 1-player run starts', soloRun.players === 1 && (soloRun.phase === 'playing' || soloRun.phase === 'wavestart'), JSON.stringify(soloRun));
      reportCheck(checks, 'solo: P1 scheme applied to slot 0', soloRun.slot0 === 'throttle', JSON.stringify(soloRun));
      await ctx1.close();

      // ── COUCH: P1 + P2 → START → two guests + two schemes → 2-player run ─
      const ctx2 = await freshContext(browser);
      const couch = await ctx2.newPage();
      couch.on('pageerror', (e: Error) => process.stderr.write(`[couch] ${e.message}\n`));
      await couch.goto(`${VITE_BASE}/?p1`, { waitUntil: 'load' });
      await waitForButton(couch, 'PLAYER 1');
      await clickByText(couch, 'PLAYER 1');          // join P1
      await clickByText(couch, 'PLAYER 2');          // join P2
      await waitForButton(couch, 'START');
      const startLabel = await couch.evaluate(() => Array.from(document.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes('START'))?.textContent?.replace(/\s+/g, ' ').trim() ?? '');
      reportCheck(checks, 'couch: START shows 2 PLAYERS', startLabel.includes('2 PLAYERS'), `label="${startLabel}"`);
      await clickByText(couch, 'START');
      await setupPilot(couch, 1, 'POINT & FLY');     // P1 → flydirect
      await setupPilot(couch, 2, 'CLASSIC');         // P2 → classic
      await waitForRun(couch, 2);
      const couchRun = await readRun(couch);
      reportCheck(checks, 'couch: 2-player run starts', couchRun.players === 2 && (couchRun.phase === 'playing' || couchRun.phase === 'wavestart'), JSON.stringify(couchRun));
      reportCheck(checks, 'couch: per-pilot schemes distinct (slot0≠slot1)', couchRun.slot0 === 'flydirect' && couchRun.slot1 === 'classic', JSON.stringify(couchRun));
      await ctx2.close();
    } finally {
      await browser.close();
    }
  } catch (e) {
    process.stderr.write(`booth-join-e2e error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    kill();
  }

  process.stdout.write('\n=== booth join checks ===\n');
  for (const c of checks) {
    const tag = c.ok ? '[PASS]' : '[FAIL]';
    process.stdout.write(`${tag} ${c.name.padEnd(44)} ${c.detail}\n`);
    if (!c.ok) exitCode = 1;
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
