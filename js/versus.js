// =============================================================================
// js/versus.js — two-player Challenge (Engine, DOM-free)
// =============================================================================
// WHAT: Two ways for two people to play Challenge (owner request 2026-09-25):
//   mode "turns" — players ALTERNATE rounds on one camera (normal one-hand
//     tracking). Each has their own score, 3 lives and combo. A player out of
//     lives is skipped; the game ends when both are out; higher score wins.
//   mode "race"  — BOTH sign the same target at the same time (two hands on
//     screen, one per player). The first to land it wins the round's points;
//     holding a confidently WRONG shape for 0.8 s locks that player out of the
//     round for 0.8 s (no fishing). A timeout scores nobody. First to
//     `raceTo` round wins (or most wins after `maxRounds`) takes the game.
//
// PUBLIC API:
//   createVersus({ letters, words?, mode, difficulty?, rng?, raceTo?, maxRounds? })
//     .start(now) · .stop() · .update(now, seen) -> snapshot | null
//       seen: [p1Letter|null, p2Letter|null] — each player's confirmed letter
//             this frame (turns mode only reads the current player's slot)
//   snapshot: { mode, phase, target, progress:[a,b], round, current, players:
//     [{ score, lives, streak, mult, wins, locked }], roundWinner, lastGain,
//     remainingFrac, low, event, gameWinner, over }
//     phase: "study" | "go" | "play" | "won" | "miss" | "over"
//     event: "letter" | "go" | "play" | "win" | "miss" | "over" | null
//   Scoring matches solo Challenge: (10 + speed*20) x letters x combo mult.

import { multFor } from "./challenge.js";

const STUDY_MS = { normal: 1800, hard: 900 };
const GO_MS = 560, WON_MS = 900, MISS_MS = 900;
const LETTER_MS = { normal: (r) => Math.max(2600, 6500 - r * 200), hard: (r) => Math.max(1900, 4500 - r * 160) };
const LOCK_AFTER_MS = 800, LOCK_FOR_MS = 800;
const START_LIVES = 3;

