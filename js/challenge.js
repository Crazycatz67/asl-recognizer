// "Simon says" speed game. A random letter is shown with its demo for a short
// study window, a "GO!" flash, then you race a shrinking timer to actually FORM
// it — you advance when the recogniser reads your hand as that letter, not when
// a shape meter guesses. Land it fast for more points; miss the timer and it's
// game over (score, best, streak, the letter you missed).
//
//   const game = createChallenge({ letters });
//   game.start(now);
//   const snap = game.update(now, seenLetter);   // seenLetter: recognised letter or null
//   snap -> { phase, letter, round, score, best, streak, bestStreak,
//             remainingFrac, low, lastGain, missedLetter, event }
//     phase: "study" | "go" | "play" | "won" | "over"
//     event: "letter" | "go" | "win" | "over" | null   (fires once on the change)

const STUDY_MS = 2400;
const GO_MS = 560; // brief "GO!" between study and play
const WON_MS = 560;
const roundDur = (r) => Math.max(2200, 6000 - r * 240); // ms, floors at 2.2s

export function createChallenge({ letters }) {
  let active = false;
  let phase = "idle";
  let letter = null;
  let round = 0;
  let score = 0;
  let streak = 0;
  let bestStreak = 0;
  let best = 0;
  try {
    best = Number(localStorage.getItem("asl-challenge-best")) || 0;
  } catch {}
  let phaseEnd = 0;
  let announced = 0;
  let lastGain = 0;
  let missedLetter = null;

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
      announced = 0;
      lastGain = 0;
      missedLetter = null;
      nextLetter(now);
    },
    stop() {
      active = false;
      phase = "idle";
      letter = null;
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
        } else if (now >= phaseEnd) {
          missedLetter = letter;
          streak = 0;
          phase = "over";
          event = "over";
          if (score > best) {
            best = score;
            try {
              localStorage.setItem("asl-challenge-best", String(best));
            } catch {}
          }
        }
      } else if (phase === "won") {
        if (now >= phaseEnd) nextLetter(now); // the announce check emits "letter"
      }

      const span =
        phase === "study" ? STUDY_MS
        : phase === "go" ? GO_MS
        : phase === "play" ? roundDur(round)
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
        remainingFrac,
        low: phase === "play" && remainingFrac < 0.28,
        lastGain,
        missedLetter,
        event,
      };
    },
  };
}
