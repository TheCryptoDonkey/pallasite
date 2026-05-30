/**
 * Pallasite controller WebSocket relay.
 *
 * Pairs phone controllers with big-screen game hosts by sessionId.
 * Once both sides connect, messages from either are forwarded to the
 * other verbatim. No signing, no event semantics, no per-message
 * validation, the sessionId in the QR code IS the auth (32-bit
 * random, exists for the brief pairing window only).
 *
 * Wire:
 *   wss://controller.pallasite.app/?s=<sessionId>&r=<host|phone>          single-player
 *   wss://controller.pallasite.app/?s=<sessionId>&r=host&multi=1          multi-player host
 *   wss://controller.pallasite.app/?s=<sessionId>&r=phone                 phone in either mode
 *   wss://controller.pallasite.app/?s=<sessionId>&r=peer                  shared-arena multiplayer
 *   wss://controller.pallasite.app/?s=<sessionId>&r=peerwatch             spectate a peer session
 *
 * Multi-player mode (host opts in via multi=1):
 *   - Up to MAX_PHONES_PER_SESSION (8 by default) phones may pair.
 *   - Each phone is assigned a player slot (0..MAX-1) on connect.
 *   - Broker sends the phone a welcome frame: {type:'welcome', p:<slot>}.
 *   - Phone-to-host JSON frames get p:<slot> injected by the broker.
 *   - Host-to-phone JSON frames may include p:<slot> to address one
 *     player; omit p to broadcast to all paired phones.
 *   - peer-up / peer-down to the host carry p:<slot>.
 *
 * Single-player mode (default, backwards compat with Pallasite):
 *   - One host, one phone. New phone connection replaces the old.
 *   - peer-up / peer-down without p.
 *   - No frame mutation.
 *
 * Peer mode (shared-arena N-player lockstep, asteroid-sats M3):
 *   - 2..64 clients per session, each one a full game runtime.
 *   - Connect with r=peer; slot is NOT chosen by the URL.
 *   - Each client sends `{type:'hello-peer', session, slot, version:1, players}`
 *     as the first frame. Add `binaryFrames:true` to opt in to the compact
 *     binary frame/hash hot path once all required peers support it.
 *   - A duplicate slot replaces the older socket for the same slot; an
 *     out-of-range slot gets `{type:'session-error', code:'invalid-slot'}`.
 *   - When a peer binds, every other peer gets
 *     `{type:'peer-joined', slot:<joined>}`; the new peer gets one for
 *     every already-bound slot.
 *   - `{type:'frame'|'frames'|'hash', ...}` or the negotiated binary
 *     equivalents from one peer are fanned to every OTHER peer (never
 *     echoed back). `frames` is a consecutive input window:
 *     `{type:'frames', slot, base, inputs}`. Every such message is ALSO
 *     fanned out to every peerwatch socket on the session (see below).
 *   - On socket close, the surviving peers get
 *     `{type:'peer-left', slot:<departed>, reason}`.
 *   - Backpressure: if the receiving socket's send buffer exceeds
 *     PEER_BACKPRESSURE_BYTES, the forward is dropped and a counter
 *     bumps. Live lockstep tolerates frame loss; the desync canary will
 *     surface any divergence.
 *
 * Peerwatch mode (spectate a peer session, asteroid-sats M5):
 *   - Subscribe-only role. Watchers receive every frame/hash that
 *     either peer sends, plus peer-joined / peer-left notifications,
 *     but anything they send is silently dropped.
 *   - Add `binaryFrames=1` to the peerwatch URL to receive compact binary
 *     frame/hash payloads when the peer session has negotiated them. Legacy
 *     watchers get JSON downgraded by the broker.
 *   - Any number of watchers per session; orphan-sweep keeps the
 *     session alive while watchers OR peers are connected.
 *   - On connect, broker immediately sends `{type:'peerwatch-ready', players}`
 *     plus `{type:'peer-joined', slot:<n>}` for each peer slot already
 *     bound. The watcher uses this to know whether to await the
 *     pair-up or start spectating straight away.
 *   - Same backpressure rule as peer fan-out: drop forwards when the
 *     watcher's send buffer is over PEER_BACKPRESSURE_BYTES.
 *
 * Listens on 127.0.0.1:8788 by default. Caddy reverse-proxies the public
 * subdomain. Run under systemd; restart on crash. No state persistence,
 * a server restart drops every paired session.
 */

import { WebSocketServer } from 'ws';
import http from 'node:http';
import { performance } from 'node:perf_hooks';

