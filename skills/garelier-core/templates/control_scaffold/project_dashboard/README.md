# Project Dashboard

Short, current planning surfaces for this control namespace.

## Authority

Highest first:

1. Explicit user instruction
2. `../operations/` and `quality_gates.md`
3. Accepted records in `../decisions/`
4. `current.md`, `roadmap.md`, `backlog.md`, `risks.md`
5. `notes.md`

## Rules

- Keep hot files short and point to canonical artifacts.
- Use stable work IDs (`W-NNN`) and risk IDs (`R-NNN`). Do not recycle IDs.
- Link a work item to its milestone, acceptance source, and detail source
  instead of copying their bodies into the dashboard.
- `backlog.md` contains open work only. Delete completed rows in the completing
  commit; use git history for the past.
- `decisions.md` indexes `../decisions/`; it does not duplicate decision bodies.
- Promote or delete scratch from `notes.md` promptly.
- For compact handoff, update `current.md`; put longer handoff detail under
  `../reports/handoffs/` only when needed.
- For control-only diagnostics, report findings under
  `../reports/diagnostics/` only when the result must survive.

## File roles

| File | Role | Canonical for | Not canonical for | Update timing |
| --- | --- | --- | --- | --- |
| `current.md` | hot index | active focus, next action, blockers, read-first pointers | long history, completed work log, settled decisions, full backlog | every meaningful session |
| `roadmap.md` | direction index | long-term direction and milestone pointers | task detail, session status, decision bodies | when direction changes |
| `backlog.md` | open work shelf | open tasks, deferred work, blocked work, detail pointers | completed work history, settled decisions | when open work changes |
| `decisions.md` | decision index | links to accepted/proposed decision records | duplicated decision bodies, open discussion | when decision records change |
| `risks.md` | active risk register | open risks, triggers, mitigations | closed risk history, general TODOs | when risks change |
| `quality_gates.md` | completion policy | reusable done criteria and quality expectations | task list, current status | when completion rules change |
| `notes.md` | temporary scratch | short-lived notes awaiting promotion or deletion | durable authority | temporary only |

## Shared field values

- Work type: `feature | bug | maintenance | research | decision | docs`
- Priority: `critical | high | normal | low`
- Backlog status: `triage | ready | blocked | deferred`
- Risk severity and likelihood: `critical | high | medium | low`
- Use `-` for an intentionally empty field. Use an exact relative path,
  issue URL, commit SHA, or stable identifier for pointers.
