/* Офлайн-режим «Журнала репетитора».
   Стратегия: отдаём из кэша сразу, в фоне обновляем с сервера —
   свежая версия подхватывается при следующем открытии. */
const CACHE = 'tutor-journal-pwa-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest',
                './icon-192.png', './icon-512.png', './icon-maskable.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(cached => {
      const fresh = fetch(e.request).then(net => {
        if (net && net.ok){
          const copy = net.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return net;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
