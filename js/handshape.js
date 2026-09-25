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
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = len(a) || 1e-9; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Measure the handshape traits of a normalized landmark vector. */
export function handTraits(v) {
  const palmAxis = sub(P(v, 9), P(v, 0));
  const palm = len(palmAxis) || 1e-9;
  const t = {};
  const pn0 = unit(cross(sub(P(v, 5), P(v, 0)), sub(P(v, 17), P(v, 0))));
  const lat = unit(cross(palmAxis, pn0)); // across the palm (index <-> pinky side)
  for (const [name, [mcp, tip]] of Object.entries(FINGER)) {
    t[name + "Flex"] = angle(palmAxis, sub(P(v, tip), P(v, mcp)));
    // straightness: knuckle->tip distance over the finger's bone length
    // (1 = straight, ~0.2-0.5 = curled at the middle joints, as in E)
    let bones = 0;
    for (let j = mcp; j < tip; j++) bones += len(sub(P(v, j + 1), P(v, j)));
    t[name + "Ext"] = len(sub(P(v, tip), P(v, mcp))) / (bones || 1e-9);
    // the same flex with the sideways (fan) component removed: how far the
    // finger tips forward toward the palm, not how far it's splayed. F W I
    // fan their raised fingers naturally; flex alone read that as folding.
    const d = sub(P(v, tip), P(v, mcp));
    const k = d[0] * lat[0] + d[1] * lat[1] + d[2] * lat[2];
    t[name + "Fold"] = angle(palmAxis, [d[0] - k * lat[0], d[1] - k * lat[1], d[2] - k * lat[2]]);
  }
  t.thumbOut = len(sub(P(v, 4), P(v, 5))) / palm; // thumb tip away from the index knuckle
  t.thumbTip = len(sub(P(v, 4), P(v, 8))) / palm; // thumb tip to index tip (O, F: touching)
  // how close the thumb tip is to ANY part of the fingers: small = tucked in
  // against/under them (A B E M N S), large = sticking out (L Y C Q).
  // thumbOut (distance from the index knuckle alone) can't say this: in M and
  // N the thumb hides under the middle/ring fingers, far from the index
  // knuckle yet still tucked. Owner 2026-09-24: "N would register even
  // though the thumb was sticking out".
  let near = Infinity;
  for (let j = 5; j <= 20; j++) near = Math.min(near, len(sub(P(v, 4), P(v, j))));
  t.thumbNear = near / palm;
  // finger SPLAY: mean angle between neighbouring fingers' base segments
  // (knuckle -> middle joint), with the component toward the palm removed —
  // so curling doesn't count as spreading, fanning sideways does. Measured:
  // held-together fists A E T ~3-4°, S 8°, M 9°, N 11° (median); an N with its
  // fingers fanned 20° apart per gap ~30°. Owner 2026-09-24: "I spread my
  // fingers wide but they were curled and it registered [N]".
  const pn = unit(cross(sub(P(v, 5), P(v, 0)), sub(P(v, 17), P(v, 0))));
  const base = (m) => {
    const a = sub(P(v, m + 1), P(v, m));
    const k = a[0] * pn[0] + a[1] * pn[1] + a[2] * pn[2];
    return unit([a[0] - k * pn[0], a[1] - k * pn[1], a[2] - k * pn[2]]);
  };
  const b = [base(5), base(9), base(13), base(17)];
  let sp = 0;
  for (let i = 0; i < 3; i++) sp += angle(b[i], b[i + 1]);
  t.fingerSplay = sp / 3;
  // how far the fingers fold forward AT THE BASE KNUCKLE (mean angle of each
  // knuckle -> middle-joint segment vs the palm axis). N and M drape the
  // fingers forward over the thumb from the knuckles (N median 117°, M 97°);
  // a claw — fingers raised at the knuckles, curled at the middle joints —
  // stays ~13-27° however far it's fanned, yet its curled tips read as
  // "folded" by indexFlex etc. This is what separates a real N from a curled,
  // spread hand (owner 2026-09-24).
  let kf = 0;
  for (const m of [5, 9, 13, 17]) kf += angle(palmAxis, sub(P(v, m + 1), P(v, m)));
  t.knuckleFold = kf / 4;
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
// "folded at the knuckles" (M, N): at least as folded as the letter's own
// signers' p10 — a floor, no ceiling
const FOLD = "fold";
const TRAITS = {
  A: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN, thumbNear: IN, fingerSplay: IN },
  // B's thumb folds across the palm; how far across varies (some signers
  // reach the ring/pinky knuckles — thumbOut 0.60-0.67 from the index
  // knuckle, failing 5 of 30 held-out B hands). thumbNear (tucked against
  // ANY finger) is what says "folded in, not out like an L" — no thumbOut.
  B: { index: UP, middle: UP, ring: UP, pinky: UP, thumbNear: IN, fingerSplay: IN },
  C: { index: true, middle: true, ring: true, pinky: true, thumbTip: true, thumbOut: OUT, thumbNear: OUT },
  D: { index: UP, middle: DOWN, ring: DOWN },
  E: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN, thumbNear: IN, fingerSplay: IN },
  F: { middle: UP, ring: UP, pinky: UP, thumbTip: true },
  G: { index: UP, middle: DOWN, ring: DOWN, pinky: DOWN, dir: true },
  H: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, dir: true },
  I: { index: DOWN, middle: DOWN, ring: DOWN, pinky: UP },
  K: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true },
  L: { index: UP, middle: DOWN, ring: DOWN, pinky: DOWN, thumbOut: OUT, thumbNear: OUT },
  M: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN, thumbNear: IN, knuckleFold: FOLD }, // no fingerSplay: fingers folded forward at the knuckle make it noise (held-out N 38-90°); knuckleFold rejects claws
  N: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN, thumbNear: IN, knuckleFold: FOLD }, // no fingerSplay: fingers folded forward at the knuckle make it noise (held-out N 38-90°); knuckleFold rejects claws
  O: { index: true, middle: true, ring: true, pinky: true, thumbTip: true },
  P: { index: true, middle: true, dir: true },
  Q: { index: true, thumbOut: OUT, thumbNear: OUT, dir: true },
  R: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true },
  S: { index: DOWN, middle: DOWN, ring: DOWN, pinky: DOWN, thumbNear: IN, fingerSplay: IN },
  T: { index: true, middle: DOWN, ring: DOWN, pinky: DOWN, fingerSplay: IN }, // index bent over the thumb
  U: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true, dir: true },
  V: { index: UP, middle: UP, ring: DOWN, pinky: DOWN, spread: true },
  W: { index: UP, middle: UP, ring: UP, pinky: DOWN },
  X: { index: true, middle: DOWN, ring: DOWN, pinky: DOWN }, // hooked index
  Y: { index: DOWN, middle: DOWN, ring: DOWN, pinky: UP, thumbOut: OUT, thumbNear: OUT },
};
// same finger pattern, told apart only by the (often hidden) thumb
export const THUMB_GROUP = new Set(["A", "E", "M", "N", "S", "T"]);

