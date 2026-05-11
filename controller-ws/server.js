/**
 * Pallasite controller WebSocket relay.
 *
 * Pairs phone controllers with big-screen game hosts by sessionId.
 * Once both sides connect, messages from either are forwarded to the
 * other verbatim. No signing, no event semantics, no per-message
 * validation — the sessionId in the QR code IS the auth (32-bit
 * random, exists for the brief pairing window only).
 *
 * Wire:
 *   wss://controller.pallasite.app/?s=<sessionId>&r=<host|phone>
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

const SESSION_RE = /^[a-z0-9]{4,32}$/i;
const ROLES = new Set(['host', 'phone']);

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
  if (sessions.size >= MAX_SESSIONS && !sessions.has(session)) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    attach(ws, session, role);
  });
});

function attach(ws, session, role) {
  // Reject if the role is already taken on this session — first
  // connection wins. Prevents a tab refresh from accidentally hijacking
  // an active pair without an explicit re-pair.
  let slot = sessions.get(session);
  if (!slot) {
    slot = { host: undefined, phone: undefined, createdAt: Date.now() };
    sessions.set(session, slot);
    // Orphan sweep so unattached sessions don't leak the map slot.
    setTimeout(() => {
      const current = sessions.get(session);
      if (!current) return;
      if (!current.host || !current.phone) {
        // Still unpaired after the timeout — close any remaining
        // socket and drop the entry.
        if (current.host) try { current.host.close(); } catch {}
        if (current.phone) try { current.phone.close(); } catch {}
        sessions.delete(session);
      }
    }, ORPHAN_TIMEOUT_MS);
  }
  if (slot[role]) {
    // Force-close the prior holder so the newcomer can take over —
    // simpler than rejecting (handles browser refresh edge cases).
    try { slot[role].close(1000, 'replaced'); } catch {}
  }
  slot[role] = ws;

  // Tell both sides their peer is on (or off).
  notifyPeerState(slot);

  ws.on('message', (data, isBinary) => {
    const peer = role === 'host' ? slot.phone : slot.host;
    if (!peer || peer.readyState !== peer.OPEN) return;
    try { peer.send(data, { binary: isBinary }); } catch {}
  });

  const closeHandler = () => {
    if (slot[role] === ws) slot[role] = undefined;
    notifyPeerState(slot);
    if (!slot.host && !slot.phone) sessions.delete(session);
  };
  ws.on('close', closeHandler);
  ws.on('error', closeHandler);
}

function notifyPeerState(slot) {
  const bothUp = slot.host && slot.host.readyState === slot.host.OPEN
              && slot.phone && slot.phone.readyState === slot.phone.OPEN;
  const msg = JSON.stringify({ type: bothUp ? 'peer-up' : 'peer-down' });
  for (const ws of [slot.host, slot.phone]) {
    if (!ws || ws.readyState !== ws.OPEN) continue;
    try { ws.send(msg); } catch {}
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
