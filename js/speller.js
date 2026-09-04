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
//     event       - "letter" | "word" | null   (fires once, for sound/haptics)
//   sp.text · sp.pending · sp.display · sp.space() · sp.backspace()
//   sp.clearPending() · sp.clear() · sp.insert(str)

export function createSpeller({
  gapMs = 320, // hand off a letter this long before the SAME letter repeats
  acceptMs = 1000, // pause this long with a word in the buffer -> commit the word
  maxLen = 240,
} = {}) {
  let text = ""; // committed words
  let pending = ""; // the word being spelled now (unconfirmed)
  let last = null; // last letter added to `pending`
  let armed = true; // may a repeat of `last` be added right now?
  let offSince = 0; // when "not forming a letter" began (0 = forming one now)
  let accepted = true; // has the current pause already committed the word?
  let raw = []; // {letter, conf}[] — the uncorrected letter stream, for decode.js
  let rawWordStart = 0; // raw[] index where the current pending word began

  const isLetter = (s) => typeof s === "string" && /^[A-Z]$/.test(s);
  const room = () => maxLen - text.length - pending.length;

  function add(letter, conf = 0.85) {
    if (!isLetter(letter) || room() <= 0) return null;
    pending += letter;
    raw.push({ letter, conf });
    last = letter;
    armed = false;
    accepted = false;
    return "letter";
  }

  function flush() {
    if (!pending) return false;
    text += (text && !text.endsWith(" ") ? " " : "") + pending;
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
    // fluid mode). No dedupe here — the caller owns segmentation.
    addLetter(letter, conf) {
      return add(letter, conf);
    },

    feed({ holding, letter, stroke, moved, now }) {
      let event = null;
      if (moved) armed = true;

      // motion letters (J/Z): one-shot, an inherent pause around the stroke
      if (stroke === "J" || stroke === "Z") {
        armed = true;
        event = add(stroke) || event;
        offSince = now || 1;
        return { text, pending, event };
      }

      if (holding && isLetter(letter)) {
        if (letter !== last || armed) event = add(letter) || event;
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
      if (text && !text.endsWith(" ") && room() > 0) text += " ";
      accepted = true;
      return had || true;
    },

    // paste: land the current word first, then drop the chunk in
    insert(str) {
      if (typeof str !== "string" || !str) return false;
      flush();
      const r = maxLen - text.length;
      if (r <= 0) return false;
      text += str.slice(0, r);
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
      last = null;
      armed = true;
      accepted = true;
      return true;
    },
  };
}
