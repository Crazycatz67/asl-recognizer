// tools/lab/probe-thresholds.mjs — per-letter "room for error" + looseness probe.
//
//   node tools/lab/probe-thresholds.mjs [--per 30] [--no-issues]
//
// Owner goal (2026-09-24): a letter must "follow the general shape and
// position but not be fixated on accuracy" — natural variation passes, but a
// wrong finger / wrong thumb / wrong spread must NOT count.
//
// For every static letter, takes held-out REAL hands of that letter (never
// used for calibration) and perturbs them along one axis at a time, measuring
// what fraction still COUNT under the shipped verdict (js/verdict.js).
//
// ROOM FOR ERROR (natural variation — should keep passing):
//   tilt (in-plane °) · jitter (landmark noise σ) · fan (fingers apart °/gap)
//   · curl (every finger curled at its middle joint °)
// WRONG SHAPE (physical, tools/synth-hand.js — should STOP passing):
//   · each finger the letter defines as raised/folded, bent the WRONG way
//     about its own base knuckle + middle joint (bendFinger: a folded finger
//     raised, a raised one folded) — levels in degrees per joint
//   · the thumb swung about its base the wrong way (swingThumb: out for the
//     tucked-thumb letters, in for L Y C Q)
//   · wrong spread: index/middle fanned apart for the together letters
//     (B U H R), squeezed together for the apart letters (V K)
// plus a confusion pass: which OTHER letters' real hands count as this one.
//
// Every perturbed hand is re-normalized like a live frame (hand radius 1,
// the 11 derived features recomputed) so the recogniser sees a consistent
// vector. "Clearly wrong" magnitudes (CLEAR) are where the wrong shape is
// unmistakable: 60° per joint (a finger half-folded is ~40°), thumb 45° out /
// 30° in, 20°/gap fan (U 2° -> V 20° median index/middle spread).
// Writes docs/lab/thresholds.json + docs/lab/THRESHOLDS.md and files issues
// (tools/lab/issues.mjs) for letters that are too loose or too strict.
// Deterministic (seeded) — same inputs, same report.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLab, rng, gauss, ROOT } from "./lab-data.mjs";
import { upsertIssue, resolveMissing } from "./issues.mjs";

const args = process.argv.slice(2);
const PER = Number(args[args.indexOf("--per") + 1]) || 30;
const FILE_ISSUES = !args.includes("--no-issues");
const ONLY = args.includes("--letters") ? args[args.indexOf("--letters") + 1].split("") : null;

const lab = await loadLab();
const { test, judge, predict, countsWith, rotateVector } = lab;
const letters = ONLY ? lab.letters.filter((L) => ONLY.includes(L)) : lab.letters;
const { fanFingers, curlAtMiddle, bendFinger, swingThumb } = await import(pathToFileURL(path.join(ROOT, "tools", "synth-hand.js")).href);

// re-normalize a perturbed vector the way a live frame is: hand radius 1,
// derived features recomputed (rotateVector by 0 rebuilds them)
const refresh = (v) => {
  let r = 1e-6;
  for (let j = 0; j < 21; j++) r = Math.max(r, Math.hypot(v[j * 3], v[j * 3 + 1], v[j * 3 + 2]));
  return rotateVector(v.slice(0, 63).map((x) => x / r).concat(v.length > 63 ? [0] : []), 0).slice(0, v.length);
};

const sample = (L) => {
  const arr = test[L] || [];
  const step = Math.max(1, Math.floor(arr.length / PER));
  return arr.filter((_, i) => i % step === 0).slice(0, PER).map((s) => s.v);
};
const passRate = (vs, L) => vs.length ? vs.filter((v) => countsWith(v, L, predict(v))).length / vs.length : 0;
const sweep = (vs, L, levels, apply) => {
  const r = rng(7);
  return levels.map((x) => passRate(vs.map((v) => refresh(apply(v, x, r))), L));
};

// the level at which the pass rate falls below half of the unperturbed rate
function thresholdOf(levels, rates, base) {
  for (let i = 0; i < levels.length; i++) if (rates[i] < base * 0.5) return levels[i];
  return null; // never dropped: tolerated across the whole range
}

