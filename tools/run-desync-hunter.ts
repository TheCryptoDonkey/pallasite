/**
 * Find the EXACT frame and field where a 2P duel first desyncs.
 *
 * Runs a duel with spectator, plays scripted input, then pulls each
 * peer's canary state history (enabled by the `?desync-hunt=1` URL
 * param wired into src/main.ts). Walks all three histories frame by
 * frame, identifies the first canary frame where any two peers'
 * serialised state differs, and pretty-prints the diff so the
 * mismatched field is obvious at a glance.
 *
 * The serialised state at each canary frame is what feeds into the
 * canary hash — same field set, same encoding, so what diffs here is
 * exactly what would have made the canary fire if the partner's hash
 * had been on the wire.
 *
 * Run with `pnpm run hunt:desync`. Single-purpose: it stops at the
 * first divergence rather than reporting later cascades.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5180;
const BROKER_PORT = 8788;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const BROKER_READY_TIMEOUT_MS = 10_000;
const REACH_PLAYING_TIMEOUT_MS = 25_000;
const PLAY_DURATION_MS = 16_000;

async function startVite(): Promise<ChildProcess> {
  const vite = spawn('pnpm', ['exec', 'vite', '--force'], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  vite.stderr?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[vite] ${s}`); });
  return vite;
}
async function startBroker(): Promise<ChildProcess> {
  const broker = spawn('node', ['controller-ws/server.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(BROKER_PORT), HOST: '127.0.0.1' },
    detached: true,
  });
  broker.stderr?.on('data', (chunk: Buffer) => { const s = chunk.toString(); if (s.trim()) process.stderr.write(`[broker] ${s}`); });
  return broker;
}
function killGroup(p: ChildProcess): void {
  if (p.killed || p.pid === undefined) return;
  try { process.kill(-p.pid, 'SIGTERM'); }
  catch { try { p.kill('SIGTERM'); } catch { /* already dead */ } }
}
async function waitForHttp(url: string, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.status < 500) return; } catch { /* not up yet */ }
    await wait(150);
  }
  throw new Error(`${label} not ready at ${url}`);
}

/** Tap a key for `ms` then release. Same shape as the duel recorder. */
async function tap(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await wait(ms);
  await page.keyboard.up(key);
}
async function pilotA(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tap(page, 'ArrowLeft', 250);
    await tap(page, 'Space', 60); await wait(140);
    await tap(page, 'Space', 60); await wait(140);
    await tap(page, 'ArrowUp', 100); await wait(180);
  }
}
async function pilotB(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await tap(page, 'ArrowRight', 240);
    await tap(page, 'Space', 60); await wait(160);
    await tap(page, 'Space', 60); await wait(160);
    await tap(page, 'ArrowUp', 90); await wait(200);
  }
}

/** Pull the canary history off a page. Each entry is { frame, state }
 *  where state is the JSON serialisation that feeds the canary hash. */
async function pullHistory(page: Page): Promise<Map<number, string>> {
  const raw = await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const h = (window as any).__pallasiteCanaryHistory as Map<number, string> | undefined;
    if (!h) return [];
    return Array.from(h.entries()).sort((a, b) => a[0] - b[0]);
  }) as [number, string][];
  return new Map(raw);
}

/** Tokenise a serialised state into a flat map of dot-path → value so
 *  we can pinpoint which field changed. */
function flatten(obj: unknown, prefix = ''): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (obj === null || typeof obj !== 'object') {
    out.set(prefix, obj);
    return out;
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => {
      const child = flatten(v, `${prefix}[${i}]`);
      for (const [k, val] of child) out.set(k, val);
    });
    return out;
  }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const child = flatten(v, prefix ? `${prefix}.${k}` : k);
    for (const [kk, val] of child) out.set(kk, val);
  }
  return out;
}

