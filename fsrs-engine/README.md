# fsrs-engine

A local-first, **framework-free** web app implementing the **FSRS-6** spaced-repetition
scheduler from scratch, differentiated by programmer-native card types (code-snippet
cloze first; regex drills and executable cards later).

Goals: learning value (memory modeling, IndexedDB, PWA) and portfolio value — a
provably reference-correct FSRS implementation validated against the py-fsrs v6.x
golden vectors.

## Conventions

- Vanilla JavaScript, **no framework, no build step, zero third-party dependencies**.
- Strict red-green-refactor TDD — the failing test comes first, always.
- Test runner: the built-in Node.js runner (`node --test`). Scheduler logic lives in
  `lib/` as pure functions so it runs headless; the same ES module loads unchanged in
  the browser.
- `lib/` grows by an "extract on second use" rule, mirrored by `test/`.

## Correctness

The scheduler is conformance-tested against **py-fsrs 6.3.1**:

- All four plan golden vectors pass: the 13-review interval-history vector
  `[0, 2, 11, 46, 163, 498, 0, 0, 2, 4, 7, 12, 21]`, the memory-state vector
  (S ≈ 53.62691, D ≈ 6.3574867) at the plan's 1e-4 tolerance *and* at 1e-9
  against exact reference values, the difficulty floor (10× Easy → D = 1.0),
  and 21-length parameter validation.
- A 40-step mixed-rating extended vector (`test/golden-extended.json`,
  generated directly from py-fsrs 6.3.1) matches per step — stability,
  difficulty, state, step, interval, and due timestamp — at 1e-9.
- The reference was used only as a throwaway oracle to generate golden data
  and to verify the fuzz algorithm's bands; shipped code remains
  zero-dependency.

## Run the tests

```
node --test
```

## Milestone status

| # | Milestone | Status |
|---|-----------|--------|
| M1 | Forgetting curve `retrievability(t, S)` | ✅ done |
| M2 | Initial stability/difficulty + parameter validation | ✅ done |
| M3 | Single-step stability update (recall branch) | ✅ done |
| M4 | Interval calculation | ✅ done |
| M5 | Full-sequence conformance (both py-fsrs vectors) | ✅ done |
| M6 | Card lifecycle state machine | ✅ done |
| M7 | IndexedDB round-trip | ✅ done |
| M8 | Due-queue selection | ✅ done |
| M9 | Code-cloze rendering | ✅ done |
| M10 | Export/import | ✅ done |
| M11 | PWA offline caching (app shell) | ✅ done |

All v1 milestones (M1–M10) plus interval fuzzing and PWA offline caching
(M11) are complete: **126/126 tests passing.**

## Public API

`lib/fsrs.js` — pure FSRS-6 math (all take an optional trailing `w` array):

```
Rating                                   // { Again:1, Hard:2, Good:3, Easy:4 }
DEFAULT_PARAMETERS                       // 21 FSRS-6 weights
validateParameters(w)                    // enforces length === 21
retrievability(elapsedDays, stability)   // FSRS-6 power curve (whole-day elapsed)
initStability(rating)                    // S0 = w[rating-1]
initDifficulty(rating)                   // D0, clamped to [1, 10]
nextStability(D, S, R, rating)           // recall + forget (FSRS-6 min-cap) branches
shortTermStability(S, rating)            // same-day review branch
nextDifficulty(D, rating)                // damping + mean reversion to raw D0(Easy)
nextInterval(S, w, {desiredRetention, maximumInterval})
```

`lib/scheduler.js` — card lifecycle (API surface mirrors ts-fsrs, semantics
mirror py-fsrs):

```
State                                    // New / Learning / Review / Relearning
createEmptyCard(now, overrides)          // fresh card, content fields passthrough
createScheduler({ parameters, desiredRetention, maximumInterval,
                  learningSteps, relearningSteps,
                  enableFuzz, rng })      // steps in minutes; rng defaults to Math.random
scheduler.next(card, now, rating)        // -> { card, reviewLog }, non-mutating
scheduler.repeat(card, now)              // preview all four ratings
scheduler.retrievabilityOf(card, now)
```

Cards store datetimes as UTC ISO-8601 strings (IndexedDB/JSON-friendly);
`now` arguments accept `Date`, ISO string, or epoch milliseconds.

`lib/fuzz.js` — interval jitter, mirrors py-fsrs's fuzz bands exactly:

