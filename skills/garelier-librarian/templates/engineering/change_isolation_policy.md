---
knowledge_id: engineering.change_isolation_policy
title: Change Isolation Policy
category: engineering
status: active
owners:
  - pm
consumers:
  - worker
  - artisan
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Change Isolation Policy

Keeps an AI agent from over-changing "while it's in there". Project-specific;
original wording.

## Keep distinct changes distinct

Do not combine these in one change/commit:

- Feature work
- Refactor
- Formatting / mechanical move
- Dependency / build update
- Test rewrite

Each is its own focused change. Mixing them hides the real diff and makes review
and rollback harder.

## Stay in scope

- Findings outside the assignment go to `backlog` or `questions.md` — not into
  the current change.
- Do not edit PM-owned control documents that are not part of the assignment.
- Before touching a protected path, confirm the assignment / approval / gate
  permits it (see `../system/decision_authority.md`).

## Behavior changes are explicit

- If a change alters existing behavior, say so against the acceptance criteria
  and name the compatibility impact.
- A "small improvement" that changes a contract, output format, or public API is
  a behavior change — treat it as one.

When in doubt about whether something is in scope, it is not — route it back
rather than absorbing it.
