<!--
  Written by the Observer. Read by the requester (Dock / Artisan / Worker).
  Path: __garelier/<pm_id>/_observers/<id>/report.md
  A point-in-time observation: immutable once REPORTING. If insufficient, the
  requester issues a NEW request (new request_id), not a rework.
  Compact handoff: one fact per line; cite exact paths/commands.
  See garelier-observer/SKILL.md §6 + references/review-workflow.md §8, §9.
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
{{PASS|PASS_WITH_NOTES|REWORK_RECOMMENDED|BLOCK|NO_OPINION}}

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
     See docs/garelier/review/user_perspective_review.md. -->
- User-visible impact: {{Not applicable / describe}}
- Usability / operability concern: {{none/describe}}
- Documentation / messaging concern: {{none/describe}}
- Verdict impact: {{none / raises REWORK / raises BLOCK}}

## System impact
<!-- DEC-029: fill only when the change ripples into role flow / driver / setup /
     docs / gates; else "Not applicable". See docs/garelier/review/system_impact_review.md. -->
- Role boundary impact: {{Not applicable / describe}}
- Driver / protocol / setup / docs sync impact: {{none/describe}}
- Gate / state-machine impact: {{none/describe}}
- Verdict impact: {{none / raises REWORK / raises BLOCK}}

## Recommended action
{{merge/continue/rework/escalate/no opinion}}

## Required requester follow-up
- {{specific action}}
