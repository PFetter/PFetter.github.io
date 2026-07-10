// Card lifecycle state machine (M6): New -> Learning -> Review -> Relearning.
//
// Semantics mirror py-fsrs 6.3.1's Scheduler.review_card exactly (it is the
// conformance reference); the API surface mirrors ts-fsrs: createEmptyCard(),
// repeat(card, now) previewing all four ratings, next(card, now, rating).
//
// Conventions:
// - All datetimes are stored on cards as UTC ISO-8601 strings (IndexedDB- and
//   JSON-friendly); APIs accept Date, ISO string, or epoch milliseconds.
// - Learning/relearning steps are given in *minutes*.
// - next() is pure with respect to its inputs: it returns a new card.
// - "Same-day" review = elapsed whole days since last_review < 1, matching
//   py-fsrs's timedelta.days semantics.
// - Interval fuzzing (enableFuzz) mirrors py-fsrs: it only ever perturbs the
//   interval for a card whose *resulting* state is Review (graduating out of
//   Learning/Relearning, or continuing in Review) — never the minute-based
//   Learning/Relearning step due times. See lib/fuzz.js for the algorithm
//   and its injectable-RNG rationale.

import {
  Rating,
  DEFAULT_PARAMETERS,
  DESIRED_RETENTION,
  MAXIMUM_INTERVAL,
  validateParameters,
  retrievability,
  initStability,
  initDifficulty,
  nextStability,
  nextDifficulty,
  shortTermStability,
  nextInterval,
} from './fsrs.js';
import { toMs, toIso } from './datetime.js';
import { applyFuzz } from './fuzz.js';

export const State = Object.freeze({
  New: 'new',
  Learning: 'learning',
  Review: 'review',
  Relearning: 'relearning',
});

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

export function createEmptyCard(now = new Date(), overrides = {}) {
  return {
    id: overrides.id ?? generateId(),
    type: 'basic',
    front: '',
    back: '',
    fields: {},
    ...overrides,
    state: State.New,
    step: 0,
    stability: null,
    difficulty: null,
    due: toIso(now),
    last_review: null,
    reps: 0,
    lapses: 0,
  };
}

