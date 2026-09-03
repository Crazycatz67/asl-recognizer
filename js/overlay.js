// Canvas drawing for the live view.
//   drawHands()  - plain blue skeleton on the detected hand
//   drawGuide()  - the same skeleton, but each segment coloured by how close it
//                  is to the target letter's shape, plus a "move this way" arrow
//                  at every fingertip that's off. An active correction guide
//                  drawn on the user's own hand, not a separate ghost.
// Skeleton rendering is shared with the reference panel via js/skeleton.js.

import { drawSkeleton, HAND_CONNECTIONS } from "./skeleton.js";

const PART = [
  "wrist",
  "thumb base", "thumb joint", "thumb knuckle", "thumb tip",
  "index base", "index joint", "index knuckle", "index tip",
  "middle base", "middle joint", "middle knuckle", "middle tip",
  "ring base", "ring joint", "ring knuckle", "ring tip",
  "pinky base", "pinky joint", "pinky knuckle", "pinky tip",
];

const PLAIN_RGB = [56, 189, 248]; // the calm default skeleton blue

// green -> amber -> red as t goes 0 -> 1 (t = normalized joint error). rgb array.
function errRGB(t) {
  const x = Math.max(0, Math.min(1, t));
  return [
    x < 0.5 ? 34 + (245 - 34) * (x / 0.5) : 245 + (248 - 245) * ((x - 0.5) / 0.5),
    x < 0.5 ? 197 + (159 - 197) * (x / 0.5) : 159 + (113 - 159) * ((x - 0.5) / 0.5),
    x < 0.5 ? 94 + (11 - 94) * (x / 0.5) : 11 + (113 - 11) * ((x - 0.5) / 0.5),
  ];
}
const rgb = (a) => `rgb(${a[0] | 0}, ${a[1] | 0}, ${a[2] | 0})`;
const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
function errColor(t) {
  return rgb(errRGB(t));
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
        // sizes auto-derive from the hand's on-screen span (see skeleton.js)
        drawSkeleton(ctx, px, { stroke: "#38bdf8", joint: "#e0f2fe", glow: 0.5 });
      }
    },

    // live: 21 raw landmarks {x,y in 0..1}. target: the letter's centroid vector
    // (wrist-centred, ~unit radius; right-hand canonical). mirror=true for a
    // left hand. tol = per-joint "on target" error. align = degrees to rotate
    // the target so it sits at the live hand's tilt.
    //
    // `reveal` (0..1) is progressive disclosure: at 0 this is just the plain
    // blue skeleton (nothing to distract from your hand); as it rises the
    // skeleton takes on error colour and — only past ~0.15 — a faint target
    // ghost and correction markers for the WORST 3 joints fade in. The caller
    // ramps `reveal` up once you're actually attempting the shape.
    //
    // Returns { part, err } for the worst-off joint (always, even at reveal 0)
    // so the text hint can name it.
    drawGuide(
      live,
      target,
      { aspect = 1, mirror = false, tol = 0.06, align = 0, reveal = 1 } = {}
    ) {
      if (!live?.length || !target) return null;
      const w = canvas.width;
      const h = canvas.height;
      const sx = mirror ? -1 : 1;
      const rv = Math.max(0, Math.min(1, reveal));

      // live in the target's normalized frame (wrist-centred, aspect-corrected,
      // scaled by max wrist->point distance)
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

      // rotate the target by `align` (small tilt forgiveness) into the live frame
      const ar = (align * Math.PI) / 180;
      const ca = Math.cos(ar), sa = Math.sin(ar);
      const tgt = new Array(21); // target joint in the live normalized frame
      for (let i = 0; i < 21; i++) {
        const tx0 = target[i * 3] * sx;
        const ty0 = target[i * 3 + 1];
        tgt[i] = [tx0 * ca - ty0 * sa, tx0 * sa + ty0 * ca];
      }

      // per-joint error + where that joint should be, in screen pixels
      const err = new Array(21);
      const tp = new Array(21); // target position on screen
      for (let i = 0; i < 21; i++) {
        const ox = tgt[i][0] - ln[i][0];
        const oy = tgt[i][1] - ln[i][1];
        err[i] = Math.hypot(ox, oy);
        tp[i] = [lp[i][0] + (ox / aspect) * radPx, lp[i][1] + oy * radPx];
      }
      const ERR_FULL = Math.max(tol * 6, 0.32);
      const band = (e) => Math.max(0, Math.min(1, (e - tol) / (ERR_FULL - tol)));

      // stroke sizes scale to the hand's on-screen size
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of lp) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      const span = Math.hypot(maxX - minX, maxY - minY) || 1;
      const baseW = Math.max(3, Math.min(10, span * 0.055));
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 260);

      // rank the off joints; worst first
      const offJoints = [];
      for (let i = 0; i < 21; i++) if (err[i] > tol) offJoints.push(i);
      offJoints.sort((a, b) => err[b] - err[a]);
      const worst = offJoints[0] ?? -1;
      // segment/joint colour: plain blue at reveal 0, error-graded as reveal rises
      const segColor = (e) => {
        if (e <= tol) return rv < 0.15 ? rgb(PLAIN_RGB) : "#22c55e";
        return rgb(mix(PLAIN_RGB, errRGB(band(e)), rv));
      };

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // (1) faint target ghost — only once you're engaged
      if (rv > 0.15) {
        ctx.globalAlpha = 0.32 * rv;
        ctx.setLineDash([baseW * 1.6, baseW * 1.6]);
        ctx.strokeStyle = "#e2e8f0";
        ctx.lineWidth = Math.max(2, baseW * 0.55);
        ctx.beginPath();
        for (const [a, b] of HAND_CONNECTIONS) {
          ctx.moveTo(tp[a][0], tp[a][1]);
          ctx.lineTo(tp[b][0], tp[b][1]);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }

      // (2) the live skeleton — dark halo, then colour
      ctx.strokeStyle = "rgba(2, 6, 23, 0.5)";
      ctx.lineWidth = baseW + 3;
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        ctx.moveTo(lp[a][0], lp[a][1]);
        ctx.lineTo(lp[b][0], lp[b][1]);
      }
      ctx.stroke();
      for (const [a, b] of HAND_CONNECTIONS) {
        const e = (err[a] + err[b]) / 2;
        ctx.strokeStyle = segColor(e);
        ctx.lineWidth = e <= tol && rv >= 0.15 ? baseW * 1.3 : baseW;
        ctx.beginPath();
        ctx.moveTo(lp[a][0], lp[a][1]);
        ctx.lineTo(lp[b][0], lp[b][1]);
        ctx.stroke();
      }
      for (let i = 0; i < 21; i++) {
        const r = baseW * 0.7;
        ctx.fillStyle = "rgba(2, 6, 23, 0.5)";
        dot(lp[i], r + 1.5);
        ctx.fillStyle = segColor(err[i]);
        dot(lp[i], r);
      }

      // (3) correction markers for the WORST 3 joints only — fade in with reveal
      if (rv > 0.15) {
        const lead = offJoints.slice(0, 3);
        ctx.globalAlpha = rv;
        for (let k = 0; k < lead.length; k++) {
          const i = lead[k];
          const col = errColor(band(err[i]));
          ctx.strokeStyle = col;
          ctx.lineWidth = Math.max(2, baseW * 0.45);
          ctx.setLineDash([baseW, baseW]);
          ctx.beginPath();
          ctx.moveTo(lp[i][0], lp[i][1]);
          ctx.lineTo(tp[i][0], tp[i][1]);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(tp[i][0], tp[i][1], baseW * 0.85, 0, Math.PI * 2);
          ctx.stroke();
        }
        // the single worst: white pulsing marker + arrowhead
        if (worst >= 0) {
          const p0 = lp[worst], p1 = tp[worst];
          ctx.strokeStyle = "#f8fafc";
          ctx.fillStyle = "#f8fafc";
          ctx.lineWidth = Math.max(2.5, baseW * 0.55);
          ctx.beginPath();
          ctx.arc(p1[0], p1[1], baseW * (1 + 0.45 * pulse), 0, Math.PI * 2);
          ctx.stroke();
          const ang = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
          const s = baseW * 1.5;
          ctx.beginPath();
          ctx.moveTo(p1[0], p1[1]);
          ctx.lineTo(p1[0] - s * Math.cos(ang - 0.42), p1[1] - s * Math.sin(ang - 0.42));
          ctx.lineTo(p1[0] - s * Math.cos(ang + 0.42), p1[1] - s * Math.sin(ang + 0.42));
          ctx.closePath();
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      function dot(p, r) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fill();
      }
      return worst >= 0 ? { part: PART[worst], joint: worst, err: err[worst] } : null;
    },
  };
}
