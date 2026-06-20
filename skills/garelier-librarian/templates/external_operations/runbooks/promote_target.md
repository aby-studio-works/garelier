# Runbook: promote_target (Garelier default — edit per project)

> Librarian-owned runbook the Concierge follows (DEC-025). Installed at
> the `external_operations/runbooks/promote_target.md` knowledge file.
> Inputs come from the Concierge `assignment.md`; see `promote_policy.md` for
> the policy and `rollback_policy.md` for recovery.

## Inputs (from assignment.md, all fixed by PM)

`source_ref` = `garelier/<target-slug>/<pm_id>/studio`, `source_sha`,
`target_ref` (`<target>`), `expected_target_sha`, `tag` (`v<version>` or n/a),
`guardian_report_path` (+ verdict), promote-notes path.

## Steps (Concierge, in its own worktree; `<target>` is free — main checkout holds studio)

1. **Gate check.** Confirm the Guardian verdict is `PASS`/`PASS_WITH_NOTES` and
   its `review_sha` matches `source_sha` (not stale). Confirm any required
   Observer verdict. Else BLOCK.
2. **Lock.** Acquire the target-scoped lock `runtime/concierge/locks/<target_remote>__<target_ref>.lock`
   (SKILL §5). If a live lock for the same target is held, BLOCK; if stale (dead
   pid), reclaim.
3. **Fetch + drift check.** `git fetch origin`; confirm `<target>` tip ==
   `expected_target_sha`. Mismatch → BLOCK (drift).
4. **Merge (no commit).** `git checkout <target>`;
   `git merge --no-ff --no-commit <source_ref>`. Resolve conflicts yourself; if
   the merge is huge/ambiguous, `git merge --abort` + BLOCK (base-track skipped).
5. **Quality gate on merged tree.** Run AGENTS.md §2 commands. On failure,
   reset/abort the merge, do not tag/push, BLOCK with the output.
6. **Finalize.** `git commit -m "Promote: <date or version>"`;
   `git tag -a "<tag>" -m "<notes title>"` (if a tag); record
   `target_after_sha` = the merge commit.
7. **Push.** `git push origin <target> --tags`. Never push `garelier/*`, never
   force-push.
8. **Verify + report.** Confirm the push; write `concierge_report.md` +
   `promote_record` (`templates/promote_record.md`) with before/after SHA, gate
   verdicts, command summary, rollback note. Release the lock; → REPORTING.

## On any stop

Leave `<target>` and the remote unchanged past the last safe point, release the
lock, and BLOCK to PM with the reason. Never silently retry.
