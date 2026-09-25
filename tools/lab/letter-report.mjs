// tools/lab/letter-report.mjs — per-letter accuracy report: WHEN and WHAT
// makes each letter register, and exactly WHERE each letter struggles.
//
//   node tools/lab/letter-report.mjs [--letters ABC] [--quick] [--compare old.json]
//                                    [--out dir] [--no-issues]
//   (on the Mac: ELECTRON_RUN_AS_NODE=1 ".../Visual Studio Code.app/Contents/MacOS/Code" tools/lab/letter-report.mjs)
//
// The "Report contract" in .claude/skills/letter-tester/SKILL.md, measured on
// the SHIPPED pipeline (normalize -> either-hand kNN -> REJECT_DIST -> heads ->
// js/verdict.js judgeLetter; js/motion.js for J/Z; js/spellgate.js for Spell):
//   static letters  held-out REAL hands (tools/lab/lab-data.mjs blocked 80/20
//                   split) — own pass, why the misses fail (trait / recogniser
//                   / non-letter), the passing trait envelope, the tolerance
//                   envelope under physical perturbations (probe-axes.mjs +
//                   tools/synth-hand.js), which other letters count as it
//   J, Z            real held-out start hands traced through motion.js with
//                   stroke size / speed / direction / start-hold variations
//   Spell           the ring pipeline per letter in context (spell-sim.mjs)
//   speed           measured ms per classify / judgeLetter / frame-equivalent
// A full run (no --letters, no --quick) writes <out>/report.json + REPORT.md
// (default docs/lab/letters) and files issues (foundBy "letter-tester");
// scoped / quick runs print a summary and write only with an explicit --out.
// Deterministic (seeded RNGs); only `generated`, `runtimeSec` and `speed` vary.
//
// Honest boundary: no camera. Real hands are the dataset's posed stills;
// distance is modelled as image-space hand size + Gaussian landmark noise
// through the one-euro filter; strokes are synthetic paths on real hands.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { loadLab, rng, gauss, ROOT } from "./lab-data.mjs";
import { upsertIssue, resolveMissing, renderMd } from "./issues.mjs";
import { createProbeAxes, thresholdOf, FINGER_LEVELS, CLEAR, TOGETHER, APART, THUMB_OUT_LETTERS } from "./probe-axes.mjs";
import { createSpellSim } from "./spell-sim.mjs";

const T0 = performance.now();
const args = process.argv.slice(2);
const arg = (k, d = null) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const ONLY = arg("--letters")?.toUpperCase().split("") || null;
const QUICK = args.includes("--quick");
const FULL = !ONLY && !QUICK;
const OUT = arg("--out") ? path.resolve(arg("--out")) : FULL ? path.join(ROOT, "docs", "lab", "letters") : null;
const COMPARE = arg("--compare");
const FILE_ISSUES = FULL && !args.includes("--no-issues");
const PER = QUICK ? 8 : 30; // hands per perturbation sweep
const SPELL_TRIALS = QUICK ? 2 : 8; // = spell-letters' default: same seeds, same numbers
const MOTION_TRIALS = QUICK ? 3 : 12;
const log = (s) => process.stderr.write(s);

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const cfg = await imp("js/config.js");
const { normalizeLandmarks } = await imp("js/normalize.js");
const { handTraits } = await imp("js/handshape.js");
const { createMotionMatcher } = await imp("js/motion.js");
const { createLandmarkFilter } = await imp("js/onefilter.js");
const { createSpellGate } = await imp("js/spellgate.js");
const { buildReference } = await imp("js/reference.js");
const { createRefiner } = await imp("js/heads.js");

const lab = await loadLab();
const { test, judge, predict, countsWith, judgeLetter, rotateVector } = lab;
const P = await createProbeAxes(lab);
const { refresh, sweep, AX, synth } = P;
const sim = await createSpellSim({ lab });

const STATIC = lab.letters; // 24 static letters with held-out hands
const ALL = [...STATIC, "J", "Z"].sort();
const scope = ONLY ? ALL.filter((L) => ONLY.includes(L)) : ALL;

// ---- small utils --------------------------------------------------------------
const r2 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 100) / 100);
const r3 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 1000);
const pct = (x) => (x == null ? "—" : `${Math.round(100 * x)}%`);
const qtl = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.round(p * (s.length - 1))))];
};
const median = (a) => qtl(a, 0.5);
const hashStr = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const noisy = (hand, R, sd = 0.0022) => hand.map((p) => ({ x: p.x + gauss(R) * sd, y: p.y + gauss(R) * sd, z: p.z + gauss(R) * sd * 0.9 }));

