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
//   tie-break.
//
//   When the recogniser REJECTS the hand as not-a-letter (knn.js recognise:
//   nearest real hand farther than REJECT_DIST) it still gives the benefit of
//   the doubt — a new signer's hand can sit far from every stored one — but
//   only while the target letter is in the hand's neighbourhood: among the
//   labels of its k nearest training hands (or the heads' best guess). Until
//   2026-09-25 any rejected hand got it, so the traits alone decided and a
//   relaxed hand counted as Q 60%, C 35%, B 15%, P 15%, and M hands counted
//   as N 21% (tools/lab/letter-report.mjs). Nothing here is a new number: k is
//   config.KNN_K, the reject line is config.REJECT_DIST.
//
// PUBLIC API:
//   judgeLetter(handshape, vec, target, predLabel, tol, reading?) -> {
//     strict,          counts as the letter
//     bucket,          "correct" | "close" | "off"   (the meter)
//     confusedWith,    the other letter it's being read as, or null
//     outOfPlace,      rejected hand whose neighbourhood has no `target`
//     traits,          handshape.check() result
//     errors,          21 per-joint colour levels for overlay.drawGuide
//   }
//   predLabel: the recogniser's label this frame (either-hand kNN + heads,
//     non-letter shapes already rejected) or null. tol: reference.matchTolerance.
//   reading: knn.js recognise()'s result for this frame (optional). Only its
//     `near` list is used, and only when predLabel is null; omit it (or pass
//     null) for the old unconditional benefit of the doubt (e.g. no dataset).

import { THUMB_GROUP } from "./handshape.js";

const JOINTS = {
  thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12],
  ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20],
};
// per-finger state -> an error level the overlay's shared rule (jointstate.js)
// colours as good / close / fix (close band: tol..2tol, fix beyond 2tol)
const LEVEL = { good: 0, close: 1.5, fix: 2.5 };

export function judgeLetter(handshape, vec, target, predLabel, tol, reading = null) {
  const hs = handshape.check(vec, target);
  const p = predLabel || null;
  let otherLetter = null;
  if (p && p !== target) {
    // the recogniser reads another letter: reject if the hand also fits that
    // letter's traits — or, for the fist letters (only the recogniser can
    // split them), if it's any other fist letter. The fist-letter branch used
    // to ignore NON-fist readings entirely, so real O hands (partly curled
    // fingers pass "folded") counted as A/E/S/T ~97% and L/G/X/Q/D counted
    // as T 63-100% (tools/lab/probe-thresholds.mjs, 2026-09-25).
    if ((THUMB_GROUP.has(target) && THUMB_GROUP.has(p)) || handshape.check(vec, p)?.ok) otherLetter = p;
  }
  // rejected as a non-letter AND none of its nearest real hands is the target.
  // The fist letters count as one neighbourhood: their traits can't split
  // them and a far hand's fist-letter vote is the same unreliable call the
  // reject line exists for — holding a far N to "an N must be among its 5
  // nearest" failed 3 of 45 real held-out N (all 5 neighbours M), a 7-pt
  // drop for N, the weakest letter (tools/lab/letter-report.mjs 2026-09-25).
  const inHood = (L) => L === target || (THUMB_GROUP.has(target) && THUMB_GROUP.has(L));
  const outOfPlace = !p && !!reading?.near?.length && !reading.near.some(inHood);
  const strict = !!hs?.ok && !otherLetter && !outOfPlace;
  const anyFix = !!hs?.traits.some((t) => t.state === "fix");
  const errors = new Array(21).fill(0);
  for (const [f, js] of Object.entries(JOINTS)) for (const j of js) errors[j] = LEVEL[hs?.fingerStates[f] || "good"] * tol;
  return {
    strict,
    bucket: strict ? "correct" : !anyFix ? "close" : "off",
    confusedWith: hs?.ok && otherLetter ? otherLetter : null,
    outOfPlace,
    traits: hs,
    errors,
  };
}
