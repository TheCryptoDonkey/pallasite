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
 * Peer mode (shared-arena 2-player lockstep, asteroid-sats M3):
 *   - Two clients per session, each one a full game runtime.
 *   - Connect with r=peer; slot is NOT chosen by the URL.
 *   - Each client sends `{type:'hello-peer', session, slot:0|1, version:1}`
 *     as the first frame. The broker binds the ws to that slot.
 *   - A third hello-peer (slot taken or both taken) gets
 *     `{type:'session-error', code:'full'}` and the socket closes.
 *   - When both peers are bound, the broker sends each one
 *     `{type:'peer-joined', slot:<other>}`.
 *   - `{type:'frame'|'hash', frame, slot, ...}` from one peer is forwarded
 *     verbatim to the OTHER peer only (never echoed back). Every such
 *     message is ALSO fanned out to every peerwatch socket on the
 *     session (see below).
 *   - On socket close, the surviving peer gets
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
 *   - Any number of watchers per session; orphan-sweep keeps the
 *     session alive while watchers OR peers are connected.
 *   - On connect, broker immediately sends `{type:'peerwatch-ready'}`
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

/** Map sessionId → SessionSlot. */
const sessions = new Map();

const server = http.createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('controller relay, open a websocket\n');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const session = url.searchParams.get('s');
  const role = url.searchParams.get('r');
  const wantsMulti = url.searchParams.get('multi') === '1';
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
    attach(ws, session, role, wantsMulti);
  });
});

function attach(ws, session, role, wantsMulti) {
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
      // Peer-mode slots for shared-arena multiplayer. Index 0 / 1, each
      // populated when the corresponding peer sends `hello-peer`.
      peers: [undefined, undefined],
      // Peerwatch-mode spectators of this peer session. Every frame/hash
      // either peer sends is fanned out to every entry here. Watchers
      // never speak; their `message` handler is a no-op.
      peerWatchers: new Set(),
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
      const hasPeers = !!current.peers[0] || !!current.peers[1];
      const hasPeerWatchers = current.peerWatchers && current.peerWatchers.size > 0;
      const empty = !current.host && !hasPhones && !current.publish && current.subscribe.size === 0 && !hasPeers && !hasPeerWatchers;
      const pairIncomplete = !current.host || !hasPhones;
      const streamIncomplete = !current.publish && current.subscribe.size === 0;
      // A peer session is "incomplete" only if neither slot is bound AND
      // no watchers are present. A watcher-only session is allowed to
      // exist briefly while the peers connect.
      const peerIncomplete = !current.peers[0] && !current.peers[1] && !hasPeerWatchers;
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
    const hasPeers = !!slot.peers[0] || !!slot.peers[1];
    const hasPeerWatchers = slot.peerWatchers && slot.peerWatchers.size > 0;
    const empty = !slot.host && !hasPhones && !slot.publish && slot.subscribe.size === 0 && !hasPeers && !hasPeerWatchers;
    if (empty) sessions.delete(session);
  };
  ws.on('close', closeHandler);
  ws.on('error', closeHandler);
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
    ws.send(JSON.stringify({ type: 'peerwatch-ready' }));
    for (let i = 0; i < 2; i++) {
      if (slot.peers[i]) ws.send(JSON.stringify({ type: 'peer-joined', slot: i }));
    }
  } catch { /* socket may already be closed */ }

  // Silently drop everything the watcher sends. No "they accidentally
  // broadcast over the spectate channel" failure mode.
  ws.on('message', () => { /* read-only */ });

  const closeHandler = () => {
    slot.peerWatchers.delete(ws);
    const hasPhones = slot.multi ? (slot.phones && slot.phones.size > 0) : !!slot.phone;
    const hasPeers = !!slot.peers[0] || !!slot.peers[1];
    const hasPeerWatchers = slot.peerWatchers && slot.peerWatchers.size > 0;
    const empty = !slot.host && !hasPhones && !slot.publish && slot.subscribe.size === 0 && !hasPeers && !hasPeerWatchers;
    if (empty) sessions.delete(session);
  };
  ws.on('close', closeHandler);
  ws.on('error', closeHandler);
}

