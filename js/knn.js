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
//                                  runnerUp, margin, near } | null
//     classifier.hasWithin(vec, r) → true if any sample is closer than r
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
//   classify() allocates no scratch per call. Three EXACT speedups (the k
//   nearest found are the same ones a plain scan finds — letter-report 2026-
//   09-25 measured kNN at ~95% of the per-frame recognition cost):
//   1. projection-sorted search: samples are stored sorted by their position
//      along the data's principal axis u. |u·q - u·x| <= |q - x| for a unit
//      u, so the scan starts at the query's own position and walks outward,
//      and stops as soon as the next sample's projection gap alone is
//      farther than the current k-th best — most of the set is never read.
//   2. partial distance search: each distance sum is abandoned the moment
//      it passes the k-th best, with the dimensions summed in decreasing
//      order of variance so the sum grows (and aborts) as early as possible.
//   3. hasWithin(vec, r): "is ANY sample closer than r?" — a single-hit
//      search with the bound fixed from the start. classifyEitherHand uses it
//      so the mirrored pass is nearly free when the mirror can't win (the
//      usual case), instead of a second full kNN.
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
  const classes = [...new Set(samples.map((s) => s.label))].sort();
  const kEff = Math.min(k, n);

  // ---- build: principal axis, variance-ordered dims, projection-sorted rows ----
  // Both are estimated on an evenly strided subset (<= ~4k rows) to keep
  // startup cheap on phones: ANY unit axis keeps the search exact, a better
  // one only makes it faster.
  const stride = Math.max(1, Math.floor(n / 4000));
  const est = samples.filter((_, i) => i % stride === 0);
  const m = est.length;
  // per-dimension mean + variance
  const mean = new Float64Array(DIMS), vari = new Float64Array(DIMS);
  for (const s of est) for (let j = 0; j < DIMS; j++) mean[j] += s.v[j];
  for (let j = 0; j < DIMS; j++) mean[j] /= m;
  for (const s of est) for (let j = 0; j < DIMS; j++) { const d = s.v[j] - mean[j]; vari[j] += d * d; }
  // dims summed in decreasing variance (partial distance search aborts sooner)
  const order = Int32Array.from({ length: DIMS }, (_, j) => j).sort((a, b) => vari[b] - vari[a]);
  // principal axis by power iteration on the covariance (deterministic start:
  // the per-dim spread, so it never starts orthogonal to the answer)
  let u = new Float64Array(DIMS);
  for (let j = 0; j < DIMS; j++) u[j] = Math.sqrt(vari[j] / m) + 1e-9;
  for (let it = 0; it < 12; it++) {
    const w = new Float64Array(DIMS);
    for (const s of est) {
      let p = 0;
      for (let j = 0; j < DIMS; j++) p += (s.v[j] - mean[j]) * u[j];
      for (let j = 0; j < DIMS; j++) w[j] += p * (s.v[j] - mean[j]);
    }
    let l = 0;
    for (let j = 0; j < DIMS; j++) l += w[j] * w[j];
    l = Math.sqrt(l) || 1;
    for (let j = 0; j < DIMS; j++) w[j] /= l;
    u = w;
  }
  // rows sorted by projection; stored with dims permuted to `order`. The
  // projection is taken from the same float32 values the distances use, so
  // the |u·(q-x)| <= |q-x| bound holds on exactly the stored numbers.
  const data = new Float32Array(n * DIMS);
  const proj0 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const v = samples[i].v;
    let p = 0;
    for (let j = 0; j < DIMS; j++) p += Math.fround(v[j]) * u[j];
    proj0[i] = p;
  }
  const rank = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => proj0[a] - proj0[b] || a - b);
  const proj = new Float64Array(n);
  const labels = new Array(n);
  const srcIdx = new Int32Array(n); // stored row -> original sample index (tie-break)
  for (let r = 0; r < n; r++) {
    const i = rank[r], v = samples[i].v, base = r * DIMS;
    for (let j = 0; j < DIMS; j++) data[base + j] = v[order[j]];
    proj[r] = proj0[i];
    labels[r] = samples[i].label;
    srcIdx[r] = i;
  }
  const uo = new Float64Array(DIMS); // u in stored dim order
  for (let j = 0; j < DIMS; j++) uo[j] = u[order[j]];

  // Reused scratch so classify() allocates nothing per call.
  const q = new Float64Array(DIMS);
  const nearIdx = new Int32Array(kEff);
  const nearDist = new Float64Array(kEff);
  // the float slack on the projection bound (rounding in two dot products)
  const EPS = 1e-9;

  // query -> q (stored dim order); returns its projection, or NaN if invalid
  function load(vec) {
    if (!vec || vec.length !== DIMS) return NaN;
    let p = 0;
    for (let j = 0; j < DIMS; j++) {
      const x = vec[order[j]];
      // a NaN coordinate makes every distance NaN, and NaN > REJECT_DIST is
      // false — so it would pass the non-letter gate as a confident letter
      // (LAB-038). No reading beats a made-up one.
      if (!Number.isFinite(x)) return NaN;
      q[j] = x;
      p += x * uo[j];
    }
    return p;
  }
  // first stored row whose projection is >= p
  function startAt(p) {
    let lo = 0, hi = n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (proj[m] < p) lo = m + 1; else hi = m; }
    return lo;
  }
  // squared distance from q to stored row r, abandoned (returns >= bound)
  // once it passes bound
  function dist2(r, bound) {
    const base = r * DIMS;
    let d = 0;
    for (let j = 0; j < DIMS; j++) {
      const diff = q[j] - data[base + j];
      d += diff * diff;
      if (d >= bound) return d;
    }
    return d;
  }

  function classify(vec) {
    const p = load(vec);
    if (Number.isNaN(p)) return null;

    // ---- 1. find the k nearest training vectors ----
    // Walk outward from the query's projection, always taking the side whose
    // next row is closer in projection; once that gap alone (squared) is past
    // the k-th best, no remaining row can enter the top k.
    let filled = 0;
    let worst = Infinity;
    let lo = startAt(p) - 1, hi = lo + 1;
    while (lo >= 0 || hi < n) {
      const gl = lo >= 0 ? p - proj[lo] : Infinity;
      const gh = hi < n ? proj[hi] - p : Infinity;
      const r = gl <= gh ? lo-- : hi++;
      const g = gl <= gh ? gl : gh;
      if (filled === kEff && g * g > worst + EPS) break;
      const d = dist2(r, worst);
      if (filled === kEff && d >= worst) continue; // pruned — can't be in the top k
      // insertion sort; equal distances keep the lower ORIGINAL sample index
      // first (what a plain in-order scan would keep)
      let s = filled < kEff ? filled++ : kEff - 1;
      while (s > 0 && (nearDist[s - 1] > d || (nearDist[s - 1] === d && srcIdx[nearIdx[s - 1]] > srcIdx[r]))) {
        nearDist[s] = nearDist[s - 1];
        nearIdx[s] = nearIdx[s - 1];
        s--;
      }
      nearDist[s] = d;
      nearIdx[s] = r;
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
      near: [...tally.keys()], // every label among the k neighbours, nearest first
    };
  }

  /**
   * Is any training vector strictly closer to `vec` than `radius`?  Same
   * answer as `classify(vec).distance < radius`, at a fraction of the cost:
   * the bound is known up front, so the walk stops at the first hit or as
   * soon as the projection gap passes the radius.
   */
  function hasWithin(vec, radius) {
    const p = load(vec);
    if (Number.isNaN(p) || !(radius > 0)) return false;
    const bound = radius * radius;
    let lo = startAt(p) - 1, hi = lo + 1;
    while (lo >= 0 || hi < n) {
      const gl = lo >= 0 ? p - proj[lo] : Infinity;
      const gh = hi < n ? proj[hi] - p : Infinity;
      const r = gl <= gh ? lo-- : hi++;
      const g = gl <= gh ? gl : gh;
      if (g * g > bound + EPS) return false;
      if (Math.sqrt(dist2(r, bound)) < radius) return true;
    }
    return false;
  }

  return { classify, hasWithin, classes, size: n, dims: DIMS };
}

