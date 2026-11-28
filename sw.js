'use strict';

const SCOPE = new URL(self.registration.scope);
// 发布静态资源的任何变更时递增版本号；不同部署目录互不清理缓存。
const VERSION = 'v41';
const CACHE_PREFIX = `yeding-reader:${encodeURIComponent(SCOPE.href)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const STATIC_URLS = new Set([
  './',
  'styles.css?v=41',
  'app.mjs?v=41',
  'reader-core.mjs?v=41',
  'storage.mjs?v=41',
  'tts.mjs?v=41',
  'sync.mjs?v=41',
  'download.mjs?v=41',
  'manifest.webmanifest?v=41',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
].map((path) => new URL(path, SCOPE).href));
const ENTRY_URL = new URL('index.html', SCOPE);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...STATIC_URLS].map((href) => new Request(href, {
      cache: 'reload',
      mode: 'same-origin',
      redirect: 'error',
    })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => (
      name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
    )).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('Range')) return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return;

  let cacheKey;
  if (request.mode === 'navigate') {
    if (url.pathname !== SCOPE.pathname && url.pathname !== ENTRY_URL.pathname) return;
    cacheKey = SCOPE.href;
  } else if (STATIC_URLS.has(url.href)) {
    cacheKey = url.href;
  } else {
    return;
  }

  // 在线优先获取最新版，离线时自动回退本地缓存
  event.respondWith((async () => {
    try {
      const fresh = await fetch(request);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(cacheKey, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      const cached = await caches.match(cacheKey, { cacheName: CACHE_NAME });
      if (cached) return cached;
      throw new Error('offline-and-uncached');
    }
  })());
});
