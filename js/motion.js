// J and Z are the only fingerspelling letters that aren't a still handshape —
// J is the "I" hand tracing a hook, Z is the index finger drawing a zigzag in
// the air. This matcher watches a ~2 s window of the hand and reports when a
// real J or Z stroke was just drawn.
//
//   const mm = createMotionMatcher();
//   mm.push(landmarks, now, aspect?);   // every frame; null on a lost hand.
//                                       // aspect = video width / height (default 1)
//   mm.match(now) -> "J" | "Z" | null   // fires once per stroke (buffer is cleared)
//   mm.metrics()  -> { progress: {J, Z} 0..1, debug: {J, Z} strings, ... } | null
//
// The stroke templates below (STROKE) are also used to animate the demo.
//
// ---- why it's built this way (rewritten 2026-09-23) ----
// Live QA: "J registers without real movement", "if you just move your hand
// it instantly counts", "I repeatedly triggers J", "Z fails to track". The
// old matcher only asked "did the pinky tip move >1.2 spans and end >0.7
// lower" (J) / "did the index sweep wide with >=1 reversal" (Z), measured
// relative to the wrist and without aspect correction. So tilting an I hand
// (~40°), or just relaxing the pinky, was a J; a single wag was a Z; and a Z
// drawn with the arm — the natural way — barely moved relative to the wrist,
// and horizontal travel counted for only 9/16 of vertical on a 16:9 webcam.
//
// Now, for both letters:
//   * SHAPE GATE — the start handshape (I = pinky out, index + middle curled;
//     Z = index out, pinky + middle curled) must be held at the start of the
//     stroke and on >=70% of its frames. Thresholds come from the dataset's
//     per-letter distributions (tip-to-knuckle / hand span: I pinky p10 0.76,
//     index p90 0.31; Z-pose index p10 0.97, pinky p90 0.45). A relaxing I
//     curls the pinky, so it fails the gate.
//   * IMAGE-SPACE PATHS, aspect-corrected, in units of the hand span measured
//     at the stroke's start — arm motion counts, and x and y are comparable.
//   * J = the pinky tip goes DOWN (>=0.6 spans), travels (>=1.0), and HOOKS
//     (its travel direction turns >=40° away from where it started), AND the hand
//     either twists (knuckle line foreshortens/lengthens >=1.3x — forearm
//     supination) or the arm moves (wrist travels >=0.5 spans). An in-plane
//     tilt has neither, a straight drop has no hook.
//   * Z = the index tip makes >=2 sideways reversals (each a >=0.35-span
//     retreat from the last extreme), spans >=1.0 wide, and ends >=0.4 lower
//     than it started. A side-to-side wave doesn't descend; one wag has one
//     reversal.
//   * Every hit clears the buffer, so the same stroke can never fire twice.
//   * A hand smaller than MIN_SPAN (far away) is ignored: its landmark jitter
//     alone is a large fraction of a span (QA: 20-36 spurious strokes/min).

const WINDOW_MS = 2000;
const COOLDOWN_MS = 600;
const MIN_FRAMES = 6;
const MIN_STROKE_MS = 300;
const MIN_SPAN = 0.035; // wrist->knuckles, aspect-corrected frame units

// shape thresholds: tip-to-MCP distance / hand span
const I_PINKY_MIN = 0.6, I_INDEX_MAX = 0.45, I_MIDDLE_MAX = 0.5;
const Z_INDEX_MIN = 0.75, Z_PINKY_MAX = 0.55, Z_MIDDLE_MAX = 0.6;
const SHAPE_FRAC = 0.7;

// J
const J_DROP = 0.6, J_LEN = 1.0, J_HOOK_DEG = 40, J_TWIST = 1.3, J_ARM = 0.5;
// Z
const Z_REV_STEP = 0.35, Z_REVS = 2, Z_WIDTH = 1.0, Z_DESCENT = 0.4;

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

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// arc-length resample a polyline to n points
export function resample(pts, n) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i], pts[i - 1]);
    seg.push(d);
    total += d;
  }
  if (total < 1e-9) return Array.from({ length: n }, () => pts[0].slice());
  const out = [pts[0].slice()];
  let acc = 0, i = 1;
  for (let k = 1; k < n; k++) {
    const target = (k / (n - 1)) * total;
    while (i < pts.length - 1 && acc + seg[i - 1] < target) { acc += seg[i - 1]; i++; }
    const s = seg[i - 1] || 1e-9;
    const f = Math.max(0, Math.min(1, (target - acc) / s));
    out.push([
      pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]),
      pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1]),
    ]);
  }
  return out;
}

