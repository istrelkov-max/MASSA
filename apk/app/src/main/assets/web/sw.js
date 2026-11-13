/* massa — service worker: интерфейс живёт на устройстве */
var VERSION = 'massa-v96';
var SHELL = [
  './',
  './index.html',
  './styles.css?v=96',
  './api.js?v=96',
  './app.js?v=96',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(VERSION)
      .then(function (cache) { return cache.addAll(SHELL); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== VERSION;
      }).map(function (key) { return caches.delete(key); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // данные и файлы — только сеть
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/files/') === 0) return;

  // переход по адресу: сеть, при обрыве — сохранённая оболочка
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(function () { return caches.match('./index.html'); })
    );
    return;
  }

  // статика: отдаём из кэша сразу, обновляем в фоне
  event.respondWith(
    caches.match(request).then(function (cached) {
      var network = fetch(request).then(function (response) {
        if (response && response.ok) {
          caches.open(VERSION).then(function (cache) {
            cache.put(request, response.clone());
          });
        }
        return response;
      }).catch(function () { return cached; });

      return cached || network;
    })
  );
});
