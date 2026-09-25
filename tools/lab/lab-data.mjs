// tools/lab/lab-data.mjs — shared setup for the offline lab (Node, no deps).
// Builds the SAME recognition stack main.js uses, from data/dataset.json:
//   handshape judge (js/handshape.js), either-hand kNN (js/knn.js) + learned
//   heads (js/heads.js) with REJECT_DIST, and the verdict (js/verdict.js).
// Split: per letter, the first 80% calibrates/trains, the LAST 20% is held
// out for judging (samples are in recording order, so this is a blocked
// split — held-out hands come from later sessions, like a new user's).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

export async function loadLab({ trainFrac = 0.8 } = {}) {
  const cfg = await imp("js/config.js");
  const { createHandshapeJudge } = await imp("js/handshape.js");
  const { createClassifier, recognise } = await imp("js/knn.js");
  const { rotateVector, mirrorVector } = await imp("js/normalize.js");
  const { augmentSamples } = await imp("js/dataset.js");
  const { createRefiner } = await imp("js/heads.js");
  const { judgeLetter } = await imp("js/verdict.js");
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "dataset.json"), "utf8"));
  const byL = {};
  for (const s of data.samples) (byL[s.label] ||= []).push(s);
  const train = [], test = {};
  for (const [L, arr] of Object.entries(byL)) {
    const cut = Math.floor(arr.length * trainFrac);
    arr.forEach((s, i) => (i < cut ? train.push(s) : (test[L] ||= []).push(s)));
  }
  const letters = cfg.LETTERS.filter((L) => L !== "J" && L !== "Z" && test[L]);
  const judge = createHandshapeJudge(train);
  // the same widening the live app's loadDataset does (js/dataset.js)
  const trainAug = augmentSamples(train.filter((s) => cfg.LETTERS.includes(s.label)), data.augmentRotations || [], cfg.AUGMENT_TILTS || []);
  const clf = createClassifier(trainAug, { k: cfg.KNN_K });
  let refiner = null;
  try { refiner = createRefiner(JSON.parse(fs.readFileSync(path.join(ROOT, "js", "heads.json"), "utf8"))); } catch {}
  // the recogniser exactly as main.js runs it per frame (knn.js recognise).
  // The full reading is cached per vector object, so the verdict (which also
  // needs the rejected hand's neighbourhood) never re-runs the kNN.
  // (readNow skips the cache — for timing the real per-frame cost)
  const readNow = (v) => recognise(clf, v, { mirror: mirrorVector, refiner, rejectDist: cfg.REJECT_DIST });
  const readings = new WeakMap();
  const read = (v) => {
    let r = readings.get(v);
    if (!r) { r = readNow(v); if (v && typeof v === "object") readings.set(v, r); }
    return r;
  };
  const predict = (v) => read(v).pred?.label ?? null;
  // does this hand COUNT as letter L (the shipped verdict)?
  const counts = (v, L) => judgeLetter(judge, v, L, predict(v), 0.3, read(v)).strict;
  // same, with a precomputed recogniser label (the probe reuses one predict
  // per hand across all 24 target letters); the reading comes from the cache
  const countsWith = (v, L, pred) => judgeLetter(judge, v, L, pred, 0.3, pred == null ? read(v) : null).strict;
  const centroid = (L) => {
    const rows = byL[L] || [];
    return Array.from({ length: 63 }, (_, i) => rows.reduce((a, s) => a + s.v[i], 0) / (rows.length || 1));
  };
  return { cfg, data, byL, train, test, trainAug, clf, refiner, letters, judge, predict, read, readNow, counts, countsWith, judgeLetter, centroid, rotateVector, mirrorVector };
}

// deterministic RNG so every run of the lab is reproducible
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
export function gauss(r) {
  const u = Math.max(1e-9, r()), v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
