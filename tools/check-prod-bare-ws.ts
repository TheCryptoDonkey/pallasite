/**
 * Bare-bones WS receive count test. Two browser contexts open WS
 * directly to the broker (NOT loading the pallasite bundle, just a
 * minimal HTML page). One sends frames at sustained rate, the other
 * counts how many arrive. If broker forwards N and browser receives
 * <N, the loss is in chromium's WebSocket layer.
 *
 * Run via `pnpm exec tsx tools/check-prod-bare-ws.ts`.
 */

import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const BROKER = process.env.BROKER ?? 'wss://controller.pallasite.app';
const DURATION_MS = 5_000;

const minimalHTML = `<!doctype html>
<html><head><title>bare ws</title></head><body>
<pre id="log"></pre>
<script>
  const log = document.getElementById('log');
  window.__counts = { sent: 0, recv: 0, errors: 0 };
  window.__openWs = function(session, slot) {
    const ws = new WebSocket('${BROKER}/?s=' + session + '&r=peer');
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello-peer', session, slot, version: 1 }));
      log.textContent += 'open slot=' + slot + '\\n';
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'frame') {
          window.__counts.recv++;
          window.__lastRecvFrame = msg.frame;
        } else if (msg.type === 'peer-joined') {
          window.__partnerJoined = true;
        }
      } catch (e) { window.__counts.errors++; }
    };
    ws.onerror = () => { window.__counts.errors++; log.textContent += 'error\\n'; };
    ws.onclose = (e) => { log.textContent += 'close code=' + e.code + '\\n'; };
    window.__ws = ws;
    window.__send = function(frame, slotArg) {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'frame', frame, slot: slotArg, input: 0 }));
      window.__counts.sent++;
    };
  };
</script>
</body></html>`;

async function main(): Promise<void> {
  const session = `bare-${randomBytes(4).toString('hex')}`;
  process.stdout.write(`session: ${session}\n`);
  const browser = await chromium.launch();
  try {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    await pageA.setContent(minimalHTML);
    await pageB.setContent(minimalHTML);

    // Open both peers, wait for both to be partner-joined.
    await pageA.evaluate(([s, sl]) => (window as { __openWs: (s: string, sl: number) => void }).__openWs(s, sl), [session, 0]);
    await pageB.evaluate(([s, sl]) => (window as { __openWs: (s: string, sl: number) => void }).__openWs(s, sl), [session, 1]);
    await pageA.waitForFunction(() => (window as { __partnerJoined?: boolean }).__partnerJoined === true, undefined, { timeout: 10_000 });
    await pageB.waitForFunction(() => (window as { __partnerJoined?: boolean }).__partnerJoined === true, undefined, { timeout: 10_000 });
    process.stdout.write(`paired\n`);

    // Drive sustained frames from BOTH peers.
    const start = Date.now();
    const driver = async (page: import('playwright').Page, slot: 0 | 1): Promise<void> => {
      let f = 0;
      while (Date.now() - start < DURATION_MS) {
        await page.evaluate(([frame, sl]) => (window as { __send: (f: number, s: number) => void }).__send(frame, sl), [f, slot]);
        f++;
        await new Promise((r) => setTimeout(r, 17));
      }
    };
    await Promise.all([driver(pageA, 0), driver(pageB, 1)]);
    await new Promise((r) => setTimeout(r, 500));

    interface Counts { sent: number; recv: number; errors: number; }
    const countsA = await pageA.evaluate(() => (window as { __counts: Counts }).__counts);
    const countsB = await pageB.evaluate(() => (window as { __counts: Counts }).__counts);
    process.stdout.write(`A sent ${countsA.sent} recv ${countsA.recv} errors ${countsA.errors}\n`);
    process.stdout.write(`B sent ${countsB.sent} recv ${countsB.recv} errors ${countsB.errors}\n`);
    process.stdout.write(`A recv vs B sent: ${countsA.recv}/${countsB.sent} = ${(countsA.recv / countsB.sent * 100).toFixed(1)}%\n`);
    process.stdout.write(`B recv vs A sent: ${countsB.recv}/${countsA.sent} = ${(countsB.recv / countsA.sent * 100).toFixed(1)}%\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
