# Code reorganization proposal (not executed)

_Written 2026-09-23. **Status: proposal only. No code has been changed.**
Do this **after** the 2026-09-26 presentation. The showcase-polish stages are
editing `js/main.js` right now, and a structural refactor would collide with
them._

Line numbers below are from the working tree on 2026-09-23 (`main.js` ≈ 2,626
lines, mid Stage 1). They will drift, so find code by the **function names**,
which are stable.

## Why

`js/main.js` holds four modes' state as ~75 module-level `let`s side by side,
alongside ~127 `$()` DOM lookups, the camera state machine, and a single
~560-line `loop()`. Nothing enforces "leaving a mode resets what that mode
armed." Each teardown is hand-written inside `setMode()` or `setState()`.
Both the project's own audit and `CLAUDE.md` name this as the main bug class:
- The 2026-09-11 `pendingChallengeStart` bug: a flag armed in Challenge, never
  cleared on failure or on a mode switch, auto-started Challenge's HUD on top
  of Practice.
- The 2026-09-11 audit note in `docs/CHANGELOG.md` suggested "a small
  per-mode `{enter, leave}` table" if it happened again.

A second instance of the same shape exists today, though it is **suspected, not
reproduced**. In `advanceAz()`, the 1,300 ms "Next: X" bridge timer calls
`setTarget(next)` without re-checking `azRun` or `mode`. So leaving Practice
during that window could set a practice target while another mode is visible.
`reward()`'s `setTimeout(advanceAz, 950)` has the same exposure, though
`advanceAz` does re-check `azRun`. Verify with `tools/testHarness.js` before
treating this as a bug. It is the kind of thing a mode contract with owned
timers removes.

## Constraints (unchanged working agreement)

- No build step, no bundler, no new dependencies. Plain ES modules served
  statically, so every new file is just another `import`.
- Every new `js/**/*.js` file goes into `sw.js`'s `CORE` precache list, with a
  `VERSION` bump. **Caveat:** `tools/ci-check.mjs` checks 1 (syntax) and 2
  (CORE vs. files) currently list only the top level of `js/`, using a
  non-recursive `readdirSync`. Files in new subfolders would silently escape
  both checks. So step 1 makes those two checks recursive first. The
  fallback is flat names (`js/mode-practice.js`, …) instead of subfolders.
- The DOM-free engine modules (`normalize`, `knn`, `speller`, `decode`, …) are
  **not touched**. This is only about the UI glue.
- **One step per commit.** Run `node tools/ci-check.mjs` + `tools/selftest.html`
  (0 FAIL) between every step. `main.js` isn't covered by either suite, so
  every step also gets the manual smoke below.

### Smoke test after every step (~3 min)

This complements the suites; it does not replace them.

1. Load `index.html?dev` on the dev server.
2. Switch Practice → Challenge → Spell → Read → Practice twice, quickly. Check
   the console for errors.
3. **Practice:** pick a letter; start an A→Z run; Skip; exit the run.
4. **Challenge:** Start with the camera off, then switch mode before it comes
   up (the `pendingChallengeStart` path).
5. **Spell:** toggle Fluid and Drill; Space / Back / Clear.
6. **Read:** play, pause, step and scrub a word; wrong answer → Next.
7. With `window.__aslDev` (see `tools/testHarness.js`), feed a synthetic hand
   in each mode.
8. For steps that touch `loop()` (steps 5–7): one live-camera check on a real
   device.

## Current shape of `main.js` (2026-09-23)

