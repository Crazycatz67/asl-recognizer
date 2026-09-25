// =============================================================================
// js/achievements.js — achievements, records and unlockable ink themes (Engine)
// =============================================================================
// WHAT: the app's long-term reward memory. main.js reports what happened
//   (a letter landed, an A->Z run finished, a Challenge ended, a mode was
//   opened, ...) with record(event, data); this module keeps counters and
//   personal records, decides which achievements that unlocked, and which
//   Home-page ink themes those achievements open up.
//   Owner request (2026-09-25): "achievements ... reflect on the home page ...
//   more colour and fun effects unlocked when you complete A->Z or other
//   courses ... achievements for using each mode or doing certain tests ...
//   and even highscores".
//
// PURE: no DOM. Storage is injected (localStorage in the app, a Map-backed
//   stub in tests), like js/leaderboard.js. One key: "asl-pref-achievements"
//   (?fresh clears every asl-* key). Corrupt / missing data starts fresh.
//
// PUBLIC API:
//   const a = createAchievements({ storage, now, masteryAt });
//   a.sync({ stats })            // adopt existing per-letter stats (unlocks
//                                // what was already earned, no celebration)
//   a.record(event, data) -> [achievement...]   // newly unlocked, in order
//     events: letter {L, done, ms} · run {kind:"az"|"review", skipped, ms}
//             mode {name} · challenge {score, difficulty, round, maxMult}
//             versus {mode, won} · spellWord {word} · drill {done}
//             read {streak} · tier {index, complete} · day {streak}
//   a.list() -> [{...achievement, unlocked: ts|0}]   (table order)
//   a.records -> { fastestAz, fastestLetter, bestRead, bestDay, bestDrill,
//                  bestMult, azRuns, words, raceWins, turnsWins }
//   a.letters -> { learned, mastered, map: {L: 0|1|2} }
//   a.themes() -> [{...theme, unlocked: bool}] · a.theme · a.setTheme(id)
//   a.takeUnseen() -> [theme...]  // newly unlocked themes not yet shown on Home
//   ACHIEVEMENTS, THEMES, KEY

export const KEY = "asl-pref-achievements";
const ALL = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MODES = ["practice", "challenge", "spell", "read"];

const learned = (s) => Object.values(s.letters).filter((d) => d >= 1).length;
const mastered = (s) => Object.values(s.letters).filter((d) => d >= s.masteryAt).length;

