# Daily Progress Update Runbook

Installed knowledge path: `runbooks/daily_progress_update.md`
Default role: Librarian
Risk: low

## Purpose

Refresh the project dashboard's current progress summary from tracked control
and runtime handoff artifacts. Do not change implementation code.

## Inputs

- `__garelier/<pm_id>/control/project_dashboard/current.md`
- `__garelier/<pm_id>/control/project_dashboard/backlog.md`
- `__garelier/<pm_id>/control/project_dashboard/risks.md`
- `__garelier/<pm_id>/runtime/manifest.md`
- Recent role reports under `__garelier/<pm_id>/runtime/**/report*.md`

## Procedure

1. Read the dashboard files first, then the runtime manifest and recent reports.
2. Identify completed work, blocked work, active lane state, and PM decisions
   needed.
3. Update only dashboard/control summaries owned by the PM/Librarian workflow.
4. Keep runtime files unchanged.
5. Record source paths used in the report so the PM can verify the summary.

## Completion Check

- No production code changed.
- Summary distinguishes done, active, blocked, and next PM action.
- Any uncertain claim is linked to the source file that justified it.
