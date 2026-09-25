// =============================================================================
// js/handfx.js — live feedback drawn ON the tracked hand (visual layer v2)
// =============================================================================
// WHAT: small canvas-2D touches on the camera overlay (#overlay, video-pixel
//   space, CSS-mirrored with the stage), driven by MediaPipe landmarks:
//   - HOLD-CHARGE RING: a thin --calm arc around the whole hand (centred on
//     landmark 9, just outside the farthest landmark) that fills clockwise
//     with the hold (0..1). Makes the invisible dwell timer
//     visible and teaches "hold still".
//   - SPELL RINGS: the same arc for Spell's circle lock (js/spellgate.js),
//     plus a thin white word-window arc just outside it that runs down.
//   - LANDED RING: when the letter lands, the arc hands off to a 400 ms amber
//     ring expanding outward (shape twin of the success sound: a ring).
//   - VERDICT RIPPLE: one soft white ring when the verdict moves UP
//     (off -> close -> correct), at most one per 400 ms (RippleLimiter). Never
//     on the way down (no nagging), and white — never a guide colour.
//   - TIP BEADS: a fingertip entering "good" gets a small blue bead pop.
//   - RACE BADGES: a "1"/"2" glyph on each wrist and, while a player is
//     locked out, a countdown arc — so P2's orange skeleton is never read as
//     the guide's "close" orange (shape + glyph, not hue).
//   Plus a pure FramingJudge: hand span (wrist -> middle knuckle, in frame
//   heights) -> "near" | "far" | "good" with time hysteresis, used by main.js
//   to show a "move back" / "come closer" cue (bad framing = bad landmarks).
//
// NEVER: fills over the hand, draws over the correction guide's joints, or
//   uses orange/magenta. Everything is thin strokes outside the palm.
//
// BUDGET (js/fxquality.js): a few arc() calls per detection frame. "full":
//   everything; "lite": no tip beads / ripples; "off" (reduced motion): the
//   hold arc and a still landed ring only — no expanding motion.
//
// PUBLIC API:
//   const hf = createHandFx({ ctx, governor });
//   hf.draw(hand, { hold, bucket, tipStates, now })   // after the skeleton
//   hf.landed(hand, now)                                // reward moment
//   hf.drawSpell(hand, { progress, windowFrac })        // Spell circle lock + word window
//   hf.drawRaceBadges(hands, owners, { locked:[f0,f1], screenMirror })
//   createRippleLimiter(minGapMs) -> { fire(bucket, now) -> bool, reset() }
//   createFramingJudge({ near, far, holdMs }) -> { update(span, now) -> state, reset() }
//   handSpanH(hand, aspect) -> wrist..middle-knuckle length in frame heights
//   RIPPLE_GAP_MS, FRAMING

export const RIPPLE_GAP_MS = 400;
export const FRAMING = { near: 0.42, far: 0.09, margin: 0.02, holdMs: 700 };

const RANK = { off: 0, close: 1, correct: 2 };

/** Upward-only verdict ripples, rate-limited. Pure (explicit clock). */
export function createRippleLimiter(minGapMs = RIPPLE_GAP_MS) {
  let prev = null;
  let lastAt = -Infinity;
  return {
    fire(bucket, now) {
      const b = bucket in RANK ? bucket : null;
      const up = b != null && prev != null && RANK[b] > RANK[prev];
      prev = b;
      if (!up || now - lastAt < minGapMs) return false;
      lastAt = now;
      return true;
    },
    reset() { prev = null; },
  };
}

/**
 * Hand-distance judge with hysteresis: a state only changes after the span
 * has been past its threshold (plus a margin to leave) for holdMs. Pure.
 */
