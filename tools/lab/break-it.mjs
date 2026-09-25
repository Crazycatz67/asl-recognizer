// tools/lab/break-it.mjs — adversarial / fuzz tests of the DOM-free engine.
//
//   node tools/lab/break-it.mjs [--only <name>] [--no-issues] [--file-static]
//
// Throws hostile input at the engine modules the live app runs every frame
// (normalize, knn, stabilizer, transition, speller, decode, swipe, twohand,
// motion, handshape, verdict, challenge, jointstate): NaN / undefined / short
// arrays / huge values, timestamps that repeat or run backwards, very long
// streams, rapid alternation, memory growth, and decode()'s incremental
// prefix cache against a fresh decoder. Every failed check becomes an issue
// in docs/lab/issues.json (tools/lab/issues.mjs, foundBy "break-it") with a
// repro command that runs just that check.
//
// --file-static also files the static-read suspects from main.js / tour.js /
// index.html / sw.js listed in STATIC below (foundBy "break-it/static") —
// they're code-reading findings, not measurements, so they're only filed when
// asked (re-running the fuzz pass must not resurrect a fixed static suspect).
//
// Honest boundary: no camera. Inputs are synthetic (tools/synth-hand.js),
// hand-built landmark arrays, and REAL dataset vectors (data/dataset.json)
// where a real hand shape matters. Deterministic: seeded RNG, fixed clocks.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, rng, gauss } from "./lab-data.mjs";
import { upsertIssue } from "./issues.mjs";

const args = process.argv.slice(2);
const ONLY = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const FILE_ISSUES = !args.includes("--no-issues");
const FILE_STATIC = args.includes("--file-static");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

const { normalizeLandmarks, mirrorVector, rotateVector } = await imp("js/normalize.js");
const { createClassifier, classifyEitherHand } = await imp("js/knn.js");
const { createStabilizer } = await imp("js/stabilizer.js");
const { createTransitionMatcher } = await imp("js/transition.js");
const { createSpeller } = await imp("js/speller.js");
const { buildLexicon, createDecoder } = await imp("js/decode.js");
const { createSwipeMatcher } = await imp("js/swipe.js");
const { createTwoHandMatcher } = await imp("js/twohand.js");
const { createMotionMatcher } = await imp("js/motion.js");
const { createHandshapeJudge } = await imp("js/handshape.js");
const { judgeLetter } = await imp("js/verdict.js");
const { jointState, isReadable, countStates } = await imp("js/jointstate.js");
const { createChallenge } = await imp("js/challenge.js");
const cfg = await imp("js/config.js");
const { synthHand, SHAPE, motionScenarios } = await imp("tools/synth-hand.js");

// ---- harness ------------------------------------------------------------
const results = [];
const REPRO = (name) => `node tools/lab/break-it.mjs --only ${name}`;
/**
 * A check: fn returns null (pass) or { title, severity, metric, area } (fail).
 * Thrown errors are failures too (a crash is P0 by the lab's triage rule).
 */
async function check(name, area, fn) {
  if (ONLY && ONLY !== name) return;
  let f = null;
  try {
    f = await fn();
  } catch (e) {
    f = { title: `${area}: crashes — ${String(e.message).slice(0, 90)}`, severity: "P0", metric: "throws" };
  }
  results.push({ name, area, fail: f });
  console.log(`${f ? "FAIL" : "ok  "} ${name}${f ? ` [${f.severity}] ${f.title} (${f.metric})` : ""}`);
}
const finite = (x) => typeof x === "number" && Number.isFinite(x);

// ---- shared fixtures ----------------------------------------------------
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "dataset.json"), "utf8"));
const byL = {};
for (const s of data.samples) if (s.rot == null) (byL[s.label] ||= []).push(s);
// small real classifier (every 4th real sample) — enough for hostile-input behaviour
const smallTrain = data.samples.filter((s, i) => cfg.LETTERS.includes(s.label) && s.rot == null && i % 4 === 0);
const clf = createClassifier(smallTrain, { k: cfg.KNN_K });
const judge = createHandshapeJudge(data.samples.filter((s) => s.rot == null && cfg.LETTERS.includes(s.label)));
const DIMS = clf.dims;
const realVec = (L, i = 0) => byL[L][i % byL[L].length].v.slice();
const OPEN = SHAPE.OPEN;
const hand = (o) => synthHand(o);
const nanHand = (j = 0, key = "x") => hand({ ext: OPEN }).map((p, i) => (i === j ? { ...p, [key]: NaN } : p));

// =========================================================================
// normalize.js
// =========================================================================
await check("normalize-short", "normalize", () => {
  // 20 landmarks (a truncated result) must not yield a vector the classifier
  // accepts. Unreachable from MediaPipe today (always 21), so a throw here is
  // hardening (P3), not the crash-P0 the harness would otherwise assign.
  let v;
  try { v = normalizeLandmarks(hand({ ext: OPEN }).slice(0, 20), { extended: DIMS > 63 }); }
  catch (e) { return { title: "normalizeLandmarks throws on a 20-landmark hand (no length guard; MediaPipe always sends 21, main.js doesn't check)", severity: "P3", metric: `throws: ${e.message.slice(0, 60)}` }; }
  const holes = v.filter((x) => !finite(x)).length;
  const p = clf.classify(v);
  if (holes && p && !(p.distance > cfg.REJECT_DIST))
    return { title: "a 20-landmark hand normalizes to a vector with holes that kNN still labels", severity: "P3", metric: `${holes} non-finite dims, label ${p.label} dist ${p.distance}` };
  return null;
});
await check("normalize-degenerate", "normalize", () => {
  // all 21 points on one pixel (collapsed tracking) — must stay finite
  const v = normalizeLandmarks(Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })), { extended: true });
  const bad = v.filter((x) => !finite(x)).length;
  return bad ? { title: "collapsed hand normalizes to NaN", severity: "P2", metric: `${bad} NaN dims` } : null;
});
await check("normalize-huge", "normalize", () => {
  const v = normalizeLandmarks(hand({ ext: OPEN }).map((p) => ({ x: p.x * 1e150, y: p.y * 1e150, z: p.z })), { extended: true });
  const bad = v.filter((x) => !finite(x)).length;
  return bad ? { title: "huge coordinates overflow normalization", severity: "P3", metric: `${bad} non-finite dims` } : null;
});
await check("normalize-rotate-mirror-roundtrip", "normalize", () => {
  // baseline = the same vector with its features recomputed (dataset rows
  // store rounded features, which is not drift)
  const v = rotateVector(realVec("B"), 0);
  const back = mirrorVector(mirrorVector(rotateVector(rotateVector(v, 37), -37)));
  const err = Math.max(...v.map((x, i) => Math.abs(x - back[i])));
  return err > 1e-9 ? { title: "rotate/mirror round-trip drifts", severity: "P3", metric: `max err ${err.toExponential(2)}` } : null;
});

