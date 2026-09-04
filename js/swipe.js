// A deliberate "wipe" gesture for Spell mode: an open hand sweeping sideways
// deletes the last character — like wiping a whiteboard.
//
// "hand roughly open + a clear, fast, sideways travel" is the signature.
// Fingerspelling keeps the fingers together or curled and moves the hand
// slowly between shapes, so it doesn't produce this.
//
//   const sw = createSwipeMatcher();
//   sw.push(landmarks, now);          // every frame (RAW landmarks); null on a lost hand
//   sw.match(now) -> "delete" | null  // fires once, then arms a cooldown

const WINDOW_MS = 650; // consider the last ~0.65 s of motion
const COOLDOWN_MS = 650; // one sweep = one delete
const KEEP_ON_GAP_MS = 450; // a fast swipe that clips the frame edge still evaluates
const MIN_FRAMES = 4;

const TIPS = [8, 12, 16, 20];
const MCPS = [5, 9, 13, 17];

function spanOf(lm) {
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of MCPS) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}

// roughly an open hand: at least 3 of the 4 fingers extended, with some spread
// (loose — during a fast sweep MediaPipe's finger landmarks smear)
function isOpenish(lm, span) {
  let ext = 0;
  for (let i = 0; i < 4; i++) {
    const t = lm[TIPS[i]], m = lm[MCPS[i]];
    if (Math.hypot(t.x - m.x, t.y - m.y) / span > 0.7) ext++;
  }
  if (ext < 3) return false;
  let gaps = 0;
  for (let i = 0; i < 3; i++) {
    const a = lm[TIPS[i]], b = lm[TIPS[i + 1]];
    gaps += Math.hypot(a.x - b.x, a.y - b.y) / span;
  }
  return gaps > 0.5;
}

export function createSwipeMatcher() {
  let buf = []; // { t, x, y, span, open }  x,y = wrist in image coords 0..1
  let coolUntil = 0;

  const extent = (ax) => {
    let lo = Infinity, hi = -Infinity;
    for (const f of buf) {
      const v = f[ax];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  };
  const avgSpan = () => buf.reduce((s, f) => s + f.span, 0) / buf.length;

  return {
    reset() {
      buf = [];
    },

    push(landmarks, now) {
      if (!landmarks || landmarks.length < 21) {
        if (now - (buf.at(-1)?.t ?? 0) > KEEP_ON_GAP_MS) buf = [];
        return;
      }
      const span = spanOf(landmarks);
      buf.push({
        t: now,
        x: landmarks[0].x,
        y: landmarks[0].y,
        span,
        open: isOpenish(landmarks, span),
      });
      while (buf.length && now - buf[0].t > WINDOW_MS) buf.shift();
    },

    match(now) {
      if (now < coolUntil || buf.length < MIN_FRAMES) return null;
      if (now - buf[0].t < 120) return null;
      const openFrac = buf.filter((f) => f.open).length / buf.length;
      if (openFrac < 0.5) return null;
      const span = avgSpan();
      const dx = extent("x") / span; // horizontal travel, in hand-spans
      const dy = extent("y") / span;
      // wide-ish and clearly more sideways than up/down
      if (dx > 1.1 && dx > dy * 1.6) {
        coolUntil = now + COOLDOWN_MS;
        return "delete";
      }
      return null;
    },

    // live numbers for an on-screen readout / tuning
    metrics() {
      if (buf.length < 2) return null;
      const span = avgSpan();
      return {
        frames: buf.length,
        open: +(buf.filter((f) => f.open).length / buf.length).toFixed(2),
        dx: +(extent("x") / span).toFixed(2),
        dy: +(extent("y") / span).toFixed(2),
      };
    },
  };
}
