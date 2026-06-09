# Worker reference: review feedback, after-merge, blocked, multi-Worker

> Detailed procedure moved out of `SKILL.md` (DEC-032). Read this when
> your state is REVIEWING / REWORK / MERGED / BLOCKED, or when coordinating
> with another Worker.

## §8. Handling review feedback (REVIEWING → REWORK → WORKING)

If Dock rejects, you'll see `__garelier/<pm_id>/_workers/<id>/review.md`
appear. Your STATE will be moved to `REWORK` (you confirm the
transition by updating your `STATE.md`).

### 8.1 Read the review

Read `review.md` in full. Each failed criterion has:

- What was observed
- What was expected
- Suggested fix (Dock's guess)

The suggested fix is a starting point, not a mandate. If you have a
better approach, take it; just make sure the criterion ends up
satisfied.

### 8.2 Address each item

1. Update `STATE.md` to `WORKING`.
2. Address each failed criterion on the **same workbench branch** (do
   not create a new branch).
3. Commit the fixes with messages referencing the review (e.g.,
   "Address review §3.1: handle empty input").
4. Re-run the quality gate.
5. Update `report.md` with a new section at the top: "Response to
   review of <YYYY-MM-DD>" describing what you changed.
6. Transition to REPORTING again per §7.

If the review has items you cannot address (acceptance criterion
seems impossible, contradicts another), transition to BLOCKED
instead of guessing.

## §9. After merge (REVIEWING → MERGED → IDLE)

When Dock merges your branch, you'll see
`__garelier/<pm_id>/_workers/<id>/merged.md` appear.

### 9.1 Cleanup

1. Update `STATE.md` to `MERGED` briefly.
2. Archive `assignment.md`, `report.md`, `under_review.md` (if
   present), and `merged.md` to
   `__garelier/<pm_id>/_workers/<id>/archive/<task_id>/`.
3. **Return to detached HEAD at the current studio tip AND reset
   working tree.** Without the reset, your workbench branch's
   uncommitted/intermediate artifacts (sccache binaries other
   Workers regenerated, build caches, etc.) linger in your worktree
   and show up as stale `M` entries against studio for weeks. Do:
   ```bash
   git checkout --detach garelier/<target-slug>/<pm_id>/studio
   git reset --hard HEAD
   ```
   Do **not** run `git checkout garelier/<target-slug>/<pm_id>/studio`
   (without `--detach`) — primary worktree owns that branch and the
   checkout will fail. Detached HEAD pointing at the studio tip is
   the correct steady state.
   Do **not** `git clean -fdx`. Other Workers and the merge-gate
   subprocess share the project root's build cache via sccache; a
   recursive clean would force a multi-minute cold rebuild for the
   next iteration.
4. Optionally delete the local workbench branch:
   ```bash
   git branch -d garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>
   ```
   Use lower-case `-d` (safe, refuses if unmerged). Reserve `-D`
   (force) for the rare case where the branch was abandoned with
   uncommitted intent — and double-check before doing so.
5. Update `STATE.md` to `IDLE`. Clear "Current task" fields.
6. Notify Dock of the IDLE transition.

### 9.2 Pre-WORKING cleanup (next assignment, IDLE → WORKING)

Whenever you next transition IDLE → ASSIGNED → WORKING, repeat the
same `git checkout --detach <studio> && git reset --hard HEAD` BEFORE
creating the new workbench branch. This guarantees your branch is cut
from the current studio tip, not from a stale local position drift
has accumulated against.

```bash
# Inside §4 of this SKILL, before `git checkout -b <workbench>`:
git checkout --detach garelier/<target-slug>/<pm_id>/studio
git reset --hard HEAD
git checkout -b garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>
```

Without this pre-cleanup, your first commit on the new workbench
branch can carry over stale modifications from prior tasks (or from
build caches another Worker touched) — they'll appear in your diff
and the merge-gate quality gate may catch them as unintended
changes.

You are now ready for the next assignment.

## §10. BLOCKED escalation

Use BLOCKED whenever you cannot proceed without external input. In driver
mode, `BLOCKED` costs no provider tokens while waiting; the driver wakes
you only when `answers.md` or `abort.md` appears.

### 10.1 Write questions.md

Use `../../garelier-core/templates/questions.md`. Save to
`__garelier/<pm_id>/_workers/<id>/questions.md`. Be specific:

- State the question clearly, in one sentence.
- Provide context: which acceptance criterion, which file, which line.
- List what you tried (so Dock doesn't suggest the same).
- If you have alternative paths in mind, list them with trade-offs.

### 10.2 Update state and notify

1. Update `STATE.md` to `BLOCKED`. Note the question filename.
2. Write a state-change notification to
   `__garelier/<pm_id>/runtime/dock/inbox/<YYYYMMDD-HHMMSS>-<your-id>-blocked.md`
   pointing to `questions.md`.
3. Stop. Do not commit further. Do not guess. Wait.

### 10.3 Resuming (BLOCKED → WORKING)

When `__garelier/<pm_id>/_workers/<id>/answers.md` appears:

1. Read the answers carefully.
2. If Dock updated `assignment.md`, re-read it.
3. Update `STATE.md` to `WORKING`.
4. Notify Dock of the resumption.
5. Resume per §5.

## §11. Multi-Worker coordination

Multiple Workers run in parallel. You do not coordinate with them
directly.

### 11.1 If your work depends on another's

Don't try to read their `__garelier/<pm_id>/_workers/<id>/` files or
branches. Instead:

- Check `__garelier/<pm_id>/runtime/manifest.md` to see if their task is
  `MERGED`.
- If yes, `git pull origin garelier/<target-slug>/<pm_id>/studio` and merge
  the integration branch into your workbench branch (or rebase, per
  project policy).
- If no, transition to BLOCKED with a question stating the dependency.

### 11.2 If two Workers touch the same file

This is Dock's coordination problem, not yours. If you discover
during merge gate (post-rebase) that there are conflicts with
another Worker's recent merge, transition to BLOCKED with the
specific conflict information. Do not attempt to resolve via
guessing what the other Worker intended.

