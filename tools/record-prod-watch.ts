/**
 * Record a real 2P duel against PRODUCTION (pallasite.app +
 * controller.pallasite.app) from a spectator viewpoint, output MP4.
 *
 * Launches three chromium contexts:
 *   - Player A on https://pallasite.app/?peer=…&slot=0   (scripted input)
 *   - Player B on https://pallasite.app/?peer=…&slot=1   (scripted input)
 *   - Spectator on /?spectate=…&peer=…                   (video recorded)
 *
 * The spectator canvas is captured as an image sequence directly from the
 * composited 2D + WebGL game canvases, then transcoded to MP4. That avoids
 * Playwright's page recorder and MediaRecorder frame drops in headless Chrome,
 * so the clip is proof footage from the real watch page rather than a flaky
 * screen-recorder artefact.
 *
 * Run with `pnpm exec tsx tools/record-prod-watch.ts`. Output: tools/
 * record-out/prod-duel-watch.mp4. ~15s of footage.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const TARGET = process.env.TARGET ?? 'https://pallasite.app';
const BROKER = process.env.BROKER ?? 'wss://controller.pallasite.app';
const REACH_PLAYING_TIMEOUT_MS = 30_000;
const PLAY_DURATION_MS = 15_000;
const ASSET_WARMUP_MS = 2_500;
const RECORD_FPS = 24;
const VIEWPORT = { width: 960, height: 540 } as const;
const ASTEROID_TEXTURE_TYPES = [
  'stony',
  'iron',
  'chondrite',
  'pallasite',
  'carbonaceous',
  'mesosiderite',
  'achondrite',
] as const;

const OUT_DIR = resolve(process.cwd(), 'tools/record-out');
const FINAL_MP4 = resolve(OUT_DIR, 'prod-duel-watch.mp4');

async function dispatchKey(page: Page, code: string, type: 'keydown' | 'keyup'): Promise<void> {
  await page.evaluate(({ code, type }) => {
    const key = code === 'Space' ? ' ' : code.replace(/^Arrow/, '');
    window.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true }));
  }, { code, type });
}

async function tap(page: Page, code: string, ms: number): Promise<void> {
  await dispatchKey(page, code, 'keydown');
  await wait(ms);
  await dispatchKey(page, code, 'keyup');
}

async function warmProofAssets(page: Page, label: string): Promise<void> {
  const urls = [
    '/backgrounds/wave-1.webp',
    ...ASTEROID_TEXTURE_TYPES.map((type) => `/backgrounds/asteroid-${type}.webp`),
  ];
  const script = String.raw`(async () => {
    const assetUrls = ${JSON.stringify(urls)};
    const loadOne = async (src) => {
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
      try {
        if ('decode' in img) await img.decode();
        else await new Promise((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('failed to load ' + src));
        });
        return { src, ok: img.naturalWidth > 0 && img.naturalHeight > 0 };
      } catch {
        return { src, ok: false };
      }
    };
    return Promise.all(assetUrls.map(loadOne));
  })()`;
  const results = await page.evaluate(script) as Array<{ src: string; ok: boolean }>;
  const failed = results.filter((r) => !r.ok).map((r) => r.src);
  if (failed.length > 0) {
    process.stdout.write(`[assets ${label}] warmed with failures: ${failed.join(', ')}\n`);
  } else {
    process.stdout.write(`[assets ${label}] warmed ${results.length} images\n`);
  }
}

async function aiPilot(page: Page, durationMs: number, firstTurn: 'ArrowLeft' | 'ArrowRight', turnMs: number, fireMs: number): Promise<void> {
  const until = Date.now() + durationMs;
  const secondTurn = firstTurn === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
  let activeTurn: 'ArrowLeft' | 'ArrowRight' | null = null;
  let nextFire = Date.now() + 450;
  await dispatchKey(page, 'ArrowUp', 'keydown');
  try {
    while (Date.now() < until) {
      const elapsed = durationMs - Math.max(0, until - Date.now());
      const desiredTurn = Math.floor(elapsed / turnMs) % 2 === 0 ? firstTurn : secondTurn;
      if (activeTurn !== desiredTurn) {
        if (activeTurn) await dispatchKey(page, activeTurn, 'keyup');
        await dispatchKey(page, desiredTurn, 'keydown');
        activeTurn = desiredTurn;
      }
      if (Date.now() >= nextFire) {
        await tap(page, 'Space', 55);
        nextFire += fireMs;
      }
      await wait(35);
    }
  } finally {
    if (activeTurn) await dispatchKey(page, activeTurn, 'keyup').catch(() => undefined);
    await dispatchKey(page, 'ArrowUp', 'keyup').catch(() => undefined);
    await dispatchKey(page, 'Space', 'keyup').catch(() => undefined);
  }
}

async function recordCanvasFrames(page: Page, frameDir: string, durationMs: number): Promise<{ frames: number; elapsedMs: number }> {
  mkdirSync(frameDir, { recursive: true });
  await page.exposeBinding('__pallasiteSaveFrame', async (_source, index: number, dataUrl: string) => {
    const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    writeFileSync(resolve(frameDir, `frame-${String(index).padStart(4, '0')}.jpg`), Buffer.from(b64, 'base64'));
  });

  const script = String.raw`(async () => {
    const duration = ${JSON.stringify(durationMs)};
    const fps = ${RECORD_FPS};
    const frameCount = Math.round(duration * fps / 1000);
    const canvas = document.getElementById('game');
    const overlay = document.getElementById('game3d');
    if (!canvas) {
      throw new Error('game canvas unavailable');
    }
    const recCanvas = document.createElement('canvas');
    recCanvas.width = ${VIEWPORT.width};
    recCanvas.height = ${VIEWPORT.height};
    const recCtx = recCanvas.getContext('2d', { alpha: false });
    if (!recCtx) {
      throw new Error('recording canvas unavailable');
    }
    const draw = () => {
      recCtx.setTransform(1, 0, 0, 1, 0, 0);
      recCtx.clearRect(0, 0, recCanvas.width, recCanvas.height);
      recCtx.drawImage(canvas, 0, 0, recCanvas.width, recCanvas.height);
      if (overlay && overlay.width > 0 && overlay.height > 0) {
        recCtx.drawImage(overlay, 0, 0, recCanvas.width, recCanvas.height);
      }
    };
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const saveFrame = window.__pallasiteSaveFrame;
    if (typeof saveFrame !== 'function') {
      throw new Error('frame save binding unavailable');
    }
    const start = performance.now();
    for (let i = 0; i < frameCount; i += 1) {
      const target = start + (i * 1000 / fps);
      const delay = target - performance.now();
      if (delay > 0) await sleep(delay);
      draw();
      await saveFrame(i, recCanvas.toDataURL('image/jpeg', 0.92));
    }
    return { frames: frameCount, elapsedMs: performance.now() - start };
  })()`;
  return page.evaluate(script) as Promise<{ frames: number; elapsedMs: number }>;
}

async function frameOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    return (window as unknown as { __pallasiteState?: { frame: number } }).__pallasiteState?.frame ?? -1;
  });
}

async function waitForSpectatorCaughtUp(pageA: Page, pageB: Page, pageSpec: Page): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const [a, b, s] = await Promise.all([frameOf(pageA), frameOf(pageB), frameOf(pageSpec)]);
    const live = Math.min(a, b);
    if (live > 0 && s > 0 && live - s < 45) {
      process.stdout.write(`spectator synced: live=${live} spec=${s} lag=${live - s}f\n`);
      return;
    }
    await wait(200);
  }
  const [a, b, s] = await Promise.all([frameOf(pageA), frameOf(pageB), frameOf(pageSpec)]);
  process.stdout.write(`spectator still catching up; recording anyway: live=${Math.min(a, b)} spec=${s} lag=${Math.min(a, b) - s}f\n`);
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  process.stdout.write(`target=${TARGET} broker=${BROKER}\n`);

  let exitCode = 0;
  try {
    const session = randomBytes(4).toString('hex');
    const peerEnc = encodeURIComponent(BROKER);
    const peerWatchUrl = `${BROKER}/?s=${session}&r=peerwatch`;
    const peerWatchEnc = encodeURIComponent(peerWatchUrl);
    const urlA = `${TARGET}/?peer=${peerEnc}&session=${session}&slot=0`;
    const urlB = `${TARGET}/?peer=${peerEnc}&session=${session}&slot=1`;
    const urlSpec = `${TARGET}/?spectate=${session}&peer=${peerWatchEnc}`;
    const frameDir = resolve(OUT_DIR, `prod-duel-watch-frames-${session}`);
    let captureStats: { frames: number; elapsedMs: number } | null = null;
    process.stdout.write(`session: ${session}\n`);

    const browser: Browser = await chromium.launch({
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });
    try {
      // Service workers blocked everywhere so a fresh chromium doesn't get
      // pulled into the controllerchange → reload artefact. Use mesh/no
      // postFX for proof footage: real 3D entities without CRT capture cost.
      const lightVisual = JSON.stringify({ asteroid: 'mesh', ship: 'mesh', bullet: 'mesh', particle: 'mesh', theme: 'none', asciiCols: 80, bitDepth: 8, bitColour: false });
      const ctxA = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
      const ctxB = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: 'block' });
      const ctxSpec = await browser.newContext({
        viewport: VIEWPORT,
        serviceWorkers: 'block',
      });
      await ctxA.addInitScript((v) => { try { localStorage.setItem('pallasite:visualStyle', v); } catch { /* ignore */ } }, lightVisual);
      await ctxB.addInitScript((v) => { try { localStorage.setItem('pallasite:visualStyle', v); } catch { /* ignore */ } }, lightVisual);
      await ctxSpec.addInitScript((v) => { try { localStorage.setItem('pallasite:visualStyle', v); } catch { /* ignore */ } }, lightVisual);

      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      const pageSpec = await ctxSpec.newPage();

      const errPipe = (tag: string) => (e: Error): void => process.stderr.write(`[${tag} pageerror] ${e.message}\n`);
      pageA.on('pageerror', errPipe('A'));
      pageB.on('pageerror', errPipe('B'));
      pageSpec.on('pageerror', errPipe('Spec'));

      // Spectator joins FIRST so the broker's peerwatch fan-out captures
      // frame 0 onwards.
      await pageSpec.goto(urlSpec, { waitUntil: 'load' });
      // The spectator can briefly show the lockstep waiting overlay while it
      // catches up. Hide that chrome in the recording so the MP4 shows the
      // actual shared arena underneath.
      await pageSpec.addStyleTag({ content: '#peer-stall-overlay{display:none!important}' });
      process.stdout.write('spectator loaded; waiting on partners…\n');
      await Promise.all([
        pageA.goto(urlA, { waitUntil: 'load' }),
        pageB.goto(urlB, { waitUntil: 'load' }),
      ]);
      process.stdout.write('player pages loaded; waiting for phase=playing on all three...\n');
      await Promise.all([
        warmProofAssets(pageSpec, 'spec'),
        warmProofAssets(pageA, 'A'),
        warmProofAssets(pageB, 'B'),
      ]);

      const waitPlaying = (page: Page, label: string): Promise<void> => page.waitForFunction(
        () => (window as unknown as { __pallasiteState?: { phase: string } }).__pallasiteState?.phase === 'playing',
        undefined,
        { timeout: REACH_PLAYING_TIMEOUT_MS },
      ).then(() => process.stdout.write(`  ${label} reached playing\n`));
      await Promise.all([waitPlaying(pageA, 'A'), waitPlaying(pageB, 'B'), waitPlaying(pageSpec, 'spec')]);
      await pageSpec.waitForFunction(() => {
        return !!(window as unknown as { __pallasiteRenderProbe?: () => { webglOverlayReady?: boolean } }).__pallasiteRenderProbe?.().webglOverlayReady;
      }, undefined, { timeout: 10_000 }).catch(() => process.stdout.write('warning: spectator WebGL overlay did not report ready before recording\n'));
      await waitForSpectatorCaughtUp(pageA, pageB, pageSpec);
      await pageSpec.bringToFront();
      process.stdout.write(`letting mesh textures settle for ${ASSET_WARMUP_MS}ms...\n`);
      await wait(ASSET_WARMUP_MS);
      process.stdout.write(`recording ${PLAY_DURATION_MS}ms of AI-driven gameplay...\n`);

      const recordPromise = recordCanvasFrames(pageSpec, frameDir, PLAY_DURATION_MS);
      const aPromise = aiPilot(pageA, PLAY_DURATION_MS, 'ArrowLeft', 720, 420).catch((e) => process.stderr.write(`[pilotA] ${e}\n`));
      const bPromise = aiPilot(pageB, PLAY_DURATION_MS, 'ArrowRight', 640, 360).catch((e) => process.stderr.write(`[pilotB] ${e}\n`));
      captureStats = await recordPromise;
      await Promise.all([aPromise, bPromise]);
      process.stdout.write(`captured ${captureStats.frames} frames in ${(captureStats.elapsedMs / 1000).toFixed(2)}s\n`);
      await wait(800);

      // State dump for verification before closing.
      const dumpState = async (page: Page, tag: string): Promise<void> => {
        try {
          const s = await page.evaluate(() => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const g: any = (window as any).__pallasiteState;
            if (!g) return null;
            return {
              phase: g.phase, frame: g.frame, playerCount: g.players.length,
              players: g.players.map((pl: { ship: { alive: boolean; pos: { x: number; y: number }; rot: number } }) => ({
                alive: pl.ship.alive, x: Math.round(pl.ship.pos.x), y: Math.round(pl.ship.pos.y), rot: Number(pl.ship.rot.toFixed(2)),
              })),
            };
          });
          process.stdout.write(`[state ${tag}] ${JSON.stringify(s)}\n`);
        } catch (e) { process.stderr.write(`[state ${tag}] probe failed: ${String(e)}\n`); }
      };
      await dumpState(pageA, 'A');
      await dumpState(pageB, 'B');
      await dumpState(pageSpec, 'Spec');

      await ctxSpec.close();
      await ctxA.close();
      await ctxB.close();
    } finally {
      await browser.close();
    }

    if (!captureStats || !existsSync(resolve(frameDir, 'frame-0000.jpg')) || !existsSync(resolve(frameDir, `frame-${String(captureStats.frames - 1).padStart(4, '0')}.jpg`))) {
      process.stderr.write('frame capture failed — missing expected image sequence\n');
      exitCode = 1;
    } else {
      const inputPattern = resolve(frameDir, 'frame-%04d.jpg');
      process.stdout.write(`transcoding ${captureStats.frames} frames from ${frameDir} -> ${FINAL_MP4}\n`);
      const ff = spawnSync('ffmpeg', [
        '-y',
        '-framerate', String(RECORD_FPS),
        '-i', inputPattern,
        '-vf', 'scale=in_range=pc:out_range=tv,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'slow',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart',
        '-an',
        FINAL_MP4,
      ], { stdio: 'inherit' });
      if (ff.status !== 0) {
        process.stderr.write(`ffmpeg failed with status ${ff.status}\n`);
        exitCode = 1;
      } else if (existsSync(FINAL_MP4)) {
        process.stdout.write(`\nrecording saved: ${FINAL_MP4}\n`);
      }
    }
  } catch (e) {
    process.stderr.write(`record error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
