// =============================================================================
// js/decode.js — lexicon-constrained beam-search word decoder (Engine)
// =============================================================================
// WHAT: Turns a noisy per-letter stream (what the recogniser thought it saw,
//   with confidences) into the most probable sequence of real words, e.g.
//   "HELO WORLF" → "hello world". It knows which letters look alike in ASL
//   (M/N, D/O, …), so a known look-alike is a cheap correction and a random
//   swap is an expensive one.
//
// PIPELINE (Spell mode, fluid path): transition.js → speller.js (records
//   speller.raw: [{letter, conf}]) → [decode.js] → the "decoded" sentence row
//   (and speech). main.js re-decodes speller.raw at most every ~350 ms.
//
// PUBLIC API:
//   DEFAULT_CONFUSION                     hand-set look-alike floor {truth: {observed: p}}
//   mergeConfusion(measured, floor?)      per-pair max of measured matrix and the floor
//   buildLexicon(text | rows)             → { trie, logp(word), size }
//   createDecoder(lexicon, opts?)         → { decode, segment, collapse }
//
//   const lex = buildLexicon(wordFreqText);        // "word\tcount\n..." (lowercase)
//   const dec = createDecoder(lex);
//   dec.decode([{letter:"W",conf:0.8}, ...])  -> { text, words, raw, fallback? }
//   dec.segment("whatareyoudoing")            -> ["what","are","you","doing"]
//   dec.collapse(frames, thr?)                -> merged letter runs (below)
//
// UNITS: every score is a natural-log probability (sums = products); conf is
//   the recogniser's 0..1 confidence. The lexicon is data/words25k.txt.
//
// HOW IT WORKS:
// decode() runs a left-to-right beam search over the collapsed letter stream.
// Each hypothesis holds a position in the dictionary trie for the word it's
// currently spelling. At each observed letter it either (a) extends the word
// with some trie child — scored by how well that child matches what was
// observed, weighted by a confusion model so known mix-ups (M<->N, D<->O) are
// cheap — or (b) if it's sitting on a complete word, commits it (adding the
// word's log-frequency minus a per-word penalty) and starts the next word.
// One optional inserted letter per word recovers a dropped double. If the beam
// dead-ends (an out-of-vocabulary name), it falls back to segment().
// Digit runs (phone numbers, addresses) are passed through verbatim.
//
// GOTCHA: `decode()` also accepts a plain string (treated as letters at
//   conf 0.9) — handy in tests and tools/decode-lab.html.

// ---- confusion model ----

// ASL fingerspelling look-alikes: elevated P(observed | true). Symmetric-ish;
// unlisted pairs get EPS. This is the hand-set FLOOR — a measured matrix
// (data/confusion.json, from tools/test-knn.html) blends on top of it via
// mergeConfusion(), since posed data under-reports live confusion.
export const DEFAULT_CONFUSION = {
  m: { n: 0.5, s: 0.15 }, n: { m: 0.5, s: 0.12 },
  d: { o: 0.25, c: 0.18, f: 0.08 }, o: { d: 0.25, c: 0.2, e: 0.08 }, c: { o: 0.2, d: 0.15 },
  u: { v: 0.4, r: 0.12 }, v: { u: 0.4, k: 0.12 }, r: { u: 0.2, v: 0.12 },
  k: { v: 0.15, p: 0.3 }, p: { k: 0.3, q: 0.1 },
  a: { s: 0.25, t: 0.18, e: 0.15 }, s: { a: 0.22, t: 0.15, m: 0.1 },
  t: { a: 0.18, s: 0.12 }, e: { a: 0.12, o: 0.08 },
  g: { h: 0.35, q: 0.12 }, h: { g: 0.35 }, q: { g: 0.12, p: 0.1 },
  i: { j: 0.2, y: 0.12 }, y: { i: 0.12 }, j: { i: 0.2 },
  f: { d: 0.08 }, b: { f: 0.06 }, x: { r: 0.08 }, w: { v: 0.06 },
};
const EPS = 0.006; // P(observed | true) for any pair not listed above

// blend a measured confusion matrix over the hand-set floor: take the larger of
// the two per pair (measured leads where it has signal, the floor covers the
// rest — posed data under-reports live look-alikes).
/**
 * @param {Object<string, Object<string, number>> | null} measured  e.g. data/confusion.json
 *   (keys starting with "_" are metadata and skipped)
 * @param {Object<string, Object<string, number>>} [floor]  defaults to DEFAULT_CONFUSION
 * @returns {Object<string, Object<string, number>>} new merged map {truth: {observed: weight}}
 */
