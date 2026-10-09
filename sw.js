// Офлайн-оболонка додатка. Дані API не кешуються тут — ними керує js/api.js.
const VERSION = 'fp-v12';
const SHELL = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/config.js', 'js/api.js', 'js/model.js', 'js/history.js', 'js/glossary.js', 'js/slip.js', 'js/app.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
];
const IMG_CACHE = 'fp-img';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== IMG_CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Власні файли: спершу мережа (щоб оновлення приходили одразу), без мережі — кеш.
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }))
    );
    return;
  }

  // Логотипи клубів і ліг: кеш назавжди (вони не змінюються і не витрачають ліміт API).
  if (url.hostname === 'media.api-sports.io') {
    e.respondWith(
      caches.open(IMG_CACHE).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
        c.put(req, res.clone());
        return res;
      })))
    );
  }
});
