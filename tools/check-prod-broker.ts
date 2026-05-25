/**
 * Read-only probe of the production broker at controller.pallasite.app.
 * Verifies the frame-replay feature is live (the spectator late-join fix
 * landed in joystick → deployed to the Hetzner box).
 *
 * Mechanic:
 *   1. Open a peer socket (slot 0), hello-peer, send a few frames.
 *   2. Open a SECOND peer socket (slot 1), hello-peer.
 *   3. Open a peerwatch socket AFTER both peers paired.
 *   4. Assert the peerwatch receives the previously-sent frames as
 *      replay (peer-joined messages first, then the buffered frames).
 *
 * Uses a random session id so it never collides with real users.
 * Closes all sockets cleanly when done. Read-only in the sense that no
 * persistent state is written — broker drops the session on disconnect.
 *
 * Run via `pnpm exec tsx tools/check-prod-broker.ts`.
 */

import { randomBytes } from 'node:crypto';
// Node ≥ 22 ships WebSocket as a global; no `ws` dependency needed.

const BROKER = process.env.BROKER ?? 'wss://controller.pallasite.app';
const SESSION = `probe-${randomBytes(4).toString('hex')}`;
const TIMEOUT_MS = 5_000;

interface Sock {
  ws: WebSocket;
  inbox: string[];
  /** Block until the next message OR a timeout. */
  next(ms?: number): Promise<string>;
  close(): void;
}

function open(path: string): Promise<Sock> {
  return new Promise((resolve, reject) => {
    const url = `${BROKER}${path}`;
    const ws = new WebSocket(url);
    const inbox: string[] = [];
    const waiters: Array<{ resolve: (s: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
    ws.addEventListener('message', (ev: MessageEvent) => {
      const s = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      const w = waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(s);
      } else {
        inbox.push(s);
      }
    });
    ws.addEventListener('open', () => resolve({
      ws,
      inbox,
      next(ms = TIMEOUT_MS): Promise<string> {
        const buffered = inbox.shift();
        if (buffered !== undefined) return Promise.resolve(buffered);
        return new Promise<string>((res, rej) => {
          const timer = setTimeout(() => rej(new Error(`timeout waiting on ${path}`)), ms);
          waiters.push({ resolve: res, reject: rej, timer });
        });
      },
      close(): void { try { ws.close(); } catch { /* ignore */ } },
    }));
    ws.addEventListener('error', () => reject(new Error(`socket error opening ${path}`)));
    ws.addEventListener('close', () => {
      for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error(`socket closed waiting on ${path}`)); }
    });
  });
}

interface Check { name: string; pass: boolean; detail: string; }
const checks: Check[] = [];
const pass = (name: string, detail = ''): void => { checks.push({ name, pass: true, detail }); };
const fail = (name: string, detail = ''): void => { checks.push({ name, pass: false, detail }); };

async function main(): Promise<void> {
  process.stdout.write(`probe target: ${BROKER}  session: ${SESSION}\n`);

  let p0: Sock | null = null;
  let p1: Sock | null = null;
  let w: Sock | null = null;
  try {
    p0 = await open(`/?s=${SESSION}&r=peer`);
    p0.ws.send(JSON.stringify({ type: 'hello-peer', session: SESSION, slot: 0, version: 1 }));

    p1 = await open(`/?s=${SESSION}&r=peer`);
    p1.ws.send(JSON.stringify({ type: 'hello-peer', session: SESSION, slot: 1, version: 1 }));

    // Drain peer-joined notifications on both peers so we know the pair is bound.
    const p0Notif = JSON.parse(await p0.next()) as { type: string; slot: number };
    const p1Notif = JSON.parse(await p1.next()) as { type: string; slot: number };
    if (p0Notif.type !== 'peer-joined' || p1Notif.type !== 'peer-joined') {
      fail('peers paired', `p0 saw ${p0Notif.type}, p1 saw ${p1Notif.type}`);
      return;
    }
    pass('peers paired', 'both peers got peer-joined');

    // p0 sends some frames that the buffer should retain.
    for (let f = 0; f < 5; f++) {
      p0.ws.send(JSON.stringify({ type: 'frame', frame: f, slot: 0, input: f }));
      // p1 will receive these as live forwards — drain so its inbox stays small.
      await p1.next(1000).catch(() => null);
    }

    // Now attach a peerwatch AFTER the frames have been sent.
    w = await open(`/?s=${SESSION}&r=peerwatch`);
    const ready = JSON.parse(await w.next()) as { type: string };
    if (ready.type !== 'peerwatch-ready') {
      fail('peerwatch ready', `got ${ready.type}`);
      return;
    }
    pass('peerwatch ready', '');
    // peer-joined for both slots (order not guaranteed).
    const j1 = JSON.parse(await w.next()) as { type: string; slot: number };
    const j2 = JSON.parse(await w.next()) as { type: string; slot: number };
    const seenSlots = new Set([j1.slot, j2.slot].filter((s) => s !== undefined));
    if (j1.type !== 'peer-joined' || j2.type !== 'peer-joined' || seenSlots.size !== 2) {
      fail('peerwatch sees both slots', `${j1.type}@${j1.slot} ${j2.type}@${j2.slot}`);
      return;
    }
    pass('peerwatch sees both slots', '');

    // Now the moment of truth — buffered frames should arrive in order.
    const replayed: Array<{ frame: number; input: number }> = [];
    for (let i = 0; i < 5; i++) {
      try {
        const msg = JSON.parse(await w.next(2_000)) as { type: string; frame: number; slot: number; input: number };
        if (msg.type === 'frame' && msg.slot === 0) {
          replayed.push({ frame: msg.frame, input: msg.input });
        }
      } catch { break; }
    }
    if (replayed.length === 5 && replayed.every((m, i) => m.frame === i && m.input === i)) {
      pass('frame replay live', `received ${replayed.length} buffered frames in order`);
    } else {
      fail('frame replay live', `received ${replayed.length} frames: ${JSON.stringify(replayed)}`);
    }
  } catch (e) {
    fail('probe ran', e instanceof Error ? e.message : String(e));
  } finally {
    p0?.close();
    p1?.close();
    w?.close();
  }

  process.stdout.write('\n=== production broker probe ===\n');
  let failed = 0;
  for (const c of checks) {
    process.stdout.write(`${c.pass ? '[PASS]' : '[FAIL]'} ${c.name.padEnd(32)} ${c.detail}\n`);
    if (!c.pass) failed++;
  }
  if (failed > 0) {
    process.stdout.write('\nfix has NOT propagated to production yet — joystick deploy likely pending.\n');
    process.exit(1);
  } else {
    process.stdout.write('\nfix is live on production.\n');
    process.exit(0);
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