| Lines (approx.) | Section | Belongs to |
|---|---|---|
| 1–60 | imports; the `motion` / `swipe` / `twohand` / `transition` singletons | shared |
| 61–210 | decoder globals; `$()` DOM refs for every mode; `sound` / `fx` / `bg` | shared (refs for all modes mixed together) |
| 214–272 | `refSheet` (S4b); load-error banners (`showLoadError`, `refreshReadLoadError`, `refreshSpellLoadError`) | shared, Read, Spell |
| 272–347 | prefs (`loadPref`, `savePref`, `loadJSON`, `saveJSON`); reduced motion; `buzz`; intro modal | shared |
| 348–407 | mastery grid + streak (`masteryCounts`, `renderProgressCount`, `renderProgressPanel`, `touchStreak`) | Practice |
| 408–435 | high-contrast toggle | shared |
| 437–550 | most of the ~75 top-level `let`s: practice hold/reward state, camera state, the A→Z/Review run, spell, fluid, drill and read state; `reviewPriority`, `buildReviewQueue` | **all modes, interleaved** |
| 552–685 | `loadWordBank`, `loadCurriculum`, `loadDecoderAssets`, dataset boot (builds classifier, players, restores prefs) | boot |
| 686–924 | letter picker, `setTarget`, runs (`setAzRun`, `advanceAz`, `skipLetter`, `showRunCard`), `applyHand`, `setHold`, `updateMeter` | Practice |
| 925–1269 | Read: categories, Course path, transport (`enableTransport`, `togglePause`, `stepReadLetter`), `playWord`, `nextReadWord`, `enterRead` / `leaveRead`, `renderDiff`, `renderCompare`, `judgeRead` | Read |
| 1270–1448 | `setMode` (under a "challenge mode" header), `clearChallengeHud`, `startChallenge`, `renderChallenge` | generic + Challenge |
| 1449–1495 | `reward`, `showToast`, `syncMuteBtn` | Practice + shared |
| 1496–1654 | `setState` (with Challenge-specific branches), `start`, `stop`, `fail`, `flip`, `applyFacing` | camera lifecycle |
| 1655–2230 | `smoothLandmarks`, **`loop()`**. Shared per-frame work runs ~1672–1840. Then per-mode branches: Spell ~1841–2031, Challenge ~2032–2040, Practice ~2041–2214 | camera + **every mode** |
| 2231–2269 | wake lock, `friendlyError` | camera lifecycle |
| 2270–2626 | event wiring for all modes; Spell (`syncSpellText`, `applyFluid`, the drill functions, `speak`, `doSpellCopy`, the A–Z grid); Read wiring; `openDemoZoom`; global keydown | all modes, interleaved |

`js/reference.js` (1,125 lines) has a similar mix. It contains pure scoring
(`buildReference`, `LETTER_GUIDE`, `wordTransDur`, `buildWordSpans`,
`sampleWordSpans`) plus the canvas demo player (`createCanonicalPlayer`,
`drawCanonical`, the stroke painters).

## Target structure

```
js/
  main.js               boot + top-level wiring only (~250 lines): build ctx, load data,
                        register modes, restore prefs, hook camera + mode toggle
  app/
    ctx.js              the shared context object (below); no mode logic
    prefs.js            loadPref / savePref / loadJSON / saveJSON (+ try/catch)
    camera-loop.js      setState, start, stop, fail, flip, applyFacing, wake lock,
                        friendlyError, and loop() reduced to "build a Frame, draw the
                        shared overlay, hand the Frame to the active mode"
    frame.js            buildFrame(): hasHand, raw + smoothed landmarks, realHand,
                        vec, lastPred, stroke, swipe/twohand input
    mode-registry.js    setMode(): exit(old) → shared UI toggles → enter(new)
    ui-common.js        toast, mute button, contrast, intro, load-error banners,
                        demo-zoom overlay
  modes/
    practice-mode.js    picker, setTarget, runs (A→Z/Review), meter, reward, mastery,
                        + the practice branch of loop()
    challenge-mode.js   start/HUD/render, pendingChallengeStart, + its loop branch
    spell-mode.js       spell loop branch, fluid, drill, speak, copy/paste, A–Z grid
    read-mode.js        everything in today's 925–1269 + its wiring
  reference.js          pure scoring only (unchanged API for buildReference etc.)
  demo-player.js        createCanonicalPlayer + stroke painters (moved from reference.js)
```

Naming: `modes/*-mode.js` avoids clashing with the engine's
`js/challenge.js`, which stays as the pure game-state module.

### The mode lifecycle contract

