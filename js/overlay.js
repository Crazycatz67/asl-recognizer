// Canvas drawing for the live view.
//   drawHands()  - plain blue skeleton on the detected hand
//   drawGuide()  - the same skeleton, but each segment coloured by how close it
//                  is to the target letter's shape, plus a "move this way" arrow
//                  at every fingertip that's off. An active correction guide
//                  drawn on the user's own hand, not a separate ghost.
// Skeleton rendering is shared with the reference panel via js/skeleton.js.

import { drawSkeleton, HAND_CONNECTIONS, handSpan } from "./skeleton.js";
import { STROKE } from "./motion.js";
import { jointState, fullError, FIX_BAND } from "./jointstate.js";

const MOTION_TIP = { J: 20, Z: 8 }; // pinky tip / index tip

// arc-length sample of a canvas-space polyline at fraction f (0..1)
function pathAt(pts, f) {
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  let acc = 0;
  const goal = Math.max(0, Math.min(1, f)) * total;
  for (let i = 1; i < pts.length; i++) {
    if (acc + seg[i - 1] >= goal) {
      const t = seg[i - 1] ? (goal - acc) / seg[i - 1] : 0;
      return [
        pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]),
        pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]),
      ];
    }
    acc += seg[i - 1];
  }
  return pts.at(-1).slice();
}

const PART = [
  "wrist",
  "thumb base", "thumb joint", "thumb knuckle", "thumb tip",
  "index base", "index joint", "index knuckle", "index tip",
  "middle base", "middle joint", "middle knuckle", "middle tip",
  "ring base", "ring joint", "ring knuckle", "ring tip",
  "pinky base", "pinky joint", "pinky knuckle", "pinky tip",
];
const FINGER_NAME = ["thumb", "index", "middle", "ring", "pinky"];
// which finger a joint belongs to (wrist -> -1)
const FINGER_OF = [-1, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4];
// the bones that make up each finger (including the one anchoring it to the palm)
const FINGER_BONES = [
  [[0, 1], [1, 2], [2, 3], [3, 4]],
  [[0, 5], [5, 6], [6, 7], [7, 8]],
  [[5, 9], [9, 10], [10, 11], [11, 12]],
  [[9, 13], [13, 14], [14, 15], [15, 16]],
  [[13, 17], [17, 18], [18, 19], [19, 20]],
];

const PLAIN_RGB = [56, 189, 248]; // the calm default skeleton blue

// ---- guide colour ramp (Stage 7c) -------------------------------------
// Safer for colour-blind users than the old green -> amber -> red, which is
// the red/green pair most colour-vision deficiencies can't tell apart. Blue
// (on target) -> orange (close) -> magenta (fix): blue and orange stay apart
// for every common deficiency, and the magenta is darker than the orange so
// those two also differ in lightness. Colour is never the only signal: good
// bones are solid, close bones dashed, fix bones thicker, and every fingertip
// carries a glyph (GUIDE_GLYPH). The on-camera colour key (#colorKey) and the
// tour's legend use the same colours through the CSS custom properties
// --guide-good / --guide-close / --guide-fix in style.css — keep them in sync.
export const GUIDE_RGB = {
  good: PLAIN_RGB, // #38bdf8 blue
  close: [251, 146, 60], // #fb923c orange
  fix: [236, 72, 153], // #ec4899 magenta
};
export const GUIDE_GLYPH = { good: "✓", close: "~", fix: "✕" };
// the close/fix cut (FIX_BAND) and the state rule live in js/jointstate.js —
// shared with reference.js's scoring so colours == the "counts" verdict

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgb = (a) => `rgb(${a[0] | 0}, ${a[1] | 0}, ${a[2] | 0})`;

// Which of the three legend states an error is in. tol = the per-joint "on
// target" error; full = the error that counts as fully off.
export function guideState(e, tol, full) {
  return jointState(e, tol, full);
}

// orange -> magenta as t goes 0 -> 1 (t = normalized error band, already past
// tol). Flat inside each state with a short blend across the cut, so what you
// see on the hand matches the legend's swatches instead of a continuous
// rainbow no key can name. Returns an rgb array.
export function errRGB(t) {
  const x = Math.max(0, Math.min(1, t));
  const lo = FIX_BAND - 0.1, hi = FIX_BAND + 0.1;
  if (x <= lo) return GUIDE_RGB.close.slice();
  if (x >= hi) return GUIDE_RGB.fix.slice();
  return mix(GUIDE_RGB.close, GUIDE_RGB.fix, (x - lo) / (hi - lo));
}

const FINGERTIPS = [4, 8, 12, 16, 20];

