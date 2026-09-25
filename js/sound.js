// Tiny synthesized sound — no audio files. Web Audio needs a user gesture to
// start, so call resume() from the first click (the "Turn on camera" button).
// Mute state persists in localStorage.
//
// VARIATION (2026-09-25, owner: "a lot more refreshing than the same repeated
// sfx"): every frequent cue now picks one of a few related voicings — all on
// the same C-major-pentatonic scale (js/juice.js) — and never the same one
// twice in a row, and streak/combo cues climb that scale. Each mode keeps its
// own motif so you can tell them apart:
//   Practice  success()            triangle arpeggio rising + sparkle
//   Spell     lock(i) / word()     tiny sine tick climbing with the letter's
//                                  place in the word / soft two-note set-down
//   Drill     success({mode:"drill"}) plucked triad + ping
//   Read      correct(streak)      sine two-note "yes", climbing with streak
//   Challenge hit(mult)            chord stab, root climbing with the combo
// Loudness: no note is louder than before, and tools/lab/sound-audit.mjs
// checks that no cue's summed peak exceeds the old loudest cue (success()).

import { PENTA, semi, scaleStep, createPicker, climb } from "./juice.js";

const C5 = 523.25;
// note for a pentatonic step above C5 (step 5 = C6), dropped an octave while
// it's above `ceil` Hz — climbing cues rise without getting shrill
// (live QA 2026-09-2x: "really loud or screechy")
const noteAt = (step, ceil = 1800) => {
  let f = C5 * semi(scaleStep(step, PENTA));
  while (f > ceil) f /= 2;
  return f;
};

// practice: 4-note arpeggios (pentatonic steps from C5); [0,2,3,5] = C E G C (the original)
const PRACTICE_VOICINGS = [[0, 2, 3, 5], [0, 2, 4, 5], [-2, 0, 2, 3], [0, 3, 5, 7]];
// drill word solved: 3-note plucks
const DRILL_VOICINGS = [[3, 5, 7], [2, 4, 5], [5, 3, 7], [0, 3, 5]];
// spell word set down: two soft notes
const WORD_VOICINGS = [[2, 4], [1, 3], [2, 5], [3, 5]];
// challenge chord shapes, semitones above the root
const HIT_SHAPES = [[0, 4, 7], [0, 7, 12], [4, 7, 12], [0, 4, 9]];
// combo x1..x4 -> scale step of the chord root (C, E, G, A)
const HIT_ROOT_STEP = [0, 2, 3, 4];

