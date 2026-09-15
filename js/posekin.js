// js/posekin.js — bone-length-preserving interpolation over the hand's
// kinematic tree. Pure math, no DOM, no canvas: decompose a 21-landmark pose
// into (root, per-bone {len, direction}), then interpolate each bone's
// DIRECTION in 3D rather than raw x,y. A naive Cartesian lerp (the old
// poseAt() in reference.js) makes a curling finger cut a straight chord
// through space and lets bone lengths drift mid-animation; interpolating a
// fixed-length bone's direction instead makes it sweep the arc a real finger
// actually swings through, and pins every bone to one constant length for
// the whole clip — "same physical hand" the whole time.
//
// Landmark tree (MediaPipe hand topology): wrist (0) is the root. Five palm
// bones fan out from the wrist to each finger's base knuckle; each finger is
// then a 3-bone chain from its knuckle to its tip. The three cross-palm
// links (5-9, 9-13, 13-17) are drawn by skeleton.js but aren't part of this
// kinematic tree — they're rendered between wherever the driven knuckles
// land, never driven themselves.
//
// Why 3D, when everything on screen is 2D: a finger curling into a fist
// doesn't just rotate in the camera's image plane — a real letter centroid's
// z per landmark (already read for S2c's depth-cue rendering) shows the
// curl happens substantially IN DEPTH too (confirmed empirically: for a
// closed fist the index PIP-DIP bone's z-only contribution is a real,
// non-trivial fraction of its length, growing knuckle to tip). Interpolating
// the 2D PROJECTION of that motion in-plane forces the entire depth rotation
// to be represented as an exaggerated in-plane swing — for several
// fist-shaped letters that swing approaches 180 degrees on a single joint,
// which is anatomically impossible and reads as a finger flipping/bending
// backwards (the confirmed root cause of checklist item 7's still-open
// W/R/X/K/V case). Interpolating the true 3D bone direction and projecting
// the RESULT back to 2D lets that same motion happen mostly in depth, where
// it belongs, and the on-screen swing shrinks to whatever the real 2D
// component actually is.
//
// Poses may be given as 21 [x,y] pairs OR 21 [x,y,z] triples — z defaults to
// 0 when omitted (e.g. NEUTRAL_HAND, a hand-authored placeholder with no
// measured depth of its own — treated as facing the camera flat). When both
// poses fed to makeInterpolator have z=0 throughout, every bone direction
// lies in the z=0 plane and its 3D SLERP reduces to exactly the same
// shortest-arc in-plane rotation the old 2D implementation computed — this
// is a strict superset of the old behavior, not a divergent rewrite.

