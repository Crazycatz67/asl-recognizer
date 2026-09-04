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

// ---------------------------------------------------------------------------
// drawHandShape — the same 21 points, but rendered as a SOLID mannequin hand
// (filled palm + fat rounded fingers + little nails) instead of a stick figure.
// Much easier to read in the demo panels. Pure canvas; pts = 21 [x,y] in px.
// ---------------------------------------------------------------------------

const FINGERS = [
  [5, 6, 7, 8],     // index
  [9, 10, 11, 12],  // middle
  [13, 14, 15, 16], // ring
  [17, 18, 19, 20], // pinky
];
const THUMB = [1, 2, 3, 4];
const TIP_IDX = [8, 12, 16, 20];

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const len = (a) => Math.hypot(a[0], a[1]) || 1;
const norm = (a) => mul(a, 1 / len(a));

// closed path smoothed through `poly` (quadratics via midpoints)
function blobPath(ctx, poly) {
  ctx.beginPath();
  const n = poly.length;
  let mid = mul(add(poly[n - 1], poly[0]), 0.5);
  ctx.moveTo(mid[0], mid[1]);
  for (let i = 0; i < n; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % n];
    const m = mul(add(cur, nxt), 0.5);
    ctx.quadraticCurveTo(cur[0], cur[1], m[0], m[1]);
  }
  ctx.closePath();
}

export function drawHandShape(ctx, pts, {
  fill,
  outline = "#1f2b3d",
  outlineWidth,
  alpha = 1,
  nails = true,
} = {}) {
  if (!pts || pts.length < 21) return;
  for (const p of pts) if (!p || !isFinite(p[0]) || !isFinite(p[1])) return;

  const span = handSpan(pts);
  const fingerW = span * 0.115;
  const thumbW = span * 0.15;
  const ol = outlineWidth ?? Math.max(2, span * 0.02);

  const knuckles = [0, 5, 9, 13, 17].map((i) => pts[i]);
  const centre = mul(knuckles.reduce(add), 1 / knuckles.length);
  const up = norm(sub(pts[9], pts[0]));       // wrist -> middle knuckle
  const side = [-up[1], up[0]];
  const halfW = len(sub(pts[5], pts[17])) * 0.5;

  // palm perimeter: wrist (pinky side) -> knuckles (nudged out to meet fingers)
  // -> thumb mound -> wrist (thumb side). No wrist stub — keeps it clean.
  const pad = fingerW * 0.6;
  const out = (i, extra = 0) => add(pts[i], mul(norm(sub(pts[i], centre)), pad + extra));
  const wrist = add(pts[0], mul(up, span * 0.03)); // a hair below the wrist point
  const palm = [
    add(wrist, mul(side, -halfW * 0.8)),
    out(17, fingerW * 0.2),
    out(13),
    out(9),
    out(5),
    add(pts[1], mul(norm(sub(pts[1], centre)), pad * 1.3)), // thumb mound
    add(wrist, mul(side, halfW * 0.8)),
  ];

  const grad =
    fill ||
    (() => {
      let minY = Infinity, maxY = -Infinity;
      for (const [, y] of pts) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
      const g = ctx.createLinearGradient(0, minY - span * 0.15, 0, maxY + span * 0.15);
      g.addColorStop(0, "#f1f4f8");
      g.addColorStop(1, "#bcc7d6");
      return g;
    })();

  const digit = (chain, w) => {
    ctx.beginPath();
    ctx.moveTo(pts[chain[0]][0], pts[chain[0]][1]);
    for (let i = 1; i < chain.length; i++) ctx.lineTo(pts[chain[i]][0], pts[chain[i]][1]);
    ctx.lineWidth = w + ol * 2;
    ctx.strokeStyle = outline;
    ctx.stroke();
    ctx.lineWidth = w;
    ctx.strokeStyle = grad;
    ctx.stroke();
  };

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // palm first (outline then fill), then each digit as its own outlined shape so
  // neighbours always show a seam; pinky -> index -> thumb, so the thumb reads
  // on top and the index over the pinky
  blobPath(ctx, palm);
  ctx.lineWidth = ol * 2;
  ctx.strokeStyle = outline;
  ctx.stroke();
  ctx.fillStyle = grad;
  ctx.fill();

  digit(FINGERS[3], fingerW); // pinky
  digit(FINGERS[2], fingerW); // ring
  digit(FINGERS[1], fingerW); // middle
  digit(FINGERS[0], fingerW); // index
  digit(THUMB, thumbW);

  // knuckle creases — a short darker line across each finger base
  ctx.strokeStyle = "rgba(31, 43, 61, 0.35)";
  ctx.lineWidth = Math.max(1, span * 0.008);
  for (const f of FINGERS) {
    const a = pts[f[0]], b = pts[f[1]];
    const d = norm(sub(b, a));
    const perp = [-d[1], d[0]];
    const m = add(a, mul(sub(b, a), 0.12));
    ctx.beginPath();
    ctx.moveTo(m[0] - perp[0] * fingerW * 0.42, m[1] - perp[1] * fingerW * 0.42);
    ctx.lineTo(m[0] + perp[0] * fingerW * 0.42, m[1] + perp[1] * fingerW * 0.42);
    ctx.stroke();
  }

  if (nails) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    for (const t of TIP_IDX) {
      const dir = norm(sub(pts[t], pts[t - 1]));
      const c = add(pts[t], mul(dir, -fingerW * 0.28));
      ctx.save();
      ctx.translate(c[0], c[1]);
      ctx.rotate(Math.atan2(dir[1], dir[0]));
      ctx.beginPath();
      ctx.ellipse(0, 0, fingerW * 0.3, fingerW * 0.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();
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