// id · group · icon · name · desc (the goal, shown while locked) · check(state)
export const ACHIEVEMENTS = [
  { id: "first-sign", group: "Letters", icon: "✋", name: "First Sign", desc: "Sign your first letter", check: (s) => learned(s) >= 1 },
  { id: "five-down", group: "Letters", icon: "🖐", name: "Five Down", desc: "Learn 5 letters", check: (s) => learned(s) >= 5 },
  { id: "half-alphabet", group: "Letters", icon: "🌗", name: "Halfway There", desc: "Learn 13 letters", check: (s) => learned(s) >= 13 },
  { id: "all-26", group: "Letters", icon: "🔤", name: "Full Alphabet", desc: "Learn all 26 letters", check: (s) => learned(s) >= 26 },
  { id: "first-mastery", group: "Letters", icon: "⭐", name: "First Mastery", desc: "Master a letter (sign it 3 times)", check: (s) => mastered(s) >= 1 },
  { id: "master-13", group: "Letters", icon: "🌟", name: "Half Mastered", desc: "Master 13 letters", check: (s) => mastered(s) >= 13 },
  { id: "master-26", group: "Letters", icon: "👑", name: "Alphabet Master", desc: "Master all 26 letters", check: (s) => mastered(s) >= 26 },
  { id: "speedy", group: "Letters", icon: "⚡", name: "Quick Hands", desc: "Land a letter in under 1.5 s", check: (s) => s.records.fastestLetter > 0 && s.records.fastestLetter < 1500 },

  { id: "az-complete", group: "Runs", icon: "🏁", name: "A to Z", desc: "Finish an A→Z run", check: (s) => s.records.azRuns >= 1 },
  { id: "az-clean", group: "Runs", icon: "💎", name: "Clean Run", desc: "Finish an A→Z run with no skips", check: (s) => s.flags.azClean },
  { id: "az-fast", group: "Runs", icon: "🚀", name: "Speed Run", desc: "Finish an A→Z run in under 3 minutes", check: (s) => s.records.fastestAz > 0 && s.records.fastestAz < 180000 },
  { id: "review-done", group: "Runs", icon: "🔁", name: "Reviewer", desc: "Finish a Review run", check: (s) => s.counters.reviewRuns >= 1 },

  { id: "explorer", group: "Modes", icon: "🧭", name: "Explorer", desc: "Try Practice, Challenge, Spell and Read", check: (s) => MODES.every((m) => s.counters.modes[m]) },
  { id: "first-word", group: "Modes", icon: "✍️", name: "First Word", desc: "Spell your first word", check: (s) => s.records.words >= 1 },
  { id: "ten-words", group: "Modes", icon: "📝", name: "Wordsmith", desc: "Spell 10 words", check: (s) => s.records.words >= 10 },
  { id: "read-5", group: "Modes", icon: "👀", name: "Sharp Eyes", desc: "Read 5 words in a row", check: (s) => s.records.bestRead >= 5 },

  { id: "challenge-200", group: "Challenge", icon: "🎯", name: "On Target", desc: "Score 200 in Challenge", check: (s) => s.flags.best >= 200 },
  { id: "challenge-500", group: "Challenge", icon: "🔥", name: "On Fire", desc: "Score 500 in Challenge", check: (s) => s.flags.best >= 500 },
  { id: "hard-10", group: "Challenge", icon: "🛡", name: "Hard Survivor", desc: "Reach round 10 on Hard", check: (s) => s.flags.hardRound >= 10 },
  { id: "combo-4", group: "Challenge", icon: "✖️", name: "Max Combo", desc: "Reach a ×4 combo", check: (s) => s.records.bestMult >= 4 },

  { id: "race-win", group: "Two players", icon: "🏎", name: "Race Winner", desc: "Win a two-player Race", check: (s) => s.records.raceWins >= 1 },
  { id: "turns-win", group: "Two players", icon: "🤝", name: "Turn Taker", desc: "Win a Take-turns game", check: (s) => s.records.turnsWins >= 1 },

  { id: "day-3", group: "Habit", icon: "📅", name: "Three in a Row", desc: "Practise 3 days in a row", check: (s) => s.records.bestDay >= 3 },
  { id: "day-7", group: "Habit", icon: "🗓", name: "Week Streak", desc: "Practise 7 days in a row", check: (s) => s.records.bestDay >= 7 },

  { id: "course-2", group: "Course", icon: "📘", name: "Level 2", desc: "Unlock course level 2 (Read → course)", check: (s) => s.counters.tier >= 1 },
  { id: "course-3", group: "Course", icon: "📗", name: "Level 3", desc: "Unlock course level 3", check: (s) => s.counters.tier >= 2 },
  { id: "course-complete", group: "Course", icon: "🎓", name: "Graduate", desc: "Complete the whole course", check: (s) => s.flags.courseComplete },
];

// Home-page ink palettes. dye: fluid colours (the hero's DYE/INK), accent:
// CSS colour for learned tiles / chips. unlock: the achievement that opens it.
export const THEMES = [
  { id: "amber", name: "Amber", unlock: null, accent: "#fbbf24", dye: ["#fbbf24", "#e8a33a", "#b45309"] },
  { id: "aurora", name: "Aurora", unlock: "az-complete", accent: "#a78bfa", dye: ["#a78bfa", "#22d3ee", "#818cf8"] },
  { id: "ocean", name: "Ocean", unlock: "course-3", accent: "#2dd4bf", dye: ["#2dd4bf", "#38bdf8", "#0ea5e9"] },
  { id: "ember", name: "Ember", unlock: "challenge-500", accent: "#fb7185", dye: ["#f97316", "#ef4444", "#fb7185"] },
  { id: "gold", name: "Gold", unlock: "master-26", accent: "#ffc861", dye: ["#ffc861", "#fde68a", "#f59e0b"] },
];

function fresh(masteryAt) {
  return {
    v: 1,
    masteryAt,
    unlocked: {},
    letters: {},
    counters: { modes: {}, reviewRuns: 0, tier: 0 },
    records: { fastestAz: 0, fastestLetter: 0, bestRead: 0, bestDay: 0, bestDrill: 0, bestMult: 0, azRuns: 0, words: 0, raceWins: 0, turnsWins: 0 },
    flags: { azClean: false, best: 0, hardRound: 0, courseComplete: false },
    theme: "amber",
    unseen: [],
  };
}

const posInt = (v) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
const lower = (cur, v) => (posInt(v) && (!cur || v < cur) ? +v : cur); // a best time: smaller is better
const higher = (cur, v) => Math.max(cur || 0, posInt(v));

