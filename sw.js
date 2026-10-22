// Lets the phone app open without internet. The page itself is fetched fresh when online (so updates
// arrive), everything else comes from the cache. GitHub requests are never cached.
const CACHE = 'bookshelf-v1';
const SHELL = [
  './', 'index.html', 'web-bridge.js', 'manifest.webmanifest',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'vendor/fonts/fraunces-500.woff2', 'vendor/fonts/fraunces-600.woff2',
  'vendor/fonts/inter-400.woff2', 'vendor/fonts/inter-500.woff2', 'vendor/fonts/inter-600.woff2',
  'build/icon-192.png', 'build/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const isPage = e.request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname.endsWith('/') || url.pathname.endsWith('web-bridge.js');
  if (isPage) {
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
  }
});