await check("onefilter-timestamps", "onefilter", async () => {
  const { createLandmarkFilter } = await imp("js/onefilter.js");
  const f = createLandmarkFilter();
  const h = hand({ ext: OPEN });
  const ts = [1, 1, 1, 0.5, 0.5, 2, 1e9, 1e9, 3];
  let bad = 0;
  for (const t of ts) for (const p of f.filter(h, t)) if (![p.x, p.y, p.z].every(finite)) bad++;
  return bad ? { title: "one-euro filter emits non-finite landmarks for duplicate/backwards timestamps", severity: "P1", metric: `${bad} non-finite points` } : null;
});

// =========================================================================
// knn.js
// =========================================================================
await check("knn-nan-vector", "knn", () => {
  // main.js guards hand 0's raw landmarks against non-finite values
  // (js/main.js hasHandRaw), so this is defence in depth: the engine itself
  // labels a NaN vector confidently, and a NaN distance slips past
  // `distance > REJECT_DIST` (and classifyEitherHand keeps it too)
  const all = clf.classify(new Array(DIMS).fill(NaN));
  const one = realVec("L"); one[20] = NaN;
  const p1 = clf.classify(one);
  const e = classifyEitherHand(clf, one, mirrorVector).pred;
  const hits = [all, p1, e].filter((p) => p && !(p.distance > cfg.REJECT_DIST));
  return hits.length ? { title: "kNN returns a confident label for a NaN vector — NaN distance passes the REJECT_DIST gate (guarded upstream for hand 0 only)", severity: "P3", metric: `all-NaN -> ${all?.label} @${all?.confidence}; one NaN coord -> ${p1?.label} @${p1?.confidence}; dist NaN` } : null;
});
await check("knn-wrong-length", "knn", () => {
  const p = [clf.classify(realVec("A").slice(0, 63 === DIMS ? 62 : 63)), clf.classify(undefined), clf.classify([])];
  return p.some(Boolean) ? { title: "kNN classifies a wrong-length vector", severity: "P2", metric: JSON.stringify(p.map((x) => x?.label ?? null)) } : null;
});
await check("knn-k-bigger-than-n", "knn", () => {
  const c = createClassifier([{ label: "A", v: realVec("A") }, { label: "B", v: realVec("B") }], { k: 5 });
  const p = c.classify(realVec("A"));
  return !p || p.label !== "A" || !(p.confidence > 0 && p.confidence <= 1)
    ? { title: "kNN with k > samples misbehaves", severity: "P2", metric: JSON.stringify(p) } : null;
});

// =========================================================================
// stabilizer.js
// =========================================================================
await check("stabilizer-hostile-preds", "stabilizer", () => {
  const s = createStabilizer({ stableFrames: 3, minConfidence: 0.6 });
  const junk = [undefined, null, {}, { label: "" }, { label: "A", confidence: NaN }, { label: "A" }, { label: "A", confidence: "0.9" }, { label: null, confidence: 1 }];
  for (let i = 0; i < 30; i++) s.push(junk[i % junk.length]);
  // "0.9" (string) >= 0.6 is true in JS — a string confidence counts; the rest must not
  return s.current && s.current !== "A" ? { title: "stabilizer confirms junk", severity: "P2", metric: String(s.current) } : null;
});
await check("stabilizer-alternation", "stabilizer", () => {
  const s = createStabilizer({ stableFrames: 8, minConfidence: 0.6 });
  for (let i = 0; i < 10000; i++) s.push({ label: i % 2 ? "M" : "N", confidence: 1 });
  return s.current ? { title: "stabilizer confirms under 1-frame M/N alternation", severity: "P1", metric: s.current } : null;
});
await check("stabilizer-progress-range", "stabilizer", () => {
  const s = createStabilizer({ stableFrames: 8 });
  const seen = [];
  for (let i = 0; i < 50; i++) { s.push({ label: "A", confidence: 1 }); seen.push(s.progress); }
  return seen.some((p) => !(p >= 0 && p <= 1)) ? { title: "stabilizer progress leaves 0..1", severity: "P3", metric: String(seen.find((p) => !(p >= 0 && p <= 1))) } : null;
});

