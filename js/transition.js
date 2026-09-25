// =============================================================================
// js/transition.js — rhythm-based letter segmentation for Spell mode (Engine)
// =============================================================================
// WHAT: Decides WHEN a letter has been signed during continuous
//   fingerspelling. The stabiliser waits for a letter to be *held still* for
//   N frames — which never happens at real signing speed, so Spell mode feels
//   stuck. This watches the hand's motion instead: a letter is committed the
//   moment the hand SETTLES after a MOVE. The move-between-settles
//   requirement is also what lets doubled letters (the two L's in HELLO)
//   register — you have to bounce between them.
//
// PIPELINE (Spell mode, "fluid" path): webcam → MediaPipe → onefilter →
//   normalize → kNN → heads → [transition.js] → speller.addLetter() →
//   decode.js. It replaces stabilizer.js on this path.
//
// PUBLIC API:
//   const tr = createTransitionMatcher({ moveThr, stillThr, minConf });
//   tr.push(landmarks, prediction, now);   // every frame; prediction = {label, confidence}
//   tr.read()                              // -> {letter, conf} once per settle, else null
//   tr.state / tr.metrics()                // "moving" | "settling" | "settled", + live numbers
//   tr.reset()
//
// STATE MACHINE (per frame, from `travel` = motion over the last WIN_MS):
//   travel ≥ moveThr            → "moving"   (arms the next commit, clears votes)
//   travel ≤ stillThr           → "settling" → after SETTLE_MS with votes → commit → "settled"
//   in between ("drifting")     → keep the current state, keep collecting votes
//
// OUTPUT: the majority letter seen across the settled window, with its mean
//   confidence — that averaged posterior is what feeds js/decode.js.
//
// UNITS: landmarks are normalized 0..1 frame coords; `now` is performance.now()
//   ms; travel/moveThr/stillThr are in hand-spans (tracked-point travel
//   divided by wrist→knuckle size), so thresholds don't depend on distance
//   from the camera. Tune with tools/sweep-transition.mjs (relative numbers
//   only — see the caveat at the top of that file).

// ---- timing (ms) ----
const WIN_MS = 110; // motion is measured over this trailing window
// SETTLE_MS history: 90ms was too quick to tell a real settle from a hand just slowing down
// mid-transition — a fast fingerspeller's hand can dip under stillThr for a
// beat between two letters without actually landing on either one, and that
// was enough to lock in whatever shape it happened to be passing through.
// Bumped to 115ms + a tighter stillThr + a higher confidence floor per a
// sweep against tools/replay-lab.html-style sequence data: this cuts
// spurious commits noticeably while only trimming a little recall (still
// well under half a second, so it doesn't feel sticky at real signing speed).
// Went as high as 140ms first but that missed a 7-frame (~230ms) still hold
// in the selftest fixture once the post-move settle-start delay is counted —
// 115ms leaves enough slack for a normal-speed hold while still being
// meaningfully stricter than the old 90ms.
const SETTLE_MS = 115; // must be still this long after a move to commit
// MediaPipe landmark indices tracked for motion:
const TIPS = [0, 8, 12, 16]; // wrist + 3 fingertips — enough to catch a transition
const MIN_VOTES = 3; // a settle needs at least this many confident frames to commit
const MIN_SHARE = 0.6; // ...and the winning letter must hold this share of them

// Hand size ("span"): wrist → mean of the four knuckles (5, 9, 13, 17).
function spanOf(lm) {
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of [5, 9, 13, 17]) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}

// ---- public factory ----

/**
 * Create a settle-after-move letter segmenter.
 * @param {{moveThr?: number, stillThr?: number, minConf?: number}} [opts]
 *   moveThr/stillThr in hand-spans of travel over WIN_MS; minConf = lowest
 *   prediction confidence (0..1) allowed to vote
 * @returns {{push: (landmarks: ({x: number, y: number}[] | null),
 *   prediction: ({label: string, confidence: number} | null), now: number) => void,
 *   read: () => ({letter: string, conf: number} | null),
 *   metrics: () => object, reset: () => void, readonly state: string}}
 */
