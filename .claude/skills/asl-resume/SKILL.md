---
name: asl-resume
description: Reconstruct exactly where the Asl Claude Code project was left off — reads the plan doc's resume block, the active stage plan, project memory, and uncommitted git state. Use at the start of a session on this project, after a crash/interruption, or when the user asks "where did we leave off" / "catch me up" / "resume".
---

# ASL project resume

A prior session on this repo may have ended abruptly (crash, closed terminal,
interruption) with work mid-flight. Reconstruct state from durable sources —
never assume anything from conversation memory alone, since a fresh session
has none. Do all of the following, then synthesize one summary; don't just
dump raw output.

## 1. Read the sources of truth, in this order

1. `asl-letter-recognition-plan.md` — the top "Session resume — read first"
   block, and its dated "Revision history" tail (most recent entries).
2. Whatever active stage-plan file that resume block points to (currently
   `C:\Users\maila\.claude\plans\twinkly-floating-garden.md` — but check the
   pointer, it may have changed) — read its "Decisions already made" table and
   the tail of its progress log to find the current stage.
3. Project memory: `MEMORY.md` in this project's memory directory, then the
   linked `asl-project.md` (or equivalent) memory file for the fullest recent
   narrative.

## 2. Cross-check against live repo state

- `git log --oneline -15` — does the last commit match what memory/plan docs
  say was last shipped? If not, memory is stale — trust git.
- `git status` and `git diff --stat` — any uncommitted changes at all?
- If there's an uncommitted diff: read it in full (`git diff -- <files>`) and
  identify which backlog/bug-report/plan item it implements by matching its
  behavior against the plan doc's open items and any `Bug Reports/` files —
  don't just describe the diff mechanically, name *what it's for*. Read the
  diff to understand it, but never quote it verbatim back to the user —
  the final summary describes what it does in prose, not as pasted code/diff.
- Check `Bug Reports/` (or similarly named QA-notes folders) for any items not
  yet reflected in the plan doc's status.

## 3. Report back

One concise summary covering:
- What was last shipped (commit + one line on what it did).
- What's currently uncommitted, if anything, and whether it looks complete
  (would pass `asl-verify`) or half-built.
- What the plan says is next.
- Any bug-report / QA items still open and unaddressed.

Do not start making changes — this skill only reconstructs context. Suggest
running `asl-verify` next if there's finished-looking uncommitted work.
