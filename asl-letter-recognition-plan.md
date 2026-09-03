# ASL letter recognition — structured plan

## Revision history
- **2026-09-03:** Reactive ambient background (`js/bg.js`) — a full-page canvas of slow-drifting soft blobs behind everything, colour eased warm→amber→green by the live match score. **Spatial:** blobs are anchored to screen regions (top / thumb-side / pinky-side / centre) and `reference.regionErrors()` reports per-zone error, so a wrong region stays warm and drifts *more* while correct regions go green — the background points toward the problem (verified: B with bent fingertips → top zone error 0.77; thumb moved → left zone 0.53; on-target → all zones 0). Respects `prefers-reduced-motion` (drift frozen, colour kept). Body background moved to `html` so the canvas shows through. Self-test 68/68.
- **2026-09-03:** Reward + polish pass ("it works but doesn't *feel* like anything"). **Reward on completion:** hold "correct" for ~0.2 s → a particle burst from the hand (`js/fx.js`, full-viewport canvas, self-sleeping rAF), a green screen glow, a rising 4-note chime (`js/sound.js`, Web-Audio synth — no assets, unlocked on the camera-button click), the viewport pops-scales, the letter badge bounces with a spin, and a "Nailed B! ✓" toast slides up. Sound mute toggle (🔊/🔇) in the controls, persisted in localStorage. **UI polish:** gradient panels with depth/shadows, chips lift on hover + scale+glow when selected, breathing glow on the CTA, gradient/shimmer meter, ambient background glows, spring easings throughout. All motion respects `prefers-reduced-motion` (burst + big animations off, colour feedback kept). New modules `js/fx.js`, `js/sound.js`. Self-test 64/64; reward visual layer verified piece-by-piece (`pop-scale` / `badge-pop` / `meter-shimmer` animations present, toast slides, fx canvas draws 115k particle pixels). The live *trigger* (hold-counter in the loop) is unverified in-session — check on the deployed site.
- **2026-09-03:** Practice feedback overhaul, from live testing ("guide goes green but meter stuck on 'close', and I don't know what to fix"). (1) **The meter could never reach "got it"** — it secretly also required the classifier's top-1 to equal the target, which for M/N/D often fails even with a good hand. Removed that gate; the meter is now pure shape-match. (2) **Thresholds were miscalibrated** — the old fixed 0.82 "correct" cutoff demanded the hand be closer to the class mean than ~99% of *training* samples were. Now self-calibrated per letter: p50 of that letter's own spread = "correct", p85 = "close". Verified: a letter's typical training samples now land ~50% correct / 35% close / 15% off (was ~0% correct). (3) **Plain-words hint** (`reference.hint()`) — picks the single most-off thing from the rotation-independent engineered features and says it: "Curl your ring finger in more" / "Bring your index and middle closer" / "Tuck your thumb in tighter" / "Looks right — hold it steady". Shows in the panel under the meter; if the classifier is confidently reading a different letter it appends "(reading as X)". (4) **Guide colour ramp** now scales to each letter's tolerance so "almost" stays amber instead of blending into green; on-target segments lock to bright thick green; correction arrows use per-letter thresholds. Reference panel: photo + skeleton now side-by-side (shorter). Removed unused `config.MATCH_CLOSE/CORRECT`. Self-test 59/59.
- **2026-09-03:** Deployed to GitHub Pages — **https://crazycatz67.github.io/asl-recognizer/** (repo `Crazycatz67/asl-recognizer`, `main` branch, `/` root). All assets verified serving with correct content-types; app boots (classifier + reference build) with no console errors. Updating = `git push`. `data/_src/` (794 MB source images) excluded via `.gitignore`.
- **2026-09-03:** Practice-view redesign, from live testing feedback ("skeleton + camera + ghost all stacked, hard to see"). (1) **Side-by-side layout** — camera is the hero (bigger, `max-height: 82vh`); on ≥760 px with a target selected, a **reference panel** sits beside it (stacks below on phones). (2) The reference panel shows the **photo (always on when learning, no toggle)** + a large clean **canonical-skeleton diagram** (`reference.drawCanonical`) in its own canvas — the "make this" is no longer a ghost tangled with your live skeleton. (3) **Feedback moved off the video**: the camera frame glows red→amber→green (`viewport[data-match]`), plus the meter bar in the panel. Recognized letter → small corner **badge** instead of a huge centre overlay. (4) **Active correction guide** (`overlay.drawGuide`) — replaces the static ghost: draws YOUR live skeleton with each segment coloured by how far that joint is from the target, plus a "move this way" arrow at every off fingertip. Toggle "correction guide on camera", default on. New shared `js/skeleton.js` (topology + `drawSkeleton` + `vectorToPixels`) used by the live overlay, the guide, and the reference diagram; `overlay.js` no longer depends on MediaPipe `DrawingUtils` and is now synchronous. Self-test 56/56. NOTE: the live *visual* of the guide arrows is unverified in-session (synthetic-camera flakiness in the automation browser) — check on the deployed site.
- **2026-09-03:** Optimization pass (profiled first, then fixed the two real costs). (1) **kNN `classify`: 1.46 ms → 0.37 ms (~4x)** via partial-distance early termination — once k candidates are held, the per-vector distance sum abandons as soon as it exceeds the current k-th best. Exact, not approximate: offline accuracy unchanged at 95.9%. (2) **Freed ~15–20 MB** — the dataset-loader promise was pinning all ~31k expanded row objects for the page's life; it now resolves to a boolean after `createClassifier`/`buildReference` take their own compact copies. Heap settles at ~11 MB after startup. Profiled and left alone (already cheap): `loadDataset` incl. rotation expansion 57 ms, `createClassifier` 3.7 ms, `buildReference` 10 ms, `normalizeLandmarks` 0.007 ms, `drawHands` (MediaPipe DrawingUtils) 0.05 ms. MediaPipe's `detectForVideo` (~15–30 ms) dominates the frame and isn't ours to optimize. Self-test 53/53; live-verified (upright N and 28°-tilted N both → "N 100%").
- **2026-09-03:** M↔N / D↔O tie-breaker — BUILT, TESTED, SHELVED (`js/refine.js`, not wired in). Doesn't help: (1) **M↔N** — tried 13 candidate discriminating measurements, best separation 65% (worse than kNN's own 84% on N). MediaPipe guesses the occluded thumb, so no landmark measurement carries the M-vs-N signal. (2) **D↔O** — the index–thumb-gap measurement IS 90% separable, but kNN never produces thin-margin D-vs-O ties for the rule to catch: the real D errors are D→C/D→P/D→E at unanimous 5-0 votes. Blanket-applying the D/O rule regressed D 87%→84% (it overrides correct calls with its own 10% error). Kept `js/refine.js` as a documented record + ready harness; kept `knn.js`'s new `runnerUp`/`margin` outputs (harmless, useful). **The only real lever left for M 85 / N 84 / D 87 is cleaner data** — self-capture of those specific letters, front-lit, where MediaPipe reads the thumb better. The practice page's ghost + match meter make guided capture straightforward. Self-test 53/53.
- **2026-09-03:** Rotation robustness — SHIPPED. Verified the fix isn't forced upright-alignment (that cratered D −13, H −12, M −11 by erasing angle signal) but **rotation augmentation**: for each real hand the dataset build also stores copies rotated ±15° and ±30° in the image plane (`config.AUGMENT_ROTATIONS`, `normalize.rotateVector()`), so kNN has neighbours at every tilt. Result: **flat ~95% accuracy from −25° to +30° of hand tilt** (was 64% at 25°), overall 95.7%→**95.9%**, no per-letter regressions. Live-verified: a 25°-tilted "N" still reads "N 100%". Efficiency: only the ~6.3k originals are stored (`data/dataset.json` 3.2 MB, down from an 18 MB fully-expanded file); `dataset.js` expands to ~31.6k rows in memory on load via `rotateVector` (~1 ms/query, fine). Coords rounded to 3 decimals (zero accuracy cost — MediaPipe isn't that precise). `tools/test-knn.js` split is now group-aware (rotated copies follow their parent; test set = originals only) so augmentation can't leak. Self-test 48/48. **M 85 / N 84 / D 87 still under 90** — augmentation didn't touch that (it's thumb occlusion), so the M↔N / D↔O tie-breaker is still the next step.
- **2026-09-03:** Pre-tie-breaker audit — robustness-tested the pipeline and researched whether the method is optimal. **Findings:** (1) **Rotation sensitivity is the real weak spot** — a 20° hand tilt drops offline accuracy 95.5%→77%, a 30° tilt →50%. We do no rotation normalization. Tested fix: rotate landmarks in-plane so the wrist→middle-MCP axis points up → **flat 93.4% at any tilt 0–30°** (costs ~2 pts at the ideal angle, worth it). (2) The `radius = max wrist-point distance` scale is fragile — one flew-out fingertip → ~60%; switching to wrist→middle-MCP bone-length scaling recovers ~5 pts on that case. (3) Aspect-ratio handling is fine (invariant under ±33% stretch — earlier worry unfounded); landmark jitter is fine (95%+ at ±0.05); start/stop/flip ×5 leaks nothing. **Method check:** kNN is correct — nearest-centroid (24 vectors, 245× faster) only scored 80–81% because letter classes are multimodal (same letter at different angles = separate clusters); an MLP is the plan's later rung, not needed now; brute-force kNN at 0.29 ms/query needs no k-d tree. **Recommendation (pending user OK):** before the M↔N tie-breaker, upgrade `normalize.js` with in-plane rotation alignment + bone-length scaling and re-extract the dataset (~6 min). Expected to fix live rotation robustness and possibly tighten M/N enough that the tie-breaker isn't needed. Research: MDPI "Improving Hand Pose Recognition Using Localization and Zoom Normalizations"; arXiv 2305.05296.
- **2026-09-03:** UI redesign — practice mode merged into `index.html` (no separate page); layout tightened (whole app now ~370px tall on mobile, fits one screen, was ~2 screens). New: a **"Learn a letter"** chip row (24 letters, scrolls, selected chip auto-centres, right-edge fade hint); picking one shows a **glowing ghost skeleton** of that letter's canonical shape anchored to your live hand — red (off) → amber (close) → green (correct), by similarity to the class centroid AND the classifier agreeing; a **match meter** bar mirrors it; an optional corner **reference photo** (real grassknoted frame). New module `js/reference.js` (UI-free: class centroids + `score()`), `overlay.drawGhost()`, config knobs `MATCH_CLOSE`/`MATCH_CORRECT`/`REFERENCE_IMG`, 24 photos in `assets/reference/`. **Perf bug caught & fixed in testing:** first `drawGhost` used per-shape `shadowBlur` (up to 34px) → would tank real-device fps; rewritten as layered strokes, now 0.009 ms/call (full loop body 0.31 ms — 30 fps cap is nowhere near stressed). Self-test grown to **43 checks, all pass**; live pipeline re-verified via injected hands (exact-N hand → meter 92% green "N 100%"; A hand vs N target → 8% red). Note: `fps` shown in the automation browser is a hidden-tab rAF-throttle artifact, not the app — micro-benchmarked instead. `standalone.html` stays the pre-redesign skeleton-only fallback (not kept in visual sync).
- **2026-09-03:** Full component test pass — **35/35 checks pass**, 0 broken. Saved as a re-runnable harness at `tools/selftest.html` (run after every change). Verified: all 10 JS modules' public APIs; server routes + mime types + 404; `dataset.json` integrity (6321×74, braces balanced, no NaN/null); the live pipeline end to end on `index.html` (synthetic camera + injected fake hand → state reaches `tracking`, a letter is drawn on the overlay, stats badge updates, 0 console errors); `standalone.html`, `tools/extract.html`, `tools/test-knn.html` all load and run clean. Two latent bugs fixed in the pass: (1) `tools/extract.js` (the folder-picker fallback) was still emitting 63-dim, non-canonicalized vectors — would silently corrupt `dataset.json` if used to top up a weak letter; now matches the primary build (74-dim, left→right, correct metadata). (2) removed the now-dead "fold left hands" checkbox from `tools/test-knn.html` (data is canonicalized at build time).
- **2026-09-03:** Accuracy push results — **overall 91.9% → 95.7%** (24 letters, k=5, 20% held-out, 1175 test samples). Rebuilt `data/dataset.json` = 6321 samples, **74-dim vectors** (63 coords + 11 shape features), left hands canonicalized to right at build time. M: 47%→87%, N: 67%→84% (via ~3x more M/N samples + the curl/thumb features). 21 of 24 letters now ≥93%. **Still under target:** M 87%, N 84%, D 87%. Cause identified as a landmark-method ceiling, not tuning: in M/N the thumb is physically occluded behind the folded fingers, so MediaPipe's thumb-position estimate is noisy and the M/N clusters genuinely overlap; D↔O is a near-silhouette lighting issue in grassknoted's D images. k and feature-weight sweeps don't move N/D. Options to close the last gap: (a) an explicit M-vs-N / D-vs-O tie-breaker rule on the single most-discriminative measurement, (b) user self-captures ~40 clean front-lit samples each of M/N/D guided by the new practice-page reference. `js/knn.js` made dimension-agnostic; `js/dataset.js` accepts 63 or 74; `js/main.js` live path now appends the features too.
- **2026-09-03:** Reference-image idea + accuracy push. (1) granthgaurav skeleton dataset confirmed to show **incorrect signs** (its "M" has three fingers extended; real M is a fist) — dropped as a visual reference. Replacement: a new `practice.html` with a letter dropdown showing a correct grassknoted photo + a canonical skeleton generated from our own training-vector centroids, plus a live "match to target" meter and a ghost overlay. Seeds the roadmap's Phase 4 "camera checks your sign." (2) Accuracy work toward 90%+/letter: reprocessing M/N/P/Q/R/C/F at higher volume, and adding ~11 engineered shape features (per-finger curl, adjacent fingertip gaps, thumb-tip position) appended to the raw-63 vector behind a `USE_EXTENDED_FEATURES` flag, so M↔N and R↔U differences become explicit instead of implicit. A/B tested via `tools/test-knn.html`.
- **2026-09-03:** Stage 3 offline accuracy measured — **91.9%** on 24 letters (k=5, 20% held-out, 725 test samples), above the plan's 90% target. 22/24 letters at 89–100%. Only real weak spots: **M 47%, N 67%** (M→N 27%, N→M 25%, M→A 13%). Narrower than the plan's M/N/S/T+A/T watchlist — S and T are 97%. Cause: too few samples (M 76 / N 61) + genuine one-fingertip shape difference. Fix path (deferred to post-Stage-5): reprocess more M/N images from `data/_src/` (only ~200 of 3000 used), then add a finger-angle feature if still weak. Added `config.LETTERS` (24-letter allow-list); `tools/test-knn.js` and live classifier now filter to it.
- **2026-09-03:** DATASET RESOLVED — switched to Kaggle grassknoted/asl-alphabet (the plan's own fallback; real photos, ~3000/letter, the field's benchmark set). Extracted a strided subsample through `HandLandmarker` (IMAGE mode) → `data/dataset.json`: **4023 samples across A–Z + space**, 63-value vectors (with z), 3780 right / 243 left hands. Overall MediaPipe detection rate on this set ≈ 69% (fists self-occlude). **FLAG — weak per-letter sample counts:** N=61, M=76, space=92, C=137 fall below the plan's 150–300 target because MediaPipe fails to find a hand in those handshapes. Enough to build the pipeline end-to-end; if Stage 6 evaluation confirms M/N are weak, top them up by processing more of the 3000 available images (only ~200 were sampled). Raw source images kept in gitignored `data/_src/` for that. `tools/extract.html` (folder-picker version) demoted to a manual fallback; this run used a manifest + browser-driven pass.
- **2026-09-03:** DATASET BLOCKED — the granthgaurav "ASL Mediapipe Landmarked Dataset" turned out to be 400x400 JPG *images of the green skeleton drawn on white* (~180/letter, 4681 total), not numeric landmark vectors. Ran a detection probe: MediaPipe `HandLandmarker` finds 0 hands in these line drawings (it's trained on real hands, not stick figures), so we can't recover coordinates from them. This dataset is unusable for our pipeline. Awaiting decision on replacement — options: (a) grassknoted "ASL Alphabet" real photos + extraction pass (plan's own fallback), (b) a genuinely pre-landmarked CSV dataset, (c) self-capture ~40 samples/letter from webcam. Leaning (c) to unblock Stages 3–5 today, then layer (a) in for weak letters per the existing "scale up selectively" rule.
- **2026-09-03:** Bias/fairness pass — confirmed skin color and hand size are already neutral to the classifier (landmark-based, not pixel-based; size already normalized). Added an explicit skin-tone detection-reliability check to Task 6, since the one residual risk is upstream in MediaPipe's pretrained hand detector, not our classifier. Two-handed neutral tracking approach (mirror each hand individually, then concatenate in a consistent left-then-right order) logged on the project roadmap under Phase 2, since ASL fingerspelling is one-handed and this doesn't block letters.
- **2026-09-03:** Two fixes from a backward-reasoning pass — (1) split the training subsample into train/held-out-test portions (e.g. 80/20) so offline accuracy testing (Task 4) is measured against samples the classifier hasn't seen, not itself; (2) normalize for handedness (mirror left-hand landmarks to match right, or vice versa) before training, since the dataset likely isn't hand-balanced and live signing might use either hand.
- **2026-09-03:** Efficiency change — subsample training data instead of loading the full dataset. kNN doesn't benefit from large N (it only gets slower), so start with ~150–300 samples per letter (stratified) rather than the full pre-annotated set. Raw-image fallback, if triggered, stays small (~50–100 images) and scoped to only the specific underrepresented letter. Scale up data only for whichever letters evaluation (Task 6) actually flags as weak — not as a blanket increase.
- **2026-09-03:** Dataset decided — primary: Kaggle "ASL Mediapipe Landmarked Dataset (A–Z)" (granthgaurav/asl-mediapipe-converted-dataset), landmarks pre-extracted for all 26 letters. Fallback: raw ASL Alphabet dataset (grassknoted, ~87k images) + manual extraction, used only to top up any letter class found underrepresented in the primary set.
- **2026-09-03:** Added J/Z motion-buffer deferral note (§4a) — build/validate the other 24 letters first, add J/Z afterward reusing Task 7's hold/pause detection.
- **2026-09-03:** Incorporated landscape research findings — balance training data per letter (Task 3); widened confusable-letter watchlist from M/N/S to M/N/S/T and A/T (Task 6).
- **2026-09-03:** Initial structured plan created (scope, task breakdown, build order).

## Current status (2026-09-03)

| Stage | State | Evidence |
|---|---|---|
| 1 Camera + skeleton | **done** | confirmed live on user's Mac; state machine tested |
| 2 Training data | **done** | `data/dataset.json` — 6321 originals (3.2 MB), 74-dim, grassknoted-sourced; `dataset.js` expands with ±15/±30° rotations to ~31.6k rows on load |
| 3 kNN classifier | **done** | **95.9%** offline (held-out), **~95% flat across ±30° hand tilt**; `classify` 0.37 ms/call; UI-free + dimension-agnostic; 53/53 selftest |
| 4 Live inference + overlay | **code done, needs real-webcam confirm** | pipeline verified via injected hands (upright + 28° tilt both → "N 100%"); user's live run pending |
| 5 Evaluation | **offline half done** | confusion matrix + per-letter in `tools/test-knn.html`; live per-letter + skin-tone detection check pending |
| Practice mode (in `index.html`) | **done** | letter picker + glowing ghost overlay + match meter + reference photo; 53/53 selftest |
| 6 Words + J/Z (stretch) | not started | |

**Immediate next:** user's live webcam run on the redesigned page (confirms Stage 4, starts Stage 5's live half). Then either targeted self-capture for M/N/D, or Stage 6.

**Known weak letters:** M 85%, N 84%, D 87%. This is a data ceiling, not a tuning gap — the M↔N tie-breaker was built and disproven (no landmark measurement separates them >65%; MediaPipe guesses the occluded thumb). The only lever is cleaner data: self-capture of those letters, front-lit, guided by the practice ghost.

**Architecture:** UI-free reusable core = `js/normalize.js` + `js/knn.js` + `js/dataset.js` + `js/stabilizer.js` + `js/reference.js` (practice pages / any future page consume these directly). `js/main.js` is the only live-UI glue. `js/refine.js` is a shelved tie-breaker (documented, not wired in). Test harness: `tools/selftest.html` (run after every change).

---

## Scope
This plan covers **fingerspelling only**: recognizing static A–Z handshapes from a live camera feed and displaying the matched letter. It deliberately excludes full ASL word signs (which require motion, face, and torso tracking — see "Out of scope" below).

---

## 1. Goal

Given a live webcam feed, detect a hand, classify which letter (A–Z) it's forming, and display it as text overlaid on the video — running entirely in the browser, on desktop and mobile.

**Definition of done:** a person can hold up a letter to their camera on a phone or laptop and see the correct letter appear on screen within roughly half a second, for at least 90% of clearly-formed letters.

---

## 2. Task breakdown

| # | Task | Output |
|---|------|--------|
| 1 | Environment & hosting | Static page live on a public HTTPS URL |
| 2 | Hand landmark tracking | Live 21-point hand skeleton from webcam |
| 3 | Training data | Labeled landmark vectors for A–Z |
| 4 | Classifier | Something that maps a landmark vector → letter |
| 5 | Live inference + overlay | Letter drawn on screen in real time |
| 6 | Evaluation & tuning | Measured accuracy, confusion cleanup |
| 7 | (Stretch) Letter buffering | Spelled words, not just single letters |

---

## 3. Task details

### Task 1 — Environment & hosting
- Single-page app: HTML + JS, no build step needed to start.
- Host on GitHub Pages or Netlify — both give free HTTPS, which is required for camera access on real devices.
- **Deliverable:** blank page that loads on your phone at a public URL.

### Task 2 — Hand landmark tracking
- Use MediaPipe's `HandLandmarker` (Tasks Vision API), loaded via CDN.
- Feed each webcam frame in; get back 21 (x, y, z) points per detected hand.
- Draw the skeleton on a `<canvas>` overlay first — this is your visual confirmation that tracking works before any classification logic exists.
- **Deliverable:** hand skeleton follows your hand live on screen.

### Task 3 — Training data
- **Primary source:** Kaggle "ASL Mediapipe Landmarked Dataset (A–Z)" — landmarks already extracted for all 26 letters, so no offline extraction pass is needed.
- **Subsample, don't load it all:** pull a stratified ~150–300 samples per letter to start, not the full dataset. kNN accuracy doesn't meaningfully improve past a moderate sample size — it only gets slower to query — so more data isn't "more accurate," just heavier. This also keeps iteration fast while the pipeline is still being shaped.
- **Fallback:** if any letter is underrepresented even in that subsample, pull a small batch (~50–100 images, not the full set) for just that letter from the raw ASL Alphabet dataset (grassknoted, ~87k images) and run those through `HandLandmarker` to match the same landmark format.
- **Scale up selectively, later:** once Task 6 (evaluation) shows which letters are actually weak, add more samples for those specific letters — not a blanket increase across all 26.
- **Split before training:** hold out ~20% of the subsample as a test set the classifier never sees. Testing against data it was trained on gives a falsely perfect accuracy number.
- **Normalize for handedness:** if the dataset is mostly one hand (commonly right), mirror those landmarks to also cover the other hand, so live signing works regardless of which hand is used.
- Normalize each vector: recenter on the wrist point and scale to hand size, so it doesn't matter how close or far the hand is from the camera.
- **Balance the dataset per letter** (roughly equal sample count for each A–Z class). This is a cheap, concrete accuracy win that shows up repeatedly in similar published projects — an unbalanced dataset biases the classifier toward whichever letters have more samples.
- **Deliverable:** a JSON/CSV file — one row per sample, 63 numbers (21 points × x,y,z) plus a letter label.

### Task 4 — Classifier
- **Default choice: k-nearest-neighbors.** Store the labeled vectors from Task 3; at inference time, compare the live vector to all stored ones and return the majority label of the closest matches. No training loop, no extra dependency, runs in plain JS.
- **Upgrade path, only if needed:** a small neural net in TensorFlow.js, if kNN accuracy or speed isn't good enough at scale.
- **Deliverable:** a function `classify(vector) → letter`.

### Task 5 — Live inference + overlay
- Wire it together: webcam frame → `HandLandmarker` → normalize → `classify()` → draw predicted letter as large text on the canvas.
- Add a simple confidence/stability check: only show a letter once the same prediction holds for a few consecutive frames, to avoid flickering between letters as the hand moves.
- **Deliverable:** working end-to-end demo.

### Task 6 — Evaluation & tuning
- Build a small confusion matrix by testing each letter several times and logging what it actually predicted.
- **Test detection reliability across a range of skin tones**, not just classification accuracy. Our classifier only sees landmark coordinates (skin color plays no role there), but MediaPipe's underlying hand *detector* is a pretrained model we don't control — if it fails to find a hand at all for some skin tones, that would show up as a detection gap, not a letter-confusion gap, so it needs its own check.
- ASL letters with known visual overlap — specifically **M/N/S/T and A/T**, the same clusters multiple published ASL-recognition papers independently flag as commonly confused — will likely need attention here: either more training samples for those letters or additional landmark features (like finger angles, not just raw positions). Budget extra tuning time for this cluster specifically rather than treating it as a surprise if it comes up.
- **Deliverable:** a written accuracy number per letter, and a short list of what's confused with what.

### Task 7 — Stretch: letter buffering into words
- Detect when a handshape holds steady (a "letter") vs. transitions between shapes (ignore these).
- Add a distinct "space" gesture (many datasets already include one) to mark word boundaries.
- Buffer confirmed letters into a running text string.
- **Deliverable:** spelling a whole word letter-by-letter produces readable text.

---

## 4. Build order

1. Task 1 → 2 (get camera + skeleton working — nothing to classify yet, just confirm the pipeline)
2. Task 3 (data ready, in parallel with 1–2 if you want)
3. Task 4 (classifier, testable offline against your data before touching live video)
4. Task 5 (plug the classifier into the live pipeline)
5. Task 6 (tune based on real test results)
6. Task 7 (only after 1–6 are solid)

---

## 4a. Note on J and Z

J and Z aren't actually static handshapes — J traces a small hook and Z draws a zigzag, so they need motion, not a single frame. **Plan: build and validate the other 24 letters first.** J and Z get added afterward as a small motion-buffer case, reusing the same hold/pause detection planned for Task 7 rather than needing a separate system.

## 5. Out of scope for this plan

- Full ASL word signs (motion-based, need face/pose tracking + a temporal model — separate project phase)
- ASL grammar (facial expression as grammar, non-manual markers)
- Two-handed letters or regional sign variants
- Continuous sentence-level translation

These stay explicitly parked so this plan doesn't quietly expand mid-build.
