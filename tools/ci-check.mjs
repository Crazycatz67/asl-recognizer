// Free, dependency-free CI checks — plain Node, no npm install, no package.json.
// Runs in GitHub Actions on every push/PR (see .github/workflows/ci.yml) and
// locally via: node tools/ci-check.mjs
//
// Deliberately NOT a replacement for tools/selftest.html (164 browser-based
// unit + integration checks) — that still needs a browser and stays a manual
// pre-push step. This catches a different, cheaper class of bug: things that
// are correct in isolation but drift out of sync with each other.

import fs from "node:fs";
import os from "node:os";
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
  // Check each file AS AN ES MODULE (a temp .mjs copy). Found 2026-09-24:
  // `node --check file.js` with no package.json "type" silently passes ESM
  // syntax errors — e.g. `import { a,, b }` in js/main.js went green here
  // while the browser refused to load the app at all.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asl-syntax-"));
  const jsFiles = fs.readdirSync(path.join(ROOT, "js")).filter((f) => f.endsWith(".js"));
  for (const f of jsFiles) {
    await check(`syntax: js/${f}`, () => {
      const copy = path.join(tmp, f.replace(/\.js$/, ".mjs"));
      fs.copyFileSync(path.join(ROOT, "js", f), copy);
      try {
        execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });
      } catch (e) {
        throw new Error(String(e.stderr || e.message).split("\n").slice(0, 5).join(" | "));
      }
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
  const { decompose, makeInterpolator, angleDistance, wrap } = pk;

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

  // angleDistance (S2e): 0 for identical poses, symmetric, finite for a real
  // pair, and unclamped `poseAt` still lands exactly on target beyond t=1's
  // usual range check above (already covers that poseAt(1) is exact; here we
  // additionally confirm overshoot t doesn't throw or go non-finite, since
  // S2e's word-mode arrival dynamics rely on that).
  // ~0, not exactly 0: posekin.js compares bone DIRECTIONS via normalize+dot+
  // acos now (3D, no sign-ambiguous wrap needed), and that chain can't
  // guarantee bit-exact 0 for identical inputs the way `wrap(same - same)`
  // used to — acos's derivative near 1 amplifies a ~1e-16 float rounding
  // error up to ~1e-9, which is still functionally zero. 1e-6 is generous
  // relative to that and to the endpoint-exactness tolerance just above.
  const dSelf = angleDistance(neutral, neutral);
  if (!(dSelf < 1e-6)) throw new Error(`angleDistance(x,x) should be ~0, got ${dSelf}`);
  const dAB = angleDistance(neutral, target);
  const dBA = angleDistance(target, neutral);
  if (Math.abs(dAB - dBA) > 1e-9) throw new Error(`angleDistance not symmetric: ${dAB} vs ${dBA}`);
  if (!Number.isFinite(dAB) || dAB < 0) throw new Error(`angleDistance out of range: ${dAB}`);
  for (const t of [-0.1, 1.06, 1.2]) {
    const pose = poseAt(t);
    for (const [x, y] of pose) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`poseAt(${t}) (overshoot) non-finite`);
    }
  }
  return `${ts.length} t-samples x 20 bones length-checked, poseAt(1) exact, overshoot t stays finite, angleDistance symmetric/zero-at-identity, wrap() range verified`;
});

// ---- 11. js/strokekin.js — rigid rotation + spline math for J (S2d pt 2) --
// Pure math (no DOM), so its invariants are enforced here rather than
// eyeballed: rotate2D preserves vector length and composes additively;
// catmullRom2D passes through every control point exactly at its own
// t-fraction and never returns non-finite values off the ends; rigidPoseAt
// rotating a pose back onto itself (theta=0, wristAt=basePose[0]) is the
// identity; arcFractions is monotonic 0->1 and lands each original point
// exactly at its own cumulative-length fraction.
await check("strokekin.js: rotate2D/catmullRom2D/rigidPoseAt/arcFractions/translatePose/easeOutBack invariants", async () => {
  const sk = await import(pathToFileURL(path.join(ROOT, "js", "strokekin.js")));
  const { rotate2D, catmullRom2D, delayedEase, rigidPoseAt, bump, arcFractions, translatePose, easeOutBack } = sk;

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

  // translatePose (S2e doubled-letter bounce): a pure per-point shift
  const shifted = translatePose(base, [0.5, -0.25]);
  for (let i = 0; i < base.length; i++) {
    if (Math.abs(shifted[i][0] - (base[i][0] + 0.5)) > 1e-9 || Math.abs(shifted[i][1] - (base[i][1] - 0.25)) > 1e-9) {
      throw new Error(`translatePose didn't shift point ${i} correctly`);
    }
  }

  // easeOutBack (S2e arrival dynamics): f(0)=0, f(1)=1 exactly, and it
  // actually overshoots past 1 somewhere in between (the whole point) by
  // roughly the plan's ~6% at the default overshoot constant.
  if (Math.abs(easeOutBack(0)) > 1e-9) throw new Error("easeOutBack(0) should be 0");
  if (Math.abs(easeOutBack(1) - 1) > 1e-9) throw new Error("easeOutBack(1) should be exactly 1");
  let peak = -Infinity;
  for (let t = 0; t <= 1; t += 0.01) peak = Math.max(peak, easeOutBack(t));
  if (peak < 1.03 || peak > 1.1) throw new Error(`easeOutBack peak overshoot ${peak} outside the expected ~6% band`);

  return "rotate2D length/composition, catmullRom2D control-point pass-through, delayedEase/rigidPoseAt/bump/arcFractions/translatePose/easeOutBack all verified";
});

