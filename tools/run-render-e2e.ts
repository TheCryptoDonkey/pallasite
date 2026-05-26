/**
 * Render-level end-to-end: prove every player's ship actually paints
 * onto the canvas, not just that the GameState carries it.
 *
 * The existing duel e2e (tools/run-e2e.ts) probes `state.players[i]`
 * fields and asserts cross-page rotation convergence. That catches
 * lockstep + protocol regressions, but it CANNOT see a renderer bug
 * because it never reads the canvas. The "only one ship visible in
 * 2P" bug (slot 0 went through the WebGL mesh overlay, slot 1 fell
 * through every code path) sat in production unnoticed for that
 * exact reason — sim state was correct, the canvas was wrong, no
 * test looked at the canvas.
 *
 * This runner does the smallest thing that would have caught it:
 *  - launches a 2P duel,
 *  - waits for both to reach phase=playing + a brief settle for the
 *    spawn-invuln flicker to expire,
 *  - reads the canvas's getImageData() at the two expected ship
 *    positions,
 *  - asserts each region contains non-background brightness, i.e.
 *    something was actually drawn there.
 *
 * Run with `pnpm run test:render`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5197;
const BROKER_PORT = 8797;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const BROKER_READY_TIMEOUT_MS = 10_000;
const REACH_PLAYING_TIMEOUT_MS = 30_000;
/** The mesh-tier early-return in drawShip is gated on isWebGLOverlayReady().
 *  The overlay is dynamic-imported, so on a fresh page it isn't ready for
 *  the first ~second after load. If we sample before then, drawShip falls
 *  through to the 2D path for ALL ships — and the bug (slot 1 invisible
 *  with mesh enabled) wouldn't trigger. We poll the #game3d canvas's draw
 *  buffer for non-zero content as the proxy for "overlay is rendering."
 *  Cap so a flaky load doesn't stall the test indefinitely. */
const WEBGL_READY_TIMEOUT_MS = 10_000;
/** Time between WebGL overlay ready and our first sample. Short enough that
 *  no asteroid can kill either ship (still inside spawn invuln, typically
 *  ~2.2s) and we get our pixel check in before the gameplay starts
 *  doing things that might move ships off their spawn points. */
const POST_PLAYING_SETTLE_MS = 500;
/** Spawn invuln flickers the ship at ~6 Hz (Math.floor(now / 80) % 2).
 *  We sample multiple frames so at least one lands on a "flicker on"
 *  frame; the test takes the MAX bright count across samples. */
const SAMPLE_FRAMES = 8;
const SAMPLE_INTERVAL_MS = 90;
/** Half-extent of the sample window around each expected ship position,
 *  in WORLD coords. A tight 11×11 window centred on the spawn coord
 *  is enough to land squarely on the ship body and miss the bright
 *  planet limb that's ~30-50 world pixels to the right of P1's spawn.
 *  The renderer maps world → drawing-buffer 1:1 in retro mode (which
 *  2P forces — see fit() in src/main.ts). */
const SAMPLE_RADIUS_WORLD = 5;
/** A "ship pixel" is one where MIN(R,G,B) > threshold — bright in all
 *  channels, i.e. the ship hull (greenish-white for slot 0, cyan-white
 *  for slot 1, near-pure-white at the mesh hull). Empirically the
 *  mesh hull min channel is ~238, the shaded 2D hull min ~150, dark
 *  space ~10-40, planet limb at the brightest ~125. 130 catches both
 *  the mesh and shaded hulls while excluding any bg pixel that might
 *  drift into a small sample window centred on the spawn coord. */
const PIXEL_MIN_CHANNEL_THRESHOLD = 130;
/** Minimum count of "ship pixels" inside the 11×11 sample window for
 *  the assertion to consider the ship drawn. Pre-fix data: P0 had
 *  119/121, P1 had 0/121 — clean separation. 10 is generous but
 *  excludes a single stray bright pixel from triggering a false-pass. */
const SHIP_PIXEL_MIN_COUNT = 10;

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

async function startBroker(): Promise<ChildProcess> {
  const broker = spawn('node', ['controller-ws/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(BROKER_PORT), HOST: '127.0.0.1' },
    detached: true,
  });
  broker.stdout?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[broker] ${s}`);
  });
  broker.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[broker] ${s}`);
  });
  return broker;
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
    try { const r = await fetch(url); if (r.status < 500) return; }
    catch (e) { lastErr = e; }
    await wait(150);
  }
  throw new Error(`${label} not ready at ${url} in ${timeoutMs}ms: ${String(lastErr)}`);
}

