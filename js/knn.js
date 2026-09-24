// =============================================================================
// js/knn.js — k-nearest-neighbour letter classifier (Engine, DOM-free)
// =============================================================================
// WHAT: The core static-letter recogniser. There is no training step: it
//   stores every labelled hand vector and, per query, finds the k closest by
//   Euclidean distance and returns the majority label plus how decisive the
//   vote was. Chosen over a neural net because it's tiny, instant to "train"
//   (just load the data), and easy to inspect when it gets a letter wrong.
//
// PIPELINE: webcam → MediaPipe → normalize.js → [knn.js] → heads.js →
//   stabilizer.js → overlay.js. main.js calls classify() once per frame.
//
// PUBLIC API:
//   createClassifier(samples, { k }) → classifier
//     classifier.classify(vec) → { label, votes, confidence, distance,
//                                  runnerUp, margin } | null
//     classifier.classes       → sorted unique labels
//     classifier.size / .dims  → number of stored samples / vector length
//
// INPUTS / OUTPUTS:
//   samples: [{ label, v }] where v is a normalized hand vector from
//     normalize.js — 63 values (21 landmarks × x,y,z, wrist-centred and
//     scaled to hand size) or 74 with the 11 engineered shape features.
//     The length is read from the data, so either works unchanged.
//   confidence = votes / k (0..1; k clamped to the sample count); distance = Euclidean distance to the single
//     nearest neighbour (same normalized units as the vector); margin = vote
//     gap between winner and runner-up.
//
// PERFORMANCE: training vectors are packed into one contiguous Float32Array
//   so the hot loop stays cache-friendly at tens of thousands of samples, and
//   classify() allocates no scratch per call (see "partial distance search").
//
// GOTCHAS: classify() returns null for a missing vector or one whose length
//   doesn't match the training data (e.g. extended features toggled on only
//   one side — config.js USE_EXTENDED_FEATURES must match the dataset).

/**
 * Build a kNN classifier over labelled hand vectors.
 * @param {{label: string, v: ArrayLike<number>}[]} samples  non-empty training set
 * @param {{k?: number}} [opts]  k = neighbours to vote (clamped to samples.length)
 * @returns {{classify: (vec: ArrayLike<number>) => (object|null),
 *            classes: string[], size: number, dims: number}}
 */
export function createClassifier(samples, { k = 5 } = {}) {
  const n = samples.length;
  if (n === 0) throw new Error("createClassifier: no samples");
  const DIMS = samples[0].v.length;
  const data = new Float32Array(n * DIMS);
  const labels = new Array(n);

  for (let i = 0; i < n; i++) {
    labels[i] = samples[i].label;
    data.set(samples[i].v, i * DIMS);
  }
  const classes = [...new Set(labels)].sort();
  const kEff = Math.min(k, n);

  // Reused scratch so classify() allocates nothing per call.
  const nearIdx = new Int32Array(kEff);
  const nearDist = new Float64Array(kEff);

  function classify(vec) {
    if (!vec || vec.length !== DIMS) return null;

    // ---- 1. find the k nearest training vectors ----
    // Maintain the k smallest squared distances seen so far (insertion sort,
    // k is tiny). Once we have k candidates, most training vectors are far
    // away, so we abandon the per-vector distance sum the moment it exceeds
    // the current k-th best ("partial distance search") — typically a 2-4x
    // speedup over summing all DIMS every time.
    let filled = 0;
    let worst = Infinity;
    for (let i = 0; i < n; i++) {
      const base = i * DIMS;
      let d = 0;

      if (filled === kEff) {
        let j = 0;
        for (; j < DIMS; j++) {
          const diff = vec[j] - data[base + j];
          d += diff * diff;
          if (d >= worst) break;
        }
        if (j < DIMS) continue; // pruned — can't be in the top k
      } else {
        for (let j = 0; j < DIMS; j++) {
          const diff = vec[j] - data[base + j];
          d += diff * diff;
        }
      }

      let p = filled < kEff ? filled++ : kEff - 1;
      while (p > 0 && nearDist[p - 1] > d) {
        nearDist[p] = nearDist[p - 1];
        nearIdx[p] = nearIdx[p - 1];
        p--;
      }
      nearDist[p] = d;
      nearIdx[p] = i;
      if (filled === kEff) worst = nearDist[kEff - 1];
    }

    // ---- 2. majority vote among the k neighbours ----
    // Ties go to the label whose nearest member is closest: nearIdx is sorted
    // nearest-first, the Map keeps that insertion order, and the strict `>`
    // below never lets a later (farther) label displace an equal count.
    const tally = new Map();
    for (let i = 0; i < filled; i++) {
      const lab = labels[nearIdx[i]];
      tally.set(lab, (tally.get(lab) || 0) + 1);
    }
    // top and runner-up by vote count
    let best = null, bestVotes = -1;
    let runnerUp = null, runnerVotes = -1;
    for (const [lab, v] of tally) {
      if (v > bestVotes) {
        runnerUp = best; runnerVotes = bestVotes;
        best = lab; bestVotes = v;
      } else if (v > runnerVotes) {
        runnerUp = lab; runnerVotes = v;
      }
    }

    return {
      label: best,
      votes: bestVotes,
      confidence: bestVotes / filled,
      distance: Math.sqrt(nearDist[0]),
      runnerUp, // 2nd most-voted label, or null
      margin: bestVotes - Math.max(0, runnerVotes), // vote gap to the runner-up
    };
  }

  return { classify, classes, size: n, dims: DIMS };
}

/**
 * Classify a hand whichever way round it came in. MediaPipe sometimes reports
 * the wrong handedness, so the vector reaches the classifier mirrored — and
 * chirality-sensitive letters (B, G, K, T, X) then read as something else
 * entirely (QA 2026-09-23, blocked 5-fold: 93.7% correctly mirrored vs 52.2%
 * with handedness wrong). Classify both the vector and its mirror and keep the
 * mirror only when it's clearly closer to the data (nearest distance < ratio x
 * the original's): measured 51% -> 92.6% under wrong handedness, no loss on
 * clean input. Costs one extra classify (~1 ms).
 * @param {{classify: Function}} clf  a createClassifier() result
 * @param {number[]} vec  normalized landmark vector
 * @param {(v: number[]) => number[]} mirror  e.g. normalize.js mirrorVector
 * @param {number} [ratio=0.9]
 * @returns {{pred: object|null, vec: number[], mirrored: boolean}}  pred as
 *   classify() returns it; vec = the orientation that won (feed it to heads)
 */
export function classifyEitherHand(clf, vec, mirror, ratio = 0.9) {
  const a = clf.classify(vec);
  if (!a) return { pred: null, vec, mirrored: false };
  const mv = mirror(vec);
  const b = clf.classify(mv);
  if (b && b.distance < a.distance * ratio) return { pred: b, vec: mv, mirrored: true };
  return { pred: a, vec, mirrored: false };
}

