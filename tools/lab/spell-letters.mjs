// tools/lab/spell-letters.mjs — per-letter + word tests of Spell mode's input.
//
//   node tools/lab/spell-letters.mjs [--pipe hold|fluid|ring|all] [--trials N]
//                                    [--profile adaptive|steady|brisk|all]
//                                    [--set key=value ...] [--json out.json] [--quiet]
//   (on the Mac: ELECTRON_RUN_AS_NODE=1 ".../Visual Studio Code.app/Contents/MacOS/Code" tools/lab/spell-letters.mjs)
//
// Drives Spell's input pipeline frame by frame (30 fps, jittered clock) the
// way js/main.js runs it: one-euro smoothing -> normalize -> either-hand kNN
// -> REJECT_DIST -> learned heads -> {pipeline} -> speller.js, plus motion.js
// for J/Z. Hands are HELD-OUT real dataset vectors (tools/lab/lab-data.mjs's
// blocked test split; the classifier is trained on the other 80%), rebuilt
// as image-space landmarks at a fixed hand size, with per-frame landmark
// noise, a slow sway, a small wrist shift between letters, interpolated
// transitions, and (1 in 3 trials) a brief tracking dropout mid-hold.
//
// Pipelines (mirrors of main.js's Spell branch — keep them in step):
//   hold   the pre-2026-09-25 default: spellStab (16 frames @ 0.8) + a
//          still-hand gate + speller.feed() (pause 2 s = word)
//   fluid  the opt-in "Fluid + speak" path: transition.js -> addLetter
//   ring   the circle lock: js/spellgate.js -> addLetter / replaceLast / space
//
// Per-letter test: for each letter X, trials of  W -> X -> Y  (W, Y random
// other static letters), scoring only what entered during X's segment
// (from the middle of W->X to the middle of X->Y):
//   correct = exactly one X · doubled = X twice+ · wrong = any other letter
//   entered (instead of or besides X) · missed = nothing entered.
// Signer profiles: adaptive = holds until the app enters the letter + 250 ms
// reaction (cap 2.4 s; what a learner watching the ring does) · steady =
// fixed ~1.1 s holds · brisk = fixed ~0.75 s holds.
// Word tests (readable held-out hands only): HI, CAT, HELLO (the doubled L with a small sideways bounce),
// "HI CAT" with a 2.8 s pause (hand held on I) and "HI CAT" with the hand
// dropped for 2.6 s between words.
//
// Honest boundary: no camera. Real hands are the dataset's posed stills;
// transitions are linear interpolations, not real coarticulation; MediaPipe
// noise is modelled as Gaussian jitter. Relative numbers between pipelines
// are the signal.
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ROOT, loadLab, rng, gauss } from "./lab-data.mjs";

const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const args = process.argv.slice(2);
const arg = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const PIPES = arg("--pipe", "all") === "all" ? ["hold", "fluid", "ring"] : arg("--pipe").split(",");
const PROFILES = arg("--profile", "all") === "all" ? ["adaptive", "steady", "brisk"] : arg("--profile").split(",");
const TRIALS = +arg("--trials", 8);
const QUIET = args.includes("--quiet");
const DEBUG = args.includes("--debug");
const ONLY_LETTERS = arg("--letters", null)?.split("") || null;
const NO_WORDS = args.includes("--no-words");
const JSON_OUT = arg("--json", null);
const GATE_SET = {};
args.forEach((a, i) => { if (a === "--set") { const [k, v] = args[i + 1].split("="); GATE_SET[k] = +v; } });

const cfg = await imp("js/config.js");
const { normalizeLandmarks, mirrorVector, rotateVector } = await imp("js/normalize.js");
const { createClassifier, classifyEitherHand } = await imp("js/knn.js");
const { createRefiner } = await imp("js/heads.js");
const { createStabilizer } = await imp("js/stabilizer.js");
const { createTransitionMatcher } = await imp("js/transition.js");
const { createSpeller, STROKE_START } = await imp("js/speller.js");
const { createMotionMatcher } = await imp("js/motion.js");
const { createLandmarkFilter } = await imp("js/onefilter.js");
let createSpellGate = null;
try { ({ createSpellGate } = await imp("js/spellgate.js")); } catch {}

