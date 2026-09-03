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

// Distance over the 21 landmark X/Y only — deliberately NOT z.
//
// MediaPipe's z is a single-image depth guess: noisy, and its scale differs
// between the training photos and a live webcam. Including it made the match
// meter stall around "close" even when the on-screen skeleton was fully green
// and the hint said "looks right" — the user was matching everything they can
// see and control, but an invisible z term they can't fix held the score down.
// The guide overlay, the hints, and the reference photo are all 2-D, so the
// meter is too. With this, "every joint green" (each within tolerance derived
// from p50) implies total distance <= p50 implies the "correct" bucket.
const coordDist = (a, b) => {
  let d = 0;
  for (let j = 0; j < 21; j++) {
    const dx = a[j * 3] - b[j * 3];
    const dy = a[j * 3 + 1] - b[j * 3 + 1];
    d += dx * dx + dy * dy;
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

  // the per-joint "locked on" tolerance — same value the guide overlay uses to
  // turn a segment green. shared so score() and the guide never disagree.
  const tolFor = (b) =>
    Math.max(0.04, Math.min(0.12, (b ? b.p50 : 0.06 * Math.sqrt(21)) / Math.sqrt(21)));

  // worst single-joint x/y error vs the centroid, in the normalized frame
  const worstJoint = (liveVec, c) => {
    let w = 0;
    for (let j = 0; j < 21; j++) {
      const e = Math.hypot(liveVec[j * 3] - c[j * 3], liveVec[j * 3 + 1] - c[j * 3 + 1]);
      if (e > w) w = e;
    }
    return w;
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
      return tolFor(bands.get(label));
    },

    score(liveVec, label) {
      const c = centroids.get(label);
      const b = bands.get(label);
      if (!c || !b || !liveVec)
        return { dist: Infinity, score: 0, bucket: "off", matched: false, worst: Infinity };
      const d = coordDist(liveVec, c);
      const s = scoreFor(d, b);
      // "correct" needs BOTH: the aggregate is good AND no single joint is still
      // off (i.e. the skeleton is fully green, not "close on average while a
      // finger's out"). Otherwise the reward can fire on a near-miss.
      const worst = worstJoint(liveVec, c);
      const matched = worst <= tolFor(b);
      let bucket = s >= 0.85 ? "correct" : s >= 0.6 ? "close" : "off";
      if (bucket === "correct" && !matched) bucket = "close";
      return { dist: d, score: s, bucket, matched, worst };
    },

    // Where on the (mirrored) view the shape is wrong: 0..1 per screen zone.
    // Lets the ambient background react in the direction of the problem —
    // fingers off -> the top warms; thumb side off -> that side warms.
    regionErrors(liveVec, label) {
      const c = centroids.get(label);
      if (!c || !liveVec) return { top: 0, left: 0, right: 0 };
      const zones = { top: [0, 0], left: [0, 0], right: [0, 0] };
      for (let j = 0; j < 21; j++) {
        const dx = liveVec[j * 3] - c[j * 3];
        const dy = liveVec[j * 3 + 1] - c[j * 3 + 1];
        const e = Math.hypot(dx, dy); // x/y only — matches coordDist / the guide
        const ty = c[j * 3 + 1]; // target y (fingers point up = negative)
        const sx = -c[j * 3]; // mirrored screen x
        if (ty < -0.12) { zones.top[0] += e; zones.top[1]++; }
        if (sx < -0.12) { zones.left[0] += e; zones.left[1]++; }
        if (sx > 0.12) { zones.right[0] += e; zones.right[1]++; }
      }
      const tol = tolFor(bands.get(label));
      const norm = (z) => (z[1] ? Math.min(1, z[0] / z[1] / (tol * 2.2)) : 0);
      return { top: norm(zones.top), left: norm(zones.left), right: norm(zones.right) };
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
