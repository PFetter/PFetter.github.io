// Interval fuzzing (optional FSRS feature): adds jitter to the computed
// interval for cards ending in the Review state, so cards reviewed together
// don't clump onto the same future day forever. Mirrors py-fsrs 6.3.1's
// Scheduler._get_fuzzed_interval exactly — same FUZZ_RANGES bands, same
// rounding/clamping order.
//
// Design: the RNG is injectable (defaults to Math.random) so tests can pin
// an exact draw and assert deterministic outcomes, rather than asserting
// statistical bounds over many random runs. That's the same anti-flakiness
// stance the plan already takes toward IndexedDB tests (§6) — random inputs
// don't have to mean random test outcomes.
//
// Known rounding-mode caveat: py-fsrs's round() is Python's round-half-to-
// even; JS Math.round() is round-half-up. The two can disagree by 1 at an
// exact .5 boundary. In practice the delta computation almost never lands
// on an exact .5, and this module is intentionally documented here rather
// than "quietly" diverging — the same trap flagged for the FSRS-4.5 decay
// constants during M1.

import { MAXIMUM_INTERVAL } from './fsrs.js';

const FUZZ_RANGES = Object.freeze([
  { start: 2.5, end: 7.0, factor: 0.15 },
  { start: 7.0, end: 20.0, factor: 0.1 },
  { start: 20.0, end: Infinity, factor: 0.05 },
]);

const NO_FUZZ_BELOW_DAYS = 2.5;
const MIN_FUZZED_INTERVAL = 2;

// The [minIvl, maxIvl] window fuzz may land in for a given (already rounded)
// interval length. Pure and deterministic — exposed for direct testing
// independent of any randomness.
export function fuzzRange(intervalDays, maximumInterval = MAXIMUM_INTERVAL) {
  let delta = 1.0;
  for (const r of FUZZ_RANGES) {
    delta += r.factor * Math.max(Math.min(intervalDays, r.end) - r.start, 0);
  }
  let minIvl = Math.round(intervalDays - delta);
  let maxIvl = Math.round(intervalDays + delta);
  minIvl = Math.max(MIN_FUZZED_INTERVAL, minIvl);
  maxIvl = Math.min(maxIvl, maximumInterval);
  minIvl = Math.min(minIvl, maxIvl);
  return [minIvl, maxIvl];
}

// intervalDays should already be the rounded, clamped output of
// nextInterval(). Returns a jittered interval — still an integer number of
// days, still <= maximumInterval. `rng()` must return a value in [0, 1),
// matching the contract of Math.random.
export function applyFuzz(intervalDays, { maximumInterval = MAXIMUM_INTERVAL, rng = Math.random } = {}) {
  if (intervalDays < NO_FUZZ_BELOW_DAYS) return intervalDays;
  const [minIvl, maxIvl] = fuzzRange(intervalDays, maximumInterval);
  const fuzzed = rng() * (maxIvl - minIvl + 1) + minIvl;
  return Math.min(Math.round(fuzzed), maximumInterval);
}
