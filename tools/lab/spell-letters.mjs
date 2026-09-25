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
import fs from "node:fs";
import { loadLab, rng } from "./lab-data.mjs";
import { createSpellSim } from "./spell-sim.mjs";

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

const lab = await loadLab();
// the simulated Spell pipelines live in spell-sim.mjs (shared with
// tools/lab/letter-report.mjs)
const { makeScript, runScript, letterTrial, PROFILE, SPAN, ALL } = await createSpellSim({ lab, gateSet: GATE_SET, debug: DEBUG });

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
