// A deliberate "wipe" gesture for Spell mode: an OPEN, SPREAD hand sweeping
// quickly sideways deletes the last character — like wiping a whiteboard.
//
// The open-and-spread requirement is what keeps it clear of normal
// fingerspelling: letters are made with the fingers together or curled and the
// hand moves slowly between them, so "all five fingers fanned out + a fast
// horizontal sweep" is a signature nothing else in spelling produces.
//
//   const sw = createSwipeMatcher();
//   sw.push(landmarks, now);          // every frame; pass null on a lost hand
//   sw.match(now) -> "delete" | null  // fires once, then arms a cooldown

const WINDOW_MS = 440; // only the last ~0.44 s of motion is considered
const COOLDOWN_MS = 650; // one sweep = one delete
const MIN_FRAMES = 4;

const TIPS = [8, 12, 16, 20];
const MCPS = [5, 9, 13, 17];

function spanOf(lm) {
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of MCPS) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}

// all four fingers extended AND fanned apart (a "5", not a flat "B")
function isSpreadOpen(lm, span) {
  for (let i = 0; i < 4; i++) {
    const t = lm[TIPS[i]], m = lm[MCPS[i]];
    if (Math.hypot(t.x - m.x, t.y - m.y) / span < 0.85) return false; // curled
  }
  let gaps = 0;
  for (let i = 0; i < 3; i++) {
    const a = lm[TIPS[i]], b = lm[TIPS[i + 1]];
    gaps += Math.hypot(a.x - b.x, a.y - b.y) / span;
  }
  return gaps > 0.9; // together ~0.3, fanned ~1.2+
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
        if (now - (buf.at(-1)?.t ?? 0) > 200) buf = [];
        return;
      }
      const span = spanOf(landmarks);
      buf.push({
        t: now,
        x: landmarks[0].x,
        y: landmarks[0].y,
        span,
        open: isSpreadOpen(landmarks, span),
      });
      while (buf.length && now - buf[0].t > WINDOW_MS) buf.shift();
    },

    match(now) {
      if (now < coolUntil || buf.length < MIN_FRAMES) return null;
      if (now - buf[0].t < 140) return null;
      const openFrac = buf.filter((f) => f.open).length / buf.length;
      if (openFrac < 0.7) return null;
      const span = avgSpan();
      const dx = extent("x") / span; // horizontal travel, in hand-spans
      const dy = extent("y") / span;
      // wide, clearly horizontal, and fast (the whole thing fits the window)
      if (dx > 1.6 && dx > dy * 2.2) {
        coolUntil = now + COOLDOWN_MS;
        return "delete";
      }
      return null;
    },

    // live numbers for an on-screen hint / tuning
    metrics() {
      if (buf.length < 2) return null;
      const span = avgSpan();
      return {
        openFrac: +(buf.filter((f) => f.open).length / buf.length).toFixed(2),
        dx: +(extent("x") / span).toFixed(2),
        dy: +(extent("y") / span).toFixed(2),
      };
    },
  };
}
