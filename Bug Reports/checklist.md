# Bug checklist — task clipboard

Sources: `Bug Reports/bug_report version 1 post test.txt` (live QA,
voice-delivered, items 1–16) and the owner's 2026-09-23 pre-showcase live
testing (items 17–28). This file is the durable tracker — update it in place as items move, don't
create parallel bug-list files. Each entry: **Status**, evidence, commit ref
once shipped. Statuses: `OPEN` · `FIXED (verified offline)` ·
`FIXED (needs live confirm)` · `IN PROGRESS` · `NOT A BUG` · `DEFERRED (planned stage)`.

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
   Two genuinely separate problems bundled in one report — split:
   - **Raw fps (~22, below the 30fps cap):** `OPEN`. Leading suspect is still
     the 640→1280 camera capture resolution bump (`js/camera.js:19-20`,
     shipped 2026-09-11 as "B16", never verified live). **Decision needed
     from the owner:** revert to 640, make resolution adaptive, or decouple
     capture resolution from detection resolution (downscale a copy before
     feeding MediaPipe). **Diagnostic first, costs nothing:** `main.js` has
     always shown a small `resolution · fps · delegate` readout bottom-right
     of the camera (`#stats`, e.g. "1280×720 · 22 fps · GPU") — check whether
     it says `GPU` or `CPU` on the affected Mac before touching resolution at
     all. If it silently fell back to CPU (a known gap on some Mac
     GPU/browser combos — `handTracker.js` already has that fallback path),
     that alone would explain the whole number and no amount of resolution
     tuning fixes it.
     **New root cause found 2026-09-23 (likely the main one):** the
     detection throttle in `main.js`'s `loop()` (`main.js:1655` at commit
     `41c43f0`: `if (now - lastDetectAt < DETECT_INTERVAL) return;`) misfires
     on a 60 Hz display. Two rAF frames are ~33.3 ms ± jitter, and
     `DETECT_INTERVAL` is 33.3 ms, so about half the time it skips to a third
     frame (50 ms). Detection then averages ~22–24/s, which matches the
     report even without any resolution or delegate problem. The planned fix
     is showcase Stage 1.2 (see the plan doc): use `requestVideoFrameCallback`
     where available, otherwise a fixed schedule (`lastDetectAt +=
     INTERVAL`) with a catch-up clamp and a few ms of tolerance. Tracked as
     item 25. Still `OPEN` until verified on a real device.
   - **The "ghosting"/lag feel: `FIXED (needs live confirm)`** — replaced the
     fixed-alpha (0.5) EMA landmark smoother with a one-euro adaptive filter
     (new `js/onefilter.js`, wired into `main.js`'s `smoothLandmarks`).
     Fixed-alpha has to compromise a single smoothing strength for every
     speed; one-euro widens its own cutoff (smooths less, responds faster)
     in proportion to estimated velocity, so it's heavier than the old
     filter while genuinely still (kills jitter better) and much lighter
     during real motion (kills the visible trailing/"ghosting"). Verified
     offline: a synthetic still-then-fast-swoosh sequence run through both
     filters shows the new one converges on a held-constant signal to
     within 1e-3 (jitter suppression intact) while trailing a fast 0.3->0.6
     swoosh by 22% less than the old EMA (0.045 vs 0.058 after the same 5
     frames). `ONE_EURO_MIN_CUTOFF`/`ONE_EURO_BETA`/`ONE_EURO_DCUTOFF`
     (`config.js`) are an informed starting guess from that math, explicitly
     NOT measured against a real hand — this is the "needs live confirm"
     part: does it actually feel less laggy on a real device, and does
     `motion.js`'s J/Z false-positive rate hold (one-euro is loosest exactly
     during fast motion, which is the J/Z regime). The raw/smoothed split
     (`swipe`/`twohand` still get RAW landmarks, untouched) is preserved
     exactly. `node tools/ci-check.mjs` (new pure-module invariants: first-
     sample passthrough, held-signal convergence, non-increasing-timestamp
     and reset safety, fast-motion responsiveness) and `tools/selftest.html`
     (174/174) both pass — this is a live-loop-only change, same
     verification boundary as everything else in `main.js`'s per-frame code.
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
   `FIXED (needs live confirm)` — see item 22 (`8f463d3`).. `motion.js`'s pinky-move/pinky-drop thresholds look reasonably
   guarded in code (a held I-hand shouldn't clear them per the code's own
   documented math). May need retuning against real signing — `fs_sequences.json`
   replay numbers are known-unreliable in absolute terms (Holistic vs
   HandLandmarker domain gap).
   **2026-09-23:** the code is looser than it looks. See item 22 for the
   concrete gate/buffer/cooldown causes.
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
     **2026-09-23:** concrete causes found (1 reversal, wrist-relative and
     not aspect-corrected, so an arm-drawn Z fails). See item 23.
