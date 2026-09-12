// js/posekin.js — bone-length-preserving interpolation over the hand's
// kinematic tree. Pure math, no DOM, no canvas: decompose a 21-landmark pose
// into (root, per-bone {len, angle}), then interpolate ANGLES rather than
// raw x,y. A naive Cartesian lerp (the old poseAt() in reference.js) makes a
// curling finger cut a straight chord through space and lets bone lengths
// drift mid-animation, since two independent points are each sliding in a
// straight line; interpolating the angle around a fixed-length bone instead
// makes it sweep the arc a real finger actually swings through, and pins
// every bone to one constant length for the whole clip — "same physical
// hand" the whole time, not a hand that stretches and shrinks as it moves.
//
// Landmark tree (MediaPipe hand topology): wrist (0) is the root. Five palm
// bones fan out from the wrist to each finger's base knuckle; each finger is
// then a 3-bone chain from its knuckle to its tip. The three cross-palm
// links (5-9, 9-13, 13-17) are drawn by skeleton.js but aren't part of this
// kinematic tree — they're rendered between wherever the driven knuckles
// land, never driven themselves.

const PALM_BONES = [[0, 1], [0, 5], [0, 9], [0, 13], [0, 17]];
const CHAINS = [
  [1, 2, 3, 4],     // thumb
  [5, 6, 7, 8],     // index
  [9, 10, 11, 12],  // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];

// Shortest-arc angular difference, always in (-pi, pi] — so a curl never
// takes the long way around when an angle wraps past +-pi.
export function wrap(d) {
  return Math.atan2(Math.sin(d), Math.cos(d));
}

function bone(pa, pb) {
  const dx = pb[0] - pa[0];
  const dy = pb[1] - pa[1];
  return { len: Math.hypot(dx, dy), theta: Math.atan2(dy, dx) };
}

// pose: 21 [x,y] pairs -> { root, palm:[{len,theta}]x5, chains:[[{len,phi}]x3]x5 }
// Chain bones store `phi`, the angle relative to their PARENT bone (the palm
// bone for the first bone in a chain, the previous chain bone after that) —
// so a finger's shape is independent of the palm's own orientation, and
// independent of its neighboring fingers.
export function decompose(pose) {
  const root = pose[0];
  const palm = PALM_BONES.map(([a, b]) => bone(pose[a], pose[b]));
  const chains = CHAINS.map((chain, fi) => {
    const bones = [];
    let parentTheta = palm[fi].theta;
    for (let i = 0; i < chain.length - 1; i++) {
      const b = bone(pose[chain[i]], pose[chain[i + 1]]);
      bones.push({ len: b.len, phi: wrap(b.theta - parentTheta) });
      parentTheta = b.theta;
    }
    return bones;
  });
  return { root, palm, chains };
}

// Build a t (0..1) -> 21 [x,y] interpolator between two poses. Bone lengths
// are pinned to poseB's (the target's) for the ENTIRE clip, including t=0 —
// see the module comment: this assumes poseA and poseB are proportioned
// consistently (e.g. two real letter centroids from the same normalization
// pipeline). Fed a poseA whose bone lengths differ from poseB's (e.g. the
// hand-authored NEUTRAL_HAND placeholder), t=0 reproduces poseA's ANGLES at
// poseB's LENGTHS rather than poseA exactly — a real tradeoff, not a bug: a
// hand that never resizes mid-clip is the whole point of this module.
export function makeInterpolator(poseA, poseB) {
  const a = decompose(poseA);
  const b = decompose(poseB);

  return function poseAt(t) {
    const e = Math.max(0, Math.min(1, t));
    const root = [
      a.root[0] + (b.root[0] - a.root[0]) * e,
      a.root[1] + (b.root[1] - a.root[1]) * e,
    ];

    const out = new Array(21);
    out[0] = root;

    const palmTheta = [];
    for (let i = 0; i < PALM_BONES.length; i++) {
      const len = b.palm[i].len; // constant: target's length, whole clip
      const dTheta = wrap(b.palm[i].theta - a.palm[i].theta);
      const theta = a.palm[i].theta + dTheta * e;
      palmTheta.push(theta);
      const child = PALM_BONES[i][1];
      out[child] = [root[0] + len * Math.cos(theta), root[1] + len * Math.sin(theta)];
    }

    CHAINS.forEach((chain, fi) => {
      let parentTheta = palmTheta[fi];
      let parentPt = out[chain[0]];
      for (let i = 0; i < chain.length - 1; i++) {
        const boneA = a.chains[fi][i];
        const boneB = b.chains[fi][i];
        const len = boneB.len; // constant: target's length, whole clip
        const dPhi = wrap(boneB.phi - boneA.phi);
        const phi = boneA.phi + dPhi * e;
        const theta = parentTheta + phi;
        const pt = [parentPt[0] + len * Math.cos(theta), parentPt[1] + len * Math.sin(theta)];
        out[chain[i + 1]] = pt;
        parentTheta = theta;
        parentPt = pt;
      }
    });

    return out;
  };
}