// ---- recogniser: exactly main.js's per-frame classify ----------------------
const lab = await loadLab();
const trainAug = [];
for (const s of lab.train) {
  if (!cfg.LETTERS.includes(s.label)) continue;
  trainAug.push({ label: s.label, v: s.v });
  for (const a of lab.data.augmentRotations || []) trainAug.push({ label: s.label, v: rotateVector(s.v, a) });
}
const clf = createClassifier(trainAug, { k: cfg.KNN_K });
let refiner = null;
try { refiner = createRefiner(JSON.parse(fs.readFileSync(path.join(ROOT, "js", "heads.json"), "utf8"))); } catch {}
function classify(hand) {
  const vec = normalizeLandmarks(hand, { aspect: 1, mirrorX: false, extended: cfg.USE_EXTENDED_FEATURES });
  const e = classifyEitherHand(clf, vec, mirrorVector);
  let p = e.pred ? { ...e.pred } : null;
  if (p && p.distance > cfg.REJECT_DIST) p = null;
  if (p && refiner) p.label = refiner.refine(e.vec, p.label);
  return p;
}

// ---- synthetic hands from held-out vectors ---------------------------------
const SPAN = 0.12; // wrist -> knuckles, frame units (arm's-length webcam)
const vecSpan = (v) => {
  let mx = 0, my = 0;
  for (const j of [5, 9, 13, 17]) { mx += v[j * 3]; my += v[j * 3 + 1]; }
  return Math.hypot(mx / 4 - v[0], my / 4 - v[1]) || 1e-6;
};
// normalized vector -> image-space landmarks, wrist at (wx, wy), span = SPAN
function handAt(v, wx, wy) {
  const k = SPAN / vecSpan(v);
  return Array.from({ length: 21 }, (_, i) => ({ x: wx + v[i * 3] * k, y: wy + v[i * 3 + 1] * k, z: v[i * 3 + 2] * k }));
}
const lerpHand = (a, b, t) => a.map((p, i) => ({ x: p.x + (b[i].x - p.x) * t, y: p.y + (b[i].y - p.y) * t, z: p.z + (b[i].z - p.z) * t }));
// J: the I hand drops, hooks and twists (tools/synth-hand.js "true J", in spans)
function jFrame(base, k) {
  const w = base[0];
  const drop = 0.65 * SPAN * Math.min(1, k / 0.55), dx = -0.2 * SPAN * k;
  const theta = -1.7 * Math.max(0, (k - 0.35) / 0.65), sup = 1 - 0.5 * k;
  // hand-local lateral axis = perpendicular to wrist -> middle knuckle
  const ax = [base[9].x - w.x, base[9].y - w.y], L = Math.hypot(...ax) || 1e-9;
  const u = [ax[0] / L, ax[1] / L], n = [-u[1], u[0]];
  const c = Math.cos(theta), s = Math.sin(theta);
  return base.map((p) => {
    const rx = p.x - w.x, ry = p.y - w.y;
    const a = rx * u[0] + ry * u[1], b = (rx * n[0] + ry * n[1]) * sup;
    const x = a * u[0] + b * n[0], y = a * u[1] + b * n[1];
    return { x: w.x + dx + x * c - y * s, y: w.y + drop + x * s + y * c, z: p.z };
  });
}
// Z: the pointing hand draws a Z with the arm (synth "true Z", 1.9 spans wide)
function zFrame(base, k) {
  const segs = [[[0, 0], [1.9, 0]], [[1.9, 0], [0, 1.3]], [[0, 1.3], [1.9, 1.3]]];
  const u = Math.min(2.999, k * 3), i = Math.floor(u), f = u - i;
  const [a, b] = segs[i];
  const dx = (a[0] + (b[0] - a[0]) * f) * SPAN, dy = (a[1] + (b[1] - a[1]) * f) * SPAN;
  return base.map((p) => ({ x: p.x + dx, y: p.y + dy, z: p.z }));
}