```js
// modes/challenge-mode.js
export function createChallengeMode(ctx) {
  const fresh = () => ({ pendingStart: false, lastTickAt: 0 });
  let s = fresh();                 // ALL mode-owned mutable state lives here
  const timers = new Set();        // ALL mode-owned timeouts, cleared on exit
  const later = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); };

  return {
    id: "challenge",
    enter(prev) { /* show chCard, set copy for current camera state */ },
    exit(next) {
      ctx.challenge.stop();
      clearHud();
      timers.forEach(clearTimeout); timers.clear();
      s = fresh();                 // cannot "forget" a flag: the whole object is replaced
    },
    onCameraState(state, live) { /* today's challenge branches in setState() */ },
    onFrame(frame) { /* today's loop() lines ~2032–2040 */ },
  };
}
```

`setMode()` becomes generic:

```js
function setMode(next) {
  if (next === current.id) return;
  const prev = current;
  prev.exit(next);                 // the mode tears down what it armed
  current = modes[next];
  applySharedModeUi(next);         // panels hidden/shown, aria-pressed, numHands, savePref
  current.enter(prev.id);
}
```

`setState()` calls `current.onCameraState(next, live)`. `loop()` calls
`current.onFrame(frame)`.

**The rule that prevents the bug class:** a mode keeps *all* of its mutable
state in its `s` object and *all* of its timers in `later()`. `exit()` replaces
`s` wholesale and clears the timers. Adding a new flag to a mode then can't
leak across modes, because nothing has to remember to reset it.

A cheap guard can be added later: a `?dev` assertion that, after
`exit()`, `JSON.stringify(s) === JSON.stringify(fresh())`.

### What stays shared (in `ctx`)

- **DOM:** the refs, grouped per mode (`ctx.dom.practice.refPanel` and so
  on). Grouping them also documents which elements each mode owns.
- **Engine handles:** `classifier`, `stabilizer`, `reference`, `refiner`,
  `speller`, `decoder`, `reader`, `course`, `challenge` (the engine), the
  players.
- **Browser services:** `sound`, `fx`, `bg`, `overlay`, `tracker`, the
  prefs helpers, and `showToast`.
- **Camera facts:** `state`, `facingMode`, `trackedHand`, `handOverride`.
  These are read by modes and written only by `camera-loop.js`.

Modes import nothing from each other. Anything two modes share goes through
`ctx`. The engine modules stay as they are.

## Incremental plan

Each step is its own commit, with ci-check + selftest + smoke in between. The
order goes from least-coupled to most-coupled, so the risky `loop()` work comes
last.

| Step | Change | Risk | Why here |
|---|---|---|---|
| 0 | **Baseline.** Record selftest and ci-check output. Write the smoke checklist above into `tools/testHarness.js`'s header as a scripted sequence where possible. Optionally add a `?dev` console command that cycles modes. | none | You need a before/after to compare against |
| 1 | **Make ci-check checks 1–2 recurse into `js/` subfolders** (they are plain Node, so this stays dependency-free). Then do the **pure leaf extractions, with no behavior change:** `app/prefs.js`, `app/ui-common.js` (toast, mute, contrast, intro, load-error banners, `openDemoZoom`). `main.js` imports them. Update `sw.js` CORE + VERSION. | low | Mechanical, and it exercises the "new file → CORE list" loop once |
| 2 | **Introduce `ctx` + the registry, with no modes migrated yet.** Wrap today's `setMode` / `setState` branches as a `legacy` adapter so behavior is identical. | low–med | Puts the contract in place before any mode depends on it |
| 3 | **Read mode → `modes/read-mode.js`.** It has no camera, it already has `enterRead()` / `leaveRead()`, and it owns its own player, timers (`readTimers`, `rdTransportRaf`) and wiring. | low | The least-coupled mode proves the contract |
| 4 | **Challenge → `modes/challenge-mode.js`.** `pendingChallengeStart` moves into `s`. Remove the Challenge branches from `setState()` (they become `onCameraState`). Add the 2026-09-11 regression to the smoke test: Start with the camera denied → switch to Practice → camera on → no HUD. | med | Small, but it is the mode that produced the known cross-mode bug |
| 5 | **Spell → `modes/spell-mode.js`.** Move the loop branch (~190 lines) plus `syncSpellText`, `applyFluid`, the drill, `speak`, and copy/paste. The `swipe` / `twohand` / `transition` singletons and `spellStab` become Spell-owned (`reset()` in `exit()`). | med–high | Touches `loop()`; needs a live check |
| 6 | **Practice → `modes/practice-mode.js`.** The biggest: picker, `setTarget`, runs, meter, `reward`, mastery, and the loop branch (~175 lines). Run timers go through `later()` (this fixes the suspected `advanceAz` leak). | high | Most state; do it once the pattern is proven three times |
| 7 | **Slim `loop()`.** Once every mode branch is gone, `loop()` becomes `buildFrame()` → shared overlay/badge/stats → `current.onFrame(frame)`. Move it to `app/camera-loop.js` + `app/frame.js`. | med | Pure consolidation after steps 3–6 |
| 8 | **Split `reference.js`** into scoring (pure, keeps its name and API) and `demo-player.js` (canvas). Update the imports in `main.js`, the modes, `tools/selftest.js`, and `tools/ci-check.mjs` (check 12 imports `reference.js` under Node). | low–med | Independent of the mode split; can be done any time |
| 9 | **Naming, comments, dead code** (lists below). | low | Last, so renames don't fight the moves |