// ---- code anchors (found at run time so they stay right as the code moves) -----
const SRC = {};
const lines = (f) => (SRC[f] ||= fs.readFileSync(path.join(ROOT, f), "utf8").split("\n"));
const at = (f, re) => {
  const i = lines(f).findIndex((l) => re.test(l));
  return i < 0 ? f : `${f}:${i + 1}`;
};
const A = {
  traitRow: (L) => at("js/handshape.js", new RegExp(`^\\s+${L}: \\{`)),
  down: at("js/handshape.js", /fixBelow: \(Math\.max/),
  up: at("js/handshape.js", /foldAbove: \(Math\.min/),
  out: at("js/handshape.js", /want === OUT \? \(q\(vals, 0\.05\)/),
  in: at("js/handshape.js", /\(q\(vals, 0\.95\) \+ outStart\(key\)\) \/ 2/),
  inOwn: at("js/handshape.js", /want === IN_OWN \? q\(vals, 0\.95\)/),
  fold: at("js/handshape.js", /want === FOLD \? Math\.max/),
  rangeLo: at("js/handshape.js", /^\s+: q\(vals, 0\.05\);/),
  rangeHi: at("js/handshape.js", /^\s+: q\(vals, 0\.95\);/),
  slack: at("js/handshape.js", /^const SLACK = /),
  okRule: at("js/handshape.js", /const ok = traits\.every/),
  veto: at("js/verdict.js", /THUMB_GROUP\.has\(target\) && THUMB_GROUP\.has\(p\)/),
  nullPred: at("js/verdict.js", /if \(p && p !== target\)/),
  reject: at("js/config.js", /export const REJECT_DIST/),
  knnK: at("js/config.js", /export const KNN_K/),
  aug: at("js/config.js", /export const AUGMENT_ROTATIONS/),
  heads: at("js/heads.js", /^\s+refine\(vec, knnLabel\)/),
  either: at("js/knn.js", /export function classifyEitherHand/),
  confirmMs: at("js/spellgate.js", /^\s+confirmMs: /),
  minConf: at("js/spellgate.js", /^\s+minConf: /),
  graceMs: at("js/spellgate.js", /^\s+graceMs: /),
  steady: at("js/spellgate.js", /^\s+steadySpans: /),
  jRule: at("js/motion.js", /^const J_DROP/),
  zRule: at("js/motion.js", /^const Z_REV_STEP/),
  shapeGate: at("js/motion.js", /^const I_PINKY_MIN/),
  shapeFrac: at("js/motion.js", /^const SHAPE_FRAC/),
  minStroke: at("js/motion.js", /^const MIN_STROKE_MS/),
  window: at("js/motion.js", /^const WINDOW_MS/),
  oneEuro: at("js/config.js", /export const ONE_EURO_MIN_CUTOFF/),
};

// ---- trait vocabulary ------------------------------------------------------------
const MEANING = {
  thumbNear: { name: "thumb-to-fingers distance", low: "thumb pressed in too close to the fingers", high: "thumb too far from the fingers (sticking out)" },
  thumbOut: { name: "thumb tip out from the index knuckle", low: "thumb not out far enough", high: "thumb too far out from the index knuckle" },
  thumbTip: { name: "thumb-tip to index-tip gap", low: "thumb tip too close to the index tip", high: "thumb tip not touching the index tip" },
  fingerSplay: { name: "finger splay (deg)", low: "fingers not spread", high: "fingers fanned apart" },
  thumbAlong: { name: "thumb tip along the knuckle line (0 index, 1 pinky)", low: "thumb too far to the index side", high: "thumb too far across toward the pinky" },
  knuckleFold: { name: "knuckle fold (deg)", low: "fingers not folded forward at the knuckles", high: "fingers folded too far forward" },
  spread: { name: "index-middle spread (deg)", low: "index/middle not spread apart", high: "index/middle spread too far" },
  dir: { name: "pointing direction (0 up, 90 sideways, 180 down)", low: "hand points too far up", high: "hand points too far sideways/down" },
};
const traitSpec = (L, key) => judge.ranges.get(L)?.[key];
function dirOf(L, t) {
  const sp = traitSpec(L, t.name);
  if (!sp) return "high";
  if (sp.kind === "down") return "low";
  if (sp.kind === "up") return "high";
  return t.value < sp.range[0] ? "low" : "high";
}
function traitWords(L, key, dir) {
  const sp = traitSpec(L, key);
  if (sp?.finger && sp.kind === "down") return `${sp.finger} finger not folded enough`;
  if (sp?.finger && sp.kind === "up") return `${sp.finger} finger not raised (tipped forward)`;
  if (sp?.finger) return `${sp.finger} finger ${dir === "low" ? "straighter" : "more bent"} than real signers`;
  return MEANING[key]?.[dir] || `${key} too ${dir}`;
}
function traitAnchor(L, key) {
  const sp = traitSpec(L, key);
  if (!sp) return A.traitRow(L);
  if (sp.kind === "down") return A.down;
  if (sp.kind === "up") return A.up;
  const lo = sp.range[0], hi = sp.range[1];
  if (hi === Infinity && lo !== -Infinity) return key === "knuckleFold" ? A.fold : A.out;
  if (lo === -Infinity) return key === "thumbOut" && L === "T" ? A.inOwn : A.in;
  return `${A.rangeLo} / ${A.rangeHi}`;
}
// the effective accept edge in the trait's own measure (for the hints)
function edgeOf(L, key) {
  const sp = traitSpec(L, key);
  if (!sp) return null;
  if (sp.kind === "down") return { measure: key, lo: r2(sp.fixBelow), hi: 180, curledExt: r2(sp.curled), note: `flex >= ${sp.fixBelow.toFixed(0)}° (or curled: straightness <= ${sp.curled.toFixed(2)})` };
  if (sp.kind === "up") return { measure: `${sp.finger}Fold`, lo: 0, hi: r2(sp.foldAbove), note: `forward fold <= ${sp.foldAbove.toFixed(0)}° (and flex <= ${sp.range[1].toFixed(0)}° + slack)` };
  const sl = key.endsWith("Flex") ? 18 : undefined;
  return { measure: key, lo: r3(sp.range[0]), hi: r3(sp.range[1]), slack: sl, note: `[${fmt(sp.range[0])}, ${fmt(sp.range[1])}] (+-slack good, +-2 slack close)` };
}
const fmt = (x) => (x === Infinity ? "inf" : x === -Infinity ? "-inf" : Math.abs(x) >= 10 ? x.toFixed(0) : x.toFixed(2));

// ---- 1. predictions for every held-out hand (one per hand, reused) --------------
log("predicting held-out hands… ");
const heldLabels = [...STATIC, "space"].filter((L) => test[L]);
const PRED = new Map(); // vector -> pred label | null
for (const L of heldLabels) for (const s of test[L]) PRED.set(s.v, predict(s.v));
log(`${PRED.size} hands\n`);

// ---- 2. static letter analysis ------------------------------------------------------
function analyseStatic(L) {
  const hands = test[L].map((s) => s.v);
  const n = hands.length;
  let pass = 0;
  const traitFail = {}, recogFail = {}, readAs = {};
  let nonLetter = 0;
  const passVals = {}, failVals = {};
  const keys = Object.keys(judge.ranges.get(L) || {});
  for (const v of hands) {
    const pred = PRED.get(v);
    readAs[pred ?? "none"] = (readAs[pred ?? "none"] || 0) + 1;
    if (pred == null) nonLetter++;
    const j = judgeLetter(judge, v, L, pred, 0.3);
    const t = handTraits(v);
    const bucket = j.strict ? passVals : failVals;
    for (const k of keys) {
      const sp = traitSpec(L, k);
      const m = sp.kind === "up" ? `${sp.finger}Fold` : k;
      (bucket[k] ||= []).push(t[m]);
    }
    if (j.strict) { pass++; continue; }
    const hs = j.traits;
    if (hs?.ok) { recogFail[pred] = (recogFail[pred] || 0) + 1; continue; }
    if (!hs) continue;
    const fixes = hs.traits.filter((x) => x.state === "fix");
    const list = fixes.length ? fixes : hs.traits.filter((x) => x.state === "close");
    for (const x of list) {
      const id = `${x.name}|${dirOf(L, x)}`;
      (traitFail[id] ||= { n: 0, vals: [] }).n++;
      traitFail[id].vals.push(x.value);
    }
  }
  const rejectedBy = { traits: {}, recogniser: {}, nonLetter: r3(nonLetter / n) };
  for (const [id, x] of Object.entries(traitFail)) {
    const [name, dir] = id.split("|");
    rejectedBy.traits[name] = { rate: r3(x.n / n), dir, failMedian: r3(median(x.vals)) };
  }
  for (const [X, c] of Object.entries(recogFail)) rejectedBy.recogniser[X] = r3(c / n);
  const readAsR = Object.fromEntries(Object.entries(readAs).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, r3(c / n)]));

  // passing trait envelope
  const traits = {};
  for (const k of keys) {
    const e = edgeOf(L, k);
    const pv = passVals[k] || [];
    traits[k] = { ...e, passMedian: r3(median(pv)), passP10: r3(qtl(pv, 0.1)), passP90: r3(qtl(pv, 0.9)) };
  }

  // tolerance envelope (the level at which the pass rate halves) on PER hands
  const step = Math.max(1, Math.floor(n / PER));
  const vs = hands.filter((_, i) => i % step === 0).slice(0, PER);
  const base = P.passRate(vs.map(refresh), L);
  const env = {};
  const axis = (name, levels, apply, seed) => {
    const rates = sweep(vs, L, levels, apply, seed);
    const th = thresholdOf(levels, rates, base || 1);
    env[name] = { levels, rates: rates.map(r2), halvesAt: th };
    // at the level where it breaks: which stage rejects the perturbed hands
    if (th != null) {
      const R = rng(seed ?? 7), why = {};
      let nf = 0;
      for (const v of vs) {
        const pv = refresh(apply(v, th, R)), pred = predict(pv);
        const j = judgeLetter(judge, pv, L, pred, 0.3);
        if (j.strict) continue;
        nf++;
        let k;
        if (!j.traits) k = "invalid hand";
        else if (j.traits.ok) k = `recogniser reads ${pred}`;
        else {
          const f = j.traits.traits.filter((x) => x.state === "fix");
          const t = (f.length ? f : j.traits.traits.filter((x) => x.state === "close"))[0];
          k = t ? `trait ${t.name} ${dirOf(L, t)}` : "trait";
        }
        why[k] = (why[k] || 0) + 1;
      }
      env[name].whyAtHalf = Object.fromEntries(Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, c]) => [k, r2(c / (nf || 1))]));
    }
    return env[name];
  };
  axis("rotation+", AX.tilt.levels, AX.tilt.apply);
  axis("rotation-", AX.tilt.levels.map((x) => -x), AX.tilt.apply);
  const rot3 = (v, deg, ax) => {
    const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180), out = v.slice();
    for (let j = 0; j < 21; j++) {
      const x = v[j * 3], y = v[j * 3 + 1], z = v[j * 3 + 2];
      if (ax === "pitch") { out[j * 3 + 1] = y * c - z * s; out[j * 3 + 2] = y * s + z * c; }
      else { out[j * 3] = x * c + z * s; out[j * 3 + 2] = -x * s + z * c; }
    }
    return out;
  };
  axis("pitch", [0, 15, 30, 45, 60], (v, x) => rot3(v, x, "pitch"));
  axis("yaw", [0, 15, 30, 45, 60], (v, x) => rot3(v, x, "yaw"));
  axis("jitter", AX.jitter.levels, AX.jitter.apply);
  axis("fan", AX.fan.levels, AX.fan.apply);
  axis("squeeze", AX.fan.levels.map((x) => -x), AX.fan.apply);
  axis("curl", AX.curl.levels, AX.curl.apply);
  // distance: image-space hand size + landmark noise through the one-euro
  // filter (8 held frames), normalized exactly like a live frame
  {
    const spans = [0.16, 0.12, 0.08, 0.06, 0.045, 0.035, 0.025];
    const R = rng(hashStr(L) + 99);
    const rates = spans.map((sp) => {
      let ok = 0;
      for (const v of vs) {
        const f = createLandmarkFilter({ mincutoff: cfg.ONE_EURO_MIN_CUTOFF, beta: cfg.ONE_EURO_BETA, dcutoff: cfg.ONE_EURO_DCUTOFF });
        const hand = sim.handAt(v, 0.5, 0.55, sp);
        let h = null;
        for (let k = 0; k < 8; k++) h = f.filter(noisy(hand, R), (k * 33) / 1000);
        const vec = normalizeLandmarks(h, { aspect: 1, mirrorX: false, extended: cfg.USE_EXTENDED_FEATURES });
        if (countsWith(vec, L, predict(vec))) ok++;
      }
      return vs.length ? ok / vs.length : 0;
    });
    // spans shrink = farther away; halvesAt = first span where the rate halves
    env.distance = { levels: spans, rates: rates.map(r2), halvesAt: thresholdOf(spans, rates, rates[1] || 1), note: "hand span in frame units (0.12 = arm's length)" };
  }
  const spec = judge.ranges.get(L) || {};
  const wrongShape = {};
  for (const f of ["index", "middle", "ring", "pinky"]) {
    const t = spec[f + "Flex"];
    if (!t || (t.kind !== "up" && t.kind !== "down")) continue;
    const sgn = t.kind === "down" ? -1 : 1;
    const e = axis(`finger:${f}`, FINGER_LEVELS, (v, x) => synth.bendFinger(v, f, sgn * x));
    e.wrong = t.kind === "down" ? "raised" : "folded";
    wrongShape[`${f} ${e.wrong} ${CLEAR.finger}°`] = e.rates[FINGER_LEVELS.indexOf(CLEAR.finger)];
  }
  const tOut = axis("thumb-out", [0, 15, 30, 45, 60], (v, x) => synth.swingThumb(v, x));
  const tIn = axis("thumb-in", [0, 10, 20, 30, 40], (v, x) => synth.swingThumb(v, -x));
  const thumbDefined = Object.keys(spec).some((k) => k.startsWith("thumb"));
  if (thumbDefined) {
    if (THUMB_OUT_LETTERS.has(L)) wrongShape[`thumb in ${CLEAR.thumbIn}°`] = tIn.rates[3];
    else wrongShape[`thumb out ${CLEAR.thumbOut}°`] = tOut.rates[3];
  }
  if (TOGETHER.has(L)) wrongShape[`index/middle fanned ${CLEAR.spread}°`] = env.fan.rates[2];
  if (APART.has(L)) wrongShape[`index/middle squeezed ${CLEAR.spread}°`] = env.squeeze.rates[2];

  const lvl = (e) => (e.halvesAt == null ? null : Math.abs(e.halvesAt));
  const registers = {
    traits,
    envelope: {
      base: r2(base), n: vs.length,
      rotationDeg: { pos: lvl(env["rotation+"]), neg: lvl(env["rotation-"]) },
      tiltDeg: { pitch: lvl(env.pitch), yaw: lvl(env.yaw) },
      minSpan: env.distance.halvesAt,
      jitter: lvl(env.jitter),
      fanDeg: lvl(env.fan), squeezeDeg: lvl(env.squeeze), curlDeg: lvl(env.curl),
      fingerBendDeg: Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("finger:")).map(([k, e]) => [k.slice(7), { wrong: e.wrong, halvesAt: e.halvesAt }])),
      thumbSwingDeg: { out: lvl(tOut), in: lvl(tIn), defined: thumbDefined },
      note: "each value = the perturbation level at which the pass rate falls below half of the unperturbed rate; null = tolerated across the whole tested range",
    },
    axes: env,
    wrongShapeStillCounts: Object.fromEntries(Object.entries(wrongShape).map(([k, v]) => [k, r2(v)])),
  };

  // false accepts: other letters' held-out hands (and relaxed "space" hands)
  const acceptedAs = {}, acceptedAsRead = {};
  for (const X of heldLabels) {
    if (X === L) continue;
    const xs = test[X];
    const acc = xs.filter((s) => countsWith(s.v, L, PRED.get(s.v)));
    if (!acc.length) continue;
    acceptedAs[X] = r3(acc.length / xs.length);
    // how the recogniser read the accepted ones: null = rejected as a
    // non-letter, which the verdict treats as "benefit of the doubt"
    const rd = {};
    for (const s of acc) { const p = PRED.get(s.v) ?? "none"; rd[p] = (rd[p] || 0) + 1; }
    acceptedAsRead[X] = Object.fromEntries(Object.entries(rd).map(([k, c]) => [k, r2(c / acc.length)]));
  }
  return { own: r3(pass / n), n, rejectedBy, readAs: readAsR, registers, acceptedAs, acceptedAsRead };
}

