# Garelier PM Scout Findings Reference

#### 13.1.D "Show me Scout's findings" (Scout completion query)

Triggered by phrases like "scout-01 の成果", "show scout's results",
"スカウトの調査見せて", "scout の完了済", "what did the scout
find", "any inspections from <topic>".

Per DEC-008, Scout never commits its own inspection — PM commits
the accepted copy after Dock review. So "what has Scout
finished?" is a PM question, not a manifest question. Use this
authoritative chain (do NOT trust only `runtime/manifest.md`,
which can lag the file-level truth):

1. **Live state** — Read `__garelier/<pm_id>/_scouts/<id>/STATE.md`:
   - `WORKING` → tell the user it's still in progress; quote
     `## Last activity` so they see the latest sub-step.
   - `REPORTING` → draft is ready, awaiting PM commit. Locate the
     intake item: `runtime/pm/inbox/<ts>-scout-intake-<task_id>.md`
     (per DEC-008). If you haven't processed it yet, this is the
     prompt to do so before answering.
   - `IDLE` → previous task complete. Find its archive.
   - `BLOCKED` → Scout has a question; show `questions.md` content
     and ask the user to resolve.
2. **Recent commits** — `git log --grep "scout" --oneline -20` on
   studio shows your past Scout-related commits. For a specific
   task: `git log --all -- __garelier/<pm_id>/control/inspections/`
   and grep for the topic. The commit messages should include the
   task id and scout id (PM commits them per DEC-008 step 3).
3. **Archived assignments** — `__garelier/<pm_id>/runtime/backlog/done/`
   contains completed task records. For each Scout task, the entry
   names the inspection path. If retention has moved older entries,
   also check `_pm/history.md` (and its monthly archive under
   `_pm/history/archive/YYYY-MM.md` per DEC-009).
4. **Direct file display** — When the user wants the actual content,
   `Read` the inspection file at the resolved path and quote the
   first 30-60 lines plus the executive summary. If the inspection
   is large (a monthly summary or long dump), prefer the summary
   section; mention the full path so the user can open it.

Output template (compact):

```
=== Scout scout-01 completion query ===
Current state:    IDLE (last task #23 closed 2026-05-25T16:42Z)
Last inspection:  __garelier/<pm_id>/control/inspections/tech/2026/05/2026-05-25-dependency-ecosystem-status.md
                  committed: 2d34a598 by PM (2026-05-25)
Open work:        (none / Task #N WORKING — last activity Xm ago)
Pending intake:   (none / runtime/pm/inbox/<ts>-scout-intake-<task>.md awaiting your review)

Recent Scout deliveries (last 5):
  #23 2026-05-25  dependency-ecosystem-status  inspections/tech/2026/05/...
  #18 2026-05-20  perf-baseline-Q2       inspections/benchmark/2026/05/...
  ...
```

If the user wants the *content* of a specific inspection, show the
first ~30 lines (or the `## Executive summary` block) and offer to
display more.

**Critical: "I've seen it, delete it / 見たから消して" handling.**

When the user says they've seen / consumed an inspection and asks to
remove or clean it up, the safe default is:

- **Do nothing destructive to git history.** Inspections are
  immutable historical records (Scout SKILL §3, DEC-008). The
  committed studio commit must stay in history; an inspection that
  the user has acknowledged is the same as an inspection they
  remember from yesterday — a permanent record. Future re-execution
  searches and audit trails depend on it.
- **Do NOT `git revert <inspection-commit>`.** Reverting a Scout
  inspection commit is wrong by default; it pollutes studio history
  with a noise revert and loses the durable record. Only revert if
  the user explicitly says "revert the commit" AND the inspection
  is provably incorrect (e.g., contained sensitive data committed
  by mistake, or factual errors that make it dangerous to keep
  around).
- **Do NOT stop any running producer.** "I've seen it" is a
  per-file acknowledgement, not a system stop signal. In-flight
  dispatches keep running. If the user wants to stop work, they will
  use the explicit phrases listed in §13.2 (Clean stop).

What you MAY do when the user says "見たから消して":

1. Acknowledge: "Inspection #N is on record at <studio commit SHA>.
   The on-disk file in the Scout's worktree is just a draft copy
   that gets archived to `_scouts/<id>/archive/<task_id>/` on the
   Scout's next IDLE transition — there's nothing left for me to
   actively delete."
2. If the user is concerned about clutter in their working tree
   listing: confirm the inspection's permanent home is the studio
   commit, and that no further action is needed. If they still want
   the file removed from CURRENT (not history), check with them
   that the studio commit is the canonical version, then `git rm`
   + commit ON STUDIO. Do NOT use revert.
3. Confirm Scout's REPORTING → IDLE transition will fire on next
   Scout iteration via the `committed.md` mechanism (DEC-008).
   You don't need to do anything special — Dock already wrote
   the trigger when it processed the intake.

If the user *really* wants the inspection rolled back from studio
history (rare, e.g., it contained secrets or was committed by
mistake), confirm with explicit yes/no questioning, then use
`git rm` + commit (preserves history showing it existed; commits a
deletion). Reserve `git revert` for cases where the user explicitly
says "revert" — and even then, double-check it's not a Scout
inspection (which is supposed to be immutable).
