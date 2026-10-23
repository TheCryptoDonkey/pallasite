/**
 * Controller WebSocket relay: inputs only.
 *
 * Pairs phone controllers with big-screen game hosts by sessionId and carries
 * controller inputs and game state between them, nothing else. Every frame an
 * endpoint sends is parsed, checked field by field against a closed grammar
 * (controller-policy.js, vocabulary.js) and REBUILT from the validated fields.
 * Anything outside the grammar is dropped, never forwarded: free text, binary
 * payloads and signing requests do not cross this relay. Strings that survive
 * are members of the operator's vocabulary.json tables or templates whose only
 * parameters are bounded integers; player names are three capital letters.
 *
 * V2 controller sessions authenticate host ownership with a private
 * credential. Legacy (versionless) sessions keep a separate namespace with the
 * same content rules. See README.md for protocol and runtime budgets.
 *
 * Wire:
 *   wss://<host>/?s=<sessionId>&r=<host|phone>          single-player
 *   wss://<host>/?s=<sessionId>&r=host&multi=1          multi-player host
 *   wss://<host>/?s=<sessionId>&r=phone                 phone in either mode
 *   wss://<host>/?s=<sessionId>&r=peer                  shared-arena multiplayer
 *   The roles publish, subscribe and peerwatch are removed (HTTP 410).
 *
 * Hosts (game screens) may be restricted to the operator's own sites with
 * CONTROLLER_HOST_ORIGINS (comma-separated origins; unset allows any origin,
 * for self-hosters). CONTROLLER_ALLOW_LOOPBACK=1 additionally admits
 * http://127.0.0.1 and http://localhost hosts when the list is set.
 *
 * Multi-player mode (host opts in via multi=1):
 *   - Up to MAX_PHONES_PER_SESSION (8 by default) phones may pair.
 *   - Each phone is assigned a player slot (0..MAX-1) on connect.
 *   - Broker sends the phone a welcome frame: {type:'welcome', p:<slot>}.
 *   - Phone-to-host frames get p:<slot> stamped by the broker.
 *   - Host-to-phone frames may include p:<slot> to address one
 *     player; omit p to broadcast to all paired phones.
 *   - peer-up / peer-down to the host carry p:<slot>.
 *
 * Single-player mode (default, backwards compat with Pallasite):
 *   - One host, one phone. New phone connection replaces the old.
 *   - peer-up / peer-down without p.
 *   - No player slot is added; lifecycle frames remain broker-owned.
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
 *   - `{type:'frame'|'frame-set'|'frames'|'hash', ...}` or the negotiated binary
 *     equivalents from one peer are fanned to every OTHER peer (never
 *     echoed back). `frames` is a consecutive input window:
 *     `{type:'frames', slot, base, inputs}`.
 *   - Peers may only exchange game inputs. Each message is parsed, checked and
 *     rebuilt from validated fields; unknown fields are stripped and anything
 *     else (other types, text, nested JSON, a slot the socket does not own,
 *     out-of-range numbers, malformed binary) is dropped, never forwarded:
 *       frame      {type, slot, frame, input}
 *       frame-set  {type, frame, entries:[[slot, input], ...]}   1..64 entries
 *       frames     {type, slot, base, inputs:[input, ...]}       1..32 inputs
 *       hash       {type, slot, frame, hash}
 *     slot is an integer the sender owns, frame/base/input are integers in
 *     0..2^24-1 and hash is a uint32 (see PEER_LIMITS in controller-policy.js).
 *     Binary frames are exact-length (12 / 12 / 9+4n bytes) and are re-encoded
 *     from the same validated fields. `hello-peer` and `bye` are consumed by the
 *     broker. A peer message over PEER_FRAME_BYTES closes the socket (1008).
 *   - Recent frames are kept so a late-joining human peer can replay them.
 *   - On socket close, the surviving peers get
 *     `{type:'peer-left', slot:<departed>, reason}`.
 *   - Backpressure: if the receiving socket's send buffer exceeds
 *     PEER_BACKPRESSURE_BYTES, the forward is dropped and a counter
 *     bumps. Live lockstep tolerates frame loss; the desync canary will
 *     surface any divergence.
 *
 * Listens on 127.0.0.1:8788 by default. Put a TLS-terminating reverse proxy in
 * front. Run under systemd; restart on crash. No state persistence, a server
 * restart drops every paired session.
 */

import { WebSocketServer } from 'ws';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { foregatherGateway } from './foregather.js';
import { OWNER_TOKEN_RE, ownerDigest, ownsSession, phoneFrame, hostFrame, hostOriginPolicy, peerFrame, compileVocabulary, loadVocabulary, PEER_FORWARD_TYPES, PHONE_FRAME_BYTES } from './controller-policy.js';

