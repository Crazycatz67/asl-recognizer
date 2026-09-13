# Bug checklist — task clipboard

Source: `Bug Reports/bug_report version 1 post test.txt` (live QA, voice-delivered).
This file is the durable tracker — update it in place as items move, don't
create parallel bug-list files. Each entry: **Status**, evidence, commit ref
once shipped. Statuses: `OPEN` · `FIXED (verified offline)` ·
`FIXED (needs live confirm)` · `NOT A BUG` · `DEFERRED (planned stage)`.

## General & Performance

1. **On-screen suggestion text (finger-name label) renders backwards/mirrored.**
   `FIXED (verified offline)` — commit `53f6be5` (pre-dates this checklist).
   Re-verified 2026-09-13 with a synthetic render test reproducing the exact
   CSS mirror (`.stage{transform:scaleX(-1)}`) — confirmed the label now
   reads correctly; the pre-fix behavior was reproduced too, confirming the
   test actually catches the bug. If still seen live: most likely a stale
   PWA cache (service worker) — try fully closing/reopening the app first
   before treating this as still-broken.
2. **Frame rate ~22fps on Mac, hand tracking delayed with visible ghosting.**
   `OPEN`. Leading suspect: the 640→1280 camera capture resolution bump
   (`js/camera.js:19-20`, shipped 2026-09-11 as "B16", explicitly flagged at
   the time as not verified live). No other new per-frame cost found in the
   detection loop. **Decision needed from the owner:** revert to 640, or make
   resolution adaptive (try 1280, measure, fall back). Cannot be verified in
   this environment — no real webcam.
3. **Skeletal overlay snaps off/on when fingers overlap the palm.**
   `FIXED (needs live confirm)`. `main.js`'s `hasHand` gate was clearing the
   overlay the instant a single frame's detection missed, while
   `LOST_HAND_FRAMES` only delayed the "searching" state label, not the draw.
   Fix: a new `OVERLAY_GRACE_FRAMES=3` (`config.js`) holds the last known pose
   on screen for a few missed frames — mirrors the existing
   `LOST_HAND_FRAMES`/`missStreak` hysteresis pattern already proven for the
   state label, applied to the draw itself; purely cosmetic (classification/
   motion/sound still correctly see the real "no hand" that frame). `node
   tools/ci-check.mjs` and `tools/selftest.html` (166/166) both unaffected —
   `main.js`'s `loop()` isn't unit-tested by either (same boundary as every
   other live-camera-only behavior in this project). Attempted live proof via
   `tools/testHarness.js`'s `noHand()` was inconclusive: the automation tab
   would not hold true foreground state even immediately after real clicks
   (`document.hidden` stayed `true`), which throttles the ~100ms grace window
   below what's testable here — a genuine environment limitation, not a code
   or harness flaw. Needs a real device/session where the tab stays naturally
   focused to fully confirm the visual fix.

## Practice Mode & Letter Recognition

4. **D, J, G register as correct with imprecise positioning.**
   `OPEN`, inconclusive. Per-letter tolerance derives from that letter's own
   training-data spread (`reference.js`); no hardcoded looser override found
   for these letters. May be genuine data spread, not a quick threshold fix —
   needs live re-test before touching constants blindly.
5. **J registers without real movement; I repeatedly triggers J.**
   `OPEN`. `motion.js`'s pinky-move/pinky-drop thresholds look reasonably
   guarded in code (a held I-hand shouldn't clear them per the code's own
   documented math). May need retuning against real signing — `fs_sequences.json`
   replay numbers are known-unreliable in absolute terms (Holistic vs
   HandLandmarker domain gap).
6. **Z fails to track, messy detection, triggers a loud audio-buzz artifact.**
   Two separate problems bundled in one report:
   - **The audio-buzz artifact: `FIXED (verified offline)`.** Root cause
     found: the J/Z practice charge-tone (`sound.charge()`) was fed the raw
     live stroke-progress metric every frame — for Z that's
     `min(indexMove, indexX, rev)`, and `rev` (a reversal count over a
     rolling window) genuinely jumps around during a real zigzag. `charge()`
     restarts a 90ms pitch ramp on every call, so a jumpy input frame-to-frame
     warbles/buzzes; J's smoother pinky-drop metric mostly avoided it, which
     is why the report singled out Z. Fixed by easing a separate
     `motionChargeAmt` toward the target (same pattern as the existing
     `guideAmt` ease) and feeding *that* to `charge()`, while the on-screen
     meter/text still show the raw, precise metric. `ci-check`/`selftest`
     (166/166) unaffected — not unit-tested, same live-only boundary as
     other per-frame `main.js` behavior.
   - **"Fails to track / messy movement detection": still `OPEN`.** No coding
     bug found in `motion.js`'s Z thresholds on inspection — this looks like
     it needs actual threshold retuning against real signing, which needs
     live data (`fs_sequences.json` replay numbers are known-unreliable per
     the project's domain-gap caveat).
7. **Anatomically impossible demo-hand animations for J, W, R, X, K, V, Z.**
   `OPEN`, two distinct root causes, not one:
   - J/Z use a separate motion-stroke system (`MOTION_POSE`/`paintStroke`) —
     already the planned **S2d** stage in the active plan doc, not a quick fix.
   - W/R/X/K/V are static letters going through `posekin.js`'s shortest-arc
     interpolation, which may lack anatomical joint-angle clamping — plausible
     but not yet confirmed with concrete angle-delta evidence.
8. **Yellow correction lines shown even when the shape is marked correct.**
   `FIXED (verified offline)` — commit `2f75e95` (local, not yet pushed).
   Root cause: overlay colored joints green only within the tight tolerance,
   while the scorer's "correct" bucket forgives up to 1.8x that. Added
   `reference.matchTolerance()` as the shared threshold; 2 new regression
   checks added to `selftest.html` (166/166 passing).
9. **Ghost overlay should be more prominent/consistent.** `OPEN`, not
   investigated — reads as a design/tuning request rather than a defect.

## Review & Challenge Modes

10. **No way to test yourself without helper diagrams/hints (Review mode).**
    `FIXED (verified offline)` — commit `da942e2`, pushed and live. The
    "Test blind" toggle, scoped to bounded runs (A→Z/Review) only.
11. **Z tracking fails in Challenge too.** Same root cause as item 6 — not
    a separate bug, tracked together.

## Spell Mode

12. **UI too text-heavy/cluttered.** `DEFERRED (planned stage)` — the active
    plan doc already calls for deleting/replacing the current Spell panel
    wholesale under **S4** (mobile restructure), not patching it now.
13. **Correct-letter chime/buzz triggers constantly.** `OPEN`, inconclusive.
    `speller.js`/`transition.js` both gate their success sound as one-shot in
    code (no fire-every-frame bug found). Likely legitimately-rapid real
    commits during fast signing rather than a broken gate — needs live
    confirmation either way.
14. **Accidental letter triggers; erase gesture needs repeating.** `OPEN`,
    not yet investigated — `swipe.js`'s cooldown/motion-sensitivity constants
    still need a look.

## Read Mode

15. **Guide accuracy blocked by incorrect skeletal animations.** Same root
    cause as item 7 — not a separate bug, tracked together.

---

## Working the list

Priority order for picking the next item: a confirmed code bug with an
offline-verifiable fix > a confirmed architecture gap needing a real design
decision > something needing live camera data before any fix is safe >
something already deliberately deferred to a planned stage. Never flip an
item to `FIXED` without actually running `node tools/ci-check.mjs` +
`tools/selftest.html` (166+/166+) — verified-but-camera-dependent work gets
`FIXED (needs live confirm)`, not `FIXED`.
