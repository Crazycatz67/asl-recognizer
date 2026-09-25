// tools/lab/probe-axes.mjs — the perturbation axes shared by the lab probes
// (tools/lab/probe-thresholds.mjs, tools/lab/letter-report.mjs). Factored out
// of probe-thresholds.mjs on 2026-09-25 so the per-letter report measures the
// SAME room-for-error / wrong-shape axes instead of a copy that drifts.
//
//   const P = await createProbeAxes(lab)     // lab = loadLab() result
//   P.refresh(v)                             re-normalize like a live frame
//   P.sweep(vs, L, levels, apply, seed?)     pass rate per level (shipped verdict)
//   P.passRate(vs, L)                        fraction of vs that count as L
//   P.AX                                     room-for-error axes (tilt, jitter, fan, curl)
//   thresholdOf(levels, rates, base)         level where the rate halves
//   FINGER_LEVELS, CLEAR, TOGETHER, APART, THUMB_OUT_LETTERS  (wrong-shape knowledge)
import path from "node:path";
import { pathToFileURL } from "node:url";
import { rng, gauss, ROOT } from "./lab-data.mjs";

// WRONG SHAPE axes
export const FINGER_LEVELS = [0, 15, 30, 45, 60, 90];
export const CLEAR = { finger: 60, thumbOut: 45, thumbIn: 30, spread: 20 };
// ASL: which letters hold index + middle together vs apart (the probe's own
// knowledge of the WRONG direction, not a threshold)
export const TOGETHER = new Set(["B", "U", "H", "R"]);
export const APART = new Set(["V", "K"]);
export const THUMB_OUT_LETTERS = new Set(["L", "Y", "C", "Q"]);

// the level at which the pass rate falls below half of the unperturbed rate
export function thresholdOf(levels, rates, base) {
  for (let i = 0; i < levels.length; i++) if (rates[i] < base * 0.5) return levels[i];
  return null; // never dropped: tolerated across the whole range
}

export async function createProbeAxes(lab) {
  const { predict, countsWith, rotateVector } = lab;
  const synth = await import(pathToFileURL(path.join(ROOT, "tools", "synth-hand.js")).href);
  const { fanFingers, curlAtMiddle } = synth;

  // re-normalize a perturbed vector the way a live frame is: hand radius 1,
  // derived features recomputed (rotateVector by 0 rebuilds them)
  const refresh = (v) => {
    let r = 1e-6;
    for (let j = 0; j < 21; j++) r = Math.max(r, Math.hypot(v[j * 3], v[j * 3 + 1], v[j * 3 + 2]));
    return rotateVector(v.slice(0, 63).map((x) => x / r).concat(v.length > 63 ? [0] : []), 0).slice(0, v.length);
  };
  const passRate = (vs, L) => (vs.length ? vs.filter((v) => countsWith(v, L, predict(v))).length / vs.length : 0);
  const sweep = (vs, L, levels, apply, seed = 7) => {
    const r = rng(seed);
    return levels.map((x) => passRate(vs.map((v) => refresh(apply(v, x, r))), L));
  };

  // ROOM FOR ERROR axes
  const AX = {
    tilt: { levels: [0, 10, 20, 30, 45, 60], apply: (v, x) => rotateVector(v, x) },
    jitter: { levels: [0, 0.01, 0.02, 0.04, 0.06], apply: (v, x, r) => v.map((val, i) => (i < 63 ? val + gauss(r) * x : val)) },
    fan: { levels: [0, 10, 20, 30], apply: (v, x) => fanFingers(v, x) },
    curl: { levels: [0, 20, 40, 60, 90], apply: (v, x) => curlAtMiddle(v, x) },
  };
  return { refresh, passRate, sweep, AX, synth };
}