7. **Anatomically impossible demo-hand animations for J, W, R, X, K, V, Z.**
   Two distinct root causes, not one — now split:
   - **J/Z: `FIXED (verified offline + live)`** — commit `1a54c68` (S2d part
     2, pushed). J's motion-stroke system (`MOTION_POSE`/`paintStroke` in
     `js/reference.js`) rebuilt: the rigid "I" handshape now rotates around
     its own gliding wrist (new `js/strokekin.js`) instead of a hand-plotted
     fingertip polyline, so the hook is a real consequence of the rotation.
     Z kept its translation, gained a wrist cock/arrowhead/waypoints.
     Verified live in Practice for both letters (trail overlays the guide
     exactly, hold→crossfade→restart still has no reverse retrace).
   - **W/R/X/K/V: `FIXED (verified offline)`.** Root cause confirmed with
     concrete evidence, not just plausible: `posekin.js` interpolated each
     bone's 2D-PROJECTED angle only. A real letter centroid's z (already read
     for S2c's depth cues) shows several joints curl substantially in depth —
     e.g. the index PIP-DIP bone's z-only contribution is ~7-16% of its
     length for S/A/E/N, growing knuckle to tip — so 2D-only interpolation
     forced that depth rotation to be represented as an exaggerated in-plane
     swing (confirmed: several fist-shaped letters' worst bone swung
     120-180° in 2D between neutral and target). Rewrote `posekin.js` to
     interpolate each bone's true 3D direction (SLERP, which has no sign
     ambiguity — the old 2D signed-angle "shortest arc" did, near ±180°) and
     project back to 2D for rendering; `js/reference.js`'s `setTarget()` now
     threads z into the `target` pose it hands `makeInterpolator` (was
     dropped before, kept separately as `targetZ` for depth-cue rendering
     only). Backward compatible by construction: a 2-element `[x,y]` point
     still works (z defaults to 0), and when both poses are all-z=0 the SLERP
     reduces to exactly the old shortest-arc math — `tools/ci-check.mjs`'s
     existing posekin invariants (length-pinning, endpoint-exactness,
     overshoot, `angleDistance` symmetry) all still pass unmodified except
     one tolerance (`angleDistance(x,x)` can no longer be bit-exact 0 with a
     normalize+acos chain instead of `wrap(same-same)`; loosened to `<1e-6`,
     documented why). Visually verified: rendered R/X/K/V (the actual
     reported letters) at t=0/.2/.4/.6/.8/1 — all now show a smooth, natural
     curl into the target shape, no crossing/tangling/backward bend.
     `tools/selftest.html` 173/173.
     **New, separate, milder issue found while verifying — not the reported
     bug, noting for later:** letter **N** shows a brief "shrinks to a
     sliver then reappears" glitch around t=0.4-0.6 on its middle-finger MCP
     bone — a real 3D SLERP passing near edge-on to the camera, where a
     smooth 3D rotation's 2D projection can move very fast (this is the
     classic gimbal-like foreshortening artifact, not an invalid pose — every
     intermediate frame IS a valid projection of a real rigid rotation, just
     briefly a fast/small-looking one). Not in the original report; `OPEN`
     as its own item if it turns out to bother testers. A future fix would
     reparametrize time (not the rotation) to slow down near-zero-projected-
     length moments.
