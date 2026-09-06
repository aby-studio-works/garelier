# Concierge Assignment

<!--
  Written by PM (after explicit user approval). Read by the assigned Concierge.
  Path: __garelier/<pm_id>/_crew/concierges/<id>/assignment.md (in-project default,
  DEC-036). When exile is opted in, resolve the container via
  __garelier/<pm_id>/runtime/workspace_paths (concierge.<id>=...).
  Compact handoff: pointers, not pasted context. See compact_handoff.md.
  PM decides and approves; Concierge executes the fixed method below.
-->

## Identity

- request_id: CXO-{{N}}
- operation_kind: {{promote_target | framework_release | sync_remote}}   <!-- Generic Phase 2 adds create_pr/create_release/update_ticket/... -->
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

## Framework release authorization (only for `framework_release`)

- approval_ledger: `control_root/__garelier/{{pm_id}}/runtime/concierge/requests/framework_release__{{request_id}}.approval.json`
- permission_record: `control_root/__garelier/{{pm_id}}/_crew/lanes/.meta/{{attended_agent}}.dispatch.json`
- publish_repo: {{absolute path to the approved clean public clone}}
- expected_publish_sha: {{approved public-clone HEAD; drift ⇒ BLOCK}}
- github_repo: {{approved owner/name}}
- approved_remote_url: {{exact origin URL from the Concierge permission record}}
- public_release_runbook: {{control/operations/public_release_runbook.md}}
- external_lock: `control_root/__garelier/{{pm_id}}/runtime/concierge/locks/release__v{{VERSION}}.lock`
  (live mode only; caller names but does not pre-create it. The wrapper derives
  the `VERSION` tag, atomically creates this exact immutable owner file with
  `pid=process.pid` + nonce, and creates `<lock>.done` atomically in
  finalization; arbitrary paths, an already-finalized tag, another live PID,
  or unrecovered stale lock ⇒ BLOCK)

The approval ledger uses `schema_version = 1`, `operation_kind =
"framework_release"`, `approval_status = "approved"`, `requested_by = "user"`,
and carries `request_id`, `approved_by`, `user_approval_ref`, `pm_id`,
`control_root`, `git_common_dir`, `agent_name`, `permission_record`,
`guardian_report`, `release_tag`, `source_sha`, `publish_repo`,
`expected_publish_sha`, `github_repo`, `target_remote`, and
`approved_remote_url`. Those authority fields bind the PM-owned ledger to one
repository, attended seat, gate result, and release input set. Set
`allow_unattended_confirmations = true` only when the recorded approval
explicitly authorizes `--yes`; otherwise attended prompts remain mandatory.

## Required gates (Concierge confirms, does not re-judge)

- required_guardian_verdict: {{PASS | PASS_WITH_NOTES}}
- guardian_report_path: {{path — carries review_sha for the stale check}}
- required_observer_verdict: {{PASS | PASS_WITH_NOTES | not_required}}
- required_external_ci: {{pass | not_required}}
- quality_gate: run on the merged tree (AGENTS.md §2) — must pass before tag/push

## Required knowledge sources (Librarian-owned — read, do not change)

- external_operations/external_operations_policy.md
- external_operations/git_remote_policy.md
- external_operations/promote_policy.md
- external_operations/rollback_policy.md
- runbook: external_operations/runbooks/promote_target.md
- record template: external_operations/templates/promote_record.md

## Allowed / forbidden commands

allowed:
- git fetch origin
- git checkout <target>
- git merge --no-ff --no-commit garelier/<target-slug>/<pm_id>/studio
- git tag -a "v<version>" -m "..."
- git push origin <target> --tags
- bun skills/garelier-core/driver/src/scripts/concierge_release.ts <fixed args>

forbidden:
- git push origin garelier/*       (garelier/* is local-only — protocol §6.5)
- git push --force
- git pull                          (use fetch + an explicit named merge)
- bun skills/garelier-core/driver/src/scripts/release.ts ...

## Outputs

- `concierge_report.md` (operation_kind, target_before_sha, target_after_sha,
  gate verdicts, command summary, rollback/recovery note — pointer-only)
- `knowledge_update_request.md` (only if a durable external-op rule gap is found)
