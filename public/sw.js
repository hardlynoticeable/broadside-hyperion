/**
 * BROADSIDE HYPERION — Root-Scoped Service Worker
 *
 * Cache strategy: Network-First with offline shell fallback.
 * Strictly classic script execution at root scope (/sw.js).
 * Zero emojis, zero external dependencies.
 */

const CACHE_VERSION = 'broadside-hyperion-v1';

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/spectate',
  '/spectate.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/main.js',
  '/js/spectator.js',
  '/js/renderer.js',
  '/js/controls-helm.js',
  '/js/controls-weapons.js',
  '/js/controls-engineer.js',
  '/js/textures.js',
  '/js/pwa.js',
  '/vendor/three.module.js',
  '/vendor/three.core.js',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL_ASSETS))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('broadside-hyperion-') && key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function shouldBypassRequest(request) {
  if (!request || request.method !== 'GET') {
    return true;
  }

  let url;
  try {
    url = new URL(request.url, self.location ? self.location.origin : undefined);
  } catch {
    return true;
  }

  if (self.location && url.origin !== self.location.origin) {
    return true;
  }

  if (url.pathname.startsWith('/api/')) {
    return true;
  }

  const upgradeHeader =
    request.headers?.get?.('upgrade') ||
    (typeof request.headers?.upgrade === 'string' ? request.headers.upgrade : '');
  if (url.pathname.startsWith('/ws') || String(upgradeHeader).toLowerCase() === 'websocket') {
    return true;
  }

  const hasRange = Boolean(
    request.headers?.has?.('range') ||
      (request.headers && typeof request.headers === 'object' && 'range' in request.headers && request.headers.range)
  );
  if (hasRange || url.pathname.startsWith('/music/')) {
    return true;
  }

  if (url.pathname === '/sw.js') {
    return true;
  }

  return false;
}

async function handleNetworkFirst(request) {
  let networkError = null;

  try {
    const networkRes = await fetch(request);
    if (networkRes && networkRes.ok && networkRes.status === 200) {
      try {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put(request, networkRes.clone());
      } catch {
        // Cache put errors are non-fatal
      }
      return networkRes;
    }
    if (networkRes) {
      return networkRes;
    }
  } catch (err) {
    networkError = err;
  }

  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }

  let url;
  try {
    url = new URL(request.url, self.location ? self.location.origin : undefined);
  } catch {
    url = null;
  }

  const acceptHeader =
    request.headers?.get?.('accept') ||
    (typeof request.headers?.accept === 'string' ? request.headers.accept : '');
  const isNavigation = request.mode === 'navigate' || acceptHeader.includes('text/html');

  if (isNavigation && url) {
    if (url.pathname.startsWith('/spectate')) {
      const fallback = (await cache.match('/spectate.html')) || (await cache.match('/spectate'));
      if (fallback) {
        return fallback;
      }
    } else {
      const fallback = (await cache.match('/index.html')) || (await cache.match('/'));
      if (fallback) {
        return fallback;
      }
    }
  }

  if (networkError) {
    throw networkError;
  }
  throw new Error(`Fetch failed and no cache available for ${request.url}`);
}

self.addEventListener('fetch', (event) => {
  if (shouldBypassRequest(event.request)) {
    return;
  }
  event.respondWith(handleNetworkFirst(event.request));
});
