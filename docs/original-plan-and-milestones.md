# Original plan, milestones & backlog (archive)

The project's original structured plan (Stages 1–7), the 2026-09-03 status
table, the "North star" milestone roadmap (M0–M5), and the B1–B21 backlog
tables. All of it was moved here verbatim from `asl-letter-recognition-plan.md`
on 2026-09-23. It is kept because the backlog rows record *why* decisions were
made. Several rows are marked DONE, STALE, or NOT A GAP, and that reasoning
should not be lost or re-derived.

**This is historical, not current.** For live status and the active backlog, see
`asl-letter-recognition-plan.md`. For dated changes, see `docs/CHANGELOG.md`.
References below to "the Stage 8 section" or "_Stage 9 → Skin tone_" now point to
`docs/research-and-future.md`, and "Revision history" now means `docs/CHANGELOG.md`.

---

## Session resume as of 2026-09-11 (superseded — kept for the record)

_Last updated 2026-09-11. This block is the fast catch-up after a context reset; the Revision history below is the full detail._

- **Where we are:** Stages 1–7 done + Read mode + Course (B2) + Spell word-drill (B4) + accessibility v1 (B5) + about page + installable PWA/offline (B8), plus a 2026-09-11 pass on Spell-mode over-triggering, reference-photo sizing, onboarding, a full audit (bug hunt + adversarial testing) that fixed a real cross-mode Challenge bug, free GitHub Actions CI (`tools/ci-check.mjs`), a committed threshold-sweep tool (`tools/sweep-transition.mjs`), **B10 done** (mastery badge + streak) and **B16 done but live-unverified** (camera resolution 640×480 → 1280×720). **About to be pushed** — `sw.js` VERSION bumped to v44 for this batch (v43 already confirmed live from the earlier push this session).
- **The one blocker now:** the camera-free queue is empty again. **The user needs to run one webcam session** on the deployed site (Spell mode → "Fluid + speak" → spell a sentence) to confirm/break fluid mode before M4 (Stage 8) is built on it, to feel whether the retuned `js/transition.js` still locks in letters reliably at real signing speed, AND to confirm the B16 resolution bump doesn't hurt frame rate. Everything else waits on that or on people (multi-signer eval).
- **Verified working:** `tools/selftest.html` **164/164**; all modules load clean; user has run it live on Mac + phone across ~25 feedback iterations. Recognition **97.1%** held-out (kNN + learned M/N & D/O/C heads), every letter ≥92%.
- **The goal now:** the **North star** section — build Backlog B1–B8 + Stage 8 + a Stage 9 prototype to near-final, then **showcase to an RIT/NTID ASL professor or the Deaf community**. Work the milestones M1→M5 in order; **M1 first** (accessibility pass + `js/transition.js`). ~4–6 months part-time to showcase-ready; Stage 9 (native-speed sequence model) a further semester, ideally with RIT.
- **Can't verify in-session:** the live camera loop / reward / animations — automation-browser limits. User confirms on the deployed site; everything else is unit-tested + layer-checked.
- **Don't re-explore:** the *single-measurement* M↔N / D↔O tie-breaker (`js/refine.js`) — disproven, shelved. The M/N/D fix that *worked* is `js/heads.js` (learned heads); retrain via `tools/train-heads.html` if the dataset changes.
- **New backlog item surfaced this session (not started):** the demo-hand animation (`createCanonicalPlayer` in `js/reference.js`) linearly interpolates raw 2D-projected landmark points from a fixed neutral pose to each letter's canonical centroid — real 3D hand rotation collapses to a straight-line 2D lerp, which is the likely cause of user-reported "flips weirdly / doesn't look natural" and "can't tell front vs back of hand." A real fix needs rotation-aware (or at least per-joint hierarchical) interpolation, not a one-line tweak — scope it as its own task before touching it. Now tracked as **B12**.
- **New this session — read before planning work:** **Backlog part 2 (B9–B21)**, both in the Backlog section. B9–B21 is a design pass over feedback/juice, the skeleton overlay, Duolingo-style pedagogy, camera accuracy, and the letters→words bridge; the cheap high-value ones are **B9** (per-finger skeleton colouring — the error data is already computed and discarded), **B10** (a visible mastery/streak artifact over `stats`, which is collected and never shown), and **B11** (palm front/back cue from the landmark z-axis — validate the sign convention offline first). **Testing infrastructure is now resolved**, not open: free GitHub Actions CI (`tools/ci-check.mjs` + `.github/workflows/ci.yml`) plus a committed `tools/sweep-transition.mjs`, no paid agent — see the Backlog section for what it does and doesn't cover.
- **Working agreement:** explain choices plainly as you go; keep this doc current with a dated Revision-history entry per change; flag deviations and wait for confirmation; ask before adding any dependency beyond MediaPipe. User is an AI major building this to learn.