const PALM_BONES = [[0, 1], [0, 5], [0, 9], [0, 13], [0, 17]];
const CHAINS = [
  [1, 2, 3, 4],     // thumb
  [5, 6, 7, 8],     // index
  [9, 10, 11, 12],  // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];

// Shortest-arc angular difference, always in (-pi, pi]. No longer used
// internally (3D bone angles are compared via dot/cross products instead,
// which have no sign ambiguity to wrap), but kept exported as-is: it's a
// generically useful, independently-tested utility, and existing callers
// (tools/ci-check.mjs) exercise it directly.
export function wrap(d) {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

const toV3 = (p) => [p[0], p[1], p.length > 2 ? p[2] : 0];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale3 = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
function norm3(a) {
  const l = len3(a) || 1e-9;
  return [a[0] / l, a[1] / l, a[2] / l];
}

function bone3(pa, pb) {
  const d = sub3(pb, pa);
  return { len: len3(d), dir: norm3(d) };
}

// Spherical linear interpolation between two unit 3D vectors at fraction e —
// the 3D analogue of the old wrap()-based shortest-arc 2D angle lerp, with no
// sign ambiguity: the shortest rotation between two vectors is unique in 3D
// (the ±180-degree wraparound problem is specifically a 2D-signed-angle
// artifact). `e` is NOT clamped to [0,1] — the formula below extrapolates
// smoothly past either endpoint, which is what lets S2e's overshoot easing
// (briefly e>1) keep working exactly as it did with the old lerp.
function slerp3(a, b, e) {
  const d = Math.max(-1, Math.min(1, dot3(a, b)));
  const omega = Math.acos(d);
  // Near-parallel or near-antipodal: the great-circle axis is ill-conditioned
  // (or undefined, for exact antipodes). Fall back to a plain lerp + re-
  // normalize — indistinguishable from true SLERP in this narrow regime, and
  // never hit in practice by two real, distinct bone directions.
  if (omega < 1e-6 || Math.PI - omega < 1e-6) {
    return norm3([
      a[0] + (b[0] - a[0]) * e,
      a[1] + (b[1] - a[1]) * e,
      a[2] + (b[2] - a[2]) * e,
    ]);
  }
  const s = Math.sin(omega);
  const wa = Math.sin((1 - e) * omega) / s;
  const wb = Math.sin(e * omega) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

// pose: 21 [x,y] or [x,y,z] points -> { root, palm:[{len,dir}]x5, chains:[[{len,dir}]x3]x5 }
// `dir` is each bone's WORLD-space unit direction (not parent-relative) — see
// the module comment on why per-bone world SLERP is enough here without a
// full parent-relative rotation frame.
export function decompose(pose) {
  const p = pose.map(toV3);
  const root = p[0];
  const palm = PALM_BONES.map(([a, b]) => bone3(p[a], p[b]));
  const chains = CHAINS.map((chain) => {
    const bones = [];
    for (let i = 0; i < chain.length - 1; i++) bones.push(bone3(p[chain[i]], p[chain[i + 1]]));
    return bones;
  });
  return { root, palm, chains };
}

// Build a t (0..1, unclamped) -> 21 [x,y] interpolator between two poses.
// Bone lengths are pinned to poseB's (the target's) 3D length for the ENTIRE
// clip, including t=0 — see the module comment: this assumes poseA and
// poseB are proportioned consistently (e.g. two real letter centroids from
// the same normalization pipeline). Fed a poseA whose bone lengths differ
// from poseB's (e.g. the hand-authored NEUTRAL_HAND placeholder), t=0
// reproduces poseA's DIRECTIONS at poseB's LENGTHS rather than poseA
// exactly — a real tradeoff, not a bug: a hand that never resizes mid-clip
// is the whole point of this module. Note the pin is on 3D length; the
// PROJECTED 2D length can still vary a little as a bone's z component
// changes (real foreshortening as it turns toward/away from the camera) —
// that's the fix working as intended, not the old invariant regressing.
export function makeInterpolator(poseA, poseB) {
  const a = decompose(poseA);
  const b = decompose(poseB);

  return function poseAt(t) {
    const e = t;
    const rootA = a.root, rootB = b.root;
    const root = [
      rootA[0] + (rootB[0] - rootA[0]) * e,
      rootA[1] + (rootB[1] - rootA[1]) * e,
      rootA[2] + (rootB[2] - rootA[2]) * e,
    ];

    const out = new Array(21);
    out[0] = root;

    PALM_BONES.forEach(([, child], i) => {
      const len = b.palm[i].len; // constant: target's 3D length, whole clip
      const dir = slerp3(a.palm[i].dir, b.palm[i].dir, e);
      out[child] = add3(root, scale3(dir, len));
    });

    CHAINS.forEach((chain, fi) => {
      let parentPt = out[chain[0]];
      for (let i = 0; i < chain.length - 1; i++) {
        const len = b.chains[fi][i].len; // constant: target's 3D length, whole clip
        const dir = slerp3(a.chains[fi][i].dir, b.chains[fi][i].dir, e);
        const pt = add3(parentPt, scale3(dir, len));
        out[chain[i + 1]] = pt;
        parentPt = pt;
      }
    });

    return out.map(([x, y]) => [x, y]); // project back to 2D for the canvas renderer
  };
}

// Normalized RMS angular distance between two poses' bone DIRECTIONS — how
// big a reconfiguration poseA -> poseB actually is, in the same 3D space
// makeInterpolator moves through. Used by S2e (js/reference.js `setWord`) to
// derive each letter-to-letter transition's duration from the shapes
// themselves: A -> B is a big reconfiguration and should take longer, U -> V
// is a flick and shouldn't. Root position is deliberately excluded — this
// measures HANDSHAPE change, not where the hand happens to sit.
export function angleDistance(poseA, poseB) {
  const a = decompose(poseA);
  const b = decompose(poseB);
  let sumSq = 0;
  let n = 0;
  const angleBetween = (u, v) => Math.acos(Math.max(-1, Math.min(1, dot3(u, v))));
  for (let i = 0; i < a.palm.length; i++) {
    sumSq += angleBetween(a.palm[i].dir, b.palm[i].dir) ** 2;
    n++;
  }
  for (let fi = 0; fi < a.chains.length; fi++) {
    for (let bi = 0; bi < a.chains[fi].length; bi++) {
      sumSq += angleBetween(a.chains[fi][bi].dir, b.chains[fi][bi].dir) ** 2;
      n++;
    }
  }
  return Math.sqrt(sumSq / n) / Math.PI; // ~0 (no change) .. ~1 (avg bone flips pi)
}
