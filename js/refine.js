// =============================================================================
// js/refine.js — rule-based tie-breaker for confusable letters (Engine, SHELVED)
// =============================================================================
// WHAT: For a thin-margin kNN vote between two known look-alikes, measure one
//   hand-picked geometric feature (e.g. the index-tip ↔ thumb-tip gap for
//   D vs O), learn a threshold for it from the training data, and let that
//   measurement pick the winner.
//
// STATUS: SHELVED — built, measured, does not help. Kept as a record + a ready
// harness in case cleaner data changes the picture. NOT wired into the live
// app or the eval tool; only tools/selftest.js exercises it. The learned
// replacement that DID help is js/heads.js.
//
// PIPELINE: would sit where heads.js sits (after kNN, before stabilizer).
//
// PUBLIC API:
//   createRefiner(samples, { maxMargin, minSeparation }) → { refine, rules }
//     refine(prediction, vec) → prediction, relabelled (+ refinedBy) if a rule fired
//     rules                   → the rules that separated well enough to activate
//
// GOTCHA: shares the export name `createRefiner` with js/heads.js but is an
//   unrelated implementation with a different signature.
//
// Why it failed (2026-09-03, tested against the current dataset):
//   * M↔N — no landmark measurement separates them better than ~65% (13
//     candidates tried). MediaPipe is guessing the occluded thumb, so the
//     M-vs-N signal simply isn't in the landmarks.
//   * D↔O — the index–thumb-gap measurement IS 90% separable, but kNN doesn't
//     actually produce thin-margin D-vs-O ties: the real D errors are D→C,
//     D→P, D→E at 5-0 vote margins, which a D/O rule can't touch. Applying the
//     rule to every D/O prediction regressed D from 87%→84% (it overrides
//     correct calls with its own 10% error rate).
// The real fix for M/N/D is cleaner training data (self-capture), not a rule.
//
//   const refiner = createRefiner(samples);
//   refiner.refine(prediction, vec63plus) -> prediction (maybe relabelled)

// ---- geometry helper ----
// 3D distance between landmarks a and b inside a normalized vector v (each
// landmark occupies v[i*3 .. i*3+2]); units = normalized hand-size units.
const d = (v, a, b) =>
  Math.hypot(v[a * 3] - v[b * 3], v[a * 3 + 1] - v[b * 3 + 1], v[a * 3 + 2] - v[b * 3 + 2]);

// pair: the two letters; measure: vec -> scalar. Threshold + polarity are
// learned in createRefiner() from the class distributions.
const RULES = [
  {
    pair: ["D", "O"],
    name: "index–thumb gap",
    // In O the index curls to touch the thumb (~0.12); in D the index stands
    // up while the thumb rests on the middle finger (~0.49). ~90% separable.
    measure: (v) => d(v, 8, 4),
  },
];

// ---- threshold learning ----
// Brute-force the best single cut between letters a and b on measure(v):
// try every midpoint between sorted neighbouring values and keep the one that
// classifies the most originals (rotated copies excluded) correctly, in
// whichever polarity works better. sepAcc = that best accuracy, 0.5..1.
function learnThreshold(samples, measure, a, b) {
  const av = samples.filter((s) => s.label === a && !s.rot).map((s) => measure(s.v));
  const bv = samples.filter((s) => s.label === b && !s.rot).map((s) => measure(s.v));
  if (av.length < 5 || bv.length < 5) return null;

  const rows = [
    ...av.map((x) => [x, a]),
    ...bv.map((x) => [x, b]),
  ].sort((p, q) => p[0] - q[0]);

  let best = -1, threshold = 0, lowLabel = a, highLabel = b;
  for (let i = 0; i < rows.length - 1; i++) {
    const t = (rows[i][0] + rows[i + 1][0]) / 2;
    let correctIfLowIsA = 0;
    for (const [x, lab] of rows) {
      const pick = x < t ? a : b;
      if (pick === lab) correctIfLowIsA++;
    }
    const correct = Math.max(correctIfLowIsA, rows.length - correctIfLowIsA);
    if (correct > best) {
      best = correct;
      threshold = t;
      if (correctIfLowIsA >= rows.length - correctIfLowIsA) {
        lowLabel = a; highLabel = b;
      } else {
        lowLabel = b; highLabel = a;
      }
    }
  }
  return { threshold, lowLabel, highLabel, sepAcc: best / rows.length };
}

// ---- public factory ----

/**
 * Fit every RULE on the training data and return a refiner using the ones
 * that separate their pair well enough.
 * @param {{label: string, v: number[], rot?: number}[]} samples  training set
 * @param {{maxMargin?: number, minSeparation?: number}} [opts]
 *   maxMargin: only intervene when the kNN vote margin is ≤ this;
 *   minSeparation: a rule activates only if its sepAcc ≥ this (0..1)
 * @returns {{refine: (pred: object, vec: number[]) => object, rules: object[]}}
 */
export function createRefiner(samples, { maxMargin = 1, minSeparation = 0.75 } = {}) {
  const active = [];
  for (const r of RULES) {
    const fit = learnThreshold(samples, r.measure, r.pair[0], r.pair[1]);
    if (fit && fit.sepAcc >= minSeparation) {
      active.push({ ...r, ...fit });
    } else {
      console.info(
        `refine: skipping ${r.pair.join("↔")} (separation ${(fit?.sepAcc ?? 0).toFixed(2)} < ${minSeparation})`
      );
    }
  }

  function refine(pred, vec) {
    if (!pred || pred.runnerUp == null || pred.margin > maxMargin) return pred;
    const set = new Set([pred.label, pred.runnerUp]);
    for (const r of active) {
      if (set.has(r.pair[0]) && set.has(r.pair[1])) {
        const chosen = r.measure(vec) < r.threshold ? r.lowLabel : r.highLabel;
        if (chosen !== pred.label) {
          return { ...pred, label: chosen, refinedBy: r.name };
        }
        return pred;
      }
    }
    return pred;
  }

  return { refine, rules: active };
}
