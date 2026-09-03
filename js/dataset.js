// Loads the labelled landmark dataset produced by the extraction pass.
//
// File shape:
//   {
//     vectorLength: 74,               // 63 raw coords + 11 engineered features
//     extendedFeatures: bool,
//     augmentRotations: [-30,-15,15,30] | [],   // expanded here, at load time
//     labelCounts: { A: 167, ... },
//     samples: [ { label: "A", v: [74 numbers], g: 12 }, ... ]   // ORIGINALS only
//   }
//
// Only the ~6k original hands are stored. Rotation-augmented copies (so kNN has
// neighbours at every hand tilt) are generated in-memory here — keeps the file
// ~3 MB instead of ~18 MB. Each augmented row keeps its parent's `g` (group id)
// and gets `rot: <angle>` so evaluation can split without leakage.

import { rotateVector } from "./normalize.js";

const MIN_LEN = 63;

export async function loadDataset(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const err = new Error(`dataset ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();

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