const PORT = parseInt(process.env.PORT ?? '8788', 10);
/** Closed lists for host-to-phone text; CONTROLLER_VOCABULARY lets a self-hoster supply their own file. */
const vocabulary = compileVocabulary(loadVocabulary(process.env.CONTROLLER_VOCABULARY || undefined));
/** Which sites may open a host (game screen) socket; see hostOriginPolicy. */
const hostOriginAllowed = hostOriginPolicy(process.env);
const HOST = process.env.HOST ?? '127.0.0.1';

/** Hard cap so a leaky client can't blow up memory. */
const MAX_SESSIONS = 4096;
function boundedOption(name, fallback, min, max) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`Invalid ${name}`);
  return value;
}
const MAX_CONNECTIONS = boundedOption('MAX_CONNECTIONS', 128, 2, 4096);
const MAX_CONNECTIONS_PER_CLIENT = boundedOption('MAX_CONNECTIONS_PER_CLIENT', 64, 1, 1024);
const CONNECTION_ATTEMPTS_PER_MINUTE = boundedOption('CONNECTION_ATTEMPTS_PER_MINUTE', 120, 1, 10000);
const MAX_FRAME_BYTES = boundedOption('MAX_FRAME_BYTES', 1024 * 1024, 1024, 4 * 1024 * 1024);
const CONTROLLER_FRAME_BYTES = boundedOption('CONTROLLER_FRAME_BYTES', 64 * 1024, 256, MAX_FRAME_BYTES);
/** Largest message a lockstep peer may send. The biggest legitimate one is a
 *  `hello-peer` naming 64 human and 64 owned slots (about 0.7 KB) or a 64-entry
 *  `frame-set` (about 1 KB); the binary hot path tops out at 1029 bytes. 2 KiB
 *  leaves headroom without letting a peer push anything free-form through. */
const PEER_FRAME_BYTES = boundedOption('PEER_FRAME_BYTES', Math.min(2048, MAX_FRAME_BYTES), 256, MAX_FRAME_BYTES);
const FORWARD_BUFFER_BYTES = boundedOption('FORWARD_BUFFER_BYTES', 256 * 1024, 1024, 4 * 1024 * 1024);
const MESSAGES_PER_SECOND = boundedOption('MESSAGES_PER_SECOND', 240, 10, 2000);
/** Lockstep peers legitimately burst far above controller traffic: one frame per
 *  owned slot per tick, plus the catch-up replay when a human takes over an
 *  AI-filled slot mid-round. Still bounded, but separately from phones/hosts. */
const PEER_MESSAGES_PER_SECOND = boundedOption('PEER_MESSAGES_PER_SECOND', 2000, 10, 20000);
const HEARTBEAT_MS = boundedOption('HEARTBEAT_MS', 5000, 100, 30000);
const CONTROLLER_LEASE_MS = boundedOption('CONTROLLER_LEASE_MS', 3000, 500, 10000);
const OWNER_RETENTION_MS = boundedOption('OWNER_RETENTION_MS', 300000, 100, 900000);
const PEER_REPLAY_BYTES = boundedOption('PEER_REPLAY_BYTES', 8 * 1024 * 1024, 1024, 64 * 1024 * 1024);
const PEER_SESSION_REPLAY_BYTES = boundedOption('PEER_SESSION_REPLAY_BYTES', 1024 * 1024, 512, PEER_REPLAY_BYTES);
let replayBytes = 0;
const clients = new Map();
function clientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const address = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && typeof forwarded === 'string'
    ? forwarded.split(',').at(-1).trim() : req.socket.remoteAddress;
  return ownerDigest(address ?? '');
}
function connectionAllowed(req) {
  const now = Date.now(), key = clientKey(req).toString('hex');
  for (const [id, state] of clients) if (!state.active && now - state.started > 60000) clients.delete(id);
  let state = clients.get(key);
  if (!state) {
    if (clients.size >= 1024) return null;
    state = { started: now, used: 0, active: 0 }; clients.set(key, state);
  }
  if (now - state.started >= 60000) { state.started = now; state.used = 0; }
  state.used++;
  if (state.used > CONNECTION_ATTEMPTS_PER_MINUTE || state.active >= MAX_CONNECTIONS_PER_CLIENT || wss.clients.size >= MAX_CONNECTIONS) return null;
  return state;
}
/** A session that never gets its second peer is orphaned. Drop after
 *  5 minutes so QR codes that were never scanned don't leak the slot. */