const PORT = parseInt(process.env.PORT ?? '8788', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

/** Hard cap so a leaky client can't blow up memory. */
const MAX_SESSIONS = 4096;
/** A session that never gets its second peer is orphaned. Drop after
 *  5 minutes so QR codes that were never scanned don't leak the slot. */
const ORPHAN_TIMEOUT_MS = 5 * 60 * 1000;
/** Per multi-mode session, max number of phones that can pair. */
const MAX_PHONES_PER_SESSION = parseInt(process.env.MAX_PHONES ?? '8', 10);
/** Per peer-mode session, drop a forwarded message if the receiver's send
 *  buffer is above this. Lockstep payloads are ~50 bytes; this only fires
 *  on a stuck or much-slower peer. */
const PEER_BACKPRESSURE_BYTES = parseInt(process.env.PEER_BACKPRESSURE_BYTES ?? '65536', 10);
/** Optional deterministic forward delay for local soak tests. Production
 *  leaves both at zero, so the relay still forwards immediately. */
const PEER_FORWARD_DELAY_MS = Math.max(0, parseInt(process.env.PEER_FORWARD_DELAY_MS ?? '0', 10) || 0);
const PEER_FORWARD_JITTER_MS = Math.max(0, parseInt(process.env.PEER_FORWARD_JITTER_MS ?? '0', 10) || 0);
/** Per peer-mode session, how many recent `frame` messages per player to buffer
 *  for replay to late-joining peerwatchers. Each message is ~50 bytes;
 *  the default covers ~25s of history for any configured session size.
 *  slots. The whole window must include frame 0 — a spectator that
 *  joins after the buffer has wrapped loses the lockstep prefix and
 *  its sim never advances past PEER_INPUT_DELAY (=5). */
const PEER_FRAME_BUFFER_PER_PLAYER = parseInt(process.env.PEER_FRAME_BUFFER_PER_PLAYER ?? '1500', 10);
const MAX_PEER_PLAYERS = parseInt(process.env.MAX_PEER_PLAYERS ?? '64', 10);
/** When a human joins an AI-filled deathmatch slot after the round has
 *  already started, keep that slot AI-controlled for a short deterministic
 *  handoff window. This gives the late client time to replay buffered
 *  inputs and start sending its own future frames before the existing peers
 *  require that slot in their lockstep input logs. */
const PEER_LATE_TAKEOVER_DELAY_FRAMES = parseInt(process.env.PEER_LATE_TAKEOVER_DELAY_FRAMES ?? '90', 10);
const PEER_BINARY_MAGIC = 0x50; // 'P'
const PEER_BINARY_VERSION = 1;
const PEER_BINARY_FRAME = 1;
const PEER_BINARY_FRAMES = 2;
const PEER_BINARY_HASH = 3;

// SESSION_RE accepts controller pairing codes (4 letters) AND the
// longer stream ids used by the live frame relay (player master pubkey,
// 64 hex). Anything alphanumeric, 4-128 chars, is fine.
const SESSION_RE = /^[a-z0-9_-]{4,128}$/i;

/** Pair-role: phone↔host controller. Stream-role: 1-to-many
 *  publisher↔subscribers for live frame broadcast. Peer-role: two
 *  symmetric game runtimes for shared-arena lockstep. Peerwatch-role:
 *  read-only spectators of a peer session. */
const ROLES = new Set(['host', 'phone', 'publish', 'subscribe', 'peer', 'peerwatch']);

/** Counter for backpressure-dropped peer messages. Surfaced via the
 *  process log on shutdown; not exposed on the wire. */
let peerDropped = 0;
let peerForwardAttempts = 0;
let peerForwardSent = 0;
let peerForwardUnavailable = 0;
let peerForwardErrors = 0;
let peerForwardBytes = 0;
let peerMaxBufferedAmountObserved = 0;

const METRIC_SAMPLE_LIMIT = Math.max(256, parseInt(process.env.METRIC_SAMPLE_LIMIT ?? '8192', 10) || 8192);
const peerForwardLatencySamples = [];
let peerForwardLatencyHead = 0;
let peerForwardLatencyCount = 0;
let peerForwardLatencyTotalMs = 0;
let lastCpuUsage = process.cpuUsage();
let lastCpuWallMs = performance.now();

/** Map sessionId → SessionSlot. */
const sessions = new Map();

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, uptimeSec: Number(process.uptime().toFixed(3)) }) + '\n');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/metrics') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(metricsSnapshot()) + '\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('controller relay, open a websocket\n');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const session = url.searchParams.get('s');
  const role = url.searchParams.get('r');
  const wantsMulti = url.searchParams.get('multi') === '1';
  const wantsBinaryFrames = url.searchParams.get('binaryFrames') === '1' || url.searchParams.get('binary') === '1';
  if (!session || !SESSION_RE.test(session) || !role || !ROLES.has(role)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  if (sessions.size >= MAX_SESSIONS && !sessions.has(session)) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attach(ws, session, role, wantsMulti, wantsBinaryFrames);
  });
});