// ---- a scripted signer -------------------------------------------------------
// steps: { L, hold } letter holds · { gone: ms } hand out of view ·
//   { bounce: spans } a sideways slide keeping the shape (doubled letter)
// Each letter step is reached through a `trans` ms interpolation from the
// previous hand. Hold length comes from the profile.
const PROFILE = {
  adaptive: { hold: [900, 150], trans: [320, 70], adaptive: true },
  steady: { hold: [1100, 180], trans: [340, 70] },
  brisk: { hold: [750, 120], trans: [260, 60] },
};
// word tests draw only held-out hands the recogniser reads (clean, >= 0.8):
// they measure timing / segmentation, not the classifier's per-hand misses
// (the per-letter test uses every held-out hand and reports both)
const readableCache = {};
const readableOf = (L) => (readableCache[L] ||= (lab.test[L] || lab.byL[L]).filter((s) => {
  const p = classify(handAt(s.v, 0.5, 0.55));
  return p && p.label === L && p.confidence >= 0.8;
}));
const testVecs = (L, R, readable = false) => {
  let arr = lab.test[L] || lab.byL[L];
  if (readable && cfg.LETTERS.includes(L) && readableOf(L).length) arr = readableOf(L);
  return arr[Math.floor(R() * arr.length)].v;
};
const START_SHAPE = { J: "I", Z: "Z" }; // Z's pointing hand: the dataset's Z stills

function makeScript(steps, R, prof, { dropoutAt = -1, readable = false } = {}) {
  // expand to timed segments; letter holds may end early/late (adaptive)
  const segs = [];
  let wx = 0.5, wy = 0.55;
  steps.forEach((st, idx) => {
    if (st.gone) { segs.push({ kind: "gone", ms: st.gone }); return; }
    if (st.bounce) { segs.push({ kind: "bounce", ms: 220, dx: st.bounce * SPAN }); return; }
    const shape = START_SHAPE[st.L] || st.L;
    const v = testVecs(shape, R, readable);
    // a small wrist shift between letters (real hands don't return to one pixel)
    wx += (R() - 0.5) * 0.35 * SPAN; wy += (R() - 0.5) * 0.25 * SPAN;
    const hold = st.hold ?? Math.max(350, prof.hold[0] + gauss(R) * prof.hold[1]);
    const trans = Math.max(120, prof.trans[0] + gauss(R) * prof.trans[1]);
    segs.push({ kind: "letter", L: st.L, v, wx, wy, hold, trans, idx, dropout: idx === dropoutAt || !!st.dropout, fixed: st.hold != null, stroke: st.L === "J" || st.L === "Z" });
    if (st.pause) segs.push({ kind: "pause", ms: st.pause });
  });
  return segs;
}