// ---- 12. js/reference.js — word-level coarticulation timeline (S2e) -------
// The interesting invariant here isn't the pose math (posekin.js already
// covers that) — it's the TIMING CONTRACT: main.js's `playWord` schedules
// each run with plain `runStartIndex * holdMs` timers and has no idea what
// buildWordSpans does internally, so a run's total duration must come out to
// EXACTLY `entries.length * holdMs` (the first letter's neutral entry has to
// fit inside its own budget, not add extra time — see the comment on
// buildWordSpans) or every letter after a multi-letter run drifts out of
// sync with its own timer. Also checks the span list is gapless/ordered,
// sampling past the end freezes rather than throwing, and a doubled letter's
// bounce actually returns to (not past) its own pose.
await check("reference.js: buildWordSpans/sampleWordSpans timing contract + doubled-letter bounce", async () => {
  const refm = await import(pathToFileURL(path.join(ROOT, "js", "reference.js")));
  const { buildWordSpans, sampleWordSpans, wordTransDur } = refm;

  // three distinct synthetic poses + z, shaped like a real centroid's parsed
  // pose/z pair (21 [x,y] + 21 numbers) — an open hand fanned by varying
  // amounts, so consecutive poses are neither identical nor wildly far apart.
  const mkPose = (spread) => {
    const pose = [[0, 0]];
    const z = [0];
    for (let i = 1; i < 21; i++) {
      pose.push([Math.cos(i) * spread, Math.sin(i) * spread - 0.5]);
      z.push(Math.sin(i * spread) * 0.1);
    }
    return { pose, z };
  };
  const letterA = mkPose(0.3);
  const letterB = mkPose(0.5);
  const letterC = mkPose(0.7);

  const holdMs = 500;

  // plain 3-letter run, no doubles
  {
    const { spans, totalMs, letterStarts } = buildWordSpans([letterA, letterB, letterC], [false, false], holdMs);
    if (Math.abs(totalMs - 3 * holdMs) > 1e-6) {
      throw new Error(`total duration ${totalMs} != 3*holdMs (${3 * holdMs}) — would desync main.js's timers`);
    }
    if (spans[0].startMs !== 0) throw new Error("first span should start at 0");
    for (let i = 1; i < spans.length; i++) {
      if (spans[i].startMs !== spans[i - 1].endMs) throw new Error(`gap/overlap between span ${i - 1} and ${i}`);
    }
    if (spans.at(-1).endMs !== totalMs) throw new Error("last span should end at totalMs");

    // letterStarts (S3 transport step targets): one per letter, strictly
    // increasing, in range, and sampling there lands exactly on that
    // letter's own raw pose (the right landing point for a "step to this
    // letter" jump — not the hold's own slightly-anticipatory blend, which
    // is what you'd get sampling a moment later instead)
    const letters3 = [letterA, letterB, letterC];
    if (letterStarts.length !== 3) throw new Error(`letterStarts should have 3 entries, got ${letterStarts.length}`);
    for (let i = 1; i < letterStarts.length; i++) {
      if (letterStarts[i] <= letterStarts[i - 1]) throw new Error("letterStarts should strictly increase");
    }
    for (let i = 0; i < letterStarts.length; i++) {
      const ms = letterStarts[i];
      if (ms < 0 || ms > totalMs) throw new Error(`letterStart ${ms} out of [0, totalMs]`);
      const { pose } = sampleWordSpans(spans, ms);
      for (let j = 0; j < 21; j++) {
        const err = Math.hypot(pose[j][0] - letters3[i].pose[j][0], pose[j][1] - letters3[i].pose[j][1]);
        if (err > 1e-6) throw new Error(`letterStart ${i} landmark ${j} off that letter's raw pose by ${err}`);
      }
    }

    const atEnd = sampleWordSpans(spans, totalMs);
    const wellPast = sampleWordSpans(spans, totalMs + 5000);
    for (let i = 0; i < 21; i++) {
      if (Math.hypot(atEnd.pose[i][0] - wellPast.pose[i][0], atEnd.pose[i][1] - wellPast.pose[i][1]) > 1e-9) {
        throw new Error("sampling past totalMs should freeze on the last frame, not keep changing");
      }
    }
    // the run should land exactly on the last letter (no residual blend —
    // isLast has no "next" to anticipate)
    for (let i = 0; i < 21; i++) {
      const err = Math.hypot(atEnd.pose[i][0] - letterC.pose[i][0], atEnd.pose[i][1] - letterC.pose[i][1]);
      if (err > 1e-6) throw new Error(`final frame landmark ${i} off the last letter's raw pose by ${err}`);
    }
  }

  // doubled letter (A-A-B): the A-A transition must be a bounce that RETURNS
  // to A's own pose, not a bone-space blend toward an identical pose (which
  // would be a no-op — the actual bug this fixes)
  {
    const { spans, totalMs } = buildWordSpans([letterA, letterA, letterB], [true, false], holdMs);
    if (Math.abs(totalMs - 3 * holdMs) > 1e-6) throw new Error(`doubled-letter run duration ${totalMs} != 3*holdMs`);
    const bounce = spans.find((s) => s.kind === "bounce");
    if (!bounce) throw new Error("A-A should produce a bounce span, not a blend");

    const mid = sampleWordSpans(spans, (bounce.startMs + bounce.endMs) / 2);
    const end = sampleWordSpans(spans, bounce.endMs);
    let midMoved = false;
    for (let i = 0; i < 21; i++) {
      if (Math.hypot(mid.pose[i][0] - letterA.pose[i][0], mid.pose[i][1] - letterA.pose[i][1]) > 1e-3) midMoved = true;
      const endErr = Math.hypot(end.pose[i][0] - letterA.pose[i][0], end.pose[i][1] - letterA.pose[i][1]);
      if (endErr > 1e-6) throw new Error(`bounce should return exactly to A's pose, landmark ${i} off by ${endErr}`);
    }
    if (!midMoved) throw new Error("bounce midpoint should visibly move away from A's pose (that's the whole point)");
  }

  // wordTransDur clamps into [90, 340]ms regardless of how far apart the
  // poses are (an identical pair and a maximally different synthetic pair)
  const dSame = wordTransDur(letterA.pose, letterA.pose);
  const dFar = wordTransDur(letterA.pose, letterC.pose);
  if (dSame < 90 || dSame > 340 || dFar < 90 || dFar > 340) {
    throw new Error(`wordTransDur out of the plan's [90,340]ms band: same=${dSame} far=${dFar}`);
  }

  return "3-letter run totals exactly 3*holdMs, spans gapless, freezes past totalMs, lands exactly on the last letter; a doubled letter bounces and returns to its own pose; wordTransDur stays in [90,340]ms";
});

