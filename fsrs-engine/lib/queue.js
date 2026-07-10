// Due-queue selection (M8): correct due set + ordering at a fixed `now`.
//
// Order: Learning/Relearning (soonest due) -> Review (due today) -> New
// (capped by newCardLimit). New cards are always eligible — their `due` is
// creation time, not a scheduling signal, until the first review.

import { State } from './scheduler.js';
import { toMs } from './datetime.js';

export function selectDueQueue(cards, now, { newCardLimit = Infinity } = {}) {
  const nowMs = toMs(now);
  const dueAsc = (a, b) => toMs(a.due) - toMs(b.due);
  const isDue = (c) => toMs(c.due) <= nowMs;

  const learning = cards
    .filter((c) => (c.state === State.Learning || c.state === State.Relearning) && isDue(c))
    .sort(dueAsc);

  const review = cards.filter((c) => c.state === State.Review && isDue(c)).sort(dueAsc);

  const fresh = cards
    .filter((c) => c.state === State.New)
    .sort(dueAsc)
    .slice(0, newCardLimit);

  return [...learning, ...review, ...fresh];
}
