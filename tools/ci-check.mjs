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
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;

// async so a check can `await import(...)` — every call site below is
// `await`ed (harmless for plain sync checks too) so output stays ordered and
// `failures` is accurate by the time the summary prints.
async function check(name, fn) {
  try {
    const detail = await fn();
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
    await check(`syntax: js/${f}`, () => {
      execFileSync(process.execPath, ["--check", path.join(ROOT, "js", f)], { stdio: "pipe" });
      return null;
    });
  }
  await check("syntax: sw.js", () => {
    execFileSync(process.execPath, ["--check", path.join(ROOT, "sw.js")], { stdio: "pipe" });
    return null;
  });
}

// ---- 2. sw.js CORE precache list matches the real file tree ---------
await check("sw.js: CORE list matches js/ directory", () => {
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

// ---- 3. dataset.json is well-formed and internally consistent -------
await check("data/dataset.json: well-formed", () => {
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

// ---- 4. fs_sequences.json is well-formed -----------------------------
await check("data/fs_sequences.json: well-formed", () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "fs_sequences.json"), "utf8"));
  if (!Array.isArray(data.sequences) || data.sequences.length === 0) {
    throw new Error("no sequences array");
  }
  const bad = data.sequences.find((s) => !s.phrase || !Array.isArray(s.frames));
  if (bad) throw new Error("a sequence is missing phrase/frames");
  return `${data.sequences.length} sequences`;
});

// ---- 5. every practice-words category is non-empty -------------------
await check("data/practice-words.json: no empty categories", () => {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "practice-words.json"), "utf8"));
  const categories = Object.entries(data).filter(([k]) => !k.startsWith("_")); // _note etc. are metadata
  const empty = categories.filter(([, words]) => !Array.isArray(words) || words.length === 0);
  if (empty.length) throw new Error(`empty categories: ${empty.map(([k]) => k).join(", ")}`);
  return `${categories.length} categories`;
});

// ---- 6. every $("id") lookup in main.js resolves in index.html -------
// One-directional on purpose: an id that exists in HTML but isn't looked up
// in JS is not a bug (aria-labelledby targets, <label for>, pure CSS hooks).
// An id main.js tries to look up that ISN'T in the HTML is a silent runtime
// null — exactly the class of bug a big DOM restructure (moving/renaming ~30
// elements) produces, and selftest.js can't catch it since it never imports
// main.js.
await check("ids: every $(\"...\") in main.js exists in index.html", () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, "js", "main.js"), "utf8");
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const htmlIds = new Set([...html.matchAll(/\bid="([a-zA-Z0-9_-]+)"/g)].map((m) => m[1]));
  const referenced = new Set(
    [...mainSrc.matchAll(/\$\("([a-zA-Z0-9_-]+)"\)/g)].map((m) => m[1])
  );
  const missing = [...referenced].filter((id) => !htmlIds.has(id));
  if (missing.length) {
    throw new Error(`main.js looks up ids not present in index.html: ${missing.join(", ")}`);
  }
  return `${referenced.size} ids referenced, all present`;
});

// ---- 7. sw.js CORE also covers css/ (generalized, not just js/) ------
await check("sw.js: CORE list matches css/ directory", () => {
  const swSrc = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const coreMatch = swSrc.match(/const CORE = \[([\s\S]*?)\];/);
  if (!coreMatch) throw new Error("couldn't find `const CORE = [...]` in sw.js");
  const corePaths = [...coreMatch[1].matchAll(/"\.\/(css\/[a-zA-Z0-9_.-]+\.css)"/g)].map((m) => m[1]);
  const coreSet = new Set(corePaths);

  const actualCss = fs
    .readdirSync(path.join(ROOT, "css"))
    .filter((f) => f.endsWith(".css"))
    .map((f) => `css/${f}`);

  const missingFromCore = actualCss.filter((f) => !coreSet.has(f));
  const staleInCore = corePaths.filter((f) => !fs.existsSync(path.join(ROOT, f)));

  if (missingFromCore.length) {
    throw new Error(`css/ has files sw.js won't precache: ${missingFromCore.join(", ")}`);
  }
  if (staleInCore.length) {
    throw new Error(`sw.js precaches css files that no longer exist: ${staleInCore.join(", ")}`);
  }
  return `${corePaths.length} file(s), all accounted for`;
});

