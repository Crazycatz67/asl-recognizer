// =============================================================================
// js/handshape.js — judge a hand by the ASL LETTER'S defining traits (Engine)
// =============================================================================
// WHAT: Each fingerspelled letter is defined by a few handshape traits —
//   which fingers are raised or folded, whether index & middle are spread,
//   whether the thumb sticks out or touches the index tip, which way the hand
//   points. This module measures those traits on a live hand and checks them
//   against the letter's definition. It replaces "how close is every joint to
//   the average photo" as the thing that decides whether a sign counts
//   (2026-09-24 owner: "match the accuracy of the letter rather than ... the
//   thousands of data positions of the hands in the photos").
//
//   Which traits define a letter is ASL knowledge, written below (TRAITS).
//   How much of each trait counts (the numeric range) is calibrated from real
//   signers in data/dataset.json (p5..p95 of that letter's own samples, plus
//   slack), so it's never a guessed number.
//
//   Letters that share one finger pattern and differ only by where a mostly
//   hidden thumb sits — A E M N S T (all fingers folded) — can't be told apart
//   by these traits; main.js lets the recogniser (kNN + learned heads) settle
//   those. See THUMB_GROUP.
//
// PUBLIC API:
//   handTraits(vec)                        -> { indexFlex, ..., thumbOut, ... }
//   createHandshapeJudge(samples)          -> judge (calibrated from the dataset)
//   judge.check(vec, letter) -> {
//     ok,                                   all defining traits in range
//     traits: [{ name, state: good|close|fix, hint }],
//     fingerStates: { thumb, index, middle, ring, pinky } (worst per finger)
//   }
//   THUMB_GROUP                            letters only the recogniser can split
//
// UNITS: flex = degrees between a finger (knuckle -> tip) and the palm axis
//   (wrist -> middle knuckle): ~0-40 raised, ~80+ folded forward. thumbOut /
//   thumbTip are distances divided by palm length. spread / dir are degrees.

const P = (v, j) => [v[j * 3], v[j * 3 + 1], v[j * 3 + 2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const angle = (a, b) => {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (len(a) * len(b) || 1e-9);
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
};
const FINGER = { index: [5, 8], middle: [9, 12], ring: [13, 16], pinky: [17, 20] };

/** Measure the handshape traits of a normalized landmark vector. */
export function handTraits(v) {
  const palmAxis = sub(P(v, 9), P(v, 0));
  const palm = len(palmAxis) || 1e-9;
  const t = {};
  for (const [name, [mcp, tip]] of Object.entries(FINGER)) {
    t[name + "Flex"] = angle(palmAxis, sub(P(v, tip), P(v, mcp)));
  }
  t.thumbOut = len(sub(P(v, 4), P(v, 5))) / palm; // thumb tip away from the index knuckle
  t.thumbTip = len(sub(P(v, 4), P(v, 8))) / palm; // thumb tip to index tip (O, F: touching)
  t.spread = angle(sub(P(v, 8), P(v, 5)), sub(P(v, 12), P(v, 9))); // index vs middle
  // which way the hand points in the image: 0 = up, 90 = sideways, 180 = down
  t.dir = Math.abs((Math.atan2(palmAxis[0], -palmAxis[1]) * 180) / Math.PI);
  return t;
}

// The traits that DEFINE each letter (ASL knowledge). Fingers not listed are
// free — e.g. B doesn't care how the thumb sits beyond "folded in".
const UP = "up", DOWN = "down"; // resolved to calibrated flex ranges below
// one-sided thumb traits: "in" = no further out than this letter's real
// signers (B: the thumb just has to be tucked, not at an exact spot); "out" =
// at least as far out as they go (L, Y: thumb clearly out to the side)
const IN = "in", OUT = "out";
const TRAITS = {
  A: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN },
  B: { index: UP, middle: UP, ring: UP, pinky: UP, thumbOut: IN },
  C: { index: true, middle: true, ring: true, pinky: true, thumbTip: true, thumbOut: OUT },
  D: { index: UP, middle: DOWN, ring: DOWN },
  E: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN },
  F: { middle: UP, ring: UP, pinky: UP, thumbTip: true },
  G: { index: UP, middle: DOWN, ring: DOWN, pinky: DOWN, dir: true },
  H: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, dir: true },
  I: { index: DOWN, middle: DOWN, ring: DOWN, pinky: UP },
  K: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true },
  L: { index: UP, middle: DOWN, ring: DOWN, pinky: DOWN, thumbOut: OUT },
  M: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN },
  N: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN },
  O: { index: true, middle: true, ring: true, pinky: true, thumbTip: true },
  P: { index: true, middle: true, dir: true },
  Q: { index: true, thumbOut: OUT, dir: true },
  R: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true },
  S: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN },
  T: { index: true, middle: DOWN, ring: DOWN, pinky: DOWN }, // index bent over the thumb
  U: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true, dir: true },
  V: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true },
  W: { index: UP, middle: UP, ring: UP, pinky: DOWN },
  X: { index: true, middle: DOWN, ring: DOWN, pinky: DOWN }, // hooked index
  Y: { index: DOWN, middle: DOWN, ring: DOWN, pinky: UP, thumbOut: OUT },
};
// same finger pattern, told apart only by the (often hidden) thumb
export const THUMB_GROUP = new Set(["A", "E", "M", "N", "S", "T"]);