// ---- 3. J / Z motion ----------------------------------------------------------------
const J_VARIANTS = [
  { name: "nominal", expect: "pass", size: 1, dur: 730, pre: 300 },
  { name: "size 0.5x", group: "size", key: 0.5, expect: "info", size: 0.5, dur: 730, pre: 300 },
  { name: "size 0.75x", group: "size", key: 0.75, expect: "pass", size: 0.75, dur: 730, pre: 300 },
  { name: "size 1.5x", group: "size", key: 1.5, expect: "pass", size: 1.5, dur: 730, pre: 300 },
  { name: "300 ms stroke", group: "speed", key: 300, expect: "info", size: 1, dur: 300, pre: 300 },
  { name: "450 ms stroke", group: "speed", key: 450, expect: "pass", size: 1, dur: 450, pre: 300 },
  { name: "1100 ms stroke", group: "speed", key: 1100, expect: "pass", size: 1, dur: 1100, pre: 300 },
  { name: "1500 ms stroke", group: "speed", key: 1500, expect: "pass", size: 1, dur: 1500, pre: 300 },
  { name: "mirrored hook", group: "direction", key: "mirrored", expect: "pass", size: 1, dur: 730, pre: 300, mirror: true },
  { name: "half twist", group: "direction", key: "half twist", expect: "info", size: 1, dur: 730, pre: 300, twist: 0.5 },
  { name: "no twist (arm only)", group: "direction", key: "no twist", expect: "info", size: 1, dur: 730, pre: 300, twist: 0 },
  { name: "start held 100 ms", group: "start", key: "held 100 ms", expect: "pass", size: 1, dur: 730, pre: 100 },
  { name: "start not held", group: "start", key: "not held", expect: "info", size: 1, dur: 730, pre: 0 },
  { name: "wrong start shape (B)", group: "start", key: "wrong shape", expect: "reject", size: 1, dur: 730, pre: 300, shape: "B" },
];
const Z_VARIANTS = [
  { name: "nominal", expect: "pass", size: 1, dur: 1000, pre: 300 },
  { name: "size 0.5x", group: "size", key: 0.5, expect: "info", size: 0.5, dur: 1000, pre: 300 },
  { name: "size 0.75x", group: "size", key: 0.75, expect: "pass", size: 0.75, dur: 1000, pre: 300 },
  { name: "size 1.5x", group: "size", key: 1.5, expect: "pass", size: 1.5, dur: 1000, pre: 300 },
  { name: "500 ms stroke", group: "speed", key: 500, expect: "info", size: 1, dur: 500, pre: 300 },
  { name: "700 ms stroke", group: "speed", key: 700, expect: "pass", size: 1, dur: 700, pre: 300 },
  { name: "1400 ms stroke", group: "speed", key: 1400, expect: "pass", size: 1, dur: 1400, pre: 300 },
  { name: "1700 ms stroke", group: "speed", key: 1700, expect: "info", size: 1, dur: 1700, pre: 300 },
  { name: "mirrored (right to left)", group: "direction", key: "mirrored", expect: "pass", size: 1, dur: 1000, pre: 300, mirror: true },
  { name: "drawn upward", group: "direction", key: "upward", expect: "reject", size: 1, dur: 1000, pre: 300, upward: true },
  { name: "start held 100 ms", group: "start", key: "held 100 ms", expect: "pass", size: 1, dur: 1000, pre: 100 },
  { name: "start not held", group: "start", key: "not held", expect: "info", size: 1, dur: 1000, pre: 0 },
  { name: "wrong start shape (B)", group: "start", key: "wrong shape", expect: "reject", size: 1, dur: 1000, pre: 300, shape: "B" },
];
const J_KEYS = { drop: 0.6, len: 1.0, hook: 40, twist: 1.3, arm: 0.5 };
function parseDebug(dbg) {
  const out = {};
  for (const m of dbg.matchAll(/(\w+) ([\d.]+)°?\/([\d.]+)/g)) out[m[1]] = { v: +m[2], thr: +m[3] };
  return out;
}
// which motion rule the stroke missed (at its best frame)
function motionFailure(L, dbg) {
  if (!dbg) return ["shape gate"];
  if (dbg.startsWith("no ")) return ["shape gate"];
  const d = parseDebug(dbg);
  const f = [];
  if (L === "J") {
    for (const k of ["drop", "len", "hook"]) if (d[k] && d[k].v < d[k].thr) f.push(k);
    if (d.twist && d.arm && d.twist.v < d.twist.thr && d.arm.v < d.arm.thr) f.push("twist/arm");
  } else {
    if (d.turns && d.turns.v < d.turns.thr) f.push("turns");
    if (d.width && d.width.v < d.width.thr) f.push("width");
    if (d.down && d.down.v < d.down.thr) f.push("descent");
  }
  return f.length ? f : ["timing/end shape"];
}
const passedCount = (L, dbg) => (dbg && !dbg.startsWith("no ") ? (L === "J" ? 5 : 3) - motionFailure(L, dbg).filter((x) => x !== "timing/end shape").length : 0);