---

## Current status (2026-09-03)

| Stage | State | Evidence |
|---|---|---|
| 1 Camera + skeleton | **done** | confirmed live on user's Mac + phone; state machine tested; front/back camera both handled |
| 2 Training data | **done** | `data/dataset.json` — 6321 originals (3.2 MB), 74-dim, grassknoted-sourced; `dataset.js` expands with ±15/±30° rotations to ~31.6k rows on load |
| 3 kNN classifier | **done** | kNN **95.9%** held-out; **+ learned M/N & D/O/C heads → 97.1%** (every letter ≥92%); `classify` 0.37 ms/call; ~95% flat across ±30° tilt |
| 4 Live inference + overlay | **done** | confirmed live by the user across ~20 feedback rounds; progressive correction guide, tilt forgiveness, EMA smoothing, real-time handedness, back-camera aware |
| 5 Evaluation | **offline done; live pending** | confusion matrix + per-letter in `tools/test-knn.html` (95.9%). Still to do: a structured **live** per-letter accuracy pass + a skin-tone detection-reliability check (MST-scale stratified panel — protocol in _Stage 9 → Skin tone_) |
| Practice mode (in `index.html`) | **done + heavily polished** | free-pick / **A→Z run**; animated demo (+ tap to enlarge); plain-language descriptions; progressive guide with finger highlight; self-calibrated "readable not perfect" meter; hold-to-win + charge sound + haptics; recogniser readout; per-letter stats; "stuck" assist; remembered setup; first-visit walkthrough |
| 6 Challenge / words / J/Z (stretch) | **all three done (v1)** | `js/challenge.js` speed game (recogniser-gated, GO flash, speed scoring, streak, 3 lives + Skip, results card). **J/Z** via `js/motion.js` (fingertip stroke matcher) — full 26-letter picker, stroke demo, works everywhere. **Spell mode** (`js/speller.js`) — continuous fingerspelling → transcript with a forgiving pending-word buffer, pause-to-commit, swipe-to-scrap, two-hand copy/paste, in-panel help + gesture demos + A–Z chart. **Follow-up:** (a) gesture-threshold tuning against real signing; (b) **`js/transition.js`** — segment letters by the settle→move→settle *rhythm* (classify the motion *between* letters) instead of requiring a still hold, per the letter-transition research; this is the real fix for "Spell mode isn't fluid." |
| 8 Fingerspell → sentence → speech | **planned** | the "slow Google Translate" path — CTC-collapse the letter posteriors, decode through a dictionary **trie + beam search** with confusion-matrix emission costs, assemble + `speechSynthesis` playback + captions. Plain JS + one bundled word list. Needs B3's continuous sequences as a test set. See the Stage 8 section. |
| Backlog (catch-up with the field) | **B1 ✓ · B2 ✓ · B4 ✓ · B5 v1 ✓ · B8 ✓** | **B1** receptive practice, **B2** curriculum, **B4** word content ×2.5 + Spell drill, **B5** accessibility v1, **B8** installable PWA + offline — all shipped. Remaining: B3 Deaf-signer data · B6 numbers/variants · B7 accounts. See the Backlog section. |

**Immediate next:** see **North star → Progress check (2026-09-04)**. The camera-free queue is now **empty** — B1/B2/B4/B5-v1/B8 and the about page are all shipped. **Everything remaining needs the webcam session or people:** (1) **user runs one webcam session** to verify fluid mode before M4 is built on it — this is now the single blocker; (2) then M4 (Stage 8 full build), B6 digit capture, and the MST-stratified skin-tone eval, in whatever order the webcam result and any RIT contact suggest.

**Known weak letters:** ~~M 85%, N 84%, D 87%~~ **FIXED** — learned refinement heads (`js/heads.js`) lift M→92, N→96, D→97 (held-out), overall 95.9→97.1%. Every letter is now ≥92%. A *single-measurement* tie-breaker (`js/refine.js`) was disproven and stays shelved; the win was a *learned* combination over the full feature vector.

**Architecture:** UI-free reusable core = `js/normalize.js` + `js/knn.js` + `js/dataset.js` + `js/stabilizer.js` + `js/reference.js` + `js/speller.js` + `js/reader.js` + `js/curriculum.js` + `js/spelldrill.js` + `js/transition.js` + `js/decode.js` (practice pages / any future page consume these directly). `js/main.js` is the only live-UI glue. `js/refine.js` is a shelved tie-breaker (documented, not wired in). Test harness: `tools/selftest.html` (run after every change).

