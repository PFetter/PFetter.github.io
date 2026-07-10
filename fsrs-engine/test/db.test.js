// M7 — IndexedDB persistence.
//
// Per plan §6 ("IndexedDB flakiness in tests"), persistence tests run against
// an in-memory fake behind the *same promise-helper interface* as the real
// IndexedDB adapter, rather than a browser harness or an added dependency.
// The real adapter (db.js: createIndexedDbAdapter) is exercised manually via
// index.html in-browser; it is not unit-tested here because `indexedDB` does
// not exist under `node --test`, which is itself asserted below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION,
  DEFAULT_MIGRATIONS,
  createMemoryAdapter,
  createIndexedDbAdapter,
  openDatabase,
} from '../lib/db.js';
import { createEmptyCard } from '../lib/scheduler.js';

// --- round-trip: save, reload, deep-equal -----------------------------------

test('M7: putCard then getCard round-trips a deep-equal card', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  const card = createEmptyCard('2024-01-01T00:00:00.000Z', { front: 'x' });

  await adapter.putCard(card);
  const reloaded = await adapter.getCard(card.id);

  assert.deepEqual(reloaded, card);
});

test('M7: getCard returns undefined for an unknown id', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  assert.equal(await adapter.getCard('nope'), undefined);
});

test('M7: getAllCards returns every stored card; deleteCard removes one', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  const a = createEmptyCard('2024-01-01T00:00:00.000Z');
  const b = createEmptyCard('2024-01-02T00:00:00.000Z');
  await adapter.putCard(a);
  await adapter.putCard(b);

  assert.equal((await adapter.getAllCards()).length, 2);

  await adapter.deleteCard(a.id);
  const remaining = await adapter.getAllCards();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, b.id);
});

test('M7: putCard requires an id', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  await assert.rejects(() => adapter.putCard({ front: 'no id' }), TypeError);
});

test('M7: stored cards are defensively copied (mutating a fetched card is inert)', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  const card = createEmptyCard('2024-01-01T00:00:00.000Z');
  await adapter.putCard(card);

  const fetched = await adapter.getCard(card.id);
  fetched.front = 'mutated';
  const fetchedAgain = await adapter.getCard(card.id);
  assert.equal(fetchedAgain.front, '');
});

test('M7: putReview stores review log entries retrievable via getAllReviews', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  await adapter.putReview({ card_id: 'c1', rating: 3, review_datetime: '2024-01-01T00:00:00.000Z' });
  await adapter.putReview({ card_id: 'c1', rating: 1, review_datetime: '2024-01-02T00:00:00.000Z' });

  const reviews = await adapter.getAllReviews();
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0].card_id, 'c1');
  assert.ok(reviews[0].seq < reviews[1].seq, 'review logs get increasing sequence numbers');
});

test('M7: meta store round-trips arbitrary key/value data', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  await adapter.setMeta('parameters', [1, 2, 3]);
  await adapter.setMeta('deckName', 'Rust concepts');

  assert.deepEqual(await adapter.getMeta('parameters'), [1, 2, 3]);
  assert.equal(await adapter.getMeta('deckName'), 'Rust concepts');
  assert.equal(await adapter.getMeta('missing'), undefined);
});

test('M7: clearAll empties cards, reviews, and meta', async () => {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  await adapter.putCard(createEmptyCard('2024-01-01T00:00:00.000Z'));
  await adapter.putReview({ card_id: 'c1', rating: 3, review_datetime: '2024-01-01T00:00:00.000Z' });
  await adapter.setMeta('k', 'v');

  await adapter.clearAll();

  assert.deepEqual(await adapter.getAllCards(), []);
  assert.deepEqual(await adapter.getAllReviews(), []);
  assert.equal(await adapter.getMeta('k'), undefined);
});

// --- schema version / upgrade path ------------------------------------------

test('M7: openDatabase stamps a fresh adapter with the current schema version', async () => {
  const adapter = createMemoryAdapter();
  assert.equal(await adapter.getMeta('schemaVersion'), undefined);
  await openDatabase(adapter);
  assert.equal(await adapter.getMeta('schemaVersion'), SCHEMA_VERSION);
});

test('M7: openDatabase is idempotent (re-opening does not rerun migrations)', async () => {
  let upCount = 0;
  const migrations = [{ version: 1, up: async () => { upCount += 1; } }];
  const adapter = createMemoryAdapter();
  await openDatabase(adapter, { migrations });
  await openDatabase(adapter, { migrations });
  assert.equal(upCount, 1);
});

test('M7: a later migration upgrades existing v1 data (simulated schema change)', async () => {
  // Simulate a pre-existing v1 database with "legacy" cards lacking a field
  // introduced in a hypothetical v2 (e.g. an `archived` flag).
  const adapter = createMemoryAdapter();
  await openDatabase(adapter); // stamps schemaVersion = 1
  const legacyCard = createEmptyCard('2024-01-01T00:00:00.000Z');
  delete legacyCard.archived;
  await adapter.putCard(legacyCard);

  const v2Migrations = [
    ...DEFAULT_MIGRATIONS,
    {
      version: 2,
      up: async (a) => {
        for (const card of await a.getAllCards()) {
          if (card.archived === undefined) {
            await a.putCard({ ...card, archived: false });
          }
        }
      },
    },
  ];

  await openDatabase(adapter, { migrations: v2Migrations });

  assert.equal(await adapter.getMeta('schemaVersion'), 2);
  const migrated = await adapter.getCard(legacyCard.id);
  assert.equal(migrated.archived, false);
});

test('M7: migrations run in ascending version order regardless of array order', async () => {
  const order = [];
  const migrations = [
    { version: 2, up: async () => { order.push(2); } },
    { version: 1, up: async () => { order.push(1); } },
  ];
  await openDatabase(createMemoryAdapter(), { migrations });
  assert.deepEqual(order, [1, 2]);
});

// --- real IndexedDB adapter (browser-only) ----------------------------------

test('M7: createIndexedDbAdapter throws a clear error outside a browser (no indexedDB global)', async () => {
  assert.equal(typeof globalThis.indexedDB, 'undefined', 'sanity: indexedDB is absent under node --test');
  const adapter = createIndexedDbAdapter('test-db');
  await assert.rejects(() => adapter.open(), /indexedDB/i);
});
