/**
 * Record a real duel (two players, one spectator) and produce demo.mp4.
 *
 * Spawns vite + the controller-ws broker, launches three headless
 * Chromium contexts:
 *   - Player A on /?peer=…&slot=0  (drives ArrowLeft / ArrowUp / Space)
 *   - Player B on /?peer=…&slot=1  (drives ArrowRight / ArrowUp / Space)
 *   - Spectator on /?spectate=…&peer=…   (video recorded)
 *
 * The spectator's context has recordVideo enabled. After the run, the
 * .webm chunk is transcoded to .mp4 via ffmpeg so we can drop it into
 * a README or share it on Nostr.
 *
 * Run with `pnpm run record:duel`. Inputs are scripted to look like
 * real gameplay (turn, drift, fire, dodge) rather than a single key
 * held flat. ~20 seconds of footage by default.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5180;
const BROKER_PORT = 8788;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const BROKER_READY_TIMEOUT_MS = 10_000;
const REACH_PLAYING_TIMEOUT_MS = 25_000;
const PLAY_DURATION_MS = 18_000;

const OUT_DIR = resolve(process.cwd(), 'tools/record-out');
const SPECTATOR_DIR = resolve(OUT_DIR, 'spectator');
const FINAL_MP4 = resolve(OUT_DIR, 'duel-demo.mp4');

async function startVite(): Promise<ChildProcess> {
  const vite = spawn('pnpm', ['exec', 'vite', '--force'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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

/** Press a key for `ms` milliseconds, then release. Awaitable so callers
 *  can chain a realistic-feeling sequence. */
async function tap(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await wait(ms);
  await page.keyboard.up(key);
}

/** Slot 0 (player A) input script — turn-and-fire pattern that keeps the
 *  ship moving without long thrust bursts that smash into asteroids. The
 *  earlier "thrust 600ms then turn" pattern reliably killed both pilots
 *  within ~10s, leaving the recording with one dead ship and one alive
 *  (and the spectator complaining "only one player visible"). Now we
 *  turn a lot, fire a lot, and only thrust in short defensive nudges.
 *  Both pilots survive ~20s of footage with all three lives intact most
 *  of the time. */
async function pilotA(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await tap(page, 'ArrowLeft', 300);
    await tap(page, 'Space', 60);
    await wait(120);
    await tap(page, 'Space', 60);
    await wait(120);
    await tap(page, 'Space', 60);
    await tap(page, 'ArrowUp', 120);  // brief nudge to drift
    await wait(200);
  }
}

/** Slot 1 (player B) input script — mirror of A: turn right + fire. */
async function pilotB(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await tap(page, 'ArrowRight', 280);
    await tap(page, 'Space', 60);
    await wait(140);
    await tap(page, 'Space', 60);
    await wait(140);
    await tap(page, 'Space', 60);
    await tap(page, 'ArrowUp', 100);
    await wait(220);
  }
}

