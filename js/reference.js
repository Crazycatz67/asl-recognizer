// Practice-mode helpers, UI-free. Given the training samples it builds a
// "canonical" vector per letter (the class mean) and scores how close a live
// vector is to a chosen target letter.
//
//   const ref = buildReference(samples, LETTERS);
//   ref.centroid("N")            -> number[vlen]  (mean of all N samples)
//   ref.score(liveVec, "N")      -> { dist, score, bucket }  bucket: off|close|correct
//
// score() uses only the first 63 values (the raw coordinates) so the glow
// tracks visible hand shape, not the engineered feature block.

import { drawSkeleton, vectorToPixels } from "./skeleton.js";

const COORD_DIMS = 63;

// Render a letter's canonical hand shape (its class-mean vector) as a clean,
// large, upright diagram in a panel canvas — the "make this" reference.
export function drawCanonical(canvasEl, vec) {
  const ctx = canvasEl.getContext("2d");
  const w = canvasEl.width;
  const h = canvasEl.height;
  ctx.clearRect(0, 0, w, h);
  if (!vec) return;
  const px = vectorToPixels(vec, w, h, { pad: 0.16 });
  drawSkeleton(ctx, px, {
    stroke: "#e2e8f0",
    joint: "#38bdf8",
    lineWidth: Math.max(4, w * 0.02),
    jointRadius: Math.max(4, w * 0.018),
  });
}

export function buildReference(samples, letters, { closeAt = 0.62, correctAt = 0.82 } = {}) {
  const keep = new Set(letters);
  const sums = new Map(); // label -> { acc: Float64Array, n }

  for (const s of samples) {
    if (!keep.has(s.label)) continue;
    if (s.rot) continue; // skip rotation-augmented copies — the ghost shows the upright shape
    let e = sums.get(s.label);
    if (!e) {
      e = { acc: new Float64Array(s.v.length), n: 0 };
      sums.set(s.label, e);
    }
    for (let i = 0; i < s.v.length; i++) e.acc[i] += s.v[i];
    e.n++;
  }

  const centroids = new Map();
  // typical spread of a class around its own centroid, for turning a raw
  // distance into a 0..1 "how close" score with a sane scale per letter
  const spreads = new Map();

  for (const [label, e] of sums) {
    const c = Array.from(e.acc, (x) => x / e.n);
    centroids.set(label, c);
  }
  for (const s of samples) {
    if (!keep.has(s.label) || s.rot) continue;
    const c = centroids.get(s.label);
    let d = 0;
    for (let i = 0; i < COORD_DIMS; i++) {
      const diff = s.v[i] - c[i];
      d += diff * diff;
    }
    d = Math.sqrt(d);
    const cur = spreads.get(s.label) || { sum: 0, n: 0 };
    cur.sum += d;
    cur.n++;
    spreads.set(s.label, cur);
  }
  const meanSpread = new Map(
    [...spreads].map(([k, v]) => [k, v.sum / v.n])
  );

  return {
    letters: [...centroids.keys()].sort(),

    centroid(label) {
      return centroids.get(label) || null;
    },

    // 0 = far, 1 = right on the class mean. score >= correctAt and the live
    // prediction agreeing == "correct".
    score(liveVec, label) {
      const c = centroids.get(label);
      if (!c || !liveVec) return { dist: Infinity, score: 0, bucket: "off" };
      let d = 0;
      for (let i = 0; i < COORD_DIMS; i++) {
        const diff = liveVec[i] - c[i];
        d += diff * diff;
      }
      d = Math.sqrt(d);
      // ~1 when d is within the class's own average spread, decaying after
      const s = Math.max(0, 1 - d / (3 * (meanSpread.get(label) || 0.5)));
      const bucket = s >= correctAt ? "correct" : s >= closeAt ? "close" : "off";
      return { dist: d, score: s, bucket };
    },
  };
}