// =========================================================================
// transition.js
// =========================================================================
// a hand that moves between letters then holds each one still
function spellStream(tr, letters, { holdMs = 400, moveMs = 250, dt = 33, t0 = 1000, jitter = 0, seed = 3, dropAt = null, dropMs = 0 } = {}) {
  const r = rng(seed);
  const out = [];
  let t = t0, x = 0.4;
  for (const L of letters) {
    for (let k = 0; k < moveMs; k += dt) { x += 0.02; t += dt; tr.push(hand({ ext: OPEN, wx: x, wy: 0.6 }), null, t); const e = tr.read(); if (e) out.push(e.letter); }
    for (let k = 0; k < holdMs; k += dt) {
      t += dt;
      if (dropAt != null && k >= dropAt && k < dropAt + dropMs) { tr.push(null, null, t); continue; }
      const h = hand({ ext: OPEN, wx: x + jitter * gauss(r), wy: 0.6 + jitter * gauss(r) });
      tr.push(h, { label: L, confidence: 0.9 }, t);
      const e = tr.read(); if (e) out.push(e.letter);
    }
  }
  return { out: out.join(""), t };
}
await check("transition-basic", "transition", () => {
  const { out } = spellStream(createTransitionMatcher(), [..."HELLO"]);
  return out !== "HELLO" ? { title: "transition matcher mis-segments a clean synthetic HELLO", severity: "P1", metric: `got "${out}"` } : null;
});
await check("transition-long-hold", "transition", () => {
  const { out } = spellStream(createTransitionMatcher(), ["A"], { holdMs: 20000 });
  return out !== "A" ? { title: "a 20 s still hold commits more than once", severity: "P1", metric: `got "${out}"` } : null;
});
await check("transition-dropout-double", "transition", () => {
  // a 250 ms tracking dropout in the middle of ONE held letter
  const { out } = spellStream(createTransitionMatcher(), ["L"], { holdMs: 1200, dropAt: 400, dropMs: 264 });
  return out.length > 1 ? { title: "a ~250 ms tracking dropout mid-hold re-commits the same letter (LL)", severity: "P2", metric: `got "${out}" from one held L`, status: "needs-live" } : null;
});
await check("transition-jitter", "transition", () => {
  const r = [0.002, 0.004, 0.006].map((j) => spellStream(createTransitionMatcher(), [..."CAB"], { jitter: j }).out);
  const bad = r.findIndex((o) => o !== "CAB");
  return bad >= 0 ? { title: "transition matcher breaks under landmark jitter", severity: "P2", metric: `jitter σ ${[0.002, 0.004, 0.006][bad]} frame units -> "${r[bad]}"` } : null;
});
await check("transition-time-backwards", "transition", () => {
  const tr = createTransitionMatcher();
  let { t } = spellStream(tr, ["A"]);
  // clock steps back 5 s (should not happen with performance.now, but a
  // restarted clock source would) — the buffer must not grow without bound
  t -= 5000;
  let out = "";
  for (let i = 0; i < 300; i++) { t += 33; tr.push(hand({ ext: OPEN }), { label: "B", confidence: 0.9 }, t); const e = tr.read(); if (e) out += e.letter; }
  const m = tr.metrics();
  return !finite(m.travel) && out === "" ? { title: "transition matcher stays stuck after the clock steps backwards", severity: "P3", metric: `state ${m.state}, travel ${m.travel} for 10 s` } : null;
});
await check("transition-duplicate-ts", "transition", () => {
  const tr = createTransitionMatcher();
  for (let i = 0; i < 5000; i++) tr.push(hand({ ext: OPEN }), { label: "A", confidence: 0.9 }, 1000);
  // no crash + a later normal stream still segments
  const { out } = spellStream(tr, ["B"], { t0: 2000 });
  return out !== "B" ? { title: "5000 frames with one duplicated timestamp wedge the transition matcher", severity: "P3", metric: `then got "${out}"` } : null;
});
await check("transition-nan-landmark", "transition", () => {
  const tr = createTransitionMatcher();
  let t = 1000;
  for (let i = 0; i < 30; i++) tr.push(hand({ ext: OPEN, wx: 0.4 + i * 0.02 }), null, (t += 33));
  for (let i = 0; i < 30; i++) tr.push(nanHand(8), { label: "A", confidence: 0.9 }, (t += 33));
  const { out } = spellStream(tr, ["B"], { t0: t });
  return out !== "B" ? { title: "one NaN fingertip poisons the transition matcher", severity: "P2", metric: `then got "${out}"` } : null;
});

