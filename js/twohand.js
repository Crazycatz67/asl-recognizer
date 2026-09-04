// Two-hand gestures for Spell mode — "carry the text through the air":
//   both open hands brought TOGETHER  -> "copy"  (grab it)
//   both open hands pulled APART       -> "paste" (drop it here)
//
// Fingerspelling is one-handed, so needing two open hands plus a big change in
// the gap between them keeps these clear of normal spelling.
//
//   const th = createTwoHandMatcher();
//   th.push(hands, now);              // hands: array of 0..2 landmark sets
//   th.match(now) -> "copy" | "paste" | null   // fires once, then a cooldown

const WINDOW_MS = 750;
const COOLDOWN_MS = 800;
const KEEP_ON_GAP_MS = 350; // hands often merge/drop a track as they meet — tolerate it
const MIN_OK_FRAMES = 3;

const TIPS = [8, 12, 16, 20];
const MCPS = [5, 9, 13, 17];

function spanOf(lm) {
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of MCPS) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}
// roughly open: >= 3 of 4 fingers extended, with a little spread (loose — a
// moving hand's landmarks smear)
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

export function createTwoHandMatcher() {
  let buf = []; // { t, ok, dist }  ok = two open hands this frame; dist = wrist gap in spans
  let coolUntil = 0;

  return {
    reset() {
      buf = [];
    },

    push(hands, now) {
      const two =
        hands && hands.length >= 2 && hands[0]?.length >= 21 && hands[1]?.length >= 21;
      if (!two) {
        if (now - (buf.at(-1)?.t ?? 0) > KEEP_ON_GAP_MS) buf = [];
        else buf.push({ t: now, ok: false, dist: 0 });
        return;
      }
      const [a, b] = hands;
      const sa = spanOf(a), sb = spanOf(b);
      const span = (sa + sb) / 2;
      const dist = Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y) / span;
      buf.push({ t: now, ok: isOpenish(a, sa) && isOpenish(b, sb), dist });
      while (buf.length && now - buf[0].t > WINDOW_MS) buf.shift();
    },

    match(now) {
      if (now < coolUntil) return null;
      const ok = buf.filter((f) => f.ok);
      if (ok.length < MIN_OK_FRAMES) return null;
      if (ok.at(-1).t - ok[0].t < 150) return null;

      // the widest and the narrowest gap we saw between two open hands, and when
      let far = ok[0], near = ok[0];
      for (const f of ok) {
        if (f.dist > far.dist) far = f;
        if (f.dist < near.dist) near = f;
      }
      if (far.dist < 2.2 || near.dist > 1.7 || far.dist - near.dist < 1.0) return null;

      // apart -> together = copy;  together -> apart = paste  (by which came first)
      const res = far.t < near.t ? "copy" : "paste";
      coolUntil = now + COOLDOWN_MS;
      return res;
    },

    metrics() {
      const ok = buf.filter((f) => f.ok);
      if (!ok.length) return { hands: buf.at(-1)?.ok === false ? "<2 open" : "…", gap: null };
      const dists = ok.map((f) => f.dist);
      return {
        hands: "2 open",
        gap: +ok.at(-1).dist.toFixed(2),
        min: +Math.min(...dists).toFixed(2),
        max: +Math.max(...dists).toFixed(2),
      };
    },
  };
}
