# ASL letter recognition — plan & status

The working source of truth for this project. It is kept deliberately short: the
current state, where to pick up, and what's next. Long material lives in `docs/`.

| Doc | What's in it |
|---|---|
| **this file** | Session resume, current status, the active backlog (showcase polish), open carry-over items |
| [`Bug Reports/checklist.md`](Bug%20Reports/checklist.md) | The live bug tracker, with numbered items and statuses |
| [`docs/CHANGELOG.md`](docs/CHANGELOG.md) | The full dated revision history, newest first. **Add a dated entry there per change.** |
| [`docs/research-and-future.md`](docs/research-and-future.md) | Stage 8 (fingerspelling → sentence → speech) design, Stage 9 (sequence model, dual engine, skin-tone evaluation, out-of-vocabulary words) |
| [`docs/original-plan-and-milestones.md`](docs/original-plan-and-milestones.md) | Archive: original Stage 1–7 plan, the 2026-09-03 status table, North-star milestones M0–M5, backlog tables B1–B21 with their DONE / STALE / NOT-A-GAP reasoning |
| [`docs/code-reorg-proposal.md`](docs/code-reorg-proposal.md) | Proposal (not executed) for splitting `js/main.js` by mode |
| [`asl-project-roadmap.md`](asl-project-roadmap.md) | The research-informed 5-phase vision beyond letters |

## Session resume — read this first
_Last updated 2026-09-23. This is the fast catch-up after a context reset. For
detail, see `docs/CHANGELOG.md` and `git log`._

- **Where we are:** Every mode has shipped: Practice (free pick, A→Z run, Review, Test blind), Challenge, Spell (with a Fluid + speak beta, word drill, and swipe/two-hand gestures), and Read (with Course, transport controls, and near-miss feedback). The app is also an installable offline PWA with an about page and CI. The 2026-09-12 mobile/demo-hand stage plan got through **S0–S5** (S4 only partly: S4a shell grid and S4b bottom sheet). Checklist fixes #1, #3, #6, #7, #8, #10 and the ghosting half of #2 are done. Last commit: `41c43f0` (2026-09-15), `sw.js` **v69**.
- **What's happening now:** The owner presents on **~Sat 2026-09-26** and will use the repo as a portfolio piece. The approved **showcase-polish plan** (below) is the active backlog. The full plan file is outside the repo at `~/.claude/plans/cryptic-squishing-donut.md`. **Stage 1 (performance) is in progress.** The decoder rewrite in `js/decode.js` is done but uncommitted.
- **Uncommitted work may be in flight:** On 2026-09-23 another session was editing `js/`, `index.html`, `css/` and `sw.js` while the docs were reorganized. Run `git status` / `git diff --stat` before trusting any status line below.
- **Verified working (at the last commit):** `node tools/ci-check.mjs` all pass; `tools/selftest.html` **174/174**. Recognition is **97.1%** on held-out data (kNN + learned M/N and D/O/C heads), and every letter is at least 92%.
- **Can't verify in-session:** the live camera loop, frame rate, J/Z strokes, sounds and animations (automation-browser limits: no real webcam, and rAF is throttled in a hidden pane). The owner confirms these on the deployed site. Anything like that gets `FIXED (needs live confirm)`.
- **Don't re-explore:**
  - The single-measurement M↔N / D↔O tie-breaker (`js/refine.js`). It was disproven and is shelved; the fix that worked is `js/heads.js`.
  - Retraining the kNN on the Kaggle sequences (B3). It was disproven because of the Holistic-vs-HandLandmarker domain gap.
  - The palm-orientation cue from a 3-landmark cross product (B11). It was disproven against real centroids. Showcase Stage 7b proposes a *different* `palmFacing()`, which must be validated offline against B11's negative result before it ships.
- **Environment note:** The repo now lives on macOS (`~/Developer/asl-recognizer`). The `.claude/settings.json` Stop hook and the `asl-resume` skill's stage-plan pointer still hard-code the old Windows path (`C:\Users\maila\...`). The `.cmd`/`.ps1` launchers are Windows-only; on a Mac use `python3 -m http.server 8000`.
- **Working agreement:**
  - Explain choices plainly as you go.
  - Add a dated `docs/CHANGELOG.md` entry per change, and keep this file's status current.
  - Flag deviations and wait for confirmation.
  - Ask before adding any dependency beyond MediaPipe.
  - Work one stage per commit: verify → bump `sw.js` VERSION → commit → push only with owner confirmation.
  - The owner is an AI major building this to learn.