8. **Yellow correction lines shown even when the shape is marked correct.**
   `FIXED (verified offline)` — commit `2f75e95`, pushed and live.
   Root cause: overlay colored joints green only within the tight tolerance,
   while the scorer's "correct" bucket forgives up to 1.8x that. Added
   `reference.matchTolerance()` as the shared threshold; 2 new regression
   checks added to `selftest.html` (166/166 passing).
9. **Ghost overlay should be more prominent/consistent.** `FIXED (needs live confirm)` — `ffb4f6c` (guide shown at low alpha from the first scored frame; ghost labelled "target"). Was, not
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
13. **Correct-letter chime/buzz triggers constantly.** `FIXED (needs live confirm)` — root causes were items 18/19 (`e582e17`).
    `speller.js`/`transition.js` both gate their success sound as one-shot in
    code (no fire-every-frame bug found). Likely legitimately-rapid real
    commits during fast signing rather than a broken gate — needs live
    confirmation either way.
    **Root cause found 2026-09-23:** each gate *is* one-shot, but the
    triggers fire far more often than intended. (a) `speller.js` flushes the
    pending word after only `acceptMs = 1000` ms without a held letter
    (`speller.js:24`, `:107`). A normal 1 s pause between letters therefore
    counts as a word break, and each flush plays the full success arpeggio
    (item 19). (b) A *different* letter re-commits with no release at all
    (`letter !== last || armed`, `speller.js` `feed()`), so kNN flicker
    between two shapes commits both (item 18). Still `OPEN`; the fix is
    showcase Stage 2.
14. **Accidental letter triggers; erase gesture needs repeating.** `FIXED (needs live confirm)` — see items 18/20/21 (`e582e17`).
    **Root causes found 2026-09-23:**
    - Accidental letters come from the missing release-to-rearm (item 18).
      Traced J/Z strokes also go straight into `speller.feed` (item 20).
    - The erase problems are in `swipe.js` (item 21). The direction test
      (`dx > dy * 1.6`, `swipe.js:89`) is strict. The open-hand fraction is
      measured over all frames, not just the moving ones. The buffer is not
      cleared after a hit, and `COOLDOWN_MS` (650 ms) only equals
      `WINDOW_MS` (650 ms). The tail of the same sweep can still be in the
      buffer when the cooldown ends, so it fires a second time. Together
      these make a real wipe miss sometimes and double-fire at other times.

    The fix is showcase Stage 2.

## Read Mode

15. **Guide accuracy blocked by incorrect skeletal animations.** Same root
    cause as item 7 — not a separate bug, tracked together. `FIXED
    (verified offline)` alongside item 7 — both the J/Z and W/R/X/K/V
    portions are now fixed.

## Demo-hand animation — new findings (not from the original report)

16. **Letter N's demo-hand briefly shrinks to a sliver then reappears
    (~t=0.4-0.6 of the animation).** `PARTLY FIXED` — the palm-collapse part was item 24's mirrored neutral (`7393db4`); a brief foreshortened tilt remains → Stage 4b. Found while verifying item 7's
    fix. The middle-finger MCP bone's 3D rotation passes near edge-on to the
    camera partway through — a real rotation, not an invalid pose, but its 2D
    projection moves very fast right at that moment (classic foreshortening/
    gimbal-adjacent artifact). Only seen on N so far; not confirmed on other
    letters. Fix would reparametrize animation TIME (not the rotation itself)
    to spend less of the clip near a bone's zero-projected-length moment.
   **2026-09-23:** a more likely root cause was found. `NEUTRAL_HAND` is
   mirrored relative to every letter centroid, so the animation starts from
   an unreachable pose (item 24). Re-check N after that fix before building
   any time-reparametrization.

## Found 2026-09-23 (live testing before the showcase)

From the owner's live testing on 2026-09-23. Fixes map to the stages of the
showcase-polish plan in `asl-letter-recognition-plan.md`. File:line
references are as of commit `41c43f0` and will drift.