function attach(ws, session, role, wantsMulti, wantsBinaryFrames = false) {
  let slot = sessions.get(session);
  if (!slot) {
    slot = {
      host: undefined,
      // Single-mode singleton; left undefined while session is in multi mode.
      phone: undefined,
      // Multi-mode phone Map<playerSlot, ws>. Initialised when a host
      // connects with multi=1. Untouched in single mode.
      phones: undefined,
      multi: false,
      publish: undefined,
      subscribe: new Set(),
      // Peer-mode slots for shared-arena multiplayer. Index 0..peerCount-1, each
      // populated when the corresponding peer sends `hello-peer`.
      peers: [],
      peerCount: 2,
      // AI-filled deathmatch finalises the human slots when the host starts.
      // Slots not listed here become deterministic local AI on every client.
      peerHumanSlots: undefined,
      // Slot -> sim frame where a late human should take over an AI-filled
      // slot. Absent/0 means human from frame 0.
      peerTakeovers: {},
      peerLatestFrame: -1,
      // Peerwatch-mode spectators of this peer session. Every frame/hash
      // either peer sends is fanned out to every entry here. Watchers
      // never speak; their `message` handler is a no-op.
      peerWatchers: new Set(),
      // Recent peer frame messages, kept so a late-joining peerwatcher
      // can replay missed frames and pass its lockstep stall check at
      // state.frame=PEER_INPUT_DELAY (5). Sized for ~25 seconds of duel
      // at 60Hz (1500 frames × 2 slots = 3000 entries). The lockstep
      // sim cannot recover from missing the FIRST few frames, so the
      // buffer must include frame 0 to be useful — purged only on
      // session orphan sweep / broker restart.
      recentFrames: [],
      recentFrameCount: 0,
      createdAt: Date.now(),
    };
    sessions.set(session, slot);
    // Orphan sweep so unattached sessions don't leak the map slot.
    setTimeout(() => {
      const current = sessions.get(session);
      if (!current) return;
      const hasPhones = current.multi
        ? (current.phones && current.phones.size > 0)
        : !!current.phone;
      const hasPeers = peersPresent(current);
      const hasPeerWatchers = current.peerWatchers && current.peerWatchers.size > 0;
      const empty = !current.host && !hasPhones && !current.publish && current.subscribe.size === 0 && !hasPeers && !hasPeerWatchers;
      const pairIncomplete = !current.host || !hasPhones;
      const streamIncomplete = !current.publish && current.subscribe.size === 0;
      // A peer session is "incomplete" only if neither slot is bound AND
      // no watchers are present. A watcher-only session is allowed to
      // exist briefly while the peers connect.
      const peerIncomplete = !peersPresent(current) && !hasPeerWatchers;
      if (empty || (pairIncomplete && streamIncomplete && peerIncomplete)) {
        if (current.host) try { current.host.close(); } catch {}
        if (current.phone) try { current.phone.close(); } catch {}
        if (current.phones) for (const phWs of current.phones.values()) try { phWs.close(); } catch {}
        if (current.publish) try { current.publish.close(); } catch {}
        for (const s of current.subscribe) try { s.close(); } catch {}
        for (const p of current.peers) if (p) try { p.close(); } catch {}
        if (current.peerWatchers) for (const w of current.peerWatchers) try { w.close(); } catch {}
        sessions.delete(session);
      }
    }, ORPHAN_TIMEOUT_MS);
  }

  // Peer role has its own attach + message + close flow; the host/phone
  // grammar below doesn't apply. Bail out after wiring it up.
  if (role === 'peer') {
    attachPeer(slot, session, ws);
    return;
  }
  // Peerwatch role: subscribe-only spectator of a peer session.
  if (role === 'peerwatch') {
    ws._peerBinaryFrames = wantsBinaryFrames === true;
    attachPeerWatcher(slot, session, ws);
    return;
  }

  // Multi-mode is set by the FIRST host's connect param. Once on, phones
  // entering this session are placed in the phones Map. If the host
  // disconnects then a new host connects without multi=1, we honour
  // their preference and reset the slot to single mode (any existing
  // phones are kicked, since the wire shape changes).
  if (role === 'host') {
    if (slot.host) try { slot.host.close(1000, 'replaced'); } catch {}
    slot.host = ws;
    if (wantsMulti && !slot.multi) {
      slot.multi = true;
      slot.phones = new Map();
      // Migrate any pre-existing single-mode phone into the Map at slot 0.
      if (slot.phone) {
        slot.phones.set(0, slot.phone);
        slot.phone._playerSlot = 0;
        slot.phone = undefined;
        try { slot.phones.get(0).send(JSON.stringify({ type: 'welcome', p: 0 })); } catch {}
      }
    } else if (!wantsMulti && slot.multi) {
      // Host opted out of multi mode but session was multi. Kick all
      // phones (their wire model differs). Reset to single mode.
      if (slot.phones) {
        for (const phWs of slot.phones.values()) {
          try { phWs.close(1000, 'multi-mode-ended'); } catch {}
        }
        slot.phones = undefined;
      }
      slot.multi = false;
    }
  } else if (role === 'phone') {
    if (slot.multi) {
      if (!slot.phones) slot.phones = new Map();
      const playerSlot = findNextSlot(slot.phones, MAX_PHONES_PER_SESSION);
      if (playerSlot === null) {
        try { ws.send(JSON.stringify({ type: 'error', code: 'session-full', message: 'too many players' })); } catch {}
        try { ws.close(1013, 'session-full'); } catch {}
        return;
      }
      slot.phones.set(playerSlot, ws);
      ws._playerSlot = playerSlot;
      try { ws.send(JSON.stringify({ type: 'welcome', p: playerSlot })); } catch {}
    } else {
      // Single-mode (current behaviour): singleton phone, new replaces old.
      if (slot.phone) try { slot.phone.close(1000, 'replaced'); } catch {}
      slot.phone = ws;
    }
  } else if (role === 'subscribe') {
    slot.subscribe.add(ws);
  } else {
    // publish (singleton)
    if (slot[role]) try { slot[role].close(1000, 'replaced'); } catch {}
    slot[role] = ws;
  }

  notifyPeerState(slot, role, ws, 'connect');

  ws.on('message', (data, isBinary) => {
    forwardMessage(slot, role, ws, data, isBinary);
  });

  const closeHandler = () => {
    if (role === 'subscribe') {
      slot.subscribe.delete(ws);
    } else if (role === 'phone') {
      if (slot.multi && slot.phones && ws._playerSlot !== undefined) {
        if (slot.phones.get(ws._playerSlot) === ws) {
          slot.phones.delete(ws._playerSlot);
        }
      } else if (slot.phone === ws) {
        slot.phone = undefined;
      }
    } else if (slot[role] === ws) {
      slot[role] = undefined;
    }
    notifyPeerState(slot, role, ws, 'disconnect');
    const hasPhones = slot.multi ? (slot.phones && slot.phones.size > 0) : !!slot.phone;
    const hasPeers = peersPresent(slot);
    const hasPeerWatchers = slot.peerWatchers && slot.peerWatchers.size > 0;
    const empty = !slot.host && !hasPhones && !slot.publish && slot.subscribe.size === 0 && !hasPeers && !hasPeerWatchers;
    if (empty) sessions.delete(session);
  };
  ws.on('close', closeHandler);
  ws.on('error', closeHandler);
}

function recordPeerForwardLatency(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (peerForwardLatencyCount < METRIC_SAMPLE_LIMIT) {
    peerForwardLatencySamples.push(value);
    peerForwardLatencyCount++;
  } else {
    const old = peerForwardLatencySamples[peerForwardLatencyHead] || 0;
    peerForwardLatencyTotalMs -= old;
    peerForwardLatencySamples[peerForwardLatencyHead] = value;
    peerForwardLatencyHead = (peerForwardLatencyHead + 1) % METRIC_SAMPLE_LIMIT;
  }
  peerForwardLatencyTotalMs += value;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function latencySummary() {
  const samples = peerForwardLatencySamples.slice().sort((a, b) => a - b);
  const count = samples.length;
  return {
    sampleCount: count,
    sampleLimit: METRIC_SAMPLE_LIMIT,
    avg: count > 0 ? Number((peerForwardLatencyTotalMs / count).toFixed(3)) : 0,
    min: count > 0 ? Number(samples[0].toFixed(3)) : 0,
    p50: Number(percentile(samples, 50).toFixed(3)),
    p95: Number(percentile(samples, 95).toFixed(3)),
    p99: Number(percentile(samples, 99).toFixed(3)),
    max: count > 0 ? Number(samples[count - 1].toFixed(3)) : 0,
  };
}

function socketCounts() {
  let open = 0;
  let closing = 0;
  let maxBufferedAmount = 0;
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) open++;
    else closing++;
    maxBufferedAmount = Math.max(maxBufferedAmount, Number(client.bufferedAmount) || 0);
  }
  return { total: wss.clients.size, open, closing, maxBufferedAmount };
}

