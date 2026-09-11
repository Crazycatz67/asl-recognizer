// Free, dependency-free parameter sweep for js/transition.js's settle-timing
// thresholds — reruns the exact tuning pass done by hand on 2026-09-11
// (see the plan doc's revision history for that date), now as a committed,
// reusable script instead of a throwaway.
//
//   node tools/sweep-transition.mjs [sequenceLimit]
//
// IMPORTANT — read before trusting the numbers this prints:
// data/fs_sequences.json uses MediaPipe HOLISTIC landmarks (from the Google
// Kaggle ASL Fingerspelling competition). The classifier is trained on
// MediaPipe HANDS/HandLandmarker landmarks. These are NOT interchangeable —
// see the "asl-kaggle-domain-gap" note in the plan doc. That means:
//   - absolute accuracy numbers here are meaningless (expect single digits)
//   - only the RELATIVE ordering across configs is valid signal
// Do not "fix" a bad number by retraining the kNN on this data — tried, and
// documented as not working.
//
// This sweeps the *segmentation* timing (transition.js), not the classifier,
// so the domain gap affects it less than it would a full pipeline benchmark —
// but the caveat still applies to the absolute recall/precision figures below.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// dataset.js / heads.js call fetch() with relative URLs — shim it to read
// from disk so this runs in plain Node with no dev server.
const origFetch = global.fetch;
global.fetch = async (url) => {
  if (typeof url === "string" && !url.startsWith("http")) {
    const p = path.resolve(ROOT, "tools", url); // resolve as if running from tools/, matching replay-lab.html's relative paths
    const buf = fs.readFileSync(p);
    return { ok: true, json: async () => JSON.parse(buf), text: async () => buf.toString("utf8") };
  }
  return origFetch(url);
};

const { normalizeLandmarks } = await import(pathToFileURL(path.join(ROOT, "js/normalize.js")));
const { loadDataset } = await import(pathToFileURL(path.join(ROOT, "js/dataset.js")));
const { createClassifier } = await import(pathToFileURL(path.join(ROOT, "js/knn.js")));
const { loadRefiner } = await import(pathToFileURL(path.join(ROOT, "js/heads.js")));
const { LETTERS, USE_EXTENDED_FEATURES, KNN_K } = await import(pathToFileURL(path.join(ROOT, "js/config.js")));

// Inlined copy of js/transition.js's matcher, with SETTLE_MS/WIN_MS exposed as
// sweepable opts (they're fixed module-level consts in the real file). Keep
// this in sync with js/transition.js if its core logic changes — it's a
// deliberate, flagged duplication for sweep purposes only; the live app never
// runs this copy.
const TIPS = [0, 8, 12, 16];
function spanOf(lm) {
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of [5, 9, 13, 17]) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}
function createTransitionMatcher(opts = {}) {
  const moveThr = opts.moveThr ?? 0.55;
  const stillThr = opts.stillThr ?? 0.27;
  const minConf = opts.minConf ?? 0.6;
  const settleMs = opts.settleMs ?? 115;
  const winMs = opts.winMs ?? 110;

  let buf = [], state = "moving", settledAt = 0, movedSince = true;
  let heldLetter = null, votes = [], pending = null;

  function travel() {
    if (buf.length < 2) return 0;
    const a = buf[0], b = buf.at(-1);
    let d = 0;
    for (let i = 0; i < TIPS.length; i++)
      d += Math.hypot(b.pts[i][0] - a.pts[i][0], b.pts[i][1] - a.pts[i][1]);
    return d / (TIPS.length * ((a.span + b.span) / 2));
  }

  return {
    push(landmarks, prediction, now) {
      if (!landmarks || landmarks.length < 21) {
        if (now - (buf.at(-1)?.t ?? 0) > 200) { buf = []; movedSince = true; state = "moving"; }
        return;
      }
      const span = spanOf(landmarks);
      buf.push({ t: now, span, pts: TIPS.map((j) => [landmarks[j].x, landmarks[j].y]) });
      while (buf.length && now - buf[0].t > winMs) buf.shift();
      const v = travel();
      if (v >= moveThr) { state = "moving"; movedSince = true; votes = []; return; }
      if (v <= stillThr) {
        if (state === "moving") { state = "settling"; settledAt = now; votes = []; }
        if (prediction?.label && (prediction.confidence ?? 0) >= minConf) votes.push(prediction);
        if (state === "settling" && now - settledAt >= settleMs && votes.length) {
          const tally = {};
          for (const x of votes) tally[x.label] = (tally[x.label] || 0) + 1;
          const letter = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
          const conf = votes.filter((x) => x.label === letter).reduce((s, x) => s + x.confidence, 0) / tally[letter];
          if (letter !== heldLetter || movedSince) {
            pending = { letter, conf: +conf.toFixed(3) };
            heldLetter = letter;
            movedSince = false;
          }
          state = "settled";
        }
      } else if (state === "settling" && prediction?.label && (prediction.confidence ?? 0) >= minConf) {
        votes.push(prediction);
      }
    },
    read() { const p = pending; pending = null; return p; },
  };
}

