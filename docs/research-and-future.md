# Research & future directions

Long-form design and research notes moved here verbatim from
`asl-letter-recognition-plan.md` on 2026-09-23 so the plan doc stays short.
Nothing below was edited except this header.

- **Stage 8 (fingerspelling → sentence → speech).** Mostly built since this was
  written. `js/decode.js`, `js/transition.js` and the "Fluid + speak (beta)"
  Spell-mode toggle all shipped (see `docs/CHANGELOG.md`, 2026-09-04). Phase 4
  ("harvest Kaggle frames + retrain") was tried and disproven because of the
  Holistic-vs-HandLandmarker landmark domain gap (CHANGELOG, 2026-09-04, and
  B3 in `docs/original-plan-and-milestones.md`). Fluid mode has still not been
  validated on a live webcam at real signing speed. The section is kept as the
  design rationale.
- **Stage 9 (native-speed recognition, out-of-vocabulary words, dual-engine
  architecture, skin-tone evaluation).** Not started. This is the long-term
  research arc.

For the broader multi-phase vision (word signs, captioning, dictionary, app),
see `asl-project-roadmap.md`.

---

## Stage 8 — Fingerspelling → sentence → speech ("slow Google Translate")

**Idea (user, 2026-09-03):** we can't do ASL word-signs (no data), but we *can* read letters well. So let a person spell a whole message out slowly, capture the raw letter stream, and do the "what is this sentence" work in software — segment it into words, fix recognition errors, assemble a sentence, and **play it back as text and speech**. A real-time-ish Google-Translate feel that rides entirely on the fingerspelling we already have.

### Pipeline (all plain JS, no ML dependency)

1. **Capture** — extend `speller.js` to keep a **per-frame letter posterior stream**, not just the confirmed letters: `[{letter, conf}]` at the detect rate, plus pause markers. Keep the raw, unsplit, uncorrected stream alongside the cleaned transcript. This is what steps 2–3 decode; the current stabilizer output is too lossy for a good decode.
2. **Collapse (CTC-style)** — `js/decode.js`: merge runs of the same top-letter, drop frames below a confidence floor (treat as "blank"). Turns ~30 noisy frames into a short letter lattice, e.g. `W H A T | A R E | …`. Standard trick from the Kaggle-winner and continuous-fingerspelling decoders.
3. **Decode through a lexicon (trie + beam search)** — one pass, replacing the old "segment then correct" two-step. A **dictionary trie** (built once from the bundled word list) gives O(1) "is this a valid word prefix?" checks. Beam search over the collapsed lattice: each partial hypothesis must stay on a valid trie path; score = Σ `log(letter conf)` + `log P(word)` each time a word completes (word frequency from the same list) + a small word-count penalty. Pause markers strongly bias a word boundary but aren't required, so a missed pause still recovers. Output is always word-shaped. Falls back to Norvig-style DP segmentation on the top-1 string if the beam finds nothing (names, jargon).
4. **Confusion-aware costs** — the per-letter emission cost is weighted by a **confusion matrix measured from `tools/test-knn.html`** (real pairs: M↔N, D↔O/C, U↔V, K↔P …), so a hypothesis that swaps a known-confusable letter to make a real word is cheap. This is the noisy-channel model; it's what makes `wat ara yuo doing` decode to `what are you doing` better than generic Hunspell.
5. **Assemble** — capitalise sentence starts, join with spaces, end a sentence on a long pause or an explicit "period" gesture/button; keep a running transcript of finished sentences. Per-word **"keep as spelled"** toggle for anything the lexicon shouldn't touch.
6. **Speak** — `window.speechSynthesis` (built into every browser, zero dependency): enumerate `getVoices()` (populates async — listen for `voiceschanged`), let the user pick a voice + rate, queue utterances per sentence. A 🔊 **Speak** button + an auto-speak-on-sentence-end toggle. Caption every spoken sentence on screen (feeds backlog **B5**).

### UI (evolves Spell mode, no new mode needed)

A three-line live view in the spell panel:
- **raw** — the letter stream as recognised (mono, dim)
- **split** — the current best segmentation (updates every letter)
- **sentence** — the corrected, capitalised sentence, large + a Speak button

