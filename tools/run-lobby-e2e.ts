/**
 * Headless end-to-end test of the duel lobby (`/duel` route).
 *
 * Spins up vite + the controller-ws broker, opens the lobby in a single
 * headless Chromium page, and verifies:
 *
 *  - the lobby renders the host panel with WAITING FOR OPPONENT badge
 *  - the session id is shown and matches the peer URL
 *  - a peer slot 1 connecting to the broker flips the badge to CONNECTED
 *  - peer slot 1 disconnecting flips the badge back to WAITING
 *  - the spectate link is broadcastable (a peerwatch socket connects and
 *    sees peer-joined for any bound slots)
 *  - JOIN tab swaps in the input + scan buttons without leaking the host
 *    panel's peerwatch socket
 *  - `/duel?deathmatch=1` opens directly into a 4P human deathmatch lobby
 *  - READY with no joined deathmatch pilots starts a broker-backed AI-filled match
 *
 * Run with `pnpm run test:lobby`. Same single-process pattern as
 * run-e2e.ts so it composes into the existing `pnpm test` chain.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';

const VITE_PORT = 5180;
const BROKER_PORT = 8788;
const VITE_BASE = `http://localhost:${VITE_PORT}`;
const BROKER_URL = `ws://localhost:${BROKER_PORT}`;
const VITE_READY_TIMEOUT_MS = 30_000;
const BROKER_READY_TIMEOUT_MS = 10_000;
const LOBBY_RENDER_TIMEOUT_MS = 10_000;
const BADGE_FLIP_TIMEOUT_MS = 3_000;

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
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch (e) {
      lastErr = e;
    }
    await wait(150);
  }
  throw new Error(`${label} not ready at ${url} in ${timeoutMs}ms: ${String(lastErr)}`);
}

/** Read the session id the lobby generated. The page renders it inside a
 *  SPAN with the SESSION label nearby; we look for an 8-char alphanumeric
 *  span (the broker session id format from generateSessionId). */
async function readSessionId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const match = spans.find(s => s.textContent && /^[a-z0-9]{8}$/i.test(s.textContent.trim()));
    if (!match) throw new Error('lobby: no session id span found');
    return match.textContent!.trim().toLowerCase();
  });
}

