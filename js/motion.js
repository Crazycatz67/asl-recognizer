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

const WINDOW_MS = 1400;
const COOLDOWN_MS = 900; // after a hit, don't re-fire until the hand resets
const MIN_FRAMES = 8;

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
  return Math.hypot(t.x - m.x, t.y - m.y) / span > 0.9;
}

export function createMotionMatcher() {
  let buf = [];
  let coolUntil = 0;

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

    // returns "J" | "Z" | null
    match(now) {
      if (now < coolUntil || buf.length < MIN_FRAMES) return null;
      const span = now - buf[0].t;
      if (span < 350) return null; // too quick to be a stroke

      // --- J: "I" hand, pinky tip goes DOWN then HOOKS to the side ---
      const pinkyMostly = buf.filter((f) => f.pinkyUp).length / buf.length > 0.6;
      if (pinkyMostly) {
        const p = buf.map((f) => f.pinky);
        const y0 = p[0][1];
        let lowIdx = 0;
        for (let i = 1; i < p.length; i++) if (p[i][1] > p[lowIdx][1]) lowIdx = i;
        const drop = p[lowIdx][1] - y0; // + = moved down
        const hook = Math.abs(p.at(-1)[0] - p[lowIdx][0]); // sideways travel after the low point
        if (drop > 0.5 && lowIdx > 1 && hook > 0.28) {
          coolUntil = now + COOLDOWN_MS;
          return "J";
        }
      }

      // --- Z: index up, index tip zigzags (>=2 x-direction reversals) ---
      const indexMostly = buf.filter((f) => f.indexUp).length / buf.length > 0.6;
      if (indexMostly) {
        const path = resample(buf.map((f) => f.index), 16);
        let reversals = 0, travel = 0, lastDir = 0;
        for (let i = 1; i < path.length; i++) {
          const dx = path[i][0] - path[i - 1][0];
          travel += Math.abs(dx);
          const dir = dx > 0.02 ? 1 : dx < -0.02 ? -1 : 0;
          if (dir && lastDir && dir !== lastDir) reversals++;
          if (dir) lastDir = dir;
        }
        const yTravel = Math.abs(path.at(-1)[1] - path[0][1]);
        if (reversals >= 2 && travel > 1.4 && travel > yTravel) {
          coolUntil = now + COOLDOWN_MS;
          return "Z";
        }
      }

      return null;
    },
  };
}