// slack beyond the calibrated range: inside SLACK = still "good" (room for
// user error); inside 2x SLACK = "close"; beyond = "fix"
const SLACK = { flex: 18, thumbOut: 0.07, thumbTip: 0.1, spread: 6, dir: 15 }; // thumb slack kept tight: I vs Y, B vs L differ ONLY by the thumb
const slackFor = (name) => (name.endsWith("Flex") ? SLACK.flex : SLACK[name]);

const HINTS = {
  up: (f) => `Raise your ${f} finger straight up`,
  down: (f) => `Fold your ${f} finger down`,
  thumbOut: { low: "Tuck your thumb in", high: "Bring your thumb out to the side" },
  thumbTip: { low: "Open the gap between thumb and index", high: "Touch your thumb to your index fingertip" },
  spread: { low: "Spread your index and middle fingers apart", high: "Keep index and middle fingers together" },
  dir: { low: "Point your hand more upward", high: "Turn your hand to point more sideways / down" },
  flexMid: (f) => `Adjust how much your ${f} finger bends`,
};

const q = (sorted, p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.round(p * (sorted.length - 1))))];

/**
 * Calibrate each letter's trait ranges from real samples.
 * @param {{label: string, v: number[]}[]} samples  (dataset rows, not rotated copies)
 */
export function createHandshapeJudge(samples) {
  const byL = new Map();
  for (const s of samples) {
    if (!TRAITS[s.label]) continue;
    if (!byL.has(s.label)) byL.set(s.label, []);
    byL.get(s.label).push(handTraits(s.v));
  }
  // global "raised" / "folded" flex ranges from every letter's clearly raised
  // or folded fingers (so UP/DOWN mean the same thing for every letter)
  const upVals = [], downVals = [];
  for (const [L, ts] of byL) {
    for (const f of Object.keys(FINGER)) {
      const want = TRAITS[L][f];
      if (want === UP) for (const t of ts) upVals.push(t[f + "Flex"]);
      if (want === DOWN) for (const t of ts) downVals.push(t[f + "Flex"]);
    }
  }
  upVals.sort((a, b) => a - b);
  downVals.sort((a, b) => a - b);
  const UP_RANGE = [0, q(upVals, 0.95)];
  const DOWN_RANGE = [q(downVals, 0.05), 180];

  // "thumb in" (B) only has to stay clear of the "thumb out" letters (L, Y,
  // C, Q): its limit sits halfway between its own signers' p95 and where the
  // thumb-out letters start (their lowest p5). Using B's own p95 alone failed
  // 60% of B's held-out hands — a different session rests the thumb a bit
  // more to the side, still clearly a B.
  const thumbOutP = (L, p) => q(byL.get(L).map((t) => t.thumbOut).sort((a, b) => a - b), p);
  const outStart = Math.min(...[...byL.keys()].filter((L) => TRAITS[L].thumbOut === OUT).map((L) => thumbOutP(L, 0.05)));

  // per letter, per trait: the [lo, hi] a real signer's hand falls in
  const ranges = new Map();
  for (const [L, ts] of byL) {
    const r = {};
    for (const [name, want] of Object.entries(TRAITS[L])) {
      const key = FINGER[name] ? name + "Flex" : name;
      if (want === UP) r[key] = { range: UP_RANGE, kind: "up", finger: name };
      else if (want === DOWN) r[key] = { range: DOWN_RANGE, kind: "down", finger: name };
      else {
        const vals = ts.map((t) => t[key]).sort((a, b) => a - b);
        // "thumb out" is what separates Y from I and L from D/G/X, so its floor
        // sits between the signers' low end (p5) and their typical (p50)
        const lo = want === IN ? -Infinity
          : want === OUT ? (q(vals, 0.05) + q(vals, 0.5)) / 2
          : q(vals, 0.05);
        const hi = want === OUT ? Infinity
          : want === IN && key === "thumbOut" ? (q(vals, 0.95) + outStart) / 2
          : q(vals, 0.95);
        r[key] = { range: [lo, hi], kind: "range", finger: FINGER[name] ? name : null };
      }
    }
    ranges.set(L, r);
  }

  function stateOf(value, [lo, hi], slack) {
    const out = value < lo ? lo - value : value > hi ? value - hi : 0;
    return out <= slack ? "good" : out <= 2 * slack ? "close" : "fix";
  }

  return {
    letters: [...ranges.keys()],
    ranges,
    check(vec, letter) {
      const r = ranges.get(letter);
      if (!r || !vec) return null;
      const t = handTraits(vec);
      const traits = [];
      const fingerStates = { thumb: "good", index: "good", middle: "good", ring: "good", pinky: "good" };
      const rank = { good: 0, close: 1, fix: 2 };
      for (const [key, spec] of Object.entries(r)) {
        const value = t[key];
        const slack = slackFor(key);
        const state = stateOf(value, spec.range, slack);
        let hint = null;
        if (state !== "good") {
          if (spec.kind === "up") hint = HINTS.up(spec.finger);
          else if (spec.kind === "down") hint = HINTS.down(spec.finger);
          else if (spec.finger) hint = HINTS.flexMid(spec.finger);
          else hint = HINTS[key][value < spec.range[0] ? "low" : "high"];
        }
        traits.push({ name: key, state, hint, value });
        const who = spec.finger || (key.startsWith("thumb") ? "thumb" : key === "spread" ? "middle" : null);
        if (who && rank[state] > rank[fingerStates[who]]) fingerStates[who] = state;
      }
      const ok = traits.every((x) => x.state !== "fix") && traits.filter((x) => x.state === "close").length <= 1;
      return { ok, traits, fingerStates };
    },
  };
}
