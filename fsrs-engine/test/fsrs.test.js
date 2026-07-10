import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Rating,
  DEFAULT_PARAMETERS,
  validateParameters,
  retrievability,
  initStability,
  initDifficulty,
  nextStability,
  nextDifficulty,
  shortTermStability,
  nextInterval,
} from '../lib/fsrs.js';

const ABS_TOL = 1e-4;
const near = (actual, expected, tol = ABS_TOL) =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `expected ${actual} to be within ${tol} of ${expected}`,
  );

// ===========================================================================
// M1 — Forgetting curve
// ===========================================================================

test('M1: retrievability at t=0 is exactly 1', () => {
  assert.equal(retrievability(0, 100), 1);
  assert.equal(retrievability(0, 2.3065), 1);
});

test('M1: retrievability at t=S equals desired retention 0.9', () => {
  near(retrievability(100, 100), 0.9);
  near(retrievability(2.3065, 2.3065), 0.9);
});

test('M1: retrievability decreases monotonically in elapsed time', () => {
  const S = 100;
  let prev = retrievability(0, S);
  for (let t = 1; t <= 500; t += 7) {
    const r = retrievability(t, S);
    assert.ok(r < prev, `R should strictly decrease at t=${t} (got ${r} >= ${prev})`);
    prev = r;
  }
});

test('M1: retrievability rejects non-positive stability and negative time', () => {
  assert.throws(() => retrievability(1, 0), RangeError);
  assert.throws(() => retrievability(-1, 100), RangeError);
});

// ===========================================================================
// M2 — Initial stability, initial difficulty, parameter validation
// ===========================================================================

test('M2: initial stability equals the per-rating weight', () => {
  near(initStability(Rating.Again), 0.212);
  near(initStability(Rating.Hard), 1.2931);
  near(initStability(Rating.Good), 2.3065);
  near(initStability(Rating.Easy), 8.2956);
});

test('M2: initial difficulty for Again equals w4', () => {
  near(initDifficulty(Rating.Again), 6.4133);
});

test('M2: initial difficulty clamps into [1, 10] (Easy underflows to 1.0)', () => {
  // raw D0(Easy) = w4 - e^(3*w5) + 1 ≈ -4.77 -> clamps to 1.0
  assert.equal(initDifficulty(Rating.Easy), 1.0);
});

test('M2: every initial difficulty lands within [1, 10]', () => {
  for (const r of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
    const d = initDifficulty(r);
    assert.ok(d >= 1 && d <= 10, `D0(${r}) out of range: ${d}`);
  }
});

test('M2: parameter validation rejects arrays whose length != 21 (golden #4)', () => {
  assert.throws(() => validateParameters(DEFAULT_PARAMETERS.slice(0, 20)), /21/);
  assert.throws(() => validateParameters([...DEFAULT_PARAMETERS, 0.1]), /21/);
  assert.throws(() => validateParameters(null), /21/);
  assert.doesNotThrow(() => validateParameters([...DEFAULT_PARAMETERS]));
});

test('M2: invalid ratings are rejected', () => {
  assert.throws(() => initStability(0), RangeError);
  assert.throws(() => initDifficulty(5), RangeError);
});

// ===========================================================================
// M3 — Single-step stability update (recall branch)
// ===========================================================================

test('M3: Good recall from (D=5, S=100, R=0.9) -> ~250.0894 (golden #5)', () => {
  near(nextStability(5, 100, 0.9, Rating.Good), 250.0894);
});

test('M3: Good recall from (D=10, S=100, R=0.9) -> ~125.0149 (golden #5)', () => {
  near(nextStability(10, 100, 0.9, Rating.Good), 125.0149);
});

test('M3: higher difficulty yields a smaller stability gain', () => {
  const lowD = nextStability(5, 100, 0.9, Rating.Good);
  const highD = nextStability(10, 100, 0.9, Rating.Good);
  assert.ok(highD < lowD, `expected ${highD} < ${lowD}`);
});

test('M3: Easy bonus exceeds Good, Hard penalty falls below Good', () => {
  const hard = nextStability(5, 100, 0.9, Rating.Hard);
  const good = nextStability(5, 100, 0.9, Rating.Good);
  const easy = nextStability(5, 100, 0.9, Rating.Easy);
  assert.ok(hard < good && good < easy, `expected ${hard} < ${good} < ${easy}`);
});

// The M5-deferral placeholder is retired: the forget branch now exists.
// Oracle values from py-fsrs 6.3.1 (throwaway conformance oracle, see plan §6).

test('M5: Again (forget) from (D=5, S=100, R=0.9) matches py-fsrs', () => {
  near(nextStability(5, 100, 0.9, Rating.Again), 3.747287425553074, 1e-9);
});

test('M5: forget branch takes the min with the short-term cap S/e^(w17*w18)', () => {
  near(nextStability(2, 500, 0.6, Rating.Again), 11.34183758740005, 1e-9);
});

test('M5: forget always lands below the prior stability at these points', () => {
  assert.ok(nextStability(5, 100, 0.9, Rating.Again) < 100);
  assert.ok(nextStability(2, 500, 0.6, Rating.Again) < 500);
});

test('M5: nextDifficulty matches py-fsrs for Again/Good/Easy from D=5', () => {
  near(nextDifficulty(5.0, Rating.Again), 8.341762369296838, 1e-9);
  near(nextDifficulty(5.0, Rating.Good), 4.9902283692968386, 1e-9);
  near(nextDifficulty(5.0, Rating.Easy), 3.3144613692968385, 1e-9);
});

test('M5: nextDifficulty clamps at the floor; damping+reversion keep it under 10', () => {
  assert.equal(nextDifficulty(1.0, Rating.Easy), 1); // floor clamp engages
  // At D=10, linear damping zeroes the delta and mean reversion pulls slightly
  // *below* 10, so the ceiling clamp never engages here (py-fsrs agrees).
  near(nextDifficulty(10.0, Rating.Again), 9.985228369296838, 1e-9);
  assert.ok(nextDifficulty(10.0, Rating.Again) <= 10);
});

test('M5: shortTermStability matches py-fsrs (incl. the Good/Easy >= 1 clamp)', () => {
  // Good on a fresh S0(Good): raw increase ~0.9945 clamps to 1 -> unchanged.
  near(shortTermStability(2.3065, Rating.Good), 2.3065, 1e-9);
  near(shortTermStability(2.3065, Rating.Again), 0.7750839828558984, 1e-9);
  near(shortTermStability(100, Rating.Easy), 133.5032721130538, 1e-9);
});

// ===========================================================================
// M4 — Interval
// ===========================================================================

test('M4: at retention 0.9 the interval equals stability (pre-rounding)', () => {
  assert.equal(nextInterval(100), 100);
});

test('M4: the post-Good stability (~250.09) yields a 250-day interval', () => {
  // This is the "250-day interval" the plan cites: interval of the *updated*
  // stability after a Good review, not interval(S=100).
  assert.equal(nextInterval(250.0894), 250);
});

test('M4: interval clamps to [1, 36500]', () => {
  assert.equal(nextInterval(0.001), 1);
  assert.equal(nextInterval(1e9), 36500);
});
