/**
 * Pallasite service worker — minimal cache-then-network strategy.
 *
 * Strategy:
 *   - HTML: network-first. Fall back to cache if offline so the app still
 *     boots, but always prefer the latest deploy when online.
 *   - Hashed assets / music / backgrounds: cache-first. Vite content-hashes
 *     the filenames, so a stale cache only ever serves the file it was
 *     originally cached against — safe forever.
 *
 * Bump SW_VERSION below to invalidate all caches on the next visit.
 */

const SW_VERSION = 'v208';
const CACHE_HTML = `pallasite-html-${SW_VERSION}`;
const CACHE_ASSET = `pallasite-asset-${SW_VERSION}`;

self.addEventListener('install', () => {
  // Auto-skip waiting on this version bump. The previous policy was to wait
  // for an in-app reload prompt, but the prompt itself was unclickable on
  // iOS — leaving users stranded on a stale bundle with no way to advance.
  // Auto-activate is safe here because the page is reload-driven anyway:
  // the controllerchange handler in main.ts triggers a clean refresh once
  // the new worker takes over, which is what the prompt would have done.
  self.skipWaiting();
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // Lets the page chip surface which SW is actually running, so a
  // stale-cache "I bumped the version but did it take?" suspicion can
  // be settled by glancing at the title rather than DevTools. The page
  // posts { type: 'SW_VERSION_QUERY' } either via the standard channel
  // (we reply on event.source) or with a MessageChannel transferred in
  // event.ports[0] (we reply on the port).
  if (event.data && event.data.type === 'SW_VERSION_QUERY') {
    const reply = { type: 'SW_VERSION', version: SW_VERSION };
    const port = event.ports && event.ports[0];
    if (port) {
      try { port.postMessage(reply); } catch { /* ignore */ }
    } else if (event.source && typeof event.source.postMessage === 'function') {
      try { event.source.postMessage(reply); } catch { /* ignore */ }
    }
  }
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Clean up any caches from previous SW versions
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => !k.endsWith(`-${SW_VERSION}`)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Don't intercept cross-origin requests — let them hit the network direct.
  if (url.origin !== self.location.origin) return;

  // Don't intercept Range-style media requests. HTMLAudioElement and
  // friends use byte-range fetches when streaming media, and Safari
  // requires 206 Partial Content responses. A SW that returns the
  // full body as 200 OK from cache hangs playback after the initial
  // buffer — exactly the "music plays for 5s then stops on mobile"
  // bug. Also skip music entirely (no offline benefit, and the
  // /music/ tree is large enough that caching it bloats storage).
  if (req.headers.has('Range')) return;
  if (url.pathname.startsWith('/music/')) return;

  // HTML / navigation AND the signet-login IIFE: network-first.
  // The IIFE lives at a stable, non-hashed path (`/signet-login.iife.js`), so
  // a deploy that ships a new SDK build needs the SW to fetch fresh — otherwise
  // a previously-cached copy can mask redirect-mode and route users back into
  // the older relay/popup flow on next sign-in.
  const isNav = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');
  const isSdk = url.pathname === '/signet-login.iife.js';
  if (isNav || isSdk) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_HTML);
        cache.put(req, fresh.clone()).catch(() => { /* ignore quota errors */ });
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached ?? new Response('Offline.', { status: 503, statusText: 'Offline' });
      }
    })());
    return;
  }

  // Static assets: cache-first (content-hashed by Vite, safe to keep forever).
  // Music is NOT in this list — see Range/music skip earlier. Audio
  // media files need network passthrough so Safari can byte-range-fetch.
  const isAsset = url.pathname.startsWith('/assets/')
    || url.pathname.startsWith('/backgrounds/')
    || url.pathname.endsWith('.svg')
    || url.pathname.endsWith('.png')
    || url.pathname.endsWith('.webp');
  if (isAsset) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) {
        // Defence: if a previous SW (or browser cache) somehow ended up with an
        // HTML SPA-fallback stored under an asset URL (Caddy used to return 200
        // index.html for missing /assets/* paths), evict and refetch. A module
        // script served as text/html crashes the page on first import.
        const cachedCt = cached.headers.get('content-type') || '';
        const looksLikeAsset = /\.(js|css|map|webp|png|jpe?g|svg|woff2?|opus|mp3|json)$/i.test(url.pathname);
        if (looksLikeAsset && cachedCt.includes('text/html')) {
          const cache = await caches.open(CACHE_ASSET);
          await cache.delete(req);
        } else {
          return cached;
        }
      }
      const fresh = await fetch(req);
      const freshCt = fresh.headers.get('content-type') || '';
      const isCorruptHtmlAsset = /\.(js|css|map|webp|png|jpe?g|svg|woff2?|opus|mp3|json)$/i.test(url.pathname)
                              && freshCt.includes('text/html');
      // Only cache responses that look right. A 200 with text/html on a JS
      // path means the origin served the SPA fallback for a missing file —
      // caching that would mask the bug indefinitely on this device.
      if (fresh.ok && !isCorruptHtmlAsset) {
        const cache = await caches.open(CACHE_ASSET);
        cache.put(req, fresh.clone()).catch(() => { /* ignore quota errors */ });
      }
      return fresh;
    })());
  }
});
