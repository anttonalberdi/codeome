const VERSION = '5';
const CACHE = `codeome-mobile-v${VERSION}`;
const SHELL = ['/', '/index.html', '/app.js', '/render.js', '/md.js', '/app.css',
  '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(async (response) => {
    if (response.ok) {
      try {
        const cache = await caches.open(CACHE);
        await cache.put(url.pathname, response.clone());
      } catch { /* Keep the network response if storage is unavailable. */ }
    }
    return response;
  }).catch(() => caches.match(url.pathname)));
});
