/**
 * Booth cross-booth link e2e — the input paths a hook-driven soak can't reach.
 *
 * Part 1: the booth lobby's LINK BOOTHS button builds the correct 4-player
 *         hybrid launch URL (Booth 1 owns slots 0,1 · Booth 2 owns 2,3).
 * Part 2: REAL keyboard (Booth 1) + a gamepad (Booth 2), driven through the
 *         actual keydown handler and gamepad poll, route into the lockstep
 *         mirrors, propagate, and stay deterministic — regression cover for the
 *         wave-start skip-gate (real keys during wavestart must NOT skip in peer
 *         mode) and the 2nd-pilot / gamepad-in-peer routing.
 *
 * Spawns its own vite + controller-ws broker. Run: pnpm test:booth:link
 */
import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';

const VITE_PORT = 5180, BROKER_PORT = 8788, VITE = `http://localhost:${VITE_PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const safe = async <T>(fn: () => Promise<T>, dflt: T): Promise<T> => { try { return await fn(); } catch { return dflt; } };
const waitHttp = async (u: string, ms: number) => { const e = Date.now() + ms; while (Date.now() < e) { try { const r = await fetch(u); if (r.status > 0) return true; } catch { /* retry */ } await sleep(250); } return false; };

let failures = 0;
const ok = (l: string, c: boolean, x = '') => { if (!c) failures++; console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  · ' + x : ''}`); };

const procs: ChildProcess[] = [];
procs.push(spawn('node', ['controller-ws/server.js'], { env: { ...process.env, PORT: String(BROKER_PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'ignore', 'ignore'] }));
procs.push(spawn('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'] }));

const link = 'praguelinke2e';
const peer = `ws://localhost:${BROKER_PORT}/?s=${link}&r=peer`;
const hybridUrl = (slot: number, owned: string) => `${VITE}/?peer=${encodeURIComponent(peer)}&session=${link}&slot=${slot}&localSlots=${owned}&players=4&mode=coop-campaign&desync-hunt=1`;

