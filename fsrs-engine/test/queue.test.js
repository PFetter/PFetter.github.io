// M8 — Due-queue selection: correct due set + ordering at a fixed `now`.
//
// Ordering convention: Learning/Relearning (soonest due) first, since their
// due times are minutes away and losing the step context is costly; then
// Review cards due today; then New cards last, capped by newCardLimit. New
// cards are always eligible regardless of their `due` timestamp (it's just
// creation time and carries no scheduling meaning until first review).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDueQueue } from '../lib/queue.js';
import { State } from '../lib/scheduler.js';

const NOW = '2024-06-15T12:00:00.000Z';

function card(id, state, dueOffsetMin) {
  const due = new Date(Date.parse(NOW) + dueOffsetMin * 60_000).toISOString();
  return { id, state, due, stability: 1, difficulty: 5, step: state === State.New ? 0 : null };
}

test('M8: excludes Learning/Relearning/Review cards not yet due', () => {
  const cards = [
    card('l-future', State.Learning, 5), // due in 5 min: not yet due
    card('r-future', State.Review, 60 * 24), // due tomorrow: not yet due
  ];
  assert.deepEqual(selectDueQueue(cards, NOW), []);
});

test('M8: includes Learning/Review cards exactly at or before now', () => {
  const cards = [card('l-now', State.Learning, 0), card('r-past', State.Review, -10)];
  const ids = selectDueQueue(cards, NOW).map((c) => c.id);
  assert.deepEqual(ids.sort(), ['l-now', 'r-past'].sort());
});

test('M8: New cards are always eligible regardless of due timestamp', () => {
  const cards = [card('n-future', State.New, 60 * 24 * 30)]; // "due" a month out
  const ids = selectDueQueue(cards, NOW).map((c) => c.id);
  assert.deepEqual(ids, ['n-future']);
});

test('M8: ordering is Learning/Relearning, then Review, then New', () => {
  const cards = [
    card('new1', State.New, 0),
    card('review1', State.Review, -1),
    card('relearn1', State.Relearning, -1),
    card('learn1', State.Learning, -1),
  ];
  const ids = selectDueQueue(cards, NOW).map((c) => c.id);
  const groupOf = (id) =>
    id.startsWith('learn') || id.startsWith('relearn') ? 0 : id.startsWith('review') ? 1 : 2;
  const groups = ids.map(groupOf);
  assert.deepEqual(groups, [...groups].sort());
});

test('M8: within a group, cards are ordered by due time ascending', () => {
  const cards = [
    card('review-later', State.Review, -1),
    card('review-earlier', State.Review, -10),
    card('review-earliest', State.Review, -60),
  ];
  const ids = selectDueQueue(cards, NOW).map((c) => c.id);
  assert.deepEqual(ids, ['review-earliest', 'review-earlier', 'review-later']);
});

test('M8: newCardLimit caps how many New cards are included', () => {
  const cards = [card('n1', State.New, 0), card('n2', State.New, 1), card('n3', State.New, 2)];
  const ids = selectDueQueue(cards, NOW, { newCardLimit: 2 }).map((c) => c.id);
  assert.equal(ids.length, 2);
});

test('M8: newCardLimit does not affect Learning or Review cards', () => {
  const cards = [
    card('learn1', State.Learning, -1),
    card('review1', State.Review, -1),
    card('n1', State.New, 0),
    card('n2', State.New, 0),
  ];
  const ids = selectDueQueue(cards, NOW, { newCardLimit: 0 }).map((c) => c.id);
  assert.deepEqual(ids.sort(), ['learn1', 'review1'].sort());
});

test('M8: an empty card list returns an empty queue', () => {
  assert.deepEqual(selectDueQueue([], NOW), []);
});

test('M8: full mixed-state scenario produces the exact expected set and order', () => {
  const cards = [
    card('learn-due', State.Learning, -2),
    card('learn-notyet', State.Learning, 30),
    card('relearn-due', State.Relearning, -1),
    card('review-due-1', State.Review, -100),
    card('review-due-2', State.Review, -5),
    card('review-notyet', State.Review, 5),
    card('new-1', State.New, 0),
    card('new-2', State.New, 0),
  ];
  const ids = selectDueQueue(cards, NOW).map((c) => c.id);
  assert.deepEqual(ids, [
    'learn-due',
    'relearn-due',
    'review-due-1',
    'review-due-2',
    'new-1',
    'new-2',
  ]);
});