function motionTrial(L, v, trial) {
  const R = rng(5000 + trial * 7919 + hashStr(L + v.name));
  const startL = v.shape || (L === "J" ? "I" : "Z");
  const pool = test[startL] || lab.byL[startL];
  const base0 = pool[Math.floor(R() * pool.length)].v;
  let W;
  do W = STATIC[Math.floor(R() * STATIC.length)]; while (W === "I" || W === "D" || W === startL);
  const prevV = test[W][Math.floor(R() * test[W].length)].v;
  const wx = 0.45 + (R() - 0.5) * 0.05, wy = 0.45 + (R() - 0.5) * 0.05;
  const prev = sim.handAt(prevV, wx, wy), target = sim.handAt(base0, wx, wy);
  const mm = createMotionMatcher();
  const f = createLandmarkFilter({ mincutoff: cfg.ONE_EURO_MIN_CUTOFF, beta: cfg.ONE_EURO_BETA, dcutoff: cfg.ONE_EURO_DCUTOFF });
  let t = 1000, sway = R() * 6;
  const hits = [];
  let best = null, bestScore = -1, strokeT0 = null;
  const push = (h, watch) => {
    t += 1000 / 30 + (R() - 0.5) * 6;
    sway += 0.07;
    const sx = Math.sin(sway) * 0.004, sy = Math.cos(sway * 0.7) * 0.003;
    const hh = f.filter(noisy(h.map((p) => ({ x: p.x + sx, y: p.y + sy, z: p.z })), R), t / 1000);
    mm.push(hh, t, 1);
    if (watch) {
      const m = mm.metrics();
      if (m) {
        const dbg = m.debug[L];
        const sc = passedCount(L, dbg) * 10 + m.progress[L];
        if (sc > bestScore) { bestScore = sc; best = dbg; }
      }
    }
    const hit = mm.match(t);
    if (hit) hits.push({ L: hit, t, inStroke: watch });
  };
  const run = (ms, fn, watch) => { const t0 = t; while (t - t0 < ms) fn((t - t0) / ms, watch); };
  run(350, () => push(prev, false), false);
  run(250, (k) => push(prev.map((p, i) => ({ x: p.x + (target[i].x - p.x) * k, y: p.y + (target[i].y - p.y) * k, z: p.z + (target[i].z - p.z) * k })), false), false);
  run(v.pre, () => push(target, true), true);
  strokeT0 = t;
  const opts = L === "J" ? { size: v.size, twist: v.twist ?? 1, mirror: !!v.mirror } : { size: v.size, mirror: !!v.mirror, upward: !!v.upward };
  let last = target;
  run(v.dur, (k) => { last = (L === "J" ? sim.jFrame : sim.zFrame)(target, Math.min(1, k), opts); push(last, true); }, true);
  run(450, () => push(last, true), true);
  const got = hits.filter((h) => h.inStroke).map((h) => h.L);
  const ok = got.includes(L);
  return { ok, other: got.find((x) => x !== L) || null, fail: ok ? null : motionFailure(L, best), best };
}

// motion.js's start-shape gate applied to every held-out start hand, still
// (thresholds read from js/motion.js so this follows the code)
function startGate(L) {
  const src = lines("js/motion.js").join("\n");
  const num = (name) => +src.match(new RegExp(`${name} = ([\\d.]+)`))[1];
  const ext = (h, t, m) => {
    const s = Math.hypot((h[5].x + h[9].x + h[13].x + h[17].x) / 4 - h[0].x, (h[5].y + h[9].y + h[13].y + h[17].y) / 4 - h[0].y);
    return Math.hypot(h[t].x - h[m].x, h[t].y - h[m].y) / s;
  };
  const hands = test[L === "J" ? "I" : "Z"];
  const fails = { pinky: 0, index: 0, middle: 0 };
  let ok = 0;
  for (const s of hands) {
    const h = sim.handAt(s.v, 0.5, 0.5);
    const p = ext(h, 20, 17), i = ext(h, 8, 5), m = ext(h, 12, 9);
    const f = L === "J"
      ? { pinky: p < num("I_PINKY_MIN"), index: i > num("I_INDEX_MAX"), middle: m > num("I_MIDDLE_MAX") }
      : { index: i < num("Z_INDEX_MIN"), pinky: p > num("Z_PINKY_MAX"), middle: m > num("Z_MIDDLE_MAX") };
    if (!f.pinky && !f.index && !f.middle) ok++;
    for (const k in f) if (f[k]) fails[k]++;
  }
  const n = hands.length;
  return { pass: r3(ok / n), n, failBy: Object.fromEntries(Object.entries(fails).map(([k, c]) => [k, r3(c / n)])),
    note: L === "J" ? "I hand: pinky tip-knuckle >= I_PINKY_MIN spans, index <= I_INDEX_MAX, middle <= I_MIDDLE_MAX" : "pointing hand: index >= Z_INDEX_MIN, pinky <= Z_PINKY_MAX, middle <= Z_MIDDLE_MAX" };
}

