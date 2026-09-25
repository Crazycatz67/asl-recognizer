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

import { drawHandShape, vectorToPixels, makeFit } from "./skeleton.js";
import { rotateVector, mirrorVector } from "./normalize.js";
import { STROKE } from "./motion.js";
import { jointState, fullError, countStates, isReadable } from "./jointstate.js";
import { makeHandInterpolator as makeInterpolator, angleDistance } from "./posekin.js";
// (Stage 4b, 2026-09-25: every demo-hand animation now uses the anatomical
// interpolator — rigid palm, fingers bend toward the palm — see posekin.js)
import {
  catmullRom2D, rigidPoseAt, delayedEase, bump, arcFractions, rotate2D,
  translatePose, easeOutBack,
} from "./strokekin.js";

// A casual wrist tilt isn't a spelling mistake, so before comparing a live hand
// to a letter we let it rotate up to this much to sit at the letter's own tilt.
// Kept small: a real mis-orientation (G/H point sideways, P points down) is tens
// of degrees off and still reads as wrong.
const ALIGN_MAX_DEG = 22;

// score()'s "correct" bucket forgives a single joint drifting up to this many
// times the tight per-joint tolerance (holding a pixel-perfect pose was
// exhausting for testers). The live guide overlay must colour joints green up
// to this SAME widened line, or it keeps flagging joints yellow that the meter
// already calls correct — see matchTolerance() below and its one caller.
// 2026-09-24: 1.8 -> 2.6 — owner: "sensitivity is too high ... I want room
// for some user error". The overlay's blue line and the reward use this same
// value via matchTolerance() + js/jointstate.js, so widening it here widens
// both together.
const MATCH_TOL_MULT = 2.6;

// ASL look-alikes (static letters). With per-joint room for error, a hand can
// be "close enough" to BOTH letters of a pair — so a sign only counts if it's
// also nearer its own letter than any look-alike (measured 2026-09-24: without
// this, 57% of look-alike hands were accepted as the other letter).
// only when CLEARLY nearer the look-alike (within 10% counts as ambiguous ->
// benefit of the doubt to the letter you're practising)
const LOOKALIKE_MARGIN = 0.9;
const LOOKALIKE = {
  M: ["N", "S", "A", "T"], N: ["M", "S", "T"], S: ["A", "T", "E", "M", "N"],
  A: ["S", "T", "E"], T: ["A", "S", "N", "M"], E: ["A", "S", "O"],
  U: ["V", "R", "H"], V: ["U", "K", "W"], R: ["U", "V"], K: ["V", "P"],
  W: ["V", "F"], F: ["W", "B"], B: ["F", "E"],
  G: ["H", "Q"], H: ["G", "U"], P: ["Q", "K"], Q: ["P", "G"],
  D: ["O", "C", "F"], O: ["D", "C", "E"], C: ["O", "D"],
  I: ["Y"], Y: ["I", "L"], L: ["Y", "G"], X: ["R", "D"],
};

// in-plane angle of the palm axis: wrist(0) -> mean of the four finger MCPs
// (5,9,13,17). Averaging the knuckles is far steadier than a single bone, so a
// little landmark noise doesn't swing the estimate.
const axisAngle = (v) => {
  let mx = 0, my = 0;
  for (const j of [5, 9, 13, 17]) {
    mx += v[j * 3];
    my += v[j * 3 + 1];
  }
  return Math.atan2(my / 4 - v[1], mx / 4 - v[0]);
};

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

// A plain-language picture of each handshape — shown while you learn it, so the
// panel isn't just "copy this diagram". Stage 7e: every description now starts
// with which way the palm faces (or the fingers point), then the shape, in
// short plain English. "Sideways" was ambiguous: fingers that point to the
// side are "pointing across your body"; a palm turned to the side "faces your
// other hand". Keep a real-world image where there's a good one.
export const LETTER_GUIDE = {
  A: "Palm faces forward. Make a fist. Rest your thumb against the side of your index finger, pointing up — a thumbs-up that never went up.",
  B: "Palm faces forward. Hold four fingers straight up and pressed together. Fold your thumb across your palm — a little wall.",
  C: "Palm faces your other hand. Curve your fingers and thumb into a C, fingers together — like holding a soda can.",
  D: "Palm faces forward. Point your index finger straight up. Curl the other fingers so their tips touch your thumb in a circle.",
  E: "Palm faces forward. Bend all four fingertips down to touch your thumb, which is tucked across your palm — a closed claw.",
  F: "Palm faces forward. Touch your thumb tip to your index fingertip in a small circle. The other three fingers stand up — the 'OK' sign.",
  G: "Fingers point across your body, palm facing you. Hold your index finger and thumb out straight and parallel, a small gap between them.",
  H: "Fingers point across your body, palm facing you. Hold your index and middle fingers straight and together. Curl the others, thumb tucked.",
  I: "Palm faces forward. Make a fist and stand your pinky straight up — a tiny antenna.",
  K: "Palm faces forward. Index finger up, middle finger up and spread out a little. Press your thumb between them — a little catapult.",
  L: "Palm faces forward. Index finger straight up, thumb straight out to the side, other fingers curled — a capital L.",
  M: "Palm faces forward. Fold your first three fingers down over your thumb. The thumb tip peeks out between your ring finger and pinky.",
  N: "Palm faces forward. Fold your first two fingers down over your thumb. The thumb tip peeks out between your middle and ring fingers.",
  O: "Palm faces your other hand. Curve all your fingertips to meet your thumb in a round O — like holding a single Cheerio.",
  P: "Fingers point down. Make a K, then tip your hand so your index finger points forward and your middle finger points down at the floor.",
  Q: "Fingers point down. Point your thumb and index finger at the floor, a small gap between them — a downward pinch.",
  R: "Palm faces forward. Hold your index and middle fingers up and cross them tightly, like crossing your fingers for luck. Curl the rest.",
  S: "Palm faces forward. Make a fist and wrap your thumb across the front of your fingers.",
  T: "Palm faces forward. Make a fist and tuck your thumb up between your index and middle fingers.",
  U: "Palm faces forward. Hold your index and middle fingers straight up and together. Your thumb holds the other two down.",
  V: "Palm faces forward. Hold your index and middle fingers up in a spread V. Your thumb holds the other two down — 'peace'.",
  W: "Palm faces forward. Hold your index, middle and ring fingers up and spread. Your thumb holds your pinky down.",
  X: "Palm faces your other hand. Hold your index finger up and bend it into a hook. Curl the rest into a fist.",
  Y: "Palm faces forward. Stretch your thumb and pinky out wide. Fold the three middle fingers down — 'hang loose'.",
  J: "Start with I: palm forward, fist, pinky up. Then draw a J with your pinky: move it down and curve it toward your body, turning your palm to face you.",
  Z: "Palm faces forward. Point your index finger up, the rest in a fist. Draw a big Z in the air: across the top, a slash down to the left, then across the bottom.",
};