function sessionCounts() {
  const out = {
    total: sessions.size,
    hosts: 0,
    phones: 0,
    multiPhones: 0,
    publishers: 0,
    subscribers: 0,
    peerSessions: 0,
    peers: 0,
    peerWatchers: 0,
    recentFramePayloads: 0,
  };
  for (const slot of sessions.values()) {
    if (slot.host) out.hosts++;
    if (slot.phone) out.phones++;
    if (slot.phones) out.multiPhones += slot.phones.size;
    if (slot.publish) out.publishers++;
    if (slot.subscribe) out.subscribers += slot.subscribe.size;
    if (peersPresent(slot)) out.peerSessions++;
    if (Array.isArray(slot.peers)) out.peers += slot.peers.filter(Boolean).length;
    if (slot.peerWatchers) out.peerWatchers += slot.peerWatchers.size;
    if (Array.isArray(slot.recentFrames)) out.recentFramePayloads += slot.recentFrames.length;
  }
  return out;
}

function cpuRecentPercent() {
  const nowCpu = process.cpuUsage();
  const nowWallMs = performance.now();
  const usedMs = ((nowCpu.user - lastCpuUsage.user) + (nowCpu.system - lastCpuUsage.system)) / 1000;
  const wallMs = Math.max(1, nowWallMs - lastCpuWallMs);
  lastCpuUsage = nowCpu;
  lastCpuWallMs = nowWallMs;
  return Number(((usedMs / wallMs) * 100).toFixed(2));
}

function metricsSnapshot() {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    ok: true,
    uptimeSec: Number(process.uptime().toFixed(3)),
    process: {
      pid: process.pid,
      rssBytes: mem.rss,
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      externalBytes: mem.external,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      cpuRecentPercent: cpuRecentPercent(),
    },
    sessions: sessionCounts(),
    sockets: socketCounts(),
    peer: {
      configuredForwardDelayMs: PEER_FORWARD_DELAY_MS,
      configuredForwardJitterMs: PEER_FORWARD_JITTER_MS,
      forwardAttempts: peerForwardAttempts,
      forwarded: peerForwardSent,
      forwardUnavailable: peerForwardUnavailable,
      forwardErrors: peerForwardErrors,
      droppedBufferedAmount: peerDropped,
      maxBufferedAmountObserved: peerMaxBufferedAmountObserved,
      forwardedBytes: peerForwardBytes,
      forwardLatencyMs: latencySummary(),
    },
  };
}

function peersPresent(slot) {
  return Array.isArray(slot.peers) && slot.peers.some(Boolean);
}

function normaliseHumanSlots(raw, peerCount) {
  if (!Array.isArray(raw)) return null;
  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 0 || n >= peerCount || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  out.sort((a, b) => a - b);
  return out.includes(0) && out.length > 0 ? out : null;
}