export function createTransitionMatcher(opts = {}) {
  const moveThr = opts.moveThr ?? 0.55; // span-units of tracked-point travel over WIN_MS
  const stillThr = opts.stillThr ?? 0.27; // below this = still
  const minConf = opts.minConf ?? 0.6;

  let buf = []; // { t, pts:[[x,y]×TIPS], span }
  let state = "moving"; // "moving" | "settling" | "settled"
  let settledAt = 0;
  let movedSince = true; // has there been a real move since the last commit?
  let heldLetter = null; // last committed letter
  let votes = []; // { label, conf } during the current settle
  let pending = null; // {letter, conf} to hand back on the next read()
  // where the hand was when tracking dropped out, and whether it had moved
  // since its last commit then. A brief dropout with the hand back in the
  // same place is NOT a move — it used to re-commit the letter being held
  // ("LL" from one held L, LAB-039). A real double letter bounces/slides.
  let gap = null; // { t, pts, span, movedSince }
  const GAP_SAME_MS = 700;
  let sameAfterGap = false; // refilling the window after such a dropout

  // How far the tracked points moved across the trailing WIN_MS, in span-units:
  // each point's straight-line displacement from the oldest buffered frame to
  // the newest, averaged over the points and divided by the mean hand span.
  function travel() {
    // Until the window actually spans most of WIN_MS, motion is unknown —
    // treat it as MOVING. (Returning 0 here made a hand that just entered
    // the frame read as "still" and commit whatever shape it arrived in
    // ~115ms later — 2026-09-24 live QA: "too many accidental spellings".)
    if (buf.length < 2 || buf.at(-1).t - buf[0].t < WIN_MS * 0.75) return Infinity;
    const a = buf[0], b = buf.at(-1);
    let d = 0;
    for (let i = 0; i < TIPS.length; i++)
      d += Math.hypot(b.pts[i][0] - a.pts[i][0], b.pts[i][1] - a.pts[i][1]);
    return d / (TIPS.length * ((a.span + b.span) / 2));
  }

  return {
    get state() { return state; },

    reset() {
      buf = []; state = "moving"; movedSince = true;
      heldLetter = null; votes = []; pending = null; gap = null; sameAfterGap = false;
    },

    push(landmarks, prediction, now) {
      if (!landmarks || landmarks.length < 21) {
        // lost hand — a gap counts as a move, so the next letter (even a repeat) commits
        const lastF = buf.at(-1);
        if (lastF && now - lastF.t > 200) {
          gap = { t: lastF.t, pts: lastF.pts, span: lastF.span, movedSince };
          buf = []; movedSince = true; state = "moving";
        }
        return;
      }
      const span = spanOf(landmarks);
      if (gap) {
        // first frame back: same spot soon after -> the dropout wasn't a move
        const g = gap;
        gap = null;
        let d = 0;
        for (let i = 0; i < TIPS.length; i++)
          d += Math.hypot(landmarks[TIPS[i]].x - g.pts[i][0], landmarks[TIPS[i]].y - g.pts[i][1]);
        if (now - g.t < GAP_SAME_MS && d / (TIPS.length * ((g.span + span) / 2)) < moveThr) {
          movedSince = g.movedSince;
          sameAfterGap = true;
        }
      }
      buf.push({ t: now, span, pts: TIPS.map((j) => [landmarks[j].x, landmarks[j].y]) });
      while (buf.length && now - buf[0].t > WIN_MS) buf.shift();

      const v = travel();
      // the refilling window reads "unknown" (Infinity) — that's not a move
      // when the hand came back where it was
      if (Number.isFinite(v)) sameAfterGap = false;

      if (v >= moveThr) {
        state = "moving";
        if (!sameAfterGap) movedSince = true;
        votes = [];
        return;
      }

      if (v <= stillThr) {
        if (state === "moving") { state = "settling"; settledAt = now; votes = []; }
        // (only while settling — once settled, votes used to keep growing
        // ~30/s for as long as a hand stayed still)
        if (state === "settling" && prediction && prediction.label && (prediction.confidence ?? 0) >= minConf) {
          votes.push({ label: prediction.label, conf: prediction.confidence });
        }
        if (state === "settling" && now - settledAt >= SETTLE_MS && votes.length >= MIN_VOTES) {
          // majority letter across the settle window + its mean confidence
          const tally = {};
          for (const x of votes) tally[x.label] = (tally[x.label] || 0) + 1;
          const letter = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
          const conf =
            votes.filter((x) => x.label === letter).reduce((s, x) => s + x.conf, 0) /
            tally[letter];
          // the winner must clearly dominate the settle — one lucky vote
          // among mixed ones is a transitional shape, not a letter
          const clear = tally[letter] / votes.length >= MIN_SHARE;
          if (clear && (letter !== heldLetter || movedSince)) {
            pending = { letter, conf: +conf.toFixed(3) };
            heldLetter = letter;
            movedSince = false;
          }
          state = "settled";
        }
      }
      // between stillThr and moveThr = drifting; hold current state, keep voting
      else if (state === "settling" && prediction && prediction.label &&
               (prediction.confidence ?? 0) >= minConf) {
        votes.push({ label: prediction.label, conf: prediction.confidence });
      }
    },

    // one-shot: returns {letter, conf} the frame a letter is committed, else null
    read() {
      const p = pending;
      pending = null;
      return p;
    },

    metrics() {
      return { state, travel: +travel().toFixed(2), moveThr, stillThr, held: heldLetter };
    },
  };
}