// Render a letter's canonical hand shape (its class-mean vector) as a clean,
// large, upright diagram in a panel canvas — the "make this" reference.
export function drawCanonical(canvasEl, vec) {
  const ctx = canvasEl.getContext("2d");
  const w = canvasEl.width;
  const h = canvasEl.height;
  ctx.clearRect(0, 0, w, h);
  if (!vec) return;
  const px = vectorToPixels(vec, w, h, { pad: 0.18 });
  drawHandShape(ctx, px);
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

  // Degrees to rotate a live vector so its tilt matches the letter's — clamped,
  // with a dead zone for sub-noise tilt, and ONLY if it actually reduces the
  // distance to the centroid (so alignment can never invent error, e.g. from a
  // noisy axis estimate on an already-matched hand).
  const alignDegFor = (liveVec, label) => {
    const c = centroids.get(label);
    if (!c || !liveVec) return 0;
    let d = axisAngle(c) - axisAngle(liveVec);
    d = Math.atan2(Math.sin(d), Math.cos(d)) * (180 / Math.PI);
    if (Math.abs(d) < 3) return 0;
    d = Math.max(-ALIGN_MAX_DEG, Math.min(ALIGN_MAX_DEG, d));
    return coordDist(rotateVector(liveVec, d), c) < coordDist(liveVec, c) ? d : 0;
  };
  // liveVec brought into the letter's orientation (small tilt forgiveness)
  const aligned = (liveVec, label) => {
    const deg = alignDegFor(liveVec, label);
    return deg ? rotateVector(liveVec, deg) : liveVec;
  };

  // Best fit of the live hand to the letter, allowing a small tilt AND a
  // left/right mirror. Signing with your left hand produces the mirror of the
  // right-hand template, and a wrist can't physically roll into the mirrored
  // orientation — so we just try both and take whichever fits, per frame.
  const fit = (v0, label) => {
    const c = centroids.get(label);
    const deg = alignDegFor(v0, label);
    const v = deg ? rotateVector(v0, deg) : v0;
    return { v, deg, dist: coordDist(v, c) };
  };
  const bestOrientation = (liveVec, label) => {
    if (!centroids.get(label) || !liveVec) return { v: liveVec, mirrored: false, deg: 0 };
    const a = fit(liveVec, label);
    const m = fit(mirrorVector(liveVec), label);
    return m.dist < a.dist
      ? { v: m.v, mirrored: true, deg: m.deg }
      : { v: a.v, mirrored: false, deg: a.deg };
  };

  return {
    letters: [...centroids.keys()].sort(),

    centroid(label) {
      return centroids.get(label) || null;
    },

    // tight per-joint normalized error — a fingertip within ~4-12% of hand
    // radius. This is NOT what the live guide colours green (see
    // matchTolerance below); it's the raw band score()/matched are built on.
    tolerance(label) {
      return tolFor(bands.get(label));
    },

    // the actual "locked on" line for the guide overlay: widened by the same
    // factor score()'s "correct" bucket forgives, so a shape the meter already
    // calls correct never still shows yellow/red joints. The overlay's ONE
    // caller for this — main.js's drawGuide `tol` — must use this, not
    // tolerance(), or the two silently disagree again.
    matchTolerance(label) {
      return tolFor(bands.get(label)) * MATCH_TOL_MULT;
    },

    // How the on-camera guide should orient the target so it and the meter
    // judge the same (tilt- and mirror-forgiven) shape.
    // -> { mirrored: bool, deg: number }
    orient(liveVec, label) {
      const o = bestOrientation(liveVec, label);
      return { mirrored: o.mirrored, deg: o.deg };
    },
    alignDeg(liveVec, label) {
      return alignDegFor(liveVec, label);
    },

    // opts.refiner: heads.js's learned M/N + D/O/C heads (optional). Raw
    // centroid distance can't separate those pairs (their shapes overlap), so
    // when a look-alike conflict is between letters a head covers, the head
    // decides instead.
    score(liveVec, label, opts = {}) {
      const c = centroids.get(label);
      const b = bands.get(label);
      if (!c || !b || !liveVec)
        return { dist: Infinity, score: 0, bucket: "off", matched: false, worst: Infinity, mirrored: false };
      const { v, mirrored } = bestOrientation(liveVec, label); // forgive tilt + mirror
      const d = coordDist(v, c);
      const s = scoreFor(d, b);
      // "correct" = a READABLE sign, not a pixel-perfect one. The aggregate has
      // to be decent and no single joint wildly off, but a joint may drift to
      // ~1.8x the tight "green" tolerance and still count — holding a perfect
      // pose was exhausting. (A truly wrong finger, several x tol, still fails.)
      const worst = worstJoint(v, c);
      // every joint judged ONCE, with the shared rule (js/jointstate.js) —
      // overlay.js colours the live hand with exactly these states and
      // main.js rewards on the same verdict, so the colours can't disagree
      // with whether the sign counts.
      const tol = tolFor(b) * MATCH_TOL_MULT;
      const full = fullError(tol);
      const errors = new Array(21);
      const states = new Array(21);
      for (let j = 0; j < 21; j++) {
        errors[j] = Math.hypot(v[j * 3] - c[j * 3], v[j * 3 + 1] - c[j * 3 + 1]);
        states[j] = jointState(errors[j], tol, full);
      }
      const counts = countStates(states);
      // nearer a look-alike than this letter? then it isn't this letter yet
      let confusedWith = null;
      for (const other of LOOKALIKE[label] || []) {
        const c2 = centroids.get(other);
        if (!c2) continue;
        const d2 = coordDist(bestOrientation(liveVec, other).v, c2);
        if (d2 < d * LOOKALIKE_MARGIN && (!confusedWith || d2 < confusedWith.d)) confusedWith = { letter: other, d: d2 };
      }
      const rf = opts.refiner;
      if (confusedWith && rf && rf.covers.includes(label) && rf.covers.includes(confusedWith.letter)) {
        const oriented = bestOrientation(liveVec, label).v;
        if (rf.refine(oriented, confusedWith.letter) === label) confusedWith = null;
      }
      const readable = isReadable(counts, s) && !confusedWith;
      const bucket = readable ? "correct" : counts.fix <= 2 && s >= 0.45 ? "close" : "off";
      return {
        dist: d, score: s, bucket, matched: readable, worst, mirrored, errors, states, counts, tol,
        confusedWith: confusedWith ? confusedWith.letter : null,
      };
    },

    // Where on the (mirrored) view the shape is wrong: 0..1 per screen zone.
    // Lets the ambient background react in the direction of the problem —
    // fingers off -> the top warms; thumb side off -> that side warms.
    regionErrors(liveVec, label) {
      const c = centroids.get(label);
      if (!c || !liveVec) return { top: 0, left: 0, right: 0 };
      const { v } = bestOrientation(liveVec, label);
      const zones = { top: [0, 0], left: [0, 0], right: [0, 0] };
      for (let j = 0; j < 21; j++) {
        const dx = v[j * 3] - c[j * 3];
        const dy = v[j * 3 + 1] - c[j * 3 + 1];
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
            text:
              dev > 0
                ? `Curl your ${FINGERS[f]} further down toward your palm`
                : `Straighten your ${FINGERS[f]} — extend it out fully`,
          });
        }
      }
      for (let g = 0; g < 4; g++) {
        const dev = liveVec[F_GAP + g] - c[F_GAP + g];
        if (Math.abs(dev) > 0.13) {
          const [a, bb] = GAP_PAIRS[g];
          cand.push({
            mag: Math.abs(dev),
            text:
              dev > 0
                ? `Close the gap — bring your ${a} and ${bb} together until they touch`
                : `Open a clear gap between your ${a} and ${bb}`,
          });
        }
      }
      const thumbDev = liveVec[F_THUMB] - c[F_THUMB];
      if (Math.abs(thumbDev) > 0.12) {
        cand.push({
          mag: Math.abs(thumbDev),
          text:
            thumbDev > 0
              ? "Tuck your thumb in tight against the side of your hand"
              : "Bring your thumb out away from your palm",
        });
      }

      if (!cand.length) return "Looks right — hold it steady";
      cand.sort((x, y) => y.mag - x.mag);
      return cand[0].text;
    },

    // The plain-language "how to shape it" description for the panel.
    describe(label) {
      return LETTER_GUIDE[label] || "";
    },
  };
}