// run a script through a pipeline. Returns { commits:[{L,t,seg}], text, segBounds }
function runScript(segs, pipe, R, prof) {
  const P = PIPELINES[pipe]();
  let t = 1000 + R() * 50;
  const frame = () => (t += 1000 / 30 + (R() - 0.5) * 6);
  const commits = [];
  const segStart = [];
  let prevHand = null;
  let swayPh = R() * 6;
  const noisy = (h) => {
    swayPh += 0.07;
    const sx = Math.sin(swayPh) * 0.004, sy = Math.cos(swayPh * 0.7) * 0.003;
    return h.map((p) => ({ x: p.x + sx + gauss(R) * 0.0022, y: p.y + sy + gauss(R) * 0.0022, z: p.z + gauss(R) * 0.002 }));
  };
  let phase = "";
  const step = (hand, segIdx, ph = "") => {
    phase = ph;
    const ev = P.frame(t, hand ? noisy(hand) : null);
    for (const e of ev) {
      if (DEBUG) console.log(`  [${pipe}] t=${t.toFixed(0)} seg=${segIdx} ${phase} ${e.type} ${e.L}`);
      if (e.type === "add") commits.push({ L: e.L, t, seg: segIdx });
      else if (e.type === "replace" && commits.length) Object.assign(commits.at(-1), { L: e.L, replaced: true });
      else if (e.type === "replace") commits.push({ L: e.L, t, seg: segIdx });
    }
    return ev;
  };
  segs.forEach((s, si) => {
    segStart.push(t);
    if (s.kind === "gone" || s.kind === "pause") {
      const end = t + s.ms;
      const hold = s.kind === "pause" ? prevHand : null;
      while (t < end) { frame(); step(hold, si); }
      if (s.kind === "gone") prevHand = null;
      return;
    }
    if (s.kind === "bounce") {
      const from = prevHand, end = t + s.ms, t0 = t;
      while (t < end) {
        frame();
        const k = Math.min(1, (t - t0) / s.ms), off = Math.sin(k * Math.PI) * s.dx;
        step(from.map((p) => ({ ...p, x: p.x + off * 0.5 + (k * s.dx) / 2 })), si);
      }
      prevHand = from.map((p) => ({ ...p, x: p.x + s.dx / 2 }));
      return;
    }
    const target = handAt(s.v, s.wx, s.wy);
    // transition (the hand arrives from wherever it was; from out of view it
    // rises into place, which is also a transition the classifier sees)
    const from = prevHand || target.map((p) => ({ ...p, y: p.y + 0.6 * SPAN * 3 }));
    const t0 = t;
    s.segT0 = t0;
    while (t - t0 < s.trans) { frame(); step(lerpHand(from, target, Math.min(1, (t - t0) / s.trans)), si, "trans"); }
    s.midIn = t0 + s.trans / 2;
    // hold (+ stroke for J/Z)
    const h0 = t;
    const nBefore = commits.length;
    const adapt = prof.adaptive && !s.fixed;
    const cap = adapt ? 2400 : s.hold;
    let doneAt = null;
    const dropFrom = s.dropout ? h0 + s.hold * 0.45 : Infinity, dropTo = dropFrom + 110 + R() * 90;
    if (s.stroke) {
      // hold the start shape briefly, trace, then hold the end pose
      const pre = 300, dur = s.L === "J" ? 730 : 1000;
      while (t - h0 < pre) { frame(); step(target, si, "pre"); }
      const s0 = t;
      let last = target;
      while (t - s0 < dur) { frame(); last = (s.L === "J" ? jFrame : zFrame)(target, Math.min(1, (t - s0) / dur)); step(last, si, "stroke"); }
      const s1 = t;
      const post = prof.adaptive ? 2000 : Math.max(250, s.hold - pre - dur + 400);
      while (t - s1 < post) {
        frame(); step(last, si, "post");
        if (prof.adaptive && commits.length > nBefore && commits.at(-1).L === s.L) { if (!doneAt) doneAt = t; if (t - doneAt >= 250) break; }
      }
      prevHand = last;
    } else {
      while (t - h0 < cap) {
        frame();
        step(t >= dropFrom && t < dropTo ? null : target, si, "hold");
        if (adapt && commits.length > nBefore) { if (!doneAt) doneAt = t; if (t - doneAt >= 250) break; }
      }
      prevHand = target;
    }
    s.holdEnd = t;
  });
  // let everything settle (word windows / pauses expire) with the hand gone
  const end = t + 3200;
  while (t < end) { frame(); step(null, segs.length); }
  return { commits, text: P.text(), segs };
}