If time runs out after any step, the codebase is still consistent. Each step
leaves a working app.

## Naming fixes

- `azRun`, `setAzRun`, `advanceAz`, `azTimes`, `azDone`, `azSkip`, `azNext`
  → `run*` (`inRun`, `setRun`, `advanceRun`, …). They drive the Review queue
  too, via `runKind`, so "Az" is misleading.
- `let mode = "practice"; // "practice" | "challenge" | "spell"`: the comment
  is missing `"read"`.
- In `loop()`, `rawLeft`, `isLeftHand` and `left` are three names for one
  boolean. Keep `isLeftHand`.
- `m` (the shape-match result in `loop()`) → `shapeMatch`. `vec` → `liveVec`.
- `spellStab` vs `stabilizer` → `spellStabilizer` / `practiceStabilizer`.
  They are two instances with different thresholds.
- The `// ---- challenge mode` header sits above the generic `setMode()`.
- `refPlayer` / `readPlayer` / `demoZoomPlayer` are fine. After step 8 they
  are all `createCanonicalPlayer` from `demo-player.js`.

## Comment fixes

- `main.js`'s file header still describes the Stage 1–4 app ("a side panel
  shows its reference photo … An optional dashed outline guide"). Replace it
  with a 10-line map of the four modes and where each lives.
- `config.js`'s `NUM_HANDS` comment ("Kept at 2 for now so the Stage 1
  skeleton demo shows both hands; drop to 1 once classification lands") is
  stale. `setMode()` already switches between 1 and 2 hands.
- Comments that cite plan-stage codes ("S3", "S4b", "B4") are useful history,
  but a newcomer can't resolve them. Add a one-line legend to `main.js`'s
  header pointing at `docs/CHANGELOG.md`.

## Dead / misplaced code

Verify each item before removing it.

- **`js/refine.js`** is shelved and never imported by the app, but it's in
  `sw.js`'s `CORE` list, so every install downloads it. Move it to `tools/`
  next to its only consumer (`tools/selftest.js`, the `refine.js` checks), or
  drop it from CORE. Moving is cleaner, because ci-check requires CORE to
  match `js/`.
- **`drawCanonical()`** (`reference.js`) is only called by `tools/selftest.js`.
  The app uses `createCanonicalPlayer`. Remove it with its selftest check, or
  keep it deliberately as a debug helper, with a comment saying so.
- **`tools/ci-check.mjs` check 14** is a placeholder for a future
  `js/orient.js` (old stage S7). The 2026-09-23 plan puts `palmFacing()` in
  `js/normalize.js` instead (Stage 7b). Retarget the placeholder when 7b
  lands.
- Labs in `tools/` (`mlp-lab.*`, `harvest-kaggle.html`, `import_kaggle.py`)
  are records of experiments, some of them disproven. Keep them, but add a
  one-line "status: experiment / disproven, see CHANGELOG date" to each
  header.

## Out of scope for this proposal

- Changing any engine module's API, or any recognition or tuning behavior.
- A framework, a bundler, TypeScript, or a test runner. Each of those would be
  a dependency decision for the owner.
- Unit-testing `main.js` directly. After the split, modes *could* be tested in
  `selftest.html` with a fake `ctx` and a detached DOM fragment. Decide that
  after step 6.
