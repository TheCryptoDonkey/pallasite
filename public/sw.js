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

const SW_VERSION = 'v56';
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

  // Static assets: cache-first (content-hashed by Vite, safe to keep forever)
  const isAsset = url.pathname.startsWith('/assets/')
    || url.pathname.startsWith('/music/')
    || url.pathname.startsWith('/backgrounds/')
    || url.pathname.endsWith('.svg')
    || url.pathname.endsWith('.png')
    || url.pathname.endsWith('.webp');
  if (isAsset) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      if (fresh.ok) {
        const cache = await caches.open(CACHE_ASSET);
        cache.put(req, fresh.clone()).catch(() => { /* ignore quota errors */ });
      }
      return fresh;
    })());
  }
});