const ORPHAN_TIMEOUT_MS = 5 * 60 * 1000;
/** Per multi-mode session, max number of phones that can pair. */
const MAX_PHONES_PER_SESSION = parseInt(process.env.MAX_PHONES ?? '8', 10);
const RECONNECT_GRACE_MS = Math.min(60_000, Math.max(100, Number(process.env.RECONNECT_GRACE_MS ?? 15_000)));
const RESUME_TOKEN_RE = /^[a-f0-9]{64}$/;
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

/** Pair-role: phone↔host controller. Peer-role: symmetric game runtimes for
 *  shared-arena lockstep. The stream and spectator roles (publish, subscribe,
 *  peerwatch) were removed: they forwarded content the relay could not check. */
const ROLES = new Set(['host', 'phone', 'peer']);
const REMOVED_ROLES = new Set(['publish', 'subscribe', 'peerwatch']);

/** Counter for backpressure-dropped peer messages. Surfaced via the
 *  process log on shutdown; not exposed on the wire. */
let peerDropped = 0;
let peerForwardAttempts = 0;
let peerForwardSent = 0;
let peerForwardUnavailable = 0;
let peerForwardErrors = 0;
let peerForwardBytes = 0;
/** Peer messages refused by the input-only policy (malformed, unknown type,
 *  wrong slot, out of range or oversize). A rise on a healthy deployment means
 *  the game started sending something the relay does not know about. */
let peerRejected = 0;
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
const pairingGateway = foregatherGateway();

