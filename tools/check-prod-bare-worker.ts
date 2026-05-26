/**
 * Isolation test: identical to check-prod-bare-ws.ts but the WebSocket
 * lives in a Worker, not the main thread. If THIS passes, my pallasite
 * peer-worker has a bug. If it ALSO drops messages, Workers + this
 * Caddy/broker pairing have a fundamental issue we haven't seen before.
 */

import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const BROKER = process.env.BROKER ?? 'wss://controller.pallasite.app';
const DURATION_MS = 5_000;

const workerSource = `
  let ws = null;
  let recv = 0;
  let partnerJoined = false;
  self.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.kind === 'open') {
      ws = new WebSocket('${BROKER}/?s=' + m.session + '&r=peer');
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'hello-peer', session: m.session, slot: m.slot, version: 1 }));
        self.postMessage({ kind: 'opened' });
      });
      ws.addEventListener('message', (e) => {
        recv++;
        if (recv === 1 || recv % 30 === 0) self.postMessage({ kind: 'log', text: 'worker recv #' + recv + ' preview=' + (typeof e.data === 'string' ? e.data.slice(0, 60) : '[bin]') });
        try {
          const parsed = JSON.parse(typeof e.data === 'string' ? e.data : '');
          if (parsed.type === 'peer-joined') {
            partnerJoined = true;
            self.postMessage({ kind: 'partner' });
          }
        } catch {}
      });
      ws.addEventListener('close', (e) => self.postMessage({ kind: 'log', text: 'ws close code=' + e.code }));
      ws.addEventListener('error', () => self.postMessage({ kind: 'log', text: 'ws error' }));
    } else if (m.kind === 'send') {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: 'frame', frame: m.frame, slot: m.slot, input: 0 }));
    } else if (m.kind === 'counts') {
      self.postMessage({ kind: 'counts', recv, partnerJoined });
    }
  });
`;

const minimalHTML = `<!doctype html>
<html><head><title>bare worker</title></head><body>
<pre id="log"></pre>
<script>
  const log = document.getElementById('log');
  const blob = new Blob([${JSON.stringify(workerSource)}], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  window.__w = new Worker(url);
  window.__w.onmessage = (ev) => {
    const m = ev.data;
    if (m.kind === 'log') log.textContent += '[worker] ' + m.text + '\\n';
    else if (m.kind === 'opened') { window.__opened = true; log.textContent += '[main] worker opened\\n'; }
    else if (m.kind === 'partner') { window.__partner = true; log.textContent += '[main] partner joined\\n'; }
    else if (m.kind === 'counts') window.__counts = { recv: m.recv, partnerJoined: m.partnerJoined };
  };
  window.__openWs = function(session, slot) { window.__w.postMessage({ kind: 'open', session, slot }); };
  window.__send = function(frame, slot) { window.__w.postMessage({ kind: 'send', frame, slot }); };
  window.__pollCounts = function() { window.__w.postMessage({ kind: 'counts' }); return new Promise(r => setTimeout(() => r(window.__counts), 50)); };
</script>
</body></html>`;

async function main(): Promise<void> {
  const session = `barew-${randomBytes(4).toString('hex')}`;
  process.stdout.write(`session: ${session}\n`);
  const browser = await chromium.launch();
  try {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    pageA.on('console', (m) => process.stderr.write(`[A/${m.type()}] ${m.text()}\n`));
    pageB.on('console', (m) => process.stderr.write(`[B/${m.type()}] ${m.text()}\n`));

    await pageA.setContent(minimalHTML);
    await pageB.setContent(minimalHTML);
    await pageA.evaluate(([s, sl]) => (window as { __openWs: (s: string, sl: number) => void }).__openWs(s, sl as number), [session, 0]);
    await pageB.evaluate(([s, sl]) => (window as { __openWs: (s: string, sl: number) => void }).__openWs(s, sl as number), [session, 1]);
    await pageA.waitForFunction(() => (window as { __partner?: boolean }).__partner === true, undefined, { timeout: 10_000 });
    await pageB.waitForFunction(() => (window as { __partner?: boolean }).__partner === true, undefined, { timeout: 10_000 });
    process.stdout.write(`paired\n`);

    const start = Date.now();
    const driver = async (page: import('playwright').Page, slot: 0 | 1): Promise<void> => {
      let f = 0;
      while (Date.now() - start < DURATION_MS) {
        await page.evaluate(([frame, sl]) => (window as { __send: (f: number, s: number) => void }).__send(frame as number, sl as number), [f, slot]);
        f++;
        await new Promise((r) => setTimeout(r, 17));
      }
    };
    await Promise.all([driver(pageA, 0), driver(pageB, 1)]);
    await new Promise((r) => setTimeout(r, 500));

    interface Counts { recv: number; partnerJoined: boolean; }
    const cA = await pageA.evaluate(async () => (window as { __pollCounts: () => Promise<Counts> }).__pollCounts());
    const cB = await pageB.evaluate(async () => (window as { __pollCounts: () => Promise<Counts> }).__pollCounts());
    process.stdout.write(`A recv=${cA.recv} partnerJoined=${cA.partnerJoined}\n`);
    process.stdout.write(`B recv=${cB.recv} partnerJoined=${cB.partnerJoined}\n`);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
