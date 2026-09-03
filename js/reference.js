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
import { rotateVector, mirrorVector } from "./normalize.js";
import { STROKE } from "./motion.js";

// A casual wrist tilt isn't a spelling mistake, so before comparing a live hand
// to a letter we let it rotate up to this much to sit at the letter's own tilt.
// Kept small: a real mis-orientation (G/H point sideways, P points down) is tens
// of degrees off and still reads as wrong.
const ALIGN_MAX_DEG = 22;

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
// panel isn't just "copy this diagram". Kept to one or two sentences with a
// real-world image where there's a good one.
export const LETTER_GUIDE = {
  A: "Close your hand into a fist and lay your thumb flat along the outside, against your index finger — like a thumbs-up that never went up.",
  B: "Flat hand, fingers straight and pressed together pointing up, thumb folded across your palm — a little wall facing the camera.",
  C: "Curve your whole hand into the shape of a C, fingers together — as if you're holding a soda can.",
  D: "Point your index finger straight up; curl the other three down so their tips meet your thumb in a circle — a candle above its holder.",
  E: "Curl all four fingertips down to press against your thumb, knuckles facing forward — a closed claw.",
  F: "Touch the tip of your thumb to the tip of your index finger to make a small circle; the other three fingers stand up straight — the 'OK' sign.",
  G: "Hold your index finger and thumb out flat and parallel, pointing sideways, a small gap between them — pinching the air.",
  H: "Index and middle fingers together and straight, pointing sideways; thumb tucked, ring and pinky curled — two barrels laid flat.",
  I: "Stand your pinky straight up on its own; curl the rest into a fist — a tiny antenna.",
  K: "Index finger up, middle finger up and spread toward it, thumb pressed into the notch between them — a little catapult.",
  L: "Thumb straight out to the side, index finger straight up, the rest curled down — a clean capital L.",
  M: "Fold your first three fingers down over your thumb, so the thumb tip peeks out between your ring and pinky — three fingers over the thumb.",
  N: "Fold your first two fingers down over your thumb, so the thumb tip peeks out between your middle and ring finger — two fingers over the thumb.",
  O: "Bring all your fingertips and thumb together into a round O — like holding a single Cheerio.",
  P: "Make a K, then tip it forward so the index points down at the floor and the middle finger and thumb sit under it.",
  Q: "Point your thumb and index finger straight down toward the floor, a small gap between them — a downward pinch.",
  R: "Cross your middle finger tightly over the front of your index finger and hold both up; curl the rest — fingers twisted for 'good luck'.",
  S: "Make a fist and wrap your thumb across the front of your fingers — a knuckle punch.",
  T: "Make a fist and poke your thumb up between your index and middle finger.",
  U: "Index and middle fingers together and straight up; thumb holds the ring and pinky down — a two-prong fork.",
  V: "Index and middle fingers up in a spread V, the rest held down by the thumb — 'peace' or 'victory'.",
  W: "Index, middle and ring fingers spread and straight up; thumb pins the pinky down — three prongs.",
  X: "Hold your index finger up but bend it into a hook at the top knuckle; curl the rest — a beckoning finger.",
  Y: "Stretch your thumb and pinky out as far apart as they go; fold the three middle fingers down — 'hang loose'.",
  J: "Make the letter I (pinky up, rest in a fist), then trace a J in the air — swing the pinky down and hook it back toward you.",
  Z: "Point your index finger, then draw a Z in the air — across, diagonally down-left, then across again.",
};

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

    // per-joint normalized error that reads as "locked on" for the guide
    // colours. Derived from the letter's spread but clamped to a visually
    // meaningful range (a fingertip within ~4-12% of hand radius = on target).
    tolerance(label) {
      return tolFor(bands.get(label));
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

    score(liveVec, label) {
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
      const matched = worst <= tolFor(b) * 1.8;
      let bucket = s >= 0.7 ? "correct" : s >= 0.5 ? "close" : "off";
      if (bucket === "correct" && !matched) bucket = "close";
      return { dist: d, score: s, bucket, matched, worst, mirrored };
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
const NEUTRAL_HAND = [
  [0.0, 0.0], [-0.16, -0.09], [-0.31, -0.2], [-0.42, -0.31], [-0.52, -0.41],
  [-0.1, -0.42], [-0.12, -0.63], [-0.13, -0.77], [-0.14, -0.9],
  [0.02, -0.45], [0.02, -0.67], [0.02, -0.82], [0.02, -0.96],
  [0.14, -0.42], [0.16, -0.62], [0.17, -0.76], [0.18, -0.88],
  [0.25, -0.36], [0.29, -0.52], [0.31, -0.63], [0.33, -0.73],
];

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

// Plays a short looping animation in a panel canvas: the hand eases from a
// relaxed open pose into the target letter, holds, then resets — a "how they
// did it" clip instead of a static picture. Falls back to a still diagram when
// the viewer prefers reduced motion.
export function createCanonicalPlayer(canvasEl) {
  const reduce =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const ctx = canvasEl.getContext("2d");
  let target = null; // 21 [x,y] from the centroid
  let stroke = null; // for J/Z: an arc-length-resampled path to trace
  let raf = 0;
  let t0 = 0;

  const FORM = 800; // ease in (snappier)
  const HOLD = 1400; // sit at the target
  const BACK = 400; // ease back to neutral
  const REST = 300; // pause before looping
  const CYCLE = FORM + HOLD + BACK + REST;

  function phaseFrac(elapsed) {
    const t = elapsed % CYCLE;
    if (t < FORM) return easeInOut(t / FORM);
    if (t < FORM + HOLD) return 1;
    if (t < FORM + HOLD + BACK) return 1 - easeInOut((t - FORM - HOLD) / BACK);
    return 0;
  }

  // interpolated pose (flat x,y,z) at a given progress 0..1
  function poseAt(frac) {
    const out = [];
    for (let i = 0; i < 21; i++) {
      out.push(
        NEUTRAL_HAND[i][0] + (target[i][0] - NEUTRAL_HAND[i][0]) * frac,
        NEUTRAL_HAND[i][1] + (target[i][1] - NEUTRAL_HAND[i][1]) * frac,
        0
      );
    }
    return out;
  }

  // fit a list of [x,y] (normalised, wrist ~origin) to the canvas
  function fitPath(pts) {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const [x, y] of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const w = canvasEl.width, h = canvasEl.height, pad = 0.18;
    const sx = (w * (1 - 2 * pad)) / (maxX - minX || 1);
    const sy = (h * (1 - 2 * pad)) / (maxY - minY || 1);
    const s = Math.min(sx, sy);
    const ox = (w - (maxX - minX) * s) / 2 - minX * s;
    const oy = (h - (maxY - minY) * s) / 2 - minY * s;
    return pts.map(([x, y]) => [x * s + ox, y * s + oy]);
  }

  // J/Z: trace the stroke — full path faint, a bright head + fading trail
  function paintStroke(prog) {
    const w = canvasEl.width, h = canvasEl.height;
    ctx.clearRect(0, 0, w, h);
    const px = fitPath(stroke);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // faint full path
    ctx.strokeStyle = "rgba(148, 163, 184, 0.35)";
    ctx.lineWidth = Math.max(3, w * 0.03);
    ctx.beginPath();
    ctx.moveTo(px[0][0], px[0][1]);
    for (const p of px) ctx.lineTo(p[0], p[1]);
    ctx.stroke();
    // drawn-so-far, bright
    const upto = Math.max(1, Math.round(prog * (px.length - 1)));
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = Math.max(4, w * 0.04);
    ctx.beginPath();
    ctx.moveTo(px[0][0], px[0][1]);
    for (let i = 1; i <= upto; i++) ctx.lineTo(px[i][0], px[i][1]);
    ctx.stroke();
    // moving head
    const head = px[Math.min(px.length - 1, upto)];
    ctx.fillStyle = "#e2e8f0";
    ctx.beginPath();
    ctx.arc(head[0], head[1], Math.max(5, w * 0.05), 0, Math.PI * 2);
    ctx.fill();
  }

  function paint(frac) {
    if (stroke) { paintStroke(frac); return; }
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx.clearRect(0, 0, w, h); // full clear every frame — no after-image
    if (!target) return;
    // short motion trail: a few recent poses at low alpha so you read the
    // path of the movement, then the crisp current pose on top
    if (!reduce) {
      for (let k = 3; k >= 1; k--) {
        const f = Math.max(0, frac - k * 0.06);
        drawSkeleton(ctx, vectorToPixels(poseAt(f), w, h, { pad: 0.16 }), {
          stroke: "#38bdf8",
          joint: "#38bdf8",
          alpha: 0.1 + 0.05 * (3 - k),
          halo: null,
        });
      }
    }
    drawSkeleton(ctx, vectorToPixels(poseAt(frac), w, h, { pad: 0.16 }), {
      stroke: "#e2e8f0",
      joint: "#38bdf8",
      glow: 0.4,
    });
  }

  function loop(ts) {
    if (!t0) t0 = ts;
    paint(phaseFrac(ts - t0));
    raf = requestAnimationFrame(loop);
  }

  return {
    setTarget(vec) {
      stroke = null;
      if (!vec) {
        target = null;
        cancelAnimationFrame(raf);
        raf = 0;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        return;
      }
      target = [];
      for (let i = 0; i < 21; i++) target.push([vec[i * 3], vec[i * 3 + 1]]);
      t0 = 0;
      if (reduce) {
        cancelAnimationFrame(raf);
        raf = 0;
        paint(1); // just the finished shape
      } else if (!raf) {
        raf = requestAnimationFrame(loop);
      }
    },
    // J / Z: loop a fingertip tracing the letter's stroke
    setMotion(letter) {
      target = null;
      stroke = STROKE[letter] || null;
      if (!stroke) {
        cancelAnimationFrame(raf);
        raf = 0;
        ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        return;
      }
      t0 = 0;
      if (reduce) { cancelAnimationFrame(raf); raf = 0; paint(1); }
      else if (!raf) raf = requestAnimationFrame(loop);
    },
    // re-draw after a canvas resize without restarting the cycle
    redraw() {
      if (reduce) paint(1);
    },
    stop() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
