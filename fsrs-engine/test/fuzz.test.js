// Interval fuzzing tests.
//
// fuzzRange() is pure and deterministic — asserted directly against py-fsrs
// 6.3.1 oracle values. applyFuzz() is randomized, so rather than asserting
// statistical bounds over many draws (flaky by nature — the exact failure
// mode the plan already called out for IndexedDB, §6), tests inject an exact
// rng() value chosen so the *known* formula lands on a specific target day.
// Given minIvl/maxIvl, rng = (target - minIvl) / (maxIvl - minIvl + 1) hits
// `target` exactly with no floating-point ambiguity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzRange, applyFuzz } from '../lib/fuzz.js';
import { Rating } from '../lib/fsrs.js';
import { createEmptyCard, createScheduler, State } from '../lib/scheduler.js';

const rngFor = (target, minIvl, maxIvl) => () => (target - minIvl) / (maxIvl - minIvl + 1);

// --- fuzzRange: deterministic, oracle-matched (py-fsrs 6.3.1) --------------

test('fuzzRange matches py-fsrs FUZZ_RANGES bands exactly', () => {
  const cases = [
    [1, 2, 2],
    [3, 2, 4],
    [5, 4, 6],
    [7, 5, 9],
    [10, 8, 12],
    [20, 17, 23],
    [25, 22, 28],
    [100, 93, 107],
  ];
  for (const [days, expectedMin, expectedMax] of cases) {
    assert.deepEqual(fuzzRange(days), [expectedMin, expectedMax], `day ${days}`);
  }
});

test('fuzzRange clamps the upper bound to maximumInterval', () => {
  assert.deepEqual(fuzzRange(49, 50), [45, 50]);
});

test('fuzzRange near the global maximum clamps correctly (36500-day ceiling)', () => {
  assert.deepEqual(fuzzRange(36499), [34672, 36500]);
  assert.deepEqual(fuzzRange(36500), [34673, 36500]);
});

// --- applyFuzz: the <2.5-day short-circuit ----------------------------------

test('applyFuzz leaves intervals under 3 days unchanged, regardless of rng', () => {
  const eagerRng = () => 0.999999999;
  assert.equal(applyFuzz(1, { rng: eagerRng }), 1);
  assert.equal(applyFuzz(2, { rng: eagerRng }), 2);
});

test('applyFuzz does fuzz a 3-day interval (the boundary where fuzz turns on)', () => {
  const [minIvl, maxIvl] = fuzzRange(3);
  assert.equal(applyFuzz(3, { rng: rngFor(minIvl, minIvl, maxIvl) }), minIvl);
  assert.notEqual(minIvl, 3, 'sanity: fuzz range for day 3 must actually differ from 3');
});

// --- applyFuzz: deterministic boundary hits via injected rng ----------------

test('applyFuzz with rng()=0 returns exactly the range minimum', () => {
  const [minIvl, maxIvl] = fuzzRange(100);
  assert.equal(applyFuzz(100, { rng: rngFor(minIvl, minIvl, maxIvl) }), minIvl);
});

test('applyFuzz can land exactly on the range maximum via a precise rng draw', () => {
  const [minIvl, maxIvl] = fuzzRange(100);
  assert.equal(applyFuzz(100, { rng: rngFor(maxIvl, minIvl, maxIvl) }), maxIvl);
});

test('applyFuzz can land on an interior day via a precise rng draw', () => {
  const [minIvl, maxIvl] = fuzzRange(100); // [93, 107]
  const target = 100;
  assert.equal(applyFuzz(100, { rng: rngFor(target, minIvl, maxIvl) }), target);
});

test('applyFuzz never exceeds the configured maximumInterval', () => {
  const maximumInterval = 50;
  const [minIvl, maxIvl] = fuzzRange(49, maximumInterval);
  assert.equal(maxIvl, maximumInterval);
  const result = applyFuzz(49, { maximumInterval, rng: rngFor(maxIvl, minIvl, maxIvl) });
  assert.ok(result <= maximumInterval);
});