/** Read the current partner-status text from the lobby badge. */
async function readBadgeText(page: Page): Promise<string> {
  return page.evaluate(() => {
    // The badge is the span whose text starts with WAITING or OPPONENT.
    const all = Array.from(document.querySelectorAll('span'));
    const match = all.find(s => {
      const t = s.textContent?.trim() ?? '';
      return t.startsWith('WAITING') || t.startsWith('OPPONENT');
    });
    return match?.textContent?.trim() ?? '<no badge>';
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

    const browser: Browser = await chromium.launch();
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      page.on('pageerror', (e: Error) => process.stderr.write(`[page] pageerror: ${e.message}\n`));
      page.on('console', (msg) => {
        if (msg.type() === 'error') process.stderr.write(`[page error] ${msg.text()}\n`);
      });

      await page.goto(`${VITE_BASE}/duel`, { waitUntil: 'load' });
      // Wait for the host panel to mount.
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('span')).some(s => (s.textContent ?? '').trim().startsWith('WAITING FOR OPPONENT')),
        undefined,
        { timeout: LOBBY_RENDER_TIMEOUT_MS },
      );

      const initialBadge = await readBadgeText(page);
      reportCheck(checks, 'initial badge WAITING', initialBadge.startsWith('WAITING'), `text="${initialBadge}"`);

      const session = await readSessionId(page);
      reportCheck(checks, 'session id rendered', /^[a-z0-9]{8}$/i.test(session), `session=${session}`);

      // ── While-you-wait widget: rotating tip + daily leader chip ─────
      // Both are filler for the host's "ok I clicked READY but my partner
      // hasn't joined yet" dead time. Tip rotates every 5s; we just
      // assert that ONE of the known tips is visible on first render.
      const tipKnown = await page.evaluate(() => {
        const known = [
          'You enter as slot 0',
          'Friendly fire is off',
          'No sats, no stakes',
          'Share the spectate link',
          'The run ends when both ships',
          'Hyperspace doubles',
          'EXACT same arena',
        ];
        const ps = Array.from(document.querySelectorAll('p'));
        return ps.some(p => {
          const t = (p.textContent ?? '').trim();
          return known.some(k => t.includes(k));
        });
      });
      reportCheck(checks, 'tip strip rendered', tipKnown, `seen=${tipKnown}`);

      const dailyChip = await page.evaluate(() => {
        const ps = Array.from(document.querySelectorAll('p'));
        const heading = ps.find(p => (p.textContent ?? '').trim().startsWith('DAILY '));
        return { headingText: heading?.textContent?.trim() ?? null };
      });
      reportCheck(checks, 'daily leader chip rendered', !!dailyChip.headingText, `heading=${dailyChip.headingText}`);

      // ── Simulate the opponent connecting to slot 1 via the broker ───
      const opponentWs = new WebSocket(`${BROKER_URL}/?s=${session}&r=peer&slot=1`);
      const opponentMsgs: string[] = [];
      opponentWs.addEventListener('message', (ev: MessageEvent) => {
        opponentMsgs.push(typeof ev.data === 'string' ? ev.data : '[binary]');
      });
      await new Promise<void>((resolve, reject) => {
        opponentWs.addEventListener('open', () => resolve());
        opponentWs.addEventListener('error', () => reject(new Error('opponent ws error')));
        setTimeout(() => reject(new Error('opponent ws open timeout')), 3000);
      });
      opponentWs.send(JSON.stringify({ type: 'hello-peer', session, slot: 1, version: 1 }));

      // Wait for the lobby's badge to flip.
      let flipped = false;
      try {
        await page.waitForFunction(
          () => {
            const all = Array.from(document.querySelectorAll('span'));
            return all.some(s => (s.textContent ?? '').trim().startsWith('OPPONENT CONNECTED'));
          },
          undefined,
          { timeout: BADGE_FLIP_TIMEOUT_MS },
        );
        flipped = true;
      } catch { /* recorded by the check below */ }
      const connectedBadge = await readBadgeText(page);
      reportCheck(checks, 'badge flips on slot 1 join', flipped, `text="${connectedBadge}"`);

      // ── Simulate the opponent disconnecting ─────────────────────────
      opponentWs.close();
      let reverted = false;
      try {
        await page.waitForFunction(
          () => {
            const all = Array.from(document.querySelectorAll('span'));
            return all.some(s => (s.textContent ?? '').trim().startsWith('WAITING FOR OPPONENT'));
          },
          undefined,
          { timeout: BADGE_FLIP_TIMEOUT_MS },
        );
        reverted = true;
      } catch { /* recorded below */ }
      const revertedBadge = await readBadgeText(page);
      reportCheck(checks, 'badge reverts on slot 1 leave', reverted, `text="${revertedBadge}"`);

      // ── Spectate link is broadcastable (peerwatch role works) ──────
      // Re-attach the opponent so the broker has a slot to report.
      const opp2 = new WebSocket(`${BROKER_URL}/?s=${session}&r=peer&slot=1`);
      await new Promise<void>((resolve, reject) => {
        opp2.addEventListener('open', () => resolve());
        opp2.addEventListener('error', () => reject(new Error('opp2 open')));
        setTimeout(() => reject(new Error('opp2 open timeout')), 3000);
      });
      opp2.send(JSON.stringify({ type: 'hello-peer', session, slot: 1, version: 1 }));

      const specWs = new WebSocket(`${BROKER_URL}/?s=${session}&r=peerwatch`);
      const specMsgs: string[] = [];
      specWs.addEventListener('message', (ev: MessageEvent) => {
        specMsgs.push(typeof ev.data === 'string' ? ev.data : '[binary]');
      });
      await new Promise<void>((resolve, reject) => {
        specWs.addEventListener('open', () => resolve());
        specWs.addEventListener('error', () => reject(new Error('spec open')));
        setTimeout(() => reject(new Error('spec open timeout')), 3000);
      });
      // Give the broker a tick to send peerwatch-ready + peer-joined.
      await wait(300);
      const sawReady = specMsgs.some(m => m.includes('peerwatch-ready'));
      const sawJoined = specMsgs.some(m => m.includes('"peer-joined"') && m.includes('"slot":1'));
      reportCheck(checks, 'spectate peerwatch-ready', sawReady, `messages=${JSON.stringify(specMsgs)}`);
      reportCheck(checks, 'spectate sees slot 1 bound', sawJoined, `messages=${JSON.stringify(specMsgs)}`);

      // ── JOIN tab swap doesn't break ────────────────────────────────
      await page.evaluate(() => {
        const join = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'JOIN');
        if (join) join.click();
      });
      await wait(300);
      const onJoin = await page.evaluate(() => {
        const input = document.querySelector('input[type="url"]') as HTMLInputElement | null;
        return !!input;
      });
      reportCheck(checks, 'JOIN tab renders invite input', onJoin, `input=${onJoin}`);

      // ── HOST tab regenerates fresh session + badge ─────────────────
      await page.evaluate(() => {
        const host = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'HOST');
        if (host) host.click();
      });
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('span')).some(s => (s.textContent ?? '').trim().startsWith('WAITING FOR OPPONENT')),
        undefined,
        { timeout: 3000 },
      );
      const session2 = await readSessionId(page);
      reportCheck(checks, 'HOST tab regenerates session', session2 !== session, `old=${session} new=${session2}`);

      // Clean up sockets.
      try { opp2.close(); } catch { /* ignore */ }
      try { specWs.close(); } catch { /* ignore */ }

      // ── Deathmatch route exposes real N-player human lobby ─────────
      const dmPage = await ctx.newPage();
      await dmPage.goto(`${VITE_BASE}/duel?deathmatch=1`, { waitUntil: 'load' });
      await dmPage.waitForFunction(
        () => document.body.innerText.includes('DEATHMATCH') && document.body.innerText.includes('WAITING FOR 3 PILOT'),
        undefined,
        { timeout: LOBBY_RENDER_TIMEOUT_MS },
      );
      const dm = await dmPage.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const text = document.body.innerText;
        return {
          heading: text.includes('DEATHMATCH'),
          waitingForPilots: text.includes('WAITING FOR 3 PILOT'),
          selected4p: buttons.some(b => b.textContent === '4P' && b.className === 'menu-btn'),
          slotLinks: ['P2', 'P3', 'P4'].every(label => buttons.some(b => b.textContent === label)),
          rules: text.includes('FFA'),
        };
      });
      reportCheck(checks, 'deathmatch lobby route', dm.heading && dm.waitingForPilots && dm.selected4p && dm.slotLinks && dm.rules, JSON.stringify(dm));
      await dmPage.evaluate(() => {
        const p3 = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'P3');
        if (!p3) throw new Error('P3 slot button not found');
        (p3 as HTMLButtonElement).click();
      });
      const dmQr = await dmPage.evaluate(() => {
        const qr = Array.from(document.querySelectorAll('canvas')).find((c) => c.dataset.slot !== undefined);
        const label = Array.from(document.querySelectorAll('p')).find((p) => (p.textContent ?? '').includes('QR ·'));
        return {
          slot: qr?.dataset.slot ?? null,
          title: qr?.title ?? null,
          label: label?.textContent ?? null,
        };
      });
      reportCheck(checks, 'deathmatch slot QR switches beyond P2', dmQr.slot === '2' && dmQr.title === 'P3 invite QR' && dmQr.label === 'QR · P3', JSON.stringify(dmQr));
      await dmPage.evaluate(() => {
        const ready = Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('START DEATHMATCH'));
        if (!ready) throw new Error('deathmatch READY button not found');
        ready.click();
      });
      await dmPage.waitForURL((url) => {
        return url.pathname === '/'
          && url.searchParams.get('mode') === 'deathmatch'
          && url.searchParams.get('deathmatchPlayers') === '4'
          && url.searchParams.get('aiFill') === '1'
          && url.searchParams.get('humanSlots') === '0'
          && url.searchParams.has('peer');
      }, { timeout: LOBBY_RENDER_TIMEOUT_MS });
      await dmPage.waitForFunction(
        () => {
          const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: Array<{ ai?: boolean }> } }).__pallasiteState;
          return !!s && (s.phase === 'playing' || s.phase === 'wavestart') && s.players?.length === 4;
        },
        undefined,
        { timeout: LOBBY_RENDER_TIMEOUT_MS },
      );
      const localDm = await dmPage.evaluate(() => {
        const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: Array<{ ai?: boolean }> } }).__pallasiteState;
        const params = new URLSearchParams(window.location.search);
        return {
          mode: params.get('mode'),
          aiFill: params.get('aiFill'),
          humanSlots: params.get('humanSlots'),
          peer: params.has('peer'),
          phase: s?.phase ?? null,
          players: s?.players?.length ?? 0,
          aiPlayers: s?.players?.filter(p => p.ai).length ?? 0,
        };
      });
      reportCheck(
        checks,
        'deathmatch READY fills empty slots with AI',
        localDm.mode === 'deathmatch' && localDm.aiFill === '1' && localDm.humanSlots === '0' && localDm.peer && localDm.players === 4 && localDm.aiPlayers === 3,
        JSON.stringify(localDm),
      );
      await dmPage.close();

      // Regression: after landing on a deathmatch URL, choosing CAMPAIGN
      // from the title screen must clear the live deathmatch route state.
      // Otherwise IGNITE still starts deathmatch because main.ts cached
      // the URL-derived mode at boot.
      const campaignPage = await ctx.newPage();
      await campaignPage.addInitScript(() => {
        localStorage.setItem('pallasite:mode', 'deathmatch');
        localStorage.setItem('pallasite:onboarded', '1');
      });
      await campaignPage.goto(`${VITE_BASE}/?mode=deathmatch&deathmatchPlayers=4&aiFill=1&deathmatchTime=300`, { waitUntil: 'load' });
      await campaignPage.evaluate(() => {
        const state = (window as unknown as { __pallasiteState?: { session?: unknown } }).__pallasiteState;
        if (!state) throw new Error('missing pallasite state');
        state.session = {
          pubkey: '0'.repeat(64),
          displayName: 'E2E',
          method: 'guest',
          signer: { capabilities: { canSignEvents: false } },
        };
      });
      await campaignPage.evaluate(() => {
        const play = Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('PLAY'));
        if (!play) throw new Error('PLAY button not found');
        play.click();
      });
      await campaignPage.waitForFunction(
        () => Array.from(document.querySelectorAll('button')).some(b => (b.textContent ?? '').trim() === 'CAMPAIGN'),
        undefined,
        { timeout: LOBBY_RENDER_TIMEOUT_MS },
      );
      await campaignPage.evaluate(() => {
        const campaign = Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').trim() === 'CAMPAIGN');
        if (!campaign) throw new Error('CAMPAIGN button not found');
        campaign.click();
      });
      await campaignPage.waitForFunction(
        () => Array.from(document.querySelectorAll('button')).some(b => (b.textContent ?? '').includes('IGNITE')),
        undefined,
        { timeout: LOBBY_RENDER_TIMEOUT_MS },
      );
      await campaignPage.evaluate(() => {
        const start = Array.from(document.querySelectorAll('button')).find(b => (b.textContent ?? '').includes('IGNITE'));
        if (!start) throw new Error('IGNITE button not found');
        start.click();
      });
      await campaignPage.waitForFunction(
        () => {
          const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: unknown[]; deathmatchRules?: unknown } }).__pallasiteState;
          return !!s && (s.phase === 'playing' || s.phase === 'wavestart') && s.players?.length === 1;
        },
        undefined,
        { timeout: LOBBY_RENDER_TIMEOUT_MS },
      );
      const campaignRun = await campaignPage.evaluate(() => {
        const s = (window as unknown as { __pallasiteState?: { phase?: string; players?: unknown[]; deathmatchRules?: unknown } }).__pallasiteState;
        const params = new URLSearchParams(window.location.search);
        return {
          storedMode: localStorage.getItem('pallasite:mode'),
          urlMode: params.get('mode'),
          deathmatchPlayers: params.get('deathmatchPlayers'),
          phase: s?.phase ?? null,
          players: s?.players?.length ?? 0,
          deathmatchRules: !!s?.deathmatchRules,
        };
      });
      reportCheck(
        checks,
        'campaign clears deathmatch URL state',
        campaignRun.storedMode === 'campaign' && campaignRun.urlMode === null && campaignRun.deathmatchPlayers === null && campaignRun.players === 1 && !campaignRun.deathmatchRules,
        JSON.stringify(campaignRun),
      );
      await campaignPage.close();
    } finally {
      await browser.close();
    }
  } catch (e) {
    process.stderr.write(`lobby-e2e error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    exitCode = 1;
  } finally {
    kill();
  }

  process.stdout.write('\n=== lobby checks ===\n');
  for (const c of checks) {
    const tag = c.ok ? '[PASS]' : '[FAIL]';
    process.stdout.write(`${tag} ${c.name.padEnd(36)} ${c.detail}\n`);
    if (!c.ok) exitCode = 1;
  }
  process.exit(exitCode);
}

main().catch((e) => {
  process.stderr.write(`runner error: ${e?.stack ?? e}\n`);
  process.exit(1);
});
