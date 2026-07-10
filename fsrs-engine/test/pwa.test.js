// M11 — PWA offline caching (app-shell).
//
// Service workers run in a browser-only global scope (`self`, `caches`,
// install/activate/fetch events) that doesn't exist under `node --test` —
// confirmed: `typeof self === 'undefined'` in Node even though `Request`/
// `URL` are real Node globals via undici (no dependency needed for those).
// So, same split as db.js's real IndexedDB adapter: the pure, decidable
// logic lives in lib/pwa.js and is tested directly; service-worker.js is a
// thin, browser-only artifact exercised manually (see README "Verifying
// offline support").
//
// service-worker.js is a *classic* (non-module) worker — Safari/iOS doesn't
// support `{ type: "module" }` service workers — so it can't `import`
// lib/pwa.js and necessarily duplicates the cache name and app-shell file
// list. The drift-guard test at the bottom of this file parses
// service-worker.js's literal source and asserts those two copies match, so
// they can't silently diverge (same cross-validation instinct as the
// oracle-checked FSRS conformance tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CACHE_NAME_PREFIX,
  CACHE_VERSION,
  CACHE_NAME,
  APP_SHELL_FILES,
  staleCacheNames,
  isCacheableRequest,
} from '../lib/pwa.js';

// --- constants sanity --------------------------------------------------------

test('M11: CACHE_NAME is built from the prefix and version', () => {
  assert.equal(CACHE_NAME, `${CACHE_NAME_PREFIX}${CACHE_VERSION}`);
});

test('M11: the app shell includes index.html, the manifest, and every lib/ module it imports', () => {
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const importedLibFiles = [...indexHtml.matchAll(/from\s+['"](\.\/lib\/[^'"]+)['"]/g)].map((m) => m[1]);

  assert.ok(APP_SHELL_FILES.includes('./index.html'));
  assert.ok(APP_SHELL_FILES.includes('./manifest.json'));
  for (const file of importedLibFiles) {
    assert.ok(APP_SHELL_FILES.includes(file), `app shell is missing ${file}, which index.html imports`);
  }
});

test('M11: the app shell list has no duplicate entries', () => {
  assert.equal(new Set(APP_SHELL_FILES).size, APP_SHELL_FILES.length);
});

// --- staleCacheNames -----------------------------------------------------------

test('M11: staleCacheNames identifies old versions of our own cache for eviction', () => {
  const existing = ['fsrs-engine-shell-v1', 'fsrs-engine-shell-v2', 'some-other-apps-cache'];
  assert.deepEqual(staleCacheNames(existing, 'fsrs-engine-shell-v2'), ['fsrs-engine-shell-v1']);
});

test('M11: staleCacheNames never flags the current cache name', () => {
  const existing = [CACHE_NAME];
  assert.deepEqual(staleCacheNames(existing, CACHE_NAME), []);
});

test('M11: staleCacheNames ignores caches belonging to other apps/scopes', () => {
  const existing = ['other-app-v1', 'workbox-precache-v2'];
  assert.deepEqual(staleCacheNames(existing, CACHE_NAME), []);
});

test('M11: staleCacheNames on an empty cache-name list returns nothing to delete', () => {
  assert.deepEqual(staleCacheNames([], CACHE_NAME), []);
});

// --- isCacheableRequest ----------------------------------------------------------
// Uses real Node globals (Request, URL) — no fake/dependency needed.

test('M11: a same-origin GET request is cacheable', () => {
  const req = new Request('https://paul.github.io/fsrs-engine/lib/fsrs.js');
  assert.equal(isCacheableRequest(req, 'https://paul.github.io'), true);
});

test('M11: a POST request is never cacheable, even same-origin', () => {
  const req = new Request('https://paul.github.io/fsrs-engine/', { method: 'POST' });
  assert.equal(isCacheableRequest(req, 'https://paul.github.io'), false);
});

test('M11: a cross-origin request is not cacheable by this app-shell strategy', () => {
  const req = new Request('https://example.com/tracker.js');
  assert.equal(isCacheableRequest(req, 'https://paul.github.io'), false);
});

test('M11: without an explicit origin, only http/https requests are considered', () => {
  const httpReq = new Request('https://paul.github.io/');
  assert.equal(isCacheableRequest(httpReq), true);
});

// --- drift guard: service-worker.js must match the tested constants ------------

test('M11: service-worker.js literally matches lib/pwa.js (no silent drift)', () => {
  const swSource = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');

  const versionMatch = swSource.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(versionMatch, 'service-worker.js must define CACHE_NAME as a string literal');
  assert.equal(versionMatch[1], CACHE_NAME);

  const prefixMatch = swSource.match(/CACHE_NAME_PREFIX\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(prefixMatch, 'service-worker.js must define CACHE_NAME_PREFIX as a string literal');
  assert.equal(prefixMatch[1], CACHE_NAME_PREFIX);

  const listMatch = swSource.match(/APP_SHELL_FILES\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(listMatch, 'service-worker.js must define APP_SHELL_FILES as an array literal');
  const swFiles = [...listMatch[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(swFiles, APP_SHELL_FILES);
});

test('M11: service-worker.js registers install/activate/fetch handlers', () => {
  const swSource = readFileSync(new URL('../service-worker.js', import.meta.url), 'utf8');
  for (const eventName of ['install', 'activate', 'fetch']) {
    assert.ok(
      swSource.includes(`addEventListener('${eventName}'`),
      `service-worker.js is missing an '${eventName}' listener`,
    );
  }
});

test('M11: manifest.json is valid JSON referencing the app shell entry point and an icon', () => {
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.start_url, './index.html');
  assert.equal(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
});

test('M11: index.html registers the service worker and links the manifest', () => {
  const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(indexHtml, /navigator\.serviceWorker\.register\(/);
  assert.match(indexHtml, /<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.json"/);
});