---

## North star — showcase a near-final product to RIT / the Deaf community

**Goal (user, 2026-09-04):** build out everything below to a polished, honest, near-final state, then demo it to an **RIT / NTID ASL professor or the Deaf community** — as both a usable tool *and* a credible research direction that could attract mentorship, data access, or collaboration. RIT/NTID is the right audience: PopSign is a Georgia Tech × RIT/NTID project, so there's precedent for exactly this kind of student engagement.

### What the Kaggle data upgrade fixes — and what it doesn't

Pulling the Google Kaggle Deaf-signer data (B3) is high-value and should come **early** — but it is not a substitute for the architecture work:

- **Better letters, yes.** Deaf-signer data + a harvest pass fixes M/N/D and improves generalisation. Each *frame's* guess gets better.
- **Fluency ("not fluid"), no — that's architecture, not data.** The current pipeline is per-frame kNN → stabiliser (needs N agreeing held frames) → commit. At any real speed the hand never holds a shape for N frames, so more data doesn't help: the *trigger* is wrong. `js/transition.js` changes the trigger from "held still" to "settled after a move" — that's the fix, and it needs a heuristic, not the dataset. (It *does* benefit from the Kaggle sequences as an offline test set.)
- **Native / conversational speed, only via a sequence model.** A model that ingests a window of frames and outputs a letter sequence (CTC) *learns the transitions*; a frame classifier can't, no matter the data. That's Stage 9, and *there* the Kaggle data is the fuel.

So: **data + better architecture, not data alone.** The reorder that follows pulls the *cheap half* of B3 (just the sequence file) to the front because it's the test harness for `transition.js` and `decode.js`.

### Milestones (rough order; M0–M3 overlap, M4 is the big one)

