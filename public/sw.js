// Сервис-воркер Novel Forge: делает приложение устанавливаемым (ярлык + отдельное
// окно без браузерной обвязки) и даёт офлайн-режим. Кэширует только свои ассеты;
// запросы к сторонним API (провайдеры ИИ) НЕ трогает и НЕ кэширует.

const CACHE = 'nf-cache-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Чужие домены (эндпоинты ИИ, картинки-провайдеры и т.п.) — мимо кэша.
  if (url.origin !== self.location.origin) return;

  // Навигации — network-first, при офлайне отдаём кэшированную оболочку.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put(req, net.clone());
          return net;
        } catch {
          const cache = await caches.open(CACHE);
          return (
            (await cache.match(req)) ||
            (await cache.match('/index.html')) ||
            (await cache.match('/')) ||
            Response.error()
          );
        }
      })()
    );
    return;
  }

  // Статика (JS/CSS/wasm/иконки) — cache-first, затем сеть с докэшированием.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const net = await fetch(req);
        if (net && net.ok && net.status === 200 && net.type !== 'opaque') {
          cache.put(req, net.clone());
        }
        return net;
      } catch {
        return cached || Response.error();
      }
    })()
  );
});
