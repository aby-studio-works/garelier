# Promote Record — {{date_or_version}}

<!--
  Written by the Concierge after a promote_target operation; PM keeps the
  persistent copy under control/reports/promote/. Pointer-only — never paste
  secrets, tokens, or PII. DEC-025.
-->

request_id: CXO-{{N}}
operation: promote_target
result: {{DONE | BLOCKED | FAILED}}
promoted_at: {{ISO8601}}

## Refs

source: `garelier/{{target_slug}}/{{pm_id}}/studio` @ {{source_sha}}
target: {{target}}
target_before_sha: {{sha}}
target_after_sha: {{merge_commit_sha}}
tag: {{v<version> or n/a}}
pushed: {{yes | no}}

## Gates

Guardian: {{PASS | PASS_WITH_NOTES}} (report: {{path}}, review_sha: {{sha}})
Observer: {{PASS | PASS_WITH_NOTES | not_required}}
Quality gate (merged tree): {{PASS}}

## Rollback

- {{not pushed: reset --hard <target_before_sha> + delete local tag | pushed: git revert -m 1 <merge_sha> then a new user-instructed promote — see rollback_policy.md}}

## Notes

- {{conflict-resolution decisions, risks, follow-ups — pointer-only}}
