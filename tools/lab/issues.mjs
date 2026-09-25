// tools/lab/issues.mjs — the lab's stored issue list (docs/lab/issues.json +
// the readable docs/lab/ISSUES.md). Every agent records findings through this
// so the main session reads one format. Deduped by `key`: re-finding an issue
// updates its metric/lastSeen instead of adding a duplicate.
//   node tools/lab/issues.mjs            -> re-render ISSUES.md
//   import { upsertIssue } from "./issues.mjs"
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./lab-data.mjs";

const JSON_PATH = path.join(ROOT, "docs", "lab", "issues.json");
const MD_PATH = path.join(ROOT, "docs", "lab", "ISSUES.md");
export const SEVERITY = ["P0", "P1", "P2", "P3"]; // P0 wrong letters accepted / crash · P1 too strict / stuck · P2 polish · P3 idea
export const STATUS = ["open", "fixing", "fixed-offline", "needs-live", "wontfix"];

export function loadIssues() {
  try { return JSON.parse(fs.readFileSync(JSON_PATH, "utf8")); } catch { return { issues: [] }; }
}

export function upsertIssue(issue) {
  const req = ["key", "title", "severity", "foundBy", "repro"];
  for (const k of req) if (!issue[k]) throw new Error(`issue missing ${k}`);
  if (!SEVERITY.includes(issue.severity)) throw new Error(`bad severity ${issue.severity}`);
  const db = loadIssues();
  const now = new Date().toISOString().slice(0, 16);
  const existing = db.issues.find((i) => i.key === issue.key);
  if (existing) {
    const keepStatus = existing.status !== "open" && issue.status == null;
    Object.assign(existing, issue, { lastSeen: now, status: keepStatus ? existing.status : issue.status || existing.status });
  } else {
    db.issues.push({ id: `LAB-${String(db.issues.length + 1).padStart(3, "0")}`, status: "open", created: now, lastSeen: now, ...issue });
  }
  fs.mkdirSync(path.dirname(JSON_PATH), { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(db, null, 2) + "\n");
  renderMd(db);
  return db.issues.find((i) => i.key === issue.key);
}

export function renderMd(db = loadIssues()) {
  const rows = [...db.issues].sort((a, b) => a.severity.localeCompare(b.severity) || a.id.localeCompare(b.id));
  const lines = [
    "# Lab issues (generated — edit docs/lab/issues.json via tools/lab/issues.mjs)",
    "",
    "Severity: P0 wrong letters accepted / crash · P1 too strict / stuck state · P2 polish · P3 idea.",
    "Status: open · fixing · fixed-offline · needs-live (needs a real camera) · wontfix.",
    "",
    "| id | sev | status | title | metric | found by | repro |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((i) => `| ${i.id} | ${i.severity} | ${i.status} | ${i.title} | ${i.metric ?? ""} | ${i.foundBy} | \`${i.repro}\` |`),
    "",
  ];
  fs.writeFileSync(MD_PATH, lines.join("\n"));
}

if (process.argv[1] && process.argv[1].endsWith("issues.mjs")) renderMd();
