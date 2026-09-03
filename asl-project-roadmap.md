# ASL project roadmap (research-informed)

## Revision history
- **2026-09-03:** Added two-handed neutral tracking approach to Phase 2 (mirror each hand individually, concatenate in consistent left-then-right order) — prompted by a fairness/bias discussion; doesn't affect Phase 1 since ASL fingerspelling is one-handed.
- **2026-09-03:** Full roadmap rewritten to incorporate landscape research pass across all 5 phases — dataset swap (ASL Citizen over WLASL) for phase 2, explicit DRM scoping + word-boundary-detection task for phase 3, "check my sign" reuse of phase 1/2 classifier for phase 4, cross-cutting techniques section added.
- **2026-09-03:** Roadmap expanded from letters-only to full 5-phase vision (letters → word recognition → video captioning → learning dictionary → app conversion), first established in chat.

Each phase below reflects what real companies/projects/papers have already tried, and what we're borrowing or changing as a result.

---

## Phase 1 — Letters/fingerspelling (current, in progress)

**Status:** MVP plan locked (see `asl-letter-recognition-plan.md`), no code written yet.

**Validated by research:** MediaPipe landmarks → lightweight in-browser classifier is a well-trodden path (fingerpose, multiple 2025 papers), not just our own idea. kNN → small neural net is a legitimate, commonly-used upgrade ladder — nothing suggests we need to skip straight to a heavier model.

**Changes made based on research:**
- Balance training data per letter (equal samples per class) — added to Task 3.
- Widened the "confusable letters" watchlist from M/N/S to **M/N/S/T and A/T** — added to Task 6.

**No plan change needed:** our general architecture (landmarks, not raw pixels; lightweight classifier, not a heavy model) already matches what every comparable in-browser/CPU-only project converges on.

---

## Phase 2 — Word/sign recognition

**What changes:** dataset choice, plus a two-hand tracking approach.

- **Two-handed signs need a neutral, consistent representation.** Many ASL words (unlike the one-handed fingerspelling alphabet) use both hands. MediaPipe already supports tracking two hands at once; the plan is to mirror each hand individually to a canonical orientation (same handedness-normalization already used for letters), then always concatenate landmarks in a consistent order (left-then-right) — so the model reads relative hand position the same way regardless of who's signing or which hand they favor.
- **Use ASL Citizen, not WLASL, as the primary training dataset.** ASL Citizen (Microsoft Research) is newer, larger (83k+ videos, 2,731 signs), and crowd-sourced from real Deaf/HoH signers in varied real-world conditions rather than lab conditions. Models trained on it roughly **double** the accuracy of WLASL-trained models on the same signs in cross-dataset tests. WLASL remains useful as a secondary/benchmark reference, not the primary training source.
- **Set realistic accuracy expectations now:** competitive research systems land around 60–75% top-1 accuracy even on curated data — not near-100%. Worth baking into how we describe "done" for this phase so it doesn't quietly assume near-perfect accuracy.
- **Architecture stays the same as planned:** temporal model (LSTM/transformer) over pose/hand/face landmarks — the field has converged on this too, nothing suggests a different technical direction.

---

## Phase 3 — Video/screen-capture captioning

**What changes:** explicit scoping and one added task.

- **Scope to non-DRM sources from the start** — own uploads, open web video (most YouTube/educational/conference content), live camera feeds. DRM-protected commercial video (Netflix etc.) is a hard platform wall (browsers' Encrypted Media Extensions block script/canvas access to protected video), not a solvable gap — every comparable real project scopes around it the same way, so this isn't a compromise unique to us.
- **Add an explicit task: word-boundary detection for continuous signing.** Research repeatedly flags this as the harder unsolved part of captioning (vs. isolated word clips) — it shouldn't be assumed to "fall out for free" once phase 2 works.
- **Architecture reference:** local inference + browser-extension overlay (rather than sending video to a server) is the structure used by the closest real prototype found (a 2025 real-time meeting-captioning system) — good structural default to plan around when we get here.
- **Reference point for "good enough":** a shipping product in this space (Sign-Speak/CaptionASL) reports a BLEU score of 60, roughly on par with a human interpreter — useful benchmark once we have something to measure.

---

## Phase 4 — Sign-language learning dictionary

**What changes:** this phase is no longer fully independent of phases 1–2.

- **Plan for a "check my sign" mode that reuses the phase 1/2 recognition engine**, rather than building the dictionary as a pure video-flashcard library. Across every strong competitor app researched (Lingvano, SignAll/Ace ASL), camera-based feedback on the *learner's* signing is the single most-cited standout feature — and we're already building the exact capability (a classifier that reads hand shapes) for a different purpose. Reusing it here is close to free.
- **Static content (reference videos/images per sign) can still start anytime, independent of recognition accuracy** — that part of the original parallel-track plan still holds. It's specifically the "check your sign" feedback layer that now depends on phases 1–2 existing.
- **Content sourcing note:** Deaf-made or Deaf-reviewed content is consistently what reviewers value most (e.g. The ASL App) — worth keeping in mind when sourcing example signs later, even though it's a content decision rather than a technical one.

---

## Phase 5 — App conversion (unchanged)

No research changes here — still the last step, packaging the proven web app (PWA first, native later if needed).

---

## Cross-cutting techniques (apply once we're past static letters)

These aren't a separate phase — they're methods that showed up repeatedly across the research and apply to phases 2 onward:

- **Transfer learning** (freeze a pretrained backbone, fine-tune only the last layers) is the single biggest lever for good accuracy from a dataset we can realistically build alone — bigger impact than architecture choice.
- **Data augmentation** (rotating/shifting/rescaling landmark data) is a cheap way to make a smaller dataset behave like a bigger one — relevant once we go beyond a pre-built dataset.
- **MobileNet-family architectures** are the recurring choice for real-time, browser/CPU-only inference — the natural fit if/when phase 2 needs something heavier than kNN or a small feedforward net.

---

## Open items flagged by research, not yet decided

1. **Phase 2 dataset:** confirm ASL Citizen access/licensing when we get there.
2. **Phase 3 DRM scoping:** should be stated explicitly in any user-facing description of the captioning feature, so it reads as an intentional decision, not a missing feature.
3. **Phase 4 reuse:** when we design phase 1/2's classifier, keep its interface generic enough that phase 4's "check my sign" mode can call into it without a rebuild.
