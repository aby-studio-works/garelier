# Smith working & merging procedure

On-demand detail for the Garelier Smith. The hard invariants stay in
`../SKILL.md` (§2 responsibilities, §3 boundaries, §4 state list, the
autofix-first invariant, **MUST BLOCK IF**); this file holds the step-by-step
procedure, git command blocks, the report.md field list, the good/bad-Smith
examples, and the escalation conditions. The worktree guard, addressing, and the
detached-HEAD cleanup rule live in `../../garelier-core/references/worktree-addressing.md`.

## §5. Receiving an assignment

When `assignment.md` appears:

1. Read it fully.
2. Read the listed inputs: Worker reports, merge result notes, test gaps,
   project specs, release docs, or policy files.
3. Check whether the concern is already tracked in backlog. If it is, do
   not duplicate it; report the existing backlog item and focus on the
   assigned hardening work.
4. If the assignment is unclear, transition to `BLOCKED`.
5. Reset to current studio and create the Anvil branch:

```bash
git checkout --detach garelier/<target-slug>/<pm_id>/studio
git reset --hard HEAD
git checkout -b garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>
```

6. Update `STATE.md` to `WORKING`.
7. Notify Dock via `runtime/dock/inbox/`.

## §6. Working on Anvil

Focus on the integration state, not a single Worker's isolated diff.

Good Smith work:

- Adds a test that covers cross-module behavior missed by Worker tests.
- Fixes a break caused by two merged changes interacting badly.
- Updates target-project docs that are now inconsistent with shipped code.
- Adds a release validation script required by the project's release rules.
- Removes or replaces a dependency that violates an already-decided project
  license policy.

Bad Smith work:

- Implements a deferred feature that PM has not assigned.
- Edits Garelier PM dashboard files because they look stale.
- Rewrites architecture because the integrated state could be prettier.
- Converts an undecided license question into a code change without PM input.

Commit incrementally. Run focused checks while working, then the assigned
quality gate before reporting. (Autofix-first invariant — see `../SKILL.md`.)

## §7. Reporting

Before `REPORTING`, run the required checks from `AGENTS.md` and any
assignment-specific integration/system commands.

Write `report.md` with:

- Result: pass/fail summary.
- Branch: Anvil branch name and commits.
- Coverage window: `studio_base_commit`, `studio_tip_at_dispatch`, and
  covered Worker merge tokens from assignment.md
  (`#<worker_task_id>@<merge_sha>`).
- Later studio merges observed: list any merges that landed after
  `studio_tip_at_dispatch`; they are outside this report's coverage and
  belong to the next Smith batch.
- Scope: what integration risk was checked.
- Changes: files changed and why.
- Tests: commands run and final result.
- Policy: license/security/compliance findings and enforcement.
- Backlog: existing backlog items you intentionally did not duplicate.
- Residual risk: anything Dock or PM must know.

Also write `report.json` from `garelier-core/templates/report.json` beside
`report.md`. It is a compact machine-routing summary only; do not duplicate the
Markdown report body.

Then update `STATE.md` to `REPORTING` and notify Dock. Do not keep
editing the branch while waiting. In driver mode, `REPORTING` and
`REVIEWING` are marker-waiting states; the driver does not spawn Smith
again until `under_review.md`, `review.md`, `merged.md`, or `abort.md`
appears.

## §8. Review and merge

If `review.md` appears:

1. Read it fully.
2. Update `STATE.md` to `REWORK`, then `WORKING`.
3. Fix the review items on the same Anvil branch.
4. Re-run checks.
5. Update `report.md` with a response section.
6. Return to `REPORTING`.

When `merged.md` appears:

1. Update `STATE.md` to `MERGED`.
2. Archive `assignment.md`, `report.md`, `under_review.md`, `review.md`,
   and `merged.md` under `archive/<task_id>/`.
3. Reset the worktree to detached studio (re-pin + reset, NEVER `git clean -fdx`;
   see `../../garelier-core/references/worktree-addressing.md`):

```bash
git checkout --detach garelier/<target-slug>/<pm_id>/studio
git reset --hard HEAD
```

4. Optionally delete the local Anvil branch with safe `git branch -d`.
5. Update `STATE.md` to `IDLE`.
6. Notify Dock.

## §9. Escalation

Transition to `BLOCKED` and write `questions.md` when one of the
conditions below applies. In driver mode, `BLOCKED` costs no provider
tokens while waiting; the driver wakes you only when `answers.md` or
`abort.md` appears.

- The assignment conflicts with PM/user decisions.
- A target-project spec is ambiguous and multiple fixes are plausible.
- A license/compliance policy is not already decided by the project.
- The fix would require new feature scope rather than integration repair.
- Required credentials, services, or test environments are unavailable.
- The work appears to need production data mutation without guards.