/** Diff two flat maps. Returns an array of differing keys with both values. */
function diffFlat(a: Map<string, unknown>, b: Map<string, unknown>): Array<{ key: string; a: unknown; b: unknown }> {
  const keys = new Set([...a.keys(), ...b.keys()]);
  const out: Array<{ key: string; a: unknown; b: unknown }> = [];
  for (const k of keys) {
    const va = a.get(k);
    const vb = b.get(k);
    if (JSON.stringify(va) !== JSON.stringify(vb)) out.push({ key: k, a: va, b: vb });
  }
  return out;
}

async function main(): Promise<void> {
  process.stdout.write('Starting Vite + broker...\n');
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

    const session = randomBytes(4).toString('hex');
    const peerEnc = encodeURIComponent(BROKER_URL);
    const peerWatchEnc = encodeURIComponent(`${BROKER_URL}/?s=${session}&r=peerwatch`);
    // ?desync-hunt=1 enables the canary state history in each peer; wiretrace
    // captures each WS send/receive so we can see what the wire actually
    // delivered (vs. what the inputLog ended up with after all writes).
    const urlA = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=0&desync-hunt=1&wiretrace=1`;
    const urlB = `${VITE_BASE}/?peer=${peerEnc}&session=${session}&slot=1&desync-hunt=1&wiretrace=1`;
    const urlSpec = `${VITE_BASE}/?spectate=${session}&peer=${peerWatchEnc}&desync-hunt=1`;
    process.stdout.write(`session: ${session}\n`);

    const browser: Browser = await chromium.launch();
    try {
      const ctxS = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const ctxA = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const ctxB = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const pageS = await ctxS.newPage();
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();
      // Spectator first so the broker peerwatch fan-out picks up frame 0.
      await pageS.goto(urlSpec, { waitUntil: 'load' });
      await Promise.all([pageA.goto(urlA, { waitUntil: 'load' }), pageB.goto(urlB, { waitUntil: 'load' })]);

      const waitPlaying = (page: Page, tag: string): Promise<void> => page.waitForFunction(
        () => (window as unknown as { __pallasiteState?: { phase: string } }).__pallasiteState?.phase === 'playing',
        undefined,
        { timeout: REACH_PLAYING_TIMEOUT_MS },
      ).then(() => process.stdout.write(`  ${tag} playing\n`));
      await Promise.all([waitPlaying(pageA, 'A'), waitPlaying(pageB, 'B'), waitPlaying(pageS, 'S')]);

      // All three reached `playing`, but the spectator's lockstep may not
      // have started ADVANCING yet (broker fan-out race: if a peer's frame
      // 0 arrives before peerwatch attach completes, the spectator is
      // stuck at frame 0 forever). Wait until all three are past frame 60
      // — by which point the live arena is producing fan-out and any
      // catch-up the spectator needs has had a chance to happen. Bail
      // loudly if it doesn't.
      const waitAdvanced = (page: Page, tag: string): Promise<void> => page.waitForFunction(
        () => ((window as unknown as { __pallasiteState?: { frame: number } }).__pallasiteState?.frame ?? 0) > 60,
        undefined,
        { timeout: 10_000 },
      ).then(() => process.stdout.write(`  ${tag} advancing\n`));
      try {
        await Promise.all([waitAdvanced(pageA, 'A'), waitAdvanced(pageB, 'B'), waitAdvanced(pageS, 'S')]);
      } catch (e) {
        process.stdout.write(`startup-stall: at least one peer did not advance past frame 60 — likely peerwatch attach race or pilot input not flowing\n`);
        throw e;
      }

      process.stdout.write('driving pilots…\n');
      const a = pilotA(pageA).catch(() => { /* end of test sometimes closes pages */ });
      const b = pilotB(pageB).catch(() => { /* same */ });
      await Promise.race([Promise.all([a, b]), wait(PLAY_DURATION_MS)]);
      await wait(400);

      process.stdout.write('pulling histories…\n');
      const histA = await pullHistory(pageA);
      const histB = await pullHistory(pageB);
      const histS = await pullHistory(pageS);
      process.stdout.write(`history sizes: A=${histA.size} B=${histB.size} S=${histS.size}\n`);

      const frames = Array.from(new Set([...histA.keys(), ...histB.keys(), ...histS.keys()])).sort((p, q) => p - q);
      let firstDivergence: { frame: number; pair: string; diffs: Array<{ key: string; a: unknown; b: unknown }> } | null = null;
      for (const f of frames) {
        const sA = histA.get(f);
        const sB = histB.get(f);
        const sS = histS.get(f);
        // Compare pairwise where both sides have a state at this frame.
        const pairs: Array<['A', 'B', string | undefined, string | undefined] | ['A', 'S', string | undefined, string | undefined] | ['B', 'S', string | undefined, string | undefined]> = [
          ['A', 'B', sA, sB],
          ['A', 'S', sA, sS],
          ['B', 'S', sB, sS],
        ];
        for (const [p, q, sp, sq] of pairs) {
          if (sp === undefined || sq === undefined) continue;
          if (sp === sq) continue;
          // Found a divergence. Flatten and diff to find which field.
          const flA = flatten(JSON.parse(sp));
          const flB = flatten(JSON.parse(sq));
          const diffs = diffFlat(flA, flB);
          firstDivergence = { frame: f, pair: `${p}↔${q}`, diffs };
          break;
        }
        if (firstDivergence) break;
      }

      if (firstDivergence === null) {
        process.stdout.write('\nNo desync detected — all canary frames match across all three peers.\n');
      } else {
        process.stdout.write(`\n=== FIRST DIVERGENCE ===\n`);
        process.stdout.write(`frame: ${firstDivergence.frame}\n`);
        process.stdout.write(`pair:  ${firstDivergence.pair}\n`);
        process.stdout.write(`differing fields (${firstDivergence.diffs.length}):\n`);
        for (const d of firstDivergence.diffs.slice(0, 30)) {
          process.stdout.write(`  ${d.key}\n    L=${JSON.stringify(d.a)}\n    R=${JSON.stringify(d.b)}\n`);
        }
        if (firstDivergence.diffs.length > 30) {
          process.stdout.write(`  … and ${firstDivergence.diffs.length - 30} more\n`);
        }
        // Dump the inputLog around the divergence frame on all 3 peers
        // so we can see what each peer ACTUALLY received via the wire
        // for each slot. Apply-frame at state.frame=F reads inputLog[F-5].
        const from = Math.max(0, firstDivergence.frame - 10);
        const to = firstDivergence.frame + 2;
        process.stdout.write(`\n=== inputLog frames ${from}..${to} (per peer) ===\n`);
        for (const [tag, p] of [['A', pageA], ['B', pageB], ['S', pageS]] as const) {
          const log = await p.evaluate((args: { from: number; to: number }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fn = (window as any).__pallasiteInputLogProbe;
            return typeof fn === 'function' ? fn(args.from, args.to) : null;
          }, { from, to });
          process.stdout.write(`  [${tag}] ${JSON.stringify(log)}\n`);
        }

        // Dump the wire-trace entries (out/in) for frames near the
        // divergence on A and B. Spectator doesn't have wiretrace.
        process.stdout.write(`\n=== wire trace frames ${from}..${to} (A and B) ===\n`);
        for (const [tag, p] of [['A', pageA], ['B', pageB]] as const) {
          const trace = await p.evaluate((args: { from: number; to: number }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ref: any = (window as any).__pallasiteTestHooks?.peerRef;
            if (!ref || typeof ref.getWireTrace !== 'function') return null;
            return ref.getWireTrace().filter((e: { frame?: number; kind: string }) =>
              e.kind === 'frame' && e.frame !== undefined && e.frame >= args.from && e.frame <= args.to,
            );
          }, { from, to });
          process.stdout.write(`  [${tag}] ${JSON.stringify(trace)}\n`);
        }
      }
    } finally {
      await browser.close();
    }
  } catch (e) {
    process.stderr.write(`hunter error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
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