/** Fan out a peer-originated message to every watcher of this session.
 *  Same backpressure rule as the peer-to-peer forward path. */
function fanOutToWatchers(slot, payload) {
  if (!slot.peerWatchers || slot.peerWatchers.size === 0) return;
  for (const w of slot.peerWatchers) {
    if (w.readyState !== w.OPEN) continue;
    if (w.bufferedAmount > PEER_BACKPRESSURE_BYTES) {
      peerDropped++;
      continue;
    }
    try { w.send(payload); } catch { /* socket transient */ }
  }
}

function attachPeer(slot, session, ws) {
  // Slot is not chosen by the URL; we wait for the client's hello-peer.
  // Until then, ws._peerSlot stays -1 and frame/hash messages are
  // ignored (the client also won't send them before its connect promise
  // resolves on peer-joined).
  ws._peerSlot = -1;

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // peer protocol is text JSON
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'hello-peer') {
      handlePeerHello(slot, ws, msg);
      return;
    }
    if (ws._peerSlot < 0) return;

    if (msg.type === 'frame' || msg.type === 'hash') {
      const payload = data.toString();
      const target = slot.peers[1 - ws._peerSlot];
      if (target && target.readyState === target.OPEN) {
        if (target.bufferedAmount > PEER_BACKPRESSURE_BYTES) {
          peerDropped++;
        } else {
          try { target.send(payload, { binary: false }); } catch {}
        }
      }
      // Fan out the same payload to every peerwatch socket on this
      // session. Spectators see what each peer sent in the order it
      // was sent; deterministic lockstep depends on consistent ordering.
      fanOutToWatchers(slot, payload);
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
      const other = slot.peers[1 - departingSlot];
      if (other && other.readyState === other.OPEN) {
        try { other.send(leftPayload); } catch {}
      }
      // Watchers see peer-left too so the spectator UI can surface
      // "OPPONENT LEFT" alongside the same gameover funnel.
      fanOutToWatchers(slot, leftPayload);
    }
    const hasPhones = slot.multi ? (slot.phones && slot.phones.size > 0) : !!slot.phone;
    const hasPeers = !!slot.peers[0] || !!slot.peers[1];
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

  const requested = msg.slot;
  if (requested !== 0 && requested !== 1) {
    try { ws.send(JSON.stringify({ type: 'session-error', code: 'invalid-slot' })); } catch {}
    try { ws.close(1008, 'invalid-slot'); } catch {}
    return;
  }
  if (slot.peers[requested]) {
    try { ws.send(JSON.stringify({ type: 'session-error', code: 'full' })); } catch {}
    try { ws.close(1013, 'full'); } catch {}
    return;
  }

  slot.peers[requested] = ws;
  ws._peerSlot = requested;

  // Watchers always see a peer-joined the moment a slot is bound, even
  // if the other peer isn't there yet — they may have connected first
  // and need to know when the game becomes startable.
  fanOutToWatchers(slot, JSON.stringify({ type: 'peer-joined', slot: requested }));

  const otherSlot = 1 - requested;
  const other = slot.peers[otherSlot];
  if (other && other.readyState === other.OPEN) {
    // Both peers now present. Notify both so each side's connect
    // promise resolves.
    try { other.send(JSON.stringify({ type: 'peer-joined', slot: requested })); } catch {}
    try { ws.send(JSON.stringify({ type: 'peer-joined', slot: otherSlot })); } catch {}
  }
  // If the other peer isn't here yet, do nothing. They will trigger this
  // same branch (with the slots reversed) when they hello-peer.
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
  console.log(`[controller-ws] shutting down (peer-dropped=${peerDropped})`);
  wss.close();
  server.close(() => process.exit(0));
});
