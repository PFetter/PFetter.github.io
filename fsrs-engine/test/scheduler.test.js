// M6 — Card lifecycle state machine.
// New -> Learning -> Review -> Relearning, learning steps [1m, 10m],
// relearning steps [10m]. API surface mirrors ts-fsrs: createEmptyCard(),
// repeat(card, now) previews all four ratings, next(card, now, rating).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rating } from '../lib/fsrs.js';
import { createEmptyCard, createScheduler, State } from '../lib/scheduler.js';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;
const T0 = '2023-06-01T08:00:00.000Z';
const t0 = Date.parse(T0);
const scheduler = () => createScheduler(); // defaults: [1m,10m] / [10m]

// --- createEmptyCard -------------------------------------------------------

test('M6: createEmptyCard produces a due New card with empty memory state', () => {
  const card = createEmptyCard(T0);
  assert.equal(card.state, State.New);
  assert.equal(card.step, 0);
  assert.equal(card.stability, null);
  assert.equal(card.difficulty, null);
  assert.equal(card.last_review, null);
  assert.equal(card.due, T0);
  assert.equal(card.reps, 0);
  assert.equal(card.lapses, 0);
  assert.ok(card.id, 'card gets an id');
});

test('M6: createEmptyCard accepts content overrides without touching scheduling fields', () => {
  const card = createEmptyCard(T0, { type: 'code-cloze', front: 'f', back: 'b' });
  assert.equal(card.type, 'code-cloze');
  assert.equal(card.front, 'f');
  assert.equal(card.state, State.New);
});

// --- New / Learning transitions -------------------------------------------

test('M6: New + Good -> Learning at step 1, due in 10 minutes', () => {
  const { card } = scheduler().next(createEmptyCard(T0), t0, Rating.Good);
  assert.equal(card.state, State.Learning);
  assert.equal(card.step, 1);
  assert.equal(Date.parse(card.due) - t0, 10 * MIN_MS);
});

test('M6: New + Again -> Learning at step 0, due in 1 minute', () => {
  const { card } = scheduler().next(createEmptyCard(T0), t0, Rating.Again);
  assert.equal(card.state, State.Learning);
  assert.equal(card.step, 0);
  assert.equal(Date.parse(card.due) - t0, 1 * MIN_MS);
});

test('M6: New + Hard -> stays step 0, due at (1m + 10m)/2 = 5.5 minutes', () => {
  const { card } = scheduler().next(createEmptyCard(T0), t0, Rating.Hard);
  assert.equal(card.state, State.Learning);
  assert.equal(card.step, 0);
  assert.equal(Date.parse(card.due) - t0, 5.5 * MIN_MS);
});

test('M6: New + Easy graduates straight to Review with an 8-day interval', () => {
  // S0(Easy) = 8.2956 -> interval rounds to 8 days at retention 0.9.
  const { card } = scheduler().next(createEmptyCard(T0), t0, Rating.Easy);
  assert.equal(card.state, State.Review);
  assert.equal(card.step, null);
  assert.equal(Date.parse(card.due) - t0, 8 * DAY_MS);
});

test('M6: Learning last step + Good graduates to Review', () => {
  const s = scheduler();
  let { card } = s.next(createEmptyCard(T0), t0, Rating.Good); // -> step 1
  ({ card } = s.next(card, Date.parse(card.due), Rating.Good)); // graduate
  assert.equal(card.state, State.Review);
  assert.equal(card.step, null);
});

test('M6: Learning + Again resets to step 0', () => {
  const s = scheduler();
  let { card } = s.next(createEmptyCard(T0), t0, Rating.Good); // step 1
  ({ card } = s.next(card, Date.parse(card.due), Rating.Again));
  assert.equal(card.state, State.Learning);
  assert.equal(card.step, 0);
});

// --- Review / Relearning transitions ---------------------------------------

function reviewCard() {
  // Fast path to a Review-state card: New + Easy graduates immediately.
  const s = scheduler();
  const { card } = s.next(createEmptyCard(T0), t0, Rating.Easy);
  return { s, card };
}