// A relaxed open right hand in the normalized frame (wrist ~origin, fingers up
// = negative y). The animated player eases from this into the target shape so
// you see the sign FORM, not just a still.
//
// Same side convention as the dataset centroids it animates INTO: thumb and
// index at +x, pinky at -x (checked against A/B/L/N centroids). It used to be
// the mirror image — thumb at -x — and a mirror image can't be reached by
// rotating bones, so every letter's palm squeezed to a sliver and turned
// inside-out mid-animation while the thumb swept across it (measured: palm
// area fell to 0-7% of its endpoints for all 24 static letters; now it never
// drops below them). That was the "impossible movement" in live QA and
// checklist #16's N "sliver". tools/ci-check.mjs guards it.
export const NEUTRAL_HAND = [
  [0.0, 0.0], [0.16, -0.09], [0.31, -0.2], [0.42, -0.31], [0.52, -0.41],
  [0.1, -0.42], [0.12, -0.63], [0.13, -0.77], [0.14, -0.9],
  [-0.02, -0.45], [-0.02, -0.67], [-0.02, -0.82], [-0.02, -0.96],
  [-0.14, -0.42], [-0.16, -0.62], [-0.17, -0.76], [-0.18, -0.88],
  [-0.25, -0.36], [-0.29, -0.52], [-0.31, -0.63], [-0.33, -0.73],
];

// start handshapes for the motion letters (wrist ~origin, +y down, span units)
// I = fist + pinky extended up;  POINT = fist + index extended up
const I_HAND = [
  [0.0, 0.0],
  [-0.17, -0.05], [-0.25, -0.13], [-0.22, -0.21], [-0.15, -0.25],
  [-0.10, -0.30], [-0.10, -0.15], [-0.08, -0.05], [-0.06, 0.02],
  [0.02, -0.32], [0.02, -0.15], [0.02, -0.04], [0.02, 0.03],
  [0.13, -0.30], [0.13, -0.13], [0.12, -0.03], [0.11, 0.03],
  [0.22, -0.34], [0.24, -0.60], [0.25, -0.80], [0.26, -0.98],
];
// (thumb on the index side, like I_HAND — it used to sit on the pinky side,
// a hand that can't exist from either view)
const POINT_HAND = [
  [0.0, 0.0],
  [-0.16, -0.05], [-0.25, -0.13], [-0.22, -0.21], [-0.15, -0.25],
  [-0.08, -0.34], [-0.08, -0.60], [-0.08, -0.80], [-0.08, -0.98],
  [0.03, -0.32], [0.03, -0.15], [0.03, -0.04], [0.03, 0.03],
  [0.14, -0.30], [0.14, -0.13], [0.13, -0.03], [0.12, 0.03],
  [0.23, -0.28], [0.23, -0.12], [0.22, -0.03], [0.21, 0.03],
];
const MOTION_POSE = { J: { hand: I_HAND, tip: 20 }, Z: { hand: POINT_HAND, tip: 8 } };

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// --- J: the rigid "I" hand, its pinky riding STROKE.J (2026-09-24) -------
// Live QA: "the mannequin video guide shows one way and the skeleton overlay
// guide shows something completely different". The demo used to rotate the
// I-hand 95° flat around a separately-authored wrist arc — its pinky swept
// like a clock hand from 12 to 9 — while the on-camera guide (overlay.js
// drawMotionGuide) draws STROKE.J, a real letter J. Now STROKE.J is the one
// source of truth: at every moment the pinky tip sits exactly on that path
// (arc-length paced), and the hand twists gradually into the hook (-50°,
// the visible part of the forearm supination) instead of spinning flat.
const J_THETA_TO = (-50 * Math.PI) / 180;
const J_ROT_START = 0.45; // straight downstroke first, then twist into the hook
const J_TIP = 20;
const J_PATH = (() => {
  // dense Catmull-Rom sampling of STROKE.J + cumulative arc length
  const pts = [], len = [0];
  for (let i = 0; i <= 120; i++) pts.push(catmullRom2D(STROKE.J, i / 120));
  for (let i = 1; i < pts.length; i++)
    len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len, total: len.at(-1) };
})();
function jTipAt(f) {
  const target = Math.max(0, Math.min(1, f)) * J_PATH.total;
  let i = 1;
  while (i < J_PATH.len.length - 1 && J_PATH.len[i] < target) i++;
  const a = J_PATH.pts[i - 1], b = J_PATH.pts[i];
  const seg = J_PATH.len[i] - J_PATH.len[i - 1] || 1e-9;
  const u = (target - J_PATH.len[i - 1]) / seg;
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
}
// exported for tools/ci-check.mjs: the demo's pinky must ride STROKE.J
export const J_DEMO = { poseAt: (f) => jPoseAt(f), tip: J_TIP };
function jPoseAt(f) {
  const e = easeInOut(Math.max(0, Math.min(1, f)));
  const theta = J_THETA_TO * delayedEase(e, J_ROT_START, easeInOut);
  // place the wrist so the rotated hand's pinky tip lands on the path
  const off = rotate2D([I_HAND[J_TIP][0] - I_HAND[0][0], I_HAND[J_TIP][1] - I_HAND[0][1]], theta);
  const tip = jTipAt(e);
  return rigidPoseAt(I_HAND, theta, [tip[0] - off[0], tip[1] - off[1]]);
}