// ---- pipelines (mirror js/main.js's Spell branch) ----------------------------
const HAND_ENTRY_MS = 400;
function common() {
  const filter = createLandmarkFilter({ mincutoff: cfg.ONE_EURO_MIN_CUTOFF, beta: cfg.ONE_EURO_BETA, dcutoff: cfg.ONE_EURO_DCUTOFF });
  const motion = createMotionMatcher();
  let handSeenSince = 0, lastHandSeenAt = 0;
  return {
    pre(now, raw, onLost) {
      const hasHand = !!raw;
      if (hasHand && !handSeenSince) handSeenSince = now;
      if (!hasHand && handSeenSince && now - lastHandSeenAt > 300) { handSeenSince = 0; onLost?.(); }
      if (hasHand) lastHandSeenAt = now;
      const handEntering = hasHand && now - handSeenSince < HAND_ENTRY_MS;
      const hand = filter.filter(hasHand ? raw : null, now / 1000);
      motion.push(hand, now, 1);
      const stroke = motion.match(now);
      const pred = hasHand && hand ? classify(hand) : null;
      return { hasHand, hand, handEntering, stroke, pred };
    },
  };
}
const spanOf = (h) => {
  let mx = 0, my = 0;
  for (const j of [5, 9, 13, 17]) { mx += h[j].x; my += h[j].y; }
  return Math.hypot(mx / 4 - h[0].x, my / 4 - h[0].y) || 1e-6;
};

const PIPELINES = {
  // the pre-2026-09-25 default ("hold to type")
  hold() {
    const c = common();
    const speller = createSpeller();
    const spellStab = createStabilizer({ stableFrames: 16, minConfidence: 0.8 });
    let spellWrist = [], spellAnchor = null, spellMaxAway = 0, spellLastCommitAt = 0;
    let prev = "";
    return {
      text: () => speller.display,
      frame(now, raw) {
        const { hasHand, hand, handEntering, stroke, pred } = c.pre(now, raw, () => spellStab.reset());
        spellStab.push(hasHand && !handEntering ? pred : null);
        spellWrist.push({ t: now, x: hand?.[0]?.x ?? 0, y: hand?.[0]?.y ?? 0, has: hasHand });
        while (spellWrist.length && now - spellWrist[0].t > 200) spellWrist.shift();
        let handSpeed = Infinity;
        if (hasHand && hand && spellWrist.length >= 3 && spellWrist.every((f) => f.has)) {
          const a = spellWrist[0], b = spellWrist.at(-1);
          handSpeed = Math.hypot(b.x - a.x, b.y - a.y) / spanOf(hand);
        }
        const still = handSpeed < 0.3 && !handEntering;
        const cand = spellStab.candidate, cur = spellStab.current;
        const holding = still && spellStab.progress >= 1 && !!cand && cand === cur;
        if (hasHand && hand && spellAnchor) {
          if (holding) spellAnchor = { x: hand[0].x, y: hand[0].y };
          else spellMaxAway = Math.max(spellMaxAway, Math.hypot(hand[0].x - spellAnchor.x, hand[0].y - spellAnchor.y) / spanOf(hand));
        }
        const moved = spellMaxAway > 0.8;
        const spellStroke = stroke && (now - spellLastCommitAt > 700 || speller.last === STROKE_START[stroke]) ? stroke : null;
        const res = speller.feed({ holding, letter: cur, stroke: spellStroke, handPresent: hasHand, moved, now });
        if (res.event === "letter") {
          spellLastCommitAt = now; spellMaxAway = 0;
          spellAnchor = hasHand && hand ? { x: hand[0].x, y: hand[0].y } : null;
        }
        return diff();
      },
    };
    function diff() {
      const cur = speller.display.replace(/ /g, "");
      const out = [];
      if (cur.length > prev.length) out.push({ type: "add", L: cur.at(-1) });
      else if (cur.length === prev.length && cur && cur !== prev) out.push({ type: "replace", L: cur.at(-1) });
      prev = cur;
      return out;
    }
  },

  // "Fluid + speak": transition.js settle-after-move
  fluid() {
    const c = common();
    const speller = createSpeller();
    const tr = createTransitionMatcher();
    return {
      text: () => speller.display,
      frame(now, raw) {
        const { hand, handEntering, pred } = c.pre(now, raw);
        tr.push(hand, handEntering ? null : pred, now);
        const e = tr.read();
        const out = [];
        if (e && speller.addLetter(e.letter, e.conf, now) === "letter") out.push({ type: "add", L: e.letter });
        return out;
      },
    };
  },

  // the circle lock (js/spellgate.js) — as wired in main.js
  ring() {
    if (!createSpellGate) throw new Error("js/spellgate.js not found");
    const c = common();
    const speller = createSpeller();
    const gate = createSpellGate(GATE_SET);
    let lastCommitAt = 0;
    return {
      text: () => speller.display,
      frame(now, raw) {
        const { hasHand, hand, handEntering, stroke, pred } = c.pre(now, raw);
        const live = hasHand && !handEntering ? pred : null;
        const gStroke = stroke && (now - lastCommitAt > 700 || gate.held === STROKE_START[stroke]) ? stroke : null;
        const s = gate.feed({
          now, letter: live?.label ?? null, conf: live?.confidence ?? 0, stroke: gStroke,
          pos: hasHand && hand ? { x: hand[0].x, y: hand[0].y, span: spanOf(hand) } : null,
        });
        const out = [];
        if (s.confirm) {
          lastCommitAt = now;
          if (s.replace) { speller.replaceLast(s.confirm, 0.85, now); out.push({ type: "replace", L: s.confirm }); }
          else if (speller.addLetter(s.confirm, 0.85, now) === "letter") out.push({ type: "add", L: s.confirm });
        }
        if (s.space) speller.space();
        return out;
      },
    };
  },
};