17. **Spell mode freezes/stutters as the text grows (decoder).**
    `FIXED (verified offline)` — `d9f22ff` (exact-safe pruning floor + incremental prefix cache; cold 40-letter decode 315→25 ms, per appended letter ~1 ms, outputs identical on a 24-phrase bench). The Fluid-mode decode re-ran the whole beam search over the
    entire letter stream every ~350 ms (`main.js` fluid block → `decode.js`).
    It measured ~85 ms at 10 letters and ~1.7 s at 240, so the page hitched.
    The fix is uncommitted in `js/decode.js`: an exact-safe pruning floor
    plus an incremental prefix cache. On an offline bench, a cold 40-letter
    decode went from 315 ms to 25 ms, and each appended letter costs about
    1 ms. Output was identical on a 24-phrase bench. Still to do: selftest,
    commit, and a live confirm. (Showcase Stage 1.1.)
18. **Spell re-commits a letter without the hand releasing it.** `FIXED (needs live confirm)` — `e582e17`: gapMs 320→700, spell stabilizer 6 frames@0.6 → 10@0.8, `moved` measured in hand-spans; regression check "held letter doesn't re-commit after a brief classifier dip".
    `speller.js` `feed()` commits whenever `letter !== last || armed`. A
    *different* letter commits immediately, and the same letter re-arms after
    only `gapMs = 320` ms of not-holding, which kNN flicker easily produces.
    The `moved` re-arm in `main.js`'s spell block is in frame units, not
    hand-spans. The fix is release-to-rearm plus a time-based hold.
    (Showcase Stage 2.)
19. **The word-flush success arpeggio plays at every ~1 s pause.** `FIXED (needs live confirm)` — `e582e17`: acceptMs 1000→2000 and word commits play a new quiet `sound.word()` cue, not `success()`; per-sound cooldowns in `sound.js`.
    `acceptMs = 1000` (`speller.js:24`) treats any 1 s gap as a word break.
    The "word" event plays the full `sound.success()` arpeggio. The fix is
    `acceptMs` ~2200 and a distinct quiet word cue. (Stages 2 and 6.)
20. **A J/Z stroke leaks into Spell text.** `FIXED (needs live confirm)` — `e582e17`: strokes gated on the suppression window + 700 ms since the last commit; a stroke right after its own start letter replaces it (J after I → "J"). Detector itself still item 22/23. `motion.match()` runs
    every frame in every mode, and its `stroke` is passed straight into
    `speller.feed`, which commits J/Z unconditionally. It isn't gated on the
    handshape or on `spellSuppressUntil`, so any swoosh (including a swipe)
    can type J or Z. The fix is to gate it on the rewritten detector.
    (Stages 2 and 3.)
21. **The swipe erase needs repeats, and sometimes double-fires.** `FIXED (needs live confirm)` — `e582e17`: openness judged on the last 350 ms (the sweep), direction ratio 1.6→1.3, buffer cleared on fire, cooldown 800 ms > window; regression check added.
    - `swipe.js:89` requires `dx > dy * 1.6`.
    - `openFrac` counts all frames in the window, not just the moving ones.
    - The buffer isn't cleared on a hit.
    - `COOLDOWN_MS` equals `WINDOW_MS` (650 ms).

    The fix is `openFrac` over moving frames, a 1.2 ratio, a buffer clear,
    and cooldown > window. (Stage 2.) See also item 14.