| M | Theme | Contents | Effort (sessions) |
|---|-------|----------|-------------------|
| **M0** | **Kaggle sequences (the cheap half of B3)** | One offline script: pull ~300 Kaggle sequences → `data/fs_sequences.json` (per-frame 21-hand landmarks + phrase). *No retrain, no harvest yet.* This is the replay test set that lets M1's `transition.js` and M4's `decode.js` be tuned at the keyboard instead of the webcam. | 1–2 |
| **M1** | **Solid + honest foundation** | `js/transition.js` **✅ built** (rhythm-based segmentation; synthetic-tested) — ⚠️ **not tuned against real signing, never run on a live webcam**. Stage 5 structured **live per-letter eval** + skin-tone check (≥3 signers — RIT could help source) — **not started, needs people**. Spell-mode gesture tuning — **pending a webcam session**. **B5 accessibility pass ✅ v1** (focus ring, `prefers-contrast`, Escape, ARIA, reduced-motion); v2 owed: in-app high-contrast *toggle*, screen-reader walkthrough, transient-sound caption audit. | 6–10 |
| **M2** | **A real learning tool, not just a recogniser** — **core done** | **B2 curriculum ✅** — Read-mode Course: 5 handshape tiers, teaching order, 10-correct gate, per-tier progress. **B1 receptive practice ✅** — Read mode. **B4 ✅** — word bank ×2.5 (8 categories, ~370 words) + Spell-mode **word drill** (target word, green/red letter colouring, auto-advance) whose "from my lesson" source = the active Course tier, so the productive side of the curriculum is now wired too. Still open: *shaping* letters in a lesson is only in free Practice (camera); a fully guided productive lesson flow is a nice-to-have, not a blocker. | 10–16 |
| **M3** | **Full data upgrade** | **B3 (rest)** — harvest per-letter frames from the Kaggle sequences via forced alignment; retrain heads; refresh the confusion matrix (feeds M4). **B6** — digit signs **0–9**: capture tool → data → train → wire in (high community value; needed for phone numbers/addresses). | 7–12 |
| **M4** | **Stage 8 — fingerspell → sentence → speech** | The full phased build in the Stage 8 section (Ph 0–5): `decode.js` (trie + CTC-collapse + beam + Norvig fallback), `decode-lab.html`, confusion-matrix export, wire behind a "fluid mode (beta)" toggle, raw/split/sentence UI, `speechSynthesis` + captions, per-word "keep as spelled". | 14–22 |
| **M5** | **Showcase prep** | **About page ✅** · **B8 PWA ✅** (`manifest.webmanifest` + `sw.js` — installs, works offline; verified by loading with the dev server stopped). Remaining: a demo script + a recorded fallback video, and **reach out to RIT/NTID** (doubles as Stage 9's "talk to Deaf people first" step). | 4–6 |
| **→** | **Showcase** | Demo. Then Stage 9 (sequence model for native-speed; context lexicons; **B7** accounts), pursued with whatever mentorship / data / collaboration the showcase generates. | — |

### Progress check — thinking backwards from "showcase-ready" (2026-09-04)

Working back from the 6 showcase-ready criteria to where we actually stand:

| Showcase-ready criterion | State | The real gap |
|---|---|---|
| A–Z **and 0–9** reliable, validated across ≥3 signers, varied skin tones | **partial** | A–Z is solid on the *builder* (97.1% held-out, ~25 live sessions). **0–9 don't exist** (B6). **Multi-signer eval not started** — needs people, not code. |
| Curriculum, productive **and** receptive | **~90%** | Receptive ✅ (Read mode). Course structure ✅ (B2). Productive side ✅ *wired* — the Spell-mode word drill can target the active Course tier. Remaining: a fully guided per-lesson *shaping* flow (camera), a nice-to-have. |
| Spell → correct spoken sentences, with transparency + per-word override | **built, unverified** | `decode.js` ✅, `transition.js` ✅, fluid mode wired ✅, back half integration-tested ✅, **B4 word drill ✅** gives Spell mode something to practise against. **The front half (webcam → HandLandmarker → classifier → transition) has still never run live.** Biggest single risk in the plan. |
| Full accessibility | **~70%** | B5 v1 ✅. Owed: in-app high-contrast toggle, SR walkthrough, transient-sound caption audit. ~1 focused session. |
| Installs as PWA, offline | **✅ done 2026-09-04** | `manifest.webmanifest` + `sw.js` (precache shell, SWR same-origin, cache-first MediaPipe). Verified by loading with the dev server stopped. |
| Honest about-page | **✅ done 2026-09-04** | `about.html` — what it does / what it doesn't / how it works / privacy / research direction / credits / open-source. Linked from the topbar. |

**Are we working efficiently?** Throughput is good — B1, B2, B4, B5 v1, `decode.js`, `transition.js` all shipped in a short span, all camera-free per the working constraint; **M2's core is now complete**. **The risk is unchanged: a growing "built but unverified" pile sitting on one unproven assumption — that fluid mode works on a real webcam.** Everything in M4 (14–22 sessions) is stacked on that. The Kaggle replay couldn't test it (domain gap). So the highest-leverage action available is still not more code — it's **one 30-minute webcam session by the user on the deployed site** to confirm or break fluid mode *before* M4 is built on it. **The camera-free queue is now empty** (about-page ✅, B8 PWA ✅) — the webcam session is the only thing standing between here and M4.

**Recommended order from here:**
1. **User action — webcam session.** Deployed site → Spell mode → turn on "Fluid + speak (beta)" → spell a short sentence slowly → report: do letters land? does the "reads as" line form words? does it speak? This de-risks M4 and tells us whether `transition.js` thresholds need real-signing tuning. (The new **word drill** is a good way to run this test — it gives you a target to spell.)
2. ~~**B4: word content + Spell-mode practice targets**~~ **✅ done 2026-09-04** — word bank ×2.5, Spell-mode word drill, productive-curriculum wiring. M2 core complete.
3. ~~**M5 cheap items** — about-page + B8 PWA~~ **✅ both done 2026-09-04.** Camera-free queue is now empty.
4. **After the webcam session** — M4 (Stage 8 full build), B6 digit capture, the MST skin-tone eval, and a guided productive-lesson *shaping* flow. Order depends on the webcam result + any RIT contact.

### "Showcase-ready" means

- A–Z **and** 0–9 recognised reliably on careful signing, **validated by a live per-letter eval across ≥3 signers** incl. varied skin tones (not just the builder).
- A structured practice curriculum with **both productive and receptive** modes.
- Spell mode → correct spoken sentences on careful spelling of common words, with the raw/split/sentence transparency and per-word override.
- **Full accessibility**: captions, keyboard-only path, high-contrast, reduced-motion.
- Installs as a **PWA**, works offline.
- An **honest about-page**: what it does, what it doesn't (native speed, out-of-vocabulary), the research direction, that it's open source.

### Timeline (part-time solo, learning as you go)

M0 ≈ few days · M1+M2 ≈ 1.5–2 months · M3 ≈ 3–4 weeks · M4 ≈ 1.5–2 months · M5 ≈ 2 weeks → **roughly 4–6 months to showcase-ready** *without* Stage 9's sequence model. Stage 9 (native-speed continuous recognition) is a further semester and is best done *with* RIT involvement — the showcase is the catalyst for it, not a prerequisite.

### Fastest path to "something worth showing" if time is short

M0 (`fs_sequences.json`) → M1's `transition.js` + accessibility pass → `js/decode.js` on typed input (skip the retrain) → `speechSynthesis` → a demonstrable "spell a sentence, hear it spoken" in ~3–4 weeks. Everything else deepens it.

---

## Backlog — catching up with the field

From the *Signing to a Webcam* competitive read (2026-09-03). Things shipping competitors do and we don't. Every item is now slotted into a **North star milestone (M1–M5)**; priority = how much it matters before the RIT showcase.

| # | Item | Why | Priority |
|---|------|-----|----------|
| B1 | ✅ **DONE (2026-09-04)** — **Receptive practice** — Read mode: the animated hand spells a word, you type what you saw. `js/reader.js` + `data/practice-words.json`. | Reading fingerspelling is the harder half of the skill and we trained none of it. Reused `createCanonicalPlayer` — no new assets. **Milestone M2.** | **High** |
| B2 | ✅ **DONE (2026-09-04)** — **A real curriculum** — Read-mode **Course**: 5 handshape-difficulty tiers (Anchors → one/two fingers → pointing/flat → fists/look-alikes → motion), unlocked in order, 10-correct-answer gate per tier, per-tier progress bar, jump to any unlocked tier. `js/curriculum.js` + `data/curriculum.json`. The letter-*shaping* half still needs Practice (camera). | We had modes (Free pick / A→Z / Challenge), not pedagogy. Fingerspelling.xyz opens with A,B,C,E,L,O,V,W,U,Y then widens; Lingvano has a full course spine. **Milestone M2.** | **High** |
| B3 | ❌ **STALE — as-written, dead. Checked 2026-09-11.** This row describes retraining the kNN on the Google Kaggle set to fix M/N/D. That was already tried and disproven on **2026-09-04** (see Revision history: `tools/harvest-kaggle.html`, 1364 harvested samples, replay accuracy 0%→0% — root cause is a landmark-format mismatch, Kaggle's MediaPipe *Holistic* vs. the classifier's *HandLandmarker*, not a data-quantity problem no amount of more Kaggle data fixes). The Kaggle sequences **are already imported** (`data/fs_sequences.json`, 300 sequences, done 2026-09-04) — the "Task" column here describes work that's both already done AND already shown not to help. **The M/N/D goal this row existed for is separately solved** — by `js/heads.js` (learned heads), a different, working approach. The Kaggle data's only remaining legitimate uses: Stage 9 (training a *sequence model* on Holistic landmarks, a matched domain — future architecture, not this one) and decoder stress-test phrases (already used, e.g. today's `tools/sweep-transition.mjs`). **Nothing to implement here in the current architecture.** | — | — |
| B4 | ✅ **DONE (2026-09-04)** — **Curated word content + Spell-mode practice targets** — `data/practice-words.json` ~150→~370 words across 8 themed categories; new `js/spelldrill.js` + a "Practice a word" toggle in Spell mode (green/red letter colouring, auto-advance) whose "from my lesson" source targets the active Course tier. | Spell mode was free-form with nothing to practise against; the drill also wires the productive side of the curriculum. Bundled word list also feeds `decode.js`. **Milestone M2.** | Med |
| B5 | **App-level accessibility, narrowed 2026-09-11 after checking each sub-item against the code.** ~~captions on every sound cue~~ **already done** — checked all 4 cues in `sound.js` (`success`/`fail`/`tick`/`charge`) against their call sites: every one already has a real-time visual companion (✓/✕ text + colour flash, `.timebar.low`'s pulse animation, the `--hold` ring), not just silence. ARIA labels + keyboard path: already substantial (many `aria-live` regions, full arrow/letter-jump keyboard nav, Escape everywhere). ✅ **In-app high-contrast toggle DONE (2026-09-11)** — a ◐ button in the topbar (`#contrastBtn`), `:root.high-contrast` in `css/style.css` (converted from the old `@media (prefers-contrast: more)` block so there's one set of overrides, not two copies to keep in sync). No explicit user choice yet → follows the OS `prefers-contrast: more` media query live; an explicit click stores an override in `asl-pref-contrast` and stops following the OS setting. Verified in-browser: toggling applies/persists across reload, `aria-pressed` syncs, no console errors, selftest 164/164. **Still missing:** a **screen-reader walkthrough** (never actually tested with a screen reader, just ARIA attributes added by inspection — needs a real pass with NVDA/VoiceOver, not more code changes based on guessing). | Table stakes for a tool aimed at a Deaf / hard-of-hearing audience, and non-negotiable before the RIT showcase. **Milestone M1.** | Med (down from High — the two harder sub-items are done or already-existing; only the SR walkthrough remains, and that's a testing task, not a build task) |
| B6 | **Number signs 0–9 + handshape variants** — digits first, then the regional/stylistic letter variants real signers use | Digits are the single most common real-world fingerspelling (phone numbers, addresses) and unlock Stage 8/9's number handling. Best benefit-to-effort item on the list. New data collection + train. **Milestone M3.** | **High** |
| B7 | **Accounts & cross-device progress** | Progress is `localStorage` on one browser. Fine now, a ceiling later. Needs a backend — first real dependency. Deferred to *after* the showcase (Stage 9 era). | Low |
| B8 | ✅ **DONE (2026-09-04)** — **Installable / offline (PWA)** — `manifest.webmanifest` + `icons/` + `sw.js` (precache shell on install; stale-while-revalidate for same-origin; cache-first for the MediaPipe wasm + `hand_landmarker.task`; navigation falls back to the cached page). Verified offline with the dev server stopped. `VERSION` in `sw.js` must be bumped per deploy. | Lets the app install and run offline at the demo. No new dependency. **Milestone M5.** | Med |

### Backlog part 2 — polish, pedagogy, tracking accuracy (added 2026-09-11)

From a design pass over six areas the user raised (feedback/"juice", skeleton overlay + directions, Duolingo-style UX, camera accuracy, missing features, letters→words) plus the tester complaints that drove the 2026-09-11 fixes. **Read this ranking honestly: nearly every item below is polish on top of an engine whose core assumption — that fluid mode works on a real webcam — is still unverified.** The plan's standing risk ("a growing built-but-unverified pile") applies to this table too. The webcam session still gates everything; B9/B11 are listed High only because they're cheap and directly answer confusion testers actually reported.

| # | Item | Why | Priority |
|---|------|-----|----------|
| B9 | ❌ **NOT A GAP — already implemented, checked 2026-09-11.** Was proposed as "colour all 21 joints by per-joint error," on the mistaken belief that `drawGuide()` only used the worst joint. Rereading the actual code: it already colours every joint AND every bone segment by its own error (`segColor(err[i])` per joint, `segColor((err[a]+err[b])/2)` per segment), with progressive reveal as you approach the shape. The worst-joint-only treatment is a *separate, additional* highlight+label on top — a reasonable design, not a bug. Don't rebuild this. | — | — |
| B10 | ✅ **DONE (2026-09-11)** — **A visible sense of accumulation** — a 🏆 badge in the topbar ("N/26"), click to open a mastery grid (26 letters, green/blue/grey by `done` count) + a daily streak line. `renderProgressCount()`/`renderProgressPanel()`/`touchStreak()` in `js/main.js`, reusing the `statsMap` that was already being collected and never shown. Mastery threshold = 3 completions (`MASTERY_DONE`). Streak keys off local calendar day so it doesn't reset on a timezone quirk. Verified in-browser with seeded stats: badge count, grid colouring, streak line, Escape-to-close, and backdrop-click-to-close all correct; selftest 164/164 (no module touched, so no new unit tests needed). | The single biggest satisfaction gap. This is Duolingo's whole engine and we had none of it. **Milestone M2.** | **High** |
| B11 | ⚠️ **TRIED, DOESN'T WORK — validated 2026-09-11, not shipped.** Proposed deriving palm orientation from `(index-MCP − wrist) × (pinky-MCP − wrist)`. Validated the sign convention offline against real ground truth *before* shipping, per the plan below: the reference photos in `assets/reference/` are actual grassknoted training frames, so **B**'s photo (visibly palm-toward-camera) and **Y**/**V**'s photos (visibly back-toward-camera, knuckles showing) give real labelled examples. Computed the cross product against each letter's real dataset centroid — **result: uniformly negative for all three, no sign difference between palm and back.** Dug into the raw coordinates: index-MCP and pinky-MCP sit on the *same* left/right side across both orientations (a true 180° flip should swap them) — real signers don't rotate the wrist as a clean single-axis spin, so per-letter hand-angle variation swamps this signal from just 3 landmarks. Did not chase a fancier formula calibrated against only 3 examples — that's overfitting risk, not a fix. **Conclusion: not viable with simple landmark geometry as scoped.** Would need either a proper 3D palm-plane fit across more points, or a differently-framed cue (e.g., an explicit "this letter is usually shown from behind" text note per letter, sourced from ASL reference material rather than derived geometry). Shelved, not reattempted without a genuinely different approach. | Directly fixes a tester complaint: "the skeletal video doesn't show front or back." | — |
| B12 | **Demo-hand animation rework** — replace the per-point 2D lerp with rotation-aware (or per-joint hierarchical) interpolation | Root cause of "it flips weirdly / doesn't look natural": `createCanonicalPlayer` lerps raw 2D-projected landmarks from a fixed neutral pose to each letter's centroid, dropping z entirely — real 3D rotation collapses into straight-line 2D motion. **A real feature, not a threshold tweak; scope it before touching it.** **Milestone M1.** | Med |
| B13 | ❌ **NOT A GAP — already implemented, checked 2026-09-11.** Proposed as "full description up front, delta corrections after" on the belief that description only appears passively and corrections escalate after 12s. Rereading `js/main.js`: `refDesc` (the full shape description) is set the moment you pick a letter, before your hand is even up — already "full description on first attempt." `refHint` is a *separate* line giving continuous, live delta-style corrections (`reference.hint()` + the worst-joint fallback from `guideInfo`, e.g. "Adjust your ring finger — follow the yellow marker") from the first frame a hand is detected, not gated behind any delay. What *does* wait ~12s (`stuckSince`) is an additional, stronger escalation on top of that — replaying the demo animation + a "nudge" pulse — which is a reasonable design (don't interrupt someone 1 second in), not a missing feature. Don't rebuild this. | — | — |
| B14 | ✅ **DONE (2026-09-11)** — **Spaced repetition / review queue**, combined with B15 into one "Review" sub-mode. `reviewPriority(L)` in `js/main.js` scores every letter by `done` count minus a bonus for `HARD_LETTERS` minus a recency term (`min(daysSince last practiced, 10) * 0.3`, capped so ancient history doesn't dominate) — never-practiced and long-untouched letters sort first. `s.last = Date.now()` added to `reward()`'s stats write to feed the recency term. **Verified live** with two seeded scenarios: fresh stats picked D first (matches hand-calculated priority order); 24 letters marked mastered (done=5, just practiced) correctly surfaced the untouched motion letter **J** first ahead of all 24, confirming both the priority math and that motion letters (J/Z) work fine inside Review without special-casing. | Per-letter `stats` and `HARD_LETTERS` already existed; nothing consumed them for scheduling. **Milestone M2.** | — |
| B15 | ✅ **DONE (2026-09-11), combined with B14** — **Bounded practice sessions.** A third `subMode` button, "Review" (`#reviewBtn`), reuses the A→Z run's queue-walking machinery (`setAzRun`/`advanceAz`/`showRunCard`, generalized to take a `kind` + `runQueue` instead of being hardcoded to all 26 letters in order) for a **10-letter** (`REVIEW_SIZE`) bounded session with its own completion card ("Review complete! 🎉" vs. "Alphabet complete! 🎉" — added `runCardTitle` id to switch it). Regression-checked A→Z run still works unchanged (0/26, starts at A) after the generalization. **Duolingo's speed incentive was deliberately NOT imported** — no timer, no bonus for finishing fast; the only reward is completing the set, consistent with the whole point of this morning's sloppy-fast fix. | Only the A→Z run had a finish line; Practice was open-ended. **Milestone M2.** | — |
| B16 | ✅ **DONE (2026-09-11), UNVERIFIED LIVE** — **Raise camera capture resolution** — `camera.js` now requests `{ideal: 1280×720}` (was 640×480), still `ideal` not `exact` so a weaker camera falls back gracefully. **Not confirmed on a real webcam** — this environment can't open one; needs a live check (does detection still hit target FPS, does accuracy actually improve) as part of the next webcam session. | Costs landmark precision on every device, worst on the back camera where the hand is farther away and smaller in frame. **Milestone M1.** | Med |
| B17 | **ROI crop-and-rerun** — second detection pass on the hand's bounding box when the hand is small in frame | The standard fix for the exact back-camera / arm's-length case. Normalises scale before classification, which is probably the biggest cheap accuracy win available. **Milestone M1/M3.** | Med |
| B18 | **Adaptive landmark smoothing** — replace the fixed EMA (α≈0.5 in `smoothLandmarks`) with a one-euro filter | Smooth hard when still, loose when moving: cuts transition latency without adding jitter. ~20 lines. Interacts with `transition.js` tuning — retune together. **Milestone M1.** | Low |
| B19 | **Shareable progress / session card** | Cheap, drives word-of-mouth, and genuinely useful for a showcase project. Depends on B10. **Milestone M5.** | Low |
| B20 | **Context-narrowed lexicons for `decode.js`** — bias the decoder toward the active lesson's category (food words during a food lesson) | `decode.js` already takes a lexicon via `buildLexicon()`; this is a swap, not new machinery. Meaningful accuracy gain for near-zero cost. **Milestone M4.** | Med |
| B21 | **Lexicalized fingerspelling** — teach the fluid, characteristic-movement forms frequent words take (#BACK, #JOB, #DO) rather than even-tempo letter-by-letter | **The actual bridge from "alphabet trainer" to ASL**, and the thing a Deaf reviewer would ask about first. Research + community question before it's a code task — bring it to the RIT/NTID contact. **Stage 9 era.** | Med (research) |

Also folded into **B5** from the 2026-09-11 audit: the `#demoZoom` enlarge overlay (canvas *and* photo variants) has **no focus trap** — Tab reaches controls behind it while open.

### Testing infrastructure — RESOLVED 2026-09-11: went with free CI, no agent

Started as an exploration of Claude Managed Agents for test automation; the user asked to keep this free, so it landed on plain GitHub Actions instead. What shipped:

- **`tools/ci-check.mjs`** — dependency-free Node script (no `npm install`, no `package.json`): syntax-checks every `js/*.js` file + `sw.js`, verifies `sw.js`'s `CORE` precache list matches the actual `js/` directory (catches "added a file, forgot to precache it" / "removed a file, sw.js still references it"), checks all 26 reference photos exist, and validates `dataset.json` / `fs_sequences.json` / `practice-words.json` are well-formed.
- **`.github/workflows/ci.yml`** — runs `ci-check.mjs` on every push/PR to `main`. Free (public repo, GitHub-hosted runner, no paid steps).
- **`tools/sweep-transition.mjs`** — the 2026-09-11 hand-run threshold sweep, committed as a reusable tool instead of a throwaway. `node tools/sweep-transition.mjs [sequenceLimit]`. Carries the domain-gap caveat inline (`fs_sequences.json` is Holistic landmarks, the classifier is HandLandmarker — absolute numbers are meaningless, only relative ordering is signal) so it can't be misread by a future session.
- **Deliberately NOT duplicated in CI:** `tools/selftest.html`'s 164 browser-based checks. Doing that for free would need a browser in the CI runner (Playwright/Puppeteer), which is a new dependency the working agreement says to ask about first — not worth it for a solo project where `selftest.html` already gets run by hand before every push. Revisit only if that manual step ever gets skipped in practice.
- **What free CI still can't touch, same as the agent couldn't:** the live camera loop and any real-device matrix (iOS Safari, Android Chrome). No amount of automation retires the "run a real webcam session" blocker at the top of this doc.
- The Managed Agent config that was built and explored during this decision (agent `tooney`) was **removed** — no sunk cost, it was never run, and keeping two overlapping test systems is worse than one.

---

## Scope
This plan covers **fingerspelling** (A–Z + J/Z motion letters) from a live webcam. It does **not** do ASL word-sign recognition (whole-word signs, which need motion + face + torso tracking and datasets we don't have — see "Out of scope"). **Stage 8** pursues a deliberate approximation of sentence-level understanding *built on fingerspelling only*: a person spells a message out letter by letter and the app segments, corrects, assembles and **speaks** it — a "slow Google Translate" that works with the data we already have.

---

## 1. Goal

**Original (Stages 1–7, met):** given a live webcam feed, detect a hand, classify which letter (A–Z) it's forming, and display it as text — entirely in the browser, on desktop and mobile. *Definition of done: correct letter within ~½ s for ≥90% of clearly-formed letters.* ✅

**Now (the North star, 2026-09-04):** grow it into a **near-final, polished, honest product** — a real fingerspelling learning tool (productive + receptive) plus a "spell a message → hear it spoken" bridge — and **showcase it to an RIT / NTID ASL professor or the Deaf community**, as a usable tool and a credible research direction. See the *North star* section above for the milestone roadmap.

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
- **Test detection reliability across a range of skin tones**, not just classification accuracy. Our classifier only sees landmark coordinates (skin color plays no role there), but MediaPipe's underlying hand *detector* is a pretrained model we don't control — if it fails to find a hand at all for some skin tones, that would show up as a detection gap, not a letter-confusion gap, so it needs its own check. **Concrete protocol + the "why the Kaggle data doesn't fix this" analysis is in _Stage 9 → Skin tone_**; use the Monk Skin Tone (MST) 10-point scale as the yardstick.
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