function analyseMotion(L) {
  const VARS = L === "J" ? J_VARIANTS : Z_VARIANTS;
  const gate = startGate(L);
  const rows = [];
  const fails = {}, recog = {};
  let passTrials = 0, shapeGate = 0;
  for (const v of VARS) {
    const res = Array.from({ length: MOTION_TRIALS }, (_, i) => motionTrial(L, v, i));
    const rate = res.filter((r) => r.ok).length / res.length;
    const modes = {};
    for (const r of res) if (!r.ok) for (const m of r.fail) modes[m] = (modes[m] || 0) + 1;
    const other = res.filter((r) => r.other).length;
    rows.push({ name: v.name, group: v.group || "nominal", key: v.key ?? null, expect: v.expect, rate: r2(rate), n: res.length,
      failModes: Object.fromEntries(Object.entries(modes).map(([k, c]) => [k, r2(c / res.length)])), otherStroke: r2(other / res.length) });
    if (v.expect === "pass") {
      passTrials += res.length;
      for (const r of res) {
        if (r.other) recog[r.other] = (recog[r.other] || 0) + 1;
        if (r.ok) continue;
        if (r.fail.includes("shape gate")) shapeGate++;
        else for (const m of r.fail) fails[m] = (fails[m] || 0) + 1;
      }
    }
  }
  const nominal = rows[0];
  const by = (g) => Object.fromEntries([["nominal", nominal.rate], ...rows.filter((r) => r.group === g).map((r) => [r.key, r.rate])]);
  const half = nominal.rate / 2;
  const sizes = rows.filter((r) => r.group === "size" || r.group === "nominal").map((r) => ({ k: r.key ?? 1, r: r.rate })).sort((a, b) => a.k - b.k);
  const speeds = rows.filter((r) => r.group === "speed" || r.group === "nominal").map((r) => ({ k: r.key ?? (L === "J" ? 730 : 1000), r: r.rate })).sort((a, b) => a.k - b.k);
  const okS = speeds.filter((s) => s.r >= half && s.r > 0);
  return {
    own: nominal.rate, n: nominal.n,
    rejectedBy: {
      traits: Object.fromEntries(Object.entries(fails).map(([k, c]) => [k, { rate: r3(c / passTrials), dir: "low" }])),
      recogniser: Object.fromEntries(Object.entries(recog).map(([k, c]) => [k, r3(c / passTrials)])),
      nonLetter: r3(shapeGate / passTrials),
      note: "over every should-pass stroke variation; traits = the motion.js rule missed (drop / len / hook / twist/arm, turns / width / descent); nonLetter = the start-shape gate never engaged",
    },
    motion: { startShapeGate: gate, bySize: by("size"), bySpeedMs: by("speed"), byDirection: by("direction"), byStart: by("start"), variants: rows },
    registers: {
      minSize: sizes.find((s) => s.r >= half && s.r > 0)?.k ?? null,
      speedMs: okS.length ? [okS[0].k, okS.at(-1).k] : null,
      directions: rows.filter((r) => r.group === "direction" && r.rate >= half && r.rate > 0).map((r) => r.key),
      startHold: rows.filter((r) => r.group === "start" && r.expect !== "reject").map((r) => `${r.key} ${pct(r.rate)}`),
      note: `nominal ${L}: ${L === "J" ? "0.65-span drop + 0.2-span sideways + 1.7 rad hook/twist over 730 ms" : "1.9 x 1.3-span Z over 1000 ms"} on real held-out ${L === "J" ? "I" : "Z"} hands, start held 300 ms`,
    },
    acceptedAs: Object.fromEntries(rows.filter((r) => r.expect === "reject" && r.rate > 0).map((r) => [r.name, r.rate])),
  };
}

// ---- 4. Spell (ring pipeline, adaptive signer) ------------------------------------
function analyseSpell(L) {
  const r = { trials: SPELL_TRIALS, correct: 0, wrong: 0, doubled: 0, missed: 0, missedReadable: 0, missedUnreadable: 0, readable: 0, wrongAs: {}, unreadableReadAs: {}, enterMs: [] };
  for (let i = 0; i < SPELL_TRIALS; i++) {
    const o = sim.letterTrial(L, "ring", "adaptive", i);
    r[o.outcome]++;
    if (o.readable) r.readable++;
    if (o.outcome === "missed") o.readable ? r.missedReadable++ : r.missedUnreadable++;
    if (!o.readable) { const k = o.read ?? "none"; r.unreadableReadAs[k] = (r.unreadableReadAs[k] || 0) + 1; }
    if (o.outcome === "wrong") for (const c of o.got.replaceAll(L, "")) r.wrongAs[c] = (r.wrongAs[c] || 0) + 1;
    if (o.enterMs != null) r.enterMs.push(o.enterMs);
  }
  const n = SPELL_TRIALS;
  return {
    trials: n, correct: r2(r.correct / n), wrong: r2(r.wrong / n), doubled: r2(r.doubled / n), missed: r2(r.missed / n),
    missedReadable: r2(r.missedReadable / n), missedUnreadable: r2(r.missedUnreadable / n), readable: r2(r.readable / n),
    wrongAs: r.wrongAs, unreadableReadAs: r.unreadableReadAs,
    medianEnterMs: r.enterMs.length ? Math.round(median(r.enterMs)) : null,
  };
}

