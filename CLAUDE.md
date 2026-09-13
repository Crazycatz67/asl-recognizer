# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-only ASL fingerspelling recognizer (A–Z + J/Z motion letters). Plain
HTML/CSS/JS — no framework, no bundler, no build step, no `package.json`. The
project's working agreement is to ask before adding any dependency beyond
MediaPipe; keep new tooling dependency-free (see `tools/ci-check.mjs`).

**`asl-letter-recognition-plan.md` is the actual source of truth** — dated
revision history, current status, and the full backlog. Read its "Session
resume" block first when picking up work here; don't duplicate its content in
this file.

## Commands

Run locally (needs a secure context — `http://localhost` works, a bare
`file://` does not, since camera access requires it):
```
start-server.cmd          # Windows double-click: PowerShell static server + opens the browser
serve.ps1                 # same, manual
python -m http.server 8000  # or any other static server
```

Test on a phone over LAN (self-signed HTTPS): `start-phone.cmd`.

Run the unit/integration suite (open on the dev server, needs a browser — not
headless-runnable, since it exercises canvas/DOM-touching modules too):
```
http://localhost:8000/tools/selftest.html
```
164 checks. Run after every change that touches `js/`.

Run the free, dependency-free CI checks (plain Node, no install — syntax on
every `js/*.js` + `sw.js`, `sw.js`'s `CORE` precache list vs. the real `js/`
directory, dataset well-formedness):
```
node tools/ci-check.mjs
```
Also runs in GitHub Actions on every push/PR to `main` (`.github/workflows/ci.yml`).

Sweep `js/transition.js`'s letter-segmentation thresholds against real
recorded sequences (also plain Node, no browser):
```
node tools/sweep-transition.mjs [sequenceLimit]
```
Read the caveat at the top of that file before trusting its numbers — see
Gotchas below.

Deploy: `git push` to `main` deploys to GitHub Pages. **Bump `VERSION` in
`sw.js` on every deploy** or existing installs keep serving the old cached
shell (the service worker precaches the whole app for offline use).

## Skills & automation

This repo has three project-scoped Claude Code skills (`.claude/skills/`) that
package the workflows above so they don't get re-derived by hand each time —
they fire automatically when a request matches their intent (no need to recall
exact names; typing `/` also lists everything available with descriptions):

- **`asl-verify`** — runs `ci-check.mjs` → `selftest.html` (164+ checks) →
  checks the `sw.js` VERSION bump → commits → (with confirmation) pushes and
  confirms CI green. Triggers on "verify/ship/test/deploy this."
- **`asl-resume`** — reconstructs exactly where a prior session left off (plan
  doc + memory + live git state) when picking this project back up cold.
  Triggers on "where did we leave off" / session start.
- **`asl-bugwatch`** — maintains `Bug Reports/checklist.md`, the persistent
  bug tracker (a task-clipboard, not a one-off report), picks the next
  highest-priority open item, and enforces the same verify-before-`FIXED`
  discipline as `asl-verify`. Triggers on "check for bugs," "what's still
  open," or "update the bug list."

There's also a **`Stop` hook** in `.claude/settings.json`: on every session
end in this directory, if the working tree is dirty it makes a silent local
`git add -A && git commit -m "WIP checkpoint (auto)"` — never pushes — purely
so an abrupt crash/close never loses uncommitted work.

## Architecture

**Everything funnels through one state machine, `js/main.js`** (~2000 lines).
It owns the camera lifecycle (`idle → requesting → loading → searching ↔
tracking`, with an `error` state recoverable via "Try again"), the per-frame
detection loop, and all four modes' UI wiring (Practice / Challenge / Spell /
Read) as module-level state living side by side with no per-mode isolation.
**This is deliberate but means mode-transition bugs are the main risk class**
— a 2026-09-11 audit found and fixed exactly this shape of bug (a flag armed
in Challenge mode, never cleared on failure or mode-switch, that could
auto-trigger Challenge's HUD while the visible mode was Practice). When
`setMode()` doesn't explicitly reset something a new feature adds, that's
where the next one will come from.

**The recognition pipeline**, run per frame in Practice/Challenge:
```
webcam → MediaPipe HandLandmarker → js/normalize.js (landmarks → 63-dim
vector + 11 engineered shape features) → js/knn.js (classify) →
js/heads.js (learned refinement heads fix the M/N and D/O/C confusions
kNN alone can't) → js/stabilizer.js (a letter only "confirms" after
STABLE_FRAMES consecutive holds) → js/overlay.js (draws it)
```
Spell mode's "fluid" continuous-signing path swaps `stabilizer.js` for
`js/transition.js` (commits a letter when the hand *settles after a move*,
not on a still-hold — real signing speed never holds still long enough for
the stabilizer) feeding `js/speller.js` → `js/decode.js` (trie + beam search
turns a noisy letter stream into words/sentences).

**The reusable "engine" core is deliberately DOM-free and runs under plain
Node**, not just the browser: `normalize`, `knn`, `dataset`, `stabilizer`,
`transition`, `decode`, `speller`, `curriculum`, `spelldrill`, `reader`,
`motion`, `swipe`, `twohand`, `heads`, `refine`. This is what makes
`tools/ci-check.mjs` and `tools/sweep-transition.mjs` possible without a
browser — `dataset.js`/`heads.js` call `fetch()` with relative URLs, so a Node
script needs a small shim to read from disk instead (see either tool file for
the pattern) before importing them. Everything DOM/canvas/audio-touching
(`camera`, `handTracker`, `overlay`, `skeleton`, `sound`, `fx`, `bg`,
`mediapipe`) only runs in a real browser.

`js/config.js` centralizes every tunable constant and external URL (MediaPipe
CDN version, classifier `k`, confidence/stability thresholds) — check there
before hunting for a magic number elsewhere.

## Gotchas

- **`data/fs_sequences.json` (300 recorded sequences, from the Google Kaggle
  ASL Fingerspelling competition) uses MediaPipe *Holistic* landmarks. The
  classifier is trained on `data/dataset.json`, which uses MediaPipe
  *HandLandmarker* landmarks (via `js/normalize.js`). These are NOT
  interchangeable.** Retraining or fine-tuning the kNN on the Kaggle sequences
  was tried and disproven (moved replay accuracy 0%→0%). Absolute accuracy
  numbers from replaying `fs_sequences.json` through the live pipeline (e.g.
  `tools/sweep-transition.mjs`, `tools/replay-lab.html`) are meaningless in
  isolation — only *relative* comparisons between two configs on the same
  replay are valid signal. The sequences' legitimate remaining uses are a
  future sequence-model architecture (not this one) and decoder stress-test
  phrases.
- **The service worker (`sw.js`) never registers on `localhost`** (checked in
  `index.html`'s inline bootstrap script) — dev reloads always get fresh
  files. PWA/offline behavior can only be verified on the deployed site.
- **Before proposing a UI/UX gap as unimplemented, check the code first.** A
  2026-09-11 pass found several proposed "gaps" (per-finger error coloring on
  the live skeleton, progressive up-front hints, sound-cue captions) already
  fully implemented — the visible behavior just didn't match what a quick
  read of the feature list suggested. `overlay.js`'s `drawGuide()` in
  particular already colors every joint and bone segment by its own error,
  not just one worst joint.
- The live camera loop, MediaPipe hand detection, and real-device behavior
  (iOS Safari, Android Chrome) can't be verified in an automation/headless
  browser — no real webcam, and a hidden browser pane throttles
  `requestAnimationFrame` to ~1fps. These need a human on the deployed site.