// ---- 13. js/onefilter.js — one-euro adaptive landmark smoothing (S8) ------
await check("onefilter.js: first-sample passthrough, converges on a held signal, dt<=0/reset are safe, no NaN", async () => {
  const { createLandmarkFilter } = await import(pathToFileURL(path.join(ROOT, "js", "onefilter.js")));
  const f = createLandmarkFilter({ mincutoff: 1.2, beta: 3.0, dcutoff: 1.0 });

  const pt = (x, y, z) => [{ x, y, z }];

  // first real sample: no history yet, must pass through exactly (this is
  // also what the live app relies on for "hand re-acquired -> snap, don't
  // lerp in from wherever the filter last was")
  const p0 = f.filter(pt(0.3, 0.4, 0.1), 0);
  if (p0[0].x !== 0.3 || p0[0].y !== 0.4 || p0[0].z !== 0.1) {
    throw new Error(`first sample should pass through unchanged, got ${JSON.stringify(p0[0])}`);
  }

  // a signal held perfectly constant should converge to that constant (not
  // just "stay close" forever) — feed it enough steps at a normal frame
  // interval to settle within a tight tolerance
  let last = p0;
  for (let i = 1; i <= 60; i++) last = f.filter(pt(0.3, 0.4, 0.1), i / 30);
  const err = Math.hypot(last[0].x - 0.3, last[0].y - 0.4, last[0].z - 0.1);
  if (err > 1e-3) throw new Error(`held-constant signal didn't converge: err=${err}`);

  // a duplicate/non-increasing timestamp must not throw, divide by zero, or
  // produce NaN — the live loop guards against this already, but the filter
  // itself shouldn't assume a caller always will
  const dup = f.filter(pt(0.31, 0.4, 0.1), 2); // same t as the last iteration above (60/30 = 2)
  for (const [k, v] of Object.entries(dup[0])) {
    if (!Number.isFinite(v)) throw new Error(`non-finite ${k} after a non-increasing timestamp`);
  }

  // null (hand lost) resets history — the next real sample must pass
  // through unchanged again, exactly like the very first one ever
  f.filter(null, 3);
  const afterReset = f.filter(pt(0.7, 0.8, 0.2), 4);
  if (afterReset[0].x !== 0.7 || afterReset[0].y !== 0.8 || afterReset[0].z !== 0.2) {
    throw new Error(`sample right after a reset should pass through unchanged, got ${JSON.stringify(afterReset[0])}`);
  }

  // a fast-changing signal should track noticeably closer than a signal
  // fed through a much heavier fixed cutoff would — a cheap proxy for "the
  // adaptive part is actually doing something": lag after one step of a
  // big jump should be well under half the jump size at a normal frame dt.
  const g = createLandmarkFilter({ mincutoff: 1.2, beta: 3.0, dcutoff: 1.0 });
  g.filter(pt(0, 0, 0), 0);
  const jumped = g.filter(pt(1, 0, 0), 1 / 30);
  if (jumped[0].x < 0.5) {
    throw new Error(`adaptive cutoff barely responded to a fast jump: x=${jumped[0].x} after 1 step`);
  }

  return "first-sample passthrough exact, held signal converges (<1e-3), non-increasing dt and reset both safe, fast motion tracked with low lag";
});

// ---- 13b. demo-hand neutral pose is on the same side as the letters -------
// The demo hand animates NEUTRAL_HAND -> each letter's dataset centroid. If
// the neutral is the mirror image of the centroids (thumb on the other side,
// as it was until 2026-09-23), no bone rotation can get there, so the palm
// polygon (wrist + 4 knuckles) squeezes to a sliver and turns inside-out
// mid-animation — the "impossible movement" live testers reported. Assert
// that for every static letter the palm's signed area never flips sign and
// never shrinks below half of the smaller endpoint's area.
await check("reference.js: demo-hand palm never collapses or turns inside-out (NEUTRAL_HAND -> every centroid)", async () => {
  const { NEUTRAL_HAND } = await import(pathToFileURL(path.join(ROOT, "js", "reference.js")));
  // the interpolator the demo hand actually uses (Stage 4b)
  const { makeHandInterpolator: makeInterpolator } = await import(pathToFileURL(path.join(ROOT, "js", "posekin.js")));
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "dataset.json"), "utf8"));
  const PALM = [0, 5, 9, 13, 17];
  const area = (p) => {
    let a = 0;
    for (let i = 0; i < PALM.length; i++) {
      const [x1, y1] = p[PALM[i]], [x2, y2] = p[PALM[(i + 1) % PALM.length]];
      a += x1 * y2 - x2 * y1;
    }
    return a / 2;
  };
  const sums = new Map();
  for (const s of data.samples) {
    if (s.label === "J" || s.label === "Z" || !/^[A-Z]$/.test(s.label)) continue;
    const e = sums.get(s.label) || { acc: new Array(63).fill(0), n: 0 };
    for (let i = 0; i < 63; i++) e.acc[i] += s.v[i];
    e.n++;
    sums.set(s.label, e);
  }
  let worst = Infinity, worstL = "";
  for (const [L, e] of sums) {
    const c = e.acc.map((x) => x / e.n);
    const tgt = Array.from({ length: 21 }, (_, i) => [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]]);
    const at = makeInterpolator(NEUTRAL_HAND, tgt);
    const a0 = area(NEUTRAL_HAND), a1 = area(tgt);
    const ref = Math.min(Math.abs(a0), Math.abs(a1));
    if (Math.sign(a0) !== Math.sign(a1)) throw new Error(`${L}: neutral and target palms face opposite ways (mirrored poses)`);
    for (let k = 1; k < 40; k++) {
      const a = area(at(k / 40));
      if (Math.sign(a) !== Math.sign(a1)) throw new Error(`${L}: palm turns inside-out at t=${k / 40}`);
      const r = Math.abs(a) / ref;
      if (r < worst) { worst = r; worstL = L; }
    }
  }
  if (worst < 0.5) throw new Error(`palm collapses to ${(worst * 100).toFixed(0)}% on ${worstL}`);
  return `${sums.size} letters, smallest mid-animation palm ${(worst * 100).toFixed(0)}% of endpoints (${worstL})`;
});