// ---- 5. struggles ------------------------------------------------------------------------
function strugglesStatic(L, x) {
  const s = [];
  const traitRow = A.traitRow(L);
  for (const [k, t] of Object.entries(x.rejectedBy.traits)) {
    const e = edgeOf(L, k);
    s.push({ mode: `${k} ${t.dir}: ${traitWords(L, k, t.dir)}`, rate: t.rate, stage: "trait",
      hint: `${pct(t.rate)} of ${x.n} held-out ${L} hands fail it (failing median ${fmt(t.failMedian)}; allowed ${e?.note ?? "?"}). Calibrated at ${traitAnchor(L, k)}; ${L}'s trait row ${traitRow}; slack ${A.slack}; 2-close rule ${A.okRule}.` });
  }
  for (const [X, r] of Object.entries(x.rejectedBy.recogniser)) {
    s.push({ mode: `recogniser reads ${X} and the hand also fits ${X}'s traits (veto)`, rate: r, stage: "recogniser",
      hint: `the verdict rejects ${L} because the recogniser says ${X} (${A.veto}); the ${L}/${X} split is kNN (${A.either}, k at ${A.knnK}) + heads (${A.heads}) — a ${L}-vs-${X} head or a trait that separates them would fix it.` });
  }
  if (x.rejectedBy.nonLetter >= 0.03) s.push({ mode: "recogniser rejects the hand as not-a-letter", rate: x.rejectedBy.nonLetter, stage: "non-letter rejection",
    hint: `nearest training hand farther than REJECT_DIST (${A.reject}). Practice gives it the benefit of the doubt, but Spell's ring gets no letter at all.` });
  const mis = Object.entries(x.readAs).filter(([k]) => k !== L && k !== "none" && !(k in x.rejectedBy.recogniser));
  for (const [X, r] of mis) if (r >= 0.05) s.push({ mode: `recogniser reads ${X} (verdict still passes; Spell would enter ${X})`, rate: r, stage: "recogniser (Spell)",
    hint: `top-1 misread with no trait veto: harmless in Practice, a wrong letter in Spell (kNN ${A.either} / heads ${A.heads}).` });
  addSpell(L, x.spell, s);
  const env = x.registers.envelope;
  const axes = x.registers.axes;
  const frag = (name, e, limit, words) => {
    if (e?.halvesAt == null || Math.abs(e.halvesAt) > limit) return;
    const i = e.levels.indexOf(e.halvesAt);
    const why = Object.entries(e.whyAtHalf || {}).slice(0, 2).map(([k, c]) => `${k} ${pct(c)}`).join(", ");
    const top = Object.keys(e.whyAtHalf || {})[0] || "";
    const where = top.startsWith("recogniser") ? `the recogniser (kNN ${A.either}; train augmentation is in-plane only, ${A.aug}) then the veto ${A.veto}`
      : top.startsWith("trait ") ? `trait ${top.split(" ")[1]} calibrated at ${traitAnchor(L, top.split(" ")[1])} (row ${traitRow})` : traitRow;
    s.push({ mode: `${words} ${Math.abs(e.halvesAt)}${name === "distance" ? " span" : name === "jitter" ? " σ" : "°"} (pass ${pct(env.base)} -> ${pct(e.rates[i])})`, rate: r3(Math.max(0, env.base - e.rates[i])), stage: `envelope${top ? `: ${top}` : ""}`,
      hint: `${why ? `rejected at that level by: ${why}. ` : ""}${name === "distance" ? `landmark noise grows relative to a small hand; smoothing at ${A.oneEuro}.` : `Look at ${where}.`}` });
  };
  frag("rotation+", axes["rotation+"], 20, "in-plane rotation +");
  frag("rotation-", axes["rotation-"], 20, "in-plane rotation -");
  frag("pitch", axes.pitch, 15, "tilted toward/away (pitch)");
  frag("yaw", axes.yaw, 15, "turned sideways (yaw)");
  frag("jitter", axes.jitter, 0.02, "landmark jitter");
  frag("curl", axes.curl, 20, "fingers curled at the middle joint");
  if (axes.distance.halvesAt != null && axes.distance.halvesAt >= 0.06) frag("distance", axes.distance, 1, "hand far away: span");
  for (const [X, r] of Object.entries(x.acceptedAs)) {
    if (r < 0.1) continue;
    const rd = x.acceptedAsRead[X] || {};
    const readTxt = Object.entries(rd).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k === "none" ? "rejected (null)" : k} ${pct(c)}`).join(", ");
    const why = (rd.none || 0) >= 0.5
      ? `the recogniser REJECTS most of them as non-letters (null), and judgeLetter treats null as benefit of the doubt (${A.nullPred}), so ${L}'s traits alone decide and they hold (${traitRow}).`
      : (rd[L] || 0) >= 0.5 ? `the recogniser itself reads them as ${L} (kNN ${A.either} / heads ${A.heads}) and ${L}'s traits (${traitRow}) hold — no trait separates ${X} from ${L}.`
      : `${L}'s traits (${traitRow}) also hold and the recogniser's reading isn't a letter whose traits fit, so the veto (${A.veto}) doesn't fire.`;
    s.push({ mode: `${X === "space" ? "relaxed non-letter" : X} hands count as ${L}`, rate: r, stage: "false-accept", hint: `recogniser read them as: ${readTxt}. ${why}` });
  }
  for (const [k, r] of Object.entries(x.registers.wrongShapeStillCounts)) if (r >= 0.5) s.push({ mode: `still counts with the ${k}`, rate: r, stage: "false-accept (wrong shape)",
    hint: `the wrong-shape trait for it is missing or too wide at ${traitRow}.` });
  return s.sort((a, b) => b.rate - a.rate);
}
function addSpell(L, sp, s) {
  if (!sp) return;
  if (sp.missedUnreadable > 0) s.push({ mode: `Spell: missed — held-out hand not read as ${L} at >= ${(0.8 * 100).toFixed(0)}% votes (read as ${Object.keys(sp.unreadableReadAs).join("/") || "?"})`, rate: sp.missedUnreadable, stage: "spell: recogniser",
    hint: `the ring only charges on vote share >= minConf (${A.minConf}) with a non-rejected label (${A.reject}); fix is on the recogniser side.` });
  if (sp.missedReadable > 0) s.push({ mode: "Spell: missed although the hand is readable (ring never filled)", rate: sp.missedReadable, stage: "spell: timing",
    hint: `ring needs ${A.confirmMs} of steady confident frames, bad-frame grace ${A.graceMs}, steadiness ${A.steady}.` });
  if (sp.wrong > 0) s.push({ mode: `Spell: wrong letter entered (${Object.keys(sp.wrongAs).join("/")})`, rate: sp.wrong, stage: "spell: wrong letter",
    hint: `a look-alike or transition shape held long enough to fill the ring (${A.confirmMs}, ${A.minConf}).` });
  if (sp.doubled > 0) s.push({ mode: "Spell: entered twice", rate: sp.doubled, stage: "spell: timing", hint: `release rules in js/spellgate.js (${A.graceMs}).` });
}
function strugglesMotion(L, x) {
  const s = [];
  const rule = L === "J" ? A.jRule : A.zRule;
  const g = x.motion.startShapeGate;
  if (g.pass < 0.9) {
    const worst = Object.entries(g.failBy).sort((a, b) => b[1] - a[1])[0];
    s.push({ mode: `start-shape gate rejects ${pct(1 - g.pass)} of real held-out ${L === "J" ? "I" : "Z"} hands (worst: ${worst[0]} ${pct(worst[1])})`, rate: r3(1 - g.pass), stage: "motion: shape gate",
      hint: `${g.note}; these tip-to-knuckle / span limits (${A.shapeGate}) were set on the dataset's per-letter p10/p90 but real ${L === "J" ? "I" : "Z"} hands from the held-out sessions fall outside them — every stroke from such a hand is dead before it starts (also needs ${A.shapeFrac} of frames in shape).` });
  }
  for (const v of x.motion.variants) {
    if (v.expect === "pass" && v.rate < 0.75) {
      const top = Object.entries(v.failModes).sort((a, b) => b[1] - a[1])[0];
      s.push({ mode: `${v.name}: only ${pct(v.rate)} register`, rate: r2(1 - v.rate), stage: `motion: ${top ? top[0] : "?"}`,
        hint: `top missed rule ${top ? `${top[0]} on ${pct(top[1])}` : "?"}; thresholds at ${top?.[0] === "shape gate" ? `${A.shapeGate} / ${A.shapeFrac}` : rule}; min stroke ${A.minStroke}, window ${A.window}.` });
    }
    if (v.expect === "reject" && v.rate >= 0.1) s.push({ mode: `${v.name} still registers as ${L}`, rate: v.rate, stage: "false-accept (motion)",
      hint: `the motion rules (${rule}) or the shape gate (${A.shapeGate}) accept it.` });
    if (v.expect === "info" && v.rate < 0.5) s.push({ mode: `${v.name}: ${pct(v.rate)} register (informational)`, rate: r2((1 - v.rate) * 0.5), stage: `motion: ${Object.keys(v.failModes)[0] || "?"}`,
      hint: `outside the designed envelope; ${rule}.` });
  }
  addSpell(L, x.spell, s);
  return s.sort((a, b) => b.rate - a.rate);
}