export function createFramingJudge({ near = FRAMING.near, far = FRAMING.far, margin = FRAMING.margin, holdMs = FRAMING.holdMs } = {}) {
  let state = "good";
  let cand = null;
  let since = 0;
  const raw = (s) => {
    // leaving a bad state needs the span to come back past the margin
    if (state === "near") return s > near - margin ? "near" : s < far ? "far" : "good";
    if (state === "far") return s < far + margin ? "far" : s > near ? "near" : "good";
    return s > near ? "near" : s < far ? "far" : "good";
  };
  return {
    update(span, now) {
      if (!Number.isFinite(span) || span <= 0) { cand = null; return state; }
      const r = raw(span);
      if (r === state) { cand = null; return state; }
      if (cand !== r) { cand = r; since = now; }
      if (now - since >= holdMs) { state = r; cand = null; }
      return state;
    },
    reset() { state = "good"; cand = null; },
    get state() { return state; },
  };
}

/** Wrist (0) -> middle knuckle (9) in frame HEIGHTS (aspect = w / h). */
export function handSpanH(hand, aspect = 4 / 3) {
  if (!hand?.[0] || !hand[9]) return 0;
  return Math.hypot((hand[9].x - hand[0].x) * aspect, hand[9].y - hand[0].y);
}

const CALM = "56, 189, 248"; // --calm / --guide-good #38bdf8
const AMBER = "251, 191, 36"; // --amber-400
const TIPS = [4, 8, 12, 16, 20];

