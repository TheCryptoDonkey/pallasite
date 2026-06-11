/**
 * Tiny static file server + faucet reverse-proxy for the Pallasite desktop
 * wrapper. Serves the built `dist/` over http://127.0.0.1 (Chromium treats
 * localhost as a secure context, so the service worker + WebGL behave exactly
 * like production) and proxies `/api/*` to the remote faucet.
 *
 * Serving rules mirror the production Caddy block (docs/600b-caddy.snippet):
 *   - /api/*           → reverse-proxy to the configured faucet origin.
 *   - real files       → served with the right MIME + cache headers.
 *   - missing asset     → clean 404 (so the SW never caches HTML-for-JS, the
 *                         May-2026 MIME-error footgun).
 *   - missing navpath  → index.html (SPA fallback for /controller, /duel, …).
 */

import http from 'node:http';
import https from 'node:https';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

// Extensions that must 404 cleanly when absent rather than falling back to
// index.html — matches the Caddy `@spa` negative matcher.
const ASSET_EXTS = new Set(Object.keys(MIME).filter((e) => e !== '.html'));

/**
 * Reverse-proxy a request to the faucet origin, streaming both ways.
 */
function proxyToFaucet(req, res, faucetOrigin) {
  const target = new URL(req.url, faucetOrigin);
  const isHttps = target.protocol === 'https:';
  const mod = isHttps ? https : http;
  const headers = { ...req.headers };
  // Rewrite Host to the faucet so virtual-hosted origins route correctly.
  headers.host = target.host;
  // We are not a browser; drop hop-by-hop noise that confuses some proxies.
  delete headers.connection;

  const upstream = mod.request(
    target,
    { method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
    }
    res.end(JSON.stringify({ ok: false, error: 'faucet-unreachable', detail: String(err.message || err) }));
  });
  req.pipe(upstream);
}

function cacheHeadersFor(pathname) {
  // Hashed build assets are content-addressed → cache forever.
  if (pathname.startsWith('/assets/')) {
    return { 'cache-control': 'public, max-age=31536000, immutable' };
  }
  // Everything else (sw.js, version.json, index.html, manifest, icons …)
  // must revalidate so a fresh build is picked up on next launch.
  return { 'cache-control': 'no-cache' };
}

async function serveFile(res, filePath, pathname, faucetOrigin, brokerUrl, booth = false) {
  const ext = path.extname(filePath).toLowerCase();

  // Inject runtime config into the SPA shell. The page is served from
  // http://127.0.0.1, so the app must be told the PUBLIC hosts it really talks
  // to (else it signs NIP-98 for localhost → 401 url_mismatch, and targets a
  // non-existent local broker for multiplayer). See apiOrigin() /
  // defaultBrokerWsUrl() in the client.
  //
  // __PALLASITE_BOOTH__ marks the paid booth kiosk: the page turns on
  // pay-to-play and hides every sat-payout surface. Only ever injected by the
  // booth variant, so the public download is unaffected.
  if (path.basename(filePath) === 'index.html' && (faucetOrigin || brokerUrl || booth)) {
    let html = await fs.readFile(filePath, 'utf8');
    const parts = [];
    if (faucetOrigin) parts.push(`window.__PALLASITE_API_ORIGIN__=${JSON.stringify(faucetOrigin)}`);
    if (brokerUrl) parts.push(`window.__PALLASITE_BROKER_URL__=${JSON.stringify(brokerUrl)}`);
    if (booth) parts.push(`window.__PALLASITE_BOOTH__=true`);
    const tag = `<script>${parts.join(';')}</script>`;
    html = html.includes('</head>') ? html.replace('</head>', `${tag}</head>`) : tag + html;
    res.writeHead(200, {
      'content-type': MIME['.html'],
      'content-length': Buffer.byteLength(html),
      ...cacheHeadersFor(pathname),
    });
    res.end(html);
    return;
  }

  const stat = await fs.stat(filePath);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'content-length': stat.size,
    ...cacheHeadersFor(pathname),
  });
  createReadStream(filePath).pipe(res);
}

/**
 * @param {object} opts
 * @param {string} opts.root          absolute path to the built dist/ dir
 * @param {string} opts.faucetOrigin  e.g. "https://pallasite.app" (no trailing /api)
 * @param {string} [opts.host]        bind address (default 127.0.0.1)
 * @param {number} [opts.port]        port (default 0 = ephemeral)
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string}>}
 */
export function startStaticServer({ root, faucetOrigin, brokerUrl = null, booth = false, host = '127.0.0.1', port = 0 }) {
  const indexPath = path.join(root, 'index.html');

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);

      // Faucet API → remote origin.
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        if (!faucetOrigin) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'faucet-disabled' }));
          return;
        }
        proxyToFaucet(req, res, faucetOrigin);
        return;
      }

      // Resolve the request to a file inside root, blocking traversal.
      const rel = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
      let filePath = path.join(root, rel);
      if (!filePath.startsWith(root)) filePath = indexPath;

      // Directory → its index.html.
      if (pathname.endsWith('/')) filePath = path.join(filePath, 'index.html');

      try {
        const stat = await fs.stat(filePath);
        if (stat.isDirectory()) {
          await serveFile(res, path.join(filePath, 'index.html'), pathname, faucetOrigin, brokerUrl, booth);
        } else {
          await serveFile(res, filePath, pathname, faucetOrigin, brokerUrl, booth);
        }
        return;
      } catch {
        // Not a real file. Asset-shaped paths 404 cleanly; everything else is
        // a navigation request and gets the SPA shell.
        const ext = path.extname(pathname).toLowerCase();
        if (ext && ASSET_EXTS.has(ext)) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('404 Not Found');
          return;
        }
        await serveFile(res, indexPath, '/index.html', faucetOrigin, brokerUrl, booth);
        return;
      }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('500 ' + String(err && err.message ? err.message : err));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: actualPort, url: `http://${host}:${actualPort}/` });
    });
  });
}
