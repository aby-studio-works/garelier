---
knowledge_id: external_operations.ticket_policy
title: Ticket Policy (Garelier default — edit per project)
category: external_operations
status: active
owners:
  - pm
consumers:
  - concierge
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Ticket Policy (Garelier default — edit per project)

> Librarian-owned; Concierge applies it (DEC-025, Phase 2). Installed at
> `docs/garelier/external_operations/ticket_policy.md`. **Default-disabled** —
> runs only when `allowed_operation_kinds` lists `create_ticket` /
> `update_ticket` / `close_ticket`. This is the **investigate-then-execute** shape.

## Preconditions

- Explicit user instruction + a PM `assignment.md` fixing the **method** (what to
  do with the ticket) and the fixed **ticket id** (e.g. `PROJ-123`).
- The tracker CLI / endpoint is available (`jira`, `gh issue`, `glab issue`, …).
  If absent → `NO_OP` + BLOCK.

## Investigate, then execute (never implement)

1. **Investigate the external operation only**: read the ticket, its current
   status / assignee / linked PRs / CI, and resolve the concrete steps the
   approved method maps to. This is the `PREPARING` phase.
2. **Decide scope honestly.** If the ticket actually needs **source changes**,
   STOP and hand back to PM with that finding — PM dispatches a Worker. Concierge
   never edits code and never decides the policy (PM fixed the method).
3. **Execute** the approved update (transition state, add a comment, set fields,
   link a PR) — within the fixed method only; never widen scope.

## Output safety

- A ticket comment / field update is generated from `templates/ticket_update.md`
  and must not contain a secret, token, PII value, customer data, or an internal
  `__garelier/` runtime path — pointer-only (paths / URLs / SHAs).
- Customer-facing trackers are external systems: treat every write as published.

## Stop conditions (BLOCKED / FAILED / NO_OP)

- The ticket id or the method is not fixed; the tracker CLI is unavailable.
- The work needs source changes (hand back to PM → Worker).
- The update would expose a secret / PII / customer data / internal runtime detail.
- A state transition needs an approval the assignment does not carry.

## After

Report the ticket URL, the new state, and what changed in `concierge_report.md`
(pointer-only), plus a rollback note (how to revert the transition / comment).
