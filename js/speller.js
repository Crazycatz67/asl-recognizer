// Continuous fingerspelling -> text, with a forgiving one-word buffer.
//
// Recognised letters land in `pending` — the word you're spelling right now,
// shown dimmed. They only drop into the real transcript (`text`) when you
// pause long enough (a word break) or tap Space. So a stray letter picked up
// while your hand was moving is cheap: it sits in `pending` and one wipe
// (clearPending) throws the whole half-formed word away — you don't chase
// individual mistakes with backspace.
//
//   const sp = createSpeller();
//   const { text, pending, event } = sp.feed({ holding, letter, stroke, handPresent, moved, now });
//     holding     - a static letter is held steady right now (stabilizer settled + hand still)
//     letter      - which letter that is (only read when `holding`)
//     stroke      - "J" | "Z" | null, a motion letter completed this frame
//     moved       - has the hand shifted notably since the last letter
//     now         - performance.now()
//     event       - "letter" | "word" | "full" | null (fires once, for sound/haptics —
//                   "full" means the 240-char cap blocked a letter, no mutation happened)
//   sp.text · sp.pending · sp.display · sp.space() · sp.backspace()
//   sp.clearPending() · sp.clear() · sp.insert(str)
//   sp.addLetter(L, conf, now) · sp.replaceLast(L, conf, now)   (pre-segmented input)

// the handshape each motion letter starts from, and how recently that letter
// must have landed for a finished stroke to replace it (see feed())
export const STROKE_START = { J: "I", Z: "D" };
const STROKE_REPLACE_MS = 1600;