function sameSlots(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function peerRequiredSlots(slot) {
  if (slot.peerHumanSlots && slot.peerHumanSlots.length > 0) return slot.peerHumanSlots;
  return Array.from({ length: slot.peerCount || 2 }, (_, i) => i);
}

function peerBinaryReady(slot) {
  const required = peerRequiredSlots(slot);
  if (required.length <= 0) return false;
  for (const i of required) {
    const peer = slot.peers[i];
    if (!peer || peer.readyState !== peer.OPEN || peer._peerBinaryFrames !== true) return false;
  }
  return true;
}

function peerJoinedPayload(slot, joinedSlot) {
  const msg = { type: 'peer-joined', slot: joinedSlot };
  if (peerBinaryReady(slot)) msg.binaryFrames = true;
  return JSON.stringify(msg);
}

function sessionConfigPayload(slot) {
  if (!slot.peerHumanSlots) return null;
  const takeovers = [];
  const source = slot.peerTakeovers || {};
  for (const key of Object.keys(source)) {
    const takeoverSlot = Math.floor(Number(key));
    const frame = Math.floor(Number(source[key]));
    if (Number.isFinite(takeoverSlot) && Number.isFinite(frame) && frame > 0) {
      takeovers.push({ slot: takeoverSlot, frame });
    }
  }
  const msg = {
    type: 'session-config',
    players: slot.peerCount || 2,
    aiFill: true,
    humanSlots: slot.peerHumanSlots,
    takeovers,
  };
  if (peerBinaryReady(slot)) msg.binaryFrames = true;
  return JSON.stringify(msg);
}

function sendSessionConfig(target, slot) {
  const payload = sessionConfigPayload(slot);
  if (!payload || !target || target.readyState !== target.OPEN) return;
  try { target.send(payload); } catch {}
}

function fanOutSessionConfig(slot) {
  const payload = sessionConfigPayload(slot);
  if (!payload) return;
  for (const p of slot.peers) {
    if (p && p.readyState === p.OPEN) {
      try { p.send(payload); } catch {}
    }
  }
  fanOutToWatchers(slot, payload);
}

function closeAiFilledPeerSlots(slot) {
  if (!slot.peerHumanSlots) return;
  const human = new Set(slot.peerHumanSlots);
  for (let i = 0; i < (slot.peerCount || 2); i++) {
    const peer = slot.peers[i];
    if (!peer || human.has(i)) continue;
    try { peer.send(JSON.stringify({ type: 'session-error', code: 'ai-slot' })); } catch {}
    try { peer.close(1008, 'ai-slot'); } catch {}
  }
}

function replayRecentPeerFrames(target, slot) {
  if (!target || target.readyState !== target.OPEN) return;
  try {
    for (const entry of slot.recentFrames) {
      const payload = typeof entry === 'string' ? entry : peerPayloadForTarget(target, entry.payload, entry.msg);
      target.send(payload, { binary: Buffer.isBuffer(payload) });
    }
  } catch { /* socket may already be closed */ }
}

/** Subscribe-only fan-out target for a peer session. Receives every
 *  frame/hash from either peer, plus peer-joined/peer-left
 *  notifications. Anything the watcher sends is silently dropped —
 *  spectators do not speak. */
function attachPeerWatcher(slot, session, ws) {
  slot.peerWatchers.add(ws);
  // Acknowledge + give the watcher the current peer-state so it can decide
  // whether to wait for the pair-up or start spectating immediately.
  try {
    ws.send(JSON.stringify({
      type: 'peerwatch-ready',
      players: slot.peerCount || 2,
      aiFill: !!slot.peerHumanSlots,
      humanSlots: slot.peerHumanSlots,
      binaryFrames: ws._peerBinaryFrames === true && peerBinaryReady(slot) ? true : undefined,
    }));
    sendSessionConfig(ws, slot);
    for (let i = 0; i < (slot.peerCount || 2); i++) {
      if (slot.peers[i]) ws.send(peerJoinedPayload(slot, i));
    }
    // Replay buffered frame history so the spectator can pass its
    // lockstep stall check at frame 5. Without this, a peerwatch that
    // attaches even one frame after either peer's first send loses
    // those inputs forever and its sim stalls at PEER_INPUT_DELAY.
    // Order preserved (buffer is a FIFO ring) so the deterministic
    // ordering the spectator's lockstep depends on stays intact.
    replayRecentPeerFrames(ws, slot);
  } catch { /* socket may already be closed */ }

  // Silently drop everything the watcher sends. No "they accidentally
  // broadcast over the spectate channel" failure mode.
  ws.on('message', () => { /* read-only */ });

  const closeHandler = () => {
    slot.peerWatchers.delete(ws);
    const hasPhones = slot.multi ? (slot.phones && slot.phones.size > 0) : !!slot.phone;
    const hasPeers = peersPresent(slot);
    const hasPeerWatchers = slot.peerWatchers && slot.peerWatchers.size > 0;
    const empty = !slot.host && !hasPhones && !slot.publish && slot.subscribe.size === 0 && !hasPeers && !hasPeerWatchers;
    if (empty) sessions.delete(session);
  };
  ws.on('close', closeHandler);
  ws.on('error', closeHandler);
}

/** Fan out a peer-originated message to every watcher of this session.
 *  Same backpressure rule as the peer-to-peer forward path. */
function fanOutToWatchers(slot, payload, msg = null, fromSlot = -1) {
  if (!slot.peerWatchers || slot.peerWatchers.size === 0) return;
  let watcherIndex = 0;
  for (const w of slot.peerWatchers) {
    sendPeerPayload(w, msg ? peerPayloadForTarget(w, payload, msg) : payload, peerForwardDelayMs(msg, fromSlot, 97 + watcherIndex));
    watcherIndex++;
  }
}

function peerForwardDelayMs(msg, fromSlot, toSlot) {
  if (PEER_FORWARD_DELAY_MS <= 0 && PEER_FORWARD_JITTER_MS <= 0) return 0;
  if (PEER_FORWARD_JITTER_MS <= 0) return PEER_FORWARD_DELAY_MS;
  const rawFrame = msg && (msg.frame ?? msg.base);
  const frame = Number.isFinite(Number(rawFrame)) ? Math.max(0, Math.floor(Number(rawFrame))) : 0;
  const from = Number.isFinite(Number(fromSlot)) ? Math.max(0, Math.floor(Number(fromSlot))) : 0;
  const to = Number.isFinite(Number(toSlot)) ? Math.max(0, Math.floor(Number(toSlot))) : 0;
  const h = (Math.imul(frame + 1, 1103515245) ^ Math.imul(from + 3, 2654435761) ^ Math.imul(to + 7, 1597334677)) >>> 0;
  return PEER_FORWARD_DELAY_MS + (h % (PEER_FORWARD_JITTER_MS + 1));
}

function peerFramePayloadCount(msg) {
  if (msg && msg.type === 'frames' && Array.isArray(msg.inputs)) return Math.max(0, msg.inputs.length);
  return 1;
}

function peerFrameLatestFrame(msg) {
  if (!msg) return -1;
  if (msg.type === 'frames' && Array.isArray(msg.inputs)) {
    return Math.max(-1, Math.floor(Number(msg.base)) + msg.inputs.length - 1);
  }
  return Number.isFinite(Number(msg.frame)) ? Math.floor(Number(msg.frame)) : -1;
}

function decodePeerBinaryPayload(data) {
  const buf = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
  if (buf.length < 9 || buf[0] !== PEER_BINARY_MAGIC || buf[1] !== PEER_BINARY_VERSION) return null;
  const kind = buf[2];
  const slot = buf[3];
  const frameOrBase = buf.readUInt32LE(4);
  if (kind === PEER_BINARY_FRAME) {
    if (buf.length !== 12) return null;
    return { type: 'frame', frame: frameOrBase, slot, input: buf.readUInt32LE(8) };
  }
  if (kind === PEER_BINARY_HASH) {
    if (buf.length !== 12) return null;
    return { type: 'hash', frame: frameOrBase, slot, hash: buf.readUInt32LE(8) };
  }
  if (kind === PEER_BINARY_FRAMES) {
    const count = buf[8];
    if (count <= 0 || buf.length !== 9 + count * 4) return null;
    const inputs = [];
    for (let i = 0; i < count; i++) inputs.push(buf.readUInt32LE(9 + i * 4));
    return { type: 'frames', slot, base: frameOrBase, inputs };
  }
  return null;
}

function encodePeerBinaryPayload(msg) {
  if (!msg || typeof msg.type !== 'string') return null;
  const slot = Math.max(0, Math.min(255, Math.floor(Number(msg.slot) || 0)));
  if (msg.type === 'frame') {
    const buf = Buffer.allocUnsafe(12);
    buf[0] = PEER_BINARY_MAGIC;
    buf[1] = PEER_BINARY_VERSION;
    buf[2] = PEER_BINARY_FRAME;
    buf[3] = slot;
    buf.writeUInt32LE(Math.max(0, Math.floor(Number(msg.frame) || 0)) >>> 0, 4);
    buf.writeUInt32LE(Math.max(0, Math.floor(Number(msg.input) || 0)) >>> 0, 8);
    return buf;
  }
  if (msg.type === 'hash') {
    const buf = Buffer.allocUnsafe(12);
    buf[0] = PEER_BINARY_MAGIC;
    buf[1] = PEER_BINARY_VERSION;
    buf[2] = PEER_BINARY_HASH;
    buf[3] = slot;
    buf.writeUInt32LE(Math.max(0, Math.floor(Number(msg.frame) || 0)) >>> 0, 4);
    buf.writeUInt32LE(Math.max(0, Math.floor(Number(msg.hash) || 0)) >>> 0, 8);
    return buf;
  }
  if (msg.type === 'frames' && Array.isArray(msg.inputs) && msg.inputs.length > 0) {
    const count = Math.min(255, msg.inputs.length);
    const buf = Buffer.allocUnsafe(9 + count * 4);
    buf[0] = PEER_BINARY_MAGIC;
    buf[1] = PEER_BINARY_VERSION;
    buf[2] = PEER_BINARY_FRAMES;
    buf[3] = slot;
    buf.writeUInt32LE(Math.max(0, Math.floor(Number(msg.base) || 0)) >>> 0, 4);
    buf[8] = count;
    for (let i = 0; i < count; i++) {
      buf.writeUInt32LE(Math.max(0, Math.floor(Number(msg.inputs[i]) || 0)) >>> 0, 9 + i * 4);
    }
    return buf;
  }
  return null;
}

function peerPayloadForTarget(target, payload, msg) {
  const binaryPayload = Buffer.isBuffer(payload);
  if (binaryPayload && target && target._peerBinaryFrames !== true) return JSON.stringify(msg);
  if (!binaryPayload && target && target._peerBinaryFrames === true) return encodePeerBinaryPayload(msg) || payload;
  return payload;
}

function rememberPeerFramePayload(slot, payload, msg) {
  const count = peerFramePayloadCount(msg);
  if (count <= 0) return;
  slot.recentFrames.push({ payload: Buffer.isBuffer(payload) ? Buffer.from(payload) : String(payload), msg, count });
  slot.recentFrameCount = (slot.recentFrameCount || 0) + count;
  const frameBufferLimit = Math.max(1, (slot.peerCount || 2)) * PEER_FRAME_BUFFER_PER_PLAYER;
  while (slot.recentFrameCount > frameBufferLimit && slot.recentFrames.length > 0) {
    const dropped = slot.recentFrames.shift();
    slot.recentFrameCount -= dropped && typeof dropped.count === 'number' ? dropped.count : 1;
  }
}

function sendPeerPayload(target, payload, delayMs = 0) {
  peerForwardAttempts++;
  const queuedAt = performance.now();
  const send = () => {
    if (!target || target.readyState !== target.OPEN) {
      peerForwardUnavailable++;
      return;
    }
    const bufferedAmount = Number(target.bufferedAmount) || 0;
    if (bufferedAmount > peerMaxBufferedAmountObserved) peerMaxBufferedAmountObserved = bufferedAmount;
    if (bufferedAmount > PEER_BACKPRESSURE_BYTES) {
      peerDropped++;
      return;
    }
    try {
      target.send(payload, { binary: Buffer.isBuffer(payload) });
      peerForwardSent++;
      peerForwardBytes += Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload));
      recordPeerForwardLatency(performance.now() - queuedAt);
    } catch {
      peerForwardErrors++;
    }
  };
  if (delayMs > 0) setTimeout(send, delayMs);
  else send();
}