const server = http.createServer(async (req, res) => {
  if (await pairingGateway(req, res)) return;
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
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.timeout = 15000;
server.maxConnections = MAX_CONNECTIONS * 2;

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

server.on('upgrade', (req, socket, head) => {
  let url;
  try { url = new URL(req.url ?? '/', 'http://x'); } catch { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return; }
  const code = url.searchParams.get('s');
  const role = url.searchParams.get('r');
  const version = url.searchParams.get('v');
  const protectedSession = version === '2';
  const session = protectedSession ? `v2:${code}` : code;
  const wantsMulti = url.searchParams.get('multi') === '1';
  if (REMOVED_ROLES.has(role)) { socket.write('HTTP/1.1 410 Gone\r\n\r\n'); socket.destroy(); return; }
  if (!code || !SESSION_RE.test(code) || !role || !ROLES.has(role) || version !== null && version !== '2' || protectedSession && (code.length < 6 || !['host', 'phone'].includes(role))) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  if (role === 'host' && !hostOriginAllowed(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
  }
  if (protectedSession && role === 'phone' && !sessions.get(session)?.ownerHash) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return;
  }
  const client = connectionAllowed(req);
  if (!client) { socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n'); socket.destroy(); return; }
  if (sessions.size >= MAX_SESSIONS && !sessions.has(session)) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.on('error', () => {});
    client.active++; ws.once('close', () => { client.active--; });
    ws._alive = true; ws.on('pong', () => { ws._alive = true; });
    ws._protected = protectedSession;
    ws._controllerHeartbeat = role === 'phone' && (protectedSession || url.searchParams.get('heartbeat') === '1');
    ws._controllerActivity = Date.now();
    let windowStart = Date.now(), messages = 0;
    ws.on('message', data => {
      const now = Date.now();
      if (now - windowStart >= 1000) { windowStart = now; messages = 0; }
      const oversize = role === 'peer' ? data.length > PEER_FRAME_BYTES : ['host', 'phone'].includes(role) && data.length > CONTROLLER_FRAME_BYTES;
      if (++messages > (role === 'peer' ? PEER_MESSAGES_PER_SECOND : MESSAGES_PER_SECOND) || oversize) {
        if (oversize && role === 'peer') peerRejected++;
        ws._refused = true; ws.close(1008, 'message-budget');
      }
    });
    if (protectedSession && role === 'host') {
      const timer = setTimeout(() => ws.close(1008, 'join-timeout'), 3000);
      ws.once('close', () => clearTimeout(timer));
      ws.once('message', (data, binary) => {
        clearTimeout(timer);
        let join;
        try { if (binary || data.length > 256 || ws._refused) throw Error(); join = JSON.parse(data.toString()); } catch { ws.close(1008, 'invalid-join'); return; }
        if (join?.type !== 'host-join' || Object.keys(join).sort().join(',') !== 'hostToken,type' || typeof join.hostToken !== 'string' || !OWNER_TOKEN_RE.test(join.hostToken)) { ws.close(1008, 'invalid-join'); return; }
        const existing = sessions.get(session);
        if (existing?.ownerHash && !ownsSession(existing.ownerHash, join.hostToken)) {
          ws.send(JSON.stringify({ type: 'error', code: 'host-ownership' })); ws.close(1008, 'host-ownership'); return;
        }
        ws.send(JSON.stringify({ type: 'host-ready', version: 2 }));
        attach(ws, session, role, wantsMulti, ownerDigest(join.hostToken));
      });
      return;
    }
    if (role !== 'phone' || !protectedSession && url.searchParams.get('recover') !== '1') {
      attach(ws, session, role, wantsMulti);
      return;
    }
    // Recovery capabilities travel in a frame, never in a URL or log.
    const timer = setTimeout(() => ws.close(1008, 'join-timeout'), 10_000);
    ws.once('close', () => clearTimeout(timer));
    ws.once('message', (data, binary) => {
      clearTimeout(timer);
      let join;
      try { if (binary || data.length > 256 || ws._refused) throw Error(); join = JSON.parse(data.toString()); } catch { ws.close(1008, 'invalid-join'); return; }
      if (join?.type !== 'controller-join' || join.resumeToken !== undefined && (typeof join.resumeToken !== 'string' || !RESUME_TOKEN_RE.test(join.resumeToken))) {
        ws.close(1008, 'invalid-join'); return;
      }
      ws._resumeToken = join.resumeToken ?? randomBytes(32).toString('hex');
      attach(ws, session, role, wantsMulti);
    });
  });
});

function attach(ws, session, role, wantsMulti, ownerHash) {
  let slot = sessions.get(session);
  if (ws._protected && role === 'phone' && !slot?.ownerHash) { ws.close(1008, 'host-unavailable'); return; }
  if (ws._protected && role === 'host' && !ownerHash) { ws.close(1008, 'host-ownership'); return; }
  if (!slot) {
    slot = {
      host: undefined,
      // Single-mode singleton; left undefined while session is in multi mode.
      phone: undefined,
      // Multi-mode phone Map<playerSlot, ws>. Initialised when a host
      // connects with multi=1. Untouched in single mode.
      phones: undefined,
      recovery: new Map(),
      // Player slot -> the initials that slot's phone sent in phone-context this session.
      // Host frames may repeat initials only if they match (see scrubInitials).
      initials: new Map(),
      multi: false,
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
      // Recent peer frame messages, kept so a late-joining human peer can
      // replay missed frames and pass its lockstep stall check at
      // state.frame=PEER_INPUT_DELAY (5). Sized for ~25 seconds of duel
      // at 60Hz (1500 frames × 2 slots = 3000 entries). The lockstep
      // sim cannot recover from missing the FIRST few frames, so the
      // buffer must include frame 0 to be useful — purged only on
      // session orphan sweep / broker restart.
      recentFrames: [],
      recentFrameCount: 0,
      createdAt: Date.now(),
      ownerHash,
    };
    sessions.set(session, slot);
    // Orphan sweep so unattached sessions don't leak the map slot.
    setTimeout(() => {
      const current = sessions.get(session);
      if (!current || current !== slot) return;
      if (current.ownerHash && current.host && current.host.readyState === current.host.OPEN) return;
      const hasPhones = current.multi
        ? (current.phones && current.phones.size > 0)
        : !!current.phone;
      const hasPeers = peersPresent(current);
      const empty = !current.host && !hasPhones && !hasPeers;
      const pairIncomplete = !current.host || !hasPhones;
      // A peer session is "incomplete" only if no slot is bound.
      const peerIncomplete = !hasPeers;
      if (empty || (pairIncomplete && peerIncomplete)) {
        if (current.host) try { current.host.close(); } catch {}
        if (current.phone) try { current.phone.close(); } catch {}
        if (current.phones) for (const phWs of current.phones.values()) try { phWs.close(); } catch {}
        for (const p of current.peers) if (p) try { p.close(); } catch {}
        if (!current.ownerHash) deleteSession(current, session);
        else dropIfEmpty(current, session);
      }
    }, ORPHAN_TIMEOUT_MS);
  }
  if (ownerHash && !slot.ownerHash) slot.ownerHash = ownerHash;
  clearTimeout(slot.ownerExpiry);
  slot.ownerExpiry = undefined;

  // Peer role has its own attach + message + close flow; the host/phone
  // grammar below doesn't apply. Bail out after wiring it up.
  if (role === 'peer') {
    attachPeer(slot, session, ws);
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
      for (const reservation of slot.recovery.values()) clearTimeout(reservation.timer);
      slot.recovery.clear();
      slot.initials.clear();
      slot.multi = false;
    }
  } else if (role === 'phone') {
    if (slot.multi) {
      if (!slot.phones) slot.phones = new Map();
      let reservation = slot.recovery.get(ws._resumeToken);
      if (reservation && !reservation.ws && reservation.until <= Date.now()) {
        releaseReservation(slot, session, ws._resumeToken);
        reservation = undefined;
      }
      if (reservation?.ws?.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'error', code: 'resume-in-use' }));
        ws.close(1008, 'resume-in-use'); return;
      }
      const playerSlot = reservation?.p ?? findNextSlot(slot.phones, MAX_PHONES_PER_SESSION, slot.recovery);
      if (playerSlot === null) {
        try { ws.send(JSON.stringify({ type: 'error', code: 'session-full', message: 'too many players' })); } catch {}
        try { ws.close(1013, 'session-full'); } catch {}
        return;
      }
      slot.phones.set(playerSlot, ws);
      if (!reservation) slot.initials.delete(playerSlot);
      ws._playerSlot = playerSlot;
      ws._resumed = !!reservation;
      if (ws._resumeToken) {
        clearTimeout(reservation?.timer);
        slot.recovery.set(ws._resumeToken, { p: playerSlot, ws });
      }
      try { ws.send(JSON.stringify({ type: 'welcome', p: playerSlot,
        ...(ws._resumeToken ? { resumeToken: ws._resumeToken, resumed: ws._resumed } : {}) })); } catch {}
    } else {
      // Single-mode (current behaviour): singleton phone, new replaces old.
      if (slot.phone) try { slot.phone.close(1000, 'replaced'); } catch {}
      slot.phone = ws;
      slot.initials.delete(0);
    }
  }

  notifyPeerState(slot, role, ws, 'connect');

  ws.on('message', (data, isBinary) => {
    if (ws._refused) return;
    if (role === 'phone' && !isBinary && data.length < 128) {
      try {
        const type = JSON.parse(data.toString()).type;
        if (type === 'controller-heartbeat') { ws._controllerActivity = Date.now(); return; }
        if (type === 'controller-leave') {
          ws._abandoned = true;
          ws.close(1000, 'left-game');
          return;
        }
      } catch { /* Ordinary input follows the existing routing path. */ }
    }
    if (role === 'phone') ws._controllerActivity = Date.now();
    forwardMessage(slot, role, ws, data, isBinary);
  });

  let disconnected = false;
  const closeHandler = () => {
    if (disconnected) return;
    disconnected = true;
    if (role === 'phone') {
      if (slot.multi && slot.phones && ws._playerSlot !== undefined) {
        if (slot.phones.get(ws._playerSlot) === ws) {
          slot.phones.delete(ws._playerSlot);
          const reservation = slot.recovery.get(ws._resumeToken);
          if (reservation?.ws === ws) {
            if (ws._abandoned) slot.recovery.delete(ws._resumeToken);
            else {
              reservation.ws = null;
              reservation.until = Date.now() + RECONNECT_GRACE_MS;
              ws._recoveringUntil = reservation.until;
              reservation.timer = setTimeout(() => releaseReservation(slot, session, ws._resumeToken), RECONNECT_GRACE_MS);
            }
          }
        } else {
          return; // A stale socket cannot remove or suspend its replacement.
        }
      } else if (slot.phone === ws) {
        slot.phone = undefined;
      } else {
        return;
      }
    } else if (slot.host === ws) {
      slot.host = undefined;
    } else {
      return;
    }
    notifyPeerState(slot, role, ws, 'disconnect');
    const hasPhones = slot.multi ? (slot.phones && slot.phones.size > 0) : !!slot.phone;
    const hasPeers = peersPresent(slot);
    const empty = !slot.host && !hasPhones && !hasPeers;
    if (empty) dropIfEmpty(slot, session);
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
    peerSessions: 0,
    peers: 0,
    recentFramePayloads: 0,
    recentFrameBytes: replayBytes,
  };
  for (const slot of sessions.values()) {
    if (slot.host) out.hosts++;
    if (slot.phone) out.phones++;
    if (slot.phones) out.multiPhones += slot.phones.size;
    if (peersPresent(slot)) out.peerSessions++;
    if (Array.isArray(slot.peers)) out.peers += slot.peers.filter(Boolean).length;
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
      rejected: peerRejected,
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
      if (!forwardBounded(target, payload, Buffer.isBuffer(payload))) break;
    }
  } catch { /* socket may already be closed */ }
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
  if (msg && msg.type === 'frame-set' && Array.isArray(msg.entries)) return Math.max(0, msg.entries.length);
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
  const bytes = (Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload))) + Buffer.byteLength(JSON.stringify(msg));
  const frameBufferLimit = Math.max(1, (slot.peerCount || 2)) * PEER_FRAME_BUFFER_PER_PLAYER;
  while (slot.recentFrames.length && (slot.recentFrameCount + count > frameBufferLimit || (slot.recentReplayBytes ?? 0) + bytes > PEER_SESSION_REPLAY_BYTES || replayBytes + bytes > PEER_REPLAY_BYTES)) {
    const dropped = slot.recentFrames.shift();
    slot.recentFrameCount -= dropped.count;
    slot.recentReplayBytes -= dropped.bytes; replayBytes -= dropped.bytes;
  }
  if (bytes > PEER_SESSION_REPLAY_BYTES || replayBytes + bytes > PEER_REPLAY_BYTES) return;
  slot.recentFrames.push({ payload: Buffer.isBuffer(payload) ? Buffer.from(payload) : String(payload), msg, count, bytes });
  slot.recentFrameCount += count;
  slot.recentReplayBytes = (slot.recentReplayBytes ?? 0) + bytes; replayBytes += bytes;
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
    if (ws._refused) return;
    // Peers may only exchange game inputs. Anything that is not a well-formed
    // frame/frame-set/frames/hash for a slot this socket owns is dropped, and
    // what is forwarded is rebuilt from the validated fields, never relayed.
    let msg;
    let payload;
    if (isBinary) {
      msg = decodePeerBinaryPayload(data);
      if (!msg || ws._peerBinaryFrames !== true) { peerRejected++; return; }
    } else {
      try { msg = JSON.parse(data.toString()); } catch { peerRejected++; return; }
    }
    if (!msg || typeof msg.type !== 'string') { peerRejected++; return; }

    if (msg.type === 'hello-peer') {
      // Consumed by the broker (slot binding); its contents are never relayed.
      if (isBinary) { peerRejected++; return; }
      handlePeerHello(slot, ws, msg);
      return;
    }
    if (ws._peerSlot < 0) { peerRejected++; return; }

    if (PEER_FORWARD_TYPES.has(msg.type)) {
      msg = peerFrame(msg, (ws._peerSlots ?? [ws._peerSlot]).filter(index => slot.peers[index] === ws));
      if (!msg) { peerRejected++; return; }
      payload = isBinary ? encodePeerBinaryPayload(msg) : JSON.stringify(msg);
      if (!payload) { peerRejected++; return; }
      if (msg.type === 'frame' || msg.type === 'frame-set' || msg.type === 'frames') {
        const latest = peerFrameLatestFrame(msg);
        if (latest > (slot.peerLatestFrame ?? -1)) slot.peerLatestFrame = latest;
      }
      const forwarded = new Set();
      for (let i = 0; i < (slot.peerCount || 2); i++) {
        const target = slot.peers[i];
        // Skip empty slots, our own socket (a booth may own several slots),
        // and any socket already sent this frame (multi-slot owners).
        if (!target || target === ws || forwarded.has(target)) continue;
        forwarded.add(target);
        sendPeerPayload(target, peerPayloadForTarget(target, payload, msg), peerForwardDelayMs(msg, ws._peerSlot, i));
      }
      // Buffer frames (only — not hashes) so a late-joining human peer can
      // replay them. Hashes are 1/60 the rate and a late peer can resync
      // from the next live one. Cap at PEER_FRAME_BUFFER entries; oldest
      // dropped first.
      if (msg.type === 'frame' || msg.type === 'frames' || msg.type === 'frame-set') {
        rememberPeerFramePayload(slot, payload, msg);
      }
      return;
    }

    if (msg.type === 'bye') {
      try { ws.close(1000, 'bye'); } catch {}
      return;
    }
    peerRejected++;
  });

  const closeHandler = () => {
    const owned = Array.isArray(ws._peerSlots) ? ws._peerSlots : (ws._peerSlot >= 0 ? [ws._peerSlot] : []);
    const freed = [];
    for (const os of owned) {
      if (slot.peers[os] === ws) { slot.peers[os] = undefined; freed.push(os); }
    }
    for (const departingSlot of freed) {
      const leftPayload = JSON.stringify({ type: 'peer-left', slot: departingSlot, reason: 'disconnect' });
      const told = new Set();
      for (let i = 0; i < (slot.peerCount || 2); i++) {
        const other = slot.peers[i];
        if (!other || other === ws || told.has(other) || other.readyState !== other.OPEN) continue;
        told.add(other);
        try { other.send(leftPayload); } catch {}
      }
    }
    const hasPhones = slot.multi ? (slot.phones && slot.phones.size > 0) : !!slot.phone;
    const hasPeers = peersPresent(slot);
    const empty = !slot.host && !hasPhones && !hasPeers;
    if (empty) deleteSession(slot, session);
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
    slot.peerCount = desiredPeerCount;
    slot.peers.length = desiredPeerCount;
    slot.peerHumanSlots = undefined;
    slot.peerTakeovers = {};
    slot.peerLatestFrame = -1;
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
  // A single socket may drive MORE than one slot locally — a couch booth
  // linked to the other booth owns e.g. slots [0,1] on one machine. ownedSlots
  // defaults to just [requested], so one-slot peers are unchanged. Every owned
  // slot must be in range; the primary (requested) is always included.
  let ownedSlots = [requested];
  if (Array.isArray(msg.ownedSlots) && msg.ownedSlots.length > 0) {
    const cleaned = [];
    for (const v of msg.ownedSlots) {
      const n = Math.floor(Number(v));
      if (!Number.isInteger(n) || n < 0 || n >= (slot.peerCount || 2)) {
        try { ws.send(JSON.stringify({ type: 'session-error', code: 'invalid-slot' })); } catch {}
        try { ws.close(1008, 'invalid-slot'); } catch {}
        return;
      }
      if (!cleaned.includes(n)) cleaned.push(n);
    }
    if (!cleaned.includes(requested)) cleaned.push(requested);
    cleaned.sort((a, b) => a - b);
    ownedSlots = cleaned;
  }

  for (const os of ownedSlots) {
    if (slot.peers[os] && slot.peers[os] !== ws) {
      const previous = slot.peers[os];
      slot.peers[os] = undefined;
      try { previous.close(1000, 'replaced'); } catch {}
    }
    slot.peers[os] = ws;
  }
  ws._peerSlot = requested;
  ws._peerSlots = ownedSlots;
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
    replayRecentPeerFrames(ws, slot);
    if (lateTakeoverFrame === null) closeAiFilledPeerSlots(slot);
  } else {
    sendSessionConfig(ws, slot);
    replayRecentPeerFrames(ws, slot);
  }

  // Tell every OTHER bound socket about each of our owned slots (dedup by
  // socket so a multi-slot owner is told once per joined slot), and tell us
  // about each already-bound slot we don't own.
  const otherSockets = new Set();
  for (let i = 0; i < (slot.peerCount || 2); i++) {
    const other = slot.peers[i];
    if (other && other !== ws && other.readyState === other.OPEN) otherSockets.add(other);
  }
  for (const other of otherSockets) {
    for (const os of ownedSlots) { try { other.send(peerJoinedPayload(slot, os)); } catch {} }
  }
  for (let i = 0; i < (slot.peerCount || 2); i++) {
    if (ownedSlots.includes(i)) continue;
    if (slot.peerHumanSlots && !slot.peerHumanSlots.includes(i)) continue;
    if (slot.peers[i] && slot.peers[i] !== ws) { try { ws.send(peerJoinedPayload(slot, i)); } catch {} }
  }
  // If more peers are still absent, do nothing. Each arrival triggers this
  // same branch and all connected clients count joined slots locally.
}

