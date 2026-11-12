// Caches the app shell so it opens fast. Data always comes live from the sheet.
const CACHE = 'accounting-v7';
const SHELL = ['./', 'index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icons/icon-180.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // never cache Apps Script calls
  if (e.request.method !== 'GET') return;
  // Network first, cache as fallback, so updates show up right away. "no-cache" makes the
  // phone ask GitHub for the newest file instead of using its own copy for up to 10 minutes.
  const fresh = new Request(e.request.url, { cache: 'no-cache', credentials: 'same-origin' });
  e.respondWith(
    fetch(fresh).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
