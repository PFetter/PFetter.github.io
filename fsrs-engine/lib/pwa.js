// PWA app-shell caching (M11) — pure, testable logic.
//
// Service workers run in a browser-only global scope (self, caches,
// install/activate/fetch events) that doesn't exist under `node --test`, so
// — same split as db.js's real IndexedDB adapter — the decidable logic
// (what belongs in the app shell, which old caches are stale, which
// requests the cache strategy should touch) lives here and is tested
// directly; service-worker.js is a thin, browser-only artifact.
//
// service-worker.js is a *classic* (non-module) worker, not `{ type:
// "module" }`, because Safari/iOS does not support module service workers
// as of this writing and Safari/iOS is a primary offline target for a
// local-first app. That means it can't `import` this file and necessarily
// duplicates CACHE_NAME_PREFIX/CACHE_VERSION/APP_SHELL_FILES below.
// test/pwa.test.js parses service-worker.js's literal source and asserts it
// matches these exports, so the two copies can't silently drift apart.

export const CACHE_NAME_PREFIX = 'fsrs-engine-shell-v';
export const CACHE_VERSION = 1; // bump whenever APP_SHELL_FILES changes
export const CACHE_NAME = `${CACHE_NAME_PREFIX}${CACHE_VERSION}`;

// Every file needed to render and run the app with zero network access.
// Paths are relative to the service worker's scope (repo root on GitHub
// Pages), matching index.html's own relative import paths — required for
// correctness under GitHub Pages project-site subpath hosting.
export const APP_SHELL_FILES = Object.freeze([
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
]);

// Which previously-cached app-shell versions should be evicted on activate.
// Pure string filtering — no Cache Storage API needed to decide this.
export function staleCacheNames(existingCacheNames, currentCacheName = CACHE_NAME, prefix = CACHE_NAME_PREFIX) {
  return existingCacheNames.filter((name) => name.startsWith(prefix) && name !== currentCacheName);
}

// Whether a fetch event's request should be handled by the app-shell cache
// strategy at all. Same-origin GET only: there is no cross-origin network
// traffic anywhere in this app by design (v1 scope is zero third-party
// dependencies), so this mainly excludes non-GET requests and anything
// outside our own origin (e.g. browser-extension requests).
export function isCacheableRequest(request, origin) {
  if (request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return origin ? url.origin === origin : true;
}