function releaseReservation(slot, session, token) {
  const reservation = slot.recovery.get(token);
  if (!reservation || reservation.ws) return;
  clearTimeout(reservation.timer);
  slot.recovery.delete(token);
  if (slot.host && slot.host.readyState === slot.host.OPEN) {
    slot.host.send(JSON.stringify({ type: 'peer-down', p: reservation.p }));
  }
  dropIfEmpty(slot, session);
}

function dropIfEmpty(slot, session) {
  if (sessions.get(session) !== slot || slot.host || slot.phone || slot.phones?.size || peersPresent(slot) || slot.recovery.size) return;
  if (!slot.ownerHash) { deleteSession(slot, session); return; }
  if (slot.ownerExpiry) return;
  slot.ownerExpiry = setTimeout(() => {
    slot.ownerExpiry = undefined;
    if (sessions.get(session) === slot && !slot.host && !slot.phone && !slot.phones?.size && !slot.recovery.size) deleteSession(slot, session);
  }, OWNER_RETENTION_MS);
  slot.ownerExpiry.unref();
}

function deleteSession(slot, session) {
  if (sessions.get(session) !== slot) return;
  replayBytes -= slot.recentReplayBytes ?? 0;
  slot.recentReplayBytes = 0; slot.recentFrameCount = 0; slot.recentFrames.length = 0;
  clearTimeout(slot.ownerExpiry); sessions.delete(session);
}

