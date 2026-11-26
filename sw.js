'use strict';

const SCOPE = new URL(self.registration.scope);
// 发布静态资源的任何变更时递增版本号；不同部署目录互不清理缓存。
const VERSION = 'v3';
const CACHE_PREFIX = `yeding-reader:${encodeURIComponent(SCOPE.href)}:`;
const CACHE_NAME = `${CACHE_PREFIX}${VERSION}`;
const STATIC_URLS = new Set([
  'index.html',
  'styles.css',
  'app.mjs',
  'reader-core.mjs',
  'storage.mjs',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
].map((path) => new URL(path, SCOPE).href));
const ENTRY_URL = new URL('index.html', SCOPE);

self.addEventListener('install', (event) => {
  // 全部下载成功才安装；不复用浏览器 HTTP 缓存，也不接受重定向。
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll([...STATIC_URLS].map((href) => new Request(href, {
      cache: 'reload',
      mode: 'same-origin',
      redirect: 'error',
    })));
  })());
  // 不调用 skipWaiting：等旧版页面关闭，避免旧页面混用新版脚本。
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => (
      name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
    )).map((name) => caches.delete(name)));
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
    // 目录首页和显式的 index.html 共用同一份预缓存。
    cacheKey = ENTRY_URL.href;
  } else if (STATIC_URLS.has(url.href)) {
    cacheKey = url.href;
  } else {
    return;
  }

  // 只读预缓存；不将其他请求或用户正文写入 Cache Storage。
  event.respondWith((async () => {
    const response = await caches.match(cacheKey, { cacheName: CACHE_NAME });
    return response || fetch(request);
  })());
});
