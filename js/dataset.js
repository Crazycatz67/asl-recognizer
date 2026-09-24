// =============================================================================
// js/dataset.js — loads the labelled training set (Engine, DOM-free)
// =============================================================================
// WHAT: Fetches data/dataset.json (the hand vectors produced offline by
//   tools/extract.html), validates its shape, and expands the stored
//   originals with rotated copies so the kNN has neighbours at every hand
//   tilt. Everything that trains or evaluates — the live app, the test/lab
//   pages, tools/sweep-transition.mjs — goes through this one loader.
//
// PIPELINE: runs once at startup, before the per-frame loop:
//   dataset.json → [dataset.js] → knn.js createClassifier() and
//   reference.js buildReference().
//
// PUBLIC API:
//   loadDataset(url) → Promise<{ samples, labels, vectorLength,
//                                originalCount, meta }>
//
// FILE SHAPE:
//   {
//     vectorLength: 74,               // 63 raw coords + 11 engineered features
//     extendedFeatures: bool,
//     augmentRotations: [-30,-15,15,30] | [],   // expanded here, at load time
//     labelCounts: { A: 167, ... },
//     samples: [ { label: "A", v: [74 numbers], g: 12 }, ... ]   // ORIGINALS only
//   }
//
// WHY AUGMENT AT LOAD: only the ~6k original hands are stored. Rotation-
//   augmented copies are generated in memory here, which keeps the file ~3 MB
//   instead of ~18 MB. Each augmented row keeps its parent's `g` (group id)
//   and gets `rot: <angle in degrees>` so evaluation can split by group
//   without leaking a hand's rotated twin into the test set.
//
// GOTCHAS: uses fetch() with a relative URL, so a plain-Node script must shim
//   global.fetch to read from disk first (see tools/sweep-transition.mjs).
//   Throws (with err.status on an HTTP failure) rather than returning null —
//   main.js catches that and runs "skeleton only" without recognition.

import { rotateVector } from "./normalize.js";

const MIN_LEN = 63; // 21 landmarks × (x, y, z) — anything shorter is malformed

/**
 * Fetch, validate and rotation-augment the training dataset.
 * @param {string} url  path to dataset.json (relative to the page)
 * @returns {Promise<{samples: {label: string, v: number[], g?: number, rot?: number}[],
 *   labels: string[], vectorLength: number, originalCount: number, meta: object}>}
 *   samples includes the augmented copies; originalCount is before expansion.
 * @throws {Error} on HTTP failure (err.status set), no samples, or bad rows
 */
export async function loadDataset(url) {
  // ---- fetch ----
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = new Error(`dataset ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();

  // ---- validate: every row must be { label, v } with one shared length ----
  if (!Array.isArray(data.samples) || data.samples.length === 0) {
    throw new Error("dataset has no samples");
  }

  const len = data.samples[0]?.v?.length;
  if (!Number.isInteger(len) || len < MIN_LEN) {
    throw new Error(`dataset vectors look wrong (length ${len})`);
  }
  const bad = data.samples.find(
    (s) => !s.label || !Array.isArray(s.v) || s.v.length !== len
  );
  if (bad) throw new Error(`dataset rows must all be { label, v:[${len}] }`);

  // ---- augment: add an in-plane rotated copy per angle, per original ----
  let samples = data.samples;
  const angles = Array.isArray(data.augmentRotations) ? data.augmentRotations : [];
  if (angles.length) {
    const expanded = [];
    for (const s of data.samples) {
      expanded.push(s);
      for (const deg of angles) {
        expanded.push({ label: s.label, v: rotateVector(s.v, deg), g: s.g, rot: deg });
      }
    }
    samples = expanded;
  }

  const labels = [...new Set(samples.map((s) => s.label))].sort();
  return {
    samples,
    labels,
    vectorLength: len,
    originalCount: data.samples.length,
    meta: data,
  };
}
