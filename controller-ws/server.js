/**
 * Pallasite controller WebSocket relay.
 *
 * Pairs phone controllers with big-screen game hosts by sessionId.
 * Once both sides connect, messages from either are forwarded to the
 * other verbatim. No signing, no event semantics, no per-message
 * validation — the sessionId in the QR code IS the auth (32-bit
 * random, exists for the brief pairing window only).
 *
 * Wire (by role):
 *   wss://controller.pallasite.app/?s=<sessionId>&r=host
 *   wss://controller.pallasite.app/?s=<sessionId>&r=phone
 *   wss://controller.pallasite.app/?s=<sessionId>&r=publish
 *   wss://controller.pallasite.app/?s=<sessionId>&r=subscribe
 *   wss://controller.pallasite.app/?s=<sessionId>&r=peer&slot=<0|1>
 *
 * Peer role pairs two duel clients into one shared-arena session. The
 * two slots are symmetric — neither is "host". Frame and hash messages
 * from one slot are forwarded verbatim to the other, and the broker
 * sends `peer-joined`/`peer-left` lifecycle events plus
 * `session-error: full` if a third client tries to join an already-
 * paired peer session. See src/peer.ts (WebSocketPeer) for the client.
 *
 * Listens on 127.0.0.1:8788 — Caddy reverse-proxies the public
 * subdomain to it. Run under systemd; restart on crash. No state
 * persistence: a server restart drops every paired session (clients
 * re-pair via a fresh QR).
 */

import { WebSocketServer } from 'ws';
import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '8788', 10);
const HOST = process.env.HOST ?? '127.0.0.1';
/** Hard cap so a leaky client can't blow up memory. Each entry is a
 *  pair of sockets + two strings — ~few KB. 4096 sessions is wildly
 *  more than this product will ever need but keeps the safety rail
 *  in place. */
const MAX_SESSIONS = 4096;
/** A session that never gets its second peer is orphaned. Drop after
 *  5 minutes so QR codes that were never scanned don't leak the slot. */
const ORPHAN_TIMEOUT_MS = 5 * 60 * 1000;

// SESSION_RE accepts the legacy controller pair ids (8 hex chars) AND
// the longer stream ids used by the live frame relay (player master
// pubkey, 64 hex). Anything alphanumeric, 4-128 chars, is fine.
const SESSION_RE = /^[a-z0-9_-]{4,128}$/i;
/** Pair-role: 1-to-1 phone↔host controller. Stream-role: 1-to-many
 *  publisher↔subscribers for live frame broadcast. Peer-role: two duel
 *  clients sharing one arena, slotted 0 and 1. All share session-id
 *  matching; multiplicity rules differ per role. */
const ROLES = new Set(['host', 'phone', 'publish', 'subscribe', 'peer']);

/** Map sessionId → { host?: ws, phone?: ws, createdAt }. */
const sessions = new Map();

const server = http.createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('controller relay — open a websocket\n');
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const session = url.searchParams.get('s');
  const role = url.searchParams.get('r');
  if (!session || !SESSION_RE.test(session) || !role || !ROLES.has(role)) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  let peerSlot = -1;
  if (role === 'peer') {
    const slotStr = url.searchParams.get('slot');
    if (slotStr !== '0' && slotStr !== '1') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    peerSlot = parseInt(slotStr, 10);
  }
  if (sessions.size >= MAX_SESSIONS && !sessions.has(session)) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attach(ws, session, role, peerSlot);
  });
});