export function createHandFx({ ctx, governor = null } = {}) {
  const ripple = createRippleLimiter();
  let ripples = []; // { x, y, r0, t0 }
  let landedAt = 0;
  let landedAt0 = null; // { x, y, r }
  let beads = []; // { x, y, t0 }
  let prevTips = null;
  const level = () => governor?.level ?? "full";

  const px = (p) => [p.x * ctx.canvas.width, p.y * ctx.canvas.height];
  // palm centre + a radius that ENCLOSES the whole hand, so rings sit
  // outside the fingers and never cross the correction guide's bones
  function palm(hand) {
    const [cx, cy] = px(hand[9]);
    let far = 0;
    for (const p of hand) {
      const [x, y] = px(p);
      far = Math.max(far, Math.hypot(x - cx, y - cy));
    }
    return { x: cx, y: cy, R: (far || 40) * 1.12 + 6 * scale() };
  }
  const scale = () => Math.max(1, ctx.canvas.height / 480);

  // hold-charge arc: faint track + calm fill from 12 o'clock, clockwise
  function holdArc(P, hold, k) {
    if (!(hold > 0.001)) return;
    ctx.lineCap = "round";
    ctx.lineWidth = 2.5 * k;
    ctx.strokeStyle = `rgba(${CALM}, 0.18)`;
    ctx.beginPath();
    ctx.arc(P.x, P.y, P.R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${CALM}, 0.9)`;
    ctx.lineWidth = 3 * k;
    ctx.beginPath();
    ctx.arc(P.x, P.y, P.R, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, hold));
    ctx.stroke();
  }

  // Spell's circle lock (js/spellgate.js): the SAME hold-charge arc as
  // Practice for the letter being confirmed, plus a thinner, fainter
  // word-window arc just outside it that runs down clockwise from full
  // (windowFrac 1 -> 0) — "the next letter joins this word until it's
  // gone". Both are plain arcs (no motion of their own), so they stay on
  // for reduced motion / "off": they carry information, not decoration.
  function drawSpell(hand, { progress = 0, windowFrac = 0 } = {}) {
    if (!hand) return;
    const k = scale();
    const P = palm(hand);
    ctx.save();
    holdArc(P, progress, k);
    if (windowFrac > 0.001) {
      const r = P.R + 7 * k;
      ctx.lineCap = "round";
      ctx.lineWidth = 1.5 * k;
      ctx.strokeStyle = "rgba(248, 250, 252, 0.4)";
      ctx.beginPath();
      ctx.arc(P.x, P.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, windowFrac));
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw(hand, { hold = 0, bucket = null, tipStates = null, now = performance.now() } = {}) {
    const L = level();
    if (!hand) { ripple.reset(); prevTips = null; }
    const k = scale();
    ctx.save();
    if (hand) {
      const P = palm(hand);
      const R = P.R;
      holdArc(P, hold, k);
      if (L !== "off" && L !== "lite") {
        if (ripple.fire(bucket, now)) ripples.push({ x: P.x, y: P.y, r0: R, t0: now });
        // tip beads: a fingertip that just turned "good"
        if (tipStates && prevTips) {
          tipStates.forEach((s, i) => {
            if (s === "good" && prevTips[i] !== "good" && hand[TIPS[i]]) {
              const [x, y] = px(hand[TIPS[i]]);
              beads.push({ x, y, t0: now });
            }
          });
        }
      } else {
        ripple.fire(bucket, now); // keep its memory in step
      }
      prevTips = tipStates ? tipStates.slice() : null;
    }
    // ripples: 380 ms, white, thin, outward only
    ripples = ripples.filter((r) => now - r.t0 < 380);
    for (const r of ripples) {
      const t = (now - r.t0) / 380;
      ctx.strokeStyle = `rgba(248, 250, 252, ${(0.45 * (1 - t)).toFixed(3)})`;
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r0 * (1 + 0.35 * t), 0, Math.PI * 2);
      ctx.stroke();
    }
    beads = beads.filter((b) => now - b.t0 < 320);
    for (const b of beads) {
      const t = (now - b.t0) / 320;
      ctx.strokeStyle = `rgba(${CALM}, ${(0.9 * (1 - t)).toFixed(3)})`;
      ctx.lineWidth = 2 * k;
      ctx.beginPath();
      ctx.arc(b.x, b.y, (6 + 10 * t) * k, 0, Math.PI * 2);
      ctx.stroke();
    }
    // landed: amber ring expanding outward over 400 ms (still ring on "off")
    if (landedAt0 && now - landedAt < 400) {
      const t = (now - landedAt) / 400;
      const grow = L === "off" ? 0 : t;
      ctx.strokeStyle = `rgba(${AMBER}, ${(0.95 * (1 - t * t)).toFixed(3)})`;
      ctx.lineWidth = (4 - 2 * grow) * k;
      ctx.beginPath();
      ctx.arc(landedAt0.x, landedAt0.y, landedAt0.r * (1 + 0.6 * grow), 0, Math.PI * 2);
      ctx.stroke();
    } else landedAt0 = null;
    ctx.restore();
  }

  function landed(hand, now = performance.now()) {
    if (!hand) return;
    const P = palm(hand);
    landedAt = now;
    landedAt0 = { x: P.x, y: P.y, r: P.R };
  }

  // Race: a glyph badge on each wrist + a countdown arc while locked out
  function drawRaceBadges(hands, owners, { locked = [0, 0], screenMirror = true, colors = ["#38bdf8", "#fb923c"] } = {}) {
    const k = scale();
    ctx.save();
    hands.forEach((hand, i) => {
      const o = owners?.[i];
      if (o !== 0 && o !== 1 || !hand?.[0]) return;
      const [x, y] = px(hand[0]);
      const r = 13 * k;
      const by = y + r * 1.6;
      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      ctx.strokeStyle = colors[o];
      ctx.lineWidth = 2.5 * k;
      // P1 = circle, P2 = rounded square: shape carries the player too
      ctx.beginPath();
      if (o === 0) ctx.arc(x, by, r, 0, Math.PI * 2);
      else ctx.roundRect ? ctx.roundRect(x - r, by - r, 2 * r, 2 * r, 4 * k) : ctx.rect(x - r, by - r, 2 * r, 2 * r);
      ctx.fill();
      ctx.stroke();
      // the stage is CSS-mirrored for the selfie camera: un-mirror the digit
      ctx.save();
      ctx.translate(x, by);
      if (screenMirror) ctx.scale(-1, 1);
      ctx.fillStyle = "#f8fafc";
      ctx.font = `800 ${Math.round(15 * k)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(o + 1), 0, 1 * k);
      ctx.restore();
      const f = Math.max(0, Math.min(1, locked?.[o] || 0));
      if (f > 0) {
        ctx.strokeStyle = "rgba(248, 250, 252, 0.9)";
        ctx.lineWidth = 3 * k;
        ctx.beginPath();
        ctx.arc(x, by, r + 5 * k, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  return { draw, drawSpell, landed, drawRaceBadges };
}
