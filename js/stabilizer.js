// Turns a noisy per-frame prediction stream into a single "confirmed" letter.
//
// A letter is confirmed once the same label has passed the confidence gate
// for `stableFrames` predictions in a row. Anything below the confidence
// gate, or a hand leaving the frame, resets the streak.
//
//   const stab = createStabilizer({ stableFrames: 8, minConfidence: 0.6 });
//   stab.push(prediction | null) -> confirmed label (string) | null
//   stab.current                 -> the currently confirmed label
//   stab.candidate               -> what's building up right now

export function createStabilizer({ stableFrames = 8, minConfidence = 0.6 } = {}) {
  let candidate = null;
  let streak = 0;
  let confirmed = null;

  return {
    get current() {
      return confirmed;
    },
    get candidate() {
      return candidate;
    },
    get progress() {
      return Math.min(1, streak / stableFrames);
    },

    push(pred) {
      const ok = pred && pred.label && pred.confidence >= minConfidence;

      if (!ok) {
        candidate = null;
        streak = 0;
        return confirmed;
      }

      if (pred.label === candidate) {
        streak++;
      } else {
        candidate = pred.label;
        streak = 1;
      }

      if (streak >= stableFrames && candidate !== confirmed) {
        confirmed = candidate;
      }
      return confirmed;
    },

    reset() {
      candidate = null;
      streak = 0;
      confirmed = null;
    },
  };
}