22. **J accepts a tilt or a relaxing I-hand as a J.** `FIXED (needs live confirm)` — `8f463d3` (Stage 3 rewrite; ci-check #13c runs 12 synthetic scenarios incl. tilt/relax/drop).
    - In `motion.js` `match()`, the gate is `(pinkyUp >= 0.3 || pinkyMoved)`.
      The `||` fallback means the "I" shape isn't required.
    - There's no trajectory/shape check: any pinky travel > 1.2 spans that
      ends > 0.7 lower passes.
    - The buffer isn't cleared after a hit.
    - `COOLDOWN_MS` (900) < `WINDOW_MS` (1600), so the same motion can
      re-fire.

    The fix is the Stage 3 rewrite (hold-start, template match, orientation
    channel). The ship fallback is the quick guards.
23. **Z barely registers, especially when drawn with the arm.** `FIXED (needs live confirm)` — `8f463d3` (image-space aspect-corrected paths; 2 reversals + descent).
    - The Z test needs only `rev >= 1` (one reversal).
    - The path is wrist-relative, so drawing with the whole arm (the natural
      way) cancels out.
    - Coordinates aren't aspect-corrected (x and y are in different units on
      a 16:9 frame).

    The fix is aspect-correct image-space tracking, 2 reversals, and a
    template match. (Stage 3.)
