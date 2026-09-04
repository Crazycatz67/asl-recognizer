// Continuous fingerspelling -> text. Consumes the per-frame recogniser state
// (a settled letter, a completed J/Z stroke, whether the hand moved) and grows
// a transcript the way someone would read it: one letter per held shape, a
// space when the signer pauses, and repeats only when the hand clearly leaves
// the shape and comes back.
//
//   const sp = createSpeller();
//   const { text, pending, event } = sp.feed({ holding, letter, stroke, handPresent, moved, now });
//     holding     - a static letter is held steady RIGHT NOW (stabilizer settled)
//     letter      - which letter that is (only read when `holding`)
//     stroke      - "J" | "Z" | null, a motion letter completed this frame
//     handPresent - is a hand in frame at all
//     moved       - has the hand shifted notably since the last commit
//     now         - performance.now()
//     event       - "letter" | "space" | null  (fires once, for sound/haptics)
//   sp.text / sp.space() / sp.backspace() / sp.clear()

export function createSpeller({
  gapMs = 350, // hand must be off a letter this long before the SAME letter repeats
  spaceMs = 1100, // no letter being formed this long -> insert a space
  maxLen = 240, // safety cap on transcript length
} = {}) {
  let text = "";
  let last = null; // last committed letter (spaces don't count)
  let armed = true; // may a repeat of `last` commit right now?
  let offSince = 0; // when "not holding a letter" began (0 = holding one now)
  let spaced = true; // has the current pause already produced a space? (true => no leading space)

  const isLetter = (s) => typeof s === "string" && /^[A-Z]$/.test(s);

  function commit(letter) {
    if (!isLetter(letter) || text.length >= maxLen) return null;
    text += letter;
    last = letter;
    armed = false;
    spaced = false; // a fresh letter started; the next pause may space again
    return "letter";
  }

  return {
    get text() {
      return text;
    },
    get last() {
      return last;
    },

    feed({ holding, letter, stroke, handPresent, moved, now }) {
      let event = null;

      // a notable hand shift since the last commit counts as "left the shape"
      if (moved) armed = true;

      // motion letters (J/Z): one-shot, with an inherent gap around the stroke
      if (stroke === "J" || stroke === "Z") {
        armed = true;
        event = commit(stroke) || event;
        offSince = now || 1;
        return { text, pending: null, event };
      }

      if (holding && isLetter(letter)) {
        // a different letter needs no gap; the same one needs `armed`
        if (letter !== last || armed) event = commit(letter) || event;
        offSince = 0;
      } else {
        if (offSince === 0) offSince = now || 1;
        if (now - offSince >= gapMs) armed = true;
        if (
          now - offSince >= spaceMs &&
          !spaced &&
          text.length > 0 &&
          !text.endsWith(" ")
        ) {
          text += " ";
          spaced = true;
          last = null; // new word — don't block a repeated first letter
          event = "space";
        }
        // ignore `handPresent` beyond this: a pause is a pause whether the hand
        // is lowered or just resting between shapes
      }

      const pending =
        holding && isLetter(letter) && letter !== last ? letter : null;
      return { text, pending, event };
    },

    space() {
      if (!text.length || text.endsWith(" ") || text.length >= maxLen) return false;
      text += " ";
      last = null;
      spaced = true;
      return true;
    },
    // drop a chunk of text in as-is (paste). Keeps within maxLen.
    insert(str) {
      if (typeof str !== "string" || !str) return false;
      const room = maxLen - text.length;
      if (room <= 0) return false;
      text += str.slice(0, room);
      last = /[A-Z]$/.test(text) ? text.at(-1) : null;
      armed = true;
      spaced = text.endsWith(" ");
      return true;
    },
    backspace() {
      if (!text.length) return false;
      text = text.slice(0, -1);
      last = /[A-Z]$/.test(text) ? text.at(-1) : null;
      armed = true;
      spaced = text.endsWith(" ") || text.length === 0;
      return true;
    },
    clear() {
      if (!text.length) return false;
      text = "";
      last = null;
      armed = true;
      spaced = true;
      return true;
    },
  };
}
