// "Simon says" speed game. A random letter is shown with its demo for a short
// study window, a "GO!" flash, then you race a shrinking timer to actually FORM
// it — you advance when the recogniser reads your hand as that letter, not when
// a shape meter guesses. Land it fast for more points. You have 3 lives; a
// timeout or a Skip costs one. Out of lives ends the run.
//
//   const game = createChallenge({ letters });
//   game.start(now);
//   game.skip();                                  // spend a life, jump to next
//   const snap = game.update(now, seenLetter);    // seenLetter: recognised letter or null
//   snap -> { phase, letter, round, score, best, streak, bestStreak, lives,
//             remainingFrac, low, lastGain, missedLetter, event }
//     phase: "study" | "go" | "play" | "won" | "miss" | "over"
//     event: "letter" | "go" | "win" | "miss" | "over" | null  (fires once)

const STUDY_MS = 2400;
const GO_MS = 560; // brief "GO!" between study and play
const WON_MS = 560;
const MISS_MS = 800; // "-1 life" beat before the next letter
const START_LIVES = 3;
const roundDur = (r) => Math.max(2200, 6000 - r * 240); // ms, floors at 2.2s

export function createChallenge({ letters }) {
  let active = false;
  let phase = "idle";
  let letter = null;
  let round = 0;
  let score = 0;
  let streak = 0;
  let bestStreak = 0;
  let lives = START_LIVES;
  let best = 0;
  try {
    best = Number(localStorage.getItem("asl-challenge-best")) || 0;
  } catch {}
  let phaseEnd = 0;
  let announced = 0;
  let lastGain = 0;
  let missedLetter = null;
  let skipRequested = false;

  const pick = () => {
    if (letters.length < 2) return letters[0];
    let n;
    do {
      n = letters[(Math.random() * letters.length) | 0];
    } while (n === letter);
    return n;
  };

  const nextLetter = (now) => {
    letter = pick();
    round++;
    phase = "study";
    phaseEnd = now + STUDY_MS;
  };

  return {
    get active() {
      return active;
    },
    get phase() {
      return phase;
    },
    best: () => best,
    score: () => score,

    start(now) {
      active = true;
      round = 0;
      score = 0;
      streak = 0;
      bestStreak = 0;
      lives = START_LIVES;
      announced = 0;
      lastGain = 0;
      missedLetter = null;
      skipRequested = false;
      nextLetter(now);
    },
    stop() {
      active = false;
      phase = "idle";
      letter = null;
    },
    // spend a life and jump to the next letter (only mid-play)
    skip() {
      if (active && phase === "play") skipRequested = true;
    },

    update(now, seenLetter) {
      if (!active) return null;
      let event = null;

      // announce each fresh letter once (covers start + every subsequent round)
      if (phase === "study" && announced !== round) {
        announced = round;
        event = "letter";
      }

      if (phase === "study") {
        if (now >= phaseEnd) {
          phase = "go";
          phaseEnd = now + GO_MS;
          event = "go";
        }
      } else if (phase === "go") {
        if (now >= phaseEnd) {
          phase = "play";
          phaseEnd = now + roundDur(round);
          event = "play";
        }
      } else if (phase === "play") {
        if (seenLetter && seenLetter === letter) {
          const speed = Math.max(0, (phaseEnd - now) / roundDur(round));
          lastGain = 10 + Math.round(speed * 20); // 10..30, faster = more
          score += lastGain;
          streak++;
          if (streak > bestStreak) bestStreak = streak;
          phase = "won";
          phaseEnd = now + WON_MS;
          event = "win";
        } else if (skipRequested || now >= phaseEnd) {
          skipRequested = false;
          lives--;
          missedLetter = letter;
          streak = 0;
          if (lives <= 0) {
            phase = "over";
            event = "over";
            if (score > best) {
              best = score;
              try {
                localStorage.setItem("asl-challenge-best", String(best));
              } catch {}
            }
          } else {
            phase = "miss";
            phaseEnd = now + MISS_MS;
            event = "miss";
          }
        }
      } else if (phase === "won" || phase === "miss") {
        if (now >= phaseEnd) nextLetter(now); // the announce check emits "letter"
      }

      const span =
        phase === "study" ? STUDY_MS
        : phase === "go" ? GO_MS
        : phase === "play" ? roundDur(round)
        : phase === "miss" ? MISS_MS
        : 1;
      const remainingFrac = Math.max(0, Math.min(1, (phaseEnd - now) / span));

      return {
        phase,
        letter,
        round,
        score,
        best,
        streak,
        bestStreak,
        lives,
        remainingFrac,
        low: phase === "play" && remainingFrac < 0.28,
        lastGain,
        missedLetter,
        event,
      };
    },
  };
}
