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

// pts: array of 21 [x, y] pairs already in canvas pixels.
export function drawSkeleton(
  ctx,
  pts,
  {
    stroke = "#38bdf8",
    joint = stroke,
    lineWidth = 4,
    jointRadius = 3.5,
    alpha = 1,
    dashed = false,
    glow = 0,
  } = {}
) {
  if (!pts || pts.length < 21) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = stroke;
  ctx.fillStyle = joint;
  if (dashed) ctx.setLineDash([lineWidth * 2.2, lineWidth * 2.2]);

  if (glow > 0) {
    // fake soft glow with a fat translucent under-stroke (cheap; no shadowBlur)
    ctx.globalAlpha = alpha * 0.25;
    ctx.lineWidth = lineWidth + 8 * glow;
    strokeAll();
    ctx.globalAlpha = alpha;
    ctx.setLineDash(dashed ? [lineWidth * 2.2, lineWidth * 2.2] : []);
  }

  ctx.lineWidth = lineWidth;
  strokeAll();

  ctx.setLineDash([]);
  for (let i = 0; i < 21; i++) {
    ctx.beginPath();
    ctx.arc(pts[i][0], pts[i][1], jointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  function strokeAll() {
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