export function createVersus({ letters, words = [], mode = "turns", difficulty = "normal", rng = Math.random, raceTo = 7, maxRounds = 15 }) {
  const diff = difficulty === "hard" ? "hard" : "normal";
  const wordPool = (words || []).map((w) => String(w).toUpperCase())
    .filter((w) => /^[A-Z]{3,4}$/.test(w) && !/(.)\1/.test(w) && [...w].every((c) => letters.includes(c)));
  let active = false, phase = "idle", target = null, round = 0, phaseEnd = 0, playStart = 0, announced = 0;
  let current = 0, roundWinner = -1, lastGain = 0, gameWinner = -1;
  let players = [], progress = [0, 0], wrongSince = [0, 0], lockedUntil = [0, 0];

  const fresh = () => ({ score: 0, lives: START_LIVES, streak: 0, wins: 0 });
  const letterMs = () => LETTER_MS[diff](round);
  const roundDur = () => (target && target.length > 1 ? Math.round(letterMs() * (0.75 * target.length + 0.5)) : letterMs());
  const pick = () => {
    if (round > 6 && wordPool.length && rng() < 0.35) return wordPool[Math.min(wordPool.length - 1, (rng() * wordPool.length) | 0)];
    const i = Math.min(letters.length - 1, (rng() * letters.length) | 0);
    return letters[i] === target ? letters[(i + 1) % letters.length] : letters[i];
  };
  const alive = (p) => players[p].lives > 0;
  function next(now) {
    round++;
    target = pick();
    progress = [0, 0];
    wrongSince = [0, 0];
    lockedUntil = [0, 0];
    roundWinner = -1;
    if (mode === "turns" && round > 1) {
      const other = 1 - current;
      if (alive(other)) current = other;
    }
    phase = "study";
    phaseEnd = now + STUDY_MS[diff];
  }
  function award(p, now) {
    const speed = Math.max(0, (phaseEnd - now) / roundDur());
    const P = players[p];
    P.streak++;
    lastGain = (10 + Math.round(speed * 20)) * target.length * multFor(P.streak);
    P.score += lastGain;
    P.wins++;
    roundWinner = p;
    if (mode === "race") players[1 - p].streak = 0;
  }
  function finish() {
    phase = "over";
    const [a, b] = players;
    gameWinner = mode === "race"
      ? (a.wins === b.wins ? (a.score === b.score ? -1 : a.score > b.score ? 0 : 1) : a.wins > b.wins ? 0 : 1)
      : (a.score === b.score ? -1 : a.score > b.score ? 0 : 1);
  }

  return {
    get active() { return active; },
    get phase() { return phase; },
    get mode() { return mode; },
    start(now) {
      active = true;
      players = [fresh(), fresh()];
      round = 0; announced = 0; current = 0; gameWinner = -1; target = null;
      next(now);
    },
    stop() { active = false; phase = "idle"; target = null; },
    // the letter each player must form right now (null outside play / not their turn)
    needed(p) {
      if (phase !== "play" || !target) return null;
      if (mode === "turns" && p !== current) return null;
      return target[progress[p]];
    },
    update(now, seen = [null, null]) {
      if (!active) return null;
      let event = null;
      if (phase === "study" && announced !== round) { announced = round; event = "letter"; }
      if (phase === "study") {
        if (now >= phaseEnd) { phase = "go"; phaseEnd = now + GO_MS; event = "go"; }
      } else if (phase === "go") {
        if (now >= phaseEnd) { phase = "play"; playStart = now; phaseEnd = now + roundDur(); event = "play"; }
      } else if (phase === "play") {
        const who = mode === "turns" ? [current] : [0, 1];
        for (const p of who) {
          const s = seen[p] || null;
          const need = target[progress[p]];
          const justLanded = progress[p] > 0 ? target[progress[p] - 1] : null;
          if (now < lockedUntil[p]) continue;
          if (s && s === need) {
            wrongSince[p] = 0;
            progress[p]++;
            if (progress[p] >= target.length) {
              award(p, now);
              phase = "won";
              phaseEnd = now + WON_MS;
              event = "win";
              break;
            }
          } else if (s && s !== justLanded) {
            if (!wrongSince[p]) wrongSince[p] = now;
            if (now - wrongSince[p] >= LOCK_AFTER_MS && mode === "race") { lockedUntil[p] = now + LOCK_FOR_MS; wrongSince[p] = 0; }
          } else {
            wrongSince[p] = 0;
          }
        }
        if (phase === "play" && now >= phaseEnd) {
          lastGain = 0;
          if (mode === "turns") { players[current].lives--; players[current].streak = 0; }
          else { players[0].streak = 0; players[1].streak = 0; }
          phase = "miss";
          phaseEnd = now + MISS_MS;
          event = "miss";
        }
      } else if (phase === "won" || phase === "miss") {
        if (now >= phaseEnd) {
          const [a, b] = players;
          const done = mode === "turns"
            ? !alive(0) && !alive(1)
            : a.wins >= raceTo || b.wins >= raceTo || round >= maxRounds;
          if (done) { finish(); event = "over"; }
          else next(now);
          if (event !== "over" && phase === "study") event = null; // "letter" fires on the next update
        }
      }
      const span = phase === "study" ? STUDY_MS[diff] : phase === "go" ? GO_MS : phase === "play" ? roundDur() : phase === "miss" ? MISS_MS : WON_MS;
      const remainingFrac = Math.max(0, Math.min(1, (phaseEnd - now) / span));
      return {
        mode, phase, target, progress: progress.slice(), round, current, difficulty: diff,
        players: players.map((P, i) => ({ ...P, mult: multFor(P.streak), locked: now < lockedUntil[i] })),
        roundWinner, lastGain, remainingFrac, low: phase === "play" && remainingFrac < 0.28,
        event, gameWinner, over: phase === "over",
      };
    },
  };
}
