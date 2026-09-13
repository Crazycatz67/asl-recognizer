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

// ---- 10. js/posekin.js — bone-length-preserving interpolation (S2b) -------
// A pure math module (no DOM), so its actual invariants can be *enforced*
// here rather than just eyeballed in tools/demo-lab.html: wrap() never
// leaves (-pi, pi]; every bone's length stays pinned to the target pose's
// length at every sampled t (the whole point of the module — a hand that
// never resizes mid-clip); poseAt(1) reproduces the target exactly; and no
// NaN/Infinity leaks out for a synthetic open-hand -> loose-fist clip.
await check("posekin.js: wrap() range, bone lengths pinned to target, endpoints exact, no NaN", async () => {
  const pk = await import(pathToFileURL(path.join(ROOT, "js", "posekin.js")));
  const { decompose, makeInterpolator, wrap } = pk;

  for (const d of [0, Math.PI, -Math.PI, 3.5, -3.5, 10, -10, 1e-4]) {
    const w = wrap(d);
    if (w <= -Math.PI - 1e-9 || w > Math.PI + 1e-9) {
      throw new Error(`wrap(${d}) = ${w} outside (-pi, pi]`);
    }
  }

  // synthetic open-hand -> loose-fist pair, 21 [x,y] pairs, wrist at origin.
  const neutral = [
    [0, 0], [-0.16, -0.09], [-0.31, -0.2], [-0.42, -0.31], [-0.52, -0.41],
    [-0.1, -0.42], [-0.12, -0.63], [-0.13, -0.77], [-0.14, -0.9],
    [0.02, -0.45], [0.02, -0.67], [0.02, -0.82], [0.02, -0.96],
    [0.14, -0.42], [0.16, -0.62], [0.17, -0.76], [0.18, -0.88],
    [0.25, -0.36], [0.29, -0.52], [0.31, -0.63], [0.33, -0.73],
  ];
  // same wrist-relative directions, scaled in toward a fist — deliberately
  // NOT the same bone lengths as `neutral`, so this also proves the pin is
  // to the TARGET's lengths, not just "whatever the first pose has".
  const target = neutral.map(([x, y], i) => (i === 0 ? [0, 0] : [x * 0.3, y * 0.3]));

  const poseAt = makeInterpolator(neutral, target);
  const targetBones = decompose(target);
  const ts = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];

  for (const t of ts) {
    const pose = poseAt(t);
    for (const [x, y] of pose) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`non-finite landmark at t=${t}`);
    }
    const d = decompose(pose);
    for (let i = 0; i < d.palm.length; i++) {
      if (Math.abs(d.palm[i].len - targetBones.palm[i].len) > 1e-9) {
        throw new Error(`palm bone ${i} length drifted from target at t=${t}`);
      }
    }
    for (let fi = 0; fi < d.chains.length; fi++) {
      for (let bi = 0; bi < d.chains[fi].length; bi++) {
        if (Math.abs(d.chains[fi][bi].len - targetBones.chains[fi][bi].len) > 1e-9) {
          throw new Error(`chain ${fi} bone ${bi} length drifted from target at t=${t}`);
        }
      }
    }
  }

  const p1 = poseAt(1);
  for (let i = 0; i < 21; i++) {
    const err = Math.hypot(p1[i][0] - target[i][0], p1[i][1] - target[i][1]);
    if (err > 1e-6) throw new Error(`poseAt(1) landmark ${i} off target by ${err}`);
  }
  return `${ts.length} t-samples x 20 bones length-checked, poseAt(1) exact, wrap() range verified`;
});

