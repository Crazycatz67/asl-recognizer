// Synthetic 21-landmark hand for testing js/motion.js (J/Z strokes) without a
// camera. Used by tools/ci-check.mjs (Node) and tools/selftest.js (browser).
//
//   synthHand({ wx, wy, S, theta, sup, ext, aspect }) -> [{x,y,z} x 21]
//     wx, wy  wrist position (x in aspect-corrected units, i.e. x * aspect)
//     S       hand size: frame units per hand-span unit
//     theta   in-plane rotation (radians)
//     sup     supination 1..0 — the palm's lateral axis foreshortens, as when
//             the forearm twists (the J motion)
//     ext     { mcpIndex: 0..1 } — 1 = finger straight out, 0 = curled
//     aspect  video width / height; output x is a fraction of WIDTH, like
//             MediaPipe's, so aspect-corrected geometry is the true geometry
//   motionScenarios() -> [{ name, frames, expect: "J" | "Z" | null }]
//
// The scenarios are the live-QA false positives ("tilting / relaxing an I
// counts as J", "one wag is a Z") plus real strokes that must still fire.

const MCP = { 5: [0.35, -0.9], 9: [0.1, -0.95], 13: [-0.12, -0.92], 17: [-0.32, -0.85] };
const CHAIN = { 5: [6, 7, 8], 9: [10, 11, 12], 13: [14, 15, 16], 17: [18, 19, 20] };
export const SHAPE = { I: { 17: 1 }, POINT: { 5: 1 }, OPEN: { 5: 1, 9: 1, 13: 1, 17: 1 } };

export function synthHand({ wx = 0.5, wy = 0.6, S = 0.1, theta = 0, sup = 1, ext = {}, aspect = 1 } = {}) {
  const pts = Array.from({ length: 21 }, () => [0, 0]);
  for (const m of [5, 9, 13, 17]) {
    const b = MCP[m];
    pts[m] = b.slice();
    const L = Math.hypot(b[0], b[1]), d = [b[0] / L, b[1] / L];
    const e = ext[m] ?? 0;
    const tip = [b[0] + d[0] * 0.95 * e, b[1] + d[1] * 0.95 * e + 0.2 * (1 - e)];
    CHAIN[m].forEach((j, k) => {
      const f = (k + 1) / 3;
      pts[j] = [b[0] + (tip[0] - b[0]) * f, b[1] + (tip[1] - b[1]) * f];
    });
  }
  pts[1] = [0.3, -0.3]; pts[2] = [0.45, -0.45]; pts[3] = [0.5, -0.6]; pts[4] = [0.45, -0.7];
  const c = Math.cos(theta), s = Math.sin(theta);
  return pts.map(([x, y]) => {
    x *= sup;
    const X = (x * c - y * s) * S + wx * aspect;
    const Y = (x * s + y * c) * S + wy;
    return { x: X / aspect, y: Y, z: 0 };
  });
}

const lerp = (a, b, t) => a + (b - a) * t;
const hold = (n, f) => Array.from({ length: n }, () => ({ ...f }));
const seq = (n, fn) => Array.from({ length: n }, (_, i) => fn(i / (n - 1)));
const zpath = (k) => {
  const segs = [[[0, 0], [0.18, 0]], [[0.18, 0], [0, 0.12]], [[0, 0.12], [0.18, 0.12]]];
  const u = Math.min(2.999, k * 3), i = Math.floor(u), f = u - i;
  const [a, b] = segs[i];
  return [lerp(a[0], b[0], f), lerp(a[1], b[1], f)];
};