function attachPeer(slot, session, ws) {
  // Slot is not chosen by the URL; we wait for the client's hello-peer.
  // Until then, ws._peerSlot stays -1 and frame/hash messages are
  // ignored (the client also won't send them before its connect promise
  // resolves on peer-joined).
  ws._peerSlot = -1;
  ws._peerBinaryFrames = false;

  ws.on('message', (data, isBinary) => {
    let msg;
    let payload;
    if (isBinary) {
      msg = decodePeerBinaryPayload(data);
      if (!msg || ws._peerBinaryFrames !== true) return;
      payload = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
    } else {
      try { msg = JSON.parse(data.toString()); } catch { return; }
      payload = data.toString();
    }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello-peer') {
      if (isBinary) return;
      handlePeerHello(slot, ws, msg);
      return;
    }
    if (ws._peerSlot < 0) return;

    if (msg.type === 'frame' || msg.type === 'frames' || msg.type === 'hash') {
      if (msg.type === 'frame' || msg.type === 'frames') {
        const latest = peerFrameLatestFrame(msg);
        if (latest > (slot.peerLatestFrame ?? -1)) slot.peerLatestFrame = latest;
      }
      for (let i = 0; i < (slot.peerCount || 2); i++) {
        if (i === ws._peerSlot) continue;
        const target = slot.peers[i];
        sendPeerPayload(target, peerPayloadForTarget(target, payload, msg), peerForwardDelayMs(msg, ws._peerSlot, i));
      }
      // Buffer frames (only — not hashes) so a late-joining peerwatch
      // can replay them on attach. Hashes are 1/60 the rate and a
      // late spectator can resync from the next live one. Cap at
      // PEER_FRAME_BUFFER entries; oldest dropped first. Spectators
      // joining after the buffer has wrapped won't see frames 0..N,
      // which means their lockstep sim is dead-on-arrival — same as
      // pre-buffer behaviour, but with a generous grace window.
      if (msg.type === 'frame' || msg.type === 'frames') {
        rememberPeerFramePayload(slot, payload, msg);
      }
      // Fan out the same payload to every peerwatch socket on this
      // session. Spectators see what each peer sent in the order it
      // was sent; deterministic lockstep depends on consistent ordering.
      fanOutToWatchers(slot, payload, msg, ws._peerSlot);
      return;
    }

    if (msg.type === 'bye') {
      try { ws.close(1000, 'bye'); } catch {}
      return;
    }
  });

  const closeHandler = () => {
    const departingSlot = ws._peerSlot;
    if (departingSlot >= 0 && slot.peers[departingSlot] === ws) {
      slot.peers[departingSlot] = undefined;
      const leftPayload = JSON.stringify({ type: 'peer-left', slot: departingSlot, reason: 'disconnect' });
      for (let i = 0; i < (slot.peerCount || 2); i++) {
        if (i === departingSlot) continue;
        const other = slot.peers[i];
        if (other && other.readyState === other.OPEN) {
          try { other.send(leftPayload); } catch {}
        }
      }
      // Watchers see peer-left too so the spectator UI can surface
      // "OPPONENT LEFT" alongside the same gameover funnel.
      fanOutToWatchers(slot, leftPayload);
    }
    const hasPhones = slot.multi ? (slot.phones && slot.phones.size > 0) : !!slot.phone;
    const hasPeers = peersPresent(slot);
    const hasPeerWatchers = slot.peerWatchers && slot.peerWatchers.size > 0;
    const empty = !slot.host && !hasPhones && !slot.publish && slot.subscribe.size === 0 && !hasPeers && !hasPeerWatchers;
    if (empty) sessions.delete(session);
  };
  ws.on('close', closeHandler);
  ws.on('error', closeHandler);
}

