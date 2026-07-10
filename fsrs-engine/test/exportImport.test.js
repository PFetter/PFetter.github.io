// M10 — Export/import: full JSON dump round-trip equality.
// Serves as backup, migration path, and future sync seed (plan §4.6).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryAdapter, openDatabase } from '../lib/db.js';
import { exportAll, importAll, EXPORT_FORMAT_VERSION } from '../lib/exportImport.js';
import { createEmptyCard } from '../lib/scheduler.js';

async function seededAdapter() {
  const adapter = createMemoryAdapter();
  await openDatabase(adapter);
  const a = createEmptyCard('2024-01-01T00:00:00.000Z', { front: 'A' });
  const b = createEmptyCard('2024-01-02T00:00:00.000Z', { front: 'B', type: 'code-cloze' });
  await adapter.putCard(a);
  await adapter.putCard(b);
  await adapter.putReview({ card_id: a.id, rating: 3, review_datetime: '2024-01-01T00:05:00.000Z' });
  await adapter.putReview({ card_id: a.id, rating: 1, review_datetime: '2024-01-03T00:00:00.000Z' });
  await adapter.setMeta('deckName', 'Rust concepts');
  return { adapter, a, b };
}

// JSON.parse(JSON.stringify(x)) to exercise the *actual* serialization path,
// not just an in-memory object handoff.
const throughJson = (x) => JSON.parse(JSON.stringify(x));

test('M10: export produces the documented top-level shape', async () => {
  const { adapter } = await seededAdapter();
  const dump = await exportAll(adapter);
  assert.equal(dump.formatVersion, EXPORT_FORMAT_VERSION);
  assert.equal(typeof dump.exportedAt, 'string');
  assert.equal(dump.cards.length, 2);
  assert.equal(dump.reviews.length, 2);
  assert.equal(dump.meta.deckName, 'Rust concepts');
});

test('M10: export -> JSON round-trip -> import into a fresh adapter is card-equal', async () => {
  const { adapter: source } = await seededAdapter();
  const dump = throughJson(await exportAll(source));

  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await importAll(dest, dump);

  const sourceCards = (await source.getAllCards()).sort((x, y) => x.id.localeCompare(y.id));
  const destCards = (await dest.getAllCards()).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(destCards, sourceCards);
});

test('M10: imported reviews match by content (card_id, rating, review_datetime)', async () => {
  const { adapter: source } = await seededAdapter();
  const dump = throughJson(await exportAll(source));

  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await importAll(dest, dump);

  const strip = (r) => ({ card_id: r.card_id, rating: r.rating, review_datetime: r.review_datetime });
  const sourceReviews = (await source.getAllReviews()).map(strip);
  const destReviews = (await dest.getAllReviews()).map(strip);
  assert.deepEqual(
    destReviews.sort((a, b) => a.review_datetime.localeCompare(b.review_datetime)),
    sourceReviews.sort((a, b) => a.review_datetime.localeCompare(b.review_datetime)),
  );
});

test('M10: imported meta matches source meta', async () => {
  const { adapter: source } = await seededAdapter();
  const dump = throughJson(await exportAll(source));

  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await importAll(dest, dump);

  assert.equal(await dest.getMeta('deckName'), 'Rust concepts');
});

test('M10: clearExisting removes prior data before importing', async () => {
  const { adapter: source } = await seededAdapter();
  const dump = throughJson(await exportAll(source));

  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await dest.putCard(createEmptyCard('2020-01-01T00:00:00.000Z', { front: 'stale' }));

  await importAll(dest, dump, { clearExisting: true });

  const fronts = (await dest.getAllCards()).map((c) => c.front).sort();
  assert.deepEqual(fronts, ['A', 'B']);
});

test('M10: without clearExisting, import merges with existing data', async () => {
  const { adapter: source } = await seededAdapter();
  const dump = throughJson(await exportAll(source));

  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await dest.putCard(createEmptyCard('2020-01-01T00:00:00.000Z', { front: 'kept' }));

  await importAll(dest, dump);

  const fronts = (await dest.getAllCards()).map((c) => c.front).sort();
  assert.deepEqual(fronts, ['A', 'B', 'kept']);
});

test('M10: import reports how many cards and reviews were imported', async () => {
  const { adapter: source } = await seededAdapter();
  const dump = throughJson(await exportAll(source));
  const dest = createMemoryAdapter();
  await openDatabase(dest);
  const result = await importAll(dest, dump);
  assert.deepEqual(result, { cardsImported: 2, reviewsImported: 2 });
});

test('M10: import rejects a mismatched formatVersion', async () => {
  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await assert.rejects(
    () => importAll(dest, { formatVersion: 999, cards: [], reviews: [], meta: {} }),
    RangeError,
  );
});

test('M10: import rejects malformed data (missing cards/reviews arrays)', async () => {
  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await assert.rejects(() => importAll(dest, { formatVersion: EXPORT_FORMAT_VERSION }), TypeError);
  await assert.rejects(() => importAll(dest, null), TypeError);
});

test('M10: an empty database round-trips to an empty dump and back', async () => {
  const source = createMemoryAdapter();
  await openDatabase(source);
  const dump = throughJson(await exportAll(source));

  const dest = createMemoryAdapter();
  await openDatabase(dest);
  await importAll(dest, dump);

  assert.deepEqual(await dest.getAllCards(), []);
  assert.deepEqual(await dest.getAllReviews(), []);
});
