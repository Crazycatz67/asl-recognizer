// =============================================================================
// js/curriculum.js — tiered lesson progression ("Course") (Engine, DOM-free)
// =============================================================================
// WHAT: A real curriculum: fingerspelling letters grouped by handshape
//   difficulty, unlocked one tier at a time, with progress gating. It only
//   tracks state (which tier is open/active, how many correct answers each
//   has); it never touches the DOM. The tier data lives in
//   data/curriculum.json; the UI glue is in main.js.
//
// WHERE IT SITS: not part of the per-frame pipeline. Read mode's "course"
//   style feeds course.words() into reader.next(list) and reports each answer
//   via course.record(ok); Spell mode's word drill can also draw its word
//   pool from course.words().
//
// PUBLIC API:
//   createCourse(json, savedState) → course
//     .tier / .activeIndex / .unlocked / .length / .complete   (getters)
//     .words()         → words for the active tier (feed to reader.next(list))
//     .taughtLetters() → sorted letters of the active tier and every earlier one
//     .record(ok)      → log an answer; { unlocked: true, tierIndex, tierName } on promotion
//     .select(i)       → switch to tier i if it's unlocked (returns success)
//     .progress()      → { done, need, ratio } for the active tier
//     .view()          → [{ index, name, blurb, letters, locked, active, done, need }]
//     .state()         → plain object to persist (saveJSON); pass back next session
//     .reset()         → back to tier 0 with no progress
//
// GATING: a tier unlocks when you get `unlockThreshold` (default 10) answers
//   right while its predecessor is the active tier. Progress is per-tier and
//   never decreases; a wrong answer just doesn't advance it.
//
// GOTCHA: `savedState` comes from localStorage and may be stale or hand-
//   edited, so every field is clamped to the current tier count on load.

/**
 * Create a course over the tiers in curriculum.json.
 * @param {{tiers?: {name: string, letters?: string, words?: string[], blurb?: string}[],
 *   unlockThreshold?: number}} [json]  parsed data/curriculum.json
 * @param {{unlocked?: number, active?: number, correct?: number[]} | null} [saved]
 *   a previous course.state(), or null for a fresh start
 * @returns {object} the course API described above
 */
export function createCourse(json = {}, saved = null) {
  const tiers = Array.isArray(json.tiers) ? json.tiers : [];
  const need = Math.max(1, json.unlockThreshold | 0 || 10);

  // unlocked = how many tiers are open (>= 1); correct = per-tier tally.
  let unlocked = 1;
  let active = 0;
  const correct = tiers.map(() => 0);

  // ---- restore saved progress (clamped — see GOTCHA above) ----
  if (saved && typeof saved === "object") {
    if (Number.isFinite(saved.unlocked)) {
      unlocked = Math.min(tiers.length || 1, Math.max(1, saved.unlocked | 0));
    }
    if (Array.isArray(saved.correct)) {
      for (let i = 0; i < correct.length; i++) correct[i] = Math.max(0, saved.correct[i] | 0);
    }
    if (Number.isFinite(saved.active)) {
      active = Math.min(unlocked - 1, Math.max(0, saved.active | 0));
    }
  }

  const clampActive = () => {
    if (active > unlocked - 1) active = unlocked - 1;
    if (active < 0) active = 0;
  };

  return {
    get length() { return tiers.length; },
    get unlocked() { return unlocked; },
    get activeIndex() { return active; },
    get tier() { return tiers[active] || null; },
    get complete() { return unlocked >= tiers.length && correct[tiers.length - 1] >= need; },

    words() {
      const t = tiers[active];
      return t && Array.isArray(t.words) ? t.words.slice() : [];
    },

    // The set of letters the learner has been taught so far (active tier + all
    // earlier ones). Useful for filtering free content down to what's fair.
    taughtLetters() {
      const s = new Set();
      for (let i = 0; i <= active; i++) {
        for (const ch of String(tiers[i]?.letters || "")) s.add(ch.toUpperCase());
      }
      return [...s].sort();
    },

    select(i) {
      i = i | 0;
      if (i >= 0 && i < unlocked) { active = i; clampActive(); return true; }
      return false;
    },

    record(ok) {
      if (!ok) return { unlocked: false };
      correct[active] = Math.min(need, correct[active] + 1);
      // Promotion only from the frontier tier, and only once.
      if (active === unlocked - 1 && unlocked < tiers.length && correct[active] >= need) {
        unlocked += 1;
        return { unlocked: true, tierIndex: unlocked - 1, tierName: tiers[unlocked - 1].name };
      }
      return { unlocked: false };
    },

    progress() {
      return { done: correct[active] | 0, need, ratio: Math.min(1, (correct[active] | 0) / need) };
    },

    view() {
      return tiers.map((t, i) => ({
        index: i,
        name: t.name,
        blurb: t.blurb || "",
        letters: t.letters || "",
        locked: i >= unlocked,
        active: i === active,
        done: correct[i] | 0,
        need,
      }));
    },

    state() {
      return { unlocked, active, correct: correct.slice() };
    },

    reset() {
      unlocked = 1;
      active = 0;
      for (let i = 0; i < correct.length; i++) correct[i] = 0;
    },
  };
}
