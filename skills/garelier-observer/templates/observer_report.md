+++
# Machine face. Every value sits under a [section] / [[array]] table; the prose
# below the closing +++ is never parsed, so parentheses, backticks and quotes in
# a finding are ordinary characters. Use '''...''' for anything multi-line.

[verdict]
result = '{{PASS | PASS_WITH_NOTES | REWORK_RECOMMENDED | BLOCK | NO_OPINION}}'
# W-062: bind the verdict to the exact reviewed commit so the merge gate's
# stale-verdict guard (symmetric with the Guardian G-15 guard) can refuse a PASS
# that a later commit on the review branch has invalidated. Use the review-branch
# tip you reviewed (the `--review-sha` you passed to review_gate_prep.ts). A
# message-only amend/reword (same tree, new SHA) still passes via the tree-hash
# fallback, so a reword does not require re-touching this.
review_sha = '{{sha}}'
role = 'observer'
# The bound branch. The PM's authority-rebind check reads THIS value.
branch = '{{bound branch}}'
+++

<!--
  Written by the Observer. Read by the requester (Dock / Artisan / Worker).
  Path: __garelier/<pm_id>/_crew/observers/<id>/report.md
  A point-in-time observation: immutable once REPORTING. If insufficient, the
  requester issues a NEW request (new request_id), not a rework.
  Compact handoff: one fact per line; cite exact paths/commands.
  See garelier-observer/SKILL.md §6 + references/review-workflow.md §8, §9.
  Output register: garelier-core/output_control.md § Inter-agent compressed register.
-->

# Observer Report: {{request_id}}

## Identity
- Request ID: {{request_id}}
- Kind: {{kind}}
- Observer: {{observer_id}}
- Requester: {{requester}}
- Target: {{target_role_task}}
- Created at: {{iso8601}}

## Verdict

<!-- The machine-read verdict is `[verdict] result` in the front matter above.
     This section is the human-facing summary of WHY; it is never parsed, so
     write it freely. -->

{{one or two sentences: what decided the verdict}}

## Review context

<!--
  Required on BLOCK / REWORK_RECOMMENDED / NO_OPINION / failed setup. Keep paths
  absolute when possible so PM can resume or re-run the exact review without
  rediscovery. Do not paste source, diff bodies, or long logs here.
-->

- Task: {{task_id_or_slug}}
- Review target: {{workbench/anvil/shelf/satchel branch}}
- Container: {{absolute path to observer container}}
- Checkout: {{absolute path to monocle checkout, or "checkout=false"}}
- Assignment: {{absolute path to assignment.md}}
- Role report: {{absolute path or none}}
- Context / brief: {{absolute path to context.json/review brief or none}}
- Re-run hint: {{exact safe command or short next step}}

## Summary
- {{one-line finding}}

## Evidence reviewed
- Assignment: {{path}}
- Report: {{path}}
- Diff: `{{command}}`
- Gate output: {{path_or_none}}
- Additional files read:
  - {{path}}

## Findings
### Blocking findings
- {{finding / or none}}
### Non-blocking findings
- {{finding / or none}}
### Scope and coverage
- Goal satisfied: {{yes/no/unknown}}
- Do items covered: {{yes/no/unknown}}
- Acceptance criteria covered: {{yes/no/unknown}}
- Out-of-scope changes: {{none/list}}
### Risk notes
- Protected paths: {{none/list}}
- Public API / schema: {{none/list}}
- Migration / data change: {{none/list}}
- Security / auth: {{none/list}}
- Test gap: {{none/list}}

## User perspective
<!-- DEC-029: fill only when there is user-visible impact; else "Not applicable".
     See the review/user_perspective_review.md knowledge. -->
- User-visible impact: {{Not applicable / describe}}
- Usability / operability concern: {{none/describe}}
- Documentation / messaging concern: {{none/describe}}
- Verdict impact: {{none / raises REWORK / raises BLOCK}}

## System impact
<!-- DEC-029: fill only when the change ripples into role flow / driver / setup /
     docs / gates; else "Not applicable". See the review/system_impact_review.md knowledge. -->
- Role boundary impact: {{Not applicable / describe}}
- Driver / protocol / setup / docs sync impact: {{none/describe}}
- Gate / state-machine impact: {{none/describe}}
- Verdict impact: {{none / raises REWORK / raises BLOCK}}

## Recommended action
{{merge/continue/rework/escalate/no opinion}}

## Required requester follow-up
- {{specific action}}
