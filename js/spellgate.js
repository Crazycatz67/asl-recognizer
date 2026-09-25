// =============================================================================
// js/spellgate.js — Spell mode's "circle lock" letter gate (Engine, DOM-free)
// =============================================================================
// WHAT: Decides WHEN a letter enters the Spell transcript, and when a word
//   ends. It is the timing brain behind Spell's default input (owner request
//   2026-09-25: "a circle confirmation lock on each letter just like in the
//   skeletal overlay in practice ... if I sign H and while the circle is
//   still active I sign I it adds HI ... once the circle goes away that's a
//   space").
//
//   1. CONFIRM RING. A letter enters only after the SAME recognised letter
//      has been held for `confirmMs` of steady, confident frames. The ring
//      (progress 0..1) fills while that happens. A few bad frames (a
//      low-confidence dip, a one-frame look-alike flicker, a tracking blip)
//      only PAUSE the ring; `graceMs` of them in a row RESETS it, and a
//      different letter then starts its own ring. A hand that is visibly
//      moving (wrist travel > steadySpans per 200 ms) pauses the ring too.
//   2. WORD WINDOW. Each confirm opens (or restarts) a countdown of
//      `windowMs` (windowFrac 1 -> 0). A letter confirmed inside it joins the
//      current word. When it runs out, `space` fires once: the caller commits
//      the word and a space. While a new ring is actively charging the
//      window is frozen, so a letter that started in time is never split
//      off into a new word.
//   3. NO REPEATS WITHOUT A RELEASE. The confirmed letter is "held": holding
//      it (or coming back to it after a tracking blip in the same spot)
//      never re-enters it. It is released by: `releaseMs` of the hand
//      showing something else (another shape, or a rejected in-between
//      hand), the hand leaving for `leaveMs`, or a visible move — the
//      wrist going unsteady (a quick bounce) or sliding `releaseSpans`
//      hand-spans from where the letter was confirmed (the doubled-letter
//      bounce). After a release the same letter needs a
//      full new ring, so HELLO's second L is deliberate.
//   4. J / Z are traced strokes (js/motion.js): they confirm on stroke
//      completion, no ring. A stroke that follows its own start letter
//      (J after I, Z after D) confirmed within `strokeReplaceMs` REPLACES it
//      (`replace: true`) — holding the I to begin a J rings in an I first.
//
// PIPELINE (Spell, default input): webcam → MediaPipe → onefilter →
//   normalize → kNN → heads → [spellgate.js] → speller.addLetter() /
//   replaceLast() / space(). main.js only wires it and draws the rings
//   (js/handfx.js). Fluid mode (transition.js) is the opt-in alternative.
//
// PUBLIC API:
//   const g = createSpellGate(opts?);           // opts override SPELL_GATE
//   const s = g.feed({ now, letter, conf, stroke, pos });
//     now     performance.now() ms
//     letter  the recogniser's label this frame, or null (no hand / rejected)
//     conf    its confidence 0..1 (kNN vote share)
//     stroke  "J" | "Z" | null — a traced motion letter completed this frame
//     pos     { x, y, span } wrist position + hand span (same units), or
//             null when there is no hand. Drives steadiness + move-release.
//   s = { confirm, replace, space, progress, candidate, windowFrac, inWord,
//         held, state }
//     confirm     letter entered this frame (or null)
//     replace     that confirm replaces the previous letter (J over I)
//     space       the word window just ran out -> commit word + space
//     progress    0..1 ring fill for `candidate`
//     windowFrac  1..0 remaining word window (0 = no open word)
//     held        the letter that needs a release before it can repeat
//     state       "idle" | "charging" | "held" (for captions)
//   g.reset()       forget everything (mode switch, clear)
//   g.closeWord()   end the open word without a `space` event (manual Space,
//                   swipe-delete) — the next letter starts a new word
//
// UNITS: ms throughout; pos in any consistent frame units, distances are
//   divided by pos.span so thresholds are in hand-spans (distance-free).

export const SPELL_GATE = {
  confirmMs: 650, // steady hold that fills the ring
  windowMs: 2200, // word window after a confirm
  minConf: 0.8, // kNN vote share a frame needs to charge the ring (4 of 5)
  graceMs: 300, // consecutive bad frames that reset (not just pause) the ring (a 110-200 ms tracking blip must only pause it: 100 ms cost 13 pts on steady holds in the lab)
  releaseMs: 250, // showing something else this long releases the held letter
  leaveMs: 700, // hand gone this long releases it too (a blip isn't a release)
  releaseSpans: 0.6, // wrist travel from the confirm spot that releases it
  steadySpans: 0.35, // wrist travel per 200 ms above which the ring pauses
  strokeReplaceMs: 1800, // J/Z replaces its start letter confirmed this recently
  strokeRepeatMs: 1500, // the same J/Z again this soon is the same stroke's tail
};

// the handshape each motion letter starts from (kept in step with speller.js)
export const GATE_STROKE_START = { J: "I", Z: "D" };

