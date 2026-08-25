const CACHE_NAME = 'ipq-rdo-v4';
const URLS = ['/', '/app'];

self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(URLS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(n => Promise.all(n.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/') || e.request.url.includes('/socket.io/')) return;
  // NUNCA interceptar HTML - deixa rede resolver e evita loop "Failed to convert value to Response"
  const accept = e.request.headers.get('accept') || '';
  if (accept.includes('text/html') || e.request.mode === 'navigate') return;
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
