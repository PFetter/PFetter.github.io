// M5 — Full-sequence conformance against py-fsrs v6.3.1 golden data.
//
// Golden vectors 1-3 come from the project plan (py-fsrs tests/test_basic.py),
// asserted at the plan's tolerance (abs 1e-4). golden-extended.json is a
// 40-step mixed-rating sequence generated from py-fsrs 6.3.1 itself and is
// asserted per-step at 1e-9 — both runtimes are IEEE-754 doubles, so agreement
// should be essentially exact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Rating } from '../lib/fsrs.js';
import { createEmptyCard, createScheduler, State } from '../lib/scheduler.js';

const DAY_MS = 86_400_000;
const near = (actual, expected, tol) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );
const wholeDays = (card) =>
  Math.floor((Date.parse(card.due) - Date.parse(card.last_review)) / DAY_MS);

const CONFORMANCE_CONFIG = {
  desiredRetention: 0.9,
  maximumInterval: 36500,
  learningSteps: [1, 10], // minutes
  relearningSteps: [10],
};

test('M5 golden #1: interval-history vector (Good x6, Again x2, Good x5)', () => {
  const scheduler = createScheduler(CONFORMANCE_CONFIG);
  let card = createEmptyCard('2022-11-29T12:30:00.000Z');
  let now = Date.parse('2022-11-29T12:30:00.000Z');

  const ratings = [3, 3, 3, 3, 3, 3, 1, 1, 3, 3, 3, 3, 3];
  const history = [];
  for (const rating of ratings) {
    ({ card } = scheduler.next(card, now, rating));
    history.push(wholeDays(card));
    now = Date.parse(card.due);
  }
  assert.deepEqual(history, [0, 2, 11, 46, 163, 498, 0, 0, 2, 4, 7, 12, 21]);
});

test('M5 golden #2: memory-state vector -> S~53.62691, D~6.3574867', () => {
  const scheduler = createScheduler(CONFORMANCE_CONFIG);
  let card = createEmptyCard('2022-11-29T12:30:00.000Z');
  let now = Date.parse('2022-11-29T12:30:00.000Z');

  const ratings = [Rating.Again, 3, 3, 3, 3, 3];
  const spacingDays = [0, 0, 1, 3, 8, 21];
  for (let i = 0; i < ratings.length; i++) {
    now += spacingDays[i] * DAY_MS;
    ({ card } = scheduler.next(card, now, ratings[i]));
  }
  near(card.stability, 53.62691, 1e-4); // plan tolerance
  near(card.difficulty, 6.3574867, 1e-4);
  near(card.stability, 53.626902917141365, 1e-9); // exact oracle values
  near(card.difficulty, 6.357487083997829, 1e-9);
});

test('M5 golden #3: ten consecutive Easy ratings drive difficulty to the 1.0 floor', () => {
  const scheduler = createScheduler(CONFORMANCE_CONFIG);
  let card = createEmptyCard('2022-11-29T12:30:00.000Z');
  let now = Date.parse('2022-11-29T12:30:00.000Z');
  for (let i = 0; i < 10; i++) {
    ({ card } = scheduler.next(card, now, Rating.Easy));
    now = Date.parse(card.due);
  }
  assert.equal(card.difficulty, 1);
});

test('M5 golden #4: scheduler construction rejects weight arrays of length != 21', () => {
  assert.throws(() => createScheduler({ parameters: new Array(19).fill(0.5) }), /21/);
  assert.throws(() => createScheduler({ parameters: new Array(22).fill(0.5) }), /21/);
});

test('M5 extended: 40-step mixed sequence matches py-fsrs per step at 1e-9', () => {
  const rows = JSON.parse(
    readFileSync(new URL('./golden-extended.json', import.meta.url), 'utf8'),
  );
  const scheduler = createScheduler(CONFORMANCE_CONFIG);
  let card = createEmptyCard(rows[0].review);

  for (const [i, row] of rows.entries()) {
    ({ card } = scheduler.next(card, row.review, row.rating));
    const label = `step ${i} (rating ${row.rating})`;
    near(card.stability, row.stability, 1e-9);
    near(card.difficulty, row.difficulty, 1e-9);
    assert.equal(card.state, State[row.state], `${label}: state`);
    assert.equal(card.step, row.step, `${label}: step`);
    assert.equal(wholeDays(card), row.interval_days, `${label}: interval`);
    assert.equal(Date.parse(card.due), Date.parse(row.due), `${label}: due`);
  }
});
