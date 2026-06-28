# Garelier PM Blueprint Re-execution Reference

## §12. Re-executing a past blueprint

The user may want to repeat a previously-completed blueprint —
typically for periodic work like "run a full test pass" or "regenerate
the status report". This is also the mechanism that pairs with Claude
Code's `/loop` command to schedule recurring runs without baking a
scheduler into Garelier.

### 12.1 Trigger

Phrases that mean "re-execute":

- "re-run #042"
- "do that test pass again"
- "rerun the status report"
- "run #017 again"

If the user names a blueprint by topic but not number, search
history.md for a matching blueprint and confirm with the user before
proceeding.

### 12.2 Process

1. **Find the original entry** in `__garelier/<pm_id>/_pm/history.md`; if
   missing, search `__garelier/<pm_id>/_pm/history/archive/*.md`. If the
   blueprint is in
   `__garelier/<pm_id>/control/blueprints/archive/<slug>.md`, read it from
   there. If still in `__garelier/<pm_id>/control/blueprints/<slug>.md`,
   read it there.
2. **Compute a new slug** by appending a numeric suffix:
   - If `<slug>` has no suffix: `<slug>-2`
   - If `<slug>` ends with `-N`: `<slug>-(N+1)` where the new N is
     the smallest integer such that
     `__garelier/<pm_id>/control/blueprints/<new-slug>.md` and
     `__garelier/<pm_id>/control/blueprints/archive/<new-slug>.md` both do
     not exist.
   - Examples: `auth-refactor` → `auth-refactor-2` →
     `auth-refactor-3`. `status-report-2` → `status-report-3`.
3. **Copy the original blueprint** to
   `__garelier/<pm_id>/control/blueprints/<new-slug>.md`.
4. **Update its Context section** to add a line:
   `Re-execution of #<original-id> (original blueprint: <original-slug>).`
   Update any time-bound details (dates, branch names, snapshot
   references) that need to refresh.
5. **Confirm the milestone** with the user. The original blueprint's
   milestone may be shipped already; ask which milestone the
   re-execution belongs under (or whether to create a new one).
6. **Show the modified blueprint to the user** and iterate until
   approved.
7. **Append a new entry to `__garelier/<pm_id>/_pm/history.md`** linking the
   new blueprint and noting the re-execution origin.
8. **Commit** as in §4.1 step 8.

### 12.3 Handling a still-running re-execution

If the user requests another re-execution of #N while a previous
re-execution (say #N+5, with slug `<slug>-2`) is still
`in-progress`, ask the user:

- Wait for the current run to finish before starting a new one?
- Run a new instance in parallel (creating `<slug>-3`)?
- Abort the current run (§13) and start fresh?

Do not silently start a parallel run. Re-runs of the same work in
parallel almost always indicate a misunderstanding.

### 12.4 Periodic triggers

Periodic re-execution is triggered externally. There are two supported
contracts:

- The user uses `/loop` (Claude Code's repeat-prompt capability) with
  a prompt like "re-run #042". On each loop iteration, PM treats it as
  a fresh re-execution request via §12.2.
- The project defines an RRULE job in
  `__garelier/<pm_id>/control/scheduled_jobs/<job_id>.toml`; an external
  scheduler notifies PM at the configured time.

Garelier owns the job definition and safety policy, not the clock.