/**
 * Classify a hand whichever way round it came in. MediaPipe sometimes reports
 * the wrong handedness, so the vector reaches the classifier mirrored — and
 * chirality-sensitive letters (B, G, K, T, X) then read as something else
 * entirely (QA 2026-09-23, blocked 5-fold: 93.7% correctly mirrored vs 52.2%
 * with handedness wrong). Classify both the vector and its mirror and keep the
 * mirror only when it's clearly closer to the data (nearest distance < ratio x
 * the original's): measured 51% -> 92.6% under wrong handedness, no loss on
 * clean input. The mirror only needs a full kNN when it wins: hasWithin()
 * answers "does it win?" first (same decision, a fraction of the work), so
 * the usual right-way-round frame costs ~one classify, not two.
 * @param {{classify: Function, hasWithin?: Function}} clf  a createClassifier() result
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
  if (clf.hasWithin && !clf.hasWithin(mv, a.distance * ratio)) return { pred: a, vec, mirrored: false };
  const b = clf.classify(mv);
  if (b && b.distance < a.distance * ratio) return { pred: b, vec: mv, mirrored: true };
  return { pred: a, vec, mirrored: false };
}


/**
 * The recogniser's reading of one hand — the ONE place main.js (per frame +
 * the two-hand path) and the offline lab (tools/lab/) turn a normalized
 * vector into a letter, so they can't drift apart:
 *   either-hand kNN -> non-letter rejection (nearest training hand farther
 *   than rejectDist) -> learned heads (M/N, D/O/C) on the winning orientation.
 * @param {{classify: Function, hasWithin?: Function}} clf
 * @param {number[]} vec  normalized hand vector
 * @param {{mirror: (v: number[]) => number[], refiner?: {refine: Function}|null,
 *          rejectDist?: number}} opts
 * @returns {{pred: object|null, guess: string|null, near: string[], vec: number[], mirrored: boolean}}
 *   pred  classify()'s result with the heads' label, or null when the hand
 *         isn't a letter (too far from every real one) or unreadable;
 *   guess the recogniser's best label EVEN when rejected (kNN + heads) —
 *         low-trust, only for "whose neighbourhood is this hand in?";
 *   near  every label among the k nearest training hands (+ guess).
 */
export function recognise(clf, vec, { mirror, refiner = null, rejectDist = Infinity }) {
  const e = classifyEitherHand(clf, vec, mirror);
  if (!e.pred) return { pred: null, guess: null, near: [], vec, mirrored: false };
  const pred = e.pred;
  const guess = refiner ? refiner.refine(e.vec, pred.label) : pred.label;
  const near = pred.near.includes(guess) ? pred.near : [...pred.near, guess];
  if (pred.distance > rejectDist) return { pred: null, guess, near, vec: e.vec, mirrored: e.mirrored };
  if (guess !== pred.label) { pred.label = guess; pred.refined = true; }
  return { pred, guess, near, vec: e.vec, mirrored: e.mirrored };
}
