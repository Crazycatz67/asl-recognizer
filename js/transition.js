// Rhythm-based letter segmentation for continuous fingerspelling.
//
// The stabiliser waits for a letter to be *held still* for N frames — which
// never happens at real signing speed, so Spell mode feels stuck. This watches
// the hand's motion instead: a letter is committed the moment the hand SETTLES
// after a MOVE. The move-between-settles requirement is also what lets doubled
// letters (the two L's in HELLO) register — you have to bounce between them.
//
//   const tr = createTransitionMatcher();
//   tr.push(landmarks, prediction, now);   // every frame; prediction = {label, confidence}
//   tr.read()                              // -> {letter, conf} once per settle, else null
//   tr.state / tr.metrics()                // "moving" | "settling" | "settled", + live numbers
//
// Emits the majority letter seen across the settled window, with its mean
// confidence — that averaged posterior is what feeds js/decode.js.

const WIN_MS = 110; // motion is measured over this trailing window
const SETTLE_MS = 90; // must be still this long after a move to commit
const TIPS = [0, 8, 12, 16]; // wrist + 3 fingertips — enough to catch a transition

function spanOf(lm) {
  const w = lm[0];
  let mx = 0, my = 0;
  for (const j of [5, 9, 13, 17]) { mx += lm[j].x; my += lm[j].y; }
  return Math.hypot(mx / 4 - w.x, my / 4 - w.y) || 1e-6;
}

export function createTransitionMatcher(opts = {}) {
  const moveThr = opts.moveThr ?? 0.55; // span-units of tracked-point travel over WIN_MS
  const stillThr = opts.stillThr ?? 0.30; // below this = still
  const minConf = opts.minConf ?? 0.5;

  let buf = []; // { t, pts:[[x,y]×TIPS], span }
  let state = "moving"; // "moving" | "settling" | "settled"
  let settledAt = 0;
  let movedSince = true; // has there been a real move since the last commit?
  let heldLetter = null; // last committed letter
  let voteFrom = 0; // when the current settling episode began collecting votes
  let votes = []; // { label, conf } during the current settle
  let pending = null; // {letter, conf} to hand back on the next read()

  // total travel of the tracked points across the trailing WIN_MS, in span-units
  function travel() {
    if (buf.length < 2) return 0;
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
      heldLetter = null; votes = []; pending = null;
    },

    push(landmarks, prediction, now) {
      if (!landmarks || landmarks.length < 21) {
        // lost hand — a gap counts as a move, so the next letter (even a repeat) commits
        if (now - (buf.at(-1)?.t ?? 0) > 200) { buf = []; movedSince = true; state = "moving"; }
        return;
      }
      const span = spanOf(landmarks);
      buf.push({ t: now, span, pts: TIPS.map((j) => [landmarks[j].x, landmarks[j].y]) });
      while (buf.length && now - buf[0].t > WIN_MS) buf.shift();

      const v = travel();

      if (v >= moveThr) {
        state = "moving";
        movedSince = true;
        votes = [];
        return;
      }

      if (v <= stillThr) {
        if (state === "moving") { state = "settling"; settledAt = now; voteFrom = now; votes = []; }
        if (prediction && prediction.label && (prediction.confidence ?? 0) >= minConf) {
          votes.push({ label: prediction.label, conf: prediction.confidence });
        }
        if (state === "settling" && now - settledAt >= SETTLE_MS && votes.length) {
          // majority letter across the settle window + its mean confidence
          const tally = {};
          for (const x of votes) tally[x.label] = (tally[x.label] || 0) + 1;
          const letter = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
          const conf =
            votes.filter((x) => x.label === letter).reduce((s, x) => s + x.conf, 0) /
            tally[letter];
          if (letter !== heldLetter || movedSince) {
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
