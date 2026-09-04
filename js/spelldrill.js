// Spell-mode practice targets: give the signer a word to fingerspell and check
// what they spelled against it. Pure — no DOM, no speller. The UI glue (reading
// the pending word out of speller.js, colouring the prompt) lives in main.js.
//
//   const d = createSpellDrill(words);   // words: flat ["brown", "seven", ...]
//   d.setWords(list)                     // swap the pool (e.g. the current course tier)
//   d.next()                             // -> a fresh target (avoids repeats until exhausted)
//   d.match("bro")                       // -> { n: 3, ok: false, bad: false, target: "brown" }
//   d.submit("brown")                    // -> true  (+ score / streak / done)
//   d.skip()                             // -> next target, breaks the streak
//   d.target / d.score / d.streak / d.best / d.done / d.size

export function createSpellDrill(words = []) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  let pool = [...new Set(words.map(norm).filter(Boolean))];
  let target = null;
  let score = 0;
  let streak = 0;
  let best = 0;
  let done = 0;
  const seen = new Set();

  const pick = () => {
    let fresh = pool.filter((w) => !seen.has(w));
    if (!fresh.length) { seen.clear(); fresh = pool; }
    target = fresh[(Math.random() * fresh.length) | 0] || null;
    if (target) seen.add(target);
    return target;
  };

  return {
    get target() { return target; },
    get score() { return score; },
    get streak() { return streak; },
    get best() { return best; },
    get done() { return done; },
    get size() { return pool.length; },

    setWords(list) {
      pool = [...new Set((list || []).map(norm).filter(Boolean))];
      seen.clear();
      if (target && !pool.includes(target)) target = null;
    },

    next: pick,

    // How far `attempt` matches `target` as a prefix.
    //   n   — count of leading letters that match
    //   ok  — the whole attempt equals the target
    //   bad — the attempt has diverged (a wrong letter past position n)
    match(attempt) {
      const a = norm(attempt);
      if (!target) return { n: 0, ok: false, bad: false, target: "" };
      let i = 0;
      while (i < a.length && i < target.length && a[i] === target[i]) i++;
      return { n: i, ok: a === target, bad: a.length > i, target };
    },

    // Score an attempt. Exact match advances streak/score/done; anything else
    // breaks the streak. Returns whether it was correct.
    submit(attempt) {
      const ok = norm(attempt) === target && !!target;
      if (ok) {
        score += 1 + Math.min(streak, 4); // 1..5, faster streak = more
        streak += 1;
        done += 1;
        if (streak > best) best = streak;
      } else {
        streak = 0;
      }
      return ok;
    },

    skip() {
      streak = 0;
      return pick();
    },

    reset() {
      score = streak = best = done = 0;
      seen.clear();
      target = null;
    },
  };
}
