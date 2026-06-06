/** Quick check: a booth stays in MODERN display when it is NOT in the JS
 *  Fullscreen API (headless is never fullscreen) — the post-Esc state.
 *
 *  Three independent paths force modern: a booth URL flag (?p1/?p2/?couch),
 *  and the fullscreen DISPLAY MODE (F11 / chromium --kiosk report
 *  `display-mode: fullscreen` even though document.fullscreenElement is null).
 *  Plain `/` on a desktop viewport stays retro. Spawns its own vite. */
import { chromium } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';

const VITE_PORT = 5181, VITE = `http://localhost:${VITE_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitHttp = async (u: string, ms: number) => { const e = Date.now() + ms; while (Date.now() < e) { try { const r = await fetch(u); if (r.status > 0) return true; } catch { /* retry */ } await sleep(250); } return false; };
let failures = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  · ' + x : ''}`); };

// Emulate `display-mode: fullscreen` (chromium --kiosk / F11) without touching
// the JS Fullscreen API — wraps matchMedia, delegating every other query so the
// app's other media checks (reduced-motion, coarse-pointer) still work.
const FULLSCREEN_MEDIA = `
  const orig = window.matchMedia.bind(window);
  window.matchMedia = (q) => q.includes('display-mode: fullscreen')
    ? { matches: true, media: q, onchange: null, addEventListener(){}, removeEventListener(){}, addListener(){}, removeListener(){}, dispatchEvent(){ return false; } }
    : orig(q);
`;

const procs: ChildProcess[] = [];
procs.push(spawn('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'] }));

try {
  ok('vite up', await waitHttp(`${VITE}/`, 20000));
  const browser = await chromium.launch();
  const read = async (path: string, initScript?: string): Promise<string | undefined> => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    if (initScript) await ctx.addInitScript(initScript);
    const page = await ctx.newPage();
    await page.goto(`${VITE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!document.body.dataset.display, { timeout: 15000 }).catch(() => undefined);
    const mode = await page.evaluate(() => document.body.dataset.display);
    await ctx.close();
    return mode;
  };
  const p1 = await read('/?p1');
  const couch = await read('/?couch=1');
  const plain = await read('/');
  const kiosk = await read('/', FULLSCREEN_MEDIA);          // param-less, but display-mode: fullscreen
  ok('booth ?p1 → modern', p1 === 'modern', `got ${p1}`);
  ok('booth ?couch → modern', couch === 'modern', `got ${couch}`);
  ok('plain / → retro on desktop (default unchanged)', plain === 'retro', `got ${plain}`);
  ok('param-less kiosk (display-mode: fullscreen) → modern, survives Esc', kiosk === 'modern', `got ${kiosk}`);
  await browser.close();
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
}
process.exit(failures > 0 ? 1 : 0);
