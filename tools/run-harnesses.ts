/**
 * Headless runner for the determinism / lockstep / peer harnesses.
 *
 * Each harness is a self-contained HTML page that runs its sim in the page
 * and sets document.title to `{NAME}-PASS`, `{NAME}-FAIL`, or `{NAME}-ERROR`
 * when done. We spin up Vite's dev server, drive headless Chromium through
 * Playwright at each harness URL, wait for the title to change from its
 * initial human-readable value, and exit 0 only if every verdict ends in
 * `-PASS`.
 *
 * Run with `pnpm test`. First-time setup needs Chromium installed:
 *   pnpm exec playwright install chromium
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser } from 'playwright';

const PORT = 5180;
const BASE = `http://localhost:${PORT}`;

interface Harness {
  name: string;
  path: string;
  initialTitle: string;
}

const HARNESSES: Harness[] = [
  { name: 'determinism', path: '/determinism-harness.html', initialTitle: 'determinism harness' },
  { name: 'lockstep',    path: '/lockstep-harness.html',    initialTitle: 'lockstep harness' },
  { name: 'peer',        path: '/peer-harness.html',        initialTitle: 'peer harness' },
  { name: 'regression',  path: '/regression-harness.html',  initialTitle: 'regression harness' },
];

const VITE_READY_TIMEOUT_MS = 30_000;
const HARNESS_TIMEOUT_MS = 60_000;

async function startVite(): Promise<ChildProcess> {
  // detached: true puts the child in its own process group so a SIGTERM to
  // -pid catches both pnpm and its child vite. Otherwise vite zombies survive
  // the runner and tie up port 5180 on the next run.
  const vite = spawn('pnpm', ['run', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  vite.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString();
    if (s.trim()) process.stderr.write(`[vite] ${s}`);
  });
  return vite;
}

function killViteGroup(p: ChildProcess): void {
  if (p.killed || p.pid === undefined) return;
  try { process.kill(-p.pid, 'SIGTERM'); }
  catch { try { p.kill('SIGTERM'); } catch { /* already dead */ } }
}

async function waitForServer(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await wait(200);
  }
  throw new Error(`Server at ${url} not ready in ${timeoutMs}ms: ${String(lastErr)}`);
}

interface Result {
  name: string;
  verdict: string;
  detail: string;
  wallMs: number;
}

async function runOne(browser: Browser, h: Harness): Promise<Result> {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') pageErrors.push(`console.error: ${msg.text()}`);
  });

  const t0 = Date.now();
  await page.goto(`${BASE}${h.path}`, { waitUntil: 'load' });

  let verdict = '';
  let detail = '';
  try {
    await page.waitForFunction(
      (initial) => document.title !== initial,
      h.initialTitle,
      { timeout: HARNESS_TIMEOUT_MS },
    );
    verdict = await page.title();
    detail = (await page.locator('#out').textContent()) ?? '';
  } catch (e) {
    verdict = `${h.name.toUpperCase()}-TIMEOUT`;
    detail = `Harness did not produce a verdict within ${HARNESS_TIMEOUT_MS}ms.\n` +
      (pageErrors.length > 0 ? `Page errors:\n  ${pageErrors.join('\n  ')}` : '(no page errors captured)');
  }
  const wallMs = Date.now() - t0;
  await page.close();

  if (pageErrors.length > 0 && !verdict.endsWith('-PASS')) {
    detail += `\n\nPage errors:\n  ${pageErrors.join('\n  ')}`;
  }
  return { name: h.name, verdict, detail, wallMs };
}

async function main(): Promise<void> {
  process.stdout.write('Starting Vite dev server on :' + PORT + '...\n');
  const vite = await startVite();
  let exitCode = 0;
  const results: Result[] = [];

  const killVite = () => killViteGroup(vite);
  process.on('SIGINT', () => { killVite(); process.exit(130); });
  process.on('SIGTERM', () => { killVite(); process.exit(143); });

  try {
    await waitForServer(BASE + '/', VITE_READY_TIMEOUT_MS);
    process.stdout.write('Vite ready.\n');

    process.stdout.write('Launching headless Chromium...\n');
    const browser = await chromium.launch();
    try {
      for (const h of HARNESSES) {
        process.stdout.write(`\n=== ${h.name} ===\n`);
        const r = await runOne(browser, h);
        results.push(r);
        process.stdout.write(r.detail.trimEnd() + '\n');
        process.stdout.write(`(verdict: ${r.verdict}, ${r.wallMs}ms wall)\n`);
        if (!r.verdict.endsWith('-PASS')) exitCode = 1;
      }
    } finally {
      await browser.close();
    }
  } finally {
    killVite();
  }

  process.stdout.write('\n=== summary ===\n');
  for (const r of results) {
    const tag = r.verdict.endsWith('-PASS') ? '[PASS]' : '[FAIL]';
    process.stdout.write(`${tag} ${r.name.padEnd(12)} ${r.verdict}\n`);
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
