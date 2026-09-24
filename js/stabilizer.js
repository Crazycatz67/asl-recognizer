// =============================================================================
// js/stabilizer.js — debounces per-frame predictions into one letter (Engine)
// =============================================================================
// WHAT: The classifier's raw output flickers frame to frame, especially while
//   the hand moves between shapes. This turns that noisy stream into a single
//   "confirmed" letter: a label is confirmed once it has passed the confidence
//   gate for `stableFrames` predictions in a row. Anything below the gate, or
//   a hand leaving the frame (push(null)), resets the streak — but NOT the
//   already-confirmed letter, which stays shown until a new one wins.
//
// PIPELINE: webcam → MediaPipe → normalize → kNN → heads → [stabilizer.js]
//   → overlay/badge. main.js keeps two instances: the main one (Practice
//   badge, Challenge "seen" letter; config.js STABLE_FRAMES/MIN_CONFIDENCE)
//   and `spellStab` (6 frames) for Spell mode's hold-to-type path. Spell's
//   fluid path uses transition.js instead, because real signing speed never
//   holds still for N frames.
//
// PUBLIC API:
//   createStabilizer({ stableFrames, minConfidence }) → stabilizer
//     .push(prediction | null) → confirmed label (string) | null
//     .current    → the currently confirmed label (or null)
//     .candidate  → the label building up a streak right now
//     .progress   → 0..1, how far the candidate's streak is toward confirming
//     .reset()    → forget everything (candidate, streak, confirmed)
//
// UNITS: stableFrames counts push() calls (≈ detection frames, ~30/s);
//   minConfidence is the kNN vote share, 0..1.

/**
 * Create a streak-based debouncer for classifier predictions.
 * @param {{stableFrames?: number, minConfidence?: number}} [opts]
 * @returns {{push: (pred: ({label: string, confidence: number}|null)) => (string|null),
 *   reset: () => void, readonly current: (string|null),
 *   readonly candidate: (string|null), readonly progress: number}}
 */
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

      // below the gate or no hand: break the streak, keep what's confirmed
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