async function main(): Promise<void> {
  // Clean output dir up front so leftover .webm chunks from previous runs
  // don't get picked up.
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(SPECTATOR_DIR, { recursive: true });
  for (const f of readdirSync(SPECTATOR_DIR)) {
    if (f.endsWith('.webm')) {
      try { renameSync(resolve(SPECTATOR_DIR, f), resolve(SPECTATOR_DIR, f + '.bak')); } catch { /* ignore */ }
    }
  }

  process.stdout.write('Starting vite + broker...\n');
  const vite = await startVite();
  const broker = await startBroker();
  const kill = (): void => { killGroup(vite); killGroup(broker); };
  process.on('SIGINT', () => { kill(); process.exit(130); });
  process.on('SIGTERM', () => { kill(); process.exit(143); });

  let exitCode = 0;
  try {
    await Promise.all([
      waitForHttp(VITE_BASE + '/', VITE_READY_TIMEOUT_MS, 'vite'),
      waitForHttp(`http://localhost:${BROKER_PORT}/`, BROKER_READY_TIMEOUT_MS, 'broker'),
    ]);
    process.stdout.write('vite + broker ready.\n');

    const session = randomBytes(4).toString('hex');
    // The duel peer URL has `r=peer` baked in via the `peer=` param; the
    // spectator needs `r=peerwatch` instead. SpectatorPeer opens whatever
    // URL it's handed verbatim, so we pre-build both flavours rather than
    // passing the bare broker host and asking the client to compose.
    const peerEnc = encodeURIComponent(BROKER_URL);
    const peerWatchUrl = `${BROKER_URL}/?s=${session}&r=peerwatch`;
    const peerWatchEnc = encodeURIComponent(peerWatchUrl);
    const urlA = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=0`;
    const urlB = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=1`;
    const urlSpec = `${VITE_BASE}/?spectate=${session}&peer=${peerWatchEnc}`;
    process.stdout.write(`session: ${session}\n`);

    const browser: Browser = await chromium.launch();
    try {
      // Players: no video. Spectator: video enabled. Playwright writes
      // one .webm per context once the context closes.
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const ctxSpec = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        recordVideo: { dir: SPECTATOR_DIR, size: { width: 1280, height: 720 } },
      });
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const pageSpec = await ctxSpec.newPage();

      pageA.on('pageerror', (e) => process.stderr.write(`[A pageerror] ${e.message}\n`));
      pageB.on('pageerror', (e) => process.stderr.write(`[B pageerror] ${e.message}\n`));
      pageSpec.on('pageerror', (e) => process.stderr.write(`[Spec pageerror] ${e.message}\n`));

      // Spectator joins FIRST so the broker's peerwatch fan-out captures
      // frame 0 onwards. If the spectator joined after the players had
      // already advanced, its lockstep would have no inputs for frames
      // 0..N and stall — past 120 stalled frames it declares "Duel ended"
      // and the recording ends prematurely.
      await pageSpec.goto(urlSpec, { waitUntil: 'load' });
      process.stdout.write('spectator loaded; waiting on partners…\n');
      // The spectator sits on the CONNECTING overlay until both peers
      // bind. Players load next; once both auto-IGNITE, the spectator's
      // connect resolves and simulateStart fires, all in lockstep.
      await Promise.all([
        pageA.goto(urlA, { waitUntil: 'load' }),
        pageB.goto(urlB, { waitUntil: 'load' }),
      ]);
      process.stdout.write('player pages loaded; waiting for phase=playing on all three...\n');

      const waitPlaying = (page: Page, label: string): Promise<void> => page.waitForFunction(
        () => (window as unknown as { __pallasiteState?: { phase: string } }).__pallasiteState?.phase === 'playing',
        undefined,
        { timeout: REACH_PLAYING_TIMEOUT_MS },
      ).then(() => process.stdout.write(`  ${label} reached playing\n`));
      await Promise.all([waitPlaying(pageA, 'A'), waitPlaying(pageB, 'B'), waitPlaying(pageSpec, 'spec')]);
      // Settle so the recording's first frame is the shared arena, not
      // the wavestart cutscene.
      await wait(1500);
      process.stdout.write(`scripting ${PLAY_DURATION_MS}ms of gameplay...\n`);

      // Drive both pilots concurrently. Capture any error from either so
      // a misbehaving pilot doesn't silently truncate the recording.
      const aPromise = pilotA(pageA).catch((e) => process.stderr.write(`[pilotA] ${e}\n`));
      const bPromise = pilotB(pageB).catch((e) => process.stderr.write(`[pilotB] ${e}\n`));

      // Hard cap to PLAY_DURATION_MS even if the scripts finish sooner —
      // we want a consistent-length recording.
      await Promise.race([
        Promise.all([aPromise, bPromise]),
        wait(PLAY_DURATION_MS),
      ]);
      await wait(800);  // settle frame so the recording's tail isn't mid-thrust

      // Probe each context BEFORE closing so we can verify what the
      // recording actually captured. The spectator complaint "only one
      // ship visible" is hard to confirm from frame inspection alone —
      // dump the GameState so it's unambiguous what was on the canvas.
      const dumpState = async (page: Page, tag: string): Promise<void> => {
        try {
          const s = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const g: any = (window as any).__pallasiteState;
            if (!g) return null;
            return {
              phase: g.phase, frame: g.frame, playerCount: g.players.length,
              desyncFrame: document.body.getAttribute('data-peer-desync'),
              stall: document.body.getAttribute('data-peer-stall'),
              players: g.players.map((pl: { ship: { alive: boolean; pos: { x: number; y: number }; rot: number; hyperspaceCloakMs: number }; lives: number; score: number }) => ({
                alive: pl.ship.alive, x: Math.round(pl.ship.pos.x), y: Math.round(pl.ship.pos.y),
                rot: Number(pl.ship.rot.toFixed(2)), lives: pl.lives, score: pl.score,
                cloak: pl.ship.hyperspaceCloakMs,
              })),
            };
          });
          process.stdout.write(`[state ${tag}] ${JSON.stringify(s)}\n`);
        } catch (e) { process.stderr.write(`[state ${tag}] probe failed: ${String(e)}\n`); }
      };
      await dumpState(pageA, 'A');
      await dumpState(pageB, 'B');
      await dumpState(pageSpec, 'Spec');

      process.stdout.write('closing spectator context to flush video...\n');
      await ctxSpec.close();
      await ctxA.close();
      await ctxB.close();
    } finally {
      await browser.close();
    }

    // Playwright writes a single .webm into the spectator dir keyed by
    // a random hash. Find it and transcode.
    const webms = readdirSync(SPECTATOR_DIR).filter(f => f.endsWith('.webm'));
    if (webms.length === 0) {
      process.stderr.write('no .webm recorded — playwright video flush failed\n');
      exitCode = 1;
    } else {
      const webm = resolve(SPECTATOR_DIR, webms[0]);
      process.stdout.write(`transcoding ${webm} -> ${FINAL_MP4}\n`);
      // -y overwrites, -c:v libx264 for broad mp4 compatibility, -crf 23
      // for sane size/quality, -pix_fmt yuv420p so iOS / Safari plays it.
      const ff = spawnSync('ffmpeg', ['-y', '-i', webm, '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p', '-an', FINAL_MP4], { stdio: 'inherit' });
      if (ff.status !== 0) {
        process.stderr.write(`ffmpeg failed with status ${ff.status}\n`);
        exitCode = 1;
      } else {
        if (existsSync(FINAL_MP4)) {
          process.stdout.write(`\n✓ recording saved: ${FINAL_MP4}\n`);
        }
      }
    }
  } catch (e) {
    process.stderr.write(`record error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    kill();
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