// slack beyond the calibrated range: inside SLACK = still "good" (room for
// user error); inside 2x SLACK = "close"; beyond = "fix"
const SLACK = { flex: 18, thumbOut: 0.07, thumbTip: 0.1, thumbNear: 0.08, fingerSplay: 5, knuckleFold: 15, spread: 6, dir: 15 }; // thumb slack kept tight: I vs Y, B vs L differ ONLY by the thumb
const slackFor = (name) => (name.endsWith("Flex") ? SLACK.flex : SLACK[name]);

const HINTS = {
  up: (f) => `Raise your ${f} finger straight up`,
  down: (f) => `Fold your ${f} finger down`,
  thumbOut: { low: "Tuck your thumb in", high: "Bring your thumb out to the side" },
  thumbTip: { low: "Open the gap between thumb and index", high: "Touch your thumb to your index fingertip" },
  thumbNear: { low: "Move your thumb out, away from your fingers", high: "Tuck your thumb in against your fingers" },
  fingerSplay: { low: "Spread your fingers a little", high: "Keep your fingers together — don't fan them apart" },
  knuckleFold: { low: "Fold your fingers forward at the knuckles, over your thumb", high: "Fold your fingers a little less" },
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
  // straightness of the raised fingers (UP) and the folded ones (DOWN) —
  // used below to tell a CURLED folded finger from a raised one
  const upExt = [], downExt = [];
  for (const [L, ts] of byL) {
    for (const f of Object.keys(FINGER)) {
      if (TRAITS[L][f] === UP) for (const t of ts) upExt.push(t[f + "Ext"]);
      if (TRAITS[L][f] === DOWN) for (const t of ts) downExt.push(t[f + "Ext"]);
    }
  }
  upExt.sort((a, b) => a - b);
  downExt.sort((a, b) => a - b);
  // the raised / folded split again, measured without the fan component
  const upFold = [], downFold = [];
  for (const [L, ts] of byL) {
    for (const f of Object.keys(FINGER)) {
      if (TRAITS[L][f] === UP) for (const t of ts) upFold.push(t[f + "Fold"]);
      if (TRAITS[L][f] === DOWN) for (const t of ts) downFold.push(t[f + "Fold"]);
    }
  }
  upFold.sort((a, b) => a - b);
  downFold.sort((a, b) => a - b);
  const UP_RANGE = [0, q(upVals, 0.95)];
  const DOWN_RANGE = [q(downVals, 0.05), 180];

  // "thumb in" (B) only has to stay clear of the "thumb out" letters (L, Y,
  // C, Q): its limit sits halfway between its own signers' p95 and where the
  // thumb-out letters start (their lowest p5). Using B's own p95 alone failed
  // 60% of B's held-out hands — a different session rests the thumb a bit
  // more to the side, still clearly a B.
  const pOf = (L, key, p) => q(byL.get(L).map((t) => t[key]).sort((a, b) => a - b), p);
  const outStart = (key) =>
    Math.min(...[...byL.keys()].filter((L) => TRAITS[L][key] === OUT).map((L) => pOf(L, key, 0.05)));

  // How folded a STRAIGHT base knuckle looks: p95 of knuckleFold over the
  // letters whose index + middle are raised (B, U, V, W, K, R, H). A claw
  // (raised at the knuckles, curled at the middle joints) sits here, so a
  // "folded at the knuckles" floor must clear it by 2x slack — M's own p10
  // (37°, a noisy class) alone let 57% of claws through.
  const raised = [...byL.keys()].filter((L) => TRAITS[L].index === UP && TRAITS[L].middle === UP);
  const straightKnuckle = q(raised.flatMap((L) => byL.get(L).map((t) => t.knuckleFold)).sort((a, b) => a - b), 0.95);

  // per letter, per trait: the [lo, hi] a real signer's hand falls in
  const ranges = new Map();
  for (const [L, ts] of byL) {
    const r = {};
    for (const [name, want] of Object.entries(TRAITS[L])) {
      const key = FINGER[name] ? name + "Flex" : name;
      if (want === UP) {
        // mirror of the DOWN rule below: a raised finger must stay on the
        // RAISED side of the halfway line between how this letter's signers
        // raise it (p90, capped at the shared UP ceiling) and the folded
        // range (DOWN p5). UP ceiling + 2x slack reached 83° — past the
        // DOWN floor (72°) — so G's index folded 60° (flex ~80°) still
        // counted for 60% of held-out G hands (probe, 2026-09-25).
        const own = q(ts.map((t) => t[name + "Fold"]).sort((a, b) => a - b), 0.9);
        r[key] = { range: UP_RANGE, kind: "up", finger: name, foldAbove: (Math.min(q(upFold, 0.95), own) + q(downFold, 0.05)) / 2 };
      }
      else if (want === DOWN) {
        // A folded finger must stay on the FOLDED side of the halfway line
        // between how this letter's own signers fold it (their p10) and the
        // raised range (UP p95). The shared DOWN floor + 2x slack reached
        // down to 36° — inside the raised range (p95 47°) — so a finger
        // raised 60° at knuckle + middle joint (flex ~55-65°) still counted:
        // A ring 87%, G ring 100%, L middle 97%, S ring 97%, X ring 100%
        // (tools/lab/probe-thresholds.mjs, 2026-09-25). Room for error is
        // unchanged above the line (still DOWN floor - slack).
        // Escape (curled): a finger curled at its middle joints past the
        // halfway point between a raised finger (straightness p5, ~0.87)
        // and this letter's own typical curl (p50) is folded however its
        // tip points — E curls onto the thumb, so its tip direction reads
        // 30-60° on real held-out E hands. Per letter, not shared: E's own
        // curl is so tight (p50 ~0.2) that a shared line (~0.67) let an E
        // finger raised 60° (still ~0.62 straight) through.
        // Override (curledTight): curled as tightly as the tightest quarter
        // of all folded fingers (p25) = folded, whatever the flex says —
        // real E pinkies at 0.16 read flex 25-28° and failed outright.
        const own = q(ts.map((t) => t[key]).sort((a, b) => a - b), 0.1);
        r[key] = { range: DOWN_RANGE, kind: "down", finger: name, fixBelow: (Math.max(DOWN_RANGE[0], own) + UP_RANGE[1]) / 2,
          curled: (q(upExt, 0.05) + q(ts.map((t) => t[name + "Ext"]).sort((a, b) => a - b), 0.5)) / 2,
          curledTight: q(downExt, 0.25) };
      }
      else {
        const vals = ts.map((t) => t[key]).sort((a, b) => a - b);
        // "thumb out" is what separates Y from I and L from D/G/X, so its floor
        // sits between the signers' low end (p5) and their typical (p50)
        const lo = want === FOLD ? Math.max(q(vals, 0.1), straightKnuckle + 2 * SLACK.knuckleFold)
          : want === IN ? -Infinity
          : want === OUT ? (q(vals, 0.05) + q(vals, 0.5)) / 2
          : q(vals, 0.05);
        const hi = want === OUT || want === FOLD ? Infinity
          : want === IN
            ? (Number.isFinite(outStart(key))
                ? (q(vals, 0.95) + outStart(key)) / 2 // halfway to the letters that need it OUT
                : q(vals, 0.9)) // nothing needs it out (finger splay): the letter's own p90
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
        // (curl escape / override: see the DOWN calibration above)
        const curled = spec.kind === "down" && t[spec.finger + "Ext"] <= spec.curledTight;
        const state = curled ? "good"
          : (spec.fixBelow !== undefined && value < spec.fixBelow && t[spec.finger + "Ext"] > spec.curled) ||
            (spec.foldAbove !== undefined && t[spec.finger + "Fold"] > spec.foldAbove) ? "fix" : stateOf(value, spec.range, slack);
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
