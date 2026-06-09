# Delegated Request: {{request_id}}

Source PM: `{{source_pm}}`
Target PM: `{{target_pm}}`
Kind: `{{kind}}`
Created at: `{{created_at}}`
Request branch: `{{git.request_branch}}`

## Requested action

{{Free-text description of what the source PM is asking for.
  Written in user-readable terms, not implementation terms.
  The target PM will translate this into a Blueprint, Scout
  inspection, or Dock workflow.}}

## Restrictions (binding on target PM)

- `allow_commits = {{safety.allow_commits}}`
- `allow_promote = false` (hard-coded — request cannot trigger promote)
- `allow_production_write = {{safety.allow_production_write}}`

If `allow_production_write` is true, this request must also satisfy
`__garelier/<pm_id>/control/operations/data_change_policy.md` per execution.

## Expected outputs

{{Bullet list naming the reports the source PM expects. Mirrors the
  request.toml [output] table.}}

## Context for target PM

{{Anything the source PM thinks the target PM should know that
  doesn't fit the structured fields above: previous related
  requests, why this was scheduled now, what's blocked on the
  result, etc.}}

## Audit trail

- Request branch: `{{git.request_branch}}`
- Request commit SHA: `{{commit_sha}}` (filled by intake)
- Will produce: `__garelier/<pm_id>/control/reports/requests/{{request_id}}.md`
- (PM-PM only) Will also produce:
  `__garelier/<pm_id>/control/reports/delegated_requests/{{request_id}}.md`