test('M6: Review + Again lapses into Relearning step 0, due in 10 minutes', () => {
  const { s, card } = reviewCard();
  const due = Date.parse(card.due);
  const { card: lapsed } = s.next(card, due, Rating.Again);
  assert.equal(lapsed.state, State.Relearning);
  assert.equal(lapsed.step, 0);
  assert.equal(Date.parse(lapsed.due) - due, 10 * MIN_MS);
  assert.equal(lapsed.lapses, 1);
});

test('M6: Relearning + Good (single step) graduates back to Review', () => {
  const { s, card } = reviewCard();
  let now = Date.parse(card.due);
  let { card: c } = s.next(card, now, Rating.Again); // -> Relearning
  now = Date.parse(c.due);
  ({ card: c } = s.next(c, now, Rating.Good));
  assert.equal(c.state, State.Review);
  assert.equal(c.step, null);
  assert.ok(Date.parse(c.due) > now);
});

test('M6: Relearning + Again stays at step 0', () => {
  const { s, card } = reviewCard();
  let { card: c } = s.next(card, Date.parse(card.due), Rating.Again);
  ({ card: c } = s.next(c, Date.parse(c.due), Rating.Again));
  assert.equal(c.state, State.Relearning);
  assert.equal(c.step, 0);
  assert.equal(c.lapses, 1, 'a lapse is counted on leaving Review, not per Again');
});

test('M6: Review + Good stays in Review with a day-granular interval', () => {
  const { s, card } = reviewCard();
  const now = Date.parse(card.due);
  const { card: c } = s.next(card, now, Rating.Good);
  assert.equal(c.state, State.Review);
  assert.equal((Date.parse(c.due) - now) % DAY_MS, 0);
  assert.ok(Date.parse(c.due) - now >= DAY_MS);
});

// --- Bookkeeping, immutability, preview ------------------------------------

test('M6: reps increments on every review; last_review is set', () => {
  const s = scheduler();
  let { card } = s.next(createEmptyCard(T0), t0, Rating.Good);
  assert.equal(card.reps, 1);
  assert.equal(Date.parse(card.last_review), t0);
  ({ card } = s.next(card, Date.parse(card.due), Rating.Good));
  assert.equal(card.reps, 2);
});

test('M6: next() never mutates the input card', () => {
  const s = scheduler();
  const input = createEmptyCard(T0);
  const snapshot = structuredClone(input);
  s.next(input, t0, Rating.Good);
  assert.deepEqual(input, snapshot);
});

test('M6: next() returns a review log entry', () => {
  const s = scheduler();
  const { reviewLog } = s.next(createEmptyCard(T0), t0, Rating.Hard);
  assert.equal(reviewLog.rating, Rating.Hard);
  assert.equal(Date.parse(reviewLog.review_datetime), t0);
  assert.ok(reviewLog.card_id, 'log references the card');
});

test('M6: repeat() previews all four ratings without mutating the card', () => {
  const s = scheduler();
  const input = createEmptyCard(T0);
  const snapshot = structuredClone(input);
  const preview = s.repeat(input, t0);
  assert.deepEqual(input, snapshot);
  assert.deepEqual(
    Object.keys(preview).map(Number).sort(),
    [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy],
  );
  assert.equal(preview[Rating.Again].card.state, State.Learning);
  assert.equal(preview[Rating.Easy].card.state, State.Review);
  // Preview intervals are ordered: Again <= Hard <= Good <= Easy.
  const dues = [1, 2, 3, 4].map((r) => Date.parse(preview[r].card.due));
  assert.ok(dues[0] <= dues[1] && dues[1] <= dues[2] && dues[2] <= dues[3]);
});

test('M6: invalid ratings and timestamps are rejected', () => {
  const s = scheduler();
  assert.throws(() => s.next(createEmptyCard(T0), t0, 5), RangeError);
  assert.throws(() => s.next(createEmptyCard(T0), 'not-a-date', Rating.Good), /date/i);
});
