// Canvas drawing for the live view.
//   drawHands()  - plain blue skeleton on the detected hand
//   drawGuide()  - the same skeleton, but each segment coloured by how close it
//                  is to the target letter's shape, plus a "move this way" arrow
//                  at every fingertip that's off. An active correction guide
//                  drawn on the user's own hand, not a separate ghost.
// Skeleton rendering is shared with the reference panel via js/skeleton.js.

import { drawSkeleton, HAND_CONNECTIONS } from "./skeleton.js";

const FINGERTIPS = [4, 8, 12, 16, 20];

// red -> amber -> green as t goes 1 -> 0 (t = normalized joint error)
function errColor(t) {
  const x = Math.max(0, Math.min(1, t));
  const r = x < 0.5 ? 34 + (245 - 34) * (x / 0.5) : 245 + (248 - 245) * ((x - 0.5) / 0.5);
  const g = x < 0.5 ? 197 + (159 - 197) * (x / 0.5) : 159 + (113 - 159) * ((x - 0.5) / 0.5);
  const b = x < 0.5 ? 94 + (11 - 94) * (x / 0.5) : 11 + (113 - 11) * ((x - 0.5) / 0.5);
  return `rgb(${r | 0}, ${g | 0}, ${b | 0})`;
}

export function createOverlay(canvas) {
  const ctx = canvas.getContext("2d");

  return {
    canvas,
    ctx,

    resizeToVideo(video) {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    },

    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },

    drawHands(landmarksList) {
      const w = canvas.width;
      const h = canvas.height;
      for (const landmarks of landmarksList) {
        const px = landmarks.map((p) => [p.x * w, p.y * h]);
        drawSkeleton(ctx, px, {
          stroke: "#38bdf8",
          joint: "#f8fafc",
          lineWidth: 4,
          jointRadius: 4,
        });
      }
    },

    // live: 21 raw landmarks {x,y in 0..1}. target: the letter's centroid vector
    // (wrist-centred, ~unit radius; right-hand canonical). mirror=true for a
    // left hand. Draws the live skeleton coloured per-segment by joint error,
    // plus fingertip correction arrows.
    drawGuide(live, target, { aspect = 1, mirror = false } = {}) {
      if (!live?.length || !target) return;
      const w = canvas.width;
      const h = canvas.height;
      const sx = mirror ? -1 : 1;

      // live in the target's normalized frame (wrist-centred, aspect-corrected,
      // scaled by max wrist->point distance), plus the pixel anchor + scale to
      // map offsets back to screen.
      const wx = live[0].x, wy = live[0].y;
      const ln = live.map((p) => [(p.x - wx) * aspect, p.y - wy, p.z - live[0].z]);
      let radN = 1e-6;
      for (const p of ln) {
        const d = Math.hypot(p[0], p[1], p[2]);
        if (d > radN) radN = d;
      }
      for (const p of ln) { p[0] /= radN; p[1] /= radN; }

      const lp = live.map((p) => [p.x * w, p.y * h]);
      let radPx = 1e-6;
      for (const p of live) {
        const d = Math.hypot((p.x - wx) * w, (p.y - wy) * h);
        if (d > radPx) radPx = d;
      }

      // per-joint error + target offset in the normalized frame
      const err = new Array(21);
      const off = new Array(21);
      for (let i = 0; i < 21; i++) {
        const tx = target[i * 3] * sx;
        const ty = target[i * 3 + 1];
        off[i] = [tx - ln[i][0], ty - ln[i][1]];
        err[i] = Math.hypot(off[i][0], off[i][1]);
      }
      // ERR_FULL: error magnitude that reads as "way off" (full red)
      const ERR_FULL = 0.55;

      // segments, coloured by the mean error of their endpoints
      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 5;
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.strokeStyle = errColor(((err[a] + err[b]) / 2) / ERR_FULL);
        ctx.beginPath();
        ctx.moveTo(lp[a][0], lp[a][1]);
        ctx.lineTo(lp[b][0], lp[b][1]);
        ctx.stroke();
      }
      for (let i = 0; i < 21; i++) {
        ctx.fillStyle = errColor(err[i] / ERR_FULL);
        ctx.beginPath();
        ctx.arc(lp[i][0], lp[i][1], 3.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // fingertip correction arrows: from the live tip toward where it should be
      const ARROW_MIN = 0.12;
      for (const t of FINGERTIPS) {
        if (err[t] < ARROW_MIN) continue;
        const ex = lp[t][0] + (off[t][0] / aspect) * radPx;
        const ey = lp[t][1] + off[t][1] * radPx;
        const col = errColor(err[t] / ERR_FULL);
        ctx.strokeStyle = col;
        ctx.fillStyle = col;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(lp[t][0], lp[t][1]);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        // arrowhead
        const ang = Math.atan2(ey - lp[t][1], ex - lp[t][0]);
        const s = 8;
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.lineTo(ex - s * Math.cos(ang - 0.4), ey - s * Math.sin(ang - 0.4));
        ctx.lineTo(ex - s * Math.cos(ang + 0.4), ey - s * Math.sin(ang + 0.4));
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    },
  };
}