// ---- 6. speed --------------------------------------------------------------------------
function measureSpeed() {
  const R = rng(4242);
  const samples = [];
  for (const L of STATIC) for (const s of test[L].slice(0, 8)) samples.push({ L, hand: noisy(sim.handAt(s.v, 0.5, 0.55), R) });
  const refiner = (() => { try { return createRefiner(JSON.parse(fs.readFileSync(path.join(ROOT, "js", "heads.json"), "utf8"))); } catch { return null; } })();
  const reference = buildReference(lab.train.filter((s) => cfg.LETTERS.includes(s.label)), cfg.LETTERS);
  const norm = (h) => normalizeLandmarks(h, { aspect: 1, mirrorX: false, extended: cfg.USE_EXTENDED_FEATURES });
  // median of 5 timed rounds (after a warm-up) — single rounds swung ~2x
  // between runs on this machine (JIT / GC / CPU clock)
  const time = (fn, reps = 1) => {
    for (const s of samples) fn(s); // warm up
    const rounds = [];
    for (let q = 0; q < 5; q++) {
      const t0 = performance.now();
      for (let r = 0; r < reps; r++) for (const s of samples) fn(s);
      rounds.push((performance.now() - t0) / (reps * samples.length));
    }
    return median(rounds);
  };
  const vecs = new Map(samples.map((s) => [s, norm(s.hand)]));
  const preds = new Map(samples.map((s) => [s, predict(vecs.get(s))]));
  const normalizeMs = time((s) => norm(s.hand));
  const knnHeadsMs = time((s) => predict(vecs.get(s)));
  const classifyMs = time((s) => sim.classify(s.hand));
  const judgeMs = time((s) => judgeLetter(judge, vecs.get(s), s.L, preds.get(s), 0.3), 10);
  const refScoreMs = time((s) => reference.score(vecs.get(s), s.L, { refiner }), 5);
  const filter = createLandmarkFilter({ mincutoff: cfg.ONE_EURO_MIN_CUTOFF, beta: cfg.ONE_EURO_BETA, dcutoff: cfg.ONE_EURO_DCUTOFF });
  const mm = createMotionMatcher();
  const gate = createSpellGate();
  let t = 0;
  const practiceFrameMs = time((s) => {
    t += 33;
    const h = filter.filter(s.hand, t / 1000);
    mm.push(h, t, 1); mm.match(t);
    const v = norm(h);
    const p = predict(v);
    reference.score(v, s.L, { refiner });
    judgeLetter(judge, v, s.L, p, 0.3);
  });
  const spellFrameMs = time((s) => {
    t += 33;
    const h = filter.filter(s.hand, t / 1000);
    mm.push(h, t, 1); const st = mm.match(t);
    const v = norm(h);
    const p = predict(v);
    gate.feed({ now: t, letter: p, conf: 0.9, stroke: st, pos: { x: h[0].x, y: h[0].y, span: 0.12 } });
  });
  const motionMs = time((s) => { t += 33; mm.push(s.hand, t, 1); mm.match(t); });
  return {
    normalizeMs: r3(normalizeMs), knnHeadsMs: r3(knnHeadsMs), classifyMs: r3(classifyMs), judgeLetterMs: r3(judgeMs),
    referenceScoreMs: r3(refScoreMs), motionPushMatchMs: r3(motionMs),
    practiceFrameMs: r3(practiceFrameMs), spellFrameMs: r3(spellFrameMs),
    frameBudgetMs: 33.3, calls: samples.length,
    note: "measured, mean ms per call on this machine (Electron's Node/V8), held-out hands as noisy image landmarks. classify = normalize + either-hand kNN (2 passes) + REJECT_DIST + heads (main.js per-frame path). practiceFrame = one-euro + motion push/match + normalize + kNN/heads + reference.score + judgeLetter; spellFrame = one-euro + motion + normalize + kNN/heads + spellgate.feed. Excludes MediaPipe inference, swipe/twohand, drawing.",
  };
}

// ---- run ----------------------------------------------------------------------------------
const letters = {};
for (const L of scope) {
  log(`${L} `);
  const x = L === "J" || L === "Z" ? analyseMotion(L) : analyseStatic(L);
  x.spell = analyseSpell(L);
  x.struggles = L === "J" || L === "Z" ? strugglesMotion(L, x) : strugglesStatic(L, x);
  letters[L] = x;
}
log("\nspeed… ");
const speed = measureSpeed();
log("done\n");

