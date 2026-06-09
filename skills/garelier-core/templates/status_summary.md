# Project Status Summary: {{date}}

<!--
  Written by Scout when idle_task is enabled. Read by PM and (optionally)
  by users via PM's review.
  Path: __garelier/<pm_id>/control/inspections/status/YYYY/MM/YYYY-MM-DD-project-summary.md
  Compact handoff: counts first, then exceptions.
-->

## At a glance

- Active milestones: {{N}}
- Active Workers (working/blocked): {{N_working}} / {{N_blocked}}
- Active Smiths (working/blocked): {{N_smith_working}} / {{N_smith_blocked}}
- Smith hardening targets remaining: {{N_smith_targets_remaining}} (pending {{N_smith_targets_pending}}, active {{N_smith_targets_active}})
- Backlog items completed in last {{period}}: {{N}}
- Open escalations: {{N}}

## Per-milestone progress

### {{milestone_name}}

- Progress: {{phases_done}}/{{phases_total}} phases
- Velocity (last 7 days): {{N}} backlog items completed
- On track?: {{yes | "behind by N items" | "ahead"}}
- Blockers: {{none | brief description}}

## Worker activity (last {{period}})

| Worker        | Tasks completed | Tasks rejected | Time blocked  |
| ------------- | --------------- | -------------- | ------------- |
| {{worker_id}} | {{N}}           | {{N}}          | {{HH:MM}}     |

## Scout activity (last {{period}})

| Scout         | Inspections produced | Categories       |
| ------------- | -------------------- | ---------------- |
| {{scout_id}}  | {{N}}                | tech, market     |

## Smith activity (last {{period}})

| Smith        | Anvil tasks completed | Integration checks added |
| ------------ | --------------------- | ------------------------ |
| {{smith_id}} | {{N}}                 | {{N}}                    |

## Notable events

<!-- Exceptions only. -->

- {{event_1}}
- {{event_2}}

## Recommendations from Scout

<!-- Optional; one action per line. -->

- {{observation_1}}: consider {{suggestion}}.

## Data sources

- `__garelier/<pm_id>/runtime/manifest.md` (snapshot at {{timestamp}})
- `__garelier/<pm_id>/runtime/backlog/done/` (last {{N}} entries)
- `__garelier/<pm_id>/runtime/dock/inbox-archive/` (last {{period}})
- `__garelier/<pm_id>/_workers/*/STATE.md` (current)
- `__garelier/<pm_id>/_smiths/*/STATE.md` (current)
