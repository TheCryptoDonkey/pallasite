// Donut Invaders offline cache. Scope is /donuts/ only, so it never touches Pallasite.
const CACHE = 'donut-invaders-v2';
const FILES = ['./', 'index.html', 'game.js', 'face.png', 'manifest.webmanifest',
  'fonts/bungee.woff2', 'fonts/bungee-shade.woff2', 'fonts/silkscreen-400.woff2', 'fonts/silkscreen-700.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('donut-invaders-') && k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// Network first so updates land straight away; cache is the offline fallback.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