24. **Demo hand does "impossible" movements: palm collapses, thumb sweeps
    across.** `FIXED (verified offline)` — `7393db4`: NEUTRAL_HAND un-mirrored, POINT_HAND thumb moved to the index side; ci-check #13b asserts no palm collapse/inversion for all 24 static letters (was 0-7% of endpoint area, now ≥100%).
    - `NEUTRAL_HAND` (`reference.js:350`) is mirrored relative to every
      dataset centroid: thumb and index are at −x versus +x (verified on
      A/B/N/L).
    - `POINT_HAND` (the Z pose) has the thumb on the pinky side.
    - A mirror pose can't be reached by rotation, so interpolating from it
      forces the palm through zero width.

    This is likely also the root cause of item 16. The fix is Stage 4a
    (negate x as needed and fix POINT_HAND's thumb), then 4b–4d.
25. **The frame-cap throttle misfires, giving ~22–24 fps instead of 30.**
    `FIXED (needs live confirm)` — `d9f22ff`: early slack + fixed-schedule advance; also numHands 1 outside Spell. Owner: check the `#stats` readout reads ~30 fps. The strict `now - lastDetectAt < DETECT_INTERVAL` test
    (`main.js:1655` at `41c43f0`) waits a third 60 Hz frame about half the
    time. See item 2. The fix is Stage 1.2. (An uncommitted change to this
    throttle was appearing in the working tree on 2026-09-23. Verify it
    before marking anything.)
26. **Overlay colors have no legend.** `FIXED (needs live confirm)` — `ffb4f6c`: colorblind-safe blue/orange/magenta + solid/dashed/thick + ✓~✕ glyphs, labelled target ghost, guide visible from the start, collapsible color-key chip (auto-opens first 2 persistent fixes); tour scene 4 teaches it live.. Nothing in the UI explains the
    colors: blue skeleton, green/amber→red per-joint error, dashed ghost,
    yellow worst-finger marker (`overlay.js`). Below score 0.35 the guide
    also stays plain blue, which looks broken. The red/green ramp isn't
    colorblind-safe either. The fix is Stage 7c (a color-key chip, redundant
    encoding, and a colorblind-safe ramp).
27. **Palm orientation is never taught or checked.** `PARTLY FIXED` — taught: tour scene 3 + all 26 descriptions lead with orientation (`628c57f`, `4444fc8`), misread hint says which way to turn. Still OPEN: live palm-facing detection (plan 7b).. Only B's and E's
    `LETTER_GUIDE` descriptions mention palm direction. The matcher and
    `hint()` ignore palm facing, so an upright H just reads as "U". The
    reference panel also auto-flips silently. The fix is Stages 7a (tour
    scene), 7b (`palmFacing()` + badge + hint, which must be validated against
    B11's negative result first) and 7d.
28. **Challenge's "seeing X" readout leaks the answer.** `FIXED (needs live confirm)` — `0abc510`: hidden during play; a miss now reports what it read. (Stage 5 also added combo, difficulty, fair drain, words, end summary.)
    `renderChallenge()` shows `seeing <b>X</b>` (the live raw prediction)
    during play. It turns the game into "wiggle until it says the letter".
    The fix is Stage 5: show it only in the post-miss "so close — read as N"
    message.

## Found 2026-09-23 (automated limit-test + accuracy pass)

29. **Fluid Spell decoded real double letters away** (HELLO → "held",
    COFFEE → "code"). `FIXED (verified offline)` — `35a42af`: `decode()`'s
    `collapse()` merged adjacent repeats of the already-segmented
    `speller.raw`; main.js now blank-separates entries. Regression check added.
30. **Two-hand paste re-fired every ~825 ms after one hand dropped** (and the
    buffer grew without bound outside Spell). `FIXED (verified offline)` —
    `35a42af`: buffer cleared on fire, trimmed in the one-hand branch.
31. **A single NaN landmark read as a confident letter until the hand was
    lost.** `FIXED (verified offline)` — `35a42af`: non-finite frames are
    treated as no hand. (Stabilizer now also reset on mode switch.)
32. **`transition.js` `votes` grows forever during a still hold** (~108k
    entries/hour). `FIXED (verified offline)` — `ba25b98` (votes only while settling).
33. **Tiny hands (radius ~5% of frame) + jitter fire spurious J/Z and fluid
    commits.** `FIXED (needs live confirm)` for J/Z — `8f463d3` MIN_SPAN gate; fluid-mode transition.js part still, low — add a minimum hand-span gate (fold into Stage 3).
34. **Edge cases:** speller `flush()` separator can exceed `maxLen` by 1;
    `insert()` can split a surrogate pair; `normalizeLandmarks` throws on
    <21 points (unreachable from main.js guards); `fluidLastLetterAt`/
    `fluidSpoke` not reset in `setMode` and speech not cancelled on leaving
    Spell. `OPEN`, low.
35. **Accuracy: wrong handedness drops static-letter accuracy 93.7% → 52%.**
    `PARTLY FIXED` — mirror-both shipped in `89022da` (`knn.classifyEitherHand`,
    regression check in selftest). Still open: jitter augmentation (would ~3x
    kNN rows → too slow per frame without prototype reduction) and k=7 /
    weighted votes (changes every vote-fraction threshold — stabilizers,
    transition.js — needs live tuning). Measured fix: classify both `v` and its mirror, keep the mirror
    only if its nearest distance is <0.9× (51% → 92.6% under wrong
    handedness, no clean loss). Next: train-time jitter augmentation (+1.3 pt
    under jitter), k=7 / distance-weighted votes (confident-wrong 5.5% →
    3.8–4.1%), then extra heads (P/Q, U/R/V/K, G/H) trained on jittered data.
    Honest held-out number (blocked 5-fold, one signer): 93.6%, weakest
    M 78 / N 80 / H 90 / Q 91. Scripts: session scratchpad `qa/`.

## Found 2026-09-24 (owner live test after the showcase pass)

36. **A→Z run doesn't reset between letters — a hand still up from Q counts
    for R or is flagged instantly.** `FIXED (needs live confirm)` — `531a198`:
    `resetPracticeFeedback()` on every target change + a release gate (old
    sign released or 400ms settle) + reward latched while an advance is
    pending (a re-made sign could double-count and skip the next letter).
37. **Letters register while the camera guide is still red.** `FIXED (needs
    live confirm)` — `531a198`: a raw kNN frame upgraded any "close" shape to
    "correct" (no per-joint check); the guide rotated the target the wrong way
    for unmirrored fits (ghost 2× the tilt off — selftest regression added);
    the 260ms grace let one good frame per 260ms carry a hold. Reward now
    needs the strict per-joint match.
38. **Hold tone stuck loud after switching modes; screechy while struggling on
    J.** `FIXED (needs live confirm)` — `531a198`: stopped on mode switch /
    letter change / hidden tab; `charge()` glides instead of chasing jitter;
    soft voice + hysteresis for J/Z.
39. **Spell: too many accidental letters.** `FIXED (needs live confirm)` —
    `ba25b98`: non-letter shapes rejected (REJECT_DIST 0.68, measured), 400ms
    entry grace, longer/stiller holds, drift can't re-arm, gestures suppress,
    fluid settle needs 3 votes / 60% share. (Also closes #32.)
40. **J demo and camera guide show different motions.** `FIXED (verified
    offline)` — `d73d6df`: demo pinky rides STROKE.J exactly (ci-check #13d).
41. **J/Z photos confusing ("straight finger", how to zigzag).** `FIXED (needs
    live confirm)` — `d73d6df`: still stroke diagrams replace the photos.
42. **Read mode uses the outdated mannequin.** `FIXED (needs live confirm)` —
    `d73d6df`: 3D word interpolation, J/Z segments no longer jump sides,
    crisp + larger canvas.
43. **CI syntax check passed ES-module syntax errors.** `FIXED (verified
    offline)` — `ba25b98`: each js/ file checked as a temp .mjs (proven on a
    real `,,` import typo).

44. **Practice too strict after #37 ("sensitivity too high"); overlay colours
    and the reward judged joints separately.** `FIXED (needs live confirm)` —
    `6e24e52`: one per-joint rule (js/jointstate.js) drives colours + reward;
    wider good band, up to 5 orange joints, look-alike guard (heads for
    M/N, D/O/C). Held-out: correct letters count 44.7% -> 78.1%, wrong 0.4%.
    M still hard (11%) — tune live.

45. **N hard to register; accuracy judged against photo averages instead of
    the letter.** `FIXED (needs live confirm)` — letter-trait verdict
    (js/handshape.js): held-out real letters count 87.5%, N 33% -> 75%, wrong
    letters 2.6%. ci-check #13e.

46. **Live-Lab cycle 1 (2026-09-25).** `FIXED (needs live confirm)` — merged
    `8b30526`: physical wrong-shape probe + per-finger fold/raise rules (46
    wrong-shape findings -> 0), B own 73->90%, E 73->80%, D 87->77% (by design:
    straight "folded" fingers no longer pass), P thumb tucked (Q own 70->87%);
    break-it.mjs (54 checks); fixed LAB-040 (fluid J-after-I spelled "IJ") and
    LAB-054 (A->Z bridge timer not cancelled); tiered reward visuals + varied,
    never-louder sounds (js/juice.js). Open lab items: docs/lab/ISSUES.md.

47. **Fist letters (A/E/S/T vs M/N) mixed up — thumb position ignored.**
    `FIXED (needs live confirm)` — `thumbAlong` trait (thumb tip along the
    knuckle line) on A E S T: held-out M as A 17%, M as S 15%, N as A/E 11%
    all -> <10%; own-letter pass unchanged except S 97->95%. ci-check #13k.

48. **Lab issue sweep (2026-09-25).** `FIXED (needs live confirm)` — issue
    store auto-resolves (61 open -> 15). Fixed: T thumb-out accepted (LAB-062),
    hidden tab cost a Challenge life (LAB-053), Skip-on-landing double penalty
    (LAB-052), Spell backspace kept the letter in the spoken sentence
    (LAB-041/042), dropout re-commit "LL" (LAB-039, live), NaN-hand guards.
    Still open: M<->N ~20% (LAB-023/025), Q as C 17% (LAB-061), N own 70%
    (LAB-013), tour ends a run (LAB-055), SW reload mid-session (LAB-056).

49. **Tour ended runs; deploy reloaded mid-session; N still hard.**
    `FIXED (needs live confirm)` — tour pauses runs + restores mode (LAB-055),
    SW reload deferred while busy (LAB-056), N own 58 -> 67% offline, M/N
    pair tip. M<->N ~20-30% remains (data limit: needs more signers).

50. **Guide ▲ / yellow tracer circles out of place (owner, 2026-09-25).**
    `FIXED (needs live confirm)` — per-finger verdict errors tied every joint,
    so the marker landed on the knuckle; now it goes to the flagged finger's
    most-off joint (js/overlay.js). Selftest guard.

51. **Visual layer v2 (2026-09-25).** `SHIPPED (needs live confirm)` — hero,
    aurora, on-hand feedback, rewards, adaptive Challenge; Effects setting is
    the kill switch. Owner to check: real-camera det fps under Off vs Auto
    (?debug), framing-cue thresholds, aurora strength, Race P2 colour.

52. **Owner QA 2026-09-25: dotted reward letter; Race word progress unclear;
    Take-turns cheat.** `FIXED (needs live confirm)` — letter tile, per-player
    word progress, side-owned turns (v102).

53. **Lag spikes / slowdowns after the visual layer (owner, 2026-09-25).**
    `FIXED (needs live confirm)` — perf pass v103 (ink bloom retired, CSS
    flash, capped loops, deduped DOM writes, stall-aware governor).

54. **Spell "doesn't work": wrong / doubled letters, J/Z double or misread,
    no space while holding, HELLO's second L lost.** `FIXED (needs live
    confirm)` — circle lock (`js/spellgate.js`): ring per letter, word window
    -> space, release needed for a repeat. `tools/lab/spell-letters.mjs`
    before/after in docs/CHANGELOG.md (2026-09-25). Owner to check on a real
    camera: does 650 ms feel right, is 2.2 s enough to find the next letter.

55. **Achievements + records + unlockable Home ink (owner, 2026-09-25).**
    `SHIPPED (needs live confirm)` — v106. Check the look of the Home wall,
    unlock cards and ink themes on the owner's devices.

56. **Phone acceptance test (S4) — iPhone Chrome + Android Chrome.** `OPEN (owner, on devices)`
    **Get the page on the phone:** the live site, or unshipped changes via
    `python3 tools/serve-https.py` on the Mac (same Wi-Fi; accept the one-time
    certificate warning). Add `?perf` to the URL for the report panel.
    **Remote debugging:** Android Chrome — Developer options › USB debugging,
    plug in, Mac Chrome `chrome://inspect`. iPhone Chrome — Chrome Settings ›
    Content Settings › Web Inspector ON, iPhone Settings › Safari › Advanced ›
    Web Inspector ON, plug in, Mac Safari › Develop › [iPhone]. (Chrome on
    iPhone uses Safari's engine, so iPhone limits apply in Chrome too.)
    **Run, portrait AND landscape, on each phone:**
    - [ ] First visit (`?fresh`): Home page, Start, tour, camera permission prompt
    - [ ] Deny the camera once: the help text names the right Settings path, Try again works
    - [ ] Practice: pick a letter, "Turn on camera" visible, sheet opens/closes with the handle bar
    - [ ] A→Z run for ~5 letters: ring, letter tile, ink, flash feel smooth
    - [ ] Challenge Solo one round; Race with two people (two hands, badges)
    - [ ] Spell "HI CAT" with the ring + word window; Read one word
    - [ ] Home page: two-hand ink (orange/blue), letter wall, achievements card
    - [ ] Rotate the phone mid-session; switch apps and come back (sound, camera)
    - [ ] 10 minutes of use: warmth, battery, `?perf` Copy report pasted back
    - [ ] One-handed reach: every control you need is tappable without re-gripping

57. **Letter-tester cycle 1 (2026-09-25): per-letter report -> recognition optimiser.**
    `FIXED (needs live confirm)` — v110. Relaxed hands counted as Q 60% -> 20%,
    C 35 -> 25%, B 15 -> 5%, P 15 -> 10%; D 72 -> 78%; R/U at 15° tilt
    27 -> 73/90%; per-frame recognition 0.86 -> 0.16 ms (identical kNN
    answers, ci-check #26). Still open (data-limited): N 67% (38% read as
    non-letter), M<->N 21-33%, J start gate, C 25% — docs/lab/letters/REPORT.md.

---

## Working the list

Priority order for picking the next item: a confirmed code bug with an
offline-verifiable fix > a confirmed architecture gap needing a real design
decision > something needing live camera data before any fix is safe >
something already deliberately deferred to a planned stage. Never flip an
item to `FIXED` without actually running `node tools/ci-check.mjs` +
`tools/selftest.html` (174+/174+ as of 2026-09-15) — verified-but-camera-dependent work gets
`FIXED (needs live confirm)`, not `FIXED`.
