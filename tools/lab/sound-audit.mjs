// tools/lab/sound-audit.mjs — offline audit of js/sound.js (no speakers needed)
//
// Drives createSound() against a fake WebAudio context that just RECORDS every
// scheduled note, then reports, per cue:
//   voicings  — distinct note sets heard over a run of calls (1 = every repeat identical)
//   repeat%   — how often a call sounded exactly like the call before it
//   peak      — the loudest instant: the sum of every overlapping note's
//               envelope (attack 14 ms linear, exponential decay), in gain units
//   maxHz     — the highest pitch it ever plays
// It measures SCHEDULED audio, not what a speaker produces — an honest proxy
// for "is it varied" and "is it louder than before", not a listening test.
//
//   ELECTRON_RUN_AS_NODE=1 "$N" tools/lab/sound-audit.mjs [--json]

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---- fake browser: clock, storage, AudioContext that records notes ----
let clock = 0; // ms, advanced by the driver
Object.defineProperty(globalThis, "performance", { value: { now: () => clock }, configurable: true });
globalThis.localStorage = { getItem: () => null, setItem() {} };
let notes = [];
class Param {
  constructor(v) { this.value = v; this.peak = 0; }
  setValueAtTime(v) { this.value = v; }
  linearRampToValueAtTime(v) { this.peak = Math.max(this.peak, v); }
  exponentialRampToValueAtTime() {}
  cancelScheduledValues() {}
  setTargetAtTime(v) { this.peak = Math.max(this.peak, v); this.value = v; }
}
class Node { connect(n) { if (this.frequency && n.gain && !this._g) this._g = n; return n; } }
class FakeCtx {
  constructor() { this.state = "running"; this.destination = new Node(); }
  get currentTime() { return clock / 1000; }
  resume() {}
  createGain() { const g = new Node(); g.gain = new Param(1); return g; }
  createOscillator() {
    const o = new Node();
    o.frequency = new Param(440);
    o.type = "sine";
    o.start = (at = clock / 1000) => { o._at = at; };
    o.stop = (end) => { o._end = end; notes.push(o); };
    return o;
  }
}
globalThis.window = { AudioContext: FakeCtx };

const { createSound } = await import(pathToFileURL(path.join(ROOT, "js", "sound.js")).href);

// envelope of one recorded note at time t (s)
function env(n, t) {
  const g = n._gain, at = n._at, dur = n._end - 0.03 - at;
  if (t < at || t > at + dur) return 0;
  if (t < at + 0.014) return g * ((t - at) / 0.014);
  const k = Math.log(0.0001 / g) / (dur - 0.014);
  return g * Math.exp(k * (t - at - 0.014));
}
function peakOf(ns) {
  if (!ns.length) return 0;
  const t0 = Math.min(...ns.map((n) => n._at)), t1 = Math.max(...ns.map((n) => n._end));
  let best = 0;
  for (let t = t0; t <= t1; t += 0.002) best = Math.max(best, ns.reduce((s, n) => s + env(n, t), 0));
  return best;
}

// Each cue is called the way main.js calls it, spaced past its cooldown.
// Args a newer sound.js understands are passed; an older one ignores them.
const CUES = {
  "lock (spell letter)":      (s, i) => s.lock(i % 6),
  "success (practice)":       (s, i) => s.success({ step: i % 5, tier: "letter" }),
  "success (drill word)":     (s, i) => s.success({ mode: "drill", step: i % 5 }),
  "word (spell word)":        (s) => s.word(),
  "correct (read)":           (s, i) => s.correct(1 + (i % 6)),
  "hit x1 (challenge)":       (s) => s.hit(1),
  "hit x3 (challenge)":       (s) => s.hit(3),
  "partHit":                  (s, i) => s.partHit(i % 5),
  "runComplete (A->Z)":       (s) => s.runComplete(),
  "newBest":                  (s) => s.newBest(),
  "success first-time":       (s) => s.success({ tier: "first" }),
  "success mastery":          (s) => s.success({ tier: "mastery" }),
};

const RUNS = 24;
const report = {};
for (const [name, call] of Object.entries(CUES)) {
  const snd = createSound();
  const sigs = [];
  let peak = 0, maxHz = 0, maxNoteGain = 0;
  for (let i = 0; i < RUNS; i++) {
    clock += 5000; // well past every cooldown, and past the previous call's tail
    notes = [];
    call(snd, i);
    // each note's level = the peak of the gain node its oscillator feeds
    for (const n of notes) n._gain = n._g?.gain.peak ?? 0;
    const ns = notes.filter((n) => n._gain > 0);
    peak = Math.max(peak, peakOf(ns));
    for (const n of ns) { maxHz = Math.max(maxHz, n.frequency.value); maxNoteGain = Math.max(maxNoteGain, n._gain); }
    sigs.push(ns.map((n) => `${Math.round(n.frequency.value)}@${Math.round((n._at - clock / 1000) * 1000)}`).sort().join(","));
  }
  const distinct = new Set(sigs).size;
  let rep = 0;
  for (let i = 1; i < sigs.length; i++) if (sigs[i] === sigs[i - 1]) rep++;
  report[name] = {
    voicings: distinct,
    repeatPct: Math.round((100 * rep) / (sigs.length - 1)),
    peak: +peak.toFixed(3),
    maxNoteGain: +maxNoteGain.toFixed(3),
    maxHz: Math.round(maxHz),
  };
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("cue".padEnd(24), "voicings", "repeat%", "  peak", "noteMax", " maxHz");
  for (const [k, r] of Object.entries(report))
    console.log(k.padEnd(24), String(r.voicings).padStart(8), String(r.repeatPct).padStart(7),
      r.peak.toFixed(3).padStart(6), r.maxNoteGain.toFixed(3).padStart(7), String(r.maxHz).padStart(6));
  const loud = Math.max(...Object.values(report).map((r) => r.peak));
  console.log(`\nloudest peak across cues: ${loud.toFixed(3)}`);
}
