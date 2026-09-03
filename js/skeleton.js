// Shared hand-skeleton drawing. One place to render the 21-point hand so the
// live overlay, the on-camera ghost, and the reference-panel diagram all look
// consistent. Pure canvas — no MediaPipe dependency (the connection list is
// fixed hand topology).

// MediaPipe's 21-landmark hand graph (wrist=0, then thumb, index, middle,
// ring, pinky, each MCP→PIP→DIP→TIP; plus wrist→pinky-MCP to close the palm).
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],        // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],        // index
  [5, 9], [9, 10], [10, 11], [11, 12],   // middle
  [9, 13], [13, 14], [14, 15], [15, 16], // ring
  [13, 17], [17, 18], [18, 19], [19, 20],// pinky
  [0, 17],                               // palm base
];

const KNUCKLES = new Set([0, 5, 9, 13, 17]);
const TIPS = new Set([4, 8, 12, 16, 20]);

// span of the point cloud (bbox diagonal) — used to size strokes to the hand
export function handSpan(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY) || 1;
}

// pts: array of 21 [x, y] pairs already in canvas pixels.
// When lineWidth / jointRadius aren't given they're derived from the hand's
// on-screen size, so the skeleton stays proportioned instead of turning into a
// thin stringy web on a big hand or a blob on a small one. Every stroke gets a
// dark contrast halo underneath so it reads cleanly over any background.
export function drawSkeleton(
  ctx,
  pts,
  {
    stroke = "#38bdf8",
    joint = stroke,
    lineWidth,
    jointRadius,
    alpha = 1,
    dashed = false,
    glow = 0,
    halo = "rgba(2, 6, 23, 0.55)",
  } = {}
) {
  if (!pts || pts.length < 21) return;
  const span = handSpan(pts);
  const lw = lineWidth ?? Math.max(2.5, Math.min(9, span * 0.05));
  const jr = jointRadius ?? lw * 0.85;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (glow > 0) {
    ctx.globalAlpha = alpha * 0.22;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw + 10 * glow;
    strokeBones();
    ctx.globalAlpha = alpha;
  }

  // contrast halo (skip when dashed so the dashes stay crisp)
  if (halo && !dashed) {
    ctx.strokeStyle = halo;
    ctx.lineWidth = lw + 3;
    strokeBones();
  }

  if (dashed) ctx.setLineDash([lw * 2.2, lw * 2.2]);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = lw;
  strokeBones();
  ctx.setLineDash([]);

  // joints: halo dot + colour dot; knuckles a touch bigger, fingertips brightest
  for (let i = 0; i < 21; i++) {
    const r = jr * (KNUCKLES.has(i) ? 1.25 : TIPS.has(i) ? 1.15 : 1);
    if (halo) {
      ctx.fillStyle = halo;
      dot(pts[i], r + 1.5);
    }
    ctx.fillStyle = joint;
    dot(pts[i], r);
    if (TIPS.has(i)) {
      ctx.globalAlpha = alpha * 0.9;
      ctx.fillStyle = "#f8fafc";
      dot(pts[i], r * 0.42);
      ctx.globalAlpha = alpha;
    }
  }
  ctx.restore();

  function dot(p, r) {
    ctx.beginPath();
    ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
    ctx.fill();
  }
  function strokeBones() {
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a][0], pts[a][1]);
      ctx.lineTo(pts[b][0], pts[b][1]);
    }
    ctx.stroke();
  }
}

// Map a normalized/engineered vector's first 63 values (21 * x,y,z, wrist at
// origin, ~unit radius) into canvas pixels that fit `w`x`h` with `pad` margin.
// `mirror` flips x (centroids are right-hand canonical). Returns [x,y][21].
export function vectorToPixels(vec, w, h, { pad = 0.14, mirror = false } = {}) {
  const sx = mirror ? -1 : 1;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const raw = [];
  for (let i = 0; i < 21; i++) {
    const x = vec[i * 3] * sx;
    const y = vec[i * 3 + 1];
    raw.push([x, y]);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = maxX - minX || 1e-6;
  const spanY = maxY - minY || 1e-6;
  const scale = Math.min((w * (1 - 2 * pad)) / spanX, (h * (1 - 2 * pad)) / spanY);
  const offX = (w - spanX * scale) / 2 - minX * scale;
  const offY = (h - spanY * scale) / 2 - minY * scale;
  return raw.map(([x, y]) => [x * scale + offX, y * scale + offY]);
}
