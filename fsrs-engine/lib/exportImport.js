// Export/import (M10): full JSON dump — backup, migration path, and future
// sync seed (v1 scope §4.6). Built on the adapter interface from db.js, so
// it works identically against the memory fake and the real IndexedDB
// adapter.

import { toIso } from './datetime.js';

export const EXPORT_FORMAT_VERSION = 1;

export async function exportAll(adapter, { now = new Date() } = {}) {
  const [cards, reviews, meta] = await Promise.all([
    adapter.getAllCards(),
    adapter.getAllReviews(),
    adapter.getAllMeta(),
  ]);
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: toIso(now),
    cards,
    reviews,
    meta,
  };
}

export async function importAll(adapter, data, { clearExisting = false } = {}) {
  validateShape(data);
  if (clearExisting) await adapter.clearAll();

  for (const card of data.cards) await adapter.putCard(card);
  // Review logs get a fresh `seq` on import (it's a storage-assigned id, not
  // semantic data); strip any incoming seq so putReview reassigns one.
  for (const { seq, ...review } of data.reviews) await adapter.putReview(review);
  for (const [key, value] of Object.entries(data.meta ?? {})) await adapter.setMeta(key, value);

  return { cardsImported: data.cards.length, reviewsImported: data.reviews.length };
}

function validateShape(data) {
  if (!data || typeof data !== 'object') throw new TypeError('import data must be an object');
  if (data.formatVersion !== EXPORT_FORMAT_VERSION) {
    throw new RangeError(`unsupported export formatVersion: ${data.formatVersion} (expected ${EXPORT_FORMAT_VERSION})`);
  }
  if (!Array.isArray(data.cards)) throw new TypeError('import data.cards must be an array');
  if (!Array.isArray(data.reviews)) throw new TypeError('import data.reviews must be an array');
}
