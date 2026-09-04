// J and Z are the only fingerspelling letters that aren't a still handshape —
// J is the "I" hand tracing a hook, Z is the index finger drawing a zigzag in
// the air. This matcher watches a ~1.4 s window of the tracked fingertip's path
// (normalised to hand size, so distance-invariant) and reports when it traced
// the right stroke.
//
//   const mm = createMotionMatcher();
//   mm.push(landmarks, now);           // every frame; pass null on a lost hand
//   mm.match(now) -> "J" | "Z" | null  // fires once, then arms a cooldown
//
// The stroke templates below (STROKE) are also used to animate the demo.

const WINDOW_MS = 1600;
const COOLDOWN_MS = 900; // after a hit, don't re-fire until the hand resets
const MIN_FRAMES = 5;

// Ideal fingertip path for the panel demo — normalised (wrist ~origin, +y down,
// units ≈ hand span). Selfie-mirrored view: +x is toward the pinky side here.
export const STROKE = {
  J: [
    [0.32, -0.95],
    [0.34, -0.35],
    [0.30, 0.30],
    [0.10, 0.55],
    [-0.28, 0.48],
    [-0.42, 0.18],
  ],
  Z: [
    [-0.5, -0.9],
    [0.5, -0.9],
    [-0.45, 0.15],
    [0.5, 0.15],
  ],
};
export const MOTION_START = { J: "pinky", Z: "index" }; // which finger is extended

const TIP = { pinky: 20, index: 8 };
const MCP = { pinky: 17, index: 5 };

function spanOf(lm) {
  // wrist -> mean of the four finger MCPs; steady and ~half the hand
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of [5, 9, 13, 17]) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}
// finger roughly extended: tip is far from its MCP relative to hand span
function extended(lm, finger, span) {
  const t = lm[TIP[finger]], m = lm[MCP[finger]];
  return Math.hypot(t.x - m.x, t.y - m.y) / span > 0.72;
}

export function createMotionMatcher() {
  let buf = [];
  let coolUntil = 0;

  // jitter-immune: farthest the tip ever got from where it started
  const maxExcursion = (pts) =>
    Math.max(...pts.map((q) => Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1])));
  const range = (pts, ax) =>
    Math.max(...pts.map((q) => q[ax])) - Math.min(...pts.map((q) => q[ax]));

  const resample = (pts, n) => {
    // arc-length resample a polyline to n points
    const seg = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d);
      total += d;
    }
    if (total < 1e-6) return pts.map(() => pts[0].slice());
    const out = [pts[0].slice()];
    let acc = 0, i = 1;
    for (let k = 1; k < n; k++) {
      const target = (k / (n - 1)) * total;
      while (i < pts.length && acc + seg[i - 1] < target) { acc += seg[i - 1]; i++; }
      const s = seg[i - 1] || 1e-6;
      const f = Math.max(0, Math.min(1, (target - acc) / s));
      out.push([
        pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]),
        pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1]),
      ]);
    }
    return out;
  };

  function computeMetrics() {
    if (buf.length < 3) return null;
    const p = buf.map((f) => f.pinky);
    const ix = buf.map((f) => f.index);
    const pDrop = Math.max(...p.map((q) => q[1])) - p[0][1]; // how far DOWN it got
    // real back-and-forth on a resampled index path (big step -> ignore jitter)
    const iPath = resample(ix, 12);
    let iRev = 0, lastDir = 0;
    for (let i = 1; i < iPath.length; i++) {
      const dx = iPath[i][0] - iPath[i - 1][0];
      const d = dx > 0.12 ? 1 : dx < -0.12 ? -1 : 0;
      if (d && lastDir && d !== lastDir) iRev++;
      if (d) lastDir = d;
    }
    return {
      frames: buf.length,
      ms: Math.round(buf.at(-1).t - buf[0].t),
      pinkyUp: +(buf.filter((f) => f.pinkyUp).length / buf.length).toFixed(2),
      indexUp: +(buf.filter((f) => f.indexUp).length / buf.length).toFixed(2),
      pinkyMove: +maxExcursion(p).toFixed(2), // farthest the pinky tip travelled
      pinkyDrop: +pDrop.toFixed(2),
      indexMove: +maxExcursion(ix).toFixed(2),
      indexX: +range(ix, 0).toFixed(2), // horizontal extent of the index tip
      rev: iRev,
    };
  }

  return {
    reset() {
      buf = [];
    },

    push(landmarks, now) {
      if (!landmarks || landmarks.length < 21) {
        if (now - (buf.at(-1)?.t ?? 0) > 250) buf = [];
        return;
      }
      const w = landmarks[0];
      const span = spanOf(landmarks);
      buf.push({
        t: now,
        pinky: [(landmarks[20].x - w.x) / span, (landmarks[20].y - w.y) / span],
        index: [(landmarks[8].x - w.x) / span, (landmarks[8].y - w.y) / span],
        pinkyUp: extended(landmarks, "pinky", span),
        indexUp: extended(landmarks, "index", span),
      });
      while (buf.length && now - buf[0].t > WINDOW_MS) buf.shift();
    },

    // live metrics for the current window — used to tune, and shown on screen
    metrics: computeMetrics,

    // returns "J" | "Z" | null. Deliberately forgiving — a rough deliberate
    // finger swoosh should count; the extended finger picks J vs Z.
    match(now) {
      if (now < coolUntil || buf.length < MIN_FRAMES) return null;
      if (now - buf[0].t < 260) return null;
      const mtr = computeMetrics();
      if (!mtr) return null;
      const pinkyMoved = mtr.pinkyMove > mtr.indexMove;

      // --- J: the pinky tip travels a real distance AND ends up notably lower.
      // A held I-hand has pinkyMove ~0.3 (jitter) and pinkyDrop ~0.2, so the
      // 1.2 / 0.7 bars only clear on an actual swoosh.
      if (
        (mtr.pinkyUp >= 0.3 || pinkyMoved) &&
        mtr.pinkyMove > 1.2 &&
        mtr.pinkyDrop > 0.7
      ) {
        coolUntil = now + COOLDOWN_MS;
        return "J";
      }
      // --- Z: the index tip sweeps a wide horizontal range with a real
      // back-and-forth (>=1 reversal on the resampled path).
      if (
        (mtr.indexUp >= 0.3 || !pinkyMoved) &&
        mtr.indexMove > 1.2 &&
        mtr.indexX > 1.6 &&
        mtr.rev >= 1
      ) {
        coolUntil = now + COOLDOWN_MS;
        return "Z";
      }
      return null;
    },
  };
}
