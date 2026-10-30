// Offline cache for the app shell. Study data never pass through this file: requests to the
// study server go straight to the network and are never cached.
const CACHE = 'tbdm-76d293e2baf4';
const FILES = ["./","index.html","app.js","app.css","logic.js","manifest.webmanifest","zxing.min.js","icon-192.png","icon-512.png","icon-maskable-512.png","apple-touch-icon.png"];
// install fetches every file straight from the server (cache: 'reload'): a copy the phone kept for a few minutes must never be saved as the new version
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).catch(() => caches.match('index.html'))));
});
