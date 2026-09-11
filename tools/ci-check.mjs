// Free, dependency-free CI checks — plain Node, no npm install, no package.json.
// Runs in GitHub Actions on every push/PR (see .github/workflows/ci.yml) and
// locally via: node tools/ci-check.mjs
//
// Deliberately NOT a replacement for tools/selftest.html (164 browser-based
// unit + integration checks) — that still needs a browser and stays a manual
// pre-push step. This catches a different, cheaper class of bug: things that
// are correct in isolation but drift out of sync with each other.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;

function check(name, fn) {
  try {
    const detail = fn();
    console.log(`PASS ${name}${detail ? " — " + detail : ""}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${name} — ${err.message}`);
  }
}

// ---- 1. every JS file at least parses -------------------------------
// `node --check` parses without executing, so this is safe even for modules
// that call fetch() at import time (dataset.js, heads.js).
{
  const jsFiles = fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js"));
  for (const f of jsFiles) {
    check(`syntax: js/${f}`, () => {
      execFileSync(process.execPath, ["--check", path.join(ROOT, "js", f)], { stdio: "pipe" });
      return null;
    });
  }
  check("syntax: sw.js", () => {
    execFileSync(process.execPath, ["--check", path.join(ROOT, "sw.js")], { stdio: "pipe" });
    return null;
  });
}

// ---- 2. sw.js CORE precache list matches the real file tree ---------
check("sw.js: CORE list matches js/ directory", () => {
  const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const coreMatch = swSrc.match(/const CORE = \[([\s\S]*?)\];/);
  if (!coreMatch) throw new Error("couldn't find `const CORE = [...]` in sw.js");
  const corePaths = [...coreMatch[1].matchAll(/"\.\/(js\/[a-zA-Z0-9_.]+\.js)"/g)].map((m) => m[1]);
  const coreSet = new Set(corePaths);

  const actualJs = fs
    .readdirSync(path.join(ROOT, "js"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => `js/${f}`);

  const missingFromCore = actualJs.filter((f) => !coreSet.has(f));
  const staleInCore = corePaths.filter((f) => !fs.existsSync(path.join(ROOT, f)));

  if (missingFromCore.length) {
    throw new Error(
      `js/ has files sw.js won't precache (won't work offline until added): ${missingFromCore.join(", ")}`
    );
  }
  if (staleInCore.length) {
    throw new Error(`sw.js precaches files that no longer exist: ${staleInCore.join(", ")}`);
  }
  return `${corePaths.length} files, all accounted for`;
});

// ---- 3. every reference photo the app can request actually exists ---
check("assets/reference: all 26 letter photos exist", () => {
  const missing = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    .split("")
    .filter((L) => !fs.existsSync(path.join(ROOT, "assets", "reference", `${L}.jpg`)));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return "26/26 present";
});

// ---- 4. dataset.json is well-formed and internally consistent -------
check("data/dataset.json: well-formed", () => {
  const raw = fs.readFileSync(path.join(ROOT, "data", "dataset.json"), "utf8");
  const data = JSON.parse(raw);
  if (!Array.isArray(data.samples) || data.samples.length === 0) {
    throw new Error("no samples array");
  }
  const len = data.samples[0]?.v?.length;
  const bad = data.samples.find((s) => !s.label || !Array.isArray(s.v) || s.v.length !== len);
  if (bad) throw new Error(`a sample doesn't match vectorLength ${len}`);
  const labels = new Set(data.samples.map((s) => s.label));
  return `${data.samples.length} samples, ${labels.size} labels, vlen ${len}`;
});

// ---- 5. fs_sequences.json is well-formed -----------------------------
check("data/fs_sequences.json: well-formed", () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "fs_sequences.json"), "utf8"));
  if (!Array.isArray(data.sequences) || data.sequences.length === 0) {
    throw new Error("no sequences array");
  }
  const bad = data.sequences.find((s) => !s.phrase || !Array.isArray(s.frames));
  if (bad) throw new Error("a sequence is missing phrase/frames");
  return `${data.sequences.length} sequences`;
});

// ---- 6. every practice-words category is non-empty -------------------
check("data/practice-words.json: no empty categories", () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "practice-words.json"), "utf8"));
  const categories = Object.entries(data).filter(([k]) => !k.startsWith("_")); // _note etc. are metadata
  const empty = categories.filter(([, words]) => !Array.isArray(words) || words.length === 0);
  if (empty.length) throw new Error(`empty categories: ${empty.map(([k]) => k).join(", ")}`);
  return `${categories.length} categories`;
});

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
