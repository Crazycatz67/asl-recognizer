---
name: asl-bugwatch
description: Maintain and work through Bug Reports/checklist.md, this project's persistent bug tracker, and regression-check changes against it. Use when asked to check for bugs/regressions before or after a change, update the bug list, see what's still open, pick the next bug to work on, or fold new QA feedback into the tracker.
---

# ASL project bug tracking

`Bug Reports/checklist.md` is the durable task-clipboard for known issues —
not a one-off report that goes stale. Treat it as a living document: read it,
update it in place, never spawn a parallel tracking file.

## Picking the next item to work

If asked "what's next" / "check the bug list" with no specific item named:
read `checklist.md` and propose the highest-priority still-`OPEN` item, in
this order:
1. A confirmed code bug with an offline-verifiable fix (no camera needed).
2. A confirmed architecture gap that needs a real design decision from the
   owner before touching code.
3. Something that needs live camera/device data before any fix is safe to
   attempt (say so explicitly — don't guess-fix these).
4. Something already deliberately deferred to a planned stage in the active
   plan doc — lowest priority here, it's already scheduled elsewhere.

## Investigating an item

Before writing any fix: read the actual code the item implicates — don't
guess a root cause from the symptom description alone. Prefer a fork/subagent
for broad investigation across many files so raw exploration doesn't fill the
main conversation; only the root-cause finding + file:line evidence needs to
come back.

If a claimed bug turns out to already be handled correctly in code (this
project has hit this before — see `CLAUDE.md`'s gotcha about verifying gaps
against the code first), mark it `NOT A BUG` with the evidence, don't leave it
`OPEN` indefinitely just because it was reported.

## Verifying a fix (before marking anything FIXED)

Run the same regression discipline as `asl-verify` — `node tools/ci-check.mjs`
green, `tools/selftest.html` at 100% pass with zero new failures. Add a new
regression check to `selftest.js` for the specific bug when the root cause is
a logic/threshold mismatch (see `checklist.md` item 8's `matchTolerance`
check for the pattern) — a fix without a regression check can silently regress
again later.

**Never mark an item plain `FIXED` if it touches live-camera-only behavior**
(anything gated by `facingMode`, `handTracker`, frame rate/timing, or noted in
`[[asl-verify-limits]]`). Use `FIXED (needs live confirm)` instead, and say
explicitly what the owner needs to check on a real device.

## Updating the checklist

After investigating or fixing an item, edit its entry in place:
- Status line at the top of the item (`OPEN` → `FIXED (verified offline)` /
  `FIXED (needs live confirm)` / `NOT A BUG` / `DEFERRED (planned stage)`).
- One or two sentences of evidence: root cause with file:line, what was
  checked, and the commit hash once it's actually committed (update the
  placeholder if the item was written before the commit existed).
- Keep entries terse — this is a checklist, not a narrative. Long
  investigation detail belongs in the commit message, not here.

## Folding in new QA feedback

When a new bug-report file appears in `Bug Reports/`, don't leave it as a
separate list — read it, add any genuinely new items to `checklist.md` in the
right section (or a new section), and check whether it duplicates/confirms an
existing entry rather than creating a second tracking line for the same bug.

## Token discipline

Don't paste the full checklist file into the conversation on every check-in —
summarize only the item(s) relevant to the current question (e.g. "here's
what's still open" → list titles + status only, not the full evidence text).