export function createSpeller({
  // hand off a letter this long before the SAME letter can repeat. Was 320:
  // live QA ("keeps inputting letters every second") traced to a held letter
  // re-committing after any ~1/3 s classifier dip — a real double letter
  // (LL, OO) is a deliberate release/bounce, which `moved` also re-arms.
  gapMs = 700,
  // pause this long with a word in the buffer -> commit the word. Was 1000,
  // which also fired between letters for anyone spelling at a learner's pace,
  // playing the word-complete cue after every letter.
  acceptMs = 2000,
  maxLen = 240,
} = {}) {
  let text = ""; // committed words
  let pending = ""; // the word being spelled now (unconfirmed)
  let last = null; // last letter added to `pending`
  let armed = true; // may a repeat of `last` be added right now?
  let offSince = 0; // when "not forming a letter" began (0 = forming one now)
  let accepted = true; // has the current pause already committed the word?
  let lastAddAt = 0; // `now` of the last letter added via feed()
  let raw = []; // {letter, conf}[] — the uncorrected letter stream, for decode.js
  let rawWordStart = 0; // raw[] index where the current pending word began
  // one flag per `text` character: true = a signed letter that has a raw[]
  // entry (not a space or pasted text). Backspacing into the transcript pops
  // raw[] only for those, so the decoded/spoken sentence drops the letter
  // too — before, "CAT" + backspace showed "CA" but still said "CAT" and
  // raw[] grew forever (LAB-041/042).
  let fromRaw = [];

  const isLetter = (s) => typeof s === "string" && /^[A-Z]$/.test(s);
  const room = () => maxLen - text.length - pending.length;

  function add(letter, conf = 0.85, now = 0) {
    if (!isLetter(letter)) return null;
    // at the cap, silently dropping the letter (the old behavior) gives the
    // signer zero feedback — they keep spelling into a line that's already
    // stopped growing. Distinct from "not a letter" so the caller can tell
    // the difference and say something (see main.js's "Line full" toast).
    if (room() <= 0) return "full";
    pending += letter;
    raw.push({ letter, conf });
    last = letter;
    lastAddAt = now;
    armed = false;
    accepted = false;
    offSince = 0; // a letter was just formed — restart the word-break clock
    return "letter";
  }

  function flush() {
    if (!pending) return false;
    if (text && !text.endsWith(" ")) { text += " "; fromRaw.push(false); }
    text += pending;
    for (let i = 0; i < pending.length; i++) fromRaw.push(true);
    pending = "";
    rawWordStart = raw.length;
    last = null;
    armed = true;
    return true;
  }

  return {
    get text() {
      return text;
    },
    get pending() {
      return pending;
    },
    get display() {
      return text + (text && pending && !text.endsWith(" ") ? " " : "") + pending;
    },
    get last() {
      return last;
    },
    get raw() {
      return raw;
    },

    // append a letter that's already been segmented upstream (transition.js /
    // fluid mode). No dedupe here — the caller owns segmentation. `now`
    // (performance.now()) lets a J/Z stroke that follows replace its start
    // letter, same as the hold path — without it fluid mode spelled "IJ"
    // (lab issue LAB-040).
    addLetter(letter, conf, now = 0) {
      return add(letter, conf, now);
    },

    // swap the last letter of the word being spelled for another (a J/Z
    // stroke that finished right after its own start letter — see
    // js/spellgate.js). With no pending word it just adds the letter.
    replaceLast(letter, conf, now = 0) {
      if (!isLetter(letter)) return null;
      if (pending) {
        pending = pending.slice(0, -1);
        if (raw.length > rawWordStart) raw.pop();
      }
      return add(letter, conf, now);
    },

    feed({ holding, letter, stroke, moved, now }) {
      let event = null;
      if (moved) armed = true;

      // motion letters (J/Z): one-shot, an inherent pause around the stroke.
      // J starts from an I handshape (Z from a D-like point), and holding that
      // start shape can commit it as a letter a moment before the stroke
      // finishes — "IJ" instead of "J". A stroke right after its own start
      // letter replaces it.
      if (stroke === "J" || stroke === "Z") {
        armed = true;
        if (
          pending && last === STROKE_START[stroke] && now - lastAddAt < STROKE_REPLACE_MS
        ) {
          pending = pending.slice(0, -1);
          if (raw.length > rawWordStart) raw.pop();
        }
        event = add(stroke, 0.85, now) || event;
        offSince = now || 1;
        return { text, pending, event };
      }

      if (holding && isLetter(letter)) {
        if (letter !== last || armed) event = add(letter, 0.85, now) || event;
        offSince = 0;
      } else {
        if (offSince === 0) offSince = now || 1;
        if (now - offSince >= gapMs) armed = true;
        // a real pause with a word in the buffer -> commit it
        if (now - offSince >= acceptMs && !accepted && pending) {
          flush();
          accepted = true;
          event = "word";
        }
      }

      return { text, pending, event };
    },

    // manual word break: commit whatever's pending, keep a trailing space
    space() {
      const had = flush();
      if (text && !text.endsWith(" ") && room() > 0) { text += " "; fromRaw.push(false); }
      accepted = true;
      return had || true;
    },

    // paste: land the current word first, then drop the chunk in
    insert(str) {
      if (typeof str !== "string" || !str) return false;
      flush();
      const r = maxLen - text.length;
      if (r <= 0) return false;
      const add = str.slice(0, r);
      text += add;
      for (let i = 0; i < add.length; i++) fromRaw.push(false);
      last = null;
      armed = true;
      return true;
    },

    // fix one character — the word you're spelling first, then the transcript
    backspace() {
      if (pending) {
        pending = pending.slice(0, -1);
        if (raw.length > rawWordStart) raw.pop();
        last = pending ? pending.at(-1) : null;
        armed = true;
        return true;
      }
      if (text) {
        text = text.slice(0, -1);
        if (fromRaw.pop() && raw.length) raw.pop();
        rawWordStart = raw.length;
        return true;
      }
      return false;
    },

    // throw away the half-formed word (the swipe gesture maps here)
    clearPending() {
      if (!pending) return false;
      pending = "";
      raw.length = rawWordStart;
      last = null;
      armed = true;
      return true;
    },

    clear() {
      if (!text && !pending) return false;
      text = "";
      pending = "";
      raw = [];
      rawWordStart = 0;
      fromRaw = [];
      last = null;
      armed = true;
      accepted = true;
      return true;
    },
  };
}
