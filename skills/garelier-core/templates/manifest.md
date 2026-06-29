# Runtime Manifest

<!--
  Live index of agent state. NOT a project dashboard — the dashboard is
  __garelier/<pm_id>/control/project_dashboard/. This file tracks moment-to-moment
  execution; the dashboard tracks long-term planning.
  Path: __garelier/<pm_id>/runtime/manifest.md
  Compact handoff: keep rows short; recent activity is timestamp --
  actor -- verb #id -- result.
-->

Last updated: {{YYYY-MM-DDTHH:MM:SS+TZ}}
Updated by: Dock
Garelier version: {{garelier_version}}

## Active milestones

<!-- Order: most-active first. Mark progress as "X/Y phases complete". -->

### Milestone: {{milestone_name}}
- Defined by PM in: `__garelier/<pm_id>/control/blueprints/{{blueprint_filename}}.md`
- Started: {{YYYY-MM-DD}}
- Progress: {{phases_done}}/{{phases_total}} phases

#### Phases
- [{{x}}] Phase {{n}}: {{phase_name}} — {{status}}

<!-- Repeat per active milestone. -->

## Dispatch execution

<!--
  W-011 (DEC-064 §3): execution state is DERIVED, never hand-edited here.
  - executing now:  live `_dispatch<N>/STATE.md` containers (structural truth)
  - generated view: `runtime/backlog/in_flight.md` (rewritten by
    scripts/dispatch_event.sh on every dispatch event)
  - append-only record: `runtime/dispatch/events.jsonl`
  Do NOT add per-agent roster tables to this file — the Status Web and
  dock_status.ts reads the sources above directly.
-->

Execution state is derived (DEC-064 W-011): see `backlog/in_flight.md`
(generated) and `dispatch/events.jsonl`. This file tracks milestones,
backlog totals, escalations, and recent activity only.

## Backlog summary

- Pending: {{n_pending}} items (see `runtime/backlog/pending.md`)
- In flight: {{n_in_flight}} items
- Smith hardening targets remaining: {{n_smith_targets_remaining}} (pending {{n_smith_targets_pending}}, active {{n_smith_targets_active}})
- Done this milestone: {{n_done}} items (see `runtime/backlog/done/`)

## Open escalations

<!-- List escalations awaiting PM resolution. Empty when none. -->

- (none)

## Recent activity (last 10 events)

<!-- Most recent first. Format: timestamp -- actor -- verb #id -- result -->

- {{YYYY-MM-DDTHH:MM:SS}} -- Dock -- merged #{{task_id}} from {{worker_id}} into `garelier/{{target_slug}}/studio`
- {{YYYY-MM-DDTHH:MM:SS}} -- {{worker_id}} -- reported #{{task_id}} complete
