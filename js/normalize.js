// Shared landmark normalization — used by BOTH the offline dataset build and
// live inference, so training vectors and runtime vectors are produced by the
// exact same math.
//
// Input:  landmarks = array of 21 objects { x, y, z }, in MediaPipe's
//         image-normalized space (x,y in 0..1; z ~ same scale as x, relative
//         depth, negative = closer to camera).
// Output: number[] — 63 base values (21 * x,y,z), wrist-centered and hand-size
//         scaled; plus 11 engineered shape features when `extended` is set.
//
// Base steps:
//   1. Recenter every point on the wrist (landmark 0) -> translation-invariant.
//   2. Aspect-correct x so one x-unit equals one y-unit in real space.
//   3. Scale by the largest wrist->point distance ("hand radius") -> size /
//      distance-invariant; values land roughly in [-1, 1].
//
// mirrorX flips the hand left<->right (canonicalize a left hand to right-hand
// geometry). extended appends handFeatures() — see below.

// MediaPipe hand landmark indices, for reference:
//   0 wrist
//   1-4  thumb  (CMC, MCP, IP, TIP)
//   5-8  index  (MCP, PIP, DIP, TIP)
//   9-12 middle
//   13-16 ring
//   17-20 pinky

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

// 11 shape features, all computed on the already-normalized points so they're
// scale-invariant and roughly the same magnitude as the base coords.
function handFeatures(p) {
  return [
    // per-finger curl: tip-to-own-MCP distance. Extended ~ full finger length,
    // curled ~ small. This is the single clearest M-vs-N signal (how many
    // fingers are folded over the thumb).
    dist(p[4], p[2]),
    dist(p[8], p[5]),
    dist(p[12], p[9]),
    dist(p[16], p[13]),
    dist(p[20], p[17]),
    // gaps between adjacent fingertips: thumb-index, index-middle,
    // middle-ring, ring-pinky. R vs U is entirely "index & middle crossed
    // vs. parallel" -> shows up here plus the x-order term below.
    dist(p[4], p[8]),
    dist(p[8], p[12]),
    dist(p[12], p[16]),
    dist(p[16], p[20]),
    // thumb tip relative to the index knuckle — M / N / T / A / S differ in
    // how far the thumb pokes out from the fist.
    dist(p[4], p[5]),
    // signed index-vs-middle horizontal order. Flips sign when the fingers
    // cross (R) vs. sit side by side (U, V).
    p[8].x - p[12].x,
  ];
}

export function normalizeLandmarks(
  landmarks,
  { aspect = 1, mirrorX = false, extended = false } = {}
) {
  const wrist = landmarks[0];
  const sx = mirrorX ? -1 : 1;

  const pts = landmarks.map((p) => ({
    x: (p.x - wrist.x) * aspect * sx,
    y: p.y - wrist.y,
    z: p.z - wrist.z,
  }));

  let radius = 1e-6;
  for (const p of pts) {
    const d = Math.hypot(p.x, p.y, p.z);
    if (d > radius) radius = d;
  }
  for (const p of pts) {
    p.x /= radius;
    p.y /= radius;
    p.z /= radius;
  }

  const out = new Array(63);
  for (let i = 0; i < pts.length; i++) {
    out[i * 3] = pts[i].x;
    out[i * 3 + 1] = pts[i].y;
    out[i * 3 + 2] = pts[i].z;
  }

  return extended ? out.concat(handFeatures(pts)) : out;
}

// Convenience: pull the aspect ratio out of whatever we ran detection on.
export function aspectOf(source) {
  const w = source.videoWidth ?? source.naturalWidth ?? source.width;
  const h = source.videoHeight ?? source.naturalHeight ?? source.height;
  return w && h ? w / h : 1;
}

// Rotate an already-normalized vector in the image plane by `degrees` about the
// wrist (the origin). Dataset-build use only: for each real hand we store a few
// rotated copies so kNN has neighbours at every hand tilt (see
// config.AUGMENT_ROTATIONS). Rotation is rigid, so the per-point distances and
// the 10 distance features are unchanged; only x/y and the x-order feature move.
export function rotateVector(vec, degrees) {
  const t = (degrees * Math.PI) / 180;
  const cs = Math.cos(t);
  const sn = Math.sin(t);

  const pts = [];
  for (let i = 0; i < 21; i++) {
    const x = vec[i * 3];
    const y = vec[i * 3 + 1];
    pts.push({ x: x * cs - y * sn, y: x * sn + y * cs, z: vec[i * 3 + 2] });
  }

  const out = new Array(63);
  for (let i = 0; i < 21; i++) {
    out[i * 3] = pts[i].x;
    out[i * 3 + 1] = pts[i].y;
    out[i * 3 + 2] = pts[i].z;
  }
  return vec.length > 63 ? out.concat(handFeatures(pts)) : out;
}
