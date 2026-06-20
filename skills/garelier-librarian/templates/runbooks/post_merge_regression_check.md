# Post-Merge Regression Check Runbook

Installed knowledge path: `runbooks/post_merge_regression_check.md`
Default role: Smith
Risk: medium

## Purpose

Run the project's configured regression checks after an integration merge and
record a concise, auditable result.

## Inputs

- Merge commit or branch under review.
- `__garelier/<pm_id>/control/project_dashboard/quality_gates.md`
- Project test/build commands from setup config or local docs.
- Recent merge-gate results under `__garelier/<pm_id>/runtime/merge_gate/`

## Procedure

1. Confirm the target commit or branch and the expected quality gate commands.
2. Run the configured checks from a clean worktree.
3. Capture command, exit code, duration, and relevant failure tail.
4. Compare failures with the previous merge-gate result if available.
5. Write a report with PASS, PASS_WITH_NOTES, or BLOCK.

## Completion Check

- All configured checks are accounted for.
- Failures include enough output for a Worker or Artisan to reproduce.
- Any skipped check has a concrete reason and PM-visible risk.
