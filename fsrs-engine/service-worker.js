// fsrs-engine service worker — app-shell offline caching (M11).
//
// Classic (non-module) service worker: intentionally NOT `{ type: "module" }`
// so it registers correctly in Safari/iOS, which does not support module
// service workers as of this writing, and Safari/iOS is a primary offline
// target for a local-first app. Because of that, this file can't `import`
// lib/pwa.js's pure constants — CACHE_NAME_PREFIX/CACHE_NAME/APP_SHELL_FILES
// below are a deliberate, guarded duplicate. test/pwa.test.js parses this
// file's literal source and asserts it matches lib/pwa.js's exports, so the
// two copies can't silently drift apart.
//
// Strategy: on install, precache the full app shell so a cold, fully
// offline load works from the very first visit after install. On fetch,
// cache-first for anything already cached; otherwise network-first with an
// opportunistic cache write, falling back to the cached app shell for
// navigations if the network is unavailable and the exact URL wasn't
// precached.

const CACHE_NAME_PREFIX = 'fsrs-engine-shell-v';
const CACHE_NAME = 'fsrs-engine-shell-v1';

const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './lib/datetime.js',
  './lib/fsrs.js',
  './lib/fuzz.js',
  './lib/scheduler.js',
  './lib/db.js',
  './lib/queue.js',
  './lib/cloze.js',
  './lib/exportImport.js',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL_FILES))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_NAME_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;

      return fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // Offline and this exact URL was never cached. For a page
          // navigation, fall back to the app shell itself rather than a
          // hard browser error.
          if (request.mode === 'navigate') return caches.match('./index.html');
          return undefined;
        });
    }),
  );
});
