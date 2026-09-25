// tools/lab/probe-thresholds.mjs — per-letter "room for error" + looseness probe.
//
//   node tools/lab/probe-thresholds.mjs [--per 30] [--no-issues]
//
// For every static letter, takes held-out REAL hands of that letter (never
// used for calibration) and perturbs them along one axis at a time, measuring
// what fraction still COUNT under the shipped verdict (js/verdict.js):
//   tilt (in-plane °) · jitter (landmark noise σ) · fan (fingers apart °/gap)
//   · thumbOut (thumb moved toward an L's thumb, 0..1)
//   · each finger moved toward the OPPOSITE of what the letter needs
//     (a folded finger raised toward a B's, a raised one folded toward an A's)
// plus a confusion pass: which OTHER letters' real hands count as this one.
// Writes docs/lab/thresholds.json + docs/lab/THRESHOLDS.md and files issues
// (tools/lab/issues.mjs) for letters that are too loose or too strict.
// Deterministic (seeded) — same inputs, same report.
import fs from "node:fs";
import path from "node:path";
import { loadLab, rng, gauss, ROOT } from "./lab-data.mjs";
import { upsertIssue } from "./issues.mjs";

const args = process.argv.slice(2);
const PER = Number(args[args.indexOf("--per") + 1]) || 30;
const FILE_ISSUES = !args.includes("--no-issues");

const lab = await loadLab();
const { letters, test, judge, predict, countsWith, centroid, rotateVector } = lab;
const FINGERS = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20] };
const THUMB = [1, 2, 3, 4];
const cB = centroid("B"), cA = centroid("A"), cL = centroid("L");
const lerpJoints = (v, joints, target, t) => {
  const o = v.slice();
  for (const j of joints) for (let c = 0; c < 3; c++) o[j * 3 + c] = v[j * 3 + c] + (target[j * 3 + c] - v[j * 3 + c]) * t;
  return o;
};
const { fanFingers } = await import(path.join(ROOT, "tools", "synth-hand.js"));

const sample = (L) => {
  const arr = test[L] || [];
  const step = Math.max(1, Math.floor(arr.length / PER));
  return arr.filter((_, i) => i % step === 0).slice(0, PER).map((s) => s.v);
};
const passRate = (vs, L) => vs.length ? vs.filter((v) => countsWith(v, L, predict(v))).length / vs.length : 0;

// the level at which the pass rate falls below half of the unperturbed rate
function thresholdOf(levels, rates, base) {
  for (let i = 0; i < levels.length; i++) if (rates[i] < base * 0.5) return levels[i];
  return null; // never dropped: tolerated across the whole range
}

const AX = {
  tilt: { levels: [0, 10, 20, 30, 45, 60], apply: (v, x) => rotateVector(v, x) },
  jitter: { levels: [0, 0.01, 0.02, 0.04, 0.06], apply: (v, x, r) => v.map((val, i) => (i < 63 ? val + gauss(r) * x : val)) },
  fan: { levels: [0, 10, 20, 30], apply: (v, x) => fanFingers(v, x) },
  thumbOut: { levels: [0, 0.25, 0.5, 0.75, 1], apply: (v, x) => lerpJoints(v, THUMB, cL, x) },
};

const report = { generated: new Date().toISOString().slice(0, 16), per: PER, letters: {} };
const findings = [];