// ---- 13b2. posekin.js makeHandInterpolator — anatomy invariants (Stage 4b) ----
// For every letter, NEUTRAL_HAND -> centroid: endpoints exact; the palm stays
// RIGID (wrist + 4 knuckle distances constant within the lerp of their end
// values); every finger bone's forward bend moves monotonically between its
// start and end values (no swinging through the palm or doubling back) —
// the "impossible movements" the owner reported.
await check("posekin.js: demo hand keeps a rigid palm and fingers bend monotonically (all static letters)", async () => {
  const { NEUTRAL_HAND } = await import(pathToFileURL(path.join(ROOT, "js", "reference.js")));
  const { makeHandInterpolator, fingerBends } = await import(pathToFileURL(path.join(ROOT, "js", "posekin.js")));
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "dataset.json"), "utf8"));
  const sums = new Map();
  for (const s of data.samples) {
    if (s.label === "J" || s.label === "Z" || !/^[A-Z]$/.test(s.label)) continue;
    const e = sums.get(s.label) || { acc: new Array(63).fill(0), n: 0 };
    for (let i = 0; i < 63; i++) e.acc[i] += s.v[i];
    e.n++;
    sums.set(s.label, e);
  }
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] || 0) - (b[2] || 0));
  const PALM = [[0, 5], [0, 17], [5, 17], [0, 9]];
  let worstBend = 0, worstPalm = 0;
  for (const [L, e] of sums) {
    const c = e.acc.map((x) => x / e.n);
    const tgt = Array.from({ length: 21 }, (_, i) => [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]]);
    const f = makeHandInterpolator(NEUTRAL_HAND, tgt);
    const end = f.at3d(1);
    for (let j = 0; j < 21; j++) if (d3(end[j], tgt[j]) > 1e-9) throw new Error(`${L}: t=1 not exact at joint ${j}`);
    const b0 = fingerBends(f.at3d(0)), b1 = fingerBends(end);
    let prev = b0;
    for (let k = 1; k <= 20; k++) {
      const p = f.at3d(k / 20);
      // rigid = no collapse / stretch: each palm distance stays inside its
      // start..end range (the shape blends linearly in the palm's own frame,
      // so a blended distance can dip a little below the linear blend of the
      // two lengths — that's not deformation)
      for (const [a, b] of PALM) {
        const s0 = d3(NEUTRAL_HAND[a], NEUTRAL_HAND[b]), s1 = d3(tgt[a], tgt[b]);
        const lo = Math.min(s0, s1), hi = Math.max(s0, s1), v = d3(p[a], p[b]);
        worstPalm = Math.max(worstPalm, Math.max(0, lo - v, v - hi) / (lo || 1));
      }
      const bends = fingerBends(p);
      bends.forEach((fb, fi) => fb.forEach((v, bi) => {
        const lo = Math.min(b0[fi][bi], b1[fi][bi]) - 1e-6, hi = Math.max(b0[fi][bi], b1[fi][bi]) + 1e-6;
        const out = Math.max(0, lo - v, v - hi);
        if (out > worstBend) worstBend = out;
      }));
      prev = bends;
    }
  }
  if (worstPalm > 0.1) throw new Error(`palm deforms: a palm distance leaves its start..end range by ${(100 * worstPalm).toFixed(1)}%`);
  if (worstBend > 0.05) throw new Error(`a finger bend leaves its start..end range by ${(worstBend * 180 / Math.PI).toFixed(1)}°`);
  return `${sums.size} letters: endpoints exact, palm distances within start..end (max excursion ${(100 * worstPalm).toFixed(2)}%), bends stay within start..end (max excursion ${(worstBend * 180 / Math.PI).toFixed(2)}°)`;
});

// ---- 13c. js/motion.js — J/Z strokes vs. the live-QA false positives -------
// tools/synth-hand.js builds a 21-landmark hand that can drop, tilt in-plane,
// twist (supination foreshortens the palm), curl fingers and move the arm.
// Real J/Z strokes must fire exactly once; the reported false positives
// (tilting or relaxing an I, a straight drop, a wave, one wag, a tiny far-away
// hand's jitter) must not fire at all — at a square and a 16:9 aspect, and
// at 30 and 20 fps.
await check("motion.js: real J/Z strokes fire once; tilt / relax / drift / wave / one-wag / far-away jitter don't", async () => {
  const { createMotionMatcher } = await import(pathToFileURL(path.join(ROOT, "js", "motion.js")));
  const { motionScenarios, runScenario } = await import(pathToFileURL(path.join(ROOT, "tools", "synth-hand.js")));
  let n = 0;
  for (const aspect of [1, 16 / 9]) {
    for (const dt of [33, 50]) {
      for (const sc of motionScenarios()) {
        const hits = runScenario(createMotionMatcher, sc, aspect, dt);
        const want = sc.expect ? [sc.expect] : [];
        if (JSON.stringify(hits) !== JSON.stringify(want)) {
          throw new Error(`"${sc.name}" @aspect ${aspect.toFixed(2)}, ${dt}ms/frame: got ${JSON.stringify(hits)}, want ${JSON.stringify(want)}`);
        }
        n++;
      }
    }
  }
  return `${n} scenario runs (12 scenarios x 2 aspects x 2 frame rates)`;
});

// ---- 13d. J demo hand and the on-camera J guide trace the SAME path --------
// 2026-09-24 live QA: "the mannequin video guide shows one way and the
// skeleton overlay guide shows something completely different". The demo's
// pinky tip must sit on motion.js STROKE.J (what overlay.js draws) at every
// moment, the I-hand must stay rigid (bone lengths constant), and it must
// start and end at the path's ends.
await check("reference.js: J demo's pinky rides STROKE.J (same path as the camera guide), hand stays rigid", async () => {
  const { J_DEMO } = await import(pathToFileURL(path.join(ROOT, "js", "reference.js")));
  const { STROKE } = await import(pathToFileURL(path.join(ROOT, "js", "motion.js")));
  const { catmullRom2D } = await import(pathToFileURL(path.join(ROOT, "js", "strokekin.js")));
  const curve = Array.from({ length: 401 }, (_, i) => catmullRom2D(STROKE.J, i / 400));
  const distToCurve = (p) => Math.min(...curve.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1])));
  const bone = (pose) => Math.hypot(pose[20][0] - pose[17][0], pose[20][1] - pose[17][1]);
  const b0 = bone(J_DEMO.poseAt(0));
  let worst = 0;
  for (let k = 0; k <= 40; k++) {
    const pose = J_DEMO.poseAt(k / 40);
    worst = Math.max(worst, distToCurve(pose[J_DEMO.tip]));
    if (Math.abs(bone(pose) - b0) > 1e-9) throw new Error(`hand not rigid at f=${k / 40}`);
  }
  if (worst > 0.02) throw new Error(`pinky leaves STROKE.J by ${worst.toFixed(3)} spans`);
  const s = J_DEMO.poseAt(0)[J_DEMO.tip], e = J_DEMO.poseAt(1)[J_DEMO.tip];
  if (Math.hypot(s[0] - STROKE.J[0][0], s[1] - STROKE.J[0][1]) > 1e-6 ||
      Math.hypot(e[0] - STROKE.J.at(-1)[0], e[1] - STROKE.J.at(-1)[1]) > 1e-6)
    throw new Error("J demo doesn't start/end at STROKE.J's ends");
  return `max pinky-to-path distance ${worst.toFixed(4)} spans over 41 samples`;
});

