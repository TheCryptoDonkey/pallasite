/**
 * Off-main-thread WebSocket worker for the duel peer transport.
 *
 * Background: when the main thread is saturated with render work (postFX +
 * WebGL on every rAF), Chrome can starve the WebSocket event handler so
 * `frame` messages queue for hundreds of ms. The lockstep loop times out
 * waiting for the partner's input log to catch up and the partner appears
 * frozen even though the broker forwarded every byte. Putting the socket
 * in a Worker isolates recv from main-thread jank: the worker parses each
 * message immediately and posts a compact payload to main. Main still has
 * to drain those postMessages but they're light (no JSON parse, no socket
 * I/O) so a starved main catches up faster than it would itself.
 *
 * Protocol: see `PeerWorkerInbound` / `PeerWorkerOutbound`. This file is
 * loaded by Vite as a module worker via `new Worker(new URL('./peer-worker.js',
 * import.meta.url), { type: 'module' })` from peer.ts.
 */

/// <reference lib="webworker" />

import type { PeerSlot, PeerMsgIn, PeerMsgOut, WireTraceEntry } from './peer.js';

// ── Wire protocol between main thread and this worker ────────────────────────

/** Messages main thread → worker. */
export type PeerWorkerInbound =
  | { kind: 'connect'; url: string; session: string; localSlot: PeerSlot; enableWireTrace: boolean }
  | { kind: 'disconnect' }
  | { kind: 'send-frame'; frame: number; input: number }
  | { kind: 'send-hash'; frame: number; hash: number };

/** Messages worker → main thread. */
export type PeerWorkerOutbound =
  | { kind: 'connected' }
  | { kind: 'reconnected' }
  | { kind: 'connect-failed'; error: string }
  | { kind: 'peer-left' }
  | { kind: 'session-error'; code: string }
  | { kind: 'frame'; frame: number; slot: PeerSlot; input: number }
  | { kind: 'hash'; frame: number; slot: PeerSlot; hash: number }
  | { kind: 'wire-entry'; entry: WireTraceEntry }
  | { kind: 'counters'; bufferedAmount: number; readyState: number; wsRecvFrameCount: number; wsSentFrameCount: number };

// ── Worker-side WebSocket state ──────────────────────────────────────────────

const RECONNECT_BACKOFF_MS = [250, 500, 1000];
const RECONNECT_MAX_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

let ws: WebSocket | null = null;
let url = '';
let session = '';
let localSlot: PeerSlot = 0;
let enableWireTrace = false;
let connected = false;
let partnerConnected = false;
let initialConnectDone = false;
let deliberateClose = false;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
// Ground-truth recv/send counts measured INSIDE the worker (i.e., before
// any postMessage hop to main). Compared against main-side recv counts in
// getWireCounters() to see if worker→main delivery is the bottleneck.
let wsRecvFrameCount = 0;
let wsSentFrameCount = 0;

const ctx = self as unknown as DedicatedWorkerGlobalScope;

// One-time boot signal so a test driver can count how many fresh worker
// instances came up during a session — repeated re-instantiation is a
// sign the connect promise is rejecting and main is retrying, which
// would look like "broker→worker dropped frames" externally.
// eslint-disable-next-line no-console
console.log('[peer-worker] boot');

function post(m: PeerWorkerOutbound): void {
  ctx.postMessage(m);
}

function trace(entry: WireTraceEntry): void {
  if (!enableWireTrace) return;
  post({ kind: 'wire-entry', entry });
}

