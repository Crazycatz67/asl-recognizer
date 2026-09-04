// Receptive fingerspelling practice: pick a word for the animated hand to spell,
// check what the user typed, keep score. Pure — no DOM, no player. The UI glue
// (driving createCanonicalPlayer, wiring the form) lives in main.js.
//
//   const rd = createReader(bank);   // bank: { category: ["word", ...], ... }
//   rd.next()                        -> a fresh word (avoids repeats until the pool is exhausted)
//   rd.check("sarah")               -> true | false  (+ updates score / streak)
//   rd.reveal()                     -> the current word, breaks the streak
//   rd.toggleCategory("names")      -> add/remove a category from the pool (never empties it)
//   rd.score / rd.streak / rd.current / rd.categories / rd.activeCategories

export function createReader(bank = {}) {
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
      const ok =
        !!current && String(guess || "").trim().toLowerCase().replace(/\s+/g, "") === current;
      if (ok) {
        score += 1 + Math.min(streak, 4); // 1..5 per word, faster streak = more
        streak += 1;
        if (streak > best) best = streak;
      } else {
        streak = 0;
      }
      return ok;
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