// Sample a `poseAt(f)` motion's fingertip once (pure function of f, no
// per-frame cost) into a plain polyline — this trail IS the derived path,
// used for the faint dashed guide and the bright progress trail.
function sampleTrail(poseAt, tip, n = 40) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(poseAt(i / n)[tip]);
  return pts;
}

// --- Z: stays a translation, plus a wrist cock at each corner (S2d) -------
// A real wrist visibly flicks at each direction change; STROKE.Z's three
// waypoints are converted to arc-length fractions once (module load) so the
// cock lands exactly at each corner regardless of segment length.
const Z_FRACS = arcFractions(STROKE.Z);
const Z_COCK_DEG = 8;
const Z_COCK_WIDTH = 0.1;
function zCockRad(prog) {
  const c1 = bump(prog, Z_FRACS[1], Z_COCK_WIDTH) * Z_COCK_DEG;
  const c2 = bump(prog, Z_FRACS[2], Z_COCK_WIDTH) * Z_COCK_DEG;
  return ((c1 - c2) * Math.PI) / 180;
}

// --- Word-level coarticulation (S2e) --------------------------------------
// Spelling a whole word by replaying the single-letter FORM->HOLD->BACK cycle
// per letter (the old approach) forces every letter through NEUTRAL_HAND, so
// a fast word looks like a neutral-hand flicker rather than one hand moving
// letter to letter. `setWord` instead chains letters directly in bone space
// (posekin.js's `makeInterpolator`, already built for S2b) with no neutral
// detour, timing each transition from how big a reconfiguration it actually
// is rather than a fixed duration.
//
// Scope: this only ever receives runs of STATIC letters — main.js splits a
// word at any J/Z (see `playWord`) since a stroke letter has no single target
// shape to chain through in bone space. Those letters keep today's existing
// single-letter treatment; only the naturalness of multi-static-letter runs
// changes here (the common case — most fingerspelling is static letters).
const WORD_MIN_TRANS_MS = 90;
const WORD_MAX_TRANS_MS = 340;
const WORD_TRANS_BASE_MS = 90;
const WORD_TRANS_SCALE_MS = 260; // added per unit of angleDistance
const WORD_BLEND_BETA = 0.15; // how far a hold anticipates the next letter
const WORD_MIN_HOLD_MS = 60;
const WORD_BOUNCE_MS = 140; // a doubled letter's wrist-bounce duration
const WORD_BOUNCE_AMT = 0.07; // ~7% of hand span, per the plan's 6-8%

// A→B is a big reconfiguration and should take longer to read; U→V is a
// flick and shouldn't — derived from the shapes, not guessed.
export function wordTransDur(poseA, poseB) {
  const d = angleDistance(poseA, poseB);
  return Math.max(WORD_MIN_TRANS_MS, Math.min(WORD_MAX_TRANS_MS, WORD_TRANS_BASE_MS + WORD_TRANS_SCALE_MS * d));
}

// Build the span timeline for a run of static letters. `entries` is
// [{pose, z}, ...] for the letters themselves (NOT including the neutral
// lead-in — that's added here as entries[-1]); `doubled[i]` is true when
// entries[i] and entries[i+1] are the same letter (needs a bounce, not a
// bone-space blend, since blending a pose toward itself is a no-op that
// would otherwise make a doubled letter visually indistinguishable from a
// single one — a correctness bug in Read mode, not polish).
// Every letter (including the first) gets exactly `holdMs` of total time —
// so a run's total duration is always `entries.length * holdMs`, matching
// the caller's own per-letter timer spacing (main.js's `playWord`) with no
// extra bookkeeping on its side. The first letter's `holdMs` additionally
// has to pay for easing in from neutral, so its own hold portion shrinks by
// that amount instead of the entry being extra time tacked on top.
export function buildWordSpans(entries, doubled, holdMs) {
  const n = entries.length;
  const withNeutral = [{ pose: NEUTRAL_HAND, z: null }, ...entries];
  const spans = [];
  const letterStarts = []; // elapsed ms each letter's own hold begins — S3 transport step targets
  let clock = 0;

  for (let i = 0; i < n; i++) {
    const to = withNeutral[i + 1];
    const isLast = i === n - 1;
    const isDouble = !isLast && doubled[i];

    let entryInterp = null, entryDur = 0;
    if (i === 0) {
      entryInterp = makeInterpolator(withNeutral[0].pose, to.pose);
      entryDur = wordTransDur(withNeutral[0].pose, to.pose);
    }

    const transDur = isLast ? 0 : isDouble ? WORD_BOUNCE_MS : wordTransDur(to.pose, withNeutral[i + 2].pose);
    const holdDur = Math.max(WORD_MIN_HOLD_MS, holdMs - entryDur - transDur);

    if (i === 0) {
      // NEUTRAL_HAND has no z of its own — lerp depth in from flat (all 0),
      // same as a single static letter's own FORM phase (see `zAt` above).
      const zFrom = to.z ? to.z.map(() => 0) : null;
      spans.push({ kind: "move", startMs: clock, endMs: clock + entryDur, interp: entryInterp, from: 0, to: 1, zFrom, zTo: to.z });
      clock += entryDur;
    }

    letterStarts.push(clock);
    let holdInterp = null;
    if (!isLast && !isDouble) holdInterp = makeInterpolator(to.pose, withNeutral[i + 2].pose);
    spans.push({
      kind: "hold", startMs: clock, endMs: clock + holdDur,
      pose: to.pose, z: to.z, interp: holdInterp, beta: holdInterp ? WORD_BLEND_BETA : 0,
    });
    clock += holdDur;

    if (!isLast) {
      if (isDouble) {
        spans.push({ kind: "bounce", startMs: clock, endMs: clock + transDur, pose: to.pose, z: to.z });
      } else {
        spans.push({
          kind: "move", startMs: clock, endMs: clock + transDur,
          interp: holdInterp, from: WORD_BLEND_BETA, to: 1, zFrom: to.z, zTo: withNeutral[i + 2].z,
        });
      }
      clock += transDur;
    }
  }
  return { spans, totalMs: clock, letterStarts };
}