// =========================================================================
// speller.js
// =========================================================================
await check("speller-fluid-j-after-i", "speller", () => {
  // fluid mode commits via addLetter() (no timestamp), then the J stroke
  // arrives through feed() at a real performance.now()
  const sp = createSpeller();
  sp.addLetter("I", 0.9);
  sp.feed({ holding: false, stroke: "J", moved: false, now: 60000 });
  return sp.pending !== "J" ? { title: "fluid mode: a J stroke after its I start shape spells \"IJ\" (addLetter records no time, so the stroke can't replace the I)", severity: "P1", metric: `pending "${sp.pending}" (hold-to-type path gives "J")` } : null;
});
await check("speller-backspace-raw", "speller", () => {
  const sp = createSpeller();
  for (const L of "CAT") sp.addLetter(L, 0.9);
  sp.space();
  sp.backspace(); // the space
  sp.backspace(); // the T of the committed word
  const raw = sp.raw.map((r) => r.letter).join("");
  return raw !== sp.text.replace(/\s/g, "") ? { title: "backspace into committed text leaves the letter in speller.raw, so fluid mode's decoded/spoken sentence keeps it", severity: "P2", metric: `text "${sp.text}" vs raw "${raw}"` } : null;
});
await check("speller-raw-growth", "speller", () => {
  // same root cause as speller-backspace-raw; filed separately for the memory angle
  const sp = createSpeller();
  for (let i = 0; i < 5000; i++) { sp.addLetter("A", 0.9); sp.space(); sp.backspace(); sp.backspace(); }
  return sp.raw.length > 300 ? { title: "speller.raw grows without bound while the visible text stays empty (type, commit, delete) — fluid mode re-decodes all of it every 350 ms", severity: "P3", metric: `raw ${sp.raw.length} entries, text ${sp.text.length} chars` } : null;
});
await check("speller-maxlen", "speller", () => {
  const sp = createSpeller({ maxLen: 240 });
  let n = 0;
  for (let i = 0; i < 1000; i++) {
    sp.addLetter("ABCDEFGH"[i % 8], 0.9);
    if (i % 7 === 6) sp.space();
    if (i % 97 === 0) sp.insert("HELLO WORLD ");
    n = Math.max(n, sp.display.length, sp.text.length);
  }
  sp.space();
  n = Math.max(n, sp.text.length);
  return n > 240 ? { title: "speller transcript exceeds its 240-char cap", severity: "P3", metric: `max ${n} chars` } : null;
});
await check("speller-flush-over-cap", "speller", () => {
  const sp = createSpeller({ maxLen: 10 });
  sp.insert("ABCDE");
  for (const L of "FGHIJ") sp.addLetter(L, 0.9);
  sp.space();
  return sp.text.length > 10 ? { title: "flushing a word at the cap adds a separator past maxLen", severity: "P3", metric: `"${sp.text}" = ${sp.text.length} > 10` } : null;
});
await check("speller-hostile-feed", "speller", () => {
  const sp = createSpeller();
  const bad = [{}, { holding: true, letter: 7 }, { holding: true, letter: "ab" }, { holding: true, letter: "é" }, { stroke: "Q", now: 5 }, { holding: true, letter: "A", now: NaN }, { now: -1e12 }];
  for (let i = 0; i < 200; i++) sp.feed(bad[i % bad.length]);
  return /[^A-Z ]/.test(sp.display) ? { title: "speller accepts non-letter input", severity: "P2", metric: JSON.stringify(sp.display) } : null;
});
await check("speller-held-no-repeat", "speller", () => {
  // a letter held steadily for 30 s at 30 fps must commit once
  const sp = createSpeller();
  let t = 0;
  for (let i = 0; i < 900; i++) sp.feed({ holding: true, letter: "L", moved: false, now: (t += 33) });
  return sp.display !== "L" ? { title: "a 30 s held letter repeats", severity: "P1", metric: `"${sp.display}"` } : null;
});

// =========================================================================
// decode.js
// =========================================================================
const lex = buildLexicon(fs.readFileSync(path.join(ROOT, "data", "words25k.txt"), "utf8"));
const WORDS = ["hello", "world", "coffee", "the", "cat", "name", "my", "is", "good", "morning", "thank", "you", "please", "water"];
function noisyStream(r, nWords) {
  const out = [];
  for (let w = 0; w < nWords; w++) {
    const word = WORDS[(r() * WORDS.length) | 0];
    for (const ch of word) {
      let L = ch.toUpperCase();
      if (r() < 0.15) L = "ABCDEFGHIKLMNOPQRSTUVWXY"[(r() * 24) | 0]; // recogniser error
      out.push({ letter: L, conf: +(0.55 + 0.4 * r()).toFixed(3) });
    }
  }
  return out;
}
const BLANK = { letter: "", conf: 0 };
await check("decode-incremental-vs-fresh", "decode", () => {
  // the live pattern: one decoder re-run on a stream that mostly grows by a
  // letter, sometimes shrinks (backspace / swipe) or has a letter replaced
  const r = rng(11);
  const inc = createDecoder(lex);
  let stream = [];
  let mism = 0, first = null, runs = 0;
  for (let step = 0; step < 260; step++) {
    const op = r();
    if (op < 0.7 || stream.length < 3) stream.push(...noisyStream(r, 1).slice(0, 1 + ((r() * 3) | 0)));
    else if (op < 0.85) stream.pop();
    else if (op < 0.95) stream[stream.length - 1] = { letter: "MNSTAE"[(r() * 6) | 0], conf: 0.7 };
    else stream = stream.slice(0, (stream.length / 2) | 0);
    if (stream.length > 60) stream = stream.slice(-40);
    const input = stream.flatMap((x) => [x, BLANK]);
    const a = inc.decode(input).text;
    const b = createDecoder(lex).decode(input).text;
    runs++;
    if (a !== b) { mism++; first ||= { len: stream.length, a, b }; }
  }
  return mism ? { title: "decode()'s incremental prefix cache returns a different sentence than a fresh decoder", severity: "P1", metric: `${mism}/${runs} runs differ, e.g. "${first.a}" vs "${first.b}"` } : null;
});
await check("decode-incremental-digit-runs", "decode", () => {
  // digit runs split one decode into several beam runs that share ONE cache
  const r = rng(5);
  const inc = createDecoder(lex);
  let mism = 0, ex = null;
  for (let i = 0; i < 40; i++) {
    const s = [...noisyStream(r, 1), { letter: String(i % 10), conf: 0.9 }, ...noisyStream(r, 1)];
    for (let k = 1; k <= s.length; k++) {
      const input = s.slice(0, k);
      const a = inc.decode(input).text, b = createDecoder(lex).decode(input).text;
      if (a !== b) { mism++; ex ||= `"${a}" vs "${b}"`; }
    }
  }
  return mism ? { title: "decode cache diverges from a fresh decoder on letter+digit streams", severity: "P1", metric: `${mism} prefixes differ, e.g. ${ex}` } : null;
});
await check("decode-hostile", "decode", () => {
  const dec = createDecoder(lex);
  const outs = {
    undef: dec.decode(undefined).text,
    null: dec.decode(null).text,
    empty: dec.decode([]).text,
    nanConf: dec.decode([..."hello"].map((letter) => ({ letter, conf: NaN }))).text,
    badLetters: dec.decode([{ letter: null }, { letter: 5, conf: 0.9 }, { letter: "?", conf: 0.9 }, { letter: "É", conf: 0.9 }]).text,
  };
  const bad = [];
  if (outs.undef) bad.push(`decode(undefined) -> "${outs.undef}"`);
  if (outs.null) bad.push(`decode(null) -> "${outs.null}"`);
  if (outs.nanConf && outs.nanConf !== "hello") bad.push(`NaN conf "hello" -> "${outs.nanConf}"`);
  return bad.length ? { title: "decode() turns non-input into words", severity: "P3", metric: bad.join("; ") } : null;
});
await check("decode-long-stream-time", "decode", () => {
  const r = rng(9);
  const s = noisyStream(r, 60).flatMap((x) => [x, BLANK]); // ~300 letters, past speller's 240 cap
  const t0 = performance.now();
  createDecoder(lex).decode(s);
  const ms = performance.now() - t0;
  // fluid mode re-decodes every 350 ms; a cold decode of a full line must fit well inside a frame budget x10
  return ms > 1500 ? { title: "a cold decode of a full 240-letter line is too slow for the 350 ms re-decode loop", severity: "P2", metric: `${ms.toFixed(0)} ms (Node, this machine)` } : null;
});

