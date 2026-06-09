# Concierge Report

<!--
  Written by the Concierge. Read by PM.
  Path: __garelier/<pm_id>/_concierges/<id>/concierge_report.md (in-project
  default, DEC-036). When exile is opted in, the container is resolved via
  __garelier/<pm_id>/runtime/workspace_paths (concierge.<id>=...).
  Compact handoff: pointers / URLs / SHAs, never pasted logs, PR bodies, or
  release notes. Never paste a secret, token, or PII value.
-->

request_id: CXO-{{N}}
operation_kind: {{promote_target | sync_remote}}
verdict: {{DONE | BLOCKED | FAILED | NO_OP}}
executed_at: {{ISO8601}}

## Fixed refs

source_ref: `garelier/{{target_slug}}/{{pm_id}}/studio`
source_sha: {{sha}}
target_remote: origin
target_ref: {{<target>}}
target_before_sha: {{sha-or-n/a}}
target_after_sha: {{merge-commit-sha-or-n/a}}
tag: {{v<version>-or-n/a}}

## Gate evidence (consumed, not re-judged)

Guardian: {{PASS | PASS_WITH_NOTES | BLOCK | not_required}}  (report: {{path}}, review_sha: {{sha}})
Observer: {{PASS | PASS_WITH_NOTES | not_required}}
Quality gate (on merged tree): {{PASS | FAIL | n/a}}
External CI: {{PASS | FAIL | PENDING | not_required}}

## External result

pushed: {{yes | no}}
push_result: {{summary, or n/a}}
external_url: {{url-or-n/a}}
remote_branch: {{branch-or-n/a}}

## Command summary

- {{short factual line — e.g. "git merge --no-ff --no-commit studio → clean"}}
- {{short factual line — e.g. "quality gate passed; committed + tagged v1.2.0"}}
- {{short factual line — e.g. "git push origin main --tags → ok"}}

## Rollback / recovery

- {{how to revert this if it must be undone — e.g. "revert merge <sha> on <target>; delete tag v1.2.0 locally (not pushed to a shared remote without user instruction)"}}

## Notes

- {{compact notes for PM: decisions made during conflict resolution, risks, follow-ups, or a knowledge_update_request pointer}}
