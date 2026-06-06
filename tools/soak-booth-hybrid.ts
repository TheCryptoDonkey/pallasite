/** Soak test: linked-booth coop hybrid under injected latency. Drives input on
 *  both booths and compares canary state across them every couple of seconds —
 *  any mismatch at a shared frame is a desync.
 *
 *  Defaults to the 4-ship lockstep hybrid (2 pilots/booth). Flags:
 *    --pilots=1     1 pilot/booth → the 2-player LINK BOOTHS default (slots 0,1)
 *    --rollback=1   run on rollback netcode instead of lockstep
 *  e.g. the new default booth link:  pnpm test:booth:soak --pilots=1 --rollback=1 */
import { chromium } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';

const VITE_PORT = 5180;
const BROKER_PORT = 8788;
const VITE = `http://localhost:${VITE_PORT}`;
const DURATION_MS = 60_000;
const arg = (k: string): string | undefined => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const PILOTS = Math.max(1, Math.min(2, parseInt(arg('pilots') || '2', 10) || 2)); // pilots per booth
const ROLLBACK = arg('rollback') === '1' || process.argv.includes('--rollback');
const PLAYERS = PILOTS * 2;          // total ships across both booths
const B2_SLOT = PILOTS;              // Booth 2's primary slot (1 when 1/booth, 2 when 2/booth)
const ownedFrom = (base: number): string => Array.from({ length: PILOTS }, (_, i) => base + i).join(',');
const NETCODE = ROLLBACK ? 'rollback' : 'lockstep';
const safe = async <T>(fn: () => Promise<T>, dflt: T): Promise<T> => { try { return await fn(); } catch { return dflt; } };
const ok = (l: string, c: boolean, x = '') => console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? '  · ' + x : ''}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitHttp = async (url: string, ms: number) => { const end = Date.now() + ms; while (Date.now() < end) { try { const r = await fetch(url); if (r.status > 0) return true; } catch { /* retry */ } await sleep(250); } return false; };

const procs: ChildProcess[] = [];
// Inject ~40ms forward delay + 20ms jitter on the broker to mimic venue WiFi.
procs.push(spawn('node', ['controller-ws/server.js'], { env: { ...process.env, PORT: String(BROKER_PORT), HOST: '127.0.0.1', PEER_FORWARD_DELAY_MS: '40', PEER_FORWARD_JITTER_MS: '20' }, stdio: ['ignore', 'ignore', 'ignore'] }));
procs.push(spawn('pnpm', ['exec', 'vite', '--port', String(VITE_PORT), '--strictPort'], { stdio: ['ignore', 'ignore', 'ignore'] }));