const pathLength = (pts) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i], pts[i - 1]);
  return L;
};

// the hook: the largest angle (deg) the path's local travel direction turns
// away from its initial direction. Comparing whole thirds of the path (the
// first version) averaged a quick J's short hook away; a sliding window over
// the resampled path catches it. A straight drop stays near 0.
function hookDeg(pts) {
  const r = resample(pts, 24);
  const a = [r[5][0] - r[0][0], r[5][1] - r[0][1]];
  const la = Math.hypot(...a);
  if (la < 1e-9) return 0;
  let best = 0;
  for (let j = 5; j + 4 < r.length; j++) {
    const b = [r[j + 4][0] - r[j][0], r[j + 4][1] - r[j][1]];
    const lb = Math.hypot(...b);
    if (lb < 1e-9) continue;
    const c = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)));
    best = Math.max(best, (Math.acos(c) * 180) / Math.PI);
  }
  return best;
}

// sideways reversals with hysteresis: a reversal only counts once x has
// retreated `step` from the running extreme in the current direction
function reversals(xs, step) {
  let dir = 0, ext = xs[0], n = 0;
  for (const x of xs) {
    if (dir === 0) {
      if (x - ext >= step) { dir = 1; ext = x; } else if (ext - x >= step) { dir = -1; ext = x; }
    } else if (dir === 1) {
      if (x > ext) ext = x;
      else if (ext - x >= step) { dir = -1; ext = x; n++; }
    } else {
      if (x < ext) ext = x;
      else if (x - ext >= step) { dir = 1; ext = x; n++; }
    }
  }
  return n;
}

