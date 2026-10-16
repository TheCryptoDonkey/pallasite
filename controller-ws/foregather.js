import { createHash } from 'node:crypto';

const allowedOrigins = new Set(['https://pad.forgesworn.dev', 'https://tank.forgesworn.dev', 'https://quiz.forgesworn.dev', 'https://tilt.forgesworn.dev']);
const locator = '[A-Za-z0-9_-]{21}[AQgw]';
const roomCode = '[0-9A-HJKMNP-TV-Z]{6}';
const message = '(hello|proof|packet-0)';
const capabilities = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const publicRoutes = [
  ['GET', new RegExp(`^live-sessions/rooms/${roomCode}$`), false],
  ['POST', new RegExp(`^live-sessions/${locator}/claim$`), true],
  ['DELETE', new RegExp(`^live-sessions/${locator}$`), true],
  ['GET', new RegExp(`^live-sessions/${locator}/messages/(inviter|recipient)/${message}$`), true],
  ['PUT', new RegExp(`^live-sessions/${locator}/messages/(inviter|recipient)/${message}$`), true],
];
async function bounded(stream, limit) {
  let timer;
  const read = async () => {
    let size = 0; const parts = [];
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) throw Object.assign(Error('Request too large'), { status: 413 });
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  };
  try {
    return await Promise.race([read(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(Error('Body deadline'), { status: 408 }));
        stream.destroy?.();
      }, 3000);
    })]);
  } finally { clearTimeout(timer); }
}
function validRoom(room) {
  const session = room?.session, clock = Math.floor(Date.now() / 1000);
  return room && Object.keys(room).sort().join(',') === 'secret_format,session' && ['words', 'characters'].includes(room.secret_format)
    && session && Object.keys(session).sort().join(',') === 'expires,issued,locator,namespace,profile,purpose'
    && session.namespace === 'joystick' && session.purpose === 'controller' && session.profile === 'foregather-live/spake2-ed25519/1'
    && new RegExp(`^${locator}$`).test(session.locator) && Number.isSafeInteger(session.issued) && Number.isSafeInteger(session.expires)
    && Math.abs(session.issued - clock) <= 15 && session.expires > clock && session.expires > session.issued && session.expires - session.issued <= 180;
}

/** The application owns anonymous pilot allocation policy; the Rust relay owns protocol state. */
export function foregatherGateway(env = process.env) {
  let endpoint;
  const token = env.FOREGATHER_CREATE_TOKEN;
  if (env.FOREGATHER_API_URL) {
    endpoint = new URL(env.FOREGATHER_API_URL);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/' || !capabilities.test(token ?? '')) throw Error('Invalid private Foregather configuration');
  }
  const clients = new Map();
  let active = 0;
  const originAllowed = origin => !origin || allowedOrigins.has(origin) || env.FOREGATHER_ALLOW_LOOPBACK === '1' && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
  function clientState(req) {
    const clock = Date.now();
    // Caddy supplies the last hop's client address. The value is hashed, bounded and never logged.
    const forwarded = req.headers['x-forwarded-for'];
    const address = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && typeof forwarded === 'string'
      ? forwarded.split(',').at(-1).trim() : req.socket.remoteAddress;
    const key = createHash('sha256').update(address ?? '').digest('hex');
    for (const [id, state] of clients) if (!state.active && clock - state.started > 60_000) clients.delete(id);
    let state = clients.get(key);
    if (!state) {
      if (clients.size >= 1024) return null;
      state = { started: clock, used: 0, lookups: 0, requests: 0, active: 0 }; clients.set(key, state);
    }
    if (clock - state.started >= 60_000) { state.started = clock; state.used = 0; state.lookups = 0; state.requests = 0; }
    return state;
  }
  async function request(method, path, body, capability) {
    const result = await fetch(new URL(path === 'health' ? path : `v1/${path}`, endpoint), {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(capability ? { Authorization: `Bearer ${capability}` } : {}) },
      body, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    const bytes = await bounded(result.body ?? [], 32768);
    return { status: result.status, bytes };
  }
  return async function handle(req, res) {
    let url;
    try { url = new URL(req.url ?? '/', 'http://x'); } catch {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end('{"error":"Invalid request target"}'); return true;
    }
    if (!url.pathname.startsWith('/foregather/')) return false;
    const origin = req.headers.origin;
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin', ...(origin && originAllowed(origin) ? { 'Access-Control-Allow-Origin': origin } : {}) };
    const reply = (status, body) => { res.writeHead(status, headers); res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
    if (!originAllowed(origin)) { reply(403, { error: 'Origin refused' }); return true; }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' }); res.end(); return true;
    }
    if (!endpoint) { reply(503, { error: 'Pairing service unavailable' }); return true; }
    const path = url.pathname.slice('/foregather/'.length);
    if (url.search || active >= 80) { reply(url.search ? 400 : 503, { error: 'Request refused' }); return true; }
    const client = clientState(req);
    if (!client || client.active >= 8 || ++client.requests > 3000) { reply(429, { error: 'Pairing request limit reached' }); return true; }
    if (req.method === 'GET' && path.startsWith('live-sessions/rooms/') && ++client.lookups > 12) { reply(429, { error: 'Pairing lookup limit reached' }); return true; }
    client.active++;
    active++;
    try {
      if (req.method === 'GET' && path === 'healthz') {
        const health = await request('GET', 'health'); reply(health.status === 200 ? 200 : 503, { ok: health.status === 200, experimental: true }); return true;
      }
      if (req.method === 'POST' && path === 'allocate') {
        if (++client.used > 12) { reply(429, { error: 'Pairing creation limit reached' }); return true; }
        if (!req.headers['content-type']?.startsWith('application/json')) { reply(415, { error: 'JSON required' }); return true; }
        let room;
        try { room = JSON.parse(await bounded(req, 2048)); } catch (error) { reply(error.status ?? 400, { error: 'Invalid pairing room' }); return true; }
        if (!validRoom(room)) { reply(400, { error: 'Invalid pairing room' }); return true; }
        const grantResult = await request('POST', 'creation-grants', JSON.stringify({ resource: 'live', expires: Math.floor(Date.now() / 1000) + 60, max_uses: 1, max_invitation_lifetime: 180 }), token);
        if (grantResult.status !== 201) { reply(grantResult.status, { error: 'Pairing creation unavailable' }); return true; }
        const grant = JSON.parse(grantResult.bytes);
        const allocation = await request('POST', 'live-sessions', JSON.stringify(room), grant.token);
        // Issuance credentials and the operator capability stay on the private loopback hop.
        reply(allocation.status, allocation.bytes); return true;
      }
      const route = publicRoutes.find(([method, pattern]) => method === req.method && pattern.test(path));
      if (!route) { reply(404, { error: 'Pairing route not found' }); return true; }
      const capability = req.headers.authorization?.slice('Bearer '.length);
      if (route[2] && (!req.headers.authorization?.startsWith('Bearer ') || !capabilities.test(capability ?? ''))) { reply(401, { error: 'Pairing capability required' }); return true; }
      const body = ['PUT', 'POST'].includes(req.method) ? await bounded(req, 24576) : undefined;
      const result = await request(req.method, path, body?.length ? body : undefined, capability);
      reply(result.status, result.bytes);
    } catch (error) { if (!res.headersSent && !res.destroyed) reply(error.status ?? 502, { error: 'Pairing service request failed' }); }
    finally { active--; client.active--; }
    return true;
  };
}
