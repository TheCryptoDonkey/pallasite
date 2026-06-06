/** Quick check: booth kiosk (?p1/?p2) resolves to MODERN display even when NOT
 *  fullscreen (headless is never fullscreen), so an Esc fullscreen-exit at the
 *  booth no longer drops to the retro letterbox. Plain `/` stays retro on a
 *  desktop viewport. Spawns its own vite. */
import { chromium } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';

const VITE_PORT = 5181, VITE = `http://localhost:${VITE_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitHttp = async (u: string, ms: number) => { const e = Date.now() + ms; while (Date.now() < e) { try { const r = await fetch(u); if (r.status > 0) return true; } catch { /* retry */ } await sleep(250); } return false; };
let failures = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  · ' + x : ''}`); };

const procs: ChildProcess[] = [];
procs.push(spawn('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'] }));

try {
  ok('vite up', await waitHttp(`${VITE}/`, 20000));
  const browser = await chromium.launch();
  const read = async (path: string): Promise<string | undefined> => {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${VITE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.body.dataset.display, { timeout: 15000 }).catch(() => undefined);
    const mode = await page.evaluate(() => document.body.dataset.display);
    await page.context().close();
    return mode;
  };
  const p1 = await read('/?p1');
  const p2 = await read('/?p2');
  const plain = await read('/');
  ok('booth ?p1 → modern (survives fullscreen exit)', p1 === 'modern', `got ${p1}`);
  ok('booth ?p2 → modern', p2 === 'modern', `got ${p2}`);
  ok('plain / → retro on desktop (default unchanged)', plain === 'retro', `got ${plain}`);
  await browser.close();
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
}
process.exit(failures > 0 ? 1 : 0);