// ---- per-letter test ---------------------------------------------------------
const STATIC = cfg.LETTERS;
const ALL = [...STATIC, "J", "Z"].sort();
function letterTrial(X, pipe, prof, trial) {
  const R = rng(1000 + ALL.indexOf(X) * 97 + trial * 7919 + prof.length * 13);
  const pick = () => { let L; do L = STATIC[Math.floor(R() * STATIC.length)]; while (L === X || (X === "J" && L === "I") || (X === "Z" && L === "D")); return L; };
  const W = pick(), Y = pick();
  const segs = makeScript([{ L: W }, { L: X }, { L: Y }], R, PROFILE[prof], { dropoutAt: trial % 3 === 1 ? 1 : -1 });
  const run = runScript(segs, pipe, R, PROFILE[prof]);
  const x = segs[1], y = segs[2];
  const from = x.midIn, to = y.midIn;
  const inX = run.commits.filter((c) => c.t >= from && c.t < to).map((c) => c.L);
  const nX = inX.filter((L) => L === X).length;
  const other = inX.length - nX;
  const outcome = !inX.length ? "missed" : nX >= 2 ? "doubled" : other ? "wrong" : "correct";
  // recogniser ceiling: does this held-out hand read as X at all (clean, still)?
  const pc = x.stroke ? null : classify(handAt(x.v, 0.5, 0.55));
  const readable = x.stroke ? true : !!pc && pc.label === X && pc.confidence >= 0.8;
  return { outcome, got: inX.join(""), W, Y, text: run.text, readable };
}

function perLetter(pipe, prof) {
  const rows = {};
  for (const X of ONLY_LETTERS || ALL) {
    const r = { correct: 0, wrong: 0, doubled: 0, missed: 0, readable: 0, correctReadable: 0, examples: [] };
    for (let i = 0; i < TRIALS; i++) {
      const o = letterTrial(X, pipe, prof, i);
      r[o.outcome]++;
      if (o.readable) { r.readable++; if (o.outcome === "correct") r.correctReadable++; }
      if (o.outcome !== "correct" && r.examples.length < 3) r.examples.push(`${o.W}${X}${o.Y}->"${o.text}"`);
    }
    rows[X] = r;
  }
  return rows;
}