// ROOM FOR ERROR axes
const AX = {
  tilt: { levels: [0, 10, 20, 30, 45, 60], apply: (v, x) => rotateVector(v, x) },
  jitter: { levels: [0, 0.01, 0.02, 0.04, 0.06], apply: (v, x, r) => v.map((val, i) => (i < 63 ? val + gauss(r) * x : val)) },
  fan: { levels: [0, 10, 20, 30], apply: (v, x) => fanFingers(v, x) },
  curl: { levels: [0, 20, 40, 60, 90], apply: (v, x) => curlAtMiddle(v, x) },
};
// WRONG SHAPE axes
const FINGER_LEVELS = [0, 15, 30, 45, 60, 90];
const CLEAR = { finger: 60, thumbOut: 45, thumbIn: 30, spread: 20 };
// ASL: which letters hold index + middle together vs apart (the probe's own
// knowledge of the WRONG direction, not a threshold)
const TOGETHER = new Set(["B", "U", "H", "R"]), APART = new Set(["V", "K"]);
const THUMB_OUT_LETTERS = new Set(["L", "Y", "C", "Q"]);
const at = (levels, rates, x) => rates[levels.indexOf(x)];

const report = { generated: new Date().toISOString().slice(0, 16), per: PER, clear: CLEAR, letters: {} };
const findings = [];
const loose = (L, key, what, rate, base, lvl) => {
  if (base > 0.3 && rate > 0.5) findings.push({ sev: "P0", L, key: `loose-${key}-${L}`, title: `${L} still counts with ${what}`, metric: `${Math.round(100 * rate)}% pass at ${lvl} (base ${Math.round(100 * base)}%)` });
};

for (const L of letters) {
  const vs = sample(L);
  const base = passRate(vs.map(refresh), L);
  const row = { base: +base.toFixed(2), n: vs.length, axes: {}, fingers: {}, wrong: {}, acceptedAs: {} };
  for (const [name, ax] of Object.entries(AX)) {
    const rates = sweep(vs, L, ax.levels, ax.apply);
    row.axes[name] = { levels: ax.levels, rates: rates.map((x) => +x.toFixed(2)), threshold: thresholdOf(ax.levels, rates, base || 1) };
  }
  const spec = judge.ranges.get(L) || {};
  // each defined finger bent the WRONG way about its own knuckles
  for (const f of ["index", "middle", "ring", "pinky"]) {
    const t = spec[f + "Flex"];
    if (!t || (t.kind !== "up" && t.kind !== "down")) continue;
    const sgn = t.kind === "down" ? -1 : 1; // folded -> raise (negative bend), raised -> fold
    const rates = sweep(vs, L, FINGER_LEVELS, (v, x) => bendFinger(v, f, sgn * x));
    const clear = at(FINGER_LEVELS, rates, CLEAR.finger);
    row.fingers[f] = { wrong: t.kind === "down" ? "raised" : "folded", levels: FINGER_LEVELS, rates: rates.map((x) => +x.toFixed(2)), atClear: +clear.toFixed(2) };
    loose(L, `finger-${f}`, `the ${f} finger ${row.fingers[f].wrong} ${CLEAR.finger}°`, clear, base, `${CLEAR.finger}°`);
  }
  // the thumb swung the wrong way
  {
    const out = !THUMB_OUT_LETTERS.has(L); // wrong = out, except for the thumb-out letters
    const levels = out ? [0, 15, 30, 45, 60] : [0, 10, 20, 30, 40];
    const rates = sweep(vs, L, levels, (v, x) => swingThumb(v, out ? x : -x));
    const clearAt = out ? CLEAR.thumbOut : CLEAR.thumbIn;
    const defined = Object.keys(spec).some((k) => k.startsWith("thumb"));
    row.wrong.thumb = { dir: out ? "out" : "in", defined, levels, rates: rates.map((x) => +x.toFixed(2)), atClear: +at(levels, rates, clearAt).toFixed(2) };
    if (defined) loose(L, "thumb", `the thumb swung ${out ? "out" : "in"} ${clearAt}°`, at(levels, rates, clearAt), base, `${clearAt}°`);
  }
  // wrong spread
  if (TOGETHER.has(L) || APART.has(L)) {
    const apart = APART.has(L);
    const levels = [0, 10, 20, 30];
    const rates = sweep(vs, L, levels, (v, x) => fanFingers(v, apart ? -x : x));
    row.wrong.spread = { dir: apart ? "squeezed" : "fanned", levels, rates: rates.map((x) => +x.toFixed(2)), atClear: +at(levels, rates, CLEAR.spread).toFixed(2) };
    loose(L, "spread", `index/middle ${apart ? "squeezed together" : "fanned apart"} ${CLEAR.spread}°/gap`, at(levels, rates, CLEAR.spread), base, `${CLEAR.spread}°/gap`);
  }
  report.letters[L] = row;
  if (base < 0.75) findings.push({ sev: "P1", L, key: `strict-own-${L}`, title: `${L}: only ${Math.round(100 * base)}% of real held-out ${L} hands count`, metric: `own pass ${Math.round(100 * base)}%` });
  if (row.axes.tilt.threshold !== null && row.axes.tilt.threshold <= 10) findings.push({ sev: "P1", L, key: `strict-tilt-${L}`, title: `${L} stops counting at a ${row.axes.tilt.threshold}° tilt`, metric: `tilt threshold ${row.axes.tilt.threshold}°` });
  if (row.axes.jitter.threshold !== null && row.axes.jitter.threshold <= 0.01) findings.push({ sev: "P1", L, key: `strict-jitter-${L}`, title: `${L} breaks under light landmark jitter (σ ${row.axes.jitter.threshold})`, metric: `jitter threshold ${row.axes.jitter.threshold}` });
  process.stderr.write(`${L} `);
}
process.stderr.write("\n");