function findNextSlot(phones, max, recovery = new Map()) {
  const reserved = new Set([...recovery.values()].map(entry => entry.p));
  for (let i = 0; i < max; i++) {
    if (!phones.has(i) && !reserved.has(i)) return i;
  }
  return null;
}

/**
 * Host and phone frames cross the relay only as a rebuilt copy of validated
 * fields (phoneFrame, hostFrame). Binary frames, oversized phone frames and
 * anything outside the grammar are dropped; the socket stays open.
 */
function forwardMessage(slot, role, ws, data, isBinary) {
  if (ws._refused) return;
  if (role === 'host' && slot.host !== ws) return;
  if (isBinary || role === 'phone' && data.length > PHONE_FRAME_BYTES) return;
  let value;
  try { value = JSON.parse(data.toString()); } catch { return; }
  const frame = role === 'phone'
    ? phoneFrame(value, slot.multi ? ws._playerSlot : undefined)
    : hostFrame(value, slot.multi, MAX_PHONES_PER_SESSION, vocabulary, number => slot.initials.get(number));
  if (!frame) return;
  if (role === 'phone' && frame.type === 'phone-context') {
    const key = slot.multi ? ws._playerSlot : 0;
    if (frame.name) slot.initials.set(key, frame.name); else slot.initials.delete(key);
  }
  const payload = JSON.stringify(frame);
  if (role === 'host') {
    if (slot.multi && slot.phones) {
      if (frame.p !== undefined) {
        const target = slot.phones.get(frame.p);
        if (target && target.readyState === target.OPEN) forwardBounded(target, payload, false);
        return;
      }
      // No p field: broadcast to all paired phones.
      for (const phWs of slot.phones.values()) {
        if (phWs.readyState !== phWs.OPEN) continue;
        forwardBounded(phWs, payload, false);
      }
    } else if (slot.phone && slot.phone.readyState === slot.phone.OPEN) {
      forwardBounded(slot.phone, payload, false);
    }
  } else if (role === 'phone') {
    if (slot.multi && slot.phones?.get(ws._playerSlot) !== ws || !slot.multi && slot.phone !== ws || ws._abandoned) return;
    if (!slot.host || slot.host.readyState !== slot.host.OPEN) return;
    forwardBounded(slot.host, payload, false);
  }
}