## Current status (2026-09-23)

| Area | State |
|---|---|
| Recognition engine | **Done.** MediaPipe HandLandmarker → 74-dim normalized vector → kNN (k=5) + learned refinement heads. 97.1% held-out; ~95% flat across ±30° tilt. |
| Practice | **Done, heavily polished.** Per-joint correction guide, animated demo hand (bone-space kinematics), hold-to-win, A→Z run, Review (spaced repetition), Test blind, mastery badge + streak. |
| Challenge | **v1 done.** Too easy per 2026-09-23 testing, so it gets reworked in showcase Stage 5. |
| Spell | **Works; reliability issues found 2026-09-23** (checklist 17–21). Fluid + speak mode is a beta toggle and **has never been validated live at real signing speed**. |
| Read + Course | **Done** (S3 transport, near-miss feedback). |
| J / Z | Works but unreliable. J fires on tilt/relax and Z rarely registers (checklist 5, 6, 20, 22, 23); rewrite in Stage 3. |
| Demo hand | S2a–S2e + #7 fixed most swings. Root cause of the remaining "impossible" motion found (checklist 24); fix in Stage 4. |
| Mobile layout | S4a/S4b shipped. S4c–S4e (letter-picker sheet, thumb dock, breakpoint cleanup) not done. Real-device acceptance still owed. |
| PWA / offline, about page, accessibility v1, high-contrast toggle | **Done.** Screen-reader walkthrough still owed (B5). |
| Testing | `tools/ci-check.mjs` (Node, also in GitHub Actions) + `tools/selftest.html` (174 checks, browser). |

## Active backlog — Showcase polish (2026-09-23 plan)

Approved by the owner on 2026-09-23 for the presentation around 2026-09-26. The
full plan with file:line references is at `~/.claude/plans/cryptic-squishing-donut.md`.
Work goes in order of risk × visibility. **Each stage is its own verified commit.**

| # | Stage | Summary | Status |
|---|---|---|---|
| 1 | **Performance** | (1) Decoder freeze. (2) The frame-cap misfire (~22–24 fps instead of 30). (3) `numHands` 2 only in Spell. (4) Hot-path DOM writes only on change. (5) Idle rAF loops (`refPlayer` during a static hold; `bg.js` capped or static with the camera off). (6) Optional downscaled detection. | **DONE** `d9f22ff`, pushed. Decoder cold 40-letter 315→25 ms, ~1 ms/appended letter (identical output); frame cap fixed (→30/s, needs live confirm); numHands 1 outside Spell; unchanged DOM/style writes skipped; bg ~30 fps; demo player skips identical frames. (6, optional downscale, not done.) |
| 2 | **Spell reliability** | Release-to-rearm before any re-commit. Time-based hold (~450 ms, vote share ≥0.8). Word-flush `acceptMs` 1000 → ~2200 with a distinct quiet "word" cue. J/Z strokes gated out of `speller.feed`. Swipe-erase fixes (openFrac over moving frames, ratio 1.6→1.2, buffer clear, cooldown > window). Per-sound cooldown in `sound.js`. | **DONE** `e582e17`, pushed — needs live confirm. gapMs 700, acceptMs 2000, stabilizer 10@0.8, moved in hand-spans, J/Z gated + replaces its start letter, `sound.word()` + per-sound cooldowns, swipe fixes. selftest 178/178. |
| 3 | **J / Z detection rewrite** (`js/motion.js`) | Aspect-corrected, hand-size-scaled coordinates. A fingertip-path channel plus a hand-orientation channel. A hold-start requirement (≥200 ms of the I or index-only shape). 32-point template match ($1/Protractor-style) plus direction checks. Buffer cleared on hit, cooldown ≥ window. Synthetic-stroke invariants in `ci-check.mjs` (tilt, relax and one-wag must not fire). | **DONE** `8f463d3`, pushed — needs live confirm. Shape gate + image-space aspect-corrected paths + hook/twist (J) and 2-reversal+descent (Z); tools/synth-hand.js scenarios in ci-check #13c + selftest (202/202). |
| 4 | **Demo-hand animation** | **4a:** fix the mirrored `NEUTRAL_HAND` / `I_HAND` and `POINT_HAND`'s thumb side (and confirm checklist #16 is gone). **4b:** rigid palm + clamped local flexion (`posekin.js`). **4c:** interpolated depth + depth sort. **4d:** J/Z demos from real 3D poses (supination). Plus ci-check invariants. | **4a DONE** `7393db4` (palm-collapse guard in ci-check #13b). 4b–4d NOT STARTED. |
| 5 | **Challenge** | Hide "seeing X" during play. Combo multiplier ×1→×4. Normal/Hard difficulty (confusables, 3–5-letter words later). A fair wrong-letter time drain. End screen with slowest letters and "Practice these". Persisted bests. Fix the start-card copy and use `START_LIVES`. | NOT STARTED |
| 6 | **Sound design** | Distinct synthesized families (close-tick, letter-lock, word cue, combo ladder, countdown, life lost, game over, NEW BEST, run complete). An optional music bed in Challenge. A visual twin for every sound. | NOT STARTED |
| 7 | **Onboarding & understanding** | **7a:** interactive ~75 s first-run tour (`js/tour.js`). **7b:** `palmFacing()` orientation cue, badge and hints, plus rewritten `LETTER_GUIDE` copy. **7c:** colorblind-safe overlay with redundant encoding and a color-key chip. **7d:** mirror/viewer toggle, auto-flip hysteresis, "show me slowly". **7e:** copy rewrite. **7f:** confidence ring, tricky-letters review, mastery map. | NOT STARTED |
| 8 | **Presentation framing** | `about.html` + intro framed as a **fingerspelling practice tool** (not "ASL translation"), complementary to Google's Sign-to-Text. Credit PopSign. Invite Deaf testers. Bump `sw.js` VERSION on every deploy. | NOT STARTED (the README side of the framing was done 2026-09-23) |

