// =============================================================================
// js/reader.js — Read mode: receptive fingerspelling quiz (Engine, DOM-free)
// =============================================================================
// WHAT: Receptive practice — the app's animated hand spells a word, the user
//   types what they read. This module picks the word, checks the typed guess,
//   explains a wrong answer, and keeps score. Pure — no DOM, no player. The
//   UI glue (driving reference.js createCanonicalPlayer, wiring the form)
//   lives in main.js (playWord / nextReadWord / judgeRead).
//
// WHERE IT SITS: not part of the camera pipeline at all — Read mode runs with
//   the camera off. Words come from data/practice-words.json (free play) or
//   curriculum.js course.words() (course style).
//
// PUBLIC API:
//   const rd = createReader(bank, { confusion });  // bank: { category: ["word", ...], ... }
//   rd.next()                        -> a fresh word (avoids repeats until the pool is exhausted)
//   rd.next(["a","b"])              -> same, but from a caller-supplied list (Course mode)
//   rd.check("sarah")               -> { ok, diff, confusables } (+ updates score / streak)
//   rd.reveal()                     -> the current word, breaks the streak
//   rd.toggleCategory("names")      -> add/remove a category from the pool (never empties it)
//   rd.setConfusion(map)            -> swap in confusion data that arrives after construction
//   rd.reset()                      -> zero score/streak/best, forget seen words
//   rd.score / rd.streak / rd.best / rd.current / rd.categories /
//   rd.activeCategories / rd.poolSize
//
// WHY `diff`/`confusables` (S3): a wrong guess on a fingerspelling test is
// rarely a random miss — it's usually one letter mistaken for one that looks
// like it (M/N, D/O). `check()` reports exactly which positions diverged and,
// where `opts.confusion` (the same shape as data/confusion.json: {truth:
// {observed: weight}}) says a pair is a KNOWN look-alike, flags it — so the
// UI can say "you read O for D" instead of just "wrong", which is the whole
// point of practicing a confusable-heavy skill.
//
// GOTCHA: bank keys starting with "_" (e.g. "_comment") are metadata, not
//   categories, and are ignored.

// ---- helpers ----

// Position-by-position comparison of guess vs answer (a length mismatch shows
// up as null on the shorter side). Mismatched pairs the confusion map knows
// about (either direction) are also returned as confusables with their weight.
function diffWords(guess, answer, confusion) {
  const n = Math.max(guess.length, answer.length);
  const diff = [];
  const confusables = [];
  for (let i = 0; i < n; i++) {
    const expected = answer[i] ?? null;
    const got = guess[i] ?? null;
    if (expected === got) continue;
    diff.push({ i, expected, got });
    if (expected && got) {
      const w = confusion?.[expected]?.[got] ?? confusion?.[got]?.[expected] ?? 0;
      if (w > 0) confusables.push({ expected, got, weight: w });
    }
  }
  return { diff, confusables };
}

// ---- public factory ----

/**
 * Create a Read-mode quiz over a categorised word bank.
 * @param {Object<string, string[]>} [bank]  { category: [words] } (data/practice-words.json)
 * @param {{confusion?: Object<string, Object<string, number>>}} [opts]
 *   confusion: {truth: {observed: weight}} look-alike map (may arrive later via setConfusion)
 * @returns {object} the reader API described above
 */
export function createReader(bank = {}, opts = {}) {
  // `let`, not `const`: main.js loads the word bank and the confusion matrix
  // as two independent fetches, and on a real network the (much larger)
  // decoder word list races with (and often loses to) the small practice-
  // words.json — so this is frequently still null when the reader is built.
  // setConfusion() lets main.js wire it in later without losing what a
  // closed-over const would have silently missed forever.
  let confusion = opts.confusion || null;
  const cats = Object.keys(bank).filter((k) => !k.startsWith("_") && Array.isArray(bank[k]));
  const active = new Set(cats);
  let current = null;
  let score = 0;
  let streak = 0;
  let best = 0;
  const seen = new Set();

  const pool = () => {
    const out = [];
    for (const c of active) for (const w of bank[c]) out.push(String(w).toLowerCase());
    return [...new Set(out)];
  };

  return {
    get score() { return score; },
    get streak() { return streak; },
    get best() { return best; },
    get current() { return current; },
    get categories() { return cats.slice(); },
    get activeCategories() { return [...active]; },
    get poolSize() { return pool().length; },

    toggleCategory(c) {
      if (!cats.includes(c)) return;
      if (active.has(c)) {
        if (active.size > 1) active.delete(c);
      } else active.add(c);
      seen.clear();
    },

    setConfusion(map) {
      confusion = map || null;
    },

    // next()          -> pick from the active-category pool
    // next(["a","b"]) -> pick from a caller-supplied list (Course mode drives this),
    //                    still avoiding repeats until that list is exhausted
    next(override) {
      const all =
        Array.isArray(override) && override.length
          ? [...new Set(override.map((w) => String(w).toLowerCase()))]
          : pool();
      let fresh = all.filter((w) => !seen.has(w));
      if (!fresh.length) { seen.clear(); fresh = all; }
      current = fresh[(Math.random() * fresh.length) | 0] || null;
      if (current) seen.add(current);
      return current;
    },

    check(guess) {
      const clean = String(guess || "").trim().toLowerCase().replace(/\s+/g, "");
      const ok = !!current && clean === current;
      if (ok) {
        score += 1 + Math.min(streak, 4); // 1..5 per word, faster streak = more
        streak += 1;
        if (streak > best) best = streak;
        return { ok, diff: [], confusables: [] };
      }
      streak = 0;
      const { diff, confusables } = current ? diffWords(clean, current, confusion) : { diff: [], confusables: [] };
      return { ok, diff, confusables };
    },

    reveal() {
      streak = 0;
      return current;
    },

    reset() {
      score = 0; streak = 0; best = 0; seen.clear(); current = null;
    },
  };
}
