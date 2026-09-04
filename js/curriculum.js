// A real curriculum for Read mode: fingerspelling letters grouped by handshape
// difficulty, unlocked one tier at a time, with progress gating. Pure — no DOM.
// The tier data lives in data/curriculum.json; the UI glue is in main.js.
//
//   const course = createCourse(json, savedState);
//   course.tier                 -> the active tier object { name, letters, words, ... }
//   course.words()              -> words for the active tier (feed to reader.next(list))
//   course.record(true|false)   -> log an answer; returns { unlocked, tierName? } on promotion
//   course.select(i)            -> switch to tier i if it's unlocked
//   course.state()              -> plain object to persist (savePref); pass back next session
//   course.view()               -> [{ name, blurb, letters, locked, active, done, need }]
//
// Gating: a tier unlocks when you get `unlockThreshold` answers right while its
// predecessor is the active tier. Progress is per-tier and never decreases; a
// wrong answer just doesn't advance it.

export function createCourse(json = {}, saved = null) {
  const tiers = Array.isArray(json.tiers) ? json.tiers : [];
  const need = Math.max(1, json.unlockThreshold | 0 || 10);

  // unlocked = how many tiers are open (>= 1); correct = per-tier tally.
  let unlocked = 1;
  let active = 0;
  const correct = tiers.map(() => 0);

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
