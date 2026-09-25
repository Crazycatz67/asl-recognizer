// =============================================================================
// js/jointstate.js — ONE definition of "how right is each joint" (Engine)
// =============================================================================
// WHAT: Classifies each of the 21 hand joints as "good" / "close" / "fix" from
//   its error against the letter's shape, and decides whether the whole hand
//   is readable enough to count. reference.js computes the states (score());
//   overlay.js colours the live hand with those SAME states (blue / orange /
//   magenta); main.js rewards on the same verdict. One rule, so what you see
//   on your hand is exactly what the app judges (2026-09-24 owner request:
//   "match the skeleton overlay accuracy and color with the guide ... not too
//   difficult but also accurate, without it yelling at you for the exact
//   positions of the photo").
//
// PUBLIC API:
//   FIX_BAND                    fraction of the way from tol to fullError where
//                               "close" becomes "fix"
//   fullError(tol)              the error that counts as fully off
//   jointState(e, tol, full?)   -> "good" | "close" | "fix"
//   countStates(states)         -> { good, close, fix }
//   READABLE                    the "counts as signed" rule's thresholds
//   isReadable(counts, score)   -> boolean
//
// UNITS: errors are in reference.js's normalized hand frame (wrist-centred,
//   scaled by hand size); tol comes from reference.matchTolerance(letter).

export const FIX_BAND = 0.5;
// "fully off" = 3x tol, so magenta ("fix") starts at 2x tol. It used to be
// 6x tol — fine while tol was tight, but once tol was widened for room for
// error, a finger ~0.7 hand-widths out of place still read as merely "close"
// and could count. Room for error lives in the orange band, not in hiding
// clearly wrong fingers.
export const fullError = (tol) => Math.max(tol * 3, 0.32);

/** @returns {"good"|"close"|"fix"} */
export function jointState(e, tol, full = fullError(tol)) {
  if (!(e > tol)) return "good";
  const t = (e - tol) / Math.max(1e-9, full - tol);
  return t < FIX_BAND ? "close" : "fix";
}

export function countStates(states) {
  const c = { good: 0, close: 0, fix: 0 };
  for (const s of states) c[s]++;
  return c;
}

// Room for user error: a sign counts when NO joint is badly off (magenta) and
// only a few are slightly off (orange), with a decent overall shape. You don't
// have to be pixel-perfect to the photo — but a clearly wrong finger (magenta)
// still has to be fixed.
export const READABLE = { maxClose: 5, maxFix: 0, minScore: 0.55 };

export function isReadable(counts, score) {
  return counts.fix <= READABLE.maxFix && counts.close <= READABLE.maxClose && score >= READABLE.minScore;
}