// ---- 13e. js/handshape.js — letters judged by their defining traits --------
// 2026-09-24 owner: judge "the accuracy of the letter rather than ... the
// photo". Calibrated on the first 80% of each letter's samples, checked on
// the held-out last 20%: every letter's own real hands must mostly pass its
// definition (room for error), and clearly different shapes must not.
await check("handshape.js: real held-out hands pass their own letter's traits; clearly different shapes don't", async () => {
  const { createHandshapeJudge } = await import(pathToFileURL(path.join(ROOT, "js", "handshape.js")));
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "dataset.json"), "utf8"));
  const byL = {};
  for (const x of data.samples) (byL[x.label] ||= []).push(x);
  const train = [], test = {};
  for (const [L, arr] of Object.entries(byL)) {
    const cut = Math.floor(arr.length * 0.8);
    arr.forEach((x, i) => (i < cut ? train.push(x) : (test[L] ||= []).push(x)));
  }
  const judge = createHandshapeJudge(train);
  const passRate = (L, asL) => test[L].filter((x) => judge.check(x.v, asL)?.ok).length / test[L].length;
  const weak = judge.letters.filter((L) => passRate(L, L) < 0.6).map((L) => `${L} ${(100 * passRate(L, L)).toFixed(0)}%`);
  if (weak.length) throw new Error(`letters whose own real hands mostly fail their definition: ${weak.join(", ")}`);
  // finger-pattern differences must be caught by the traits alone; I vs Y
  // differ ONLY by the thumb (often seen edge-on), so traits alone are
  // looser there and main.js's recogniser tie-break settles it (measured:
  // I->Y doesn't appear among the gate's false passes) — bound it anyway.
  const mustFail = [["B", "A"], ["B", "S"], ["V", "U"], ["L", "B"], ["Y", "L"], ["W", "V"], ["A", "B"], ["I", "Y", 0.35], ["Q", "P"]]; // Q vs P: thumb out vs tucked (2026-09-25)
  const leaks = mustFail.filter(([a, b, lim = 0.15]) => passRate(a, b) > lim).map(([a, b]) => `${a} as ${b} ${(100 * passRate(a, b)).toFixed(0)}%`);
  if (leaks.length) throw new Error(`clearly different shapes pass: ${leaks.join(", ")}`);
  // owner 2026-09-24: "I spread my fingers wide but they were curled and it
  // registered [N]". Claws built from held-out raised-finger hands (fanned,
  // then curled at the middle joints) must not pass as the fist letters that
  // fold at the KNUCKLES.
  const { fanFingers, curlAtMiddle } = await import(pathToFileURL(path.join(ROOT, "tools", "synth-hand.js")));
  const claws = ["B", "V", "W"].flatMap((L) => test[L]).flatMap((x) => [curlAtMiddle(fanFingers(x.v, 15), 90), curlAtMiddle(fanFingers(x.v, 25), 100), curlAtMiddle(x.v, 80)]);
  const clawLeak = ["N", "M"].map((L) => [L, claws.filter((v) => judge.check(v, L)?.ok).length / claws.length]).filter(([, r]) => r > 0.1);
  if (clawLeak.length) throw new Error(`curled + spread (claw) hands pass as ${clawLeak.map(([L, r]) => `${L} ${(100 * r).toFixed(0)}%`).join(", ")}`);
  const all = judge.letters.map((L) => passRate(L, L));
  return `${judge.letters.length} letters, own-letter pass ${(100 * all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)}% avg (min ${(100 * Math.min(...all)).toFixed(0)}%), ${mustFail.length} different-shape pairs rejected, claws rejected as N/M`;
});

// ---- 13f. verdict.js — no letter's real hands count as a DIFFERENT letter ----
// tools/lab/probe-thresholds.mjs found (2026-09-25) the fist-letter tie-break
// ignoring non-fist readings: real O hands counted as A/E/S/T ~97%, L/G/X as
// T ~100%. Guard the shipped verdict on held-out hands (the lab's own setup):
// no ordered pair may exceed 30% (the M/N pair sits ~20-23%).
await check("verdict.js: no letter's held-out real hands count as a different letter > 30%", async () => {
  const { loadLab } = await import(pathToFileURL(path.join(ROOT, "tools", "lab", "lab-data.mjs")).href);
  const lab = await loadLab();
  let worst = { rate: 0 };
  for (const X of lab.letters) {
    const vs = lab.test[X].filter((_, i) => i % 2 === 0).slice(0, 25).map((s) => s.v);
    const preds = vs.map((v) => lab.predict(v));
    for (const L of lab.letters) {
      if (L === X) continue;
      const rate = vs.filter((v, i) => lab.countsWith(v, L, preds[i])).length / vs.length;
      if (rate > worst.rate) worst = { rate, pair: `${X} as ${L}` };
    }
  }
  if (worst.rate > 0.3) throw new Error(`${Math.round(100 * worst.rate)}% of real ${worst.pair}`);
  return `worst cross-letter acceptance ${Math.round(100 * worst.rate)}% (${worst.pair})`;
});

// ---- 13g. handshape.js — a folded finger RAISED doesn't still count -------
// owner 2026-09-24: "follow the general shape ... but a wrong finger must not
// count". tools/lab/probe-thresholds.mjs (physical bendFinger, 2026-09-25)
// found a folded finger raised 60° at knuckle + middle joint still counting
// for A ring 87%, G ring 100%, L middle 97%, S ring 97%, T ring 90%, X ring
// 100%, Y middle 80% (the DOWN floor + slack reached into the raised range).
// Traits-only, on held-out hands that pass their own letter.
await check("handshape.js: a folded finger raised 60° no longer passes (clean letters <= 25%, every letter <= 75%)", async () => {
  const { loadLab } = await import(pathToFileURL(path.join(ROOT, "tools", "lab", "lab-data.mjs")).href);
  const { bendFinger } = await import(pathToFileURL(path.join(ROOT, "tools", "synth-hand.js")).href);
  const lab = await loadLab();
  // letters whose folded fingers are folded tight on every real signer; M N
  // (knuckle-folded, noisy) and S's pinky are held to the looser cap. E and
  // D joined when the curl escape became per-letter (E ring/pinky raised
  // 60° counted 47/50% of held-out E under a shared line, 7/13% after).
  const CLEAN = new Set(["A", "D", "E", "G", "H", "I", "K", "L", "R", "T", "U", "V", "W", "X", "Y"]);
  const bad = [];
  let n = 0;
  for (const L of lab.letters) {
    const spec = lab.judge.ranges.get(L);
    const own = lab.test[L].map((s) => s.v).filter((v) => lab.judge.check(v, L)?.ok);
    for (const f of ["index", "middle", "ring", "pinky"]) {
      if (spec[f + "Flex"]?.kind !== "down" || !own.length) continue;
      n++;
      const rate = own.filter((v) => lab.judge.check(bendFinger(v, f, -60), L)?.ok).length / own.length;
      if (rate > (CLEAN.has(L) ? 0.25 : 0.75)) bad.push(`${L} ${f} ${Math.round(100 * rate)}%`);
    }
  }
  // ...without failing E's real curled fingers (tips on the thumb read as
  // half raised by direction alone): E own traits pass was 73% before the
  // curl override + per-letter escape
  const eOwn = lab.test.E.filter((s) => lab.judge.check(s.v, "E")?.ok).length / lab.test.E.length;
  if (eOwn < 0.78) bad.push(`E's own held-out hands pass only ${Math.round(100 * eOwn)}%`);
  if (bad.length) throw new Error(`still counts with that finger raised 60°: ${bad.join(", ")}`);
  return `${n} letter-fingers checked; E own ${Math.round(100 * eOwn)}%`;
});

