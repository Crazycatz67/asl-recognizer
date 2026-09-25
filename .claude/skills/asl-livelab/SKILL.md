---
name: asl-livelab
description: Run the ASL Live-Lab loop — probe every letter's room for error and false accepts, hunt bugs, log everything to docs/lab/issues.json, fix on the local shadow site, verify, then ship. Use when the owner says "run the lab", "test the thresholds", "find what's broken", "tune the letters", or asks for background testing / a test-fix loop.
---

# ASL Live-Lab — test → find → fix → ship

The owner's standing request (2026-09-24): a formal loop where background
agents find per-letter error thresholds and every way to break the app, store
it all in one document, and fixes get made and shipped from it.

**Owner decisions:** run a cycle when asked ("run the lab"), not continuously.
Agents change code ONLY on the `shadow` branch (worktree `../asl-shadow`,
served at http://localhost:8010). The main session verifies, merges, pushes.
The live site never gets unreviewed changes.

**Honest boundary:** nothing here uses a real webcam. "Live" = the shipped
code (js/verdict.js etc.) driven by held-out REAL dataset hands and synthetic
hands (tools/synth-hand.js). Every report says what it measured; camera
behaviour stays "needs live confirm" until the owner tests it.

Node isn't on PATH on the Mac: `N="/Applications/Visual Studio Code.app/Contents/MacOS/Code"`
and run scripts as `ELECTRON_RUN_AS_NODE=1 "$N" <script>`.

## 1. Sync the shadow
```
git -C ../asl-shadow merge --ff-only main   # or: git worktree add ../asl-shadow -b shadow
(cd ../asl-shadow && python3 -m http.server 8010 --bind 127.0.0.1)   # background, if not running
```

## 2. Probe (writes the stored document)
```
ELECTRON_RUN_AS_NODE=1 "$N" tools/lab/probe-thresholds.mjs   # -> docs/lab/THRESHOLDS.md, thresholds.json, issues.json
ELECTRON_RUN_AS_NODE=1 "$N" tools/lab/break-it.mjs          # -> issues.json (if present)
ELECTRON_RUN_AS_NODE=1 "$N" tools/lab/issues.mjs            # re-render docs/lab/ISSUES.md
```
Every finding goes through `upsertIssue()` (tools/lab/issues.mjs): deduped by
`key`, severity P0–P3, status open → fixing → fixed-offline / needs-live /
wontfix, with a repro command.

## 3. Triage
P0 = wrong letters accepted (>15% of a letter's real hands) or a crash ·
P1 = a letter too strict (own pass < 75%, breaks at ≤10° tilt or light jitter)
or a stuck state · P2 polish · P3 idea. Work P0 then P1. Promote P0/P1 into
`Bug Reports/checklist.md` (asl-bugwatch rules).

## 4. Fix (on the shadow)
One issue per commit on `shadow`. Every fix: measured before/after on the
probe, a regression check (tools/ci-check.mjs or tools/selftest.js), and the
issue's status updated. Thresholds stay DATA-CALIBRATED (percentiles of real
signers in js/handshape.js) — never a hand-picked magic number; a letter's
defining traits (TRAITS in js/handshape.js) are ASL knowledge, write why.

## 5. Verify
`tools/ci-check.mjs` all pass (includes #13e handshape, #13f no cross-letter
pair > 30%), selftest at http://localhost:8010/tools/selftest.html when the
Chrome extension is connected (say "selftest not run" otherwise), re-probe
the touched letters.

## 6. Report
To the main session / owner: the numbers that moved, what changed, what still
needs a real camera. No raw logs.

## 7. Ship (main session only)
Merge `shadow` → `main`, bump `VERSION` in sw.js, commit (why + before/after),
push (standing approval for verified stages), confirm CI green, update
`Bug Reports/checklist.md`, `docs/CHANGELOG.md`, and issue statuses.