/** Capture pixel data for a window around (worldX, worldY) on BOTH the
 *  2D #game canvas AND the WebGL #game3d overlay canvas, combine into
 *  a single 8-bit "max channel per pixel" buffer (so a pixel rendered
 *  on either canvas shows up at its real brightness). Returns the raw
 *  buffer plus the dimensions so the caller can diff against a baseline.
 *  The composite is what the user sees, modulo WebGL preserveDrawingBuffer:
 *  if the overlay can't be read (default WebGL doesn't preserve its
 *  buffer past frame compositing), the 2D bytes are returned alone. */
async function captureWindow(page: Page, worldX: number, worldY: number, radius: number): Promise<{ width: number; height: number; bytes: number[] }> {
  return page.evaluate(([wx, wy, r]) => {
    const c2d = document.getElementById('game') as HTMLCanvasElement | null;
    if (!c2d) throw new Error('no #game canvas');
    const ctx2d = c2d.getContext('2d');
    if (!ctx2d) throw new Error('no 2D context');
    const WORLD_W = 1280;
    const dpr = c2d.width / WORLD_W;
    const bx = Math.round(wx * dpr);
    const by = Math.round(wy * dpr);
    const half = Math.round(r * dpr);
    const x0 = Math.max(0, bx - half);
    const y0 = Math.max(0, by - half);
    const w = Math.min(c2d.width - x0, half * 2);
    const h = Math.min(c2d.height - y0, half * 2);
    const out = new Uint8ClampedArray(w * h * 4);
    // 2D content
    const data2d = ctx2d.getImageData(x0, y0, w, h).data;
    for (let i = 0; i < out.length; i++) out[i] = data2d[i];
    // WebGL content composited via per-pixel max(channel). Bottom-up flip
    // matches the WebGL viewport.
    const c3d = document.getElementById('game3d') as HTMLCanvasElement | null;
    if (c3d && c3d.width === c2d.width && c3d.height === c2d.height) {
      const gl = c3d.getContext('webgl2') ?? c3d.getContext('webgl');
      if (gl) {
        const glY = c3d.height - (y0 + h);
        const buf = new Uint8Array(w * h * 4);
        try {
          gl.readPixels(x0, glY, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          // The WebGL buffer arrives bottom-up; flip per-row when merging.
          for (let row = 0; row < h; row++) {
            const srcRow = h - 1 - row;
            for (let col = 0; col < w; col++) {
              const dst = (row * w + col) * 4;
              const src = (srcRow * w + col) * 4;
              for (let ch = 0; ch < 3; ch++) {
                if (buf[src + ch] > out[dst + ch]) out[dst + ch] = buf[src + ch];
              }
            }
          }
        } catch { /* readPixels can fail on a context-lost overlay; skip */ }
      }
    }
    return { width: w, height: h, bytes: Array.from(out) };
  }, [worldX, worldY, radius]);
}

/** Legacy bright-pixel counter — kept for the empty-region sanity check
 *  and as a fallback. The main ship assertion uses captureWindow + diff. */
async function countBrightPixels(page: Page, worldX: number, worldY: number, radius: number, threshold: number): Promise<{ count: number; sampled: number; maxBrightness: number; on2D: number; on3D: number }> {
  return page.evaluate(([wx, wy, r, th]) => {
    const c2d = document.getElementById('game') as HTMLCanvasElement | null;
    if (!c2d) throw new Error('no #game canvas');
    const ctx2d = c2d.getContext('2d');
    if (!ctx2d) throw new Error('no 2D context');
    // The fit() pass for 2P uses the retro transform: canvas.width =
    // round(WORLD_W * dpr), no offset, scale=1. Drawing-buffer pixel
    // = world * dpr. The #game3d overlay matches dimensions exactly.
    const WORLD_W = 1280;
    const WORLD_H = 720;
    const dpr = c2d.width / WORLD_W;
    const bx = Math.round(wx * dpr);
    const by = Math.round(wy * dpr);
    const half = Math.round(r * dpr);
    const x0 = Math.max(0, bx - half);
    const y0 = Math.max(0, by - half);
    const w = Math.min(c2d.width - x0, half * 2);
    const h = Math.min(c2d.height - y0, half * 2);

    let on2D = 0; let on3D = 0; let maxMin = 0;
    let sampled = 0;

    // "White pixel" = MIN(R,G,B) > threshold. Chromatic backgrounds (the
    // bluish planet, reddish nebula) have at least one low channel and
    // never count, while ships and bright stars do. Inline check rather
    // than a closure — tsx's keep-names helper inlines a __name reference
    // into the serialised page.evaluate body which then ReferenceErrors
    // in the browser.

    // 2D canvas via getImageData. Top-left origin.
    const data2d = ctx2d.getImageData(x0, y0, w, h).data;
    sampled = data2d.length / 4;
    for (let i = 0; i < data2d.length; i += 4) {
      const r = data2d[i], g = data2d[i + 1], b = data2d[i + 2];
      const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if (mn > maxMin) maxMin = mn;
      if (mn > th) on2D++;
    }

    // WebGL overlay canvas (#game3d) via gl.readPixels. Bottom-left
    // origin, hence WORLD_H-y flip; same dpr/size as #game so the
    // sample window is the same.
    const c3d = document.getElementById('game3d') as HTMLCanvasElement | null;
    if (c3d && c3d.width === c2d.width && c3d.height === c2d.height) {
      const gl = c3d.getContext('webgl2') ?? c3d.getContext('webgl');
      if (gl) {
        // WebGL readPixels y-axis is bottom-up; convert top-down world y.
        const glY = c3d.height - (y0 + h);
        const buf = new Uint8Array(w * h * 4);
        try {
          gl.readPixels(x0, glY, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          for (let i = 0; i < buf.length; i += 4) {
            const r = buf[i], g = buf[i + 1], b = buf[i + 2];
            const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
            if (mn > maxMin) maxMin = mn;
            if (mn > th) on3D++;
          }
        } catch { /* readPixels can fail on a context-lost overlay; skip */ }
      }
    }
    void WORLD_H;
    return { count: on2D + on3D, sampled, maxBrightness: maxMin, on2D, on3D };
  }, [worldX, worldY, radius, threshold]);
}

async function renderProbe(page: Page): Promise<{
  phase: string;
  frame: number;
  peerActive: boolean;
  playerCount: number;
  bodyStall: string | null;
  bodyDesync: string | null;
  counters: unknown;
}> {
  return page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const s = w.__pallasiteState;
    return {
      phase: s?.phase ?? 'missing',
      frame: s?.frame ?? -1,
      peerActive: !!w.__pallasitePeerActive,
      playerCount: Array.isArray(s?.players) ? s.players.length : 0,
      bodyStall: document.body.getAttribute('data-peer-stall'),
      bodyDesync: document.body.getAttribute('data-peer-desync'),
      counters: w.__pallasitePeerCounters?.() ?? null,
    };
  });
}