```
fuzzRange(intervalDays, maximumInterval)       // pure; the [min, max] window
applyFuzz(intervalDays, { maximumInterval, rng }) // -> jittered integer day count
```

`lib/pwa.js` — app-shell cache logic (M11):

```
CACHE_NAME_PREFIX, CACHE_VERSION, CACHE_NAME, APP_SHELL_FILES
staleCacheNames(existingCacheNames, currentCacheName)  // old versions to evict
isCacheableRequest(request, origin)                    // same-origin GET filter
```

`service-worker.js` (repo root) is the real browser artifact: a **classic**
(non-module) service worker — not `{ type: "module" }` — because Safari/iOS
doesn't support module service workers and Safari/iOS is a primary offline
target. That means it can't `import` `lib/pwa.js` and duplicates its cache
name and file list; `test/pwa.test.js` parses `service-worker.js`'s literal
source and asserts the two copies match, so they can't silently drift.
`manifest.json` and `icons/icon.svg` make the app installable.

### Verifying offline support

The install/activate/fetch handlers run in a service-worker global scope
(`self`, `caches`) that doesn't exist under Node, so this part is verified
manually rather than by `node --test` — same boundary as the real IndexedDB
adapter:

1. Serve the repo over `http://` or `https://` (service workers refuse
   `file://`) — e.g. `npx http-server` or GitHub Pages itself.
2. Load the page once online; confirm registration in DevTools → Application
   → Service Workers, and that the app shell appears under Cache Storage.
3. In DevTools → Network, switch to Offline (or actually disconnect) and
   hard-reload. The app should load fully — this is the scenario a plain
   HTTP cache can't guarantee, since it's implicit and not durable across a
   cold, fully offline first load.

Known limitation: the manifest ships one SVG icon (works well in Chrome/
Edge/Firefox via `"sizes": "any"`); dedicated 192×192/512×512 PNGs would be
needed for full iOS "Add to Home Screen" icon fidelity — a polish item, not
a functional gap.

### Notable FSRS-6 semantics (easy to get wrong)

- Retrievability uses **whole elapsed days** (floored), not fractional time.
- The forget branch is `min(long-term formula, S / e^(w17·w18))` — the
  short-term cap is new in FSRS-6.
- Same-day reviews use the separate short-term formula, clamped so Good/Easy
  never shrink stability.
- `nextDifficulty` mean-reverts toward the **unclamped** `D0(Easy) ≈ -4.7716`.
- **Interval fuzzing** (`enableFuzz: true`) matches py-fsrs's bands exactly
  (±15%/±10%/±5% by interval length, no fuzz under 3 days) and only ever
  perturbs intervals for cards ending in the **Review** state — Learning and
  Relearning step due times (minutes-based) are never fuzzed. The RNG is
  injectable (`rng` option, defaults to `Math.random`) so it stays testable
  deterministically rather than statistically. See `lib/fuzz.js` for a
  documented JS-vs-Python rounding-mode caveat at exact `.5` boundaries.

`lib/db.js` — persistence (M7). Two adapters share one interface:

```
createMemoryAdapter()                    // in-memory fake; what node --test runs against
createIndexedDbAdapter(dbName)           // real browser backend, same interface
openDatabase(adapter, { migrations })    // stamps/upgrades schemaVersion in meta
```

Object stores: `cards` (keyPath `id`), `reviews` (auto-incrementing `seq`),
`meta` (arbitrary key/value — schema version, scheduler parameters, deck
settings, etc). The real IndexedDB adapter is not unit-tested under
`node --test` (`indexedDB` doesn't exist there) — see plan §6; it's exercised
by `index.html` in-browser instead.

`lib/queue.js` — due-card selection (M8):

```
selectDueQueue(cards, now, { newCardLimit })
// -> Learning/Relearning (due, soonest first), then Review (due), then New
//    (always eligible, capped by newCardLimit)
```

`lib/cloze.js` — code-snippet cloze cards (M9). Pure string in/out, safe by
default (HTML-escaped):

```
parseCloze(text)                  // "{{c1::a+b}}" / "{{c1::a+b::hint}}" -> segments
clozeNumbers(segments)
renderClozeHtml(segments, { revealed })   // revealed: Set<number> | 'all'
renderCodeCloze(text, opts)       // wraps in <pre class="code-cloze"><code>
```

`lib/exportImport.js` — full JSON dump (M10):

```
exportAll(adapter)                        // -> { formatVersion, exportedAt, cards, reviews, meta }
importAll(adapter, data, { clearExisting })
```