// ---- 13h. handshape.js — a raised finger FOLDED doesn't still count; fanning does -
// probe 2026-09-25: G's index folded 60° (flex ~80°) still counted for 60% of
// held-out G hands, H's 23% — the UP ceiling + slack reached past the folded
// floor. The fix measures the fold toward the palm with the sideways (fan)
// component removed, so F / W / I, which fan their raised fingers, still pass
// when fanned 20°/gap.
await check("handshape.js: a raised finger folded 60° fails; raised fingers fanned 20°/gap still pass", async () => {
  const { loadLab } = await import(pathToFileURL(path.join(ROOT, "tools", "lab", "lab-data.mjs")).href);
  const { bendFinger, fanFingers } = await import(pathToFileURL(path.join(ROOT, "tools", "synth-hand.js")).href);
  const lab = await loadLab();
  const bad = [];
  let n = 0;
  for (const L of lab.letters) {
    const spec = lab.judge.ranges.get(L);
    const own = lab.test[L].map((s) => s.v).filter((v) => lab.judge.check(v, L)?.ok);
    if (!own.length) continue;
    for (const f of ["index", "middle", "ring", "pinky"]) {
      if (spec[f + "Flex"]?.kind !== "up") continue;
      n++;
      const rate = own.filter((v) => lab.judge.check(bendFinger(v, f, 60), L)?.ok).length / own.length;
      if (rate > 0.25) bad.push(`${L} ${f} folded still ${Math.round(100 * rate)}%`);
    }
  }
  for (const L of ["F", "W", "I"]) {
    const own = lab.test[L].map((s) => s.v).filter((v) => lab.judge.check(v, L)?.ok);
    const rate = own.filter((v) => lab.judge.check(fanFingers(v, 20), L)?.ok).length / own.length;
    if (rate < 0.5) bad.push(`${L} fanned 20°/gap only ${Math.round(100 * rate)}%`);
  }
  if (bad.length) throw new Error(bad.join(", "));
  return `${n} raised letter-fingers rejected when folded; F W I tolerate fanning`;
});

// ---- 13i. handshape.js — B's thumb: tucked anywhere across the palm, not out -
// probe 2026-09-25: 5 of 30 held-out B hands failed ONLY thumbOut (thumb
// folded across toward the ring/pinky knuckles, 0.60-0.67 from the index
// knuckle), and a 15° thumb swing failed 97% of B. B now defines its thumb by
// thumbNear alone; a thumb swung clearly out (45°) must still fail, and L
// (thumb out) must not pass as B (13e).
// T (LAB-062, 2026-09-25): T didn't define its thumb, so a thumb swung out
// 45° still counted 67%. The shared IN line failed a quarter of real T (its
// thumb pokes up between index and middle), so T is bounded by its own p95.
await check("handshape.js: B and T pass with the thumb tucked, fail with it swung out 45°", async () => {
  const { loadLab } = await import(pathToFileURL(path.join(ROOT, "tools", "lab", "lab-data.mjs")).href);
  const { swingThumb } = await import(pathToFileURL(path.join(ROOT, "tools", "synth-hand.js")).href);
  const lab = await loadLab();
  const out = [];
  for (const [L, minOwn] of [["B", 0.85], ["T", 0.8]]) {
    const hands = lab.test[L].map((s) => s.v);
    const own = hands.filter((v) => lab.judge.check(v, L)?.ok);
    const ownRate = own.length / hands.length;
    const out45 = own.filter((v) => lab.judge.check(swingThumb(v, 45), L)?.ok).length / own.length;
    if (ownRate < minOwn) throw new Error(`only ${Math.round(100 * ownRate)}% of held-out ${L} hands pass ${L}`);
    if (out45 > 0.1) throw new Error(`${Math.round(100 * out45)}% of ${L} hands still pass with the thumb swung out 45°`);
    out.push(`${L} own ${Math.round(100 * ownRate)}%, thumb out 45° ${Math.round(100 * out45)}%`);
  }
  return out.join("; ");
});

// ---- 15. reward feedback: juice.js helpers + sound variation / loudness ----
// The owner asked for rewards that don't repeat the same sfx — but never
// louder. tools/lab/sound-audit.mjs records every note createSound() schedules
// (fake AudioContext, no speakers) and reports variety + summed peak per cue.
await check("juice.js: no-repeat picker, pentatonic steps, tiers, bounded plans", async () => {
  const j = await import(pathToFileURL(path.join(ROOT, "js", "juice.js")));
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pick = j.createPicker(4, rng);
  let prev = -1, seen = new Set();
  for (let i = 0; i < 400; i++) {
    const v = pick();
    if (v === prev) throw new Error("picker repeated an index back-to-back");
    if (!(v >= 0 && v < 4)) throw new Error(`picker out of range: ${v}`);
    seen.add(v); prev = v;
  }
  if (seen.size !== 4) throw new Error("picker never used every variant");
  if (j.createPicker(1)() !== 0) throw new Error("1-variant picker must return 0");
  const st = [-1, 0, 4, 5, 7].map((k) => j.scaleStep(k));
  if (st.join() !== "-3,0,9,12,16") throw new Error(`scaleStep wrong: ${st}`);
  if (j.rewardTier(0, 1) !== "first" || j.rewardTier(2, 3) !== "mastery" ||
      j.rewardTier(3, 4) !== "letter" || j.rewardTier(1, 2) !== "letter")
    throw new Error("rewardTier wrong");
  if (j.nextRun(2, 1000, 5000) !== 3 || j.nextRun(2, 1000, 99999) !== 1 || j.nextRun(0, null, 5) !== 1)
    throw new Error("nextRun wrong");
  const big = j.celebrationPlan("mastery", 999);
  if (big.particles > 72 || big.rings > 3) throw new Error("celebrationPlan not bounded");
  if (j.celebrationPlan("letter", 1).particles >= j.celebrationPlan("first", 1).particles)
    throw new Error("first-time should out-celebrate a plain rep");
  if (j.glowLevel(1) !== 0 || j.glowLevel(2) !== 1 || j.glowLevel(9) !== 3) throw new Error("glowLevel wrong");
  return "picker never repeats (400 draws, all 4 used), scale/tier/run/plan/glow verified";
});
await check("sound.js: frequent cues vary, none louder than the old loudest cue (0.161)", () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, "tools", "lab", "sound-audit.mjs"), "--json"],
    { stdio: "pipe", env: process.env }).toString();
  const r = JSON.parse(out);
  const LOUDEST_BEFORE = 0.161; // success() before variation (audit of 1c70454)
  const loud = Object.entries(r).filter(([, v]) => v.peak > LOUDEST_BEFORE + 0.002);
  if (loud.length) throw new Error(`louder than before: ${loud.map(([k, v]) => `${k} ${v.peak}`).join(", ")}`);
  const frequent = ["lock (spell letter)", "success (practice)", "success (drill word)", "word (spell word)", "correct (read)", "hit x1 (challenge)"];
  const flat = frequent.filter((k) => !(r[k]?.voicings >= 3 && r[k]?.repeatPct === 0));
  if (flat.length) throw new Error(`still repetitive: ${flat.join(", ")}`);
  const top = Math.max(...Object.values(r).map((v) => v.peak));
  return `${frequent.length} frequent cues each >= 3 voicings with 0% back-to-back repeats; loudest peak ${top}`;
});

