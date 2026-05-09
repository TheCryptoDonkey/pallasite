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

const SW_VERSION = 'v1';
const CACHE_HTML = `pallasite-html-${SW_VERSION}`;
const CACHE_ASSET = `pallasite-asset-${SW_VERSION}`;

self.addEventListener('install', () => {
  // Skip waiting so the new SW activates the moment the user reloads,
  // rather than only after every tab closes.
  self.skipWaiting();
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

  // HTML / navigation: network-first
  const isNav = req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html');
  if (isNav) {
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
    || url.pathname.endsWith('.webp')
    || url.pathname === '/signet-login.iife.js';
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
