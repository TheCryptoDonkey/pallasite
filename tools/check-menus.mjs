/** Responsive menu acceptance, including nested scrolling and unavailable web fonts. */
import { webkit, chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

const base = 'http://127.0.0.1:5194';
const out = 'tools/record-out/presentation';
const server = spawn('pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', '5194', '--strictPort'], {
  stdio: 'pipe', detached: true,
});
await mkdir(out, { recursive: true });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) { ready = true; break; } } catch { /* boot */ }
    await wait(100);
  }
  assert.ok(ready, 'menu test server started');
  const results = [];
  for (const [name, width, height, engine] of [
    ['small', 320, 568, chromium], ['portrait', 375, 678, webkit],
    ['landscape', 812, 303, webkit], ['ipad', 1024, 1366, webkit], ['desktop', 1440, 900, chromium],
  ]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width, height }, hasTouch: name !== 'desktop',
        isMobile: name !== 'desktop', serviceWorkers: 'block',
      });
      await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
      await context.routeWebSocket(/.*/, socket => socket.close());
      const page = await context.newPage();
      await page.goto(base + '/?menu=1');
      // Reproduce the physical iPhone landscape notch and home-indicator margins.
      if (name === 'landscape') await page.addStyleTag({ content: '.overlay {padding-left:53px;padding-right:53px;padding-bottom:36px}' });
      await page.waitForFunction(() => !!window.__pallasiteState);
      async function audit(stage) {
        const result = await page.evaluate(() => {
          const overlay = document.querySelector('.overlay');
          const bad = [...overlay.querySelectorAll('button,input,select')]
            .filter(element => element.getClientRects().length)
            .filter(element => { const r = element.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; })
            .map(element => element.textContent.slice(0, 50));
          return { bad, scrollWidth: overlay.scrollWidth, width: overlay.clientWidth };
        });
        assert.deepEqual(result.bad, [], `${name} ${stage} controls fit horizontally`);
        assert.ok(result.scrollWidth <= result.width + 1, `${name} ${stage} overlay overflows ${JSON.stringify(result)}`);
        await page.screenshot({ path: `${out}/menu-${name}-${stage}.png` });
        results.push({ name, stage, ...result });
      }
      await page.locator('.title-logo').evaluate(element => element.decode());
      const initial = await page.evaluate(() => {
        const button = [...document.querySelectorAll('button')].find(element => element.textContent.startsWith('PLAY'));
        const logo = document.querySelector('.title-logo').getBoundingClientRect();
        const utilities = document.querySelector('.attract-utilities').getBoundingClientRect();
        return { play: button.getBoundingClientRect().bottom, viewport: innerHeight, clear: logo.top >= utilities.bottom };
      });
      assert.ok(initial.play <= initial.viewport && initial.clear, `${name} title ${JSON.stringify(initial)}`);
      await audit('attract');
      await page.getByRole('button', { name: /^PLAY/ }).click();
      await audit('auth');
      await page.getByRole('button', { name: /PLAY AS GUEST/ }).click();
      await audit('name');
      // Exercise longest name without creating or publishing an identity.
      await page.getByRole('button', { name: 'W', exact: true }).click({ clickCount: 25 });
      await audit('long-name');
      await page.evaluate(async () => {
        const mod = await import('/src/ui.ts');
        const state = window.__pallasiteState;
        state.session = { pubkey: '0'.repeat(64), displayName: 'LOCAL QA', method: 'guest', signer: { capabilities: { canSignEvents: false } } };
        mod.renderTitle(state);
      });
      await audit('mission');
      if (name === 'landscape') {
        const start = await page.getByRole('button', { name: /IGNITE/ }).boundingBox();
        assert.ok(start.y + start.height <= height, 'landscape mission start is visible without scrolling');
      }
      await page.getByRole('button', { name: 'CAMPAIGN', exact: true }).click();
      await page.getByRole('button', { name: /IGNITE/ }).scrollIntoViewIfNeeded();
      await audit('ignite');
      await page.getByRole('button', { name: 'SETTINGS', exact: true }).click();
      await audit('settings');
      await page.locator('.overlay button').last().scrollIntoViewIfNeeded();
      const last = await page.locator('.overlay button').last().boundingBox();
      assert.ok(last.y >= 0 && last.y + last.height <= height, 'last settings action is reachable');
      await audit('settings-bottom');
      console.log(name + ' menus PASS');
    } finally { await browser.close(); }
  }
  await writeFile(`${out}/menu-results.json`, JSON.stringify(results, null, 2));
} finally {
  if (server.pid) { try { process.kill(-server.pid, 'SIGTERM'); } catch { /* exited */ } }
}