function handlePeerHello(slot, ws, msg) {
  // Already bound: a second hello-peer is a protocol error; ignore it
  // rather than re-arrange slots.
  if (ws._peerSlot >= 0) return;

  const requested = Number(msg.slot);
  const requestedPlayers = Number(msg.players);
  const desiredPeerCount = Number.isFinite(requestedPlayers)
    ? Math.max(2, Math.min(MAX_PEER_PLAYERS, Math.floor(requestedPlayers)))
    : (slot.peerCount || 2);
  const wantsAiFillConfig = msg.aiFill === true && Array.isArray(msg.humanSlots);
  if (!peersPresent(slot) && slot.recentFrames.length === 0) {
    const peerCountChanged = desiredPeerCount !== (slot.peerCount || 2);
    slot.peerCount = desiredPeerCount;
    slot.peers.length = desiredPeerCount;
    slot.peerHumanSlots = undefined;
    slot.peerTakeovers = {};
    slot.peerLatestFrame = -1;
    if (peerCountChanged) {
      fanOutToWatchers(slot, JSON.stringify({ type: 'peerwatch-ready', players: slot.peerCount }));
    }
  } else if (desiredPeerCount !== (slot.peerCount || 2)) {
    try { ws.send(JSON.stringify({ type: 'session-error', code: 'player-count-mismatch' })); } catch {}
    try { ws.close(1008, 'player-count-mismatch'); } catch {}
    return;
  }

  if (!Number.isInteger(requested) || requested < 0 || requested >= (slot.peerCount || 2)) {
    try { ws.send(JSON.stringify({ type: 'session-error', code: 'invalid-slot' })); } catch {}
    try { ws.close(1008, 'invalid-slot'); } catch {}
    return;
  }
  let nextHumanSlots = null;
  let lateTakeoverFrame = null;
  if (slot.peerHumanSlots && !slot.peerHumanSlots.includes(requested)) {
    if (msg.aiFill !== true) {
      try { ws.send(JSON.stringify({ type: 'session-error', code: 'ai-slot' })); } catch {}
      try { ws.close(1008, 'ai-slot'); } catch {}
      return;
    }
    nextHumanSlots = normaliseHumanSlots([...slot.peerHumanSlots, requested], slot.peerCount || 2);
    if (!nextHumanSlots) {
      try { ws.send(JSON.stringify({ type: 'session-error', code: 'invalid-human-slots' })); } catch {}
      try { ws.close(1008, 'invalid-human-slots'); } catch {}
      return;
    }
    lateTakeoverFrame = Math.max(0, (slot.peerLatestFrame ?? -1) + PEER_LATE_TAKEOVER_DELAY_FRAMES);
  }
  if (wantsAiFillConfig) {
    if (requested !== 0) {
      try { ws.send(JSON.stringify({ type: 'session-error', code: 'host-required' })); } catch {}
      try { ws.close(1008, 'host-required'); } catch {}
      return;
    }
    const configuredSlots = normaliseHumanSlots(msg.humanSlots, slot.peerCount || 2);
    if (!configuredSlots) {
      try { ws.send(JSON.stringify({ type: 'session-error', code: 'invalid-human-slots' })); } catch {}
      try { ws.close(1008, 'invalid-human-slots'); } catch {}
      return;
    }
    if (slot.peerHumanSlots && !sameSlots(slot.peerHumanSlots, configuredSlots)) {
      try { ws.send(JSON.stringify({ type: 'session-error', code: 'start-config-mismatch' })); } catch {}
      try { ws.close(1008, 'start-config-mismatch'); } catch {}
      return;
    }
    nextHumanSlots = configuredSlots;
  }
  if (slot.peers[requested]) {
    const previous = slot.peers[requested];
    slot.peers[requested] = undefined;
    try { previous.close(1000, 'replaced'); } catch {}
  }

  slot.peers[requested] = ws;
  ws._peerSlot = requested;
  ws._peerBinaryFrames = msg.binaryFrames === true;

  if (nextHumanSlots) {
    slot.peerHumanSlots = nextHumanSlots;
    if (lateTakeoverFrame !== null) {
      slot.peerTakeovers = slot.peerTakeovers || {};
      slot.peerTakeovers[requested] = lateTakeoverFrame;
    } else {
      slot.peerTakeovers = {};
    }
    fanOutSessionConfig(slot);
    if (lateTakeoverFrame !== null) replayRecentPeerFrames(ws, slot);
    else closeAiFilledPeerSlots(slot);
  } else {
    sendSessionConfig(ws, slot);
  }

  // Watchers always see a peer-joined the moment a slot is bound, even
  // if the other peer isn't there yet — they may have connected first
  // and need to know when the game becomes startable.
  fanOutToWatchers(slot, peerJoinedPayload(slot, requested), { type: 'peer-joined', slot: requested });

  for (let i = 0; i < (slot.peerCount || 2); i++) {
    if (i === requested) continue;
    if (slot.peerHumanSlots && !slot.peerHumanSlots.includes(i)) continue;
    const other = slot.peers[i];
    if (other && other.readyState === other.OPEN) {
      const joinedRequested = peerJoinedPayload(slot, requested);
      const joinedOther = peerJoinedPayload(slot, i);
      try { other.send(joinedRequested); } catch {}
      try { ws.send(joinedOther); } catch {}
    }
  }
  // If more peers are still absent, do nothing. Each arrival triggers this
  // same branch and all connected clients count joined slots locally.
}