// =========================================================================
// swipe.js
// =========================================================================
function sweep(sw, { t0 = 1000, frames = 12, dt = 33, from = 0.2, to = 0.8, ext = OPEN, y = 0.6 } = {}) {
  let t = t0, hits = 0;
  for (let i = 0; i < frames; i++) {
    t += dt;
    sw.push(hand({ ext, wx: from + ((to - from) * i) / (frames - 1), wy: y }), t);
    if (sw.match(t) === "delete") hits++;
  }
  return { hits, t };
}
await check("swipe-one-sweep-one-delete", "swipe", () => {
  const sw = createSwipeMatcher();
  const a = sweep(sw);
  const b = sweep(sw, { t0: a.t, from: 0.8, to: 0.2 }); // the return stroke, immediately
  return a.hits !== 1 || b.hits !== 0 ? { title: "a back-and-forth wipe deletes the wrong number of times", severity: "P1", metric: `out ${a.hits}, back ${b.hits} (want 1, 0)` } : null;
});
await check("swipe-fist-no-delete", "swipe", () => {
  const { hits } = sweep(createSwipeMatcher(), { ext: {} });
  return hits ? { title: "a closed hand moving sideways fires delete", severity: "P1", metric: `${hits} deletes` } : null;
});
await check("swipe-continuous-wiping", "swipe", () => {
  // 10 s of non-stop back-and-forth wiping: deletes are rate-limited by the cooldown
  const sw = createSwipeMatcher();
  let t = 1000, hits = 0;
  for (let k = 0; k < 25; k++) { const r = sweep(sw, { t0: t, from: k % 2 ? 0.8 : 0.2, to: k % 2 ? 0.2 : 0.8 }); hits += r.hits; t = r.t; }
  const secs = (t - 1000) / 1000;
  return hits / secs > 1000 / 800 + 0.01 ? { title: "continuous wiping beats the swipe cooldown", severity: "P2", metric: `${hits} deletes in ${secs.toFixed(1)} s` } : null;
});
await check("swipe-nan", "swipe", () => {
  const sw = createSwipeMatcher();
  let t = 1000, hits = 0;
  for (let i = 0; i < 30; i++) { sw.push(nanHand(0, i % 2 ? "x" : "y"), (t += 33)); if (sw.match(t)) hits++; }
  return hits ? { title: "NaN wrist frames fire the swipe-delete gesture", severity: "P2", metric: `${hits} deletes` } : null;
});

// =========================================================================
// twohand.js
// =========================================================================
// the synthetic hand's span (wrist -> mean knuckle) in frame units, as twohand.js measures it
const SYN_SPAN = (() => { const h = hand({ ext: OPEN }); let mx = 0, my = 0; for (const j of [5, 9, 13, 17]) { mx += h[j].x; my += h[j].y; } return Math.hypot(mx / 4 - h[0].x, my / 4 - h[0].y); })();
function twoHands(th, dists, { t0 = 1000, dt = 33, bad = null } = {}) {
  let t = t0;
  const hits = [];
  for (const d of dists) {
    t += dt;
    let b = hand({ ext: OPEN, wx: 0.5 + d * SYN_SPAN, wy: 0.6 }); // d = wrist gap in hand-spans
    if (bad) b = bad(b);
    th.push([hand({ ext: OPEN, wx: 0.5, wy: 0.6 }), b], t);
    const m = th.match(t);
    if (m) hits.push(m);
  }
  return { hits, t };
}
await check("twohand-copy-paste", "twohand", () => {
  const apart = Array.from({ length: 12 }, (_, i) => 1 + (3 * i) / 11);
  const together = [...apart].reverse();
  const c = twoHands(createTwoHandMatcher(), together).hits.join(",");
  const p = twoHands(createTwoHandMatcher(), apart).hits.join(",");
  return c !== "copy" || p !== "paste" ? { title: "two-hand gesture misfires on clean synthetic copy/paste", severity: "P1", metric: `together -> [${c}], apart -> [${p}]` } : null;
});
await check("twohand-nan-second-hand", "twohand", () => {
  // main.js only checks hand 0 for non-finite landmarks; hand 1 goes in raw
  const th = createTwoHandMatcher();
  const { hits } = twoHands(th, Array(20).fill(1.5), { bad: (b) => b.map((p, i) => (i === 0 ? { ...p, x: NaN } : p)) });
  return hits.length ? { title: "a NaN wrist on the SECOND hand fires a phantom copy/paste (hand 1 isn't finite-checked in main.js; span falls back to 1e-6 so it reads as open)", severity: "P2", metric: `fired [${hits.join(",")}] with both hands still` } : null;
});
await check("twohand-memory", "twohand", () => {
  const th = createTwoHandMatcher();
  let t = 0;
  for (let i = 0; i < 20000; i++) th.push(i % 3 ? [hand({ ext: OPEN })] : [], (t += 33));
  const m = th.metrics();
  // buffer is internal — probe via a two-hand frame count after the stream
  const { hits } = twoHands(th, Array(5).fill(1.5), { t0: t });
  return hits.length ? { title: "one-hand stream leaves stale two-hand frames that fire later", severity: "P2", metric: JSON.stringify(m) } : null;
});

