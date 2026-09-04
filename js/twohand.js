// Two-hand gestures for Spell mode — "carry the text through the air":
//   both open hands brought TOGETHER   -> "copy"  (grab it)
//   both open hands pulled APART        -> "paste" (drop it here)
//
// Fingerspelling is one-handed, so needing two open, spread hands plus a clear
// change in the gap between them keeps these clear of normal spelling.
//
//   const th = createTwoHandMatcher();
//   th.push(hands, now);              // hands: array of 0..2 landmark sets
//   th.match(now) -> "copy" | "paste" | null   // fires once, then a cooldown

const WINDOW_MS = 560;
const COOLDOWN_MS = 800;
const MIN_FRAMES = 5;

const TIPS = [8, 12, 16, 20];
const MCPS = [5, 9, 13, 17];

function spanOf(lm) {
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of MCPS) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}
function isSpreadOpen(lm, span) {
  for (let i = 0; i < 4; i++) {
    const t = lm[TIPS[i]], m = lm[MCPS[i]];
    if (Math.hypot(t.x - m.x, t.y - m.y) / span < 0.85) return false;
  }
  let gaps = 0;
  for (let i = 0; i < 3; i++) {
    const a = lm[TIPS[i]], b = lm[TIPS[i + 1]];
    gaps += Math.hypot(a.x - b.x, a.y - b.y) / span;
  }
  return gaps > 0.9;
}

export function createTwoHandMatcher() {
  let buf = []; // { t, ok, dist }  ok = two spread-open hands; dist = wrist gap in spans
  let coolUntil = 0;

  return {
    reset() {
      buf = [];
    },

    push(hands, now) {
      const two = hands && hands.length >= 2 && hands[0]?.length >= 21 && hands[1]?.length >= 21;
      if (!two) {
        if (now - (buf.at(-1)?.t ?? 0) > 220) buf = [];
        else buf.push({ t: now, ok: false, dist: 0 });
        return;
      }
      const [a, b] = hands;
      const sa = spanOf(a), sb = spanOf(b);
      const span = (sa + sb) / 2;
      const dist = Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y) / span;
      const ok = isSpreadOpen(a, sa) && isSpreadOpen(b, sb);
      buf.push({ t: now, ok, dist });
      while (buf.length && now - buf[0].t > WINDOW_MS) buf.shift();
    },

    match(now) {
      if (now < coolUntil || buf.length < MIN_FRAMES) return null;
      if (now - buf[0].t < 200) return null;
      const okFrac = buf.filter((f) => f.ok).length / buf.length;
      if (okFrac < 0.7) return null;
      const d = buf.filter((f) => f.ok).map((f) => f.dist);
      const first = d.slice(0, Math.ceil(d.length / 3)).reduce((s, v) => s + v, 0) / Math.ceil(d.length / 3);
      const last = d.slice(-Math.ceil(d.length / 3)).reduce((s, v) => s + v, 0) / Math.ceil(d.length / 3);
      // came together: was well apart, ended close
      if (first > 2.4 && last < 1.6 && first - last > 1.1) {
        coolUntil = now + COOLDOWN_MS;
        return "copy";
      }
      // pulled apart: was close, ended well apart
      if (first < 1.6 && last > 2.4 && last - first > 1.1) {
        coolUntil = now + COOLDOWN_MS;
        return "paste";
      }
      return null;
    },

    metrics() {
      const f = buf.at(-1);
      return f ? { ok: f.ok, dist: +f.dist.toFixed(2) } : null;
    },
  };
}