The existing dashed pending-word already covers "letters not yet confirmed"; Stage 8 adds the split/correct/speak layer on top.

### Prior art (not a novel idea — a cleaner take on a known one)

`Sign2Text` (portfolio project) already does fingerspelling → text with **Hunspell autocorrect** at 30fps. The [Google Kaggle ASL Fingerspelling comp](https://www.kaggle.com/competitions/asl-fingerspelling) is exactly this task at scale (3M chars, 100+ Deaf signers); its winners use CTC + beam + a lexicon — which is what steps 2–4 above are, in lightweight form. Continuous-fingerspelling papers (ChicagoFSWild+) do LM-constrained decoding as standard. **What's ours:** fully browser-side / no server / no ML framework, the raw→split→sentence transparency with per-word override, and correction tuned to *our* classifier's confusion matrix rather than generic Hunspell.

### New assets / deps

- **One data file**: a compact English word-frequency list (~top 10–30k words; ~50–300 KB, gzips small) → built into a trie at load. Ships with the app. *Not a code dependency* but flag it — first bundled data beyond the training set. Doubles as backlog **B4**'s content source.
- No new libraries. Trie, CTC-collapse, beam search, edit-distance fallback ≈ 200 lines of JS; TTS is a browser API.

### Honest limits (write these into the UI copy)

- This is **fingerspelling, not ASL**. Real signers rarely fingerspell whole sentences — it's slow and tiring. Stage 8's use case is "spell a message and have it spoken," an accessibility bridge and a demo, not a substitute for an interpreter.
- Accuracy compounds: a sentence is only as good as its worst letter. In-the-wild continuous fingerspelling is ~74% letter accuracy even in research (ChicagoFSWild+); the lexicon decode lifts *word* accuracy above that but won't save a badly-recognised run. Keep the **raw** line visible so the user can see and fix what it heard.
- Names, jargon and non-dictionary words won't decode — the per-word "keep as spelled" toggle is the escape hatch.

### Ph1 already prototyped + benchmarked (2026-09-04)

`js/decode.js` (trie over a 25k Norvig word list + CTC-collapse + left-to-right beam search with confusion-weighted emission costs + one optional insert/word + Norvig-DP fallback) and `tools/decode-lab.html` are **built and committed**. DOM-free, lexicon builds in ~22 ms, ~55 ms/decode at beam 60. Benchmark — 40 sentences, synthetic ASL-confusion noise, mean **word accuracy**:

| per-letter error | decoder | naive split (baseline) | full sentence exact |
|---|---|---|---|
| 0% | **100%** | 100% | **100%** |
| 8% | ~79% | ~64% | ~45% |
| 15% | ~64% | ~46% | ~23% |

**Verdict: the approach works.** The lexicon layer is worth **+15–18 word-accuracy points** over naive segmentation and is exact on careful spelling. Errors compound at the sentence level (~45% fully-correct at 8% letter error), so the **raw / split / sentence view + per-word override are load-bearing**, not polish. Realistic operating point given ~10% live letter error ≈ **75% word / 40% sentence** — a "readable, fix the raw line" tool. Still open: double letters need `transition.js` (Ph 2) to preserve the bounce; numbers need a digit path; tune the built-in confusion matrix against the real one from `test-knn.html`.

### Build simulation — phases, effort, risk

Effort in **focused sessions** (~2–4 h each) for a solo builder learning as they go. "Live-check" = confirm on the deployed site with a webcam.

| Ph | Work | Deliverable | Effort | Main risk |
|----|------|-------------|--------|-----------|
| 0 | **Kaggle import, test-set only.** One offline script (`tools/import_kaggle.py`): read `train.csv`, keep sequences with one hand mostly present, extract per-frame 21-hand landmarks + phrase → `data/fs_sequences.json` (~300 seq). Subsample hard — ignore the 190 GB, pull a slice. | `fs_sequences.json` + a loader | 1–2 | download size/logistics; Holistic-vs-Hands landmark quality (spot-check visually) |
| 1 | ~~`js/decode.js` + `decode-lab.html`~~ **done + benchmarked (see above).** Remaining: run it against `fs_sequences.json` once Ph 0 lands; swap in the real confusion matrix; digit path. | ✅ `decode.js`, `decode-lab.html` | ~~3–5~~ 1–2 left | double letters & numbers are the known blind spots |
| 2 | **`js/transition.js`** — settle→move→settle state machine, velocity normalised by hand span, emits a letter + its averaged posterior on each settle. Prototype by *replaying* `fs_sequences.json` offline; no webcam needed to tune. | `transition.js` + replay harness | 2–3 | threshold is device/framerate/signer-speed dependent (same trap as the swipe matcher) |
| 3 | **Wire both into `speller.js`** behind a "fluid mode (beta)" toggle: transition.js becomes the letter source for Spell mode, decode.js runs on the collapsed stream. Practice/Challenge keep the stabilizer. | Spell mode using the new path | 2 | the seam between transition.js output and the existing pending-word buffer |
| 4 | **Harvest training data + retrain.** DTW-align kNN predictions to known phrases, keep per-letter frames at ≥0.8 conf → append to `dataset.json` (group key = participant_id). Retrain heads, refresh the confusion matrix (feeds Ph 1 — loop back once). | bigger dataset, new `heads.json`, `confusion.json` | 2–4 | **domain shift** (Holistic+posed mix may regress); measure per-source, keep the mix only if it wins live |
| 5 | **UI + speech.** raw / split / sentence three-line view; `speechSynthesis` (async `getVoices`, gesture-gated first utterance, iOS `resume()` watchdog); per-word "keep as spelled" chips; caption every spoken line. | shipped Stage 8 | 2–3 | **iOS `speechSynthesis` is flaky** (cuts out ~15 s) — button-first, captions always |
| — | **selftest** coverage runs alongside every phase (decode on fixed noisy inputs, transition state machine, keep-as-spelled, speak-no-throw). | green suite | folded in | — |

**Total: ~14–22 sessions (≈ 3–6 weeks part-time).** Ph 0→1 is the critical path; Ph 2 parallels Ph 1 and makes it easier; Ph 4 loops back into Ph 1 once.

### Failure modes to expect (and the fallback for each)

- **Decoder splits into tiny common words** ("i am" ← "iam" is fine, but "it he re" ← "there") → raise the word-count/length penalty; lean on `P(word)` frequency.
- **Decoder refuses to split** (one long garbage token) → penalty too high, or the confidence floor dropped too many frames.
- **Doubled letters vanish** (HELLO→HELO) → CTC-collapse ate them; transition.js's move-between-letters requirement is the fix, plus the trie can sometimes re-insert.
- **Numbers/addresses mangled** (a big share of real fingerspelling) → digit-run passthrough; longer term needs B6 (digit signs).
- **Confusion matrix from posed data ≠ live confusions** → hand-tune the M/N and D/O cells after a live-check.
- **Mixed-dataset classifier regresses** → keep grassknoted-only if the Kaggle mix loses on a live per-letter check.
- **`speechSynthesis` silent on iOS / no voices** → always show the caption; "Speak" is best-effort, never the only output.
- **transition.js misses on a fast signer** → keep the old stabilizer path selectable; "fluid mode" stays a toggle until it's proven.

### Ways to build it efficiently

- **Everything is offline-testable against `fs_sequences.json`.** You barely touch the webcam until Ph 5 — replay real Deaf-signer sequences and iterate at keyboard speed.
- **`decode-lab.html` with typed input** = sub-second iteration on the hardest part; add a "corrupt with the confusion matrix" button to auto-generate test cases.
- **One word list, two uses** — decoder dictionary *and* backlog B4's practice content.
- **The confusion matrix already exists** — `tools/test-knn.html` produces it; just add a JSON export.
- **Build `transition.js` before leaning on `decode.js`** — clean letter boundaries make the decode job much smaller.
- **Keep `decode.js` / `transition.js` DOM-free in the reusable core** so any future page or tool consumes them directly.
- **Ship behind a beta toggle** — no big-bang cutover; Spell mode keeps working the whole time.

## Stage 9 — Breaking the two hard limits ("actually useful to the community")

Stage 8 is capped at *careful* spelling of *dictionary* words. The two ceilings, and how to attack each. **This stage is semester-scale, not weekend-scale** — it's the ambitious arc, logged so the direction is clear.

### First, before any of it: talk to Deaf people

The biggest lever on "actually useful" is not a model — it's confirming fingerspelling→speech is even the right problem. Ask a Deaf school, a university ASL program, a Deaf community centre, or an existing effort (PopSign / Georgia Tech works directly with Deaf signers; the Deaf Professional Arts Network; the sign-language-processing research community, SLTAT workshops). Possible outcomes: the highest-value thing is *receptive* practice (B1), or a specific transactional context (pharmacy, DMV, doctor intake), or contributing a component to a project that already has data + Deaf leadership + distribution. **A solo project's best path to impact may be a good open component others use, plus an openly-released consented landmark dataset (Deaf-led).**

### Limit 1 — native-speed / conversational fingerspelling

Frame-wise classification (the current kNN) *cannot* do this — at speed the hand never fully forms letters, the signal is in the *transitions*. The fix is a **sequence model on landmark input**:

- **Proven, and on-device.** The [Google ASL Fingerspelling Kaggle comp](https://www.kaggle.com/competitions/asl-fingerspelling) is exactly this task; the [1st-place solution](https://github.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution) is a Squeezeformer encoder + 2-layer transformer decoder on MediaPipe landmarks, exported to **TF-Lite for on-device**. The competition *required* a small on-device model. So "runs client-side" is not the blocker — the self-imposed "no ML framework" rule is.
- **Path:** train a *small* CTC model (1D-CNN or GRU encoder, ~100k–2M params) on the Kaggle landmark sequences in Colab (free GPU, hours not days). Export to ONNX; run in-browser via **ONNX Runtime Web** (WASM / WebGPU). Landmark input is ~63 floats/frame — tiny, real-time even on a phone.
- **Keep the kNN** — see the *Dual-engine architecture* below. The sequence model powers a new **"Conversation" mode**; nothing else changes.
- **Augmentations from the winners:** FingerDropout, TimeStretch, CutMix; also predict a per-sequence confidence to flag garbage.
- **Honest ceiling:** the competition had ~200 hours of data; Google's shipping model had far more. This won't match Google. But the Kaggle winners got to usable word-error rates on ~200 hours, on-device — that's the achievable target.

### Dual-engine architecture — k-NN for the basics, sequence model for Conversation mode

Design decision (user, 2026-09-04): **don't replace the k-NN.** Run two recognisers side by side, each doing what it's good at. The k-NN stays the default and the whole app keeps working with zero download.

| | **Engine A — k-NN** (built) | **Engine B — sequence model** (Stage 9) |
|---|---|---|
| Powers | Practice, Challenge, Read, Spell (letter-at-a-time), the word drill | **Conversation mode** (new, opt-in) |
| Input | one normalised frame (74-dim) | a rolling ~1–2 s window of landmark frames |
| Output | letter + confidence, immediately | streaming letter *sequence* + per-sequence confidence |
| Good at | instant, transparent (you can show *why*), no download, accurate on a held letter | reads the *transitions* → survives natural speed |
| Cost | ~0 | model (~1–5 MB) + ONNX Runtime Web (~3 MB WASM), first-load lag |
| Trained on | grassknoted (posed A–Z, mostly hearing) | Google Kaggle set (100+ Deaf signers, continuous phrases) |

- **Default is Engine A.** Conversation mode is a toggle, same pattern as fluid mode — the rest of the app is untouched.
- **Lazy load.** ONNX Runtime + the model download only on first entry to Conversation mode, then the service worker (B8) caches them. Fetch fails → Conversation mode falls back to today's fluid path (Engine A + `transition.js` + `decode.js`) with a "lite mode" note.
- **Shared downstream.** Both engines emit a letter stream into the *same* `decode.js` lexicon/beam layer and the same `speechSynthesis` output. Engine B only replaces the `transition.js` + per-frame-k-NN *front* of the fluid pipeline; everything after the letter stream is reused.
- **Shared front-end.** Both sit on the same MediaPipe hand-landmark step — so the skin-tone evaluation below covers both engines at once.
- **Cross-check for free.** With Conversation mode on, optionally keep Engine A running in the background and log where the two disagree — cheap evaluation data, and a sanity fallback when Engine B's per-sequence confidence says it produced garbage.

### Skin tone — our data vs. Google's approach (and why the data swap is *not* the fix)

The one thing both pipelines get right by construction: **the classifier/model never sees skin.** It sees normalised 3-D landmark coordinates — a brown hand and a pale hand forming the same letter produce the same vector. So at the *decision* stage neither Engine A nor a Google-data Engine B can be skin-biased. Confirmed for the k-NN back on 2026-09-03; it's equally true for a sequence model on landmark input.

The disparity risk is one stage **upstream**, in the pixel → landmark step, and it is **identical for both engines**:

- **Detection** — does MediaPipe find the hand at all? A miss = a dropped frame = no letter; hand/face detectors have *measured* gaps across skin tone, worse in low light / low contrast.
- **Landmark precision** — when the hand *is* found, are the 21 points placed as accurately? Lower hand-vs-background contrast adds jitter, which degrades classification indirectly.

Both MediaPipe **Hands** (ours) and MediaPipe **Holistic** (the Kaggle data) run a pretrained pixel detector from the same family for this step. **Switching to Google's dataset doesn't touch it** — the Kaggle data is *already* landmarks; the pixel step ran on Google's machines when they built it. So:

> Adopting Google's data moves the *training distribution*, not the *detector*. It does not, by itself, answer the skin-tone question.

What Google's **data** genuinely helps: 100+ signers on their own webcams/phones/lighting (vs. our studio-ish alphabet cards) → a model more robust to hand shape, speed, framing and lighting, which *correlates* with better cross-skin-tone behaviour but isn't a targeted fix. It also ships `participant_id` for signer-held-out evaluation — but, as far as is public, **no Fitzpatrick / Monk skin-tone labels**, so you can't slice the Kaggle set by skin tone directly.

What Google's **approach** (the org's practice, separate from this dataset) models for us: the **Monk Skin Tone (MST) scale** — a 10-point scale Google published for exactly this kind of CV fairness evaluation. The thing to copy is the **evaluation discipline**, not the dataset.

**The actual fix is a measurement task, and it's the same for either engine** (this is the concrete form of the Stage 5 / Task 6 "skin-tone check"):

1. Recruit a small **skin-tone-stratified panel** — aim ≥2 people per MST band you can reach (RIT/NTID could help source Deaf signers across the range).
2. Fixed protocol: each person forms all 26 letters × N reps, in controlled *and* uncontrolled lighting.
3. Measure **per MST band**: (a) hand-detection rate, (b) landmark jitter, (c) end-to-end letter accuracy.
4. If a gap shows at the detection stage: in-app lighting/exposure guidance, a brightness/contrast pre-pass on the video frame, and — last resort, heavy — a fine-tuned or swapped hand detector.

Bottom line: keep both engines landmark-based (they already are — that neutralises the decision stage), and treat skin-tone reliability as a **shared requirement on the MediaPipe front-end** that both engines sit on, measured with the MST scale.

### Limit 2 — names, addresses, phone numbers (out-of-vocabulary)

Not a model problem — a **vocabulary + UX** problem. The decoder fails because the target isn't in the dictionary.

- **Context lexicons.** Ask or infer the field type: *name* → US Census first/last names (~150k, tiny); *address* → number grammar + street-suffix set (ST/AVE/BLVD…) + city/state list; *phone / number* → pure digit grammar. Swap the trie for the context.
- **Digit signs 0–9 (promote B6 to high priority).** Bounded data-collection task; unlocks the single most common real-world fingerspelling use. Probably the highest benefit-to-effort item on the whole roadmap.
- **Spell-back confirmation.** On a low-confidence + no-dictionary-hit run (a name), don't guess — show the raw letters big, one tap to confirm or fix, then lock it. A name is spelled once per conversation; make the fix cheap.
- **Session dictionary.** A name/term confirmed once is added to the live lexicon so its next occurrence decodes.
- **Entity priors.** "my name is ___", "I live at ___" → pattern rules weight the right lexicon.

### Sequencing

Stage 8 first (it's the scaffold + the offline test harness + the lexicon/decoder Stage 9 reuses). Then, if the community conversation says fingerspelling→speech is worth pursuing: digit signs → context lexicons → the sequence model. The sequence model is the big commitment; everything before it is incremental and independently useful.
