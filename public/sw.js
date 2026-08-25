const CACHE_NAME = 'ipq-rdo-v5';
const URLS = ['/', '/app', '/login', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(URLS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(n => Promise.all(n.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) return;
  const accept = e.request.headers.get('accept') || '';
  if (accept.includes('text/html') || e.request.mode === 'navigate') return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