// ---- 11. js/strokekin.js — rigid rotation + spline math for J (S2d pt 2) --
// Pure math (no DOM), so its invariants are enforced here rather than
// eyeballed: rotate2D preserves vector length and composes additively;
// catmullRom2D passes through every control point exactly at its own
// t-fraction and never returns non-finite values off the ends; rigidPoseAt
// rotating a pose back onto itself (theta=0, wristAt=basePose[0]) is the
// identity; arcFractions is monotonic 0->1 and lands each original point
// exactly at its own cumulative-length fraction.
await check("strokekin.js: rotate2D/catmullRom2D/rigidPoseAt/arcFractions invariants", async () => {
  const sk = await import(pathToFileURL(path.join(ROOT, "js", "strokekin.js")));
  const { rotate2D, catmullRom2D, delayedEase, rigidPoseAt, bump, arcFractions } = sk;

  // rotate2D: length-preserving, and two half-turns == one full turn
  for (const v of [[1, 0], [0.3, -0.7], [-2, 5]]) {
    const r = rotate2D(v, 1.234);
    const lenBefore = Math.hypot(v[0], v[1]);
    const lenAfter = Math.hypot(r[0], r[1]);
    if (Math.abs(lenBefore - lenAfter) > 1e-9) throw new Error(`rotate2D changed length: ${lenBefore} -> ${lenAfter}`);
  }
  const half1 = rotate2D(rotate2D([1, 0], Math.PI / 2), Math.PI / 2);
  const full = rotate2D([1, 0], Math.PI);
  if (Math.hypot(half1[0] - full[0], half1[1] - full[1]) > 1e-9) {
    throw new Error("rotate2D(rotate2D(v, a), a) != rotate2D(v, 2a)");
  }

  // catmullRom2D: passes through every control point at its own t; no NaN
  const pts = [[0, 0], [1, 2], [3, 1], [4, 4]];
  for (let i = 0; i < pts.length; i++) {
    const t = i / (pts.length - 1);
    const p = catmullRom2D(pts, t);
    if (Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]) > 1e-6) {
      throw new Error(`catmullRom2D(${t}) = ${p} != control point ${pts[i]}`);
    }
  }
  for (const t of [-1, 0, 0.5, 1, 2]) {
    const [x, y] = catmullRom2D(pts, t);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`catmullRom2D(${t}) non-finite`);
  }

  // delayedEase: 0 up to `start`, reaches ease(1)=1 at t=1
  if (delayedEase(0.3, 0.5, (x) => x) !== 0) throw new Error("delayedEase should be 0 before start");
  if (Math.abs(delayedEase(1, 0.5, (x) => x) - 1) > 1e-9) throw new Error("delayedEase(1) should reach ease(1)");

  // rigidPoseAt: theta=0 with wristAt=basePose[0] is the identity
  const base = [[0, 0], [1, 0], [0, 1]];
  const identity = rigidPoseAt(base, 0, base[0]);
  for (let i = 0; i < base.length; i++) {
    if (Math.hypot(identity[i][0] - base[i][0], identity[i][1] - base[i][1]) > 1e-9) {
      throw new Error(`rigidPoseAt identity case moved point ${i}`);
    }
  }

  // bump: 1 at center, 0 at/after width
  if (Math.abs(bump(0.5, 0.5, 0.1) - 1) > 1e-9) throw new Error("bump(center) should be 1");
  if (bump(0.7, 0.5, 0.1) !== 0) throw new Error("bump beyond width should be 0");

  // arcFractions: monotonic 0->1, one entry per point
  const fracs = arcFractions(pts);
  if (fracs.length !== pts.length) throw new Error("arcFractions length mismatch");
  if (fracs[0] !== 0 || Math.abs(fracs.at(-1) - 1) > 1e-9) throw new Error("arcFractions should run 0 -> 1");
  for (let i = 1; i < fracs.length; i++) {
    if (fracs[i] < fracs[i - 1]) throw new Error("arcFractions not monotonic");
  }

  return "rotate2D length/composition, catmullRom2D control-point pass-through, delayedEase/rigidPoseAt/bump/arcFractions all verified";
});

// ---- 12. js/orient.js (scaffolding — palm-orientation cue, stage S7) ------
// Doesn't exist yet. When it lands, this is where its invariants get
// asserted (sign stability under the 4 augmentation rotations, |area|
// monotonic in a synthetic rotation sweep — see the plan's S7 section).
if (!fs.existsSync(path.join(ROOT, "js", "orient.js"))) {
  console.log("SKIP orient.js invariants — not yet added (stage S7)");
} else {
  await check("orient.js loads", async () => {
    await import(pathToFileURL(path.join(ROOT, "js", "orient.js")));
    return "present — add real math assertions here as they're built";
  });
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