try {
  ok('broker up', await waitHttp(`http://localhost:${BROKER_PORT}/`, 12000));
  ok('vite up', await waitHttp(`${VITE}/`, 20000));
  const browser = await chromium.launch();

  // ── Part 1: LINK BOOTHS → hybrid launch URL ────────────────────────────
  for (const booth of [1, 2] as const) {
    const page = await (await browser.newContext({ viewport: { width: 900, height: 560 } })).newPage();
    await page.goto(`${VITE}/?p${booth}&link=${link}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => /WHO ARE YOU|BOOTH/i.test(document.body.innerText), { timeout: 15000 }).catch(() => undefined);
    // Complete guest if the login screen is up (arcade picker submits on its DONE button's pointerdown).
    if (/WHO ARE YOU/i.test(await page.evaluate(() => document.body.innerText))) {
      await page.locator('button', { hasText: /^DONE$/ }).first().dispatchEvent('pointerdown').catch(() => undefined);
      await page.waitForFunction(() => /BOOTH/i.test(document.body.innerText), { timeout: 8000 }).catch(() => undefined);
    }
    // Click LINK BOOTHS (renderEventLobbyAction binds 'click') and read where it
    // navigates — proof the lobby button launches the right hybrid URL.
    await page.locator('button', { hasText: /LINK BOOTHS/i }).first().click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForFunction(() => location.search.includes('localSlots'), { timeout: 8000 }).catch(() => undefined);
    const assigned = page.url();
    const u = assigned.includes('localSlots') ? new URL(assigned) : null;
    const base = (booth - 1) * 2;
    ok(`Booth ${booth}: LINK BOOTHS → 4-player coop hybrid URL`,
      !!u && u.searchParams.get('players') === '4' && u.searchParams.get('mode') === 'coop-campaign' && u.searchParams.get('localSlots') === `${base},${base + 1}` && u.searchParams.get('slot') === String(base),
      assigned ? assigned.replace(/^[^?]*/, '') : '(no navigation captured)');
    await page.context().close();
  }

  // ── Part 2: real keyboard + gamepad input, deterministic ───────────────
  const p1 = await (await browser.newContext({ viewport: { width: 900, height: 560 } })).newPage();
  const p2 = await (await browser.newContext({ viewport: { width: 900, height: 560 } })).newPage();
  await Promise.all([p1.goto(hybridUrl(0, '0,1'), { waitUntil: 'domcontentloaded' }), p2.goto(hybridUrl(2, '2,3'), { waitUntil: 'domcontentloaded' })]);

  const reach = async (pg: Page) => { try { await pg.waitForFunction(() => { const s = (window as any).__pallasiteState; const pd = (window as any).__pallasitePeerDebug?.(); return s && s.players?.length === 4 && ['playing', 'wavestart', 'warp'].includes(s.phase) && pd?.active && pd.remoteLatest >= 0; }, { timeout: 25000 }); return true; } catch { return false; } };
  ok('both booths reach 4-player coop', (await Promise.all([reach(p1), reach(p2)])).every(Boolean));

  // Inject a mock standard gamepad on Booth 2 (drives slot 2).
  await p2.evaluate(`
    window.__mockPads = [{ index:0, id:'mock', connected:true, mapping:'standard', timestamp:1,
      axes:[0,0,0,0], buttons: Array.from({length:17}, function(){ return { pressed:false, touched:false, value:0 }; }) }];
    Object.defineProperty(navigator, 'getGamepads', { configurable:true, value: function(){ return window.__mockPads; } });
  `);

  // Drive DURING wavestart with REAL events — fire + slow turn, NO thrust, so
  // ships survive AND the skip-gate is exercised (these keys must not skip).
  await p1.keyboard.down('Space');     // P1 (slot 0) fire
  await p1.keyboard.down('ArrowLeft'); // P1 turn
  await p1.keyboard.down('Shift');     // P2 (slot 1) fire (ShiftLeft → Space)
  await p1.keyboard.down('a');         // P2 turn (KeyA → ArrowLeft)
  await p2.evaluate(`var p=window.__mockPads[0]; p.buttons[0].pressed=true; p.buttons[0].value=1;`); // pad fire (slot 2)

  const before = await safe(() => p1.evaluate(() => ({ s0: (window as any).__pallasiteState.players[0].ship.rot, s1: (window as any).__pallasiteState.players[1].ship.rot })), null);

  let desync = 0, compared = 0;
  const phasesP1 = new Set<string>(), phasesP2 = new Set<string>();
  for (let i = 0; i < 18; i++) {
    await sleep(500);
    const [h1, h2, s1, s2] = await Promise.all([
      safe(() => p1.evaluate(() => Array.from(((window as any).__pallasiteCanaryHistory as Map<number, string>) ?? new Map())), [] as [number, string][]),
      safe(() => p2.evaluate(() => Array.from(((window as any).__pallasiteCanaryHistory as Map<number, string>) ?? new Map())), [] as [number, string][]),
      safe(() => p1.evaluate(() => ({ ph: (window as any).__pallasiteState.phase, n: (window as any).__pallasiteState.players.length })), null),
      safe(() => p2.evaluate(() => ({ ph: (window as any).__pallasiteState.phase, n: (window as any).__pallasiteState.players.length })), null),
    ]);
    if (!s1 || !s2) break;
    phasesP1.add(s1.ph); phasesP2.add(s2.ph);
    const m2 = new Map(h2 as [number, string][]);
    for (const [f, s] of h1 as [number, string][]) if (m2.has(f)) { compared++; if (m2.get(f) !== s) desync++; }
  }
  const after = await safe(() => p1.evaluate(() => ({ s0: (window as any).__pallasiteState.players[0].ship.rot, s1: (window as any).__pallasiteState.players[1].ship.rot })), null);

  ok('real keyboard turned slot-0 AND slot-1 (P1+P2 keys routed)', !!(before && after) && (Math.abs(after.s0 - before.s0) > 0.05 && Math.abs(after.s1 - before.s1) > 0.05));
  ok('phases stayed in sync (skip-gate held — no local wavestart skip)', [...phasesP1].sort().join() === [...phasesP2].sort().join(), `B1=${[...phasesP1]} B2=${[...phasesP2]}`);
  ok('NO desync with real keyboard + gamepad input', desync === 0, `${desync}/${compared} frames`);

  await browser.close();
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
}

process.exit(failures > 0 ? 1 : 0);