// =========================================================================
// motion.js (J / Z)
// =========================================================================
function runFrames(frames, { drop = 0, jitter = 0, seed = 1, aspect = 1, dt = 33, dupEvery = 0 } = {}) {
  const mm = createMotionMatcher();
  const r = rng(seed);
  const hits = [];
  let t = 0;
  frames.forEach((f, i) => {
    t += dt;
    if (drop && i % drop === drop - 1) return; // frame never delivered
    const h = synthHand({ ...f, aspect }).map((p) => ({ x: p.x + jitter * gauss(r), y: p.y + jitter * gauss(r), z: 0 }));
    mm.push(h, t, aspect);
    if (dupEvery && i % dupEvery === 0) mm.push(h, t, aspect); // same frame delivered twice
    const m = mm.match(t);
    if (m) hits.push(m);
  });
  return hits;
}
await check("motion-frame-drops", "motion", () => {
  const bad = [];
  for (const sc of motionScenarios()) {
    for (const drop of [3, 4]) {
      const h = runFrames(sc.frames, { drop });
      const got = h[0] ?? null;
      if (got !== sc.expect || h.length > 1) bad.push(`${sc.name} @drop1/${drop}: ${h.join(",") || "none"}`);
    }
  }
  return bad.length ? { title: "J/Z matcher changes its verdict when every 3rd/4th frame is dropped", severity: "P2", metric: bad.slice(0, 3).join(" | ") + (bad.length > 3 ? ` (+${bad.length - 3})` : ""), status: "needs-live" } : null;
});
await check("motion-jitter", "motion", () => {
  // 20 seeds per scenario at landmark noise σ 0.001 / 0.002 frame units
  // (0.01 / 0.02 hand-spans at the synthetic hand's size) — report RATES
  const bad = [];
  for (const sigma of [0.001, 0.002]) {
    for (const sc of motionScenarios()) {
      let wrong = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const h = runFrames(sc.frames, { jitter: sigma, seed });
        if ((h[0] ?? null) !== sc.expect || h.length > 1) wrong++;
      }
      if (wrong >= 2) bad.push(`σ${sigma} "${sc.name}" (want ${sc.expect ?? "none"}): ${wrong}/20 wrong`);
    }
  }
  return bad.length ? { title: "J/Z verdict flips under light landmark jitter", severity: "P2", metric: bad.slice(0, 3).join(" | ") + (bad.length > 3 ? ` (+${bad.length - 3} more)` : ""), status: "needs-live" } : null;
});
await check("motion-duplicate-frames", "motion", () => {
  const bad = [];
  for (const sc of motionScenarios()) {
    const h = runFrames(sc.frames, { dupEvery: 2 });
    if ((h[0] ?? null) !== sc.expect || h.length > 1) bad.push(`${sc.name}: ${h.join(",") || "none"}`);
  }
  return bad.length ? { title: "duplicated frames (same timestamp twice) change the J/Z verdict", severity: "P3", metric: bad.slice(0, 3).join(" | ") } : null;
});
await check("motion-aspect-16x9", "motion", () => {
  const bad = [];
  for (const sc of motionScenarios()) {
    const h = runFrames(sc.frames, { aspect: 16 / 9 });
    if ((h[0] ?? null) !== sc.expect) bad.push(`${sc.name}: ${h.join(",") || "none"}`);
  }
  return bad.length ? { title: "J/Z verdict differs on a 16:9 camera", severity: "P2", metric: bad.slice(0, 3).join(" | ") } : null;
});
await check("motion-hostile", "motion", () => {
  const mm = createMotionMatcher();
  let t = 0;
  const frames = [null, [], nanHand(0), nanHand(20), nanHand(8, "y"), hand({ ext: SHAPE.I }).slice(0, 20), hand({ S: 0 }), hand({ S: 1e6 })];
  let hits = 0;
  for (let i = 0; i < 400; i++) { mm.push(frames[i % frames.length], (t += 33)); if (mm.match(t)) hits++; mm.metrics(); }
  return hits ? { title: "hostile frames fire a J/Z stroke", severity: "P1", metric: `${hits} strokes` } : null;
});
await check("motion-i-held-60s", "motion", () => {
  const f = Array.from({ length: 1800 }, (_, i) => ({ ext: SHAPE.I, wx: 0.5 + 0.003 * Math.sin(i / 7), wy: 0.6 + 0.003 * Math.cos(i / 11) }));
  const h = runFrames(f, { jitter: 0.001, seed: 8 });
  return h.length ? { title: "an I held (with tremor) for 60 s fires J", severity: "P1", metric: `${h.length} strokes: ${h.join("")}` } : null;
});

