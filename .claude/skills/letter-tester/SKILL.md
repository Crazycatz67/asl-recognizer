---
name: letter-tester
description: Per-letter accuracy pipeline for the ASL recognizer — a background tester agent measures exactly which hand shapes / movements make each letter register and where each letter fails, writes docs/lab/letters/REPORT.md; a second agent reads that report + the recognition code and builds faster, better-structured fixes for those exact failures in an isolated worktree; the main session verifies, checks the bug report, and ships. Use when the owner says "run the letter tester", "test each letter's accuracy", "why does letter X fail", "optimise recognition per letter", or asks for a per-letter accuracy report.
---

# Letter tester — measure each letter → fix its exact failures → verify → ship

Owner request (2026-09-25): "run an agent in the background that tests for
accuracy and reports the data per letter — exactly when and what hand
structures and movements register each letter correctly, and exactly when and
what parts each letter struggles with — then feed that into another agent that
looks through the code and recognition for each letter and finds a more
optimized, structured way that is faster and combats the exact errors, then
run that back to you to verify and test and look through the bug report."

Three stages, strictly in order. Stage 1 and 2 run as background agents
(Agent tool, `run_in_background: true`); stage 3 is the main session.

**Honest boundary:** no real webcam. "Registers" = the SHIPPED pipeline
(normalize → either-hand kNN → REJECT_DIST → heads → js/verdict.js
judgeLetter, and js/spellgate.js for Spell) driven by held-out REAL dataset
hands (tools/lab/lab-data.mjs, blocked 80/20 split) and physical synthetic
perturbations (tools/synth-hand.js). Every number says what it measured;
camera feel stays "needs live confirm".

Node isn't on PATH: `N="/Applications/Visual Studio Code.app/Contents/MacOS/Code"`,
run scripts as `ELECTRON_RUN_AS_NODE=1 "$N" <script>`.

## Why it's fast (keep it that way)
- ONE script does the measuring: `tools/lab/letter-report.mjs`. Agents run it,
  they don't re-derive the analysis. `--letters ABC` scopes a run to a few
  letters (seconds, not minutes); a full run should stay under ~3 minutes.
- Deterministic (seeded RNG), so before/after diffs are real, not noise.
- Machine-readable output first (`docs/lab/letters/report.json`), prose
  second (`REPORT.md`); stage 2 reads the JSON, not logs.
- `--compare old.json` prints only what moved (per letter, per failure mode).
- Reuse, don't duplicate: probe-thresholds (room for error / wrong shape),
  spell-letters (Spell timing), break-it (robustness), issues.mjs (store).

## Stage 1 — Letter tester agent (background, READ-ONLY on app code)
Spawn with this brief (fill in scope):

> Run (build first if missing — see "Report contract" below)
> `tools/lab/letter-report.mjs [--letters <scope>]`, save the previous
> `docs/lab/letters/report.json` as `report.prev.json` first. For each letter
> write, from the numbers: what registers it (trait ranges that pass, the
> tolerated tilt/rotation/distance/finger-bend/thumb/spread envelope, J/Z
> stroke size/speed/direction), and exactly where it struggles (ranked failure
> modes with % and the stage that rejects it: trait / recogniser confusion /
> non-letter rejection / Spell timing), plus 1-2 concrete hypotheses per weak
> letter pointing at code (file:line). Log every P0/P1 via
> tools/lab/issues.mjs upsertIssue (key `letter-<L>-<mode>`). Do not edit
> js/. Return a <= 500-word summary + the paths.

## Stage 2 — Recognition optimiser agent (background, `isolation: "worktree"`)
Only after stage 1's report exists on main (merge its tooling/report commit
first — docs + tools only, low risk). Brief:

> Read docs/lab/letters/report.json + REPORT.md and the recognition code
> (js/normalize.js, js/knn.js, js/heads.js, js/handshape.js, js/verdict.js,
> js/motion.js, js/spellgate.js, js/stabilizer.js, main.js's classify path).
> For the worst letters/failure modes, find changes that are (a) faster
> (fewer passes / allocations / duplicate classify calls per frame) and
> (b) more accurate on exactly those failures, and (c) better structured
> (one clear place per decision). Rules: thresholds stay DATA-CALIBRATED
> (percentiles of real signers, never hand-picked); a letter's defining
> traits are ASL knowledge — write why; no new dependencies. Every change:
> before/after from `letter-report.mjs --compare`, no letter's own pass may
> drop > 3 pts, no cross-letter pair may exceed ci-check #13f's 30%, and a
> regression check in tools/ci-check.mjs or tools/selftest.js. Also time the
> per-frame classify cost before/after. Commit small on your branch; do NOT
> push/merge/bump sw.js VERSION. Return: branch, commits, the before/after
> table, speed numbers, and anything unverifiable.

## Stage 3 — Main session: verify, bug report, ship
1. Merge the optimiser branch into main (resolve docs conflicts by keeping both).
2. `tools/ci-check.mjs` all pass; selftest at http://localhost:8000/tools/selftest.html zero FAIL.
3. Re-run `letter-report.mjs --compare docs/lab/letters/report.prev.json` on the
   merged code — the agent's numbers must reproduce. Also `probe-thresholds.mjs`
   and `spell-letters.mjs --pipe ring` for no regressions.
4. Bug report: read `Bug Reports/checklist.md` open items + `docs/lab/ISSUES.md`;
   mark what this fixed (issues auto-resolve on a full lab run), add a
   checklist item for the pass, keep camera-dependent items "needs live confirm".
5. Bump `sw.js` VERSION, CHANGELOG entry (what moved, why), commit, push
   (standing approval for verified stages), confirm CI green, remove the worktree.
6. Tell the owner: per-letter before/after, speed change, what still needs a camera.

## Report contract (`tools/lab/letter-report.mjs`)
Per letter L, `report.json.letters[L]`:
- `own`: pass rate of held-out L hands under the shipped verdict; `n`.
- `rejectedBy`: { traits: {<trait>: {rate, dir: "low"|"high"}}, recogniser:
  {<X>: rate}, nonLetter: rate } — WHY L's own hands fail, by stage.
- `registers`: the passing envelope — per defining trait its [lo, hi] and the
  median of passing hands; tolerated tilt°, in-plane rotation°, scale
  (distance) range, per-finger bend°, thumb swing°, spread — the level at
  which the pass rate halves (reuse probe-thresholds' axes).
- `acceptedAs`: other letters' real hands that count as L (rate) — false accepts.
- `motion` (J, Z): pass rate by stroke size, speed, direction, and start
  shape held/not held.
- `spell`: ring pipeline correct / wrong / missed for L in context (reuse
  spell-letters.mjs), and median time-to-enter.
- `struggles`: ranked [{mode, rate, stage, hint}] — the plain-English "where L
  fails".
Top level: `generated`, `commit`, `split`, `speed` (ms per classify, per
judgeLetter, per frame-equivalent), `worst` (letters sorted by own pass).
REPORT.md renders the same: a summary table, then one short section per
letter ("Registers when … · Struggles when …").
