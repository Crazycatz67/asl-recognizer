// "Simon says" speed game. A letter (later: a short word) is shown, a "GO!"
// flash, then you race a shrinking timer to actually FORM it — you advance
// when the recogniser reads your hand as that letter, not when a shape meter
// guesses. Land it fast for more points; keep landing them for a combo
// multiplier. You have 3 lives; a timeout or a Skip costs one.
//
//   const game = createChallenge({ letters, words?, difficulty?, rng? });
//   game.start(now, difficulty?);                 // "normal" | "hard"
//   game.setWords(list);                          // word rounds (loaded later)
//   game.skip();                                  // spend a life, jump to next
//   const snap = game.update(now, seenLetter, { near }?);
//     seenLetter: the confirmed letter the recogniser reads right now, or null
//                 when there's no hand (null never drains the timer)
//     near:       the hand is "close" to the needed letter (grace at time-out)
//   snap -> { phase, letter, target, progress, round, score, best, streak,
//             bestStreak, mult, lives, remainingFrac, low, draining, lastGain,
//             missedLetter, missReadAs, event, comboUp, partHit, newBest,
//             summary }
//     phase: "study" | "go" | "play" | "won" | "miss" | "over"
//     event: "letter" | "go" | "play" | "win" | "miss" | "over" | null (fires once)
//
// ---- design (2026-09-23 showcase pass; live QA: "too easy, needs stakes") ----
// * no free peeking: main.js no longer shows what the recogniser reads during
//   play; a miss reports what it read instead ("so close — read as N").
// * combo multiplier x1 -> x2 (3 in a row) -> x3 (6) -> x4 (10); a miss or
//   skip resets it. comboUp fires when the multiplier climbs.
// * difficulty: "hard" skips the demo preview (letter only, short study) and
//   runs a faster clock. Both ramp: from CONFUSE_FROM rounds on, half the
//   letters come from the look-alike set; from WORDS_FROM on, some rounds are
//   3-5-letter words (no doubled letters — the recogniser can't see a repeat).
// * fair stakes: holding a confidently WRONG letter for >WRONG_GRACE_MS makes
//   the clock run at 2x (draining) — it costs time, never a life on its own;
//   lives are only lost on time-out or Skip. If the hand is "near" the right
//   shape when time runs out, a one-time NEAR_GRACE_MS extension applies.
// * best score / streak / round persist per difficulty; newBest flags a run
//   that beat the stored best; summary lists accuracy + slowest letters.

const STUDY_MS = { normal: 2400, hard: 900 };
const GO_MS = 560; // brief "GO!" between study and play
const WON_MS = 560;
const MISS_MS = 900; // "-1 life" beat before the next letter
export const START_LIVES = 3;
const LETTER_MS = {
  normal: (r) => Math.max(2200, 6000 - r * 240), // floors at 2.2s (round 16)
  hard: (r) => Math.max(1700, 4200 - r * 180),
};
const CONFUSE_FROM = { normal: 6, hard: 3 };
const WORDS_FROM = { normal: 11, hard: 7 };
const WORD_CHANCE = 0.4;
// ASL look-alikes (see decode.js DEFAULT_CONFUSION / the measured confusion)
export const CONFUSABLE = ["M", "N", "S", "T", "A", "E", "K", "V", "P", "Q", "G", "H", "U", "R", "J", "Z"];
const WRONG_GRACE_MS = 800;
const NEAR_GRACE_MS = 1000;
// A frame gap longer than this isn't play time: the tab was hidden (rAF
// stops) or the camera stalled. The clock pauses across it instead of
// charging the whole absence to the round (LAB-053: a 15 s hidden tab cost
// a life). A real frame gap is ~33 ms; 1 s is far outside it. Opt-in
// (main.js passes it): tests step the clock in big jumps on purpose.
export const PAUSE_GAP_MS = 1000;
export const multFor = (streak) => (streak >= 10 ? 4 : streak >= 6 ? 3 : streak >= 3 ? 2 : 1);

const bestKey = (d) => (d === "normal" ? "asl-challenge-best" : `asl-challenge-best-${d}`);
const statsKey = (d) => `asl-challenge-stats-${d}`;
const load = (k, fallback) => {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};

