# Daily Progress Update Runbook

Installed knowledge path: `runbooks/daily_progress_update.md`
Default role: Librarian
Risk: low

## Purpose

Produce a bounded project-progress summary from schema-3 Control and
runtime handoff evidence. Do not change implementation code or directly edit
control authority.

## Inputs

- Schema 3: `garelier control session-open` bounded resume plus
  `control get/list` for linked Backlog/Risk/Milestone records
- `__garelier/<pm_id>/runtime/manifest.md`
- Recent role reports under `__garelier/<pm_id>/runtime/**/report*.md`

## Procedure

1. Resolve `control.toml`. For schema 3, use bounded context/resume and linked
   queries; never scan the control tree. Then read the runtime
   manifest and recent reports.
2. Identify completed work, blocked work, active lane state, and PM decisions
   needed.
3. Return the summary to PM. PM records schema-3 resume/evidence through a
   revision-checked control transaction. Librarian does not directly edit PM authority.
4. Keep runtime files unchanged.
5. Record source paths used in the report so the PM can verify the summary.

## Completion Check

- No production code changed.
- Summary distinguishes done, active, blocked, and next PM action.
- Any uncertain claim is linked to the source file that justified it.