function buildSocketUrl(): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}s=${encodeURIComponent(session)}&r=peer&slot=${localSlot}`;
}

function openSocket(): void {
  try {
    ws = new WebSocket(buildSocketUrl());
  } catch (e) {
    if (!initialConnectDone) {
      post({ kind: 'connect-failed', error: e instanceof Error ? e.message : String(e) });
      initialConnectDone = true;
    } else {
      scheduleReconnect();
    }
    return;
  }
  ws.addEventListener('open', onOpen);
  ws.addEventListener('message', onMessage);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);
}

function onOpen(): void {
  const hello: PeerMsgOut = { type: 'hello-peer', session, slot: localSlot, version: 1 };
  if (ws) ws.send(JSON.stringify(hello));
  connected = true;
  // eslint-disable-next-line no-console
  console.log('[peer-worker] ws open, hello sent slot=' + localSlot);
  // We do not post 'connected' here — main waits for partner-joined.
}

let onMessageFireCount = 0;
function onMessage(ev: MessageEvent): void {
  onMessageFireCount++;
  // Log first few messages and every 30th. Tells us whether onMessage is
  // even firing for the frames broker logs as forwarded.
  // eslint-disable-next-line no-console
  if (onMessageFireCount <= 3 || onMessageFireCount % 30 === 0) {
    const preview = typeof ev.data === 'string' ? ev.data.slice(0, 80) : `[${typeof ev.data}]`;
    // eslint-disable-next-line no-console
    console.log(`[peer-worker] onMessage #${onMessageFireCount} dataType=${typeof ev.data} preview=${preview}`);
  }
  let msg: PeerMsgIn;
  try {
    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as PeerMsgIn;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log(`[peer-worker] onMessage parse failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  switch (msg.type) {
    case 'frame':
      wsRecvFrameCount++;
      // First-frame log: confirms broker→worker actually delivers data.
      // Quiet after that so we don't flood the console at 60Hz.
      // eslint-disable-next-line no-console
      if (wsRecvFrameCount === 1) console.log('[peer-worker] first frame recv slot=' + msg.slot);
      // eslint-disable-next-line no-console
      if (wsRecvFrameCount === 30) console.log('[peer-worker] 30 frames recv');
      post({ kind: 'frame', frame: msg.frame, slot: msg.slot, input: msg.input });
      trace({ t: performance.now(), dir: 'in', kind: 'frame', frame: msg.frame, slot: msg.slot, input: msg.input });
      return;
    case 'hash':
      post({ kind: 'hash', frame: msg.frame, slot: msg.slot, hash: msg.hash });
      trace({ t: performance.now(), dir: 'in', kind: 'hash', frame: msg.frame, slot: msg.slot, hash: msg.hash });
      return;
    case 'peer-joined': {
      const wasReconnecting = !initialConnectDone ? false : !partnerConnected;
      partnerConnected = true;
      if (!initialConnectDone) {
        initialConnectDone = true;
        // eslint-disable-next-line no-console
        console.log('[peer-worker] peer-joined; posting connected to main slot=' + localSlot);
        post({ kind: 'connected' });
      } else if (wasReconnecting) {
        reconnectAttempt = 0;
        post({ kind: 'reconnected' });
      }
      return;
    }
    case 'peer-left':
      partnerConnected = false;
      post({ kind: 'peer-left' });
      return;
    case 'session-error':
      post({ kind: 'session-error', code: msg.code });
      cleanupSocket();
      return;
  }
}

function onClose(): void {
  const wasConnecting = !initialConnectDone;
  const wasFullyConnected = connected && partnerConnected;
  // eslint-disable-next-line no-console
  console.log(`[peer-worker] ws close (wasConnecting=${wasConnecting} wasFullyConnected=${wasFullyConnected} deliberate=${deliberateClose}) slot=` + localSlot);
  connected = false;
  partnerConnected = false;
  if (wasConnecting) {
    post({ kind: 'connect-failed', error: 'socket closed before partner joined' });
    initialConnectDone = true;
    return;
  }
  if (!deliberateClose && wasFullyConnected) scheduleReconnect();
}

function onError(): void {
  if (!initialConnectDone) {
    post({ kind: 'connect-failed', error: 'socket error' });
    initialConnectDone = true;
  }
}

function scheduleReconnect(): void {
  if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) return;
  const delay = RECONNECT_BACKOFF_MS[reconnectAttempt];
  reconnectAttempt++;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (deliberateClose) return;
    openSocket();
  }, delay);
}

function cleanupSocket(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ws) {
    ws.removeEventListener('open', onOpen);
    ws.removeEventListener('message', onMessage);
    ws.removeEventListener('close', onClose);
    ws.removeEventListener('error', onError);
    try { ws.close(); } catch { /* socket may already be closing */ }
    ws = null;
  }
  connected = false;
  partnerConnected = false;
}

// Periodic counters snapshot for diagnostics. Cheap; main caches the latest.
const COUNTERS_INTERVAL_MS = 250;
setInterval(() => {
  post({
    kind: 'counters',
    bufferedAmount: ws ? ws.bufferedAmount : -1,
    readyState: ws ? ws.readyState : -1,
    wsRecvFrameCount,
    wsSentFrameCount,
  });
}, COUNTERS_INTERVAL_MS);

ctx.addEventListener('message', (ev: MessageEvent<PeerWorkerInbound>) => {
  const msg = ev.data;
  switch (msg.kind) {
    case 'connect':
      url = msg.url;
      session = msg.session;
      localSlot = msg.localSlot;
      enableWireTrace = msg.enableWireTrace;
      deliberateClose = false;
      initialConnectDone = false;
      reconnectAttempt = 0;
      openSocket();
      return;
    case 'disconnect':
      deliberateClose = true;
      if (ws && connected) {
        const bye: PeerMsgOut = { type: 'bye', slot: localSlot };
        try { ws.send(JSON.stringify(bye)); } catch { /* socket may already be closed */ }
      }
      cleanupSocket();
      return;
    case 'send-frame': {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const out: PeerMsgOut = { type: 'frame', frame: msg.frame, slot: localSlot, input: msg.input };
      ws.send(JSON.stringify(out));
      wsSentFrameCount++;
      trace({ t: performance.now(), dir: 'out', kind: 'frame', frame: msg.frame, slot: localSlot, input: msg.input, bufferedAmount: ws.bufferedAmount });
      return;
    }
    case 'send-hash': {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const out: PeerMsgOut = { type: 'hash', frame: msg.frame, slot: localSlot, hash: msg.hash };
      ws.send(JSON.stringify(out));
      trace({ t: performance.now(), dir: 'out', kind: 'hash', frame: msg.frame, slot: localSlot, hash: msg.hash, bufferedAmount: ws.bufferedAmount });
      return;
    }
  }
});