// ---- 8. reference photos, generalized over config's letter lists -----
// Was hardcoded to "A-Z" — reads ALL_LETTERS (+ DIGITS, once S9 adds it)
// from config.js instead, so this doesn't need editing when labels change.
await check("assets/reference: every configured label has a photo", async () => {
  const configUrl = pathToFileURL(path.join(ROOT, "js", "config.js"));
  const cfg = await import(configUrl);
  const labels = [...(cfg.ALL_LETTERS ?? []), ...(cfg.DIGITS ?? [])];
  if (!labels.length) throw new Error("config.js exported no ALL_LETTERS");
  const missing = labels.filter((L) => !fs.existsSync(path.join(ROOT, "assets", "reference", `${L}.jpg`)));
  if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
  return `${labels.length}/${labels.length} present`;
});

// ---- 9. sw.js VERSION bumped when a precached file changes -----------
// Advisory, not load-bearing: skips (doesn't fail) whenever origin/main isn't
// resolvable (shallow clone, no such remote yet, git unavailable) rather than
// false-failing CI for reasons unrelated to the actual rule. Most useful run
// locally right before pushing, which is exactly when the reminder matters —
// on a `push` CI run, origin/main is usually already the pushed commit, so
// the diff is empty and this becomes a no-op there, which is fine.
await check("sw.js: VERSION bumped vs origin/main when core files changed", () => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "origin/main"], { cwd: ROOT, stdio: "pipe" });
  } catch {
    return "skipped — no origin/main ref available";
  }
  let changedFiles;
  try {
    changedFiles = execFileSync("git", ["diff", "--name-only", "origin/main", "--"], {
      cwd: ROOT,
      stdio: "pipe",
    })
      .toString()
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    return `skipped — git diff failed (${e.message})`;
  }
  const isCore = (f) =>
    f === "sw.js" ||
    f === "index.html" ||
    f === "about.html" ||
    f === "manifest.webmanifest" ||
    f.startsWith("js/") ||
    f.startsWith("css/");
  const coreChanged = changedFiles.some(isCore);
  if (!coreChanged) return "no precached files changed vs origin/main";
  if (!changedFiles.includes("sw.js")) {
    throw new Error("precached files changed vs origin/main but sw.js itself wasn't touched — bump VERSION");
  }
  let oldSw;
  try {
    oldSw = execFileSync("git", ["show", "origin/main:sw.js"], { cwd: ROOT, stdio: "pipe" }).toString();
  } catch {
    return "skipped — couldn't read origin/main:sw.js";
  }
  const newSw = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8");
  const oldV = oldSw.match(/const VERSION = "(.*?)"/)?.[1];
  const newV = newSw.match(/const VERSION = "(.*?)"/)?.[1];
  if (oldV && newV && oldV === newV) {
    throw new Error(`precached files changed but VERSION is still "${newV}" — bump it in sw.js`);
  }
  return oldV && newV ? `${oldV} -> ${newV}` : "VERSION pattern not found in one of the two revisions";
});

// ---- 10. pure-module math invariants (scaffolding) --------------------
// js/posekin.js (bone-length-preserving interpolation, stage S2b) and
// js/orient.js (palm-orientation cue, stage S7) don't exist yet — this is
// forward-compatible scaffolding, not a failure, until those stages land.
// When they do, this is where their pure-Node invariants get asserted (bone
// lengths constant across a lerp, wrap() staying in (-pi, pi], sign stability
// under the 4 augmentation rotations, etc.) so the math has *enforced*
// coverage rather than relying on tools/selftest.html alone.
{
  const pending = ["posekin.js", "orient.js"].filter(
    (f) => !fs.existsSync(path.join(ROOT, "js", f))
  );
  if (pending.length) {
    console.log(`SKIP pure-module invariants — not yet added: ${pending.join(", ")}`);
  } else {
    await check("pure-module invariants: js/posekin.js and js/orient.js load", async () => {
      await import(pathToFileURL(path.join(ROOT, "js", "posekin.js")));
      await import(pathToFileURL(path.join(ROOT, "js", "orient.js")));
      return "present — add real math assertions here as they're built";
    });
  }
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
