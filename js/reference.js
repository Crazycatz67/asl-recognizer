// Practice-mode helpers, UI-free.
//
//   const ref = buildReference(samples, LETTERS);
//   ref.centroid("N")        -> number[vlen]  (class mean)
//   ref.score(liveVec, "N")  -> { dist, score, bucket }   bucket: off | close | correct
//   ref.hint(liveVec, "N")   -> "Curl your ring finger" | "Looks right — hold it" | ...
//   ref.tolerance("N")       -> per-joint normalized error that counts as "on target"
//
// score() and the bands are calibrated per letter from that letter's OWN
// training spread: "correct" means your hand matches the target about as well
// as a typical training example does — not "closer to the mean than 99% of
// them", which is what the old fixed threshold demanded (and why it never hit).

import { drawSkeleton, vectorToPixels } from "./skeleton.js";

const COORD_DIMS = 63;

// engineered-feature indices (see normalize.js handFeatures)
const F_CURL = 63;   // 63..67  thumb,index,middle,ring,pinky : tip->own-MCP distance
const F_GAP = 68;    // 68..71  adjacent fingertip gaps
const F_THUMB = 72;  // thumb-tip -> index-MCP distance
const FINGERS = ["thumb", "index finger", "middle finger", "ring finger", "pinky"];
const GAP_PAIRS = [
  ["thumb", "index"],
  ["index", "middle"],
  ["middle", "ring"],
  ["ring", "pinky"],
];

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

const coordDist = (a, b) => {
  let d = 0;
  for (let i = 0; i < COORD_DIMS; i++) {
    const q = a[i] - b[i];
    d += q * q;
  }
  return Math.sqrt(d);
};
const percentile = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;

export function buildReference(samples, letters) {
  const keep = new Set(letters);
  const sums = new Map(); // label -> { acc, n }
  const rows = new Map(); // label -> [vec, ...] (originals only)

  for (const s of samples) {
    if (!keep.has(s.label) || s.rot) continue;
    let e = sums.get(s.label);
    if (!e) {
      e = { acc: new Float64Array(s.v.length), n: 0 };
      sums.set(s.label, e);
      rows.set(s.label, []);
    }
    for (let i = 0; i < s.v.length; i++) e.acc[i] += s.v[i];
    e.n++;
    rows.get(s.label).push(s.v);
  }

  const centroids = new Map();
  for (const [label, e] of sums) centroids.set(label, Array.from(e.acc, (x) => x / e.n));

  // per-letter calibration: p50 / p85 of that letter's own distances to its
  // centroid. p50 -> "as good as a typical example" (correct); p85 -> "close".
  const bands = new Map();
  for (const [label, vecs] of rows) {
    const c = centroids.get(label);
    const ds = vecs.map((v) => coordDist(v, c)).sort((a, b) => a - b);
    bands.set(label, { p50: percentile(ds, 0.5) || 0.15, p85: percentile(ds, 0.85) || 0.3 });
  }

  const scoreFor = (d, b) => {
    // piecewise so "correct" is reachable: d<=p50 -> 0.85..1, <=p85 -> 0.6..0.85
    if (d <= b.p50) return 0.85 + 0.15 * (1 - d / (b.p50 || 1e-6));
    if (d <= b.p85) return 0.6 + 0.25 * (1 - (d - b.p50) / ((b.p85 - b.p50) || 1e-6));
    return Math.max(0, 0.6 * (1 - (d - b.p85) / (2 * (b.p85 || 1e-6))));
  };

  return {
    letters: [...centroids.keys()].sort(),

    centroid(label) {
      return centroids.get(label) || null;
    },

    // per-joint normalized error that reads as "locked on" for the guide
    // colours. Derived from the letter's spread but clamped to a visually
    // meaningful range (a fingertip within ~4-12% of hand radius = on target).
    tolerance(label) {
      const b = bands.get(label);
      const raw = b ? b.p50 / Math.sqrt(21) : 0.06;
      return Math.max(0.04, Math.min(0.12, raw));
    },

    score(liveVec, label) {
      const c = centroids.get(label);
      const b = bands.get(label);
      if (!c || !b || !liveVec) return { dist: Infinity, score: 0, bucket: "off" };
      const d = coordDist(liveVec, c);
      const s = scoreFor(d, b);
      const bucket = s >= 0.85 ? "correct" : s >= 0.6 ? "close" : "off";
      return { dist: d, score: s, bucket };
    },

    // Which one thing to fix, in plain words. Uses the engineered features
    // (curl / gaps / thumb) — rotation-independent, so the advice is stable.
    hint(liveVec, label) {
      const c = centroids.get(label);
      if (!c || !liveVec || liveVec.length <= F_THUMB) return "";

      const cand = [];
      for (let f = 0; f < 5; f++) {
        const dev = liveVec[F_CURL + f] - c[F_CURL + f];
        if (Math.abs(dev) > 0.11) {
          cand.push({
            mag: Math.abs(dev),
            text: dev > 0 ? `Curl your ${FINGERS[f]} in more` : `Straighten your ${FINGERS[f]}`,
          });
        }
      }
      for (let g = 0; g < 4; g++) {
        const dev = liveVec[F_GAP + g] - c[F_GAP + g];
        if (Math.abs(dev) > 0.13) {
          const [a, bb] = GAP_PAIRS[g];
          cand.push({
            mag: Math.abs(dev),
            text: dev > 0 ? `Bring your ${a} and ${bb} closer` : `Spread your ${a} and ${bb} apart`,
          });
        }
      }
      const thumbDev = liveVec[F_THUMB] - c[F_THUMB];
      if (Math.abs(thumbDev) > 0.12) {
        cand.push({
          mag: Math.abs(thumbDev),
          text: thumbDev > 0 ? "Tuck your thumb in tighter" : "Move your thumb out a bit",
        });
      }

      if (!cand.length) return "Looks right — hold it steady";
      cand.sort((x, y) => y.mag - x.mag);
      return cand[0].text;
    },
  };
}
