// =============================================================================
// js/verdict.js — "does this hand count as the letter?" (Engine, DOM-free)
// =============================================================================
// WHAT: The Practice / A->Z verdict, in one pure function so the live app and
//   the offline lab (tools/lab/) run the SAME logic. Extracted from main.js on
//   2026-09-24 — until then the lab re-implemented it in scratch scripts.
//
//   A hand counts when the letter's defining handshape traits hold
//   (js/handshape.js) and the recogniser isn't reading a DIFFERENT letter
//   whose traits also hold. For the fist letters (THUMB_GROUP: A E M N S T),
//   which differ only by a mostly-hidden thumb, the recogniser's call is the
//   tie-break; an unsure recogniser (null) gives the benefit of the doubt.
//
// PUBLIC API:
//   judgeLetter(handshape, vec, target, predLabel, tol) -> {
//     strict,          counts as the letter
//     bucket,          "correct" | "close" | "off"   (the meter)
//     confusedWith,    the other letter it's being read as, or null
//     traits,          handshape.check() result
//     errors,          21 per-joint colour levels for overlay.drawGuide
//   }
//   predLabel: the recogniser's label this frame (either-hand kNN + heads,
//     non-letter shapes already rejected) or null. tol: reference.matchTolerance.

import { THUMB_GROUP } from "./handshape.js";

const JOINTS = {
  thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20],
};
// per-finger state -> an error level the overlay's shared rule (jointstate.js)
// colours as good / close / fix (close band: tol..2tol, fix beyond 2tol)
const LEVEL = { good: 0, close: 1.5, fix: 2.5 };

export function judgeLetter(handshape, vec, target, predLabel, tol) {
  const hs = handshape.check(vec, target);
  const p = predLabel || null;
  let otherLetter = null;
  if (p && p !== target) {
    if (THUMB_GROUP.has(target)) otherLetter = THUMB_GROUP.has(p) ? p : null;
    else if (handshape.check(vec, p)?.ok) otherLetter = p;
  }
  const strict = !!hs?.ok && !otherLetter;
  const anyFix = !!hs?.traits.some((t) => t.state === "fix");
  const errors = new Array(21).fill(0);
  for (const [f, js] of Object.entries(JOINTS)) for (const j of js) errors[j] = LEVEL[hs?.fingerStates[f] || "good"] * tol;
  return {
    strict,
    bucket: strict ? "correct" : !anyFix ? "close" : "off",
    confusedWith: hs?.ok && otherLetter ? otherLetter : null,
    traits: hs,
    errors,
  };
}