export function motionScenarios() {
  const { I, POINT, OPEN } = SHAPE;
  return [
    { name: "true J (drop, then hook with a forearm twist)", expect: "J", frames: [...hold(5, { ext: I }), ...seq(22, (k) => ({ ext: I, wy: 0.6 + 0.06 * Math.min(1, k / 0.55), wx: 0.5 - 0.02 * k, theta: -1.7 * Math.max(0, (k - 0.35) / 0.65), sup: 1 - 0.5 * k }))] },
    { name: "true J, quick (12 frames)", expect: "J", frames: [...hold(4, { ext: I }), ...seq(12, (k) => ({ ext: I, wy: 0.6 + 0.05 * Math.min(1, k / 0.5), theta: -1.6 * Math.max(0, (k - 0.3) / 0.7), sup: 1 - 0.45 * k }))] },
    { name: "true J drawn with the arm (little twist)", expect: "J", frames: [...hold(5, { ext: I }), ...seq(22, (k) => ({ ext: I, wy: 0.6 + 0.09 * Math.min(1, k / 0.6), wx: 0.5 - 0.08 * Math.max(0, (k - 0.5) / 0.5), theta: -1.2 * Math.max(0, (k - 0.4) / 0.6), sup: 1 - 0.1 * k }))] },
    { name: "I tilted in-plane, wrist fixed", expect: null, frames: [...hold(5, { ext: I }), ...seq(20, (k) => ({ ext: I, theta: -1.0 * k }))] },
    { name: "I relaxing (pinky curls down)", expect: null, frames: [...hold(5, { ext: I }), ...seq(15, (k) => ({ ext: { 17: 1 - k } }))] },
    { name: "I held with drift", expect: null, frames: [...hold(5, { ext: I }), ...seq(40, (k) => ({ ext: I, wx: 0.5 + 0.01 * Math.sin(k * 9), wy: 0.6 + 0.01 * k }))] },
    { name: "I moved straight down", expect: null, frames: [...hold(5, { ext: I }), ...seq(20, (k) => ({ ext: I, wy: 0.6 + 0.2 * k }))] },
    { name: "open hand swoosh", expect: null, frames: [...hold(5, { ext: OPEN }), ...seq(20, (k) => ({ ext: OPEN, wy: 0.6 + 0.1 * k, theta: -1.0 * k, sup: 1 - 0.5 * k }))] },
    { name: "true Z drawn with the arm", expect: "Z", frames: [...hold(5, { ext: POINT, wx: 0.4, wy: 0.5 }), ...seq(30, (k) => { const [dx, dy] = zpath(k); return { ext: POINT, wx: 0.4 + dx, wy: 0.5 + dy }; })] },
    { name: "pointing hand waving side to side", expect: null, frames: [...hold(5, { ext: POINT, wx: 0.45, wy: 0.6 }), ...seq(30, (k) => ({ ext: POINT, wx: 0.45 + 0.09 * Math.sin(k * Math.PI * 3) }))] },
    { name: "pointing hand, one wag", expect: null, frames: [...hold(5, { ext: POINT, wx: 0.4, wy: 0.5 }), ...seq(20, (k) => ({ ext: POINT, wx: 0.4 + 0.18 * Math.sin(k * Math.PI), wy: 0.5 + 0.06 * k }))] },
    { name: "far-away (tiny) I hand with landmark jitter", expect: null, frames: seq(60, (k) => ({ ext: I, S: 0.03, wx: 0.5 + 0.004 * Math.sin(k * 37), wy: 0.6 + 0.004 * Math.cos(k * 53) })) },
  ];
}

// run one scenario through a fresh matcher; returns the list of hits
export function runScenario(createMotionMatcher, sc, aspect = 1, dtMs = 33) {
  const mm = createMotionMatcher();
  const hits = [];
  let t = 0;
  for (const f of sc.frames) {
    mm.push(synthHand({ ...f, aspect }), t, aspect);
    const h = mm.match(t);
    if (h) hits.push(h);
    t += dtMs;
  }
  return hits;
}

// ---- operations on NORMALIZED landmark vectors (dataset rows / live vecs) ----
// Used by tools/ci-check.mjs to build shapes a learner might make by mistake.
const P3 = (v, j) => [v[j * 3], v[j * 3 + 1], v[j * 3 + 2]];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit3 = (a) => { const l = Math.hypot(...a) || 1e-9; return a.map((x) => x / l); };
const rotAbout = (p, c, axis, rad) => {
  const r = sub3(p, c), cs = Math.cos(rad), sn = Math.sin(rad), k = dot3(r, axis), cr = cross3(axis, r);
  return [0, 1, 2].map((i) => c[i] + r[i] * cs + cr[i] * sn + axis[i] * k * (1 - cs));
};
const setP = (v, j, q) => { v[j * 3] = q[0]; v[j * 3 + 1] = q[1]; v[j * 3 + 2] = q[2]; };