export function createAchievements({ storage = globalThis.localStorage, now = () => Date.now(), masteryAt = 3 } = {}) {
  let s = fresh(masteryAt);
  try {
    const raw = JSON.parse(storage?.getItem(KEY) || "null");
    if (raw && raw.v === 1) {
      const base = fresh(masteryAt);
      s = {
        ...base, ...raw, masteryAt,
        counters: { ...base.counters, ...raw.counters, modes: { ...(raw.counters?.modes || {}) } },
        records: { ...base.records, ...raw.records },
        flags: { ...base.flags, ...raw.flags },
        unlocked: { ...(raw.unlocked || {}) },
        letters: { ...(raw.letters || {}) },
        unseen: Array.isArray(raw.unseen) ? raw.unseen : [],
      };
      if (!THEMES.some((t) => t.id === s.theme)) s.theme = "amber";
    }
  } catch { s = fresh(masteryAt); } // corrupt data: start over rather than crash

  const save = () => { try { storage?.setItem(KEY, JSON.stringify(s)); } catch {} };

  // evaluate every locked achievement; unlock + theme bookkeeping
  function evaluate({ quiet = false } = {}) {
    const out = [];
    for (const a of ACHIEVEMENTS) {
      if (s.unlocked[a.id] || !a.check(s)) continue;
      s.unlocked[a.id] = now();
      const th = THEMES.find((t) => t.unlock === a.id);
      if (th) {
        s.theme = th.id; // newest unlocked palette becomes the Home ink
        if (!quiet) s.unseen.push(th.id);
      }
      out.push(th ? { ...a, theme: th } : { ...a });
    }
    return out;
  }

  const api = {
    // adopt what's already been earned (per-letter stats predate this module)
    sync({ stats = {} } = {}) {
      for (const L of ALL) {
        const d = posInt(stats[L]?.done);
        if (d > (s.letters[L] || 0)) s.letters[L] = d;
        s.records.fastestLetter = lower(s.records.fastestLetter, stats[L]?.bestMs);
      }
      const got = evaluate({ quiet: true });
      save();
      return got;
    },
    record(event, d = {}) {
      const r = s.records, c = s.counters, f = s.flags;
      switch (event) {
        case "letter":
          if (ALL.includes(d.L)) s.letters[d.L] = Math.max(s.letters[d.L] || 0, posInt(d.done));
          r.fastestLetter = lower(r.fastestLetter, d.ms);
          break;
        case "run":
          if (d.kind === "az") {
            r.azRuns++;
            if (!posInt(d.skipped)) { f.azClean = true; r.fastestAz = lower(r.fastestAz, d.ms); }
          } else if (d.kind === "review") c.reviewRuns++;
          break;
        case "mode":
          if (MODES.includes(d.name)) c.modes[d.name] = 1;
          break;
        case "challenge":
          f.best = higher(f.best, d.score);
          if (d.difficulty === "hard") f.hardRound = higher(f.hardRound, d.round);
          r.bestMult = higher(r.bestMult, d.maxMult);
          break;
        case "versus":
          if (d.won && d.mode === "race") r.raceWins++;
          if (d.won && d.mode === "turns") r.turnsWins++;
          break;
        case "spellWord":
          if (typeof d.word === "string" && d.word.trim()) r.words++;
          break;
        case "drill":
          r.bestDrill = higher(r.bestDrill, d.done);
          break;
        case "read":
          r.bestRead = higher(r.bestRead, d.streak);
          break;
        case "tier":
          c.tier = Math.max(c.tier, posInt(d.index));
          if (d.complete) f.courseComplete = true;
          break;
        case "day":
          r.bestDay = higher(r.bestDay, d.streak);
          break;
        default:
          return [];
      }
      const got = evaluate();
      save();
      return got;
    },
    list() { return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: s.unlocked[a.id] || 0 })); },
    get records() { return { ...s.records, bestChallenge: s.flags.best }; },
    get letters() {
      const map = {};
      for (const L of ALL) { const d = s.letters[L] || 0; map[L] = d >= s.masteryAt ? 2 : d >= 1 ? 1 : 0; }
      return { learned: learned(s), mastered: mastered(s), map };
    },
    get unlockedCount() { return Object.keys(s.unlocked).length; },
    isUnlocked(id) { return !!s.unlocked[id]; },
    themes() { return THEMES.map((t) => ({ ...t, unlocked: !t.unlock || !!s.unlocked[t.unlock] })); },
    get theme() { return THEMES.find((t) => t.id === s.theme) || THEMES[0]; },
    setTheme(id) {
      const t = THEMES.find((x) => x.id === id);
      if (!t || (t.unlock && !s.unlocked[t.unlock])) return false;
      s.theme = id;
      save();
      return true;
    },
    // themes unlocked since the Home page last showed them (shown once)
    takeUnseen() {
      const ids = s.unseen;
      s.unseen = [];
      if (ids.length) save();
      return ids.map((id) => THEMES.find((t) => t.id === id)).filter(Boolean);
    },
  };
  return api;
}