// confusion: which OTHER letters' real hands count as L
for (const X of lab.letters) {
  const vs = sample(X);
  const preds = vs.map((v) => predict(v));
  for (const L of letters) {
    if (L === X) continue;
    const rate = vs.filter((v, i) => countsWith(v, L, preds[i])).length / (vs.length || 1);
    if (rate > 0) report.letters[L].acceptedAs[X] = +rate.toFixed(2);
    if (rate > 0.15) findings.push({ sev: "P0", L, key: `confuse-${X}-as-${L}`, title: `${Math.round(100 * rate)}% of real ${X} hands count as ${L}`, metric: `${X}->${L} ${Math.round(100 * rate)}%` });
  }
}

const pct = (x) => `${Math.round(100 * x)}%`;
if (ONLY) {
  // partial run (--letters): print, don't overwrite the stored document
  for (const L of letters) console.log(L, JSON.stringify(report.letters[L]));
} else {
  fs.mkdirSync(path.join(ROOT, "docs", "lab"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "docs", "lab", "thresholds.json"), JSON.stringify(report, null, 1) + "\n");
  const md = [
    "# Per-letter room for error (generated by tools/lab/probe-thresholds.mjs)",
    "",
    `Held-out real hands per letter: up to ${PER} (never used for calibration). "Counts" = the shipped verdict (js/verdict.js). Perturbations are physical (tools/synth-hand.js) and every perturbed hand is re-normalized like a live frame.`,
    "Room-for-error columns: the level where the pass rate falls below half of the unperturbed rate (— = tolerated across the whole range).",
    `Wrong-shape columns: % of the letter's own hands that STILL count at a clearly wrong magnitude (finger bent the wrong way ${CLEAR.finger}° at knuckle + middle joint; thumb ${CLEAR.thumbOut}° out / ${CLEAR.thumbIn}° in; index/middle fanned or squeezed ${CLEAR.spread}°/gap). Lower is better; > 50% is a finding. (thumb) = the letter doesn't define its thumb, informational.`,
    "",
    "| letter | own pass | tilt ° | jitter σ | fan °/gap | curl ° | wrong finger still counts | wrong thumb | wrong spread | other letters accepted as it |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...letters.map((L) => {
      const r = report.letters[L];
      const th = (a) => (r.axes[a].threshold === null ? "—" : r.axes[a].threshold);
      const wf = Object.entries(r.fingers).map(([f, x]) => `${f} ${x.wrong} ${pct(x.atClear)}`).join(", ") || "n/a";
      const t = r.wrong.thumb;
      const wt = t.defined ? `${t.dir} ${pct(t.atClear)}` : `(${t.dir} ${pct(t.atClear)})`;
      const ws = r.wrong.spread ? `${r.wrong.spread.dir} ${pct(r.wrong.spread.atClear)}` : "n/a";
      const acc = Object.entries(r.acceptedAs).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([X, x]) => `${X} ${pct(x)}`).join(", ") || "none";
      return `| ${L} | ${pct(r.base)} | ${th("tilt")} | ${th("jitter")} | ${th("fan")} | ${th("curl")} | ${wf} | ${wt} | ${ws} | ${acc} |`;
    }),
    "",
    "## Findings",
    "",
    ...(findings.length ? findings.map((f) => `- ${f.sev} ${f.title} — ${f.metric}`) : ["none"]),
    "",
  ];
  fs.writeFileSync(path.join(ROOT, "docs", "lab", "THRESHOLDS.md"), md.join("\n"));
  if (FILE_ISSUES) for (const f of findings) upsertIssue({ key: f.key, title: f.title, severity: f.sev, foundBy: "probe-thresholds", metric: f.metric, area: `letter ${f.L}`, repro: "node tools/lab/probe-thresholds.mjs" });
  if (FILE_ISSUES) {
    const resolved = resolveMissing("probe-thresholds", findings.map((f) => f.key));
    if (resolved.length) console.log(`resolved (no longer found): ${resolved.join(" ")}`);
  }
}
console.log(`probed ${letters.length} letters x ${PER} held-out hands; ${findings.length} findings (${findings.filter((f) => f.sev === "P0").length} P0, ${findings.filter((f) => f.sev === "P1").length} P1)`);