export function createSpellGate(opts = {}) {
  const o = { ...SPELL_GATE, ...opts };
  let lastT = null;
  let cand = null; // letter charging the ring
  let charge = 0; // ms of steady, confident hold accumulated for cand
  let badSince = 0; // start of the current run of bad frames (0 = none)
  let held = null; // last confirmed letter, blocked until released
  let heldAlt = null; // a stroke's start letter, blocked with it
  let anchor = null; // pos at the confirm
  let otherSince = 0; // start of "showing something other than held"
  let goneSince = 0; // start of "no hand"
  let lastConfirm = null;
  let lastConfirmAt = -Infinity;
  let windowStart = null; // null = no open word
  let hist = []; // { t, x, y, span } for steadiness

  const release = () => { held = null; heldAlt = null; anchor = null; otherSince = 0; goneSince = 0; };
  const isHeld = (L) => L != null && (L === held || L === heldAlt);

  function steadyNow(now, pos) {
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !(pos.span > 0)) { hist = []; return false; }
    hist.push({ t: now, x: pos.x, y: pos.y, span: pos.span });
    while (hist.length > 1 && now - hist[0].t > 200) hist.shift();
    if (hist.length < 2) return true; // no evidence of motion yet
    const a = hist[0], b = hist.at(-1);
    return Math.hypot(b.x - a.x, b.y - a.y) / ((a.span + b.span) / 2) <= o.steadySpans;
  }

  function doConfirm(L, now, pos) {
    lastConfirm = L;
    lastConfirmAt = now;
    windowStart = now;
    cand = null;
    charge = 0;
    badSince = 0;
    held = L;
    heldAlt = null;
    anchor = pos && pos.span > 0 ? { x: pos.x, y: pos.y, span: pos.span } : null;
    otherSince = 0;
    goneSince = 0;
  }

  function snapshot(extra) {
    const windowFrac = windowStart == null ? 0 : Math.max(0, 1 - (lastT - windowStart) / o.windowMs);
    const progress = cand ? Math.min(1, charge / o.confirmMs) : 0;
    return {
      confirm: null, replace: false, space: false,
      progress, candidate: cand, windowFrac, inWord: windowStart != null, held,
      state: cand && progress > 0 ? "charging" : held ? "held" : "idle",
      ...extra,
    };
  }

  return {
    get held() { return held; },
    get inWord() { return windowStart != null; },

    reset() {
      lastT = null; cand = null; charge = 0; badSince = 0; release();
      lastConfirm = null; lastConfirmAt = -Infinity; windowStart = null; hist = [];
    },

    closeWord() {
      windowStart = null;
    },

    feed({ now, letter = null, conf = 0, stroke = null, pos = null } = {}) {
      if (!Number.isFinite(now)) return snapshot({});
      // clamp dt: a stalled tab must not dump seconds of charge in one frame
      const dt = lastT == null ? 0 : Math.max(0, Math.min(100, now - lastT));
      lastT = lastT == null ? now : Math.max(lastT, now);
      const L = typeof letter === "string" && /^[A-Z]$/.test(letter) ? letter : null;
      const steady = steadyNow(now, pos);

      // ---- motion letters: confirm on stroke completion, no ring ----
      // (the tail of one long stroke can match again once motion.js's
      // cooldown ends — the same letter needs strokeRepeatMs between strokes)
      if ((stroke === "J" || stroke === "Z") && !(stroke === lastConfirm && now - lastConfirmAt < o.strokeRepeatMs)) {
        const start = GATE_STROKE_START[stroke];
        const replace = windowStart != null && lastConfirm === start && now - lastConfirmAt < o.strokeReplaceMs;
        doConfirm(stroke, now, pos);
        heldAlt = start; // the hand ends near its start shape — don't ring that in next
        anchor = null; // ...and only a shape change or leaving releases a stroke
        return snapshot({ confirm: stroke, replace });
      }

      // ---- release of the held letter ----
      if (held) {
        if (!pos) {
          otherSince = 0;
          if (!goneSince) goneSince = now;
          if (now - goneSince >= o.leaveMs) release();
        } else {
          goneSince = 0;
          // a static letter is released by a visible move: a quick bounce
          // (the hand goes unsteady) or a slow slide past releaseSpans. Not
          // a stroke — its own tail and un-twist are motion too.
          if (anchor && (!steady || Math.hypot(pos.x - anchor.x, pos.y - anchor.y) / ((anchor.span + pos.span) / 2) >= o.releaseSpans)) {
            release();
          } else if (!isHeld(L)) {
            if (!otherSince) otherSince = now;
            if (now - otherSince >= o.releaseMs) release();
          } else {
            otherSince = 0;
          }
        }
      }

      // ---- the confirm ring ----
      const valid = L && (conf ?? 0) >= o.minConf && !isHeld(L);
      if (valid && (L === cand || !cand || charge < o.graceMs)) {
        // same letter (or a fresh / barely-started ring): charge it
        if (L !== cand) { cand = L; charge = 0; }
        badSince = 0;
        if (steady) charge += dt;
        if (charge >= o.confirmMs) {
          doConfirm(cand, now, pos);
          return snapshot({ confirm: L });
        }
      } else {
        // bad frame: pause; a run of them longer than graceMs resets the ring
        if (!badSince) badSince = now;
        if (now - badSince >= o.graceMs) {
          cand = null; charge = 0;
          // a different letter that outlasted the grace starts its own ring
          if (valid) { cand = L; badSince = 0; }
        }
        if (isHeld(L)) { cand = null; charge = 0; } // back on the held letter
      }

      // ---- the word window ----
      let space = false;
      if (windowStart != null) {
        // an actively charging ring freezes the countdown
        if (cand && charge >= 120) windowStart = Math.min(now, windowStart + dt);
        if (now - windowStart >= o.windowMs) { windowStart = null; space = true; }
      }
      return snapshot({ space });
    },
  };
}