export function createOverlay(canvas) {
  const ctx = canvas.getContext("2d");
  // what the last drawGuide() call showed, for the colour key and the tour:
  // { tips: [state x5, thumb..pinky], counts: {good, close, fix} (tips),
  //   joints: {good, close, fix} (all 21),
  //   worstFinger: name|null, ghost: bool }. null when the last call drew nothing.
  let lastStats = null;

  return {
    canvas,
    ctx,

    guideStats() {
      return lastStats;
    },

    resizeToVideo(video) {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }
    },

    clear() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    },

    // opts.colors: optional per-hand [{stroke, joint}] (two-player race:
    // each player's hand in their own colour); default plain blue
    drawHands(landmarksList, { colors = null } = {}) {
      const w = canvas.width;
      const h = canvas.height;
      landmarksList.forEach((landmarks, i) => {
        const px = landmarks.map((p) => [p.x * w, p.y * h]);
        const c = colors?.[i] || { stroke: "#38bdf8", joint: "#e0f2fe" };
        // sizes auto-derive from the hand's on-screen span (see skeleton.js)
        drawSkeleton(ctx, px, { stroke: c.stroke, joint: c.joint, glow: 0.5 });
      });
    },

    // J / Z: the plain skeleton plus a purple "swoosh" — the stroke path scaled
    // to the hand and anchored at the finger you trace with, an arrowhead at the
    // end, and a dot animating along it to show the direction.
    drawMotionGuide(live, letter, { mirror = true } = {}) {
      if (!live?.length) return;
      const w = canvas.width, h = canvas.height;
      const lp = live.map((p) => [p.x * w, p.y * h]);
      drawSkeleton(ctx, lp, { stroke: "#38bdf8", joint: "#e0f2fe", glow: 0.5 });

      const path = STROKE[letter];
      const tipIdx = MOTION_TIP[letter];
      if (!path || tipIdx == null) return;
      const span = handSpan(lp);
      // STROKE is already wrist-relative (units ~span), so anchor the arc at the
      // WRIST, not the moving fingertip — J/Z are a wrist rotation, so the wrist
      // stays roughly put while the hand pivots, keeping the arc steady.
      const wrist = lp[0];
      const sx = mirror ? -1 : 1; // the stage is selfie-flipped for the front cam
      const P = path.map(([x, y]) => [
        wrist[0] + x * span * sx,
        wrist[1] + y * span,
      ]);

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = "rgba(167, 139, 250, 0.55)";
      ctx.lineWidth = Math.max(4, span * 0.06);
      ctx.setLineDash([span * 0.1, span * 0.07]);
      ctx.beginPath();
      P.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
      ctx.setLineDash([]);

      const a = P.at(-1), b = P.at(-2);
      const ang = Math.atan2(a[1] - b[1], a[0] - b[0]);
      const s = span * 0.16;
      ctx.fillStyle = "#a78bfa";
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(a[0] - s * Math.cos(ang - 0.42), a[1] - s * Math.sin(ang - 0.42));
      ctx.lineTo(a[0] - s * Math.cos(ang + 0.42), a[1] - s * Math.sin(ang + 0.42));
      ctx.closePath();
      ctx.fill();

      const dot = pathAt(P, (performance.now() % 1300) / 1300);
      ctx.fillStyle = "#ede9fe";
      ctx.beginPath();
      ctx.arc(dot[0], dot[1], Math.max(4, span * 0.05), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    },

    // live: 21 raw landmarks {x,y in 0..1}. target: the letter's centroid vector
    // (wrist-centred, ~unit radius; right-hand canonical). mirror=true for a
    // left hand. tol = per-joint "on target" error. align = degrees to rotate
    // the target so it sits at the live hand's tilt.
    //
    // `reveal` (0..1) is progressive disclosure: at 0 this is just the plain
    // blue skeleton; as it rises the skeleton takes on error colour and — past
    // ~0.15 — the faint "target" ghost, the fingertip glyphs and the worst-
    // finger marker fade in. The caller keeps `reveal` at a low floor as soon
    // as a hand is scored (Stage 7c: a guide that stayed plain blue until the
    // shape was already half right looked broken) and ramps it up from there.
    //
    // Encoding (never colour alone — see GUIDE_RGB):
    //   good  blue, solid bone,   ✓ at the fingertip
    //   close orange, dashed bone, ~ at the fingertip
    //   fix   magenta, thicker bone, ✕ at the fingertip
    //   worst finger: yellow highlight + ▲ and its name at the destination
    //
    // Returns { part, err } for the worst-off joint (always, even at reveal 0)
    // so the text hint can name it; per-fingertip states via guideStats().
    drawGuide(
      live,
      target,
      {
        aspect = 1,
        mirror = false,
        tol = 0.06,
        align = 0,
        errors = null, // optional 21 per-joint errors from reference.score()
        reveal = 1,
        settled = false,
        // Is the canvas itself displayed CSS-mirrored (front camera)? This is
        // NOT the same thing as `mirror` above — that one flips the TARGET
        // ghost to match a left hand / a mirrored orientation fit. This one
        // only controls the on-screen text counter-flip, below.
        screenMirror = false,
      } = {}
    ) {
      lastStats = null;
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
      const ERR_FULL = fullError(tol);
      // colour with the SCORER's per-joint errors when given (reference.js
      // score().errors) — then every colour on the hand is exactly the state
      // the reward is judged on. Positions (ghost, lead lines) stay geometric.
      if (errors && errors.length === 21) for (let i = 0; i < 21; i++) err[i] = errors[i];
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
      const shown = rv >= 0.15; // the guide layer (styles, glyphs, ghost) is on
      const stateOf = (e) => guideState(e, tol, ERR_FULL);
      // segment/joint colour: plain blue at reveal 0, state-coloured as reveal
      // rises. "good" is the same blue as the plain skeleton, so a matching
      // hand never changes colour — only the off parts do.
      const segColor = (e) => {
        if (e <= tol) return rgb(GUIDE_RGB.good);
        return rgb(mix(PLAIN_RGB, errRGB(band(e)), rv));
      };

      // screen-readable text at (x, y): the stage is CSS-mirrored for the
      // front camera, so counter-flip each label around its own anchor (see
      // the finger-name label below for the bug this avoids)
      const label = (str, x, y, { fill, font, stroke = "rgba(2, 6, 23, 0.85)", lw = 4 }) => {
        ctx.save();
        ctx.translate(x, y);
        if (screenMirror) ctx.scale(-1, 1);
        ctx.font = font;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineWidth = lw;
        ctx.strokeStyle = stroke;
        ctx.strokeText(str, 0, 0);
        ctx.fillStyle = fill;
        ctx.fillText(str, 0, 0);
        ctx.restore();
      };

      ctx.save();
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // (1) faint dashed target ghost, labelled "target"
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
        // label beside the ghost's outermost point (away from the fingertips,
        // where the worst-finger label goes)
        let side = 0;
        for (let i = 1; i < 21; i++) if (Math.abs(tp[i][0] - tp[0][0]) > Math.abs(tp[side][0] - tp[0][0])) side = i;
        const dir = Math.sign(tp[side][0] - tp[0][0]) || 1;
        const fsT = Math.max(10, baseW * 1.6);
        ctx.globalAlpha = Math.min(0.85, 0.6 * rv + 0.15);
        label("target", tp[side][0] + dir * fsT * 2.2, tp[side][1], {
          fill: "#e2e8f0",
          font: `600 ${fsT}px system-ui, sans-serif`,
          lw: 3,
        });
        ctx.globalAlpha = 1;
      }

      // (2) the live skeleton — dark halo, then colour + line style per state:
      // solid = good, dashed = close, thicker = fix
      const segs = HAND_CONNECTIONS.map(([a, b]) => {
        const e = (err[a] + err[b]) / 2;
        const st = shown ? stateOf(e) : "good";
        return { a, b, e, st, lw: st === "fix" ? baseW * 1.45 : baseW };
      });
      // worst finger: a wide yellow glow beneath its bones
      const worstF = worst >= 0 ? FINGER_OF[worst] : -1;
      if (shown && worstF >= 0 && !settled) {
        ctx.globalAlpha = rv;
        ctx.strokeStyle = "rgba(253, 224, 71, 0.55)";
        ctx.lineWidth = baseW * 3.4;
        ctx.beginPath();
        for (const [a, b] of FINGER_BONES[worstF]) {
          ctx.moveTo(lp[a][0], lp[a][1]);
          ctx.lineTo(lp[b][0], lp[b][1]);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = "rgba(2, 6, 23, 0.5)";
      for (const s of segs) {
        ctx.lineWidth = s.lw + 3;
        ctx.beginPath();
        ctx.moveTo(lp[s.a][0], lp[s.a][1]);
        ctx.lineTo(lp[s.b][0], lp[s.b][1]);
        ctx.stroke();
      }
      for (const s of segs) {
        ctx.strokeStyle = segColor(s.e);
        ctx.lineWidth = s.lw;
        ctx.setLineDash(s.st === "close" ? [baseW * 1.3, baseW * 0.9] : []);
        ctx.beginPath();
        ctx.moveTo(lp[s.a][0], lp[s.a][1]);
        ctx.lineTo(lp[s.b][0], lp[s.b][1]);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      for (let i = 0; i < 21; i++) {
        const r = baseW * 0.7;
        ctx.fillStyle = "rgba(2, 6, 23, 0.5)";
        dot(lp[i], r + 1.5);
        ctx.fillStyle = segColor(err[i]);
        dot(lp[i], r);
      }

      // (2b) a glyph just past each fingertip: ✓ good / ~ close / ✕ fix —
      // the shape-coded twin of the colour, readable without colour vision
      const tips = FINGERTIPS.map((i) => stateOf(err[i]));
      if (shown) {
        const fsG = Math.max(10, baseW * 1.7);
        ctx.globalAlpha = rv;
        FINGERTIPS.forEach((i, k) => {
          const st = tips[k];
          const prev = lp[i - 1];
          let dx = lp[i][0] - prev[0], dy = lp[i][1] - prev[1];
          const d = Math.hypot(dx, dy) || 1;
          dx /= d;
          dy /= d;
          const gx = lp[i][0] + dx * fsG * 1.25, gy = lp[i][1] + dy * fsG * 1.25;
          ctx.fillStyle = "rgba(2, 6, 23, 0.78)";
          dot([gx, gy], fsG * 0.62);
          ctx.strokeStyle = rgb(GUIDE_RGB[st]);
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(gx, gy, fsG * 0.62, 0, Math.PI * 2);
          ctx.stroke();
          label(GUIDE_GLYPH[st], gx, gy + fsG * 0.04, {
            fill: rgb(GUIDE_RGB[st]),
            font: `800 ${fsG * 0.8}px system-ui, sans-serif`,
            lw: 0.01,
            stroke: "transparent",
          });
        });
        ctx.globalAlpha = 1;
      }
      const counts = { good: 0, close: 0, fix: 0 };
      for (const st of tips) counts[st]++;
      // every joint's state, not just the tips — main.js's reward gate uses
      // this so a sign can't count while joints are still drawn off
      const joints = { good: 0, close: 0, fix: 0 };
      for (let i = 0; i < 21; i++) joints[stateOf(err[i])]++;
      lastStats = {
        tips,
        counts,
        joints,
        worstFinger: worst >= 0 ? FINGER_NAME[FINGER_OF[worst]] || null : null,
        ghost: rv > 0.15,
        shown,
      };

      // (3) focus the ONE finger that's most off — highlight its whole length
      // bright, draw one bold lead to a filled destination disc, and label it
      // with the finger name. Suppressed once the sign already counts (`settled`)
      // so you're not nagged to chase perfection.
      if (rv > 0.15 && worst >= 0 && !settled) {
        const f = FINGER_OF[worst];
        ctx.globalAlpha = rv;

        // (the finger's yellow glow is drawn UNDER the skeleton, in step 2,
        // so its own close/fix colour and dash stay visible)

        // lead line + filled pulsing destination for the worst joint
        const p0 = lp[worst], p1 = tp[worst];
        ctx.strokeStyle = "#fde047";
        ctx.lineWidth = Math.max(2.5, baseW * 0.6);
        ctx.setLineDash([baseW * 1.1, baseW * 0.8]);
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.stroke();
        ctx.setLineDash([]);
        const rr = baseW * (1.1 + 0.4 * pulse);
        ctx.fillStyle = "rgba(253, 224, 71, 0.28)";
        dot(p1, rr);
        ctx.strokeStyle = "#fde047";
        ctx.lineWidth = Math.max(2, baseW * 0.5);
        ctx.beginPath();
        ctx.arc(p1[0], p1[1], rr, 0, Math.PI * 2);
        ctx.stroke();

        // label: "ring" near the destination. For the front camera, the
        // whole stage (video + this canvas) is CSS-mirrored — `.stage {
        // transform: scaleX(-1) }` in style.css — so the skeleton lines
        // drawn here in plain canvas coordinates line up with the mirrored
        // video. But that same outer flip makes any TEXT drawn in plain
        // coordinates render backwards on screen (a real bug reported live:
        // "the suggestion text is backwards"). Counter-flip just the text
        // draw around its own anchor point so it reads normally once the
        // CSS mirror is applied on top.
        // The ▲ is the worst-finger mark in the colour key — a shape, so
        // it reads without relying on the yellow.
        const fs = Math.max(11, baseW * 2.1);
        const ly = p1[1] - rr - fs * 0.7;
        label(f >= 0 ? `▲ ${FINGER_NAME[f]}` : "▲", p1[0], ly, {
          fill: "#fde047",
          font: `700 ${fs}px system-ui, sans-serif`,
        });
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      function dot(p, r) {
        ctx.beginPath();
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        ctx.fill();
      }
      return worst >= 0
        ? { part: PART[worst], finger: FINGER_NAME[FINGER_OF[worst]] || null, joint: worst, err: err[worst] }
        : null;
    },
  };
}