function findNextSlot(phones, max) {
  for (let i = 0; i < max; i++) {
    if (!phones.has(i)) return i;
  }
  return null;
}

function forwardMessage(slot, role, ws, data, isBinary) {
  if (role === 'host') {
    if (slot.multi && slot.phones) {
      // Try to parse JSON to look for a targeted p field.
      if (!isBinary) {
        const targetP = peekP(data);
        if (targetP !== null) {
          const target = slot.phones.get(targetP);
          if (target && target.readyState === target.OPEN) {
            try { target.send(data, { binary: false }); } catch {}
          }
          return;
        }
      }
      // No p field (or binary): broadcast to all paired phones.
      for (const phWs of slot.phones.values()) {
        if (phWs.readyState !== phWs.OPEN) continue;
        try { phWs.send(data, { binary: isBinary }); } catch {}
      }
    } else if (slot.phone && slot.phone.readyState === slot.phone.OPEN) {
      try { slot.phone.send(data, { binary: isBinary }); } catch {}
    }
  } else if (role === 'phone') {
    if (!slot.host || slot.host.readyState !== slot.host.OPEN) return;
    if (slot.multi && !isBinary && ws._playerSlot !== undefined) {
      const stamped = injectP(data, ws._playerSlot);
      try { slot.host.send(stamped, { binary: false }); } catch {}
    } else {
      try { slot.host.send(data, { binary: isBinary }); } catch {}
    }
  } else if (role === 'publish') {
    for (const sub of slot.subscribe) {
      if (sub.readyState !== sub.OPEN) continue;
      try { sub.send(data, { binary: isBinary }); } catch {}
    }
  }
  // subscribe → ignored (uplink-only)
}

/** Read p field from a JSON frame. Returns integer player slot, null otherwise. */
function peekP(data) {
  try {
    const str = data.toString();
    const obj = JSON.parse(str);
    if (typeof obj.p === 'number' && Number.isInteger(obj.p)) return obj.p;
  } catch {
    // not JSON, no p
  }
  return null;
}

/** Stamp p into a JSON frame. Falls back to original data if parsing fails. */
function injectP(data, playerSlot) {
  try {
    const str = data.toString();
    const obj = JSON.parse(str);
    obj.p = playerSlot;
    return JSON.stringify(obj);
  } catch {
    return data;
  }
}

function notifyPeerState(slot, changedRole, changedWs, eventType) {
  if (changedRole === 'host') {
    if (slot.multi && slot.phones) {
      const up = !!slot.host && slot.host.readyState === slot.host.OPEN;
      const msg = JSON.stringify({ type: up ? 'host-up' : 'host-down' });
      for (const phWs of slot.phones.values()) {
        if (phWs.readyState !== phWs.OPEN) continue;
        try { phWs.send(msg); } catch {}
      }
    } else {
      const bothUp = slot.host && slot.host.readyState === slot.host.OPEN
                  && slot.phone && slot.phone.readyState === slot.phone.OPEN;
      const msg = JSON.stringify({ type: bothUp ? 'peer-up' : 'peer-down' });
      for (const ws of [slot.host, slot.phone]) {
        if (!ws || ws.readyState !== ws.OPEN) continue;
        try { ws.send(msg); } catch {}
      }
    }
  } else if (changedRole === 'phone') {
    if (slot.multi) {
      const playerSlot = changedWs._playerSlot;
      const hostUp = slot.host && slot.host.readyState === slot.host.OPEN;
      if (hostUp && playerSlot !== undefined) {
        const up = eventType === 'connect';
        const msg = JSON.stringify({ type: up ? 'peer-up' : 'peer-down', p: playerSlot });
        try { slot.host.send(msg); } catch {}
      }
      // Tell the new phone whether the host is alive. Symmetric to single
      // mode, which sends peer-up to both sides when both are connected.
      if (eventType === 'connect' && changedWs.readyState === changedWs.OPEN) {
        const msg = JSON.stringify({ type: hostUp ? 'host-up' : 'host-down' });
        try { changedWs.send(msg); } catch {}
      }
    } else {
      const bothUp = slot.host && slot.host.readyState === slot.host.OPEN
                  && slot.phone && slot.phone.readyState === slot.phone.OPEN;
      const msg = JSON.stringify({ type: bothUp ? 'peer-up' : 'peer-down' });
      for (const ws of [slot.host, slot.phone]) {
        if (!ws || ws.readyState !== ws.OPEN) continue;
        try { ws.send(msg); } catch {}
      }
    }
  } else if (changedRole === 'publish' || changedRole === 'subscribe') {
    const pubUp = slot.publish && slot.publish.readyState === slot.publish.OPEN;
    const msg = JSON.stringify({ type: pubUp ? 'publisher-up' : 'publisher-down' });
    for (const sub of slot.subscribe) {
      if (sub.readyState !== sub.OPEN) continue;
      try { sub.send(msg); } catch {}
    }
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[controller-ws] listening on ${HOST}:${PORT}`);
});

process.on('SIGTERM', () => {
  const latency = latencySummary();
  console.log(`[controller-ws] shutting down (peer-forwarded=${peerForwardSent} peer-dropped=${peerDropped} p95=${latency.p95}ms p99=${latency.p99}ms)`);
  wss.close();
  server.close(() => process.exit(0));
});