function forwardBounded(socket, data, binary) {
  if (socket.readyState !== socket.OPEN) return false;
  if (socket.bufferedAmount > FORWARD_BUFFER_BYTES) { socket.terminate(); return false; }
  try { socket.send(data, { binary }); return true; } catch { socket.terminate(); return false; }
}

let lastPing = Date.now();
const heartbeat = setInterval(() => {
  const now = Date.now(), ping = now - lastPing >= HEARTBEAT_MS;
  for (const ws of wss.clients) {
    if (ws._controllerHeartbeat && now - ws._controllerActivity > CONTROLLER_LEASE_MS) { ws.terminate(); continue; }
    if (ping) {
      if (!ws._alive) { ws.terminate(); continue; }
      ws._alive = false; try { ws.ping(); } catch { ws.terminate(); }
    }
  }
  if (ping) lastPing = now;
}, Math.min(500, HEARTBEAT_MS));
heartbeat.unref();

function notifyPeerState(slot, changedRole, changedWs, eventType) {
  if (changedRole === 'host') {
    if (slot.multi && slot.phones) {
      const up = !!slot.host && slot.host.readyState === slot.host.OPEN;
      const msg = JSON.stringify({ type: up ? 'host-up' : 'host-down' });
      for (const phWs of slot.phones.values()) {
        if (phWs.readyState !== phWs.OPEN) continue;
        try { phWs.send(msg); } catch {}
        if (up) try { slot.host.send(JSON.stringify({ type: 'peer-up', p: phWs._playerSlot, resumed: true })); } catch {}
      }
      if (up) for (const reservation of slot.recovery.values()) {
        if (!reservation.ws) try { slot.host.send(JSON.stringify({ type: 'peer-suspended', p: reservation.p, graceMs: Math.max(0, reservation.until - Date.now()) })); } catch {}
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
        const msg = JSON.stringify({ type: up ? 'peer-up' : changedWs._recoveringUntil ? 'peer-suspended' : 'peer-down', p: playerSlot,
          ...(up ? { resumed: changedWs._resumed === true } : changedWs._recoveringUntil ? { graceMs: Math.max(0, changedWs._recoveringUntil - Date.now()) } : {}) });
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
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[controller-ws] listening on ${HOST}:${server.address().port}`);
});

process.on('SIGTERM', () => {
  clearInterval(heartbeat);
  const latency = latencySummary();
  console.log(`[controller-ws] shutting down (peer-forwarded=${peerForwardSent} peer-dropped=${peerDropped} p95=${latency.p95}ms p99=${latency.p99}ms)`);
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close(() => process.exit(0));
});
