<!--
  Written by the Observer. Read by the requesting Worker.
  Path: __garelier/<pm_id>/_observers/<id>/advice.md
  Non-binding implementation-direction advice INSIDE the Worker's assignment
  scope. Forbidden question -> status ESCALATE_TO_DOCK_OR_PM, no advice.
  See garelier-observer/references/review-workflow.md §7c and references/direction-advice.md.
-->

# Observer Direction Advice: {{request_id}}

## Identity
- Request ID: {{request_id}}
- Worker: {{worker_id}}
- Task: {{task_id}}
- Created at: {{iso8601}}

## Advice status
{{ADVICE|ESCALATE_TO_DOCK_OR_PM|NO_OPINION}}

## Worker question
{{question}}

## Context read
- {{path}}

## Recommended direction
{{concise recommendation}}

## Alternatives considered
| Option | Pros | Cons | When to choose |
|---|---|---|---|
| A | {{}} | {{}} | {{}} |
| B | {{}} | {{}} | {{}} |

## Scope guard
- This advice does not change assignment scope.
- If the Worker must change scope, transition to BLOCKED and ask Dock.
