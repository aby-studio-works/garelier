# Concierge Assignment

<!--
  Written by PM (after explicit user approval). Read by the assigned Concierge.
  Path: __garelier/<pm_id>/_concierges/<id>/assignment.md (in-project default,
  DEC-036). When exile is opted in, resolve the container via
  __garelier/<pm_id>/runtime/workspace_paths (concierge.<id>=...).
  Compact handoff: pointers, not pasted context. See compact_handoff.md.
  PM decides and approves; Concierge executes the fixed method below.
-->

## Identity

- request_id: CXO-{{N}}
- operation_kind: {{promote_target | sync_remote}}   <!-- Phase 1; Phase 2 adds create_pr/create_release/update_ticket/... -->
- assigned_to: {{concierge_id}}
- requested_by: user
- approved_by: PM
- created_at: {{ISO8601}}

## Fixed refs (PM fixes these; Concierge does not change them)

- provider: {{remote_git | github | gitlab | jira | other}}
- target_remote: origin
- target_ref: {{<target> branch, e.g. main}}
- expected_target_sha: {{sha the live target tip must match — drift ⇒ BLOCK}}
- source_ref: `garelier/{{target_slug}}/{{pm_id}}/studio`
- source_sha: {{studio tip sha PM base-tracked and approved}}
- tag: {{v<version> or n/a}}
- promote_notes: {{path to control/reports/promote/<YYYY-MM-DD>.md}}

## Required gates (Concierge confirms, does not re-judge)

- required_guardian_verdict: {{PASS | PASS_WITH_NOTES}}
- guardian_report_path: {{path — carries review_sha for the stale check}}
- required_observer_verdict: {{PASS | PASS_WITH_NOTES | not_required}}
- required_external_ci: {{pass | not_required}}
- quality_gate: run on the merged tree (AGENTS.md §2) — must pass before tag/push

## Required knowledge sources (Librarian-owned — read, do not change)

- docs/garelier/external_operations/external_operations_policy.md
- docs/garelier/external_operations/git_remote_policy.md
- docs/garelier/external_operations/promote_policy.md
- docs/garelier/external_operations/rollback_policy.md
- runbook: docs/garelier/external_operations/runbooks/promote_target.md
- record template: docs/garelier/external_operations/templates/promote_record.md

## Allowed / forbidden commands

allowed:
- git fetch origin
- git checkout <target>
- git merge --no-ff --no-commit garelier/<target-slug>/<pm_id>/studio
- git tag -a "v<version>" -m "..."
- git push origin <target> --tags

forbidden:
- git push origin garelier/*       (garelier/* is local-only — protocol §6.5)
- git push --force
- git pull                          (use fetch + an explicit named merge)

## Outputs

- `concierge_report.md` (operation_kind, target_before_sha, target_after_sha,
  gate verdicts, command summary, rollback/recovery note — pointer-only)
- `knowledge_update_request.md` (only if a durable external-op rule gap is found)
