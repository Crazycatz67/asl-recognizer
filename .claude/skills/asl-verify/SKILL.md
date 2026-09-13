---
name: asl-verify
description: Run this project's full verify-and-ship ritual (ci-check.mjs, selftest.html 164 checks, VERSION bump, commit, push, CI confirm) after any js/css/html change in the Asl Claude Code repo. Use when the user asks to verify, test, ship, or deploy a change, or before ending a work session with uncommitted changes.
---

# ASL project verify-and-ship

This project's standing discipline (see `CLAUDE.md` and
`asl-letter-recognition-plan.md`) is: verify → bump VERSION → commit → push →
confirm CI green, **one stage at a time, never batched**. This skill executes
that ritual mechanically so it doesn't have to be re-derived by hand each time.

Run every step below in order. Stop and report if any step fails — do not
proceed to commit/push on a failure.

**Token discipline:** `ci-check.mjs` and `selftest.html` both produce long,
mostly-identical PASS listings every run. Never paste the full listing into
the conversation. Report only: the pass count, whether it's ALL PASS/PASSED,
and the full text of any FAIL/error lines (there should be none). If this
verification is delegated to a fork/subagent, only its pass/fail verdict and
any failures should come back to the main thread — not the raw transcript.

## 1. Static check (fast, no browser needed)

```
node tools/ci-check.mjs
```

Must print `ALL CHECKS PASSED`. This already includes the VERSION-bump-vs-
`origin/main` check, dependency-free syntax checks, `sw.js` CORE-list
integrity, and dataset/id/reference-photo well-formedness. If it fails on the
VERSION check, bump `sw.js`'s `VERSION` constant (any core `js/`/`css/`
change requires a bump) and re-run.

## 2. Live selftest (needs the dev server + a browser)

1. Check if the dev server is already up: `curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/` — if not 200, start it in the background: `powershell -File serve.ps1` (or `.\serve.ps1`), then wait ~2s.
2. Load the Chrome tools if not already loaded (`ToolSearch` for
   `mcp__claude-in-chrome__tabs_context_mcp,navigate,get_page_text,tabs_create_mcp,tabs_close_mcp`).
3. Open a tab, navigate to `http://localhost:8000/tools/selftest.html`,
   `get_page_text`, and confirm the header reads `164 checks — ALL PASS ✅`
   (the count may grow over time — the key is **zero FAIL lines** and the
   header's count matching the number of PASS lines).
4. If anything failed, quote the failing line(s) verbatim and stop — do not
   guess a fix blindly; this suite is the only real regression net.
5. Close the tab when done.

If the change touches live-camera-only behavior (anything gated by
`facingMode`, `handTracker`, or noted in `[[asl-verify-limits]]`), say so
explicitly — this suite and this environment cannot exercise a real webcam,
so that part stays unverified until a real device checks it.

## 3. Commit

- `git status` / `git diff --stat` to see exactly what's staged.
- Stage only the files actually part of this change (never blanket `git add -A`
  without checking).
- Write a commit message in this repo's established style: a one-line
  present/imperative summary naming the stage or bug fixed, then a body
  explaining *why* (what tester feedback or plan item this addresses) and the
  *root cause* for bug fixes — see recent commits (`git log -5`) for tone.
  Do not add the Co-Authored-By/session lines yourself; the harness appends
  those automatically from the system reminder.

## 4. Push and confirm CI

Only after explicit user confirmation to push (per standing safety rules —
this skill does not waive that). Once pushed:

```
gh run list --limit 3
```

Confirm the new run is green (or wait/check again — don't declare success on
a queued/in-progress run). If it fails, `gh run view --log-failed` to see why
before touching anything further.

## Notes

- This skill assumes Windows/PowerShell for `serve.ps1`; adapt the invocation
  if run from a different shell.
- `tools/sweep-transition.mjs` is a separate, optional tool for
  `transition.js` threshold changes only — not part of this default ritual.
