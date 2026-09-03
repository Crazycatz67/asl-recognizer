// k-nearest-neighbours over 63-D normalized landmark vectors. Plain JS, no
// training step: it just stores the labelled vectors and, per query, finds
// the k closest by Euclidean distance and returns the majority label.
//
//   const clf = createClassifier(samples, { k: 5 });
//   clf.classify(vec63) -> { label, confidence, votes, distance } | null
//
// Training vectors are packed into one contiguous Float32Array so the
// hot loop stays cache-friendly even at tens of thousands of samples.
//
// Vector length is taken from the data, so this works for the raw 63-value
// vectors or the extended 74-value ones without changing anything here.

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

    // majority vote among the k neighbours; ties broken by the closer sum
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