export function createSound() {
  let ctx = null;
  let muted = false;
  try {
    muted = localStorage.getItem("asl-muted") === "1";
  } catch {}

  const ensure = () => {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        ctx = null;
      }
    }
    // iOS reports "interrupted" (not "suspended") after a call / app switch
    if (ctx && (ctx.state === "suspended" || ctx.state === "interrupted")) ctx.resume().catch(() => {});
    return ctx;
  };

  // one note with a soft attack + exponential decay
  const tone = (freq, at, dur, { type = "triangle", gain = 0.12 } = {}) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.014);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(ctx.destination);
    o.start(at);
    o.stop(at + dur + 0.03);
  };

  // Per-sound cooldown: the same cue can't stack on itself faster than a
  // listener can tell the repeats apart. Every call site is event-driven, but
  // several events can land within a few frames of each other (e.g. a letter
  // + a word commit), and stacked oscillators read as a buzz or a spammed
  // jingle rather than feedback.
  const lastAt = {};
  const cool = (name, ms) => {
    const t = performance.now();
    if (t - (lastAt[name] ?? -Infinity) < ms) return false;
    lastAt[name] = t;
    return true;
  };

  // one no-repeat picker per varied cue (js/juice.js createPicker)
  const pickPractice = createPicker(PRACTICE_VOICINGS.length);
  const pickDrill = createPicker(DRILL_VOICINGS.length);
  const pickWord = createPicker(WORD_VOICINGS.length);
  const pickHit = createPicker(HIT_SHAPES.length);
  const pickLock = createPicker(3);
  const pickCorrect = createPicker(2);

  // persistent "charging" voice while a completed sign is being held — a low
  // tone that rises in pitch and volume as progress 0 -> 1, then resolves into
  // success(). charge(p<=0) or chargeStop() ends it.
  let chg = null;
  const chargeStop = (fade = 0.12) => {
    if (!chg || !ctx) return;
    const c = chg;
    chg = null;
    const n = ctx.currentTime;
    try {
      c.g.gain.cancelScheduledValues(n);
      c.g.gain.setValueAtTime(Math.max(0.0001, c.g.gain.value), n);
      c.g.gain.linearRampToValueAtTime(0.0001, n + fade);
      c.o.stop(n + fade + 0.03);
      c.o2.stop(n + fade + 0.03);
    } catch {}
  };

  return {
    resume() {
      ensure();
    },
    get muted() {
      return muted;
    },
    setMuted(m) {
      muted = !!m;
      if (muted) chargeStop(0.05);
      try {
        localStorage.setItem("asl-muted", muted ? "1" : "0");
      } catch {}
    },

    // p: 0..1 hold progress. call repeatedly while holding; <=0 stops.
    // { soft: true } — J/Z motion progress: a lower, narrower range and no
    //   octave shimmer (live QA: "really loud or screechy when you are
    //   struggling" — the motion metric swings frame to frame).
    //
    // Smoothing (2026-09-24): the old version queued a fresh
    // linearRampToValueAtTime every frame without cancelling, so each ramp
    // started from the previous one's end — pitch effectively followed the
    // frame-to-frame jitter ~33ms late, and the param's event list grew for
    // as long as the voice lived. Now: tiny changes are ignored, pending
    // automation is cancelled, and setTargetAtTime glides (tau 80ms).
    charge(p, { soft = false } = {}) {
      if (muted || !ensure()) {
        chargeStop(0.03);
        return;
      }
      if (!(p > 0)) {
        chargeStop();
        return;
      }
      const n = ctx.currentTime;
      if (!chg) {
        const g = ctx.createGain();
        g.gain.value = 0.0001;
        const o = ctx.createOscillator();
        o.type = "triangle";
        const o2 = ctx.createOscillator();
        o2.type = "sine";
        const g2 = ctx.createGain(); // shimmer level (0 for soft)
        o.connect(g);
        o2.connect(g2).connect(g);
        g.connect(ctx.destination);
        o.frequency.value = 240;
        o2.frequency.value = 480;
        o.start();
        o2.start();
        chg = { o, o2, g, g2, p: -1, soft: null };
      }
      if (Math.abs(p - chg.p) < 0.02 && chg.soft === soft) return;
      chg.p = p;
      chg.soft = soft;
      const f = soft ? 240 + p * 240 : 240 + p * 540; // soft: 240->480, hold: 240->780 Hz
      const gain = soft ? 0.02 + p * 0.035 : 0.03 + p * 0.06;
      for (const [param, v] of [
        [chg.o.frequency, f],
        [chg.o2.frequency, f * 2.01],
        [chg.g.gain, gain],
        [chg.g2.gain, soft ? 0 : 1],
      ]) {
        param.cancelScheduledValues(n);
        param.setValueAtTime(param.value, n);
        param.setTargetAtTime(v, n, 0.08);
      }
    },
    // stop any held tone right away (mode switch, tab hidden, letter change)
    chargeStop() {
      chargeStop(0.06);
    },

    // triumphant little rising arpeggio + a sparkle tail.
    // opts (all optional — success() alone still works):
    //   step  0..4  climbs the scale (a run of reps in a row)
    //   tier  "letter" | "first" (first-ever rep of a letter: a twinkle tail)
    //         | "mastery" (just mastered: a warm chord bloom)
    //   mode  "drill" — Spell's word drill gets its own pluck motif
    success(opts = {}) {
      chargeStop(0.04);
      if (muted || !cool("success", 300) || !ensure()) return;
      const { step = 0, tier = "letter", mode = "practice" } = opts || {};
      const up = climb(step + 1);
      const n = ctx.currentTime;
      if (mode === "drill") {
        const v = DRILL_VOICINGS[pickDrill()];
        v.forEach((st, i) => tone(noteAt(st + up), n + i * 0.06, 0.14, { gain: 0.1 }));
        tone(noteAt(Math.max(...v) + up + 2, 1800), n + 0.2, 0.35, { type: "sine", gain: 0.04 });
        return;
      }
      const v = PRACTICE_VOICINGS[pickPractice()];
      v.forEach((st, i) => tone(noteAt(st + up), n + i * 0.08, 0.3, { gain: 0.14 }));
      const top = Math.max(...v) + up;
      tone(noteAt(top + 3, 1800), n + 0.32, 0.55, { type: "sine", gain: 0.05 });
      if (tier === "first") {
        // a little three-note twinkle after the sparkle — "that's a new one"
        [1, 2, 4].forEach((d, i) =>
          tone(noteAt(top + 3 + d, 2100), n + 0.5 + i * 0.07, 0.22, { type: "sine", gain: 0.035 }));
      } else if (tier === "mastery") {
        // a warm sustained chord under the tail — "you own this one now"
        [0, 2, 3].forEach((st, i) =>
          tone(noteAt(st + up - 5), n + 0.44 + i * 0.03, 0.9, { type: "sine", gain: 0.035 }));
        tone(noteAt(top + 5, 2100), n + 0.62, 0.5, { type: "sine", gain: 0.03 });
      }
    },

    // soft tick — a letter just locked in. i = the letter's position in the
    // word being spelled: the tick climbs D6 E6 G6 A6 and wraps, so a word
    // plays a little rising figure instead of the same blip over and over.
    // No i: one of three neighbouring pitches, never the same twice running.
    lock(i) {
      if (muted || !cool("lock", 80) || !ensure()) return;
      const st = Number.isFinite(i) ? 6 + (Math.max(0, Math.floor(i)) % 4) : 6 + pickLock();
      tone(noteAt(st), ctx.currentTime, 0.05, { type: "sine", gain: 0.035 });
    },

    // sharper tick — the challenge timer is running low
    tick() {
      if (muted || !cool("tick", 120) || !ensure()) return;
      tone(880, ctx.currentTime, 0.06, { type: "square", gain: 0.03 });
    },

    // Spell: a word was committed to the transcript — a soft two-note "set
    // down" cue, deliberately small (Spell commits often; success() is the
    // big reward sound and shouldn't play every word)
    word() {
      if (muted || !cool("word", 400) || !ensure()) return;
      const n = ctx.currentTime;
      const [a, b] = WORD_VOICINGS[pickWord()];
      tone(noteAt(a), n, 0.09, { type: "sine", gain: 0.05 });
      tone(noteAt(b), n + 0.07, 0.16, { type: "sine", gain: 0.04 });
    },

    // ---- Challenge palette (2026-09-23): every game event gets its OWN cue
    // instead of reusing success()/fail()/select() everywhere. Each has a
    // visual twin in main.js (banner / flash / chip) — sound is never the
    // only signal.

    // a new round's letter appears — a quick soft upward "whoosh" blip
    roundStart() {
      if (muted || !cool("roundStart", 200) || !ensure()) return;
      const n = ctx.currentTime;
      tone(440, n, 0.06, { type: "sine", gain: 0.04 });
      tone(660, n + 0.05, 0.08, { type: "sine", gain: 0.035 });
    },
    // GO — bright two-note starting gun
    go() {
      if (muted || !cool("go", 300) || !ensure()) return;
      const n = ctx.currentTime;
      tone(784, n, 0.07, { type: "square", gain: 0.035 });
      tone(1175, n + 0.07, 0.16, { type: "square", gain: 0.04 });
    },
    // one letter of a word landed — a short pluck that climbs with position
    partHit(i = 0) {
      if (muted || !cool("partHit", 60) || !ensure()) return;
      tone(660 * Math.pow(2, Math.min(i, 6) / 12), ctx.currentTime, 0.09, { type: "triangle", gain: 0.07 });
    },
    // a Challenge letter/word landed — a chord whose root climbs the scale
    // with the combo multiplier (1..4: C E G A), so a hot streak audibly
    // "levels up"; the chord's shape varies hit to hit
    hit(mult = 1) {
      chargeStop(0.04);
      if (muted || !cool("hit", 150) || !ensure()) return;
      const n = ctx.currentTime;
      const m = Math.max(1, Math.min(Math.floor(mult) || 1, 4));
      const root = noteAt(HIT_ROOT_STEP[m - 1]);
      HIT_SHAPES[pickHit()].forEach((st, i) => tone(root * semi(st), n + i * 0.035, 0.22, { gain: 0.08 }));
      if (m > 1) {
        let sp = root * 4;
        while (sp > 2100) sp /= 2;
        tone(sp, n + 0.12, 0.3, { type: "sine", gain: 0.03 + 0.01 * m });
      }
    },
    // the combo multiplier just went up — a rising sparkle run
    comboUp(mult = 2) {
      if (muted || !cool("comboUp", 300) || !ensure()) return;
      const n = ctx.currentTime;
      const base = 880 * Math.pow(2, (Math.min(mult, 4) - 2) * 2 / 12);
      [0, 4, 7, 12].forEach((st, i) => tone(base * Math.pow(2, st / 12), n + 0.18 + i * 0.05, 0.14, { type: "sine", gain: 0.05 }));
    },
    // holding the wrong shape — the clock is draining (soft, low, repeating)
    drain() {
      if (muted || !cool("drain", 380) || !ensure()) return;
      tone(165, ctx.currentTime, 0.12, { type: "triangle", gain: 0.05 });
    },
    // lost a life (not the end) — a muted low thud, deliberately not harsh
    lifeLost() {
      if (muted || !cool("lifeLost", 300) || !ensure()) return;
      const n = ctx.currentTime;
      tone(220, n, 0.16, { type: "triangle", gain: 0.1 });
      tone(165, n + 0.1, 0.24, { type: "triangle", gain: 0.08 });
    },
    // the run is over — a slower three-step descent
    gameOver() {
      chargeStop(0.04);
      if (muted || !cool("gameOver", 500) || !ensure()) return;
      const n = ctx.currentTime;
      [392, 311.13, 261.63].forEach((f, i) => tone(f, n + i * 0.16, 0.34, { type: "triangle", gain: 0.1 }));
    },
    // a new personal best — the ONE big fanfare in the app, saved for this
    newBest() {
      if (muted || !cool("newBest", 1000) || !ensure()) return;
      const n = ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) =>
        tone(f, n + 0.45 + i * 0.09, 0.4, { gain: 0.12 }));
      [1046.5, 1567.98, 2093].forEach((f, i) =>
        tone(f, n + 0.95 + i * 0.06, 0.6, { type: "sine", gain: 0.04 }));
    },
    // an A->Z / Review run completed — warmer and longer than a single letter
    runComplete() {
      chargeStop(0.04);
      if (muted || !cool("runComplete", 800) || !ensure()) return;
      const n = ctx.currentTime;
      [392, 523.25, 659.25, 783.99].forEach((f, i) => tone(f, n + i * 0.11, 0.45, { gain: 0.11 }));
      tone(1046.5, n + 0.44, 0.7, { type: "sine", gain: 0.05 });
    },
    // Read mode: a correct answer — a gentle two-note "yes" (not the big
    // reward). streak (optional) climbs the scale; the interval varies.
    correct(streak = 1) {
      if (muted || !cool("correct", 250) || !ensure()) return;
      const n = ctx.currentTime;
      const a = 2 + climb(streak); // E5 at streak 1, the original first note
      tone(noteAt(a), n, 0.12, { type: "sine", gain: 0.07 });
      tone(noteAt(a + (pickCorrect() ? 3 : 2)), n + 0.09, 0.2, { type: "sine", gain: 0.07 });
    },
    // Read mode: not quite — a soft falling two-note "hmm" (not the harsh fail)
    wrong() {
      if (muted || !cool("wrong", 250) || !ensure()) return;
      const n = ctx.currentTime;
      tone(392, n, 0.12, { type: "triangle", gain: 0.06 });
      tone(349.23, n + 0.1, 0.2, { type: "triangle", gain: 0.05 });
    },

    // a run ended
    fail() {
      if (muted || !cool("fail", 300) || !ensure()) return;
      const n = ctx.currentTime;
      tone(300, n, 0.18, { type: "sawtooth", gain: 0.09 });
      tone(220, n + 0.12, 0.3, { type: "sawtooth", gain: 0.08 });
    },

    // picking a letter to learn
    select() {
      if (muted || !cool("select", 80) || !ensure()) return;
      const n = ctx.currentTime;
      tone(392, n, 0.05, { type: "sine", gain: 0.05 });
      tone(587.33, n + 0.045, 0.07, { type: "sine", gain: 0.05 });
    },
  };
}