export function mergeConfusion(measured, floor = DEFAULT_CONFUSION) {
  const out = {};
  for (const src of [floor, measured || {}]) {
    for (const h in src) {
      if (h.startsWith("_")) continue;
      out[h] = out[h] || {};
      for (const o in src[h]) out[h][o] = Math.max(out[h][o] || 0, src[h][o]);
    }
  }
  return out;
}

// ---- lexicon (trie + unigram word probabilities) ----

/**
 * Build the dictionary trie and a unigram log-probability function.
 * @param {string | Array<[string, number|string]>} input  "word count" lines
 *   (whitespace-separated) or [word, count] rows; non a–z words are skipped
 * @returns {{trie: {c: Object, w: number}, logp: (w: string) => number, size: number}}
 *   trie nodes: c = children by letter, w = word count if a word ends here (else 0);
 *   logp(w) = ln P(w), with a length-penalised backoff for unknown words
 */
export function buildLexicon(input) {
  const rows =
    typeof input === "string"
      ? input.split("\n").map((l) => l.split(/\s+/)).filter((p) => p[0])
      : input;
  const trie = { c: {}, w: 0 };
  const count = new Map();
  let total = 0;
  for (const [word, n] of rows) {
    const w = String(word).toLowerCase();
    if (!/^[a-z]+$/.test(w)) continue;
    const freq = Number(n) || 1;
    count.set(w, (count.get(w) || 0) + freq);
    total += freq;
    let node = trie;
    for (const ch of w) node = node.c[ch] || (node.c[ch] = { c: {}, w: 0 });
    node.w = freq;
  }
  const logTotal = Math.log(total || 1);
  const logp = (w) =>
    count.has(w)
      ? Math.log(count.get(w)) - logTotal
      : Math.log(10) - logTotal - w.length * Math.log(26); // Norvig OOV backoff
  return { trie, logp, size: count.size };
}

// ---- decoder ----

/**
 * Create a beam-search decoder over a lexicon.
 * @param {ReturnType<typeof buildLexicon>} lexicon
 * @param {{confusion?: object, beamWidth?: number, wordPenalty?: number,
 *   insPenalty?: number, subBase?: number, minConf?: number}} [opts]
 *   penalties are log-prob costs; minConf drops observations below minConf+0.05
 * @returns {{decode: (input: ({letter: string, conf?: number}[] | string)) =>
 *   {text: string, words: string[], raw: string, fallback?: true},
 *   segment: (s: string) => string[], collapse: (frames: object[], thr?: number) => object[]}}
 */