for (const L of letters) {
  const vs = sample(L);
  const base = passRate(vs, L);
  const row = { base: +base.toFixed(2), n: vs.length, axes: {}, fingers: {}, acceptedAs: {} };
  for (const [name, ax] of Object.entries(AX)) {
    const r = rng(7);
    const rates = ax.levels.map((x) => passRate(vs.map((v) => ax.apply(v, x, r)), L));
    row.axes[name] = { levels: ax.levels, rates: rates.map((x) => +x.toFixed(2)), threshold: thresholdOf(ax.levels, rates, base || 1) };
  }
  // each finger pushed toward the WRONG state for this letter
  const spec = judge.ranges.get(L) || {};
  for (const [f, joints] of Object.entries(FINGERS)) {
    const t = spec[f + "Flex"];
    if (!t || (t.kind !== "up" && t.kind !== "down")) continue;
    const toward = t.kind === "down" ? cB : cA; // folded finger -> raised, raised -> folded
    const levels = [0, 0.25, 0.5, 0.75, 1];
    const rates = levels.map((x) => passRate(vs.map((v) => lerpJoints(v, joints, toward, x)), L));
    row.fingers[f] = { wrong: t.kind === "down" ? "raised" : "folded", levels, rates: rates.map((x) => +x.toFixed(2)), stillCountsAt75: +(rates[3] / (base || 1)).toFixed(2) };
    if (base > 0.3 && rates[3] >= base * 0.5) findings.push({ sev: "P0", L, key: `loose-finger-${L}-${f}`, title: `${L} still counts with the ${f} finger ${row.fingers[f].wrong} 75% of the way`, metric: `${Math.round(100 * rates[3])}% pass at 0.75 (base ${Math.round(100 * base)}%)` });
  }
  report.letters[L] = row;
  if (base < 0.75) findings.push({ sev: "P1", L, key: `strict-own-${L}`, title: `${L}: only ${Math.round(100 * base)}% of real held-out ${L} hands count`, metric: `own pass ${Math.round(100 * base)}%` });
  if (row.axes.tilt.threshold !== null && row.axes.tilt.threshold <= 10) findings.push({ sev: "P1", L, key: `strict-tilt-${L}`, title: `${L} stops counting at a ${row.axes.tilt.threshold}° tilt`, metric: `tilt threshold ${row.axes.tilt.threshold}°` });
  if (row.axes.jitter.threshold !== null && row.axes.jitter.threshold <= 0.01) findings.push({ sev: "P1", L, key: `strict-jitter-${L}`, title: `${L} breaks under light landmark jitter (σ ${row.axes.jitter.threshold})`, metric: `jitter threshold ${row.axes.jitter.threshold}` });
  process.stderr.write(`${L} `);
}
process.stderr.write("\n");

// confusion: which OTHER letters' real hands count as L
for (const X of letters) {
  const vs = sample(X);
  const preds = vs.map((v) => predict(v));
  for (const L of letters) {
    if (L === X) continue;
    const rate = vs.filter((v, i) => countsWith(v, L, preds[i])).length / (vs.length || 1);
    if (rate > 0) report.letters[L].acceptedAs[X] = +rate.toFixed(2);
    if (rate > 0.15) findings.push({ sev: "P0", L, key: `confuse-${X}-as-${L}`, title: `${Math.round(100 * rate)}% of real ${X} hands count as ${L}`, metric: `${X}->${L} ${Math.round(100 * rate)}%` });
  }
}

fs.mkdirSync(path.join(ROOT, "docs", "lab"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "docs", "lab", "thresholds.json"), JSON.stringify(report, null, 1) + "\n");

const pct = (x) => `${Math.round(100 * x)}%`;
const md = [
  "# Per-letter room for error (generated by tools/lab/probe-thresholds.mjs)",
  "",
  `Held-out real hands per letter: up to ${PER} (never used for calibration). "Counts" = the shipped verdict (js/verdict.js).`,
  "Threshold = the perturbation level where the pass rate falls below half of the unperturbed rate (— = tolerated across the whole range).",
  "",
  "| letter | own pass | tilt ° | jitter σ | fan °/gap | thumb out | wrong finger still counts at 75% | other letters accepted as it |",
  "|---|---|---|---|---|---|---|---|",
  ...letters.map((L) => {
    const r = report.letters[L];
    const th = (a) => (r.axes[a].threshold === null ? "—" : r.axes[a].threshold);
    const wf = Object.entries(r.fingers).filter(([, f]) => f.stillCountsAt75 >= 0.5).map(([f, x]) => `${f} ${x.wrong}`).join(", ") || "none";
    const acc = Object.entries(r.acceptedAs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([X, x]) => `${X} ${pct(x)}`).join(", ") || "none";
    return `| ${L} | ${pct(r.base)} | ${th("tilt")} | ${th("jitter")} | ${th("fan")} | ${th("thumbOut")} | ${wf} | ${acc} |`;
  }),
  "",
];
fs.writeFileSync(path.join(ROOT, "docs", "lab", "THRESHOLDS.md"), md.join("\n"));

if (FILE_ISSUES) for (const f of findings) upsertIssue({ key: f.key, title: f.title, severity: f.sev, foundBy: "probe-thresholds", metric: f.metric, area: `letter ${f.L}`, repro: "node tools/lab/probe-thresholds.mjs" });
console.log(`probed ${letters.length} letters x ${PER} held-out hands; ${findings.length} findings (${findings.filter((f) => f.sev === "P0").length} P0, ${findings.filter((f) => f.sev === "P1").length} P1) -> docs/lab/THRESHOLDS.md, issues.json`);
