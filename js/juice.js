// =============================================================================
// js/juice.js — pure helpers for reward feedback (variation + escalation)
// =============================================================================
// WHAT: The DOM-free, audio-free decisions behind "make it rewarding and not
//   the same sound every time": which voicing plays next (never the same one
//   twice in a row), how far up the scale a streak has climbed, which tier of
//   celebration a rep earns (plain / first-ever letter / just mastered), and
//   how big that celebration's visuals are.
//
// WHERE IT SITS: sound.js asks it for pitches, main.js asks it for tiers and
//   visual plans, fx.js draws the plan. Runs under plain Node (selftest +
//   tools/lab/sound-audit.mjs).
//
// MUSIC: everything lives on ONE scale — C major pentatonic (C D E G A) — so
//   any two variants, and any streak step, sound related rather than random.
//   Pentatonic has no semitone clashes, so overlapping tails never grind.

/** Major-pentatonic scale degrees, in semitones above the root. */
export const PENTA = [0, 2, 4, 7, 9];

/** Frequency ratio for n semitones. */
export const semi = (n) => Math.pow(2, n / 12);

/**
 * Semitone offset of scale step `step` (0 = root; wraps into higher/lower
 * octaves), e.g. PENTA step 5 = 12 (the octave), step -1 = -3.
 */
export function scaleStep(step, scale = PENTA) {
  const n = scale.length;
  const s = Math.round(step) || 0;
  const oct = Math.floor(s / n);
  return scale[((s % n) + n) % n] + 12 * oct;
}

/**
 * A picker over n variants that never returns the same index twice in a row
 * (for n >= 2). rng is injectable for tests.
 * @returns {() => number}
 */
export function createPicker(n, rng = Math.random) {
  let last = -1;
  return () => {
    if (n <= 1) return 0;
    let i;
    if (last < 0) i = Math.floor(rng() * n);
    else {
      i = Math.floor(rng() * (n - 1)); // n-1 choices: everything except `last`
      if (i >= last) i++;
    }
    i = Math.min(n - 1, Math.max(0, i));
    last = i;
    return i;
  };
}

/**
 * In-a-row counter for rewards: another success within `windowMs` of the
 * previous one extends the run, otherwise it starts again at 1.
 */
export function nextRun(prevCount, prevAt, now, windowMs = 30000) {
  return prevAt != null && now - prevAt <= windowMs && prevCount > 0 ? prevCount + 1 : 1;
}

/** Streak/run length -> how many scale steps a cue climbs (0-based, capped). */
export function climb(run, cap = 4) {
  return Math.max(0, Math.min(cap, (Math.floor(run) || 1) - 1));
}

/**
 * Which celebration a completed rep earns. prevDone = completions before this
 * one, done = after it. "mastery" wins when both apply (it's the rarer one).
 */
export function rewardTier(prevDone, done, masteryAt = 3) {
  if (prevDone < masteryAt && done >= masteryAt) return "mastery";
  if (!(prevDone > 0)) return "first";
  return "letter";
}

/**
 * Visual plan for a practice reward: bigger for rarer moments and for longer
 * runs, bounded so a long streak never turns into a screen full of confetti.
 */
export function celebrationPlan(tier = "letter", run = 1) {
  const c = climb(run);
  const base = {
    letter: { particles: 30, rings: 1, stars: false, color: "#22c55e", moment: null },
    first: { particles: 46, rings: 2, stars: true, color: "#38bdf8", moment: "first" },
    mastery: { particles: 60, rings: 3, stars: true, color: "#fde047", moment: "mastery" },
  }[tier] || null;
  const p = base || { particles: 30, rings: 1, stars: false, color: "#22c55e", moment: null };
  return {
    ...p,
    particles: Math.min(72, p.particles + c * 6),
    rings: Math.min(3, p.rings + (c >= 3 ? 1 : 0)),
    run: Math.max(1, Math.floor(run) || 1),
  };
}

/** Combo multiplier / streak -> edge-glow level 0..3 (0 = no glow). */
export function glowLevel(mult) {
  const m = Math.floor(mult) || 0;
  return m < 2 ? 0 : Math.min(3, m - 1);
}
