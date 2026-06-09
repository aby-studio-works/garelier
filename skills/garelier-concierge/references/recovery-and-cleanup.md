# Concierge reference: recovery (reconcile) + archive/IDLE cleanup

> Moved from `SKILL.md` (DEC-032): crash/restart-safe reconcile-before-
> re-attempt (§10.5) and archive/IDLE cleanup (§11).

## §10.5 Recovery — reconcile before re-attempting (crash / restart safe)

External operations are **not freely re-runnable** (a push, a PR, a release are
side effects). So on pickup, if your state is not a clean `IDLE`/`ASSIGNED`, or a
a **stale** target lock (dead pid) under `runtime/concierge/locks/` exists, or a prior run may have been
interrupted, you **reconcile first** — check the live external state against the
operation's intended end state **before** doing anything:

1. **Reclaim the lock if stale.** A live lock held by another Concierge → BLOCK.
   A stale lock (dead pid) → reclaim it; a genuinely inconsistent lock → surface
   to PM (do not delete another op's lock).
2. **Check whether the operation already landed**, per kind:
   - `promote_target`: `git fetch origin`; if `<target>` tip already contains the
     studio merge (it equals the report's `target_after_sha`, or `git merge-base
     --is-ancestor <source_sha> <target>` is true), the push **already
     succeeded** — write / finish `concierge_report.md` (`DONE`) and stop. Do
     **not** re-merge or re-push. If the merge is committed locally but not
     pushed, finish only the push. If nothing landed, execute normally (§6).
   - `create_pr`: query for an existing open PR for the head
     (`gh pr list --head pr/<pm_id>/<slug>` / `glab mr list`). If one exists,
     switch to **update/verify**, never open a duplicate.
   - `create_release`: an existing tag/release (`git ls-remote --tags origin
     <tag>` / `gh release view <tag>`) means it already landed — verify + report,
     never clobber.
   - `update_ticket`: re-read the ticket; if the transition/comment is already
     applied, report `NO_OP` rather than re-applying.
3. Only when the live external state shows the operation did **not** happen do you
   (re-)execute. When in doubt, BLOCK to PM with the exact observed state rather
   than risk a duplicate external side effect.

This makes a crash-after-write **self-reconciling**: you recognize a completed-
but-unreported operation and finish the report, instead of re-doing the write.

## §11. Archive / IDLE cleanup

On `acked.md`: archive `assignment.md` + `concierge_report.md` under
`archive/<request_id>/`, ensure the target-scoped lock is released, reset your worktree
to a detached neutral state, optionally delete the `clipboard` branch
(`git branch -D garelier/<target-slug>/<pm_id>/clipboard/#<id>/<slug>`), and
return to `IDLE`.

