// IndexedDB persistence (M7).
//
// Two adapters share one interface — createMemoryAdapter() (used by
// node --test, per plan §6) and createIndexedDbAdapter() (the real browser
// backend, wrapped in a small promise helper around native IndexedDB; no
// idb/dexie dependency). Object stores: cards, reviews (review log), meta
// (schema version, and anything else the app wants to key-value store, e.g.
// scheduler parameters — see v1 scope §4.5).
//
// Adapter interface (all async):
//   open() close()
//   putCard(card) getCard(id) getAllCards() deleteCard(id)
//   putReview(reviewLog) -> seq   getAllReviews()
//   getMeta(key) setMeta(key, value) getAllMeta()
//   clearAll()

export const SCHEMA_VERSION = 1;
export const STORES = Object.freeze({ CARDS: 'cards', REVIEWS: 'reviews', META: 'meta' });

// Base schema migration: object stores already exist by the time this runs
// (memory adapter has no notion of "creating" a store; the real adapter
// creates all stores in its IndexedDB onupgradeneeded). Future migrations
// are appended here, e.g. `{ version: 2, up: async (adapter) => { ... } }`.
export const DEFAULT_MIGRATIONS = Object.freeze([{ version: 1, up: async () => {} }]);

// Runs pending migrations (by ascending version) against `adapter`, starting
// from its currently stored schemaVersion (0 if unset). Idempotent: calling
// twice with the same target does not rerun already-applied migrations.
export async function openDatabase(adapter, { migrations = DEFAULT_MIGRATIONS } = {}) {
  await adapter.open();
  let version = (await adapter.getMeta('schemaVersion')) ?? 0;
  const pending = [...migrations].sort((a, b) => a.version - b.version).filter((m) => m.version > version);
  for (const migration of pending) {
    await migration.up(adapter);
    version = migration.version;
    await adapter.setMeta('schemaVersion', version);
  }
  return adapter;
}

// ---------------------------------------------------------------------------
// In-memory fake — the adapter node --test runs persistence tests against.
// ---------------------------------------------------------------------------

export function createMemoryAdapter() {
  const cards = new Map();
  const reviews = [];
  const meta = new Map();
  let nextSeq = 1;

  return {
    kind: 'memory',

    async open() {},
    async close() {},

    async putCard(card) {
      if (!card || typeof card.id !== 'string' || card.id === '') {
        throw new TypeError('putCard requires a card with a non-empty string id');
      }
      cards.set(card.id, structuredClone(card));
    },
    async getCard(id) {
      const c = cards.get(id);
      return c === undefined ? undefined : structuredClone(c);
    },
    async getAllCards() {
      return [...cards.values()].map((c) => structuredClone(c));
    },
    async deleteCard(id) {
      cards.delete(id);
    },

    async putReview(reviewLog) {
      const seq = nextSeq++;
      reviews.push(structuredClone({ ...reviewLog, seq }));
      return seq;
    },
    async getAllReviews() {
      return reviews.map((r) => structuredClone(r));
    },

    async getMeta(key) {
      return meta.has(key) ? structuredClone(meta.get(key)) : undefined;
    },
    async setMeta(key, value) {
      meta.set(key, structuredClone(value));
    },
    async getAllMeta() {
      return Object.fromEntries([...meta.entries()].map(([k, v]) => [k, structuredClone(v)]));
    },

    async clearAll() {
      cards.clear();
      reviews.length = 0;
      meta.clear();
      nextSeq = 1;
    },
  };
}

// ---------------------------------------------------------------------------
// Real IndexedDB adapter — same interface, native browser storage.
// ---------------------------------------------------------------------------

export function createIndexedDbAdapter(dbName = 'fsrs-engine', idbFactory = globalThis.indexedDB) {
  let db = null;

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  }

  async function open() {
    if (!idbFactory) {
      throw new Error('indexedDB is not available in this environment (browser-only adapter)');
    }
    if (db) return;
    db = await new Promise((resolve, reject) => {
      const req = idbFactory.open(dbName, 1);
      req.onupgradeneeded = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains(STORES.CARDS)) {
          database.createObjectStore(STORES.CARDS, { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains(STORES.REVIEWS)) {
          database.createObjectStore(STORES.REVIEWS, { keyPath: 'seq', autoIncrement: true });
        }
        if (!database.objectStoreNames.contains(STORES.META)) {
          database.createObjectStore(STORES.META, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function store(name, mode) {
    return db.transaction(name, mode).objectStore(name);
  }

  return {
    kind: 'indexeddb',
    open,
    async close() {
      db?.close();
      db = null;
    },

    async putCard(card) {
      const tx = db.transaction(STORES.CARDS, 'readwrite');
      tx.objectStore(STORES.CARDS).put(card);
      await txDone(tx);
    },
    async getCard(id) {
      return requestToPromise(store(STORES.CARDS, 'readonly').get(id));
    },
    async getAllCards() {
      return requestToPromise(store(STORES.CARDS, 'readonly').getAll());
    },
    async deleteCard(id) {
      const tx = db.transaction(STORES.CARDS, 'readwrite');
      tx.objectStore(STORES.CARDS).delete(id);
      await txDone(tx);
    },

    async putReview(reviewLog) {
      const tx = db.transaction(STORES.REVIEWS, 'readwrite');
      const req = tx.objectStore(STORES.REVIEWS).put(reviewLog);
      const seq = await requestToPromise(req);
      await txDone(tx);
      return seq;
    },
    async getAllReviews() {
      return requestToPromise(store(STORES.REVIEWS, 'readonly').getAll());
    },

    async getMeta(key) {
      const row = await requestToPromise(store(STORES.META, 'readonly').get(key));
      return row?.value;
    },
    async setMeta(key, value) {
      const tx = db.transaction(STORES.META, 'readwrite');
      tx.objectStore(STORES.META).put({ key, value });
      await txDone(tx);
    },
    async getAllMeta() {
      const rows = await requestToPromise(store(STORES.META, 'readonly').getAll());
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },

    async clearAll() {
      const tx = db.transaction([STORES.CARDS, STORES.REVIEWS, STORES.META], 'readwrite');
      tx.objectStore(STORES.CARDS).clear();
      tx.objectStore(STORES.REVIEWS).clear();
      tx.objectStore(STORES.META).clear();
      await txDone(tx);
    },
  };
}
