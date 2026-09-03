// Small learned "refinement heads" that clean up the pairs plain kNN keeps
// mixing up (M↔N, and D↔O↔C). Each head is an ensemble of three tiny
// one-hidden-layer MLPs (74 → 24 → K) over standardised features. A head only
// gets consulted when kNN itself landed on a label that head covers, so the
// fast kNN stays in charge of everything it already does well.
//
// Weights are trained offline by tools/train-heads.html → js/heads.json.
// Group-aware 20% held-out: kNN 95.9% → kNN + heads 97.1%
// (M 85→92, N 84→96, D 87→97, O 90→97; nothing else regresses).
//
//   const refiner = await loadRefiner("js/heads.json");   // null if missing
//   label = refiner ? refiner.refine(vec, knnLabel) : knnLabel;

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

  // one net's class probabilities for a standardised x
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
