/** Real worker lifecycle and signed MessagePort handoff, using private local peers. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { SOLO_SCORE_OUTBOX_KEY } from '../src/solo-score-outbox.js';

const root = resolve('dist');
let workerGate = Promise.resolve();
let workerRevision = '';
const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url!, 'http://fixture').pathname;
    if (request.method !== 'GET' || path.startsWith('/api/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"ok":false}');
      return;
    }
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(root + '/')) throw new Error('Outside fixture root');
    if (path === '/sw.js') await workerGate;
    let body: Buffer | string = await readFile(file);
    if (path === '/sw.js' && workerRevision) body = body.toString().replace(/const SW_VERSION = '[^']+';/, `const SW_VERSION = '${workerRevision}';`);
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('No fixture address');
const gameOrigin = `http://127.0.0.1:${address.port}`;
const arcadeOrigin = 'https://arcade.600.wtf';
const privateKey = schnorr.utils.randomSecretKey();
const pubkey = bytesToHex(schnorr.getPublicKey(privateKey));
const createdAt = Math.floor(Date.now() / 1000);
const tags = [['origin', arcadeOrigin], ['app', '600 Billion Arcade']];
const digest = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, createdAt, 21236, tags, ''])));
const event = { id: bytesToHex(digest), pubkey, sig: bytesToHex(schnorr.sign(digest, privateKey)), kind: 21236, created_at: createdAt, tags, content: '' };
const payload = { v: 1, game: 'pallasite', target: gameOrigin, channel: 'private-arcade-fixture-channel', canSign: true, profile: { name: 'Arcade fixture' }, event };
const launchUrl = (path: string) => `${gameOrigin}${path}#gamestr-auth=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
let currentPage: Page | null = null;
async function isolated(path = '/?p1=1', viewport = { width: 1180, height: 820 }): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => new URL(route.request().url()).origin === gameOrigin && route.request().method() === 'GET' ? route.continue() : route.abort());
  await context.routeWebSocket(/wss:\/\//, socket => socket.close());
  await context.route('**/music/**', route => route.abort());
  await context.addInitScript(() => {
    (window as any).__fixtureDocument = crypto.randomUUID();
    (window as any).__fixturePortCloses = 0;
    const bridgePorts = new WeakSet<MessagePort>();
    const start = MessagePort.prototype.start, close = MessagePort.prototype.close;
    MessagePort.prototype.start = function () {
      this.addEventListener('message', e => { if (e.data?.protocol === 'gamestr-auth-v1' && e.data.type === 'connected') bridgePorts.add(this); });
      return start.call(this);
    };
    MessagePort.prototype.close = function () {
      if (bridgePorts.has(this)) (window as any).__fixturePortCloses++;
      return close.call(this);
    };
  });
  await context.route(`${arcadeOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<button id="play">Play</button><script>
    let child;
    document.querySelector('#play').onclick=()=>child=window.open(${JSON.stringify(launchUrl(path))},'_blank');
    addEventListener('message',e=>{
      if(e.origin!==${JSON.stringify(gameOrigin)}||e.source!==child||e.data?.protocol!=='gamestr-auth-v1'||e.data.channel!==${JSON.stringify(payload.channel)})return;
      const port=e.ports[0];port.start();port.postMessage({protocol:'gamestr-auth-v1',type:'connected'});
      port.onmessage=async m=>{
        if(m.data?.protocol!=='gamestr-auth-v1'||m.data.type!=='sign')return;
        try{
          if(typeof window.__fixtureSign!=='function')throw Error('fixture-signing-unavailable');
          const event=await window.__fixtureSign(m.data.event);
          port.postMessage({protocol:'gamestr-auth-v1',type:'result',id:m.data.id,ok:true,event});
        }catch{
          port.postMessage({protocol:'gamestr-auth-v1',type:'result',id:m.data.id,ok:false,error:'fixture-signing-unavailable'});
        }
      };
    });</script>` }));
  return context;
}
async function launch(context: BrowserContext) {
  const parent = await context.newPage();
  await parent.goto(`${arcadeOrigin}/fixture`);
  const popup = context.waitForEvent('page');
  await parent.locator('#play').click();
  const game = await popup;
  currentPage = game;
  await game.waitForFunction(key => (globalThis as any).__signetSignerInfo?.pubkey === key, pubkey);
  assert.equal(await game.evaluate(() => location.hash), '');
  assert.equal(await game.evaluate(() => window.opener), null);
  return game;
}
try {
  const context = await isolated();
  let releaseWorker!: () => void;
  workerGate = new Promise<void>(done => { releaseWorker = done; });
  const game = await launch(context);
  const documentToken = await game.evaluate(() => (window as any).__fixtureDocument);
  releaseWorker();
  await game.waitForFunction(() => !!navigator.serviceWorker.controller);
  await game.waitForTimeout(500);
  assert.equal(await game.evaluate(() => (window as any).__fixtureDocument), documentToken);
  assert.equal(await game.evaluate(() => (globalThis as any).__signetSignerInfo.pubkey), pubkey);
  await game.getByRole('button', { name: '▶ TAP TO START', exact: true }).click();
  await game.getByRole('button', { name: /PLAYER 1\s*PRESS Ⓐ/ }).click();
  await game.getByRole('button', { name: '▶ START · SOLO', exact: true }).click();
  await game.getByRole('heading', { name: 'PLAYER 1 — CONTROLS', exact: true }).waitFor();
  assert(await game.locator('#ui-root').innerText().then(text => text.includes('Arcade fixture')));
  assert.equal(await game.getByRole('button', { name: /SIGN IN WITH NOSTR/ }).count(), 0);
  console.log('PASS first worker control preserves the signed launch and booth pilot');

  workerRevision = 'arcade-fixture-update';
  await game.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
  await game.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration())?.waiting);
  await game.getByRole('button', { name: 'RETURN TO ARCADE', exact: true }).waitFor();
  assert.equal(await game.evaluate(() => (window as any).__fixtureDocument), documentToken);
  assert.equal(await game.evaluate(() => (globalThis as any).__signetSignerInfo.pubkey), pubkey);
  console.log('PASS worker update waits for an explicit arcade relaunch');

  await game.getByRole('button', { name: /^CLASSIC/ }).click();
  await game.getByRole('button', { name: 'Skip intro', exact: true }).click();
  await game.waitForFunction(() => document.body.dataset.phase === 'playing');
  await game.keyboard.press('p');
  await game.getByRole('heading', { name: 'PAUSED', exact: true }).waitFor();
  await game.getByRole('button', { name: 'END RUN', exact: true }).click();
  await game.getByRole('button', { name: /PLAYER 1\s*PRESS Ⓐ/ }).click();
  await game.getByRole('button', { name: '▶ START · SOLO', exact: true }).click();
  await game.getByRole('heading', { name: 'PLAYER 1 — SIGN IN', exact: true }).waitFor();
  assert((await game.evaluate(() => (window as any).__fixturePortCloses)) > 0);
  console.log('PASS next booth visitor cannot inherit the launch account');
  await context.close();

  const couch = await isolated();
  const two = await launch(couch);
  await two.getByRole('button', { name: '▶ TAP TO START', exact: true }).click();
  await two.getByRole('button', { name: /PLAYER 1\s*PRESS Ⓐ/ }).click();
  await two.getByRole('button', { name: /PLAYER 2\s*PRESS Ⓐ/ }).click();
  await two.getByRole('button', { name: '▶ START · 2 PLAYERS', exact: true }).click();
  await two.getByRole('heading', { name: 'PLAYER 1 — CONTROLS', exact: true }).waitFor();
  await two.getByRole('button', { name: /^CLASSIC/ }).click();
  await two.getByRole('heading', { name: 'PLAYER 2 — SIGN IN', exact: true }).waitFor();
  console.log('PASS second pilot still requires a separate identity');
  await couch.close();

  const walkup = await isolated();
  const guest = await walkup.newPage();
  await guest.goto(`${gameOrigin}/?p1=1`);
  await guest.getByRole('button', { name: '▶ TAP TO START', exact: true }).click();
  await guest.getByRole('button', { name: /PLAYER 1\s*PRESS Ⓐ/ }).click();
  await guest.getByRole('button', { name: '▶ START · SOLO', exact: true }).click();
  await guest.getByRole('heading', { name: 'PLAYER 1 — SIGN IN', exact: true }).waitFor();
  console.log('PASS ordinary booth visitor still chooses their own identity');
  await walkup.close();

  const normal = await isolated('/');
  const menu = await launch(normal);
  const menuDocument = await menu.evaluate(() => (window as any).__fixtureDocument);
  await menu.waitForFunction(() => !!navigator.serviceWorker.controller);
  await menu.getByRole('button', { name: 'PLAY ▶', exact: true }).click();
  await menu.getByRole('button', { name: /^IGNITE/ }).waitFor();
  assert.equal(await menu.getByRole('button', { name: /SIGN IN WITH NOSTR/ }).count(), 0);
  assert.equal(await menu.evaluate(() => (globalThis as any).__signetSignerInfo.pubkey), pubkey);
  assert.equal(await menu.evaluate(() => (window as any).__fixtureDocument), menuDocument);
  console.log('PASS normal root launch keeps the arcade account through mission selection');
  await normal.close();

  // Seed public fixture receipts, not game state or real/public scores. Every
  // signature and HTTP response stays inside this isolated local regression.
  const recovery = await isolated('/', { width: 320, height: 568 });
  let signAttempts = 0, posts = 0;
  const scoreInput = { score: 125, wave: 2, duration_ms: 9000, run_id: '123456789', mode: 'campaign', player_name: 'Fixture pilot' };
  const other = 'b'.repeat(64);
  await recovery.exposeFunction('__fixtureSign', async (template: any) => {
    if (template.kind !== 27235 || !template.tags.some((t: string[]) => t[0] === 'u' && t[1] === `${gameOrigin}/api/score`)) throw new Error('Outside fixture score scope');
    if (++signAttempts === 1) throw new Error('Fixture user declined signing');
    const hash = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, template.created_at, template.kind, template.tags, template.content])));
    return { ...template, pubkey, id: bytesToHex(hash), sig: bytesToHex(schnorr.sign(hash, privateKey)) };
  });
  await recovery.addInitScript(({ origin, key, receipts }) => {
    if (location.origin === origin && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(receipts));
  }, { origin: gameOrigin, key: SOLO_SCORE_OUTBOX_KEY, receipts: [{ pubkey, input: scoreInput }, { pubkey: other, input: { ...scoreInput, run_id: '987654321' } }] });
  await recovery.route(`${gameOrigin}/api/score`, async route => {
    assert.equal(route.request().method(), 'POST');
    const body = route.request().postData()!;
    assert.deepEqual(JSON.parse(body), scoreInput);
    const auth = JSON.parse(Buffer.from(route.request().headers().authorization.slice(6), 'base64').toString());
    assert.equal(auth.pubkey, pubkey);
    const hash = sha256(new TextEncoder().encode(JSON.stringify([0, pubkey, auth.created_at, auth.kind, auth.tags, auth.content])));
    assert.equal(auth.id, bytesToHex(hash));
    assert(schnorr.verify(hexToBytes(auth.sig), hash, hexToBytes(pubkey)));
    assert(auth.tags.some((t: string[]) => t[0] === 'payload' && t[1] === bytesToHex(sha256(new TextEncoder().encode(body)))));
    posts++;
    await route.fulfill({ json: { ok: true, id: 'e'.repeat(64), published: { ok: 1, total: 1 } } });
  });
  const failedScore = await launch(recovery);
  await failedScore.getByRole('button', { name: 'RETRY SCORE', exact: true }).focus();
  await failedScore.keyboard.press('Enter');
  await failedScore.waitForFunction(() => document.getElementById('pal-score-recovery')?.textContent?.includes('WAITING TO PUBLISH'));
  assert.equal(signAttempts, 1);
  assert.equal(posts, 0);
  assert.equal(await failedScore.evaluate(key => JSON.parse(localStorage.getItem(key)!).length, SOLO_SCORE_OUTBOX_KEY), 2);
  assert(await failedScore.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const reconnectBox = await failedScore.getByRole('button', { name: 'RECONNECT IN ARCADE', exact: true }).boundingBox();
  assert(reconnectBox && reconnectBox.height >= 44);
  await failedScore.getByRole('button', { name: 'RECONNECT IN ARCADE', exact: true }).focus();
  await failedScore.keyboard.press('Enter');
  await failedScore.waitForURL(`${arcadeOrigin}/game/pallasite`);
  const relaunched = recovery.waitForEvent('page');
  await failedScore.locator('#play').click();
  const retriedScore = await relaunched;
  await retriedScore.waitForFunction(key => (globalThis as any).__signetSignerInfo?.pubkey === key, pubkey);
  await retriedScore.getByRole('button', { name: 'RETRY SCORE', exact: true }).click();
  await retriedScore.locator('#pal-score-recovery').waitFor({ state: 'detached' });
  assert.equal(signAttempts, 2);
  assert.equal(posts, 1);
  const remaining = await retriedScore.evaluate(key => JSON.parse(localStorage.getItem(key)!), SOLO_SCORE_OUTBOX_KEY);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].pubkey, other);
  console.log('PASS declined score survives arcade reconnection and retries under the same account without guest fallback');
  await recovery.close();

  const removal = await isolated('/', { width: 320, height: 568 });
  await removal.addInitScript(({ origin, key, receipts }) => {
    if (location.origin === origin && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(receipts));
  }, { origin: gameOrigin, key: SOLO_SCORE_OUTBOX_KEY, receipts: [
    { pubkey, input: { ...scoreInput, finished_at: 1791700009 }, lastError: 'invalid_score', rejected: true },
    { pubkey, input: { ...scoreInput, score: 126, run_id: '123456790' } },
    { pubkey: other, input: { ...scoreInput, score: 127, run_id: '987654321' } },
  ] });
  const review = await launch(removal);
  await review.getByText('Score rejected: invalid score. Your saved run is retained.', { exact: true }).waitFor();
  const controls = review.getByRole('button', { name: 'REMOVE SAVED SCORE', exact: true });
  assert.equal(await controls.count(), 2);
  const target = await controls.first().boundingBox();
  assert(target && target.height >= 44);
  assert(await review.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await controls.first().focus();
  const cancel = review.waitForEvent('dialog').then(dialog => { assert(dialog.message().includes('125 points')); return dialog.dismiss(); });
  await review.keyboard.press('Enter'); await cancel;
  assert.equal(await review.evaluate(key => JSON.parse(localStorage.getItem(key)!).length, SOLO_SCORE_OUTBOX_KEY), 3);
  const confirm = review.waitForEvent('dialog').then(dialog => dialog.accept());
  await review.keyboard.press('Enter'); await confirm;
  await review.waitForFunction(() => document.querySelectorAll('#pal-score-recovery button').length === 3);
  const retained = await review.evaluate(key => JSON.parse(localStorage.getItem(key)!), SOLO_SCORE_OUTBOX_KEY);
  assert.deepEqual(retained.map((r: any) => r.input.run_id), ['123456790', '987654321']);
  assert.equal(retained[1].pubkey, other);
  const returned = await launch(removal);
  await returned.getByRole('button', { name: 'REMOVE SAVED SCORE', exact: true }).waitFor();
  assert.equal(await returned.getByRole('button', { name: 'REMOVE SAVED SCORE', exact: true }).count(), 1);
  assert(!await returned.locator('#pal-score-recovery').textContent().then(text => text?.includes('127 points')));
  console.log('PASS keyboard cancellation and confirmed selected removal preserve other runs/accounts across relaunch at 320px');
  await removal.close();
} catch (error) {
  if (currentPage && !currentPage.isClosed()) {
    const state = await currentPage.evaluate(() => ({ phase: document.body.dataset.phase, text: document.getElementById('ui-root')?.textContent?.slice(0, 2500) })).catch(() => null);
    await writeFile('/tmp/pallasite-arcade-handoff-failure.json', JSON.stringify({ error: String(error), state }, null, 2));
    await currentPage.screenshot({ path: '/tmp/pallasite-arcade-handoff-failure.png' }).catch(() => undefined);
  }
  throw error;
} finally {
  await browser.close();
  await new Promise<void>(done => server.close(() => done()));
}
