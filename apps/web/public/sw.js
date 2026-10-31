/*
 * LocalLens service worker. Kept deliberately simple:
 * - App code (/assets/*, hashed file names): cache-first, so the app opens fast and works on a weak signal.
 * - Pages: network-first; offline → the last cached app page, or offline.html.
 * - The API (/api/*) is NEVER cached: it carries personal data (accounts, alerts) and must always be fresh.
 * - Other sites (news photos, maps): left to the browser.
 */
const VERSION = 'v1';
const SHELL = `locallens-shell-${VERSION}`;
const ASSETS = `locallens-assets-${VERSION}`;
const PRECACHE = ['/offline.html', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('locallens-') && k !== SHELL && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // never cache personal or live data

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.open(ASSETS).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      }),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Keep the latest app page for offline starts (copied now: a response body can be read only once).
          if (res.ok && res.headers.get('content-type')?.includes('text/html')) {
            const copy = res.clone();
            event.waitUntil(caches.open(SHELL).then((c) => c.put('/', copy)));
          }
          return res;
        })
        .catch(async () => (await caches.match('/', { cacheName: SHELL })) ?? (await caches.match('/offline.html'))),
    );
  }
});