try {
  ok('broker up (latency 40±20ms)', await waitHttp(`http://localhost:${BROKER_PORT}/`, 12000));
  ok('vite up', await waitHttp(`${VITE}/`, 20000));

  const link = 'praguesoak';
  const peer = `ws://localhost:${BROKER_PORT}/?s=${link}&r=peer`;
  const url = (slot: number, owned: string) =>
    `${VITE}/?peer=${encodeURIComponent(peer)}&session=${link}&slot=${slot}&localSlots=${owned}&players=${PLAYERS}&mode=coop-campaign&desync-hunt=1${ROLLBACK ? '&rollback=1' : ''}`;

  const browser = await chromium.launch();
  const p1 = await (await browser.newContext({ viewport: { width: 900, height: 560 } })).newPage();
  const p2 = await (await browser.newContext({ viewport: { width: 900, height: 560 } })).newPage();
  const errs: string[] = [];
  for (const [pg, tag] of [[p1, 'B1'], [p2, 'B2']] as const) pg.on('pageerror', (e) => errs.push(`${tag} ${e.message}`));

  await Promise.all([
    p1.goto(url(0, ownedFrom(0)), { waitUntil: 'domcontentloaded' }),
    p2.goto(url(B2_SLOT, ownedFrom(B2_SLOT)), { waitUntil: 'domcontentloaded' }),
  ]);

  const reach = async (pg: typeof p1) => { try { await pg.waitForFunction((want) => { const s = (window as any).__pallasiteState; const pd = (window as any).__pallasitePeerDebug?.(); return s && s.players?.length === want && ['playing', 'wavestart', 'warp'].includes(s.phase) && pd?.active && pd.remoteLatest >= 0; }, PLAYERS, { timeout: 25000 }); return true; } catch { return false; } };
  const [r1, r2] = await Promise.all([reach(p1), reach(p2)]);
  ok(`both booths reach ${PLAYERS}-player coop (${NETCODE})`, r1 && r2);
  if (!r1 || !r2) throw new Error(`did not reach ${PLAYERS}-player coop`);

  // Drive the primary pilot on each booth (slot 0 / slot 2). The 2nd local
  // slot has no input routing yet, so it stays idle — fine for a desync soak.
  // No thrust — stationary ships firing clear asteroids without ramming them,
  // so the coop run survives the full soak instead of hitting game-over (which
  // navigates and tears down the test context).
  const drive = (pg: typeof p1, slot: number, tick: number) => safe(() => pg.evaluate(([sl, t]) => {
    const k = (window as any).__pallasiteTestHooks?.localKeysRef?.[sl];
    if (!k) return;
    k['ArrowUp'] = false;
    k['Space'] = true;
    k['ArrowLeft'] = (t % 6) < 3;
    k['ArrowRight'] = (t % 6) >= 3;
  }, [slot, tick] as [number, number]), undefined);

  const peerDbg = (pg: typeof p1) => safe(() => pg.evaluate(() => (window as any).__pallasitePeerDebug?.() ?? null), null);
  const stateLite = (pg: typeof p1) => safe(() => pg.evaluate(() => { const s = (window as any).__pallasiteState; return s ? { phase: s.phase, players: s.players?.length ?? 0, frame: s.frame, wave: s.wave, alive: s.players?.filter((p: any) => p.ship?.alive).length ?? 0 } : null; }), null);
  const canary = (pg: typeof p1) => safe(() => pg.evaluate(() => Array.from(((window as any).__pallasiteCanaryHistory as Map<number, string>) ?? new Map()).map(([f, s]) => [f, s]) as [number, string][]), [] as [number, string][]);

  const start = Date.now();
  let tick = 0, maxStall = 0, maxGap = 0, disconnects = 0, checks = 0, maxWave = 1;
  const desyncFrames: number[] = [];
  const phasesSeen = new Set<string>();

  while (Date.now() - start < DURATION_MS) {
    await Promise.all([drive(p1, 0, tick), drive(p2, B2_SLOT, tick)]);
    tick++;
    await sleep(250);
    if (tick % 8 === 0) {                 // ~every 2s
      checks++;
      const [d1, d2, s1, s2, h1, h2] = await Promise.all([peerDbg(p1), peerDbg(p2), stateLite(p1), stateLite(p2), canary(p1), canary(p2)]);
      if (!s1 || !s2) { process.stdout.write('\n   a booth left play (game-over / nav) — stopping, reporting collected data\n'); break; }
      if (d1) maxStall = Math.max(maxStall, d1.maxStallFrames ?? 0);
      if (d2) maxStall = Math.max(maxStall, d2.maxStallFrames ?? 0);
      if (!d1?.active || !d2?.active) disconnects++;
      if (s1 && s2) { maxGap = Math.max(maxGap, Math.abs(s1.frame - s2.frame)); maxWave = Math.max(maxWave, s1.wave, s2.wave); phasesSeen.add(s1.phase); phasesSeen.add(s2.phase); }
      const m2 = new Map(h2);
      for (const [f, s] of h1) if (m2.has(f) && m2.get(f) !== s && !desyncFrames.includes(f)) desyncFrames.push(f);
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r  ${elapsed}s · B1 f${s1?.frame ?? '?'} w${s1?.wave ?? '?'} · B2 f${s2?.frame ?? '?'} · gap ${maxGap} · stall ${maxStall} · desync ${desyncFrames.length}   `);
    }
  }
  process.stdout.write('\n');

  const [fs1, fs2] = await Promise.all([stateLite(p1), stateLite(p2)]);
  ok('NO desync across booths (canary match)', desyncFrames.length === 0, desyncFrames.length ? `first at frame ${desyncFrames[0]} (${desyncFrames.length} frames)` : `${checks} checks over ${DURATION_MS / 1000}s`);
  ok('no disconnects', disconnects === 0, `${disconnects}/${checks}`);
  ok('stalls bounded under latency', maxStall < 180, `max ${maxStall} frames`);
  ok('frame gap stays in lockstep window', maxGap < 220, `max ${maxGap} frames`);
  ok('progressed into live play', phasesSeen.has('playing'), `phases ${[...phasesSeen].join(',')}, reached wave ${maxWave}`);
  ok(`still ${PLAYERS}-player at the end`, !!(fs1 && fs2 && fs1.players === PLAYERS && fs2.players === PLAYERS), JSON.stringify([fs1, fs2]));
  if (errs.length) console.log('   page errors:', errs.slice(0, 4).join(' | '));
  await browser.close();
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
}