export function createDecoder(lexicon, opts = {}) {
  const { trie, logp } = lexicon;
  const confuse = opts.confusion || DEFAULT_CONFUSION;
  const beamWidth = opts.beamWidth ?? 120;
  const wordPenalty = opts.wordPenalty ?? -2.5;
  const insPenalty = opts.insPenalty ?? -5.0;
  const subBase = opts.subBase ?? -1.6; // flat cost for any letter correction
  const minConf = opts.minConf ?? 0.4;

  // Emission score: ln P(observing letter o, at confidence c | true letter h).
  // A match scores ln(c); a mismatch pays subBase plus the look-alike weight,
  // so M-for-N costs far less than, say, B-for-N.
  const emit = (h, o, c) =>
    h === o
      ? Math.log(Math.max(c, 0.15))
      : subBase +
        Math.log(Math.max(1 - c, 0.03) * ((confuse[h] && confuse[h][o]) || EPS) * 0.5);

  // Merge consecutive repeats of the same letter into one observation (keeping
  // the highest conf). A below-`thr` or empty frame acts as a "blank"
  // separator, so the same letter either side of it is kept as two (a real
  // double like the LL in HELLO).
  function collapse(frames, thr = 0.5) {
    const out = [];
    let blank = true;
    for (const f of frames) {
      const L = String(f.letter || "").toLowerCase();
      if (!L || (f.conf ?? 1) < thr) { blank = true; continue; }
      const prev = out[out.length - 1];
      if (prev && prev.letter === L && !blank) prev.conf = Math.max(prev.conf, f.conf ?? 1);
      else { out.push({ letter: L, conf: f.conf ?? 1 }); blank = false; }
    }
    return out;
  }

  // expand every beam hypothesis by exactly one observed letter
  function advance(beam, o, c) {
    const out = [];
    for (const h of beam) {
      // states this hypothesis can be in *before* consuming the letter:
      //   itself, or (if it's on a complete word) the committed-then-restart state
      const bases = [h];
      if (h.node.w && h.cur) {
        bases.push({
          node: trie, cur: "", words: [...h.words, h.cur],
          score: h.score + logp(h.cur) + wordPenalty, ins: 0,
        });
      }
      for (const b of bases) {
        // (1) substitution: consume the letter as some trie child
        for (const ch in b.node.c) {
          out.push({
            node: b.node.c[ch], cur: b.cur + ch, words: b.words,
            score: b.score + emit(ch, o, c),
            ins: b.ins || 0,
          });
        }
        // (2) one inserted letter, then consume: recovers a dropped double/letter
        if ((b.ins || 0) < 1) {
          for (const ch1 in b.node.c) {
            const n1 = b.node.c[ch1];
            for (const ch2 in n1.c) {
              out.push({
                node: n1.c[ch2], cur: b.cur + ch1 + ch2, words: b.words,
                score: b.score + insPenalty + emit(ch2, o, c),
                ins: 1,
              });
            }
          }
        }
      }
    }
    out.sort((a, b) => b.score - a.score);
    // de-dup identical (cur, node) keeping the best. The key is (committed-word
    // count, current partial word, is-a-word): `cur` fixes the trie node, and
    // since the language model is unigram, two hypotheses that differ only in
    // earlier words can never be re-ranked later — the lower one is dropped.
    // (The per-word insertion budget `ins` is NOT in the key, so a used-up
    // hypothesis can shadow an equal-text one that still has its insertion.)
    const seen = new Set();
    const pruned = [];
    for (const h of out) {
      const k = h.words.length + "|" + h.cur + "|" + (h.node.w ? "w" : "");
      if (seen.has(k)) continue;
      seen.add(k);
      pruned.push(h);
      if (pruned.length >= beamWidth) break;
    }
    return pruned;
  }

  // beam-decode one alphabetic run
  function decodeRun(obs) {
    let beam = [{ node: trie, cur: "", words: [], score: 0, ins: 0 }];
    for (const f of obs) {
      beam = advance(beam, f.letter, f.conf);
      if (!beam.length) break;
    }
    let best = null;
    for (const h of beam) {
      let score = h.score, words = h.words;
      if (h.cur) {
        if (!h.node.w) continue;
        score += logp(h.cur) + wordPenalty;
        words = [...h.words, h.cur];
      }
      if (words.length && (!best || score > best.score)) best = { score, words };
    }
    return best ? best.words : null;
  }

  function decode(input) {
    const frames =
      Array.isArray(input) && input.length && typeof input[0] === "object"
        ? input
        : String(input).toLowerCase().split("").map((letter) => ({ letter, conf: 0.9 }));
    const obs = collapse(frames, minConf + 0.05);
    if (!obs.length) return { text: "", words: [], raw: "" };
    const raw = obs.map((f) => f.letter).join("");

    // split into alternating digit-runs (passed through verbatim — phone numbers,
    // addresses) and alphabetic runs (beam-decoded)
    const words = [];
    let anyFallback = false;
    let i = 0;
    while (i < obs.length) {
      const isDigit = /[0-9]/.test(obs[i].letter);
      let j = i;
      while (j < obs.length && /[0-9]/.test(obs[j].letter) === isDigit) j++;
      const run = obs.slice(i, j);
      if (isDigit) {
        words.push(run.map((f) => f.letter).join(""));
      } else {
        const w = decodeRun(run);
        if (w) words.push(...w);
        else { anyFallback = true; words.push(...segment(run.map((f) => f.letter).join(""))); }
      }
      i = j;
    }
    return { text: words.join(" "), words, raw, fallback: anyFallback || undefined };
  }

  // Norvig max-likelihood word split of an unspaced string.
  function segment(s) {
    s = String(s).toLowerCase().replace(/[^a-z]/g, "");
    const memo = new Map();
    const best = (i) => {
      if (i >= s.length) return { p: 0, words: [] };
      if (memo.has(i)) return memo.get(i);
      let top = { p: -Infinity, words: [] };
      for (let j = i + 1; j <= Math.min(s.length, i + 20); j++) {
        const rest = best(j);
        const p = logp(s.slice(i, j)) + rest.p;
        if (p > top.p) top = { p, words: [s.slice(i, j), ...rest.words] };
      }
      memo.set(i, top);
      return top;
    };
    return best(0).words;
  }

  return { decode, segment, collapse };
}