// =========================================================================
// handshape.js + verdict.js + jointstate.js
// =========================================================================
await check("handshape-nan-vector", "handshape", () => {
  // stateOf(NaN) measures 0 distance out of range -> "good" for every trait
  const v = new Array(DIMS).fill(NaN);
  const passes = judge.letters.filter((L) => judge.check(v, L)?.ok);
  return passes.length ? { title: "an all-NaN hand passes every letter's defining traits (stateOf(NaN) measures 0 out-of-range) — guarded upstream for hand 0 only", severity: "P3", metric: `${passes.length}/${judge.letters.length} letters ok: ${passes.slice(0, 8).join("")}` } : null;
});
await check("verdict-nan-vector", "verdict", () => {
  const v = new Array(DIMS).fill(NaN);
  const pred = clf.classify(v);
  const label = pred && !(pred.distance > cfg.REJECT_DIST) ? pred.label : null;
  const counts = judge.letters.filter((L) => judgeLetter(judge, v, L, label, 0.3).strict);
  return counts.length ? { title: "the shipped verdict COUNTS an all-NaN hand as a letter (engine has no finite guard; main.js guards hand 0 upstream)", severity: "P3", metric: `${counts.length} letters count: ${counts.slice(0, 10).join("")}` } : null;
});
await check("verdict-collapsed-hand", "verdict", () => {
  // every landmark on one point (collapsed tracking) -> an all-zero vector
  const v = normalizeLandmarks(Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 })), { extended: DIMS > 63 });
  const pred = clf.classify(v);
  const label = pred && !(pred.distance > cfg.REJECT_DIST) ? pred.label : null;
  const counts = judge.letters.filter((L) => judgeLetter(judge, v, L, label, 0.3).strict);
  return counts.length ? { title: "a collapsed hand (all 21 landmarks on one point) counts as a letter", severity: "P3", metric: `counts as ${counts.join("")} (recogniser: ${label ?? "rejected"})` } : null;
});
await check("verdict-short-vector", "verdict", () => {
  const v = realVec("B").slice(0, 30);
  const counts = judge.letters.filter((L) => judgeLetter(judge, v, L, null, 0.3).strict);
  return counts.length ? { title: "a truncated (30-value) vector counts as a letter (handTraits reads undefined joints as NaN -> 'in range')", severity: "P3", metric: counts.join("") } : null;
});
await check("verdict-unknown-target", "verdict", () => {
  const v = realVec("A");
  const r = ["J", "Z", "", null, "??"].map((L) => judgeLetter(judge, v, L, "A", 0.3).strict);
  return r.some(Boolean) ? { title: "verdict counts a hand for a target with no traits", severity: "P1", metric: JSON.stringify(r) } : null;
});
await check("verdict-hostile-pred", "verdict", () => {
  const v = realVec("B", 3);
  const base = judgeLetter(judge, v, "B", "B", 0.3).strict;
  const r = [undefined, "", "zz", 42, {}].map((p) => judgeLetter(judge, v, "B", p, 0.3).strict);
  return base && r.some((x) => x !== base) ? { title: "garbage recogniser labels change the verdict", severity: "P3", metric: JSON.stringify(r) } : null;
});
await check("jointstate-nan", "jointstate", () => {
  const s = jointState(NaN, 0.2);
  const c = countStates(["good", "bogus"]);
  const bad = [];
  if (s === "good") bad.push(`jointState(NaN) = "good"`);
  if (Object.keys(c).length > 3) bad.push(`countStates tallies unknown state keys: ${JSON.stringify(c)}`);
  if (isReadable({ good: 21, close: 0, fix: 0 }, NaN)) bad.push("isReadable(score NaN) = true");
  return bad.length ? { title: "jointstate treats NaN error as a good joint", severity: "P3", metric: bad.join("; ") } : null;
});