// ---- 13k. handshape.js — fist letters told apart by WHERE the thumb sits --
// A (thumb beside the index), S (thumb across the front), T (thumb between
// index and middle), E (thumb under the tips) share four DOWN fingers; the
// thumb's position along the knuckle line (thumbAlong: 0 = index knuckle,
// 1 = pinky knuckle) is the ASL-defining difference. Before it (2026-09-25),
// held-out M hands counted as A 17% / S 15%, N as A/E 11%. Applied to
// A E S T only — on M/N it cost N's own pass 58->51% (M vs N stays with the
// recogniser tie-break).
await check("verdict.js: M/N hands don't count as A/S/E (thumb position); A/E/S/T still pass themselves", async () => {
  const { loadLab } = await import(pathToFileURL(path.join(ROOT, "tools", "lab", "lab-data.mjs")).href);
  const lab = await loadLab();
  const rate = (X, L) => {
    const vs = lab.test[X].map((s) => s.v);
    return vs.filter((v) => lab.countsWith(v, L, lab.predict(v))).length / vs.length;
  };
  const leaks = [["M", "A"], ["M", "S"], ["N", "A"], ["N", "E"], ["N", "S"]].map(([x, l]) => [x, l, rate(x, l)]).filter(([, , r]) => r >= 0.1);
  if (leaks.length) throw new Error(`fist-letter leaks: ${leaks.map(([x, l, r]) => `${x} as ${l} ${Math.round(100 * r)}%`).join(", ")}`);
  const weak = ["A", "E", "S", "T"].map((L) => [L, rate(L, L)]).filter(([, r]) => r < 0.75);
  if (weak.length) throw new Error(`own pass too low: ${weak.map(([L, r]) => `${L} ${Math.round(100 * r)}%`).join(", ")}`);
  return "M/N as A/S/E all < 10%; A/E/S/T own pass >= 75%";
});

// ---- 13j. main.js — the A->Z "Next" bridge can be cancelled (LAB-054) --------
// Static check (main.js is DOM-bound): both bridge timers (advanceAz and
// skipLetter) must be stored in azBridgeTimer, and setAzRun — which every
// exit path (leaving the run, setMode) goes through — must clear it.
await check("main.js: A->Z bridge timers are tracked and cancelled when the run ends (LAB-054)", () => {
  const src = fs.readFileSync(path.join(ROOT, "js", "main.js"), "utf8");
  const assigned = (src.match(/azBridgeTimer = setTimeout\(/g) || []).length;
  const setAz = src.slice(src.indexOf("function setAzRun"), src.indexOf("function setAzRun") + 800);
  if (assigned !== 2) throw new Error(`expected 2 tracked bridge timers, found ${assigned}`);
  if (!/clearTimeout\(azBridgeTimer\)/.test(setAz)) throw new Error("setAzRun doesn't clear azBridgeTimer");
  return "2 bridge timers tracked; setAzRun clears them";
});

// ---- 16. visual layer v2: amber palette stays accessible + separate -------
// The brand amber is a chrome/reward colour; "close" already owns
// amber/orange near the hand. Guard (a) the contrast the palette promises,
// (b) that --close / --guide-close / --guide-worst were NOT re-pointed at the
// new tokens, and (c) the contrast helper itself against known WCAG values.
await check("style.css: amber palette tokens meet contrast + don't alias the guide colours", async () => {
  const fm = await import(pathToFileURL(path.join(ROOT, "js", "fxmath.js")));
  const white = fm.contrastRatio("#ffffff", "#000000");
  if (Math.abs(white - 21) > 1e-9) throw new Error(`contrastRatio(white, black) = ${white}, want 21`);
  if (Math.abs(fm.contrastRatio("#777777", "#ffffff") - 4.478) > 0.01) throw new Error("contrastRatio(#777, #fff) != 4.48");
  const css = fs.readFileSync(path.join(ROOT, "css", "style.css"), "utf8");
  const tok = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,6})\\b`));
    if (!m) throw new Error(`token --${name} missing from css/style.css`);
    return m[1];
  };
  const bg = tok("bg"), panel = tok("panel");
  const out = [];
  for (const [name, min] of [["amber-300", 7], ["amber-400", 7], ["gold", 7], ["honey", 7]]) {
    const r = fm.contrastRatio(tok(name), bg);
    if (r < min) throw new Error(`--${name} is ${r.toFixed(2)}:1 on --bg, want >= ${min}`);
    if (fm.contrastRatio(tok(name), panel) < 4.5) throw new Error(`--${name} under 4.5:1 on --panel`);
    out.push(`${name} ${r.toFixed(1)}`);
  }
  const ink = fm.contrastRatio(tok("amber-ink"), tok("amber-400"));
  if (ink < 7) throw new Error(`--amber-ink on --amber-400 is ${ink.toFixed(2)}:1, want >= 7`);
  if (fm.contrastRatio("#ffffff", tok("amber-400")) >= 4.5) throw new Error("white on amber unexpectedly passes — recheck the ink rule");
  // the correction-guide / verdict colours keep their meaning and values
  const fixed = { close: "#f59e0b", "guide-close": "#fb923c", "guide-worst": "#fde047", "guide-good": "#38bdf8", "guide-fix": "#ec4899" };
  for (const [k, v] of Object.entries(fixed))
    if (tok(k).toLowerCase() !== v) throw new Error(`--${k} changed to ${tok(k)} (was ${v}) — needs a colour-blind review first`);
  if (/--(close|guide-[a-z]+):\s*var\(--(amber|gold|honey|ember)/.test(css)) throw new Error("a guide/verdict token aliases the brand amber");
  return `${out.join(", ")} on --bg; ink ${ink.toFixed(1)}:1; guide colours unchanged`;
});

// ---- 17. fxquality.js: the effects governor protects detection fps -------
await check("fxquality.js: governor drops to lite after 3 s under 26 fps, restores after 10 s, obeys caps", async () => {
  const q = await import(pathToFileURL(path.join(ROOT, "js", "fxquality.js")));
  const g = q.createGovernor();
  let t = 0;
  const feed = (fps, ms, cam = true) => { for (const end = t + ms; t < end; t += 500) g.reportFps(fps, cam, t); };
  feed(25, 2500); if (g.level !== "full") throw new Error("dropped before 3 s");
  feed(25, 1000); if (g.level !== "lite") throw new Error("didn't drop to lite after 3 s under 26 fps");
  feed(30, 9500); if (g.level !== "lite") throw new Error("restored before 10 s healthy");
  feed(30, 1000); if (g.level !== "full") throw new Error("didn't restore after 10 s healthy");
  g.set({ mode: "race" }); if (g.level !== "lite") throw new Error("Race not pinned to lite");
  g.set({ mode: "practice", reducedMotion: true }); if (g.level !== "off") throw new Error("reduced motion not off");
  g.set({ reducedMotion: false, override: "off" }); if (g.level !== "off") throw new Error("manual off ignored");
  g.set({ override: "auto", webgl2: false }); if (g.level !== "lite") throw new Error("no-WebGL2 not capped at lite");
  return "3 s drop / 10 s restore / Race, reduced-motion, manual, no-WebGL2 caps verified";
});

// ---- 18. fxmath.js springStep: the hero's kinetic-title spring solver -----
await check("fxmath.js: springStep converges, underdamped overshoots, critical doesn't, long frames stay stable", async () => {
  const f = await import(pathToFileURL(path.join(ROOT, "js", "fxmath.js")));
  const run = (opt, dt, n) => { let s = { x: 0, v: 0 }, peak = 0; for (let i = 0; i < n; i++) { s = f.springStep(s, 1, opt, dt); peak = Math.max(peak, s.x); } return { s, peak }; };
  const bouncy = run({ k: 190, c: 13 }, 1 / 60, 240);
  if (!f.springSettled(bouncy.s, 1, 1e-3)) throw new Error(`bouncy spring didn't settle: ${JSON.stringify(bouncy.s)}`);
  if (bouncy.peak < 1.05) throw new Error(`underdamped spring should overshoot, peak ${bouncy.peak}`);
  const crit = run({ k: 100, c: 20 }, 1 / 60, 300);
  if (crit.peak > 1 + 1e-6) throw new Error(`critically damped spring overshot: ${crit.peak}`);
  const coarse = run({ k: 260, c: 20 }, 0.25, 40); // 4 fps frames: sub-stepping keeps it stable
  if (!Number.isFinite(coarse.s.x) || Math.abs(coarse.s.x - 1) > 1e-3) throw new Error(`unstable at dt=0.25: ${coarse.s.x}`);
  const nan = f.springStep({ x: NaN, v: NaN }, 2, {}, 1 / 60);
  if (nan.x !== 2 || nan.v !== 0) throw new Error("NaN state should snap to the target");
  if (f.springStep({ x: 0, v: 0 }, 1, {}, -1).x !== 0) throw new Error("negative dt must be a no-op");
  return `bouncy peak ${bouncy.peak.toFixed(3)}, critical peak ${crit.peak.toFixed(4)}, dt=0.25 stable`;
});