/** fan the four fingers apart by `deg` per gap (rotation about the palm normal at each knuckle) */
export function fanFingers(v, deg) {
  const out = v.slice();
  const n = unit3(cross3(sub3(P3(v, 5), P3(v, 0)), sub3(P3(v, 17), P3(v, 0))));
  [[5, -1.5], [9, -0.5], [13, 0.5], [17, 1.5]].forEach(([m, w]) => {
    for (let j = m + 1; j <= m + 3; j++) setP(out, j, rotAbout(P3(v, j), P3(v, m), n, (w * deg * Math.PI) / 180));
  });
  return out;
}

/** curl each finger `bendDeg` at its middle joint — raised knuckles + curled fingers = a claw */
export function curlAtMiddle(v, bendDeg) {
  const out = v.slice();
  const n = unit3(cross3(sub3(P3(v, 5), P3(v, 0)), sub3(P3(v, 17), P3(v, 0))));
  for (const m of [5, 9, 13, 17]) {
    const pip = P3(v, m + 1);
    const axis = unit3(cross3(sub3(pip, P3(v, m)), n));
    for (const j of [m + 2, m + 3]) setP(out, j, rotAbout(P3(out, j), pip, axis, (bendDeg * Math.PI) / 180));
  }
  return out;
}

// Palm side: +n where n = (index knuckle - wrist) x (pinky knuckle - wrist).
// The dataset is canonicalized to right-hand geometry, and measured on
// data/dataset.json ~97% of hands curl their fingers (and hold the thumb)
// toward +n, so "fold" = rotate toward +n, "raise" = rotate away from it.
const palmNormal = (v) => unit3(cross3(sub3(P3(v, 5), P3(v, 0)), sub3(P3(v, 17), P3(v, 0))));
const FINGER_MCP = { index: 5, middle: 9, ring: 13, pinky: 17 };

// signed bend (deg) at joint j of a chain prev -> j -> next, positive = flexed
// toward the palm; the flexion axis is cross(segment into j, palm normal)
function bendAt(v, prev, j, next, n) {
  const a = sub3(P3(v, j), P3(v, prev)), b = sub3(P3(v, next), P3(v, j));
  const ax = unit3(cross3(a, n));
  const ang = Math.acos(Math.max(-1, Math.min(1, dot3(unit3(a), unit3(b)))));
  return { ax, deg: (Math.sign(dot3(cross3(a, b), ax)) || 1) * (ang * 180) / Math.PI };
}

/**
 * Physically fold (deg > 0) or raise (deg < 0) ONE finger: rotate everything
 * beyond the base knuckle about the knuckle, then everything beyond the middle
 * joint about the middle joint, by `deg` each (a real finger folds at both).
 * Raising never straightens a joint past straight (no hyperextension), so a
 * fist finger raised 90° ends straight, not bent backwards.
 */
export function bendFinger(v, finger, deg) {
  const m = FINGER_MCP[finger];
  const n = palmNormal(v);
  let out = v.slice();
  // base knuckle: its "segment in" is wrist -> knuckle
  for (const [prev, j, next] of [[0, m, m + 1], [m, m + 1, m + 2]]) {
    const { ax, deg: cur } = bendAt(out, prev, j, next, n);
    const d = deg < 0 ? -Math.min(-deg, Math.max(0, cur)) : deg;
    const rad = (d * Math.PI) / 180, c = P3(out, j);
    const src = out.slice();
    for (let k = j + 1; k <= m + 3; k++) setP(out, k, rotAbout(P3(src, k), c, ax, rad));
  }
  return out;
}

/**
 * Swing the thumb (joints 2-4) about its base (joint 1), around the palm
 * normal: deg > 0 moves the thumb tip AWAY from the index knuckle (out to the
 * side, toward an L), deg < 0 toward it (tucked in). The direction is picked
 * per hand so it means the same on every hand.
 */
export function swingThumb(v, deg) {
  const n = palmNormal(v), c = P3(v, 1);
  const tip = (rad) => rotAbout(P3(v, 4), c, n, rad);
  const d5 = (p) => Math.hypot(...sub3(p, P3(v, 5)));
  const sgn = d5(tip(0.1)) >= d5(tip(-0.1)) ? 1 : -1;
  const out = v.slice(), rad = (sgn * deg * Math.PI) / 180;
  for (const k of [2, 3, 4]) setP(out, k, rotAbout(P3(v, k), c, n, rad));
  return out;
}