// =========================================================================
// challenge.js
// =========================================================================
const fakeLS = () => { const m = new Map(); globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
fakeLS();
function toPlay(g, t) {
  let s;
  for (let i = 0; i < 400 && g.phase !== "play"; i++) s = g.update((t += 33), null);
  return { t, s };
}
await check("challenge-skip-and-land-same-frame", "challenge", () => {
  fakeLS();
  const g = createChallenge({ letters: cfg.ALL_LETTERS, rng: rng(2) });
  let t = 1000;
  g.start(t);
  ({ t } = toPlay(g, t));
  const needed = g.needed;
  g.skip(); // Skip tapped...
  let s = g.update((t += 33), needed); // ...on the same frame the letter lands
  const livesAfterWin = s.lives;
  ({ t } = toPlay(g, t));
  s = g.update((t += 33), null); // first frame of the NEXT round, no hand
  return s.lives < livesAfterWin ? { title: "Skip tapped as the letter lands: the round is won AND the stale skip costs a life on the next round's first frame", severity: "P2", metric: `lives ${livesAfterWin} -> ${s.lives} at 33 ms into round ${s.round}, event ${s.event}` } : null;
});
await check("challenge-background-tab", "challenge", () => {
  // rAF pauses in a hidden tab; main.js has no visibility pause for the game,
  // so the first update() after returning sees the whole absence at once
  fakeLS();
  const g = createChallenge({ letters: cfg.ALL_LETTERS, rng: rng(3) });
  let t = 1000;
  g.start(t);
  ({ t } = toPlay(g, t));
  const lives = g.update((t += 33), null).lives;
  const s = g.update((t += 15000), null); // tab hidden for 15 s
  return s.lives < lives ? { title: "switching tabs mid-round costs a life (the round clock keeps running while the page is hidden; no visibilitychange pause)", severity: "P2", metric: `lives ${lives} -> ${s.lives} after a 15 s hidden tab, event ${s.event}` } : null;
});
await check("challenge-time-backwards", "challenge", () => {
  fakeLS();
  const g = createChallenge({ letters: cfg.ALL_LETTERS, rng: rng(4) });
  let t = 100000;
  g.start(t);
  ({ t } = toPlay(g, t));
  const s0 = g.update(t, null);
  const s1 = g.update(t - 50000, null);
  const bad = !(s1.remainingFrac >= 0 && s1.remainingFrac <= 1) || s1.lives !== s0.lives;
  return bad ? { title: "challenge clock misbehaves when time steps backwards", severity: "P3", metric: JSON.stringify({ frac: s1.remainingFrac, lives: s1.lives }) } : null;
});
await check("challenge-long-run", "challenge", () => {
  // 2000 rounds, all landed instantly — score/round must stay finite, no crash,
  // and a word round must never be won by an unrelated letter
  fakeLS();
  const g = createChallenge({ letters: cfg.ALL_LETTERS, words: ["CAT", "DOG", "SUN", "HAT", "MAP", "BOX", "FIVE", "WORD", "PLAN", "CLOUD"], rng: rng(6) });
  let t = 0, s;
  g.start(t);
  for (let i = 0; i < 1000000 && s?.round !== 2000; i++) s = g.update((t += 33), g.needed);
  return !s || !finite(s.score) || s.round < 2000 || s.lives !== 3 ? { title: "a long all-correct challenge run breaks", severity: "P1", metric: JSON.stringify({ round: s?.round, score: s?.score, lives: s?.lives }) } : null;
});
await check("challenge-hostile-seen", "challenge", () => {
  fakeLS();
  const g = createChallenge({ letters: cfg.ALL_LETTERS, rng: rng(7) });
  let t = 1000;
  g.start(t);
  ({ t } = toPlay(g, t));
  const junk = [undefined, "", 0, {}, "AB", NaN];
  let s;
  for (let i = 0; i < 30; i++) s = g.update((t += 33), junk[i % junk.length]);
  return s.event === "win" || s.streak ? { title: "junk seenLetter values land a challenge letter", severity: "P1", metric: JSON.stringify({ streak: s.streak }) } : null;
});

// =========================================================================
// static-read suspects (main.js flows) — filed only with --file-static
// =========================================================================
const STATIC = [
  {
    key: "static-az-bridge-timer-leak", severity: "P1", area: "practice A->Z / mode switch",
    title: "A->Z 'Next' bridge timer isn't cancelled: leaving the run (Free, Review, another mode) within 1.3 s still calls setTarget(next)",
    metric: "js/main.js:935 (advanceAz) and :968 (skipLetter) setTimeout -> setTarget(next) unconditionally",
    repro: "static: js/main.js:935-939 — land a letter in A->Z, then tap Spell (or Free / Review) within 1.3 s: the old run's next letter becomes the target in the new mode (ref panel opens over Spell; a new Review run jumps to the A->Z letter)",
  },
  {
    key: "static-tour-kills-challenge", severity: "P2", area: "tour / challenge",
    title: "Opening the tour ('?') mid-Challenge or mid-Spell silently switches to Practice and ends the run; ghost/blind toggles are forced and not restored",
    metric: "js/main.js:3043-3050 practice() hook -> setMode('practice') -> challenge.stop(); ghostToggle.checked=true, blindToggle.checked=false",
    repro: "static: js/main.js:3043 — start a Challenge run, tap the ? tour button: the run is gone (no summary, bests not saved) and you're in Practice on A",
  },
  {
    key: "static-sw-reload-midsession", severity: "P2", area: "service worker update",
    title: "A service-worker update reloads the page mid-session with no guard: an in-progress Spell transcript or Challenge run is lost",
    metric: "index.html:68-72 controllerchange -> location.reload(); sw.js install waits on EXTRA (dataset, words25k, 26 photos) so the swap can land well after the user has started",
    repro: "static: index.html:68 — on the deployed site after a VERSION bump, open the app, start spelling within the first seconds: when the new SW activates the page reloads and the transcript is gone",
  },
  {
    key: "static-drill-advance-timer", severity: "P3", area: "spell word drill",
    title: "Word-drill success timer (700 ms) clears the pending word and advances even if the user already started the next word, turned Drill off, or left Spell",
    metric: "js/main.js:2333-2337 setTimeout(() => { speller.clearPending(); nextDrillWord(); }, 700) — no mode/drill/target check",
    repro: "static: js/main.js:2333 — solve a drill word, keep fingerspelling: letters committed in the next 0.7 s are wiped",
  },
  {
    key: "static-fluid-stroke-gate", severity: "P3", area: "spell fluid mode",
    title: "Fluid mode never updates spellLastCommitAt, so the 'no J/Z right after another commit' 700 ms gate is dead in fluid mode",
    metric: "js/main.js:2280-2283 gate reads spellLastCommitAt, which only speller.feed()'s 'letter' event sets (:2294); fluid commits go through addLetter() at :2222",
    repro: "static: js/main.js:2280 — fluid mode, commit a letter then move quickly: a stray J/Z stroke isn't blocked by the 700 ms gate",
  },
  {
    key: "static-read-advance-timer", severity: "P3", area: "read mode",
    title: "Read mode's auto-advance timer (850/1400 ms) isn't tracked in readTimers: leaving Read right after answering still plays a word into the hidden panel",
    metric: "js/main.js:1408 setTimeout(nextReadWord, ...) — leaveRead() clears readTimers only",
    repro: "static: js/main.js:1408 — answer a Read word, switch to Practice within 0.85 s: nextReadWord() runs (playback timers + input focus) while Read is hidden",
  },
  {
    key: "static-fresh-module-race", severity: "P3", area: "?fresh bootstrap",
    title: "?fresh wipes storage asynchronously while js/main.js still boots: the app can open the tour / request the camera before the replace() reload",
    metric: "index.html:22-51 cleanup is async (SW unregister + caches) and only then location.replace(); the module script at index.html:416 is not held back",
    repro: "static: index.html:22 — load ?fresh on a slow device: the tour or camera prompt flashes before the page reloads",
  },
];

// =========================================================================
const fails = results.filter((r) => r.fail);
console.log(`\nbreak-it: ${results.length} checks, ${fails.length} failed (${fails.filter((r) => r.fail.severity === "P0").length} P0, ${fails.filter((r) => r.fail.severity === "P1").length} P1)`);
if (FILE_ISSUES) {
  for (const r of fails) {
    const { title, severity, metric, status } = r.fail;
    upsertIssue({ key: `breakit-${r.name}`, title, severity, foundBy: "break-it", metric, area: r.area, repro: REPRO(r.name), ...(status ? { status } : {}) });
  }
  if (FILE_STATIC && !ONLY) for (const s of STATIC) upsertIssue({ ...s, foundBy: "break-it/static" });
}