export function createMotionMatcher() {
  let buf = []; // per-frame: { t, wrist, pinky, index, knuckle, span, isI, isPoint }
  let coolUntil = 0;

  // earliest frame index from which this shape starts the stroke: the start
  // frames are in shape and the shape holds on >= SHAPE_FRAC of the segment
  function strokeStart(key) {
    for (let s = 0; s + MIN_FRAMES <= buf.length; s++) {
      if (!buf[s][key] || !buf[s + 1][key] || !buf[s + 2][key]) continue;
      let ok = 0;
      for (let i = s; i < buf.length; i++) if (buf[i][key]) ok++;
      if (ok / (buf.length - s) >= SHAPE_FRAC) return s;
    }
    return -1;
  }

  function evalJ() {
    const s = strokeStart("isI");
    if (s < 0) return { ok: false, progress: 0, debug: "no I-hand start" };
    const seg = buf.slice(s);
    const ms = seg.at(-1).t - seg[0].t;
    const ref = seg.slice(0, 3).reduce((a, f) => a + f.span, 0) / 3;
    const P = seg.map((f) => [(f.pinky[0] - seg[0].pinky[0]) / ref, (f.pinky[1] - seg[0].pinky[1]) / ref]);
    const drop = Math.max(...P.map((q) => q[1]));
    const len = pathLength(P);
    const hook = P.length >= 4 ? hookDeg(P) : 0;
    const kn = seg.map((f) => f.knuckle / f.span);
    const twist = Math.max(...kn) / Math.max(1e-6, Math.min(...kn));
    const arm = Math.max(...seg.map((f) => dist(f.wrist, seg[0].wrist))) / ref;
    const endsI = seg.at(-1).isI || seg.at(-2)?.isI;
    const ok =
      ms >= MIN_STROKE_MS && endsI && drop >= J_DROP && len >= J_LEN &&
      hook >= J_HOOK_DEG && (twist >= J_TWIST || arm >= J_ARM);
    const progress = Math.max(0, Math.min(1,
      Math.min(drop / J_DROP, len / J_LEN) * (0.6 + 0.4 * Math.min(1, hook / J_HOOK_DEG))));
    return {
      ok, progress,
      debug: `drop ${drop.toFixed(2)}/${J_DROP} · len ${len.toFixed(2)}/${J_LEN} · hook ${hook.toFixed(0)}°/${J_HOOK_DEG} · twist ${twist.toFixed(2)}/${J_TWIST} · arm ${arm.toFixed(2)}/${J_ARM}`,
    };
  }

  function evalZ() {
    const s = strokeStart("isPoint");
    if (s < 0) return { ok: false, progress: 0, debug: "no pointing-hand start" };
    const seg = buf.slice(s);
    const ms = seg.at(-1).t - seg[0].t;
    const ref = seg.slice(0, 3).reduce((a, f) => a + f.span, 0) / 3;
    const P = seg.map((f) => [(f.index[0] - seg[0].index[0]) / ref, (f.index[1] - seg[0].index[1]) / ref]);
    const xs = resample(P, 24).map((q) => q[0]);
    const rev = reversals(xs, Z_REV_STEP);
    const width = Math.max(...P.map((q) => q[0])) - Math.min(...P.map((q) => q[0]));
    const descent = P.at(-1)[1] - P[0][1];
    const ok =
      ms >= MIN_STROKE_MS && rev >= Z_REVS && width >= Z_WIDTH && descent >= Z_DESCENT;
    const progress = Math.max(0, Math.min(1,
      Math.min(width / Z_WIDTH, 1) * 0.4 + Math.min(rev / Z_REVS, 1) * 0.4 +
      Math.max(0, Math.min(descent / Z_DESCENT, 1)) * 0.2));
    return {
      ok, progress,
      debug: `turns ${rev}/${Z_REVS} · width ${width.toFixed(2)}/${Z_WIDTH} · down ${descent.toFixed(2)}/${Z_DESCENT}`,
    };
  }

  return {
    reset() {
      buf = [];
    },

    push(landmarks, now, aspect = 1) {
      if (!landmarks || landmarks.length < 21) {
        if (now - (buf.at(-1)?.t ?? 0) > 250) buf = [];
        return;
      }
      const P = (j) => [landmarks[j].x * aspect, landmarks[j].y];
      const w = P(0);
      let mx = 0, my = 0;
      for (const j of [5, 9, 13, 17]) { const q = P(j); mx += q[0]; my += q[1]; }
      const span = Math.hypot(mx / 4 - w[0], my / 4 - w[1]);
      if (!(span >= MIN_SPAN)) { buf = []; return; } // too far away (or degenerate) to trust
      const ext = (tip, mcp) => dist(P(tip), P(mcp)) / span;
      const pinky = ext(20, 17), index = ext(8, 5), middle = ext(12, 9);
      buf.push({
        t: now,
        wrist: w,
        pinky: P(20),
        index: P(8),
        knuckle: dist(P(5), P(17)),
        span,
        isI: pinky >= I_PINKY_MIN && index <= I_INDEX_MAX && middle <= I_MIDDLE_MAX,
        isPoint: index >= Z_INDEX_MIN && pinky <= Z_PINKY_MAX && middle <= Z_MIDDLE_MAX,
      });
      while (buf.length && now - buf[0].t > WINDOW_MS) buf.shift();
    },

    // live progress (0..1) toward each letter + a debug readout, for the
    // Practice meter / rising tone. null until there's enough to judge.
    metrics() {
      if (buf.length < MIN_FRAMES) return null;
      const J = evalJ(), Z = evalZ();
      return {
        frames: buf.length,
        ms: Math.round(buf.at(-1).t - buf[0].t),
        progress: { J: J.progress, Z: Z.progress },
        debug: { J: J.debug, Z: Z.debug },
      };
    },

    // returns "J" | "Z" | null
    match(now) {
      if (now < coolUntil || buf.length < MIN_FRAMES) return null;
      const J = evalJ();
      const Z = J.ok ? null : evalZ();
      const hit = J.ok ? "J" : Z.ok ? "Z" : null;
      if (hit) {
        coolUntil = now + COOLDOWN_MS;
        buf = []; // this stroke is spent
      }
      return hit;
    },
  };
}