// ---- word tests --------------------------------------------------------------
const WORDS = [
  // one letter held a long time (with sway + a tracking blip) must enter once
  { name: "L held 4 s + blip", steps: [{ L: "L", hold: 4000, dropout: true }], want: "L" },
  { name: "HI", steps: [{ L: "H" }, { L: "I" }], want: "HI" },
  { name: "CAT", steps: [{ L: "C" }, { L: "A" }, { L: "T" }], want: "CAT" },
  { name: "HELLO", steps: [{ L: "H" }, { L: "E" }, { L: "L" }, { L: "O" }], want: "HELLO" },
  { name: "HI CAT (pause on I)", steps: [{ L: "H" }, { L: "I", pause: 2800 }, { L: "C" }, { L: "A" }, { L: "T" }], want: "HI CAT" },
  { name: "HI CAT (hand down)", steps: [{ L: "H" }, { L: "I" }, { gone: 2600 }, { L: "C" }, { L: "A" }, { L: "T" }], want: "HI CAT" },
];
function wordTests(pipe, prof) {
  return WORDS.map((w) => {
    let ok = 0;
    const outs = {};
    for (let i = 0; i < TRIALS; i++) {
      const R = rng(55 + i * 131 + w.name.length * 17 + prof.length);
      // HELLO's second L is the same hand as the first (bounce, re-hold)
      const segs = makeScript(w.steps, R, PROFILE[prof], { readable: true });
      if (w.name === "HELLO") {
        const Lseg = segs.find((s) => s.L === "L");
        const at = segs.indexOf(Lseg);
        // after the bounce, re-hold the same L a little to the side
        segs.splice(at + 1, 0, { kind: "bounce", ms: 220, dx: 0.7 * SPAN },
          { ...Lseg, wx: Lseg.wx + 0.35 * SPAN, trans: 60, dropout: false });
      }
      const run = runScript(segs, pipe, R, PROFILE[prof]);
      const got = run.text.trim().replace(/\s+/g, " ");
      if (got === w.want) ok++;
      outs[got] = (outs[got] || 0) + 1;
    }
    return { name: w.name, ok, n: TRIALS, outs };
  });
}

// ---- report --------------------------------------------------------------------
const report = {};
const pct = (a, n) => `${Math.round((100 * a) / n)}%`.padStart(4);
for (const prof of PROFILES) {
  for (const pipe of PIPES) {
    const t0 = Date.now();
    const rows = perLetter(pipe, prof);
    const words = NO_WORDS ? [] : wordTests(pipe, prof);
    report[`${pipe}/${prof}`] = { rows, words };
    const tot = { correct: 0, wrong: 0, doubled: 0, missed: 0, readable: 0, correctReadable: 0 };
    for (const r of Object.values(rows)) for (const k in tot) tot[k] += r[k];
    const n = Object.keys(rows).length * TRIALS;
    console.log(`\n=== ${pipe} · ${prof} signer · ${TRIALS} trials/letter (${((Date.now() - t0) / 1000).toFixed(0)} s) ===`);
    console.log(`letters: correct ${pct(tot.correct, n)} · wrong ${pct(tot.wrong, n)} · doubled ${pct(tot.doubled, n)} · missed ${pct(tot.missed, n)}` +
      `   | on hands the recogniser can read (${pct(tot.readable, n)} of trials): correct ${pct(tot.correctReadable, tot.readable)}`);
    if (!QUIET) {
      console.log("  " + Object.keys(rows).map((L) => `${L}:${String(rows[L].correct).padStart(2)}`).join(" "));
      const bad = Object.keys(rows).filter((L) => rows[L].correct < TRIALS);
      for (const L of bad) {
        const r = rows[L];
        console.log(`  ${L} ok ${r.correct}/${TRIALS} wrong ${r.wrong} dbl ${r.doubled} miss ${r.missed}  e.g. ${r.examples.join(" ")}`);
      }
    }
    for (const w of words) {
      const top = Object.entries(w.outs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `"${k}"x${v}`).join(" ");
      console.log(`  word ${w.name.padEnd(20)} ${w.ok}/${w.n}   ${top}`);
    }
  }
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 1));