export function createScheduler({
  parameters = DEFAULT_PARAMETERS,
  desiredRetention = DESIRED_RETENTION,
  maximumInterval = MAXIMUM_INTERVAL,
  learningSteps = [1, 10], // minutes
  relearningSteps = [10], // minutes
  enableFuzz = false,
  rng = Math.random,
} = {}) {
  validateParameters(parameters);
  const w = [...parameters];
  const intervalOpts = { desiredRetention, maximumInterval };
  const learningMs = learningSteps.map((m) => m * MIN_MS);
  const relearningMs = relearningSteps.map((m) => m * MIN_MS);

  // The only place nextInterval() feeds a *Review-state* due date. Applying
  // fuzz here (rather than at each call site) guarantees every path that can
  // land a card in Review — graduation from Learning/Relearning, or an
  // ordinary Review continuation — gets fuzzed identically, and that
  // Learning/Relearning step due times (which never call this) cannot be.
  function intervalMsForReview(stability) {
    let days = nextInterval(stability, w, intervalOpts);
    if (enableFuzz) days = applyFuzz(days, { maximumInterval, rng });
    return days * DAY_MS;
  }

  function next(card, now, rating) {
    assertRating(rating);
    const nowMs = toMs(now);
    const out = structuredClone(card);

    const daysSince =
      out.last_review == null
        ? null
        : Math.floor((nowMs - toMs(out.last_review)) / DAY_MS);

    updateMemoryState(out, rating, daysSince);

    let dueMs;
    switch (out.state) {
      case State.New:
      case State.Learning:
        dueMs = stepThrough(out, rating, nowMs, learningMs, State.Learning);
        break;
      case State.Review:
        if (rating === Rating.Again && relearningMs.length > 0) {
          out.state = State.Relearning;
          out.step = 0;
          out.lapses += 1;
          dueMs = nowMs + relearningMs[0];
        } else {
          dueMs = nowMs + intervalMsForReview(out.stability);
        }
        break;
      case State.Relearning:
        dueMs = stepThrough(out, rating, nowMs, relearningMs, State.Relearning);
        break;
      default:
        throw new Error(`unknown card state: ${out.state}`);
    }

    out.due = toIso(dueMs);
    out.last_review = toIso(nowMs);
    out.reps += 1;

    const reviewLog = {
      card_id: out.id,
      rating,
      review_datetime: toIso(nowMs),
    };
    return { card: out, reviewLog };
  }

  // Memory-state update shared by every state, mirroring py-fsrs:
  // fresh card -> init; same-day -> short-term formula; otherwise long-term
  // formulas driven by retrievability at *whole* elapsed days.
  function updateMemoryState(card, rating, daysSince) {
    if (card.stability == null || card.difficulty == null) {
      card.stability = initStability(rating, w);
      card.difficulty = initDifficulty(rating, w);
    } else if (daysSince != null && daysSince < 1) {
      card.stability = shortTermStability(card.stability, rating, w);
      card.difficulty = nextDifficulty(card.difficulty, rating, w);
    } else {
      const r = retrievability(Math.max(0, daysSince ?? 0), card.stability, w);
      card.stability = nextStability(card.difficulty, card.stability, r, rating, w);
      card.difficulty = nextDifficulty(card.difficulty, rating, w);
    }
  }

  // Learning/relearning step walker (identical structure in py-fsrs for both).
  // Returns the due time in ms and sets state/step on the card.
  function stepThrough(card, rating, nowMs, stepsMs, stateName) {
    const graduate = () => {
      card.state = State.Review;
      card.step = null;
      return nowMs + intervalMsForReview(card.stability);
    };

    // Edge case: card scheduled by a scheduler with more steps than this one.
    if (stepsMs.length === 0 || (card.step >= stepsMs.length && rating !== Rating.Again)) {
      return graduate();
    }

    switch (rating) {
      case Rating.Again:
        card.state = stateName;
        card.step = 0;
        return nowMs + stepsMs[0];
      case Rating.Hard: {
        card.state = stateName;
        // step stays the same
        if (card.step === 0 && stepsMs.length === 1) return nowMs + stepsMs[0] * 1.5;
        if (card.step === 0 && stepsMs.length >= 2) {
          return nowMs + (stepsMs[0] + stepsMs[1]) / 2;
        }
        return nowMs + stepsMs[card.step];
      }
      case Rating.Good:
        if (card.step + 1 === stepsMs.length) return graduate();
        card.state = stateName;
        card.step += 1;
        return nowMs + stepsMs[card.step];
      case Rating.Easy:
        return graduate();
      /* c8 ignore next 2 -- assertRating guards this */
      default:
        throw new RangeError(`unknown rating: ${rating}`);
    }
  }

  function repeat(card, now) {
    const preview = {};
    for (const rating of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy]) {
      preview[rating] = next(card, now, rating);
    }
    return preview;
  }

  function retrievabilityOf(card, now) {
    if (card.last_review == null || card.stability == null) return 0;
    const days = Math.max(0, Math.floor((toMs(now) - toMs(card.last_review)) / DAY_MS));
    return retrievability(days, card.stability, w);
  }

  return { next, repeat, retrievabilityOf, config: Object.freeze({
    parameters: Object.freeze(w),
    desiredRetention,
    maximumInterval,
    learningSteps: [...learningSteps],
    relearningSteps: [...relearningSteps],
    enableFuzz,
  }) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function assertRating(r) {
  if (r !== 1 && r !== 2 && r !== 3 && r !== 4) {
    throw new RangeError(`rating must be 1..4 (Again..Easy), got ${r}`);
  }
}

function generateId() {
  return globalThis.crypto?.randomUUID
    ? crypto.randomUUID()
    : `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
