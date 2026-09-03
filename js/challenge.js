// "Simon says" speed game. A random letter is shown with its demo for a short
// study window, then the help disappears and you have a shrinking amount of
// time to form it. Each letter you land speeds the next one up. Miss the timer
// and it's game over — just a score and a best.
//
//   const game = createChallenge({ letters });
//   game.start(now);
//   const snap = game.update(now, isCorrectThisFrame); // call every loop frame
//   snap -> { phase, letter, round, score, best, remainingFrac, event }
//     phase: "study" | "play" | "won" | "over"
//     event: "letter" | "win" | "over" | null  (fires once on the transition)

const STUDY_MS = 2600;
const WIN_HOLD_MS = 360; // brief — it's a race, not a calibration
const WON_MS = 600;
const roundDur = (r) => Math.max(2000, 5500 - r * 220); // ms, floors at 2s

export function createChallenge({ letters }) {
  let active = false;
  let phase = "idle";
  let letter = null;
  let round = 0;
  let score = 0;
  let best = 0;
  try {
    best = Number(localStorage.getItem("asl-challenge-best")) || 0;
  } catch {}
  let phaseEnd = 0;
  let holdStart = 0;
  let announced = 0; // last round whose "letter" event was emitted

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
    holdStart = 0;
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
      announced = 0;
      nextLetter(now);
    },
    stop() {
      active = false;
      phase = "idle";
      letter = null;
      holdStart = 0;
    },

    update(now, isCorrect) {
      if (!active) return null;
      let event = null;

      // announce each fresh letter once (covers start + every subsequent round)
      if (phase === "study" && announced !== round) {
        announced = round;
        event = "letter";
      }

      if (phase === "study") {
        if (now >= phaseEnd) {
          phase = "play";
          phaseEnd = now + roundDur(round);
          holdStart = 0;
        }
      } else if (phase === "play") {
        if (isCorrect) {
          if (!holdStart) holdStart = now;
          if (now - holdStart >= WIN_HOLD_MS) {
            score++;
            phase = "won";
            phaseEnd = now + WON_MS;
            event = "win";
          }
        } else {
          holdStart = 0;
        }
        if (phase === "play" && now >= phaseEnd) {
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
        phase === "study" ? STUDY_MS : phase === "play" ? roundDur(round) : 1;
      const remainingFrac = Math.max(0, Math.min(1, (phaseEnd - now) / span));

      return { phase, letter, round, score, best, remainingFrac, event };
    },
  };
}