let commit = null;
try { commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch {}
const report = {
  generated: new Date().toISOString().slice(0, 16),
  commit,
  mode: FULL ? "full" : QUICK ? "quick" : "scoped",
  scope: scope.join(""),
  runtimeSec: null,
  split: { trainFrac: 0.8, kind: "blocked per letter (last 20% of each letter's recordings held out)", heldOut: Object.fromEntries(Object.entries(test).map(([k, v]) => [k, v.length])), perturbHands: PER, spellTrials: SPELL_TRIALS, motionTrials: MOTION_TRIALS },
  speed,
  worst: Object.entries(letters).sort((a, b) => a[1].own - b[1].own).map(([L, x]) => ({ L, own: x.own, spell: x.spell.correct, top: x.struggles[0]?.mode ?? null })),
  letters,
};
report.runtimeSec = Math.round((performance.now() - T0) / 100) / 10;

// ---- REPORT.md -------------------------------------------------------------------------------
function registersText(L, x) {
  if (L === "J" || L === "Z") {
    const r = x.registers;
    const g = x.motion.startShapeGate;
    return `${r.note}. Start-shape gate passes ${pct(g.pass)} of ${g.n} held-out start hands (fails: ${Object.entries(g.failBy).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}). Registers at stroke size >= ${r.minSize ?? "?"}x, stroke ${r.speedMs ? `${r.speedMs[0]}-${r.speedMs[1]} ms` : "?"}, directions: ${r.directions.join(", ") || "nominal only"}; start: ${r.startHold.join(", ")}. By size ${JSON.stringify(x.motion.bySize)} · by speed ${JSON.stringify(x.motion.bySpeedMs)} · by direction ${JSON.stringify(x.motion.byDirection)} · by start ${JSON.stringify(x.motion.byStart)}.`;
  }
  const tr = Object.entries(x.registers.traits).map(([k, t]) => `${MEANING[k]?.name ?? k} ${t.note} (passing median ${fmt(t.passMedian)})`).join("; ");
  const e = x.registers.envelope;
  const v = (a) => (a == null ? "all tested" : a);
  const fingers = Object.entries(e.fingerBendDeg).map(([f, b]) => `${f} ${b.wrong} ${v(b.halvesAt)}°`).join(", ");
  return `${tr}. Tolerates: in-plane rotation +${v(e.rotationDeg.pos)}° / -${v(e.rotationDeg.neg)}° · pitch ${v(e.tiltDeg.pitch)}° · yaw ${v(e.tiltDeg.yaw)}° · distance down to span ${e.minSpan == null ? "0.025 (all tested)" : `> ${e.minSpan}`} · jitter σ ${v(e.jitter)} · fan ${v(e.fanDeg)}°/gap · squeeze ${v(e.squeezeDeg)}° · curl ${v(e.curlDeg)}° · thumb out ${v(e.thumbSwingDeg.out)}° / in ${v(e.thumbSwingDeg.in)}°${fingers ? ` · wrong-way bend halves pass at: ${fingers}` : ""} (level where the pass rate halves).`;
}
function renderReport(rep) {
  const L2 = Object.keys(rep.letters);
  const md = [
    "# Per-letter accuracy report (generated by tools/lab/letter-report.mjs)",
    "",
    `Generated ${rep.generated} at ${rep.commit ?? "?"} · ${rep.mode} run · ${rep.runtimeSec} s. Honest boundary: no camera — held-out REAL dataset hands (blocked 80/20 split) through the shipped verdict; perturbations are physical (tools/synth-hand.js); J/Z are synthetic strokes on real start hands through js/motion.js; Spell is the ring pipeline (js/spellgate.js) simulated frame by frame. Camera feel still needs a live check. Pitch/yaw rotate the landmarks in 3D, so they mostly move z; MediaPipe's z is a rough relative-depth estimate, so read those two envelopes as how sensitive the recogniser is to z, not a measured camera angle.`,
    "",
    `Speed (measured, ms/call): classify ${rep.speed.classifyMs} (normalize ${rep.speed.normalizeMs} + kNN/heads ${rep.speed.knnHeadsMs}) · judgeLetter ${rep.speed.judgeLetterMs} · reference.score ${rep.speed.referenceScoreMs} · motion ${rep.speed.motionPushMatchMs} · **Practice frame ${rep.speed.practiceFrameMs}** · **Spell frame ${rep.speed.spellFrameMs}** (budget 33 ms at 30 fps, MediaPipe excluded).`,
    "",
    "| letter | own pass (n) | recogniser top-1 | Spell correct / missed / wrong | enter ms | top struggle (stage) | worst false accept |",
    "|---|---|---|---|---|---|---|",
    ...L2.map((L) => {
      const x = rep.letters[L];
      const top1 = x.readAs ? pct(x.readAs[L] ?? 0) : "—";
      const s0 = x.struggles[0];
      const fa = Object.entries(x.acceptedAs || {}).sort((a, b) => b[1] - a[1])[0];
      return `| ${L} | ${pct(x.own)} (${x.n}) | ${top1} | ${pct(x.spell.correct)} / ${pct(x.spell.missed)} / ${pct(x.spell.wrong)} | ${x.spell.medianEnterMs ?? "—"} | ${s0 ? `${s0.mode} — ${pct(s0.rate)} (${s0.stage})` : "none"} | ${fa ? `${fa[0]} ${pct(fa[1])}` : "none"} |`;
    }),
    "",
    `Worst by own pass: ${rep.worst.slice(0, 8).map((w) => `${w.L} ${pct(w.own)}`).join(" · ")}`,
    "",
  ];
  for (const L of L2) {
    const x = rep.letters[L];
    md.push(`## ${L} — own ${pct(x.own)} of ${x.n} · Spell ${pct(x.spell.correct)} correct`, "");
    md.push(`**Registers when** ${registersText(L, x)}`, "");
    if (x.struggles.length) {
      md.push("**Struggles when**", "");
      for (const s of x.struggles.slice(0, 8)) md.push(`- ${pct(s.rate)} · *${s.stage}* · ${s.mode}. ${s.hint}`);
    } else md.push("**Struggles when** — nothing measurable at this depth.");
    md.push("");
  }
  return md.join("\n");
}

// ---- compare -----------------------------------------------------------------------------------
function compare(old, cur) {
  const out = [];
  const d = (a, b) => (b ?? 0) - (a ?? 0);
  const line = (L, what, a, b) => { if (Math.abs(d(a, b)) >= 0.02) out.push(`${L} ${what}: ${pct(a ?? 0)} -> ${pct(b ?? 0)} (${d(a, b) > 0 ? "+" : ""}${Math.round(100 * d(a, b))})`); };
  for (const [L, x] of Object.entries(cur.letters)) {
    const o = old.letters?.[L];
    if (!o) { out.push(`${L}: new in this report`); continue; }
    line(L, "own", o.own, x.own);
    if ((o.spell?.trials ?? 0) === x.spell.trials) line(L, "spell correct", o.spell?.correct, x.spell.correct);
    else if (L === Object.keys(cur.letters)[0]) out.push(`(spell not compared: ${o.spell?.trials} vs ${x.spell.trials} trials — use the same --quick setting)`);
    for (const k of new Set([...Object.keys(o.rejectedBy?.traits || {}), ...Object.keys(x.rejectedBy.traits)])) line(L, `rejected by ${k}`, o.rejectedBy?.traits?.[k]?.rate, x.rejectedBy.traits[k]?.rate);
    for (const k of new Set([...Object.keys(o.rejectedBy?.recogniser || {}), ...Object.keys(x.rejectedBy.recogniser)])) line(L, `vetoed as ${k}`, o.rejectedBy?.recogniser?.[k], x.rejectedBy.recogniser[k]);
    line(L, "non-letter", o.rejectedBy?.nonLetter, x.rejectedBy.nonLetter);
    for (const k of new Set([...Object.keys(o.acceptedAs || {}), ...Object.keys(x.acceptedAs || {})])) line(L, `accepts ${k}`, o.acceptedAs?.[k], x.acceptedAs?.[k]);
    for (const v of x.motion?.variants || []) line(L, `motion ${v.name}`, o.motion?.variants?.find((w) => w.name === v.name)?.rate, v.rate);
  }
  for (const k of ["classifyMs", "judgeLetterMs", "practiceFrameMs", "spellFrameMs"]) if (old.speed?.[k] != null) out.push(`speed ${k}: ${old.speed[k]} -> ${cur.speed[k]} ms`);
  return out;
}

// ---- output --------------------------------------------------------------------------------------
if (OUT) {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1) + "\n");
  fs.writeFileSync(path.join(OUT, "REPORT.md"), renderReport(report));
}
console.log("letter  own    spell  top struggle");
for (const [L, x] of Object.entries(letters)) console.log(`${L}       ${pct(x.own).padEnd(6)} ${pct(x.spell.correct).padEnd(6)} ${x.struggles[0] ? `${x.struggles[0].mode} ${pct(x.struggles[0].rate)} [${x.struggles[0].stage}]` : "-"}`);
console.log(`speed: classify ${speed.classifyMs} ms · judgeLetter ${speed.judgeLetterMs} ms · practice frame ${speed.practiceFrameMs} ms · spell frame ${speed.spellFrameMs} ms`);
if (COMPARE) {
  const old = JSON.parse(fs.readFileSync(COMPARE, "utf8"));
  const moved = compare(old, report);
  console.log(`\n--compare ${COMPARE}: ${moved.length ? "" : "nothing moved >= 2 pts"}`);
  for (const m of moved) console.log("  " + m);
}

// ---- issues (full run only) -----------------------------------------------------------------------
if (FILE_ISSUES) {
  const found = [];
  const add = (L, mode, sev, title, metric) => {
    const key = `letter-${L}-${mode}`;
    found.push(key);
    upsertIssue({ key, title, severity: sev, foundBy: "letter-tester", metric, area: `letter ${L}`, repro: "node tools/lab/letter-report.mjs --letters " + L });
  };
  for (const [L, x] of Object.entries(letters)) {
    const top = x.struggles.find((s) => !s.stage.startsWith("spell") && !s.stage.startsWith("false"));
    if (x.own < 0.75) add(L, "own", "P1", `${L}: only ${pct(x.own)} of held-out ${L} register${top ? ` — mostly ${top.mode}` : ""}`, `own ${pct(x.own)}; ${top ? `${top.stage} ${pct(top.rate)}` : ""}`);
    if (x.spell.correct <= 0.625 && x.spell.trials >= 8) add(L, "spell", "P1", `${L} in Spell (ring): ${pct(x.spell.correct)} entered correctly`, `missed ${pct(x.spell.missed)} (unreadable ${pct(x.spell.missedUnreadable)}), wrong ${pct(x.spell.wrong)}`);
    for (const [X, r] of Object.entries(x.acceptedAs || {})) {
      if (L === "J" || L === "Z") continue;
      if (r >= 0.15) add(L, `accepts-${X}`, "P0", `${pct(r)} of real ${X === "space" ? "relaxed non-letter" : X} hands count as ${L}`, `${X}->${L} ${pct(r)}`);
    }
    for (const v of x.motion?.variants || []) {
      const slug = v.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      if (v.expect === "pass" && v.rate < 0.5) add(L, `motion-${slug}`, "P1", `${L} ${v.name}: only ${pct(v.rate)} register`, `fails: ${JSON.stringify(v.failModes)}`);
      if (v.expect === "reject" && v.rate >= 0.2) add(L, `false-${slug}`, "P0", `${L} fires on "${v.name}" ${pct(v.rate)} of the time`, `${pct(v.rate)}`);
    }
  }
  const resolved = resolveMissing("letter-tester", found);
  renderMd();
  console.log(`issues: ${found.length} found${resolved.length ? `, resolved ${resolved.join(" ")}` : ""}`);
}
console.log(`runtime ${report.runtimeSec} s (${report.mode}, ${scope.length} letters)`);