function attach(ws, session, role, peerSlot = -1) {
  let slot = sessions.get(session);
  if (!slot) {
    slot = { host: undefined, phone: undefined, publish: undefined, subscribe: new Set(), peers: [undefined, undefined], createdAt: Date.now() };
    sessions.set(session, slot);
    // Orphan sweep so unattached sessions don't leak the map slot.
    setTimeout(() => {
      const current = sessions.get(session);
      if (!current) return;
      const empty = !current.host && !current.phone && !current.publish && current.subscribe.size === 0
                 && !current.peers[0] && !current.peers[1];
      const pairIncomplete = !current.host || !current.phone;
      const streamIncomplete = !current.publish && current.subscribe.size === 0;
      const peersIncomplete = !current.peers[0] || !current.peers[1];
      if (empty || (pairIncomplete && streamIncomplete && peersIncomplete)) {
        if (current.host) try { current.host.close(); } catch {}
        if (current.phone) try { current.phone.close(); } catch {}
        if (current.publish) try { current.publish.close(); } catch {}
        for (const s of current.subscribe) try { s.close(); } catch {}
        for (const p of current.peers) if (p) try { p.close(); } catch {}
        sessions.delete(session);
      }
    }, ORPHAN_TIMEOUT_MS);
  }

  // Multiplicity rules:
  //   host/phone/publish: singleton — new connection replaces old.
  //   subscribe:          many — added to a Set.
  //   peer:               two slots (0, 1). Third joiner is rejected.
  if (role === 'peer') {
    if (slot.peers[peerSlot]) {
      // Slot already taken — reject as a third joiner.
      try { ws.send(JSON.stringify({ type: 'session-error', code: 'full' })); } catch {}
      try { ws.close(1000, 'slot taken'); } catch {}
      return;
    }
    slot.peers[peerSlot] = ws;
  } else if (role === 'subscribe') {
    slot.subscribe.add(ws);
  } else {
    if (slot[role]) {
      try { slot[role].close(1000, 'replaced'); } catch {}
    }
    slot[role] = ws;
  }

  notifyPeerState(slot, role, peerSlot);

  ws.on('message', (data, isBinary) => {
    // Forwarding rules by role:
    //   host → phone (pair)
    //   phone → host (pair)
    //   publish → subscribe* (broadcast)
    //   subscribe → ignored (uplink-only — viewers can't drive)
    //   peer → the OTHER peer slot (1-to-1)
    if (role === 'host' && slot.phone && slot.phone.readyState === slot.phone.OPEN) {
      try { slot.phone.send(data, { binary: isBinary }); } catch {}
    } else if (role === 'phone' && slot.host && slot.host.readyState === slot.host.OPEN) {
      try { slot.host.send(data, { binary: isBinary }); } catch {}
    } else if (role === 'publish') {
      for (const sub of slot.subscribe) {
        if (sub.readyState !== sub.OPEN) continue;
        try { sub.send(data, { binary: isBinary }); } catch {}
      }
    } else if (role === 'peer') {
      const other = slot.peers[peerSlot === 0 ? 1 : 0];
      const otherOpen = !!(other && other.readyState === other.OPEN);
      const debug = process.env.BROKER_DEBUG === '1';
      if (otherOpen) {
        let sendErr = null;
        try { other.send(data, { binary: isBinary }); } catch (e) { sendErr = e; }
        if (debug) {
          // Truncate long messages but keep enough to see frame number + input.
          const preview = isBinary ? `[binary ${data.length}b]` : String(data).slice(0, 120);
          const buffered = other.bufferedAmount ?? -1;
          const status = sendErr ? `SEND_ERR=${String(sendErr)}` : 'sent';
          console.log(`[peer-fwd] from=${peerSlot} to=${peerSlot === 0 ? 1 : 0} ${status} buffered=${buffered} msg=${preview}`);
        }
      } else if (debug) {
        const preview = isBinary ? `[binary ${data.length}b]` : String(data).slice(0, 120);
        const otherState = other ? other.readyState : 'no-peer';
        console.log(`[peer-DROP] from=${peerSlot} to=${peerSlot === 0 ? 1 : 0} otherState=${otherState} msg=${preview}`);
      }
    }
  });

  const closeHandler = () => {
    if (role === 'peer') {
      if (slot.peers[peerSlot] === ws) slot.peers[peerSlot] = undefined;
    } else if (role === 'subscribe') {
      slot.subscribe.delete(ws);
    } else if (slot[role] === ws) {
      slot[role] = undefined;
    }
    notifyPeerState(slot, role, peerSlot);
    const empty = !slot.host && !slot.phone && !slot.publish && slot.subscribe.size === 0
               && !slot.peers[0] && !slot.peers[1];
    if (empty) sessions.delete(session);
  };
  ws.on('close', closeHandler);
  ws.on('error', closeHandler);
}

function notifyPeerState(slot, changedRole, peerSlot = -1) {
  // Peer-role: paired duel clients see peer-joined when both bound and
  // peer-left when the partner closes. peer-joined carries the OTHER
  // slot's index, so each side knows which slot just appeared.
  if (changedRole === 'peer') {
    const a = slot.peers[0];
    const b = slot.peers[1];
    const aUp = a && a.readyState === a.OPEN;
    const bUp = b && b.readyState === b.OPEN;
    if (aUp && bUp) {
      // Tell each peer its partner is up (using the partner's slot index).
      try { a.send(JSON.stringify({ type: 'peer-joined', slot: 1 })); } catch {}
      try { b.send(JSON.stringify({ type: 'peer-joined', slot: 0 })); } catch {}
    } else {
      // One side gone — notify the survivor with the slot that left.
      const survivor = aUp ? a : (bUp ? b : null);
      if (survivor && peerSlot >= 0) {
        try { survivor.send(JSON.stringify({ type: 'peer-left', slot: peerSlot, reason: 'closed' })); } catch {}
      }
    }
    return;
  }
  // Pair-mode (host + phone): both sides see peer-up/down on each other.
  if (changedRole === 'host' || changedRole === 'phone') {
    const bothUp = slot.host && slot.host.readyState === slot.host.OPEN
                && slot.phone && slot.phone.readyState === slot.phone.OPEN;
    const msg = JSON.stringify({ type: bothUp ? 'peer-up' : 'peer-down' });
    for (const ws of [slot.host, slot.phone]) {
      if (!ws || ws.readyState !== ws.OPEN) continue;
      try { ws.send(msg); } catch {}
    }
  }
  // Stream-mode (publish + subscribers):
  //  - On publisher state change, notify all subscribers.
  //  - On subscriber join, just notify that subscriber (so they know
  //    if a publisher is already live).
  if (changedRole === 'publish') {
    const pubUp = slot.publish && slot.publish.readyState === slot.publish.OPEN;
    const msg = JSON.stringify({ type: pubUp ? 'publisher-up' : 'publisher-down' });
    for (const sub of slot.subscribe) {
      if (sub.readyState !== sub.OPEN) continue;
      try { sub.send(msg); } catch {}
    }
  } else if (changedRole === 'subscribe') {
    const pubUp = slot.publish && slot.publish.readyState === slot.publish.OPEN;
    // A subscriber just joined — tell them whether a publisher is live.
    // We don't need to broadcast to other subscribers; only the new one
    // cares. But notifyPeerState is called for both joins AND leaves,
    // so we conservatively notify the whole subscribe set (any closed
    // sockets are skipped by the readyState check above).
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
  console.log('[controller-ws] shutting down');
  wss.close();
  server.close(() => process.exit(0));
});