async function main() {
  const ds = await loadDataset("../data/dataset.json");
  const refiner = await loadRefiner("../js/heads.json").catch(() => null);
  const seqs = (await (await fetch("../data/fs_sequences.json")).json()).sequences;

  const keep = new Set(LETTERS);
  const clf = createClassifier(
    ds.samples.filter((s) => keep.has(s.label)).map((s) => ({ label: s.label, v: s.v })),
    { k: KNN_K }
  );

  console.log(`sequences: ${seqs.length}, classifier vectors: ${clf.size}, refiner: ${!!refiner}\n`);

  function runOnce(lim, opts) {
    let totalTrue = 0, totalEmitted = 0, correct = 0, extra = 0;
    for (let i = 0; i < Math.min(lim, seqs.length); i++) {
      const s = seqs[i];
      const truthLetters = s.phrase.toUpperCase().replace(/[^A-Z]/g, "").split("");
      const tr = createTransitionMatcher(opts);
      const emitted = [];
      let t = 0;
      for (const fr of s.frames) {
        const pts = fr.map(([x, y, z]) => ({ x, y, z }));
        const vec = normalizeLandmarks(pts, { aspect: 1, mirrorX: false, extended: USE_EXTENDED_FEATURES });
        let pred = clf.classify(vec);
        if (pred && refiner) {
          const rl = refiner.refine(vec, pred.label);
          if (rl !== pred.label) pred = { ...pred, label: rl };
        }
        t += 33;
        tr.push(pts, pred ? { label: pred.label, confidence: pred.confidence } : null, t);
        const e = tr.read();
        if (e) emitted.push(e.letter);
      }
      // greedy alignment: an emitted letter "counts" if it matches the next
      // unconsumed truth letter in order; anything else is spurious ("extra")
      let ti = 0;
      for (const l of emitted) {
        const k = truthLetters.indexOf(l, ti);
        if (k >= 0) { correct++; ti = k + 1; } else { extra++; }
      }
      totalTrue += truthLetters.length;
      totalEmitted += emitted.length;
    }
    return { totalTrue, totalEmitted, correct, extra };
  }

  const lim = Number(process.argv[2] || 250);

  // Coarse grid around the shipped defaults (settleMs:115, minConf:0.6,
  // stillThr:0.27) plus the pre-2026-09-11 old defaults, for comparison.
  const grid = [
    { label: "old defaults (pre 2026-09-11)", settleMs: 90, minConf: 0.5, stillThr: 0.3 },
    { label: "current shipped defaults", settleMs: 115, minConf: 0.6, stillThr: 0.27 },
    { label: "stricter settle", settleMs: 140, minConf: 0.62, stillThr: 0.26 },
    { label: "stricter confidence only", settleMs: 115, minConf: 0.68, stillThr: 0.27 },
    { label: "looser (faster lock, more spurious)", settleMs: 100, minConf: 0.55, stillThr: 0.28 },
  ];

  console.log(`${lim} sequences per config\n`);
  for (const g of grid) {
    const r = runOnce(lim, g);
    const recall = (100 * r.correct / r.totalTrue).toFixed(1);
    const precision = (100 * r.correct / Math.max(1, r.totalEmitted)).toFixed(1);
    console.log(
      `${g.label.padEnd(38)} settleMs=${g.settleMs} minConf=${g.minConf} stillThr=${g.stillThr}\n` +
      `${"".padEnd(38)} truth=${r.totalTrue} emitted=${r.totalEmitted} correct=${r.correct} spurious=${r.extra} ` +
      `recall=${recall}% precision=${precision}%\n`
    );
  }

  console.log(
    "Reminder: precision (fewer spurious/wrong-letter locks) is the number that\n" +
    "matters for the 'sloppy fast transition gets locked in as correct' complaint\n" +
    "this was tuned against. Recall trades off against it — don't chase precision\n" +
    "to zero or real signing will feel sticky. Absolute numbers are not real-world\n" +
    "accuracy (see the domain-gap note at the top of this file)."
  );
}

main();
