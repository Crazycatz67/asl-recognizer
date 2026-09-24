// =============================================================================
// js/onefilter.js — One Euro landmark smoothing filter (Engine, DOM-free)
// =============================================================================
// WHAT: The One Euro Filter (Casiez, Roussel & Vogel, 2012;
//   https://gery.casiez.net/1euro/). Pure math, no DOM: an adaptive low-pass
//   filter that trades off jitter vs. lag based on how fast the signal is
//   currently moving, instead of a single fixed compromise.
//
// WHY: The tracker's raw hand landmarks jitter frame to frame even when the
//   hand is dead still (sensor/model noise), so main.js has always smoothed
//   them — previously with a fixed-alpha EMA (constant blend weight regardless
//   of speed). A fixed alpha has to compromise: heavy enough to kill
//   still-hand jitter, but that same heaviness adds visible lag once the hand
//   actually moves ("ghosting" — the drawn skeleton visibly trailing the real
//   hand). One-euro instead widens its own cutoff frequency (== responds
//   faster, smooths less) in proportion to the signal's estimated velocity:
//   nearly motionless -> heavy smoothing; moving fast -> mostly raw, low lag.
//
// PIPELINE: webcam → MediaPipe → [onefilter.js] → normalize → kNN → …
//   main.js smoothLandmarks() filters the first hand each frame; the smoothed
//   landmarks feed drawing, motion.js (J/Z), normalize/kNN and transition.js.
//   swipe.js and twohand.js deliberately get the RAW landmarks instead —
//   smoothing damps exactly the fast motion those gestures are made of.
//
// PUBLIC API:
//   const oef = createLandmarkFilter({ mincutoff, beta, dcutoff });
//   oef.filter(landmarks, tSeconds) -> filtered landmarks (or null)
//   oef.reset()                      -> forget history (call on hand-lost)
//
// UNITS: t is in SECONDS (main.js divides performance.now() ms by 1000);
//   mincutoff/dcutoff are Hz; beta is Hz per (landmark unit / second). The
//   live values come from config.js ONE_EURO_* — see the comment there on
//   why they're an informed starting guess, not a measured optimum.
//
// GOTCHA: after a reset (or a change in point count) the first TWO samples
//   pass through unfiltered — the first only builds the channels (without
//   stepping them), the second seeds each channel's history. Filtering
//   starts on the third.

// ---- scalar filter math ----

// alpha for a first-order low-pass filter at a given cutoff frequency (Hz)
// and sample interval dt (seconds) — this IS the one-euro paper's `alpha()`.
function lowPassAlpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

// One scalar channel's filter state (one of these per x/y/z per landmark).
function createChannel() {
  let xPrev = null;
  let dxPrev = 0;
  return {
    step(x, dt, mincutoff, beta, dcutoff) {
      if (xPrev === null) {
        xPrev = x;
        dxPrev = 0;
        return x;
      }
      // 1) low-pass the estimated derivative (a FIXED cutoff — this stage
      // only exists to de-noise the velocity estimate itself)
      const dx = (x - xPrev) / dt;
      const aD = lowPassAlpha(dcutoff, dt);
      const edx = dxPrev + aD * (dx - dxPrev);
      // 2) the adaptive part: cutoff widens with how fast we're moving
      const cutoff = mincutoff + beta * Math.abs(edx);
      const a = lowPassAlpha(cutoff, dt);
      const ex = xPrev + a * (x - xPrev);
      xPrev = ex;
      dxPrev = edx;
      return ex;
    },
    reset() {
      xPrev = null;
      dxPrev = 0;
    },
  };
}

// ---- public factory ----

// mincutoff/dcutoff are frequencies in Hz; beta scales the derivative
// (signal units per second) into an added cutoff — see config.js's
// ONE_EURO_* comment on why these three specific starting values are an
// informed guess, not a measured one. Handles a variable-length point array
// (built lazily on the first real sample) and a `null` input (hand lost) by
// forgetting state, the same contract main.js's old smoothLandmarks() had.
/**
 * Create a per-landmark One Euro filter (one channel per x, y and z).
 * @param {{mincutoff?: number, beta?: number, dcutoff?: number}} [opts]
 *   mincutoff: Hz cutoff while still; beta: added Hz per unit/s of speed;
 *   dcutoff: Hz cutoff used to de-noise the velocity estimate
 * @returns {{filter: (pts: ({x: number, y: number, z: number}[] | null), t: number)
 *   => ({x: number, y: number, z: number}[] | null), reset: () => void}}
 */
export function createLandmarkFilter({ mincutoff = 1.2, beta = 3.0, dcutoff = 1.0 } = {}) {
  let channels = null; // one createChannel() per (landmark, x|y|z)
  let lastT = null;

  function reset() {
    channels = null;
    lastT = null;
  }

  function filter(pts, t) {
    if (!pts) {
      reset();
      return null;
    }
    if (!channels || channels.length !== pts.length * 3) {
      channels = [];
      for (let i = 0; i < pts.length * 3; i++) channels.push(createChannel());
      lastT = t;
      return pts.map((p) => ({ x: p.x, y: p.y, z: p.z }));
    }
    // Guard a non-positive/duplicate timestamp (two frames landing in the
    // same millisecond) rather than dividing by zero or going negative.
    const dt = t > lastT ? t - lastT : 1e-3;
    lastT = t;
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const cx = channels[i * 3], cy = channels[i * 3 + 1], cz = channels[i * 3 + 2];
      out[i] = {
        x: cx.step(pts[i].x, dt, mincutoff, beta, dcutoff),
        y: cy.step(pts[i].y, dt, mincutoff, beta, dcutoff),
        z: cz.step(pts[i].z, dt, mincutoff, beta, dcutoff),
      };
    }
    return out;
  }

  return { filter, reset };
}