// Sample the timeline at `elapsedMs` -> { pose: 21[x,y], z: 21-number[]|null }.
export function sampleWordSpans(spans, elapsedMs) {
  const last = spans[spans.length - 1];
  const e = Math.max(0, Math.min(elapsedMs, last.endMs));
  let span = last;
  for (const s of spans) {
    if (e >= s.startMs && e <= s.endMs) { span = s; break; }
  }
  const len = span.endMs - span.startMs || 1;
  const localT = Math.max(0, Math.min(1, (e - span.startMs) / len));

  if (span.kind === "hold") {
    return { pose: span.interp ? span.interp(span.beta) : span.pose, z: span.z };
  }
  if (span.kind === "bounce") {
    const amt = WORD_BOUNCE_AMT * Math.sin(Math.PI * localT);
    return { pose: translatePose(span.pose, [0, amt]), z: span.z };
  }
  // "move"
  const t = span.from + (span.to - span.from) * easeOutBack(localT);
  const z = span.zFrom && span.zTo
    ? span.zFrom.map((z0, i) => z0 + (span.zTo[i] - z0) * Math.max(0, Math.min(1, localT)))
    : null;
  return { pose: span.interp(t), z };
}

// Plays a short looping animation in a panel canvas: the hand eases from a
// relaxed open pose into the target letter, holds, then resets — a "how they
// did it" clip instead of a static picture. Falls back to a still diagram when
// the viewer prefers reduced motion.
export function createCanonicalPlayer(canvasEl) {
  // Read once AND stay live (see fx.js/bg.js's identical fix) — deliberately
  // conservative here though: this only updates the variable, it doesn't
  // reach into an already-running rAF loop to force-cancel it mid-animation.
  // The many setTarget/setMotion/setWord entry points below already each
  // check `reduce` and branch correctly, so the very next one naturally
  // picks up a live toggle; forcibly interrupting a running clip mid-way
  // (multiple stroke/word paint variants, each with their own resume state)
  // isn't worth the risk here for a fairly rare event (toggling OS-level
  // reduced-motion mid-session).
  const motionQuery = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)");
  let reduce = motionQuery ? motionQuery.matches : false;
  motionQuery?.addEventListener?.("change", (e) => { reduce = e.matches; });
  const ctx = canvasEl.getContext("2d");
  let target = null; // 21 [x,y] from the centroid
  let stroke = null; // for J/Z: { path:[[x,y]...], pose:[21 x,y], tip:idx, poseAt0 }
  let word = null; // for setWord (S2e): { spans, totalMs } from buildWordSpans
  let fit = null; // cached [x,y] -> [px,py] closure — rebuilt only on
                   // setTarget/setMotion/resize, never per animation frame
                   // (see skeleton.js's makeFit for why that matters)
  let poseInterp = null; // cached t -> 21 [x,y] from posekin.js — built once
                          // per setTarget() call, not per frame (see posekin.js:
                          // interpolating bone angles instead of raw x,y is what
                          // makes a curling finger sweep an arc instead of
                          // cutting a straight chord through space)
  let targetZ = null; // 21 raw z values from the centroid, or null. NEUTRAL_HAND
                       // has no z of its own (a flat/frontal placeholder pose,
                       // z=0 for every landmark), so depth is a plain per-landmark
                       // lerp from 0 up to the target's real z — rendering-only,
                       // never touches posekin's 2D geometry.
  let raf = 0;
  let t0 = 0;
  let paused = false; // S3 transport — word mode only; freezes the loop, remembers elapsed
  let pausedElapsed = 0;

  const FORM = 800; // ease in (snappier)
  const HOLD = 1400; // sit at the target
  const BACK = 400; // ease back to neutral (static letters only — see below)
  const REST = 300; // pause before looping
  const CYCLE = FORM + HOLD + BACK + REST;

  // For a STATIC letter, easing back through the same finger-curl arc to
  // neutral is just a visual reset — there's no real "how you get to D"
  // lesson being taught, so retracing it is harmless.
  function phaseFrac(elapsed) {
    const t = elapsed % CYCLE;
    if (t < FORM) return easeInOut(t / FORM);
    if (t < FORM + HOLD) return 1;
    if (t < FORM + HOLD + BACK) return 1 - easeInOut((t - FORM - HOLD) / BACK);
    return 0;
  }

  // J/Z strokes are different: retracing the SAME path backward visually
  // teaches a motion that doesn't exist (S2d, live QA: "Skeletal video
  // guides for dynamic letters ... show anatomically impossible ...
  // movements"). FADE replaces that reverse-retrace with a hold->crossfade->
  // restart: the finished-stroke hand fades out while the about-to-restart
  // hand fades in, both held still — no implied backward motion at all.
  const S_FORM = 800;
  const S_HOLD = 1400;
  const S_FADE = 400;
  const S_REST = 300;
  const S_CYCLE = S_FORM + S_HOLD + S_FADE + S_REST;

  function strokePhase(elapsed) {
    const t = elapsed % S_CYCLE;
    if (t < S_FORM) return { mode: "prog", prog: easeInOut(t / S_FORM) };
    if (t < S_FORM + S_HOLD) return { mode: "prog", prog: 1 };
    if (t < S_FORM + S_HOLD + S_FADE) {
      const f = easeInOut((t - S_FORM - S_HOLD) / S_FADE);
      return { mode: "fade", outAlpha: 1 - f, inAlpha: f };
    }
    return { mode: "prog", prog: 0 };
  }

  // a transform mapping normalised [x,y] (wrist ~origin) into canvas px so that
  // `bounds` (a superset of everything we'll draw) fills the canvas with padding
  function fitFor(bounds) {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const [x, y] of bounds) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const w = canvasEl.width, h = canvasEl.height, pad = 0.16;
    const s = Math.min(
      (w * (1 - 2 * pad)) / (maxX - minX || 1),
      (h * (1 - 2 * pad)) / (maxY - minY || 1)
    );
    const ox = (w - (maxX - minX) * s) / 2 - minX * s;
    const oy = (h - (maxY - minY) * s) / 2 - minY * s;
    return ([x, y]) => [x * s + ox, y * s + oy];
  }

  // Rebuild the cached `fit` closure from whichever bounds are currently
  // relevant — called on setTarget/setMotion and on resize (redraw()), never
  // from inside the animation loop. Static poses anchor the wrist so it stays
  // planted as the hand curls (kills the swell/drift — see makeFit); a J/Z
  // stroke keeps the old centered whole-path fit (the "wrist" moves along the
  // path, so anchoring it to a fixed canvas point would be wrong), just
  // computed once instead of every frame.
  function rebuildFit() {
    if (word) {
      // one fit for the whole word (wrist-anchored, like a single static
      // letter) so the hand never rescales/re-anchors between letters
      fit = makeFit(word.bounds, canvasEl.width, canvasEl.height, {
        pad: 0.18,
        anchorAt: [0.5, 0.82],
      });
    } else if (stroke && stroke.kind === "rotate") {
      // trail already sweeps the fingertip's full extent; the two endpoint
      // poses cover the rest of the hand at min/max rotation
      fit = fitFor(stroke.trail.concat(jPoseAt(0)).concat(jPoseAt(1)));
    } else if (stroke) {
      // include the hand at the END of the path too — the still diagram draws
      // it there, and the Z end hand was being cut off the bottom
      const P = stroke.path, d = [P.at(-1)[0] - P[0][0], P.at(-1)[1] - P[0][1]];
      fit = fitFor(P.concat(stroke.poseAt0, stroke.poseAt0.map(([x, y]) => [x + d[0], y + d[1]])));
    } else if (target) {
      fit = makeFit(NEUTRAL_HAND.concat(target), canvasEl.width, canvasEl.height, {
        pad: 0.18,
        anchorAt: [0.5, 0.82],
      });
    } else {
      fit = null;
    }
  }

  // sample a polyline at fraction f (0..1) of its arc length
  function along(pts, f) {
    let total = 0;
    const seg = [];
    for (let i = 1; i < pts.length; i++) {
      const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      seg.push(d);
      total += d;
    }
    const targetLen = Math.max(0, Math.min(1, f)) * total;
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      if (acc + seg[i - 1] >= targetLen || i === pts.length - 1) {
        const t = seg[i - 1] ? (targetLen - acc) / seg[i - 1] : 0;
        return [
          pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]),
          pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]),
        ];
      }
      acc += seg[i - 1];
    }
    return pts.at(-1).slice();
  }

  // shared faint dashed guide line, used by both stroke kinds
  function drawGhostPath(px) {
    const w = canvasEl.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(148, 163, 184, 0.4)";
    ctx.lineWidth = Math.max(2.5, w * 0.022);
    ctx.setLineDash([w * 0.045, w * 0.045]);
    ctx.beginPath();
    px.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // numbered waypoints at Z's hand-authored corners — learners mirror Z
  // constantly, so showing the stroke order (not just its shape) helps.
  function drawWaypoints(px) {
    const w = canvasEl.width;
    px.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p[0], p[1], Math.max(6, w * 0.028), 0, Math.PI * 2);
      ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
      ctx.fill();
      ctx.strokeStyle = "rgba(148, 163, 184, 0.7)";
      ctx.lineWidth = Math.max(1, w * 0.006);
      ctx.stroke();
      ctx.fillStyle = "#e2e8f0";
      ctx.font = `${Math.max(9, Math.round(w * 0.035))}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), p[0], p[1]);
    });
  }

  // a small triangle at `at`, pointing along the path's current direction of
  // travel — Z's corners are easy to mirror backward without this
  function drawArrowhead(at, dir) {
    const w = canvasEl.width;
    const len = Math.max(9, w * 0.045);
    ctx.save();
    ctx.translate(at[0], at[1]);
    ctx.rotate(dir);
    ctx.fillStyle = "#38bdf8";
    ctx.beginPath();
    ctx.moveTo(len, 0);
    ctx.lineTo(-len * 0.5, len * 0.45);
    ctx.lineTo(-len * 0.5, -len * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // J: the rigid "I" hand rotating around its gliding wrist. The dashed
  // guide + bright trail are `stroke.trail`, sampled once from the same
  // motion this draws — a derived path, not an authored one (S2d part 2).
  function paintRotateStroke(prog) {
    const w = canvasEl.width;
    const { trail, tip } = stroke;
    const px = trail.map(fit);
    drawGhostPath(px);

    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = Math.max(3, w * 0.03);
    ctx.beginPath();
    for (let s = 0; s <= 24; s++) {
      const p = along(px, (s / 24) * prog);
      s ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
    }
    ctx.stroke();

    const pose = stroke.getPose(prog).map(fit);
    drawHandShape(ctx, pose);
    const tipNow = pose[tip];
    ctx.fillStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.arc(tipNow[0], tipNow[1], Math.max(4, w * 0.035), 0, Math.PI * 2);
    ctx.fill();
    // which way to go — same arrowhead Z gets (the camera guide has one too)
    if (prog > 0.02 && prog < 0.98) {
      const ahead = along(px, Math.min(1, prog + 0.04));
      const behind = along(px, Math.max(0, prog - 0.04));
      drawArrowhead(tipNow, Math.atan2(ahead[1] - behind[1], ahead[0] - behind[0]));
    }
  }

  function paintRotateCrossfade(outAlpha, inAlpha) {
    const w = canvasEl.width;
    const { trail, tip } = stroke;
    drawGhostPath(trail.map(fit));
    const drawAt = (prog, alpha) => {
      if (alpha <= 0.01) return;
      const pose = stroke.getPose(prog).map(fit);
      drawHandShape(ctx, pose, { alpha });
      const tipNow = pose[tip];
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#e2e8f0";
      ctx.beginPath();
      ctx.arc(tipNow[0], tipNow[1], Math.max(4, w * 0.035), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    drawAt(1, outAlpha);
    drawAt(0, inAlpha);
  }

  // Z: the START handshape translated along STROKE.Z, plus a small wrist
  // cock at each corner and a direction arrowhead (S2d).
  function paintTranslateStroke(prog) {
    const w = canvasEl.width;
    const { path, poseAt0, tip } = stroke;
    const px = path.map(fit);
    drawGhostPath(px);
    drawWaypoints(px);

    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = Math.max(3, w * 0.03);
    ctx.beginPath();
    for (let s = 0; s <= 24; s++) {
      const p = along(px, (s / 24) * prog);
      s ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]);
    }
    ctx.stroke();

    const tipNow = along(px, prog);
    const cock = stroke.cockAt ? stroke.cockAt(prog) : 0;
    const cocked = cock ? rigidPoseAt(poseAt0, cock, poseAt0[0]) : poseAt0;
    const poseFit = cocked.map(fit);
    const dx = tipNow[0] - poseFit[tip][0];
    const dy = tipNow[1] - poseFit[tip][1];
    drawHandShape(ctx, poseFit.map(([x, y]) => [x + dx, y + dy]));
    ctx.fillStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.arc(tipNow[0], tipNow[1], Math.max(4, w * 0.035), 0, Math.PI * 2);
    ctx.fill();

    if (prog > 0.02 && prog < 0.98) {
      const ahead = along(px, Math.min(1, prog + 0.04));
      const behind = along(px, Math.max(0, prog - 0.04));
      drawArrowhead(tipNow, Math.atan2(ahead[1] - behind[1], ahead[0] - behind[0]));
    }
  }

  function paintTranslateCrossfade(outAlpha, inAlpha) {
    const { path, poseAt0, tip } = stroke;
    const px = path.map(fit);
    drawGhostPath(px);
    drawWaypoints(px);

    const poseFit = poseAt0.map(fit);
    const drawAt = (prog, alpha) => {
      if (alpha <= 0.01) return;
      const tipNow = along(px, prog);
      const dx = tipNow[0] - poseFit[tip][0];
      const dy = tipNow[1] - poseFit[tip][1];
      drawHandShape(ctx, poseFit.map(([x, y]) => [x + dx, y + dy]), { alpha });
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#e2e8f0";
      ctx.beginPath();
      ctx.arc(tipNow[0], tipNow[1], Math.max(4, canvasEl.width * 0.035), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    };
    drawAt(1, outAlpha); // the just-finished hand, fading out
    drawAt(0, inAlpha); // the about-to-restart hand, fading in
  }

  // J/Z: dispatches to the rotate (J) or translate (Z) kind — see each
  // paint*Stroke above.
  function paintStroke(prog) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!fit) return;
    if (stroke.kind === "rotate") paintRotateStroke(prog);
    else paintTranslateStroke(prog);
  }

  // The S_FADE phase: no path retrace, just the finished-stroke hand fading
  // out at prog=1 while the about-to-restart hand fades in at prog=0, both
  // held perfectly still. Same faint dashed guide path stays put throughout
  // for orientation.
  function paintStrokeCrossfade(outAlpha, inAlpha) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!fit) return;
    if (stroke.kind === "rotate") paintRotateCrossfade(outAlpha, inAlpha);
    else paintTranslateCrossfade(outAlpha, inAlpha);
  }

  // poseInterp(frac) -> pixel points through the cached `fit`, so the ghost
  // trail and the solid hand share the exact same anchor/scale instead of
  // each refitting its own bbox (that mismatch was D3 — the ghost drifting
  // separately from the hand it's supposed to be trailing). poseInterp
  // itself comes from posekin.js: bone-angle interpolation, not raw x,y lerp
  // (D1) — a curling finger sweeps an arc instead of cutting a chord.
  function poseAtPixels(frac) {
    return poseInterp(frac).map(fit);
  }

  // Depth at a given progress — a plain per-landmark lerp from the implicit
  // flat neutral (z=0) up to the target's real z (see skeleton.js's
  // drawHandShape `depth` option for what this actually drives: paint order,
  // perspective width, conditional nails, gradient axis).
  function zAt(frac) {
    if (!targetZ) return null;
    const e = Math.max(0, Math.min(1, frac));
    return targetZ.map((tz) => tz * e);
  }

  function paint(frac) {
    if (stroke) { paintStroke(frac); return; }
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx.clearRect(0, 0, w, h); // full clear every frame — no after-image
    if (!target || !fit || !poseInterp) return;
    // one faint trailing hand so you read the movement, then the solid hand
    if (!reduce) {
      const gFrac = Math.max(0, frac - 0.09);
      drawHandShape(ctx, poseAtPixels(gFrac), {
        alpha: 0.18,
        nails: false,
        depth: targetZ ? { z: zAt(gFrac) } : null,
      });
    }
    drawHandShape(ctx, poseAtPixels(frac), {
      depth: targetZ ? { z: zAt(frac) } : null,
    });
  }

  // S2e: one hand moving letter-to-letter, no per-letter ghost trail (the
  // trail reads as "how THIS letter forms," which doesn't apply once the
  // hand is already mid-word) — plays once through and freezes on the last
  // letter (sampleWordSpans clamps past `totalMs`), same as a single static
  // letter's HOLD; the caller clears it via setTarget/setMotion/setWord(null).
  function paintWordAt(elapsed) {
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    if (!fit) return;
    const { pose, z } = sampleWordSpans(word.spans, elapsed);
    drawHandShape(ctx, pose.map(fit), { depth: z ? { z } : null });
  }

  // skip repainting an identical frame: a static letter spends most of its
  // cycle on a still HOLD (frac 1) or rest (frac 0), and a word freezes on
  // its last letter after totalMs — the pixels don't change, so don't redraw
  // them 60-120 times a second. Reset to null whenever what's shown changes.
  let lastPaintKey = null;
  // perf (owner: lag spikes): the demo hand is a slow, smooth motion — 30 fps
  // is plenty. It used to redraw at the display rate (120 Hz on ProMotion)
  // during every move phase.
  let lastPaintTs = 0;
  function loop(ts) {
    raf = requestAnimationFrame(loop);
    if (ts - lastPaintTs < 32) return;
    lastPaintTs = ts;
    if (!t0) t0 = ts;
    const elapsed = ts - t0;
    if (word) {
      const key = elapsed >= word.totalMs ? "end" : elapsed;
      if (key !== lastPaintKey) paintWordAt(elapsed);
      lastPaintKey = key;
    } else if (stroke) {
      const ph = strokePhase(elapsed);
      if (ph.mode === "fade") paintStrokeCrossfade(ph.outAlpha, ph.inAlpha);
      else paintStroke(ph.prog);
    } else {
      const f = phaseFrac(elapsed);
      if (f !== lastPaintKey) paint(f);
      lastPaintKey = f;
    }
  }

  return {
    setTarget(vec) {
      stroke = null;
      word = null;
      paused = false;
      if (!vec) {
        target = null;
        poseInterp = null;
        targetZ = null;
        fit = null;
        cancelAnimationFrame(raf);
        raf = 0;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        return;
      }
      target = [];
      targetZ = [];
      for (let i = 0; i < 21; i++) {
        // target carries z now too — posekin.js's makeInterpolator uses it to
        // interpolate each bone's true 3D direction instead of its 2D
        // projection, so a finger that curls substantially in depth (every
        // fist-shaped letter, confirmed empirically) sweeps that depth
        // rotation instead of an exaggerated in-plane swing (checklist item
        // 7 — the W/R/X/K/V "anatomically impossible" animation). NEUTRAL_HAND
        // has no z of its own; posekin treats a 2-element point as z=0.
        target.push([vec[i * 3], vec[i * 3 + 1], vec[i * 3 + 2]]);
        targetZ.push(vec[i * 3 + 2] ?? 0);
      }
      poseInterp = makeInterpolator(NEUTRAL_HAND, target);
      rebuildFit();
      t0 = 0;
      lastPaintKey = null;
      if (reduce) {
        cancelAnimationFrame(raf);
        raf = 0;
        paint(1); // just the finished shape
      } else if (!raf) {
        raf = requestAnimationFrame(loop);
      }
    },
    // J / Z: loop the letter's stroke — J as a rotation, Z as a translation
    setMotion(letter) {
      target = null;
      poseInterp = null;
      targetZ = null;
      word = null;
      paused = false;
      if (letter === "J") {
        stroke = { kind: "rotate", getPose: jPoseAt, tip: MOTION_POSE.J.tip, trail: sampleTrail(jPoseAt, MOTION_POSE.J.tip) };
      } else {
        const p = STROKE[letter], pose = MOTION_POSE[letter];
        if (p && pose) {
          // the hand's fingertip should land on path[0] at the start, so the
          // bounds to fit = the path + the pose shifted so pose[tip] == path[0]
          const off = [p[0][0] - pose.hand[pose.tip][0], p[0][1] - pose.hand[pose.tip][1]];
          const poseAt0 = pose.hand.map(([x, y]) => [x + off[0], y + off[1]]);
          stroke = {
            kind: "translate", path: p, pose: pose.hand, tip: pose.tip, poseAt0,
            cockAt: letter === "Z" ? zCockRad : null,
          };
        } else {
          stroke = null;
        }
      }
      if (!stroke) {
        fit = null;
        cancelAnimationFrame(raf);
        raf = 0;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        return;
      }
      rebuildFit();
      t0 = 0;
      lastPaintKey = null;
      if (reduce) { cancelAnimationFrame(raf); raf = 0; paint(1); }
      else if (!raf) raf = requestAnimationFrame(loop);
    },
    // A still "how to trace it" diagram for J / Z, drawn in the signer's
    // (selfie) view: the whole path, direction arrows along it, the hand
    // faded at the start and solid at the end, Z's numbered corners.
    // main.js shows it in place of the reference photo for motion letters —
    // the photos are one ambiguous frame of a motion, in the viewer's view
    // (2026-09-24 live QA: "the photo has a straight finger ... confusing on
    // how to make the zig zag"). Returns true if it drew something.
    diagram(letter) {
      this.setMotion(letter);
      cancelAnimationFrame(raf);
      raf = 0;
      if (!stroke || !fit) return false;
      paintStroke(1); // full trail + the end hand
      const px = (stroke.kind === "rotate" ? stroke.trail : stroke.path).map(fit);
      const start = (stroke.kind === "rotate" ? stroke.getPose(0) : stroke.poseAt0).map(fit);
      drawHandShape(ctx, start, { alpha: 0.35, nails: false });
      for (const f of [0.18, 0.5, 0.82]) {
        const at = along(px, f);
        const ahead = along(px, Math.min(1, f + 0.03));
        const behind = along(px, Math.max(0, f - 0.03));
        drawArrowhead(at, Math.atan2(ahead[1] - behind[1], ahead[0] - behind[0]));
      }
      return true;
    },
    // S2e: a run of STATIC letters (main.js's `playWord` splits a word at
    // any J/Z before calling this — see the module comment above
    // `buildWordSpans`), chained letter-to-letter in bone space instead of
    // detouring through neutral each time. `items`: [{letter, vec}], where
    // `vec` is the same flattened 21x3 shape `setTarget` takes.
    // `opts.holdMs`: the per-letter time budget (old `#rdSpeed`'s role) —
    // NOT the transition duration, which is derived from the shapes.
    setWord(items, opts = {}) {
      stroke = null;
      target = null;
      poseInterp = null;
      targetZ = null;
      if (!items || !items.length) {
        word = null;
        fit = null;
        cancelAnimationFrame(raf);
        raf = 0;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        return;
      }
      const holdMs = Math.max(150, opts.holdMs || 700);
      const entries = items.map((it) => {
        const pose = [], z = [];
        for (let i = 0; i < 21; i++) {
          // [x, y, z]: posekin interpolates each bone's TRUE 3D direction, the
          // same as setTarget (checklist #7). This path still passed 2D only,
          // so Read's hand kept the old in-plane "impossible" finger swings
          // (2026-09-24 live QA: "read mode still using the outdated
          // mannequin model").
          pose.push([it.vec[i * 3], it.vec[i * 3 + 1], it.vec[i * 3 + 2] ?? 0]);
          z.push(it.vec[i * 3 + 2] ?? 0);
        }
        return { pose, z };
      });
      const doubled = items.map((it, i) => i < items.length - 1 && it.letter === items[i + 1].letter);
      const built = buildWordSpans(entries, doubled, holdMs);
      word = {
        spans: built.spans, totalMs: built.totalMs, letterStarts: built.letterStarts,
        bounds: NEUTRAL_HAND.concat(...entries.map((e) => e.pose)),
      };
      rebuildFit();
      t0 = 0;
      lastPaintKey = null;
      paused = false;
      if (reduce) {
        cancelAnimationFrame(raf);
        raf = 0;
        paintWordAt(word.totalMs); // just the finished word, on its last letter
      } else if (!raf) {
        raf = requestAnimationFrame(loop);
      }
    },
    // S3 transport (word mode) — pause/resume/seek so a learner who missed
    // letter 4 of 7 can go back to exactly that letter instead of rewatching
    // the whole word. No-ops outside word mode (single-letter practice and
    // J/Z strokes are short loops with no "missed a spot" problem to solve).
    pause() {
      if (!word || paused || !raf) return;
      pausedElapsed = t0 ? performance.now() - t0 : 0;
      paused = true;
      cancelAnimationFrame(raf);
      raf = 0;
    },
    resume() {
      if (!word || !paused) return;
      paused = false;
      raf = requestAnimationFrame((ts) => {
        t0 = ts - pausedElapsed;
        loop(ts);
      });
    },
    isPaused() {
      return paused;
    },
    // current position into the word, for a UI scrub bar to sync against
    // while playing (not just while the user is dragging it)
    elapsedMs() {
      if (!word) return 0;
      if (paused) return pausedElapsed;
      return raf ? performance.now() - t0 : 0;
    },
    // jump to `ms` into the word; works whether playing or paused
    seek(ms) {
      if (!word) return;
      pausedElapsed = Math.max(0, Math.min(ms, word.totalMs));
      if (paused || !raf) {
        paintWordAt(pausedElapsed);
      } else {
        t0 = performance.now() - pausedElapsed;
      }
    },
    // { totalMs, letterStarts } for the scrub bar / step buttons, or null
    // outside word mode
    wordInfo() {
      return word ? { totalMs: word.totalMs, letterStarts: word.letterStarts.slice() } : null;
    },
    // re-draw after a canvas resize without restarting the cycle
    redraw() {
      rebuildFit();
      lastPaintKey = null;
      if (reduce) {
        if (word) paintWordAt(word.totalMs);
        else paint(1);
      }
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