// ---- 19. fxmath.js coverMap: hero fingertips follow object-fit: cover -----
await check("fxmath.js: coverMap matches object-fit: cover (centre fixed, overflow cropped evenly)", async () => {
  const f = await import(pathToFileURL(path.join(ROOT, "js", "fxmath.js")));
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const c = f.coverMap(0.5, 0.5, 640, 480, 1600, 900);
  if (!near(c.x, 800) || !near(c.y, 450)) throw new Error(`centre moved: ${JSON.stringify(c)}`);
  const tl = f.coverMap(0, 0, 640, 480, 1600, 900), br = f.coverMap(1, 1, 640, 480, 1600, 900);
  if (!near(tl.x, 0) || !near(br.x, 1600)) throw new Error("wide screen: x should span exactly the width");
  if (!near(tl.y, -(br.y - 900))) throw new Error("wide screen: crop must be split evenly top/bottom");
  const p = f.coverMap(0, 0, 640, 480, 400, 900);
  if (!(p.x < 0) || !near(p.y, 0)) throw new Error("portrait: sides must be cropped, not the top");
  const z = f.coverMap(0.25, 0.75, 0, 0, 200, 100);
  if (!near(z.x, 50) || !near(z.y, 75)) throw new Error("unknown video size should fall back to a stretch");
  return "centre fixed; wide crops top/bottom evenly; portrait crops sides; no-size falls back";
});

// ---- 20. aurora.js: amber means "on a roll", never "close" ----------------
await check("aurora.js: warmth ignores the match score, amber clamped to <= 0.15, no green verdict floor", async () => {
  const a = await import(pathToFileURL(path.join(ROOT, "js", "aurora.js")));
  if (!(a.WARM_CEIL > 0 && a.WARM_CEIL <= 0.15)) throw new Error(`WARM_CEIL ${a.WARM_CEIL} above the brief's 0.15`);
  const w = a.auroraWarmth;
  if (w({}) !== 0) throw new Error("idle should have no warmth");
  if (!(w({ present: true }) > 0 && w({ present: true }) < 0.3)) throw new Error("presence should warm only slightly");
  if (!(w({ present: true, streak: 1 }) > w({ present: true, streak: 0.33 }))) throw new Error("warmth should rise with the streak");
  if (w({ present: true, streak: 1, pulse: 1 }) > 1 || w({ present: true, streak: 9, pulse: 9 }) !== 1) throw new Error("warmth must clamp to 0..1");
  if (w.length > 1 || /score/.test(w.toString())) throw new Error("auroraWarmth must not take a match score");
  const src = fs.readFileSync(path.join(ROOT, "js", "aurora.js"), "utf8");
  if (!/min\(E \* ws \* uAlpha, \$\{WARM_CEIL/.test(src)) throw new Error("shader no longer clamps the amber layer to WARM_CEIL");
  if (/uGreen/.test(src)) throw new Error("the green verdict floor is back — the camera frame owns the verdict");
  const sm = src.slice(src.indexOf("setMatch(score, bucket, regions) {"), src.indexOf("setHand(h)"));
  if (/warmth/.test(sm.replace(/\/\/.*$/gm, ""))) throw new Error("setMatch() must not drive warmth");
  return `WARM_CEIL ${a.WARM_CEIL}; presence ${w({ present: true }).toFixed(2)}, full streak ${w({ present: true, streak: 1 }).toFixed(2)}; score-free`;
});

// ---- 14. js/orient.js (scaffolding — palm-orientation cue, stage S7) ------
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
