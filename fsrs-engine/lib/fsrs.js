// FSRS-6 scheduler — pure functions, zero third-party dependencies.
//
// Target: FSRS-6 (21 parameters). Golden data from py-fsrs v6.x.
// Model: three-component DSR — Difficulty (1..10), Stability (days for R to
// fall 100% -> 90%), Retrievability.
//
// Milestones implemented here: M1 (curve), M2 (init S/D + param validation),
// M3/M5 (stability updates: recall, forget, and same-day short-term branches),
// M4 (interval), M5 (difficulty update). The card lifecycle state machine
// (M6) lives in scheduler.js.

export const Rating = Object.freeze({
  Again: 1,
  Hard: 2,
  Good: 3,
  Easy: 4,
});

// Default FSRS-6 parameter array (21 weights), 0-indexed as w0..w20.
export const DEFAULT_PARAMETERS = Object.freeze([
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
]);

export const DESIRED_RETENTION = 0.9;
export const MAXIMUM_INTERVAL = 36500;
const S_MIN = 0.001;

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

// Golden test #4: reject any weight array whose length != 21.
// Wired into the scheduler constructor at M6; exported now so it is testable.
export function validateParameters(w) {
  if (!Array.isArray(w) || w.length !== 21) {
    const got = Array.isArray(w) ? `length ${w.length}` : typeof w;
    throw new RangeError(`FSRS-6 requires exactly 21 parameters, got ${got}`);
  }
  return w;
}

// Derived forgetting-curve constants (FSRS-6):
//   DECAY  = -w20
//   FACTOR = 0.9^(1/DECAY) - 1
// (The fixed DECAY=-0.5 / FACTOR=19/81 values are FSRS-4.5/5 — never used here.)
function decay(w) {
  return -w[20];
}
function factor(w) {
  return Math.pow(0.9, 1 / decay(w)) - 1;
}

// ---------------------------------------------------------------------------
// M1 — Forgetting curve
// ---------------------------------------------------------------------------

// R(t, S) = (1 + FACTOR * t/S)^DECAY.
// By construction R(0,S)=1 and R(S,S)=0.9.
export function retrievability(elapsedDays, stability, w = DEFAULT_PARAMETERS) {
  if (!(stability > 0)) throw new RangeError('stability must be > 0');
  if (elapsedDays < 0) throw new RangeError('elapsedDays must be >= 0');
  return Math.pow(1 + factor(w) * (elapsedDays / stability), decay(w));
}

// ---------------------------------------------------------------------------
// M2 — Initial stability & difficulty
// ---------------------------------------------------------------------------

// S0(rating) = w[rating-1], floored at S_MIN.
export function initStability(rating, w = DEFAULT_PARAMETERS) {
  assertRating(rating);
  return Math.max(w[rating - 1], S_MIN);
}

// Raw (unclamped) D0. NOTE: the unclamped value is the mean-reversion target
// used by nextDifficulty (arrives M5); the *public* initDifficulty clamps it.
function rawInitDifficulty(rating, w) {
  return w[4] - Math.exp(w[5] * (rating - 1)) + 1;
}

// D0(rating), clamped to [1, 10]. For defaults, Easy underflows (~ -4.77 -> 1).
export function initDifficulty(rating, w = DEFAULT_PARAMETERS) {
  assertRating(rating);
  return clampDifficulty(rawInitDifficulty(rating, w));
}

// ---------------------------------------------------------------------------
// M3 — Single-step stability update
// ---------------------------------------------------------------------------

// Stability after a (not same-day) review.
//
// Recall branch (Hard/Good/Easy):
//   S' = S * (1 + e^w8 * (11 - D) * S^(-w9) * (e^(w10*(1-R)) - 1)
//                 * [w15 if Hard] * [w16 if Easy])
// Forget branch (Again), FSRS-6:
//   S' = min( w11 * D^(-w12) * ((S+1)^w13 - 1) * e^(w14*(1-R)),
//             S / e^(w17*w18) )               <- short-term cap, new in FSRS-6
export function nextStability(difficulty, stability, retention, rating, w = DEFAULT_PARAMETERS) {
  assertRating(rating);
  if (rating === Rating.Again) {
    const longTerm =
      w[11] *
      Math.pow(difficulty, -w[12]) *
      (Math.pow(stability + 1, w[13]) - 1) *
      Math.exp(w[14] * (1 - retention));
    const shortTermCap = stability / Math.exp(w[17] * w[18]);
    return clampStability(Math.min(longTerm, shortTermCap));
  }
  const hardPenalty = rating === Rating.Hard ? w[15] : 1;
  const easyBonus = rating === Rating.Easy ? w[16] : 1;
  const growth =
    Math.exp(w[8]) *
    (11 - difficulty) *
    Math.pow(stability, -w[9]) *
    (Math.exp(w[10] * (1 - retention)) - 1) *
    hardPenalty *
    easyBonus;
  return clampStability(stability * (1 + growth));
}

// Stability after a same-day review (elapsed < 1 day), FSRS-6:
//   SInc = e^(w17 * (rating - 3 + w18)) * S^(-w19), clamped to >= 1 for
//   Good/Easy (a successful same-day review never shrinks stability).
export function shortTermStability(stability, rating, w = DEFAULT_PARAMETERS) {
  assertRating(rating);
  let inc = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(stability, -w[19]);
  if (rating === Rating.Good || rating === Rating.Easy) {
    inc = Math.max(inc, 1);
  }
  return clampStability(stability * inc);
}

// Difficulty after any review:
//   delta = -w6 * (rating - 3)
//   damped = D + delta * (10 - D) / 9                    (linear damping)
//   D' = w7 * D0raw(Easy) + (1 - w7) * damped            (mean reversion)
// The mean-reversion target is the *unclamped* D0(Easy) ~ -4.7716.
export function nextDifficulty(difficulty, rating, w = DEFAULT_PARAMETERS) {
  assertRating(rating);
  const delta = -w[6] * (rating - 3);
  const damped = difficulty + (delta * (10 - difficulty)) / 9;
  const reverted = w[7] * rawInitDifficulty(Rating.Easy, w) + (1 - w[7]) * damped;
  return clampDifficulty(reverted);
}

// ---------------------------------------------------------------------------
// M4 — Interval
// ---------------------------------------------------------------------------

// Days until R decays to desiredRetention:
//   t = (S / FACTOR) * (retention^(1/DECAY) - 1), rounded, clamped to [1, MAX].
// Because FACTOR = 0.9^(1/DECAY) - 1, at retention 0.9 this reduces to t = S.
export function nextInterval(
  stability,
  w = DEFAULT_PARAMETERS,
  { desiredRetention = DESIRED_RETENTION, maximumInterval = MAXIMUM_INTERVAL } = {},
) {
  const raw = (stability / factor(w)) * (Math.pow(desiredRetention, 1 / decay(w)) - 1);
  return Math.min(Math.max(Math.round(raw), 1), maximumInterval);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assertRating(r) {
  if (r !== 1 && r !== 2 && r !== 3 && r !== 4) {
    throw new RangeError(`rating must be 1..4 (Again..Easy), got ${r}`);
  }
}

function clampDifficulty(d) {
  return Math.min(Math.max(d, 1), 10);
}

function clampStability(s) {
  return Math.max(s, S_MIN);
}