export function createChallenge({ letters, words = [], difficulty = "normal", rng = Math.random, pauseGapMs = Infinity }) {
  let diff = difficulty === "hard" ? "hard" : "normal";
  let wordPool = [];
  let active = false;
  let phase = "idle";
  let target = null; // the letter or word being signed
  let progress = 0; // letters of `target` already landed (words)
  let round = 0;
  let score = 0;
  let streak = 0;
  let bestStreak = 0;
  let lives = START_LIVES;
  let best = Number(load(bestKey(diff), 0)) || 0;
  let phaseEnd = 0;
  let playStart = 0;
  let lastNow = 0;
  let announced = 0;
  let lastGain = 0;
  let missedLetter = null;
  let missReadAs = null;
  let skipRequested = false;
  let wrongSince = 0;
  let lastWrong = null;
  let graceUsed = false;
  let wins = 0, misses = 0;
  let times = []; // { target, ms, missed }

  const setWords = (list) => {
    wordPool = (list || [])
      .map((w) => String(w).toUpperCase())
      .filter((w) => /^[A-Z]{3,5}$/.test(w) && !/(.)\1/.test(w) && [...w].every((c) => letters.includes(c)));
  };
  setWords(words);

  const letterMs = (r) => LETTER_MS[diff](r);
  const roundDur = () =>
    target.length > 1 ? Math.round(letterMs(round) * (0.75 * target.length + 0.5)) : letterMs(round);

  const pickLetter = () => {
    const pool =
      round >= CONFUSE_FROM[diff] && rng() < 0.5
        ? CONFUSABLE.filter((c) => letters.includes(c))
        : letters;
    if (pool.length < 2) return pool[0];
    // never the same letter twice in a row — step to the next one instead of
    // re-rolling (a re-roll loop can't terminate with a degenerate rng)
    const i = Math.min(pool.length - 1, (rng() * pool.length) | 0);
    return pool[i] === target ? pool[(i + 1) % pool.length] : pool[i];
  };
  const pickTarget = () => {
    if (round >= WORDS_FROM[diff] && wordPool.length && rng() < WORD_CHANCE) {
      // short words first, longer as the run goes on
      const maxLen = round >= WORDS_FROM[diff] + 6 ? 5 : round >= WORDS_FROM[diff] + 3 ? 4 : 3;
      const fit = wordPool.filter((w) => w.length <= maxLen);
      if (fit.length) return fit[(rng() * fit.length) | 0];
    }
    return pickLetter();
  };

  const nextTarget = (now) => {
    round++;
    target = pickTarget();
    progress = 0;
    phase = "study";
    phaseEnd = now + STUDY_MS[diff];
    wrongSince = 0;
    lastWrong = null;
    graceUsed = false;
  };

  function finish() {
    phase = "over";
    const prev = load(statsKey(diff), { bestStreak: 0, bestRound: 0 }) || {};
    const newBest = score > best;
    if (newBest) {
      best = score;
      save(bestKey(diff), best);
    }
    const stats = {
      bestStreak: Math.max(prev.bestStreak || 0, bestStreak),
      bestRound: Math.max(prev.bestRound || 0, round),
    };
    save(statsKey(diff), stats);
    // slowest: misses first, then the longest landed times
    const slowest = [...times]
      .sort((a, b) => (b.missed - a.missed) || b.ms - a.ms)
      .slice(0, 3)
      .map((t) => t.target);
    return {
      newBest,
      summary: {
        score, best, round, bestStreak,
        allTimeBestStreak: stats.bestStreak, allTimeBestRound: stats.bestRound,
        accuracy: wins + misses ? wins / (wins + misses) : 0,
        wins, misses, slowest, difficulty: diff,
      },
    };
  }

  return {
    get active() {
      return active;
    },
    get phase() {
      return phase;
    },
    get difficulty() {
      return diff;
    },
    // the letter the player must form right now (null outside play)
    get needed() {
      return phase === "play" && target ? target[progress] : null;
    },
    best: () => best,
    score: () => score,
    setWords,
    savedStats: (d = diff) => ({
      best: Number(load(bestKey(d), 0)) || 0,
      ...(load(statsKey(d), { bestStreak: 0, bestRound: 0 }) || {}),
    }),

    start(now, difficulty) {
      if (difficulty) diff = difficulty === "hard" ? "hard" : "normal";
      best = Number(load(bestKey(diff), 0)) || 0;
      active = true;
      round = 0;
      score = 0;
      streak = 0;
      bestStreak = 0;
      lives = START_LIVES;
      announced = 0;
      lastGain = 0;
      missedLetter = null;
      missReadAs = null;
      skipRequested = false;
      wins = 0;
      misses = 0;
      times = [];
      target = null;
      lastNow = now;
      nextTarget(now);
    },
    stop() {
      active = false;
      phase = "idle";
      target = null;
    },
    // spend a life and jump to the next letter (only mid-play)
    skip() {
      if (active && phase === "play") skipRequested = true;
    },

    update(now, seenLetter, { near = false } = {}) {
      if (!active) return null;
      let event = null;
      let comboUp = false;
      let partHit = false;
      let over = null;
      let dt = Math.max(0, now - lastNow);
      lastNow = now;
      if (dt > pauseGapMs) {
        // shift every clock forward by the gap, as if time stood still
        phaseEnd += dt;
        playStart += dt;
        if (wrongSince) wrongSince += dt;
        dt = 0;
      }

      // announce each fresh target once (covers start + every subsequent round)
      if (phase === "study" && announced !== round) {
        announced = round;
        event = "letter";
      }

      const needed = target ? target[progress] : null;
      let draining = false;

      if (phase === "study") {
        if (now >= phaseEnd) {
          phase = "go";
          phaseEnd = now + GO_MS;
          event = "go";
        }
      } else if (phase === "go") {
        if (now >= phaseEnd) {
          phase = "play";
          playStart = now;
          phaseEnd = now + roundDur();
          event = "play";
        }
      } else if (phase === "play") {
        // a confidently wrong letter held past the grace drains the clock.
        // Sustained wrongness counts even across DIFFERENT wrong letters, so
        // cycling through shapes can't dodge it. The letter just landed in a
        // word isn't "wrong" — the recogniser keeps reporting it while the
        // signer moves on to the next shape.
        const justLanded = progress > 0 ? target[progress - 1] : null;
        if (seenLetter && seenLetter !== needed && seenLetter !== justLanded) {
          if (!wrongSince) wrongSince = now;
          lastWrong = seenLetter;
          if (now - wrongSince >= WRONG_GRACE_MS) {
            phaseEnd -= dt; // clock runs at 2x
            draining = true;
          }
        } else {
          wrongSince = 0;
        }

        if (seenLetter && seenLetter === needed) {
          progress++;
          wrongSince = 0;
          lastWrong = null;
          if (progress < target.length) {
            partHit = true; // next letter of the word
          } else {
            const speed = Math.max(0, (phaseEnd - now) / roundDur());
            const oldMult = multFor(streak);
            streak++;
            if (streak > bestStreak) bestStreak = streak;
            const mult = multFor(streak);
            comboUp = mult > oldMult;
            lastGain = (10 + Math.round(speed * 20)) * target.length * mult;
            score += lastGain;
            wins++;
            skipRequested = false; // a Skip tapped on the landing frame is moot (LAB-052)
            times.push({ target, ms: now - playStart, missed: 0 });
            phase = "won";
            phaseEnd = now + WON_MS;
            event = "win";
          }
        } else if (!skipRequested && now >= phaseEnd && near && !graceUsed) {
          graceUsed = true; // so close — one short extension
          phaseEnd = now + NEAR_GRACE_MS;
        } else if (skipRequested || now >= phaseEnd) {
          skipRequested = false;
          lives--;
          missedLetter = target;
          missReadAs = lastWrong;
          streak = 0;
          misses++;
          times.push({ target, ms: Infinity, missed: 1 });
          if (lives <= 0) {
            over = finish();
            event = "over";
          } else {
            phase = "miss";
            phaseEnd = now + MISS_MS;
            event = "miss";
          }
        }
      } else if (phase === "won" || phase === "miss") {
        if (now >= phaseEnd) nextTarget(now); // the announce check emits "letter"
      }

      const span =
        phase === "study" ? STUDY_MS[diff]
        : phase === "go" ? GO_MS
        : phase === "play" ? roundDur()
        : phase === "miss" ? MISS_MS
        : 1;
      const remainingFrac = Math.max(0, Math.min(1, (phaseEnd - now) / span));

      return {
        phase,
        letter: target, // kept for callers written before word rounds
        target,
        progress,
        round,
        score,
        best,
        streak,
        bestStreak,
        mult: multFor(streak),
        lives,
        remainingFrac,
        low: phase === "play" && remainingFrac < 0.28,
        draining,
        lastGain,
        missedLetter,
        missReadAs,
        event,
        comboUp,
        partHit,
        difficulty: diff,
        newBest: over?.newBest ?? false,
        summary: over?.summary ?? null,
      };
    },
  };
}