**Cut line.** These must be live and owner-tested by Friday night:
- Stages **1, 2, 4a, 5, 6**
- Stages **7a / 7c / 7e**

If time runs short, these land after the weekend:
- **3** (the ship fallback is its quick guards: buffer clear, cooldown ≥ window, strict shape gate, 2 reversals for Z)
- **4b–4d**
- **7b**
- **7f**

**Deferred past the presentation:**
- A native wrapper (Capacitor)
- A LiteRT.js small sequence model
- Spaced-repetition upgrades
- Streak freeze
- A placement test

**Verification, every stage:**
- `node tools/ci-check.mjs` and `tools/selftest.html` all green.
- New invariants added per stage.
- Before/after offline benches for Stage 1.
- Demo-hand renders at t=0..1 for all 26 letters (Stage 4).
- The owner live-confirms on the deployed site. Until then, checklist items stay `FIXED (needs live confirm)`.

## Carry-over backlog (still open from before 2026-09-23)

Full rows and reasoning are in `docs/original-plan-and-milestones.md`.

- **Live validation of Fluid mode** at real signing speed. This was the long-standing single blocker before any further Stage 8 work.
- **Multi-signer live evaluation + MST skin-tone check** (Stage 5 / Task 6). This needs people, not code. The protocol is in `docs/research-and-future.md` → Skin tone.
- **B5:** a real screen-reader walkthrough (NVDA/VoiceOver). Also check whether the `#demoZoom` overlay still lacks a focus trap now that `js/sheet.js` exists.
- **B6:** number signs 0–9 (high community value). **B7:** accounts (post-showcase). **B17:** ROI crop-and-rerun. **B19:** shareable progress card. **B20:** context-narrowed decoder lexicons. **B21:** lexicalized fingerspelling (a research question for Deaf reviewers).
- **B12 / demo hand:** largely addressed by S2a–S2e and checklist #7. The remainder is showcase Stage 4.
- **B16:** 1280×720 capture, still unverified live. It is tied to checklist #2.
- **Mobile S4c–S4e** and real-device acceptance (iOS Safari + Android Chrome, portrait and landscape).
- **Known unrelated gap:** the tap-to-enlarge demo canvas renders blank for J/Z (found during S2d part 2, not investigated).
- **Code clarity:** `docs/code-reorg-proposal.md` (proposal only). Do it after the presentation.

## 5. Out of scope for this plan

- Full ASL word signs (motion-based, need face/pose tracking + a temporal model — a separate project phase; Stage 8 is a *fingerspelling-based approximation*, not this)
- ASL grammar (facial expression as grammar, non-manual markers)
- Two-handed letters or regional sign variants (tracked as backlog B6 for the alphabet variants only)

These stay explicitly parked so this plan doesn't quietly expand mid-build.