test('applyFuzz always returns an integer', () => {
  const result = applyFuzz(100, { rng: () => 0.3333333 });
  assert.equal(Number.isInteger(result), true);
});

test('applyFuzz defaults to Math.random and stays within the valid window', () => {
  for (let i = 0; i < 20; i++) {
    const result = applyFuzz(100);
    // upper bound is inclusive of the rare round-up-at-the-edge case (rng
    // approaching 1 can round fuzzed=maxIvl+0.5+epsilon up to maxIvl+1;
    // py-fsrs has this same property, see lib/fuzz.js).
    assert.ok(result >= 93 && result <= 108, `result ${result} out of expected window`);
  }
});

// --- Scheduler integration: fuzz only touches Review-state intervals -------

test('scheduler: enableFuzz applies to a Review-state interval via injected rng', () => {
  const rng = () => 0; // deterministic: always the range minimum
  const scheduler = createScheduler({ enableFuzz: true, rng });
  let { card } = createSchedulerReviewCard(scheduler);

  const before = Date.parse(card.due);
  const { card: reviewed } = scheduler.next(card, before, Rating.Good);

  const rawDays = Math.round((Date.parse(reviewed.due) - before) / 86_400_000);
  // Recompute independently via applyFuzz to prove the scheduler actually
  // routes through it, rather than just asserting *some* number came back.
  const unfuzzedScheduler = createScheduler({ enableFuzz: false });
  const { card: unfuzzedReview } = unfuzzedScheduler.next(card, before, Rating.Good);
  const unfuzzedDays = Math.round((Date.parse(unfuzzedReview.due) - before) / 86_400_000);
  const [minIvl] = fuzzRange(unfuzzedDays);

  assert.equal(rawDays, minIvl);
});

test('scheduler: enableFuzz does NOT alter Learning-step due times', () => {
  const rng = () => 0.999999999; // would push a Review interval to its max
  const scheduler = createScheduler({ enableFuzz: true, rng });
  const t0 = Date.parse('2024-01-01T00:00:00.000Z');
  const { card } = scheduler.next(createEmptyCard(t0), t0, Rating.Good); // -> Learning, step 1

  assert.equal(card.state, State.Learning);
  assert.equal(Date.parse(card.due) - t0, 10 * 60_000); // exact 10-minute step, unfuzzed
});

test('scheduler: enableFuzz does NOT alter Relearning-step due times', () => {
  const rng = () => 0.999999999;
  const t0 = Date.parse('2024-01-01T00:00:00.000Z');
  const plain = createScheduler({ enableFuzz: false });
  let { card } = plain.next(createEmptyCard(t0), t0, Rating.Easy); // -> Review

  const fuzzy = createScheduler({ enableFuzz: true, rng });
  const dueBefore = Date.parse(card.due);
  ({ card } = fuzzy.next(card, dueBefore, Rating.Again)); // -> Relearning

  assert.equal(card.state, State.Relearning);
  assert.equal(Date.parse(card.due) - dueBefore, 10 * 60_000); // exact step, unfuzzed
});

test('scheduler: enableFuzz defaults to false (unfuzzed, exact interval)', () => {
  const t0 = Date.parse('2024-01-01T00:00:00.000Z');
  const scheduler = createScheduler();
  const { card } = scheduler.next(createEmptyCard(t0), t0, Rating.Easy);
  // S0(Easy)=8.2956 -> interval rounds to exactly 8 days, unfuzzed (< 2.5-day
  // gate doesn't even apply here since fuzz is off entirely).
  assert.equal(Date.parse(card.due) - t0, 8 * 86_400_000);
});

test('scheduler: config reports enableFuzz', () => {
  const scheduler = createScheduler({ enableFuzz: true, rng: () => 0.5 });
  assert.equal(scheduler.config.enableFuzz, true);
  assert.equal(createScheduler().config.enableFuzz, false);
});

// --- helper ------------------------------------------------------------------

function createSchedulerReviewCard(scheduler) {
  const t0 = Date.parse('2024-01-01T00:00:00.000Z');
  return scheduler.next(createEmptyCard(t0), t0, Rating.Easy); // New + Easy -> Review
}
