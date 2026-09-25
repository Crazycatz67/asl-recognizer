// =============================================================================
// js/leaderboard.js — Challenge scoreboard kept on this device (Engine)
// =============================================================================
// WHAT: Top-10 scores per board ("solo-normal", "solo-hard", "race", "turns"),
//   each with 3-letter initials, stored in localStorage (the live site is
//   static GitHub Pages — no server, so the board is per device; everyone at
//   one laptop shares it). Owner request 2026-09-25.
//
// PUBLIC API:
//   createLeaderboard({ storage?, max? }) -> {
//     top(board)                     -> [{ name, score, round, streak, date }] best first
//     qualifies(board, score)        -> true if the score would make the top list
//     add(board, entry)              -> 1-based rank, or 0 if it didn't place
//     clear(board)
//   }
//   cleanInitials(s)                 -> "ABC" (A-Z only, max 3, default "???")

export const cleanInitials = (s) => (String(s || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3) || "???");

export function createLeaderboard({ storage = globalThis.localStorage, max = 10 } = {}) {
  const KEY = "asl-leaderboard";
  const load = () => {
    try {
      const d = JSON.parse(storage?.getItem(KEY) || "{}");
      return d && typeof d === "object" ? d : {};
    } catch {
      return {};
    }
  };
  const save = (d) => {
    try {
      storage?.setItem(KEY, JSON.stringify(d));
    } catch {}
  };
  const sorted = (rows) =>
    rows
      .filter((r) => r && Number.isFinite(r.score))
      .sort((a, b) => b.score - a.score || (b.round || 0) - (a.round || 0) || String(a.date).localeCompare(String(b.date)));
  return {
    top(board) {
      return sorted(load()[board] || []).slice(0, max);
    },
    qualifies(board, score) {
      if (!(score > 0)) return false;
      const rows = this.top(board);
      return rows.length < max || score > rows[rows.length - 1].score;
    },
    add(board, entry) {
      if (!this.qualifies(board, entry?.score)) return 0;
      const d = load();
      const row = {
        name: cleanInitials(entry.name),
        score: Math.round(entry.score),
        round: entry.round | 0,
        streak: entry.streak | 0,
        date: entry.date || "",
      };
      const rows = sorted([...(d[board] || []), row]).slice(0, max);
      d[board] = rows;
      save(d);
      return rows.indexOf(row) + 1 || 0;
    },
    clear(board) {
      const d = load();
      delete d[board];
      save(d);
    },
  };
}
