/*
 * Academic AI — service worker.
 *
 * Deliberately small, and deliberately distrustful of its own cache.
 *
 * A service worker sits between the user and every request the page makes,
 * which makes it the easiest place in a web application to cause damage that
 * looks like a ghost: a stale page served to the wrong account, an API answer
 * replayed after logout, a session that will not end because the HTML never
 * comes from the network again. This one is written so that none of those are
 * possible, by refusing to cache anything that could ever be personal.
 *
 * The rules, in full:
 *
 *   1. Only same-origin GET requests are handled at all.
 *   2. Anything under /api/ is never touched — always straight to the network.
 *   3. Build output (/_next/static/**) and icons are content-hashed or stable,
 *      so they are cache-first. These are the files that make a repeat visit
 *      feel instant, and they carry no user data.
 *   4. Page navigations go to the network every single time. The response is
 *      never stored. If the network fails, and only then, an offline notice is
 *      shown. This is what keeps login, sessions and every dynamic page exactly
 *      as they behave without a service worker.
 *   5. Everything else falls through untouched.
 */

const VERSION = 'v1';
const STATIC_CACHE = `academic-ai-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';

const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // `reload` so a new deploy cannot pick up an HTTP-cached offline page.
      await cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name !== STATIC_CACHE).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Static build output and icons: safe to keep, and worth keeping. */
function isImmutableAsset(url) {
  return url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (isImmutableAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') {
          const cache = await caches.open(STATIC_CACHE);
          cache.put(request, response.clone());
        }
        return response;
      })(),
    );
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          // Never cached: this response may be a signed-in page belonging to
          // whoever is using the device right now, and only right now.
          return await fetch(request);
        } catch {
          const offline = await caches.match(OFFLINE_URL);
          return (
            offline ??
            new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } })
          );
        }
      })(),
    );
  }
});

/** Lets a freshly deployed worker take over without waiting for a tab close. */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