interface CheckRow { name: string; ok: boolean; detail: string }
function reportCheck(rows: CheckRow[], name: string, ok: boolean, detail: string): void {
  rows.push({ name, ok, detail });
}

async function main(): Promise<void> {
  process.stdout.write('Starting Vite + broker...\n');
  const vite = await startVite();
  const broker = await startBroker();
  const kill = (): void => { killGroup(vite); killGroup(broker); };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  let exitCode = 0;
  const checks: CheckRow[] = [];
  try {
    await Promise.all([
      waitForHttp(VITE_BASE + '/', VITE_READY_TIMEOUT_MS, 'vite'),
      waitForHttp(`http://localhost:${BROKER_PORT}/`, BROKER_READY_TIMEOUT_MS, 'broker'),
    ]);
    process.stdout.write('Vite + broker ready.\n');

    // Fixed session id so the arena (seeded from sessionSeed(session))
    // is deterministic. The duel e2e uses randomBytes for cross-page
    // convergence testing, but for the render test a fixed seed avoids
    // the "asteroid spawned on top of slot 0" flake — once a seed is
    // confirmed to not kill ships in the first ~5 seconds of play, the
    // test runs repeatably. Change this value only if a future asteroid
    // generation change makes this seed kill a spawn.
    const session = 'rendere2e';
    const peerEnc = encodeURIComponent(BROKER_URL);
    const urlA = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=0&players=2`;
    const urlB = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=1&players=2`;

    const browser: Browser = await chromium.launch();
    try {
      // Slot 0 IS in retro mode (fit() chooses retro for players.length >= 2),
      // so its canvas shows the full world and both ships should be visible.
      // We could equally probe slot 1 or a spectator; slot 0 is cheapest.
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      pageA.on('pageerror', (e: Error) => process.stderr.write(`[A pageerror] ${e.message}\n`));
      pageB.on('pageerror', (e: Error) => process.stderr.write(`[B pageerror] ${e.message}\n`));

      await Promise.all([pageA.goto(urlA, { waitUntil: 'load' }), pageB.goto(urlB, { waitUntil: 'load' })]);
      const waitStartable = (page: Page): Promise<void> => page.waitForFunction(
        () => {
          const w = window as unknown as { __pallasitePeerActive?: boolean; __pallasiteState?: { phase: string; players?: unknown[]; elapsed: number; phaseStart: number } };
          const s = w.__pallasiteState;
          return !!w.__pallasitePeerActive
            && s?.players?.length === 2
            && (s.phase === 'playing' || (s.phase === 'wavestart' && s.elapsed - s.phaseStart > 1000));
        },
        undefined,
        { timeout: REACH_PLAYING_TIMEOUT_MS },
      ).then(() => undefined);
      // Skip the campaign intertitle before sampling. The intertitle
      // deliberately blacks the playfield, so sampling there would prove
      // only that the story card rendered.
      const waitDrawing = (page: Page): Promise<void> => page.waitForFunction(
        () => {
          const s = (window as unknown as { __pallasiteState?: { phase: string; players?: unknown[] } }).__pallasiteState;
          return s?.players?.length === 2 && s.phase === 'playing';
        },
        undefined,
        { timeout: REACH_PLAYING_TIMEOUT_MS },
      ).then(() => undefined);
      try {
        await Promise.all([waitStartable(pageA), waitStartable(pageB)]);
        await Promise.all([pageA.keyboard.press('Enter'), pageB.keyboard.press('Enter')]);
        await Promise.all([waitDrawing(pageA), waitDrawing(pageB)]);
      } catch (e) {
        const [probeA, probeB] = await Promise.all([renderProbe(pageA), renderProbe(pageB)]);
        process.stderr.write(`startup A: ${JSON.stringify(probeA)}\n`);
        process.stderr.write(`startup B: ${JSON.stringify(probeB)}\n`);
        await pageA.screenshot({ path: '/tmp/render-e2e-startup-A.png', fullPage: false }).catch(() => undefined);
        await pageB.screenshot({ path: '/tmp/render-e2e-startup-B.png', fullPage: false }).catch(() => undefined);
        throw e;
      }
      // Wait for the WebGL overlay to start rendering — without this the
      // 2D drawShip path stays active for everything and the renderer-
      // skips-slot-1 bug wouldn't trigger. Use the renderer's probe rather
      // than sampling a fixed pixel; the overlay can be ready while the
      // centre of the duel arena is legitimately empty space.
      const webglReady = await pageA.waitForFunction(
        () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return !!(window as any).__pallasiteRenderProbe?.().webglOverlayReady;
        },
        undefined,
        { timeout: WEBGL_READY_TIMEOUT_MS },
      ).then(() => true).catch(() => false);
      process.stdout.write(`webgl overlay ready: ${webglReady}\n`);
      // Short settle so any in-flight frame uses the now-ready overlay.
      await wait(POST_PLAYING_SETTLE_MS);
      // Sanity: what's the current ship visual tier on this run? If
      // localStorage put it on 'vector' the bug-trigger condition
      // (mesh + WebGL ready) doesn't apply and the test would not
      // catch the regression. Dump for the run log.
      const diag = await pageA.evaluate(() => {
        const c3d = document.getElementById('game3d') as HTMLCanvasElement | null;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const probe = (window as any).__pallasiteRenderProbe?.() ?? null;
        return {
          shipTierLocalStorage: localStorage.getItem('pallasite:visualStyle'),
          game3dSize: c3d ? { w: c3d.width, h: c3d.height } : null,
          probe,
        };
      });
      process.stdout.write(`diag: ${JSON.stringify(diag)}\n`);
      // Capture a debug screenshot so a failing run leaves an artefact.
      await pageA.screenshot({ path: '/tmp/render-e2e-canvas.png', fullPage: false });
      process.stdout.write('debug screenshot: /tmp/render-e2e-canvas.png\n');

      // Probe slot 0's view. Both ships are at their spawn coords in
      // retro mode — slot 0 at (640, 360) after beginWave's centre reset
      // and slot 1 at (896, 360) from startGame's slot spawn override.
      const state = await pageA.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s: any = (window as any).__pallasiteState;
        return {
          phase: s.phase, frame: s.frame, playerCount: s.players.length,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          players: s.players.map((p: any) => ({ alive: p.ship.alive, x: Math.round(p.ship.pos.x), y: Math.round(p.ship.pos.y), invulnUntil: p.ship.invulnerableUntil })),
        };
      }) as { phase: string; frame: number; playerCount: number; players: { alive: boolean; x: number; y: number; invulnUntil: number }[] };
      process.stdout.write(`state: ${JSON.stringify(state)}\n`);

      reportCheck(checks, 'phase = playing', state.phase === 'playing', `phase=${state.phase}`);
      reportCheck(checks, 'playerCount = 2', state.playerCount === 2, `playerCount=${state.playerCount}`);
      reportCheck(checks, 'P0 alive', state.players[0]?.alive === true, `alive=${state.players[0]?.alive}`);
      reportCheck(checks, 'P1 alive', state.players[1]?.alive === true, `alive=${state.players[1]?.alive}`);

      const p0 = state.players[0];
      const p1 = state.players[1];
      if (p0 && p1) {
        // Count "ship pixels" — pixels in a tight 11×11 window centred on
        // the exact spawn coord where MIN(R,G,B) > threshold. Ship hulls
        // are bright in all three channels; the bluish planet (which sits
        // ~30-50 px to the right of slot 1's spawn) has low R; dark space
        // has low everything. Take the max count across multiple samples
        // so spawn-invuln flicker can't suppress the count.
        const sampleShipPixels = async (worldX: number, worldY: number): Promise<{ count: number; sampled: number; maxMinChannel: number }> => {
          // Initialise from the first capture so `sampled` reflects the
          // real window size even when later samples don't improve on
          // count = 0 (the "ship missing" case).
          let best = { count: -1, sampled: 0, maxMinChannel: 0 };
          for (let i = 0; i < SAMPLE_FRAMES; i++) {
            const cap = await captureWindow(pageA, worldX, worldY, SAMPLE_RADIUS_WORLD);
            const sampled = cap.bytes.length / 4;
            let count = 0;
            let maxMn = 0;
            for (let j = 0; j < cap.bytes.length; j += 4) {
              const r = cap.bytes[j], g = cap.bytes[j + 1], b = cap.bytes[j + 2];
              const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
              if (mn > maxMn) maxMn = mn;
              if (mn > PIXEL_MIN_CHANNEL_THRESHOLD) count++;
            }
            if (best.count < 0 || count > best.count) best = { count, sampled, maxMinChannel: maxMn };
            await wait(SAMPLE_INTERVAL_MS);
          }
          return best;
        };
        const samp0 = await sampleShipPixels(p0.x, p0.y);
        const samp1 = await sampleShipPixels(p1.x, p1.y);
        // Empty region sanity — same tight sampling at a coord well
        // clear of ships, asteroids, planet, and HUD.
        const sampEmpty = await sampleShipPixels(640, 700);
        process.stdout.write(`P0 @(${p0.x},${p0.y}): ${JSON.stringify(samp0)}\n`);
        process.stdout.write(`P1 @(${p1.x},${p1.y}): ${JSON.stringify(samp1)}\n`);
        process.stdout.write(`empty @(640,700): ${JSON.stringify(sampEmpty)}\n`);

        reportCheck(
          checks,
          'P0 drawn on canvas',
          samp0.count >= SHIP_PIXEL_MIN_COUNT,
          `count=${samp0.count}/${samp0.sampled} (need >=${SHIP_PIXEL_MIN_COUNT})  maxMin=${samp0.maxMinChannel}`,
        );
        reportCheck(
          checks,
          'P1 drawn on canvas',
          samp1.count >= SHIP_PIXEL_MIN_COUNT,
          `count=${samp1.count}/${samp1.sampled} (need >=${SHIP_PIXEL_MIN_COUNT})  maxMin=${samp1.maxMinChannel}`,
        );
        reportCheck(
          checks,
          'empty region is background (sanity)',
          sampEmpty.count < SHIP_PIXEL_MIN_COUNT,
          `count=${sampEmpty.count}/${sampEmpty.sampled} (should be <${SHIP_PIXEL_MIN_COUNT})`,
        );
      }
    } finally {
      await browser.close();
    }
  } catch (e) {
    process.stderr.write(`render-e2e error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    kill();
  }

  process.stdout.write('\n=== render checks ===\n');
  for (const c of checks) {
    const tag = c.ok ? '[PASS]' : '[FAIL]';
    process.stdout.write(`${tag} ${c.name.padEnd(38)} ${c.detail}\n`);
    if (!c.ok) exitCode = 1;
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
