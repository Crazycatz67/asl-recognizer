// =============================================================================
// js/heads.js — learned refinement heads for kNN's confusable letters (Engine)
// =============================================================================
// WHAT: Small learned "refinement heads" that clean up the pairs plain kNN
//   keeps mixing up (M↔N, and D↔O↔C). Each head is an ensemble of three tiny
//   one-hidden-layer MLPs (74 → 24 → K, ReLU hidden, softmax out) over
//   standardised features; the three nets' probabilities are summed and the
//   top class wins. A head is only consulted when kNN itself landed on a
//   label that head covers, so the fast kNN stays in charge of everything it
//   already does well.
//
// PIPELINE: webcam → MediaPipe → normalize → kNN → [heads.js] → stabilizer.
//   main.js: `lastPred.label = refiner.refine(vec, lastPred.label)`.
//
// RESULTS: weights are trained offline by tools/train-heads.html →
//   js/heads.json. Group-aware 20% held-out: kNN 95.9% → kNN + heads 97.1%
//   (M 85→92, N 84→96, D 87→97, O 90→97; nothing else regresses).
//
// PUBLIC API:
//   loadRefiner(url)     → Promise<refiner | null>   (null if missing/invalid)
//   createRefiner(data)  → refiner | null            (from parsed heads.json)
//     refiner.refine(vec, knnLabel) → label (knnLabel unchanged if no head covers it)
//     refiner.covers                → labels any head can decide
//
//   const refiner = await loadRefiner("js/heads.json");   // null if missing
//   label = refiner ? refiner.refine(vec, knnLabel) : knnLabel;
//
// GOTCHAS:
//   - Not the same thing as refine.js's createRefiner (a shelved rule-based
//     experiment with the same export name) — main.js imports this one.
//   - `vec` must be the same 74-value extended vector the heads were trained
//     on; a shorter vector is passed through untouched.
//   - Missing heads.json is not an error: the app just runs kNN-only.

/**
 * Fetch heads.json and build a refiner from it.
 * @param {string} url  URL of heads.json
 * @returns {Promise<ReturnType<typeof createRefiner>>} refiner, or null on any
 *   fetch/parse failure or an empty/invalid file
 */
export async function loadRefiner(url) {
  let data;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    return null;
  }
  return createRefiner(data);
}

/**
 * Build a refiner from parsed heads.json data.
 * @param {{dims: number, mean: number[], std: number[],
 *   heads: {labels: string[], hid: number,
 *           nets: {W1: number[], b1: number[], W2: number[], b2: number[]}[]}[]}} data
 *   W1 is dims×hid and W2 is hid×K, both flattened row-major.
 * @returns {{covers: string[], refine: (vec: ArrayLike<number>, knnLabel: string) => string} | null}
 */
export function createRefiner(data) {
  if (!data?.heads?.length || !Array.isArray(data.mean)) return null;
  const { dims, mean, std } = data;

  // label -> the head that decides it
  const byLabel = new Map();
  for (const h of data.heads) for (const L of h.labels) byLabel.set(L, h);

  const standardise = (v) => {
    const x = new Float64Array(dims);
    for (let i = 0; i < dims; i++) x[i] = (v[i] - mean[i]) / std[i];
    return x;
  };

  // One net's class probabilities for a standardised x: a plain forward pass,
  // hidden = ReLU(x·W1 + b1), out = softmax(hidden·W2 + b2). H = hidden width,
  // K = number of classes this head decides between.
  const netProbs = (net, x, H, K) => {
    const { W1, b1, W2, b2 } = net;
    const hvec = new Float64Array(H);
    for (let j = 0; j < H; j++) {
      let s = b1[j];
      for (let i = 0; i < dims; i++) s += x[i] * W1[i * H + j];
      hvec[j] = s > 0 ? s : 0;
    }
    const o = new Float64Array(K);
    let mx = -1e30;
    for (let k = 0; k < K; k++) {
      let s = b2[k];
      for (let j = 0; j < H; j++) s += hvec[j] * W2[j * K + k];
      o[k] = s;
      if (s > mx) mx = s;
    }
    let sum = 0;
    for (let k = 0; k < K; k++) { o[k] = Math.exp(o[k] - mx); sum += o[k]; }
    for (let k = 0; k < K; k++) o[k] /= sum;
    return o;
  };

  return {
    covers: [...byLabel.keys()],

    refine(vec, knnLabel) {
      const head = byLabel.get(knnLabel);
      if (!head || !vec || vec.length < dims) return knnLabel;
      // ensemble: sum each net's probabilities, take the argmax
      const x = standardise(vec);
      const K = head.labels.length;
      const acc = new Float64Array(K);
      for (const net of head.nets) {
        const o = netProbs(net, x, head.hid, K);
        for (let k = 0; k < K; k++) acc[k] += o[k];
      }
      let best = 0;
      for (let k = 1; k < K; k++) if (acc[k] > acc[best]) best = k;
      return head.labels[best];
    },
  };
}
