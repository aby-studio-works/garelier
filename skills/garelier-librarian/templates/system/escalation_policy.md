---
knowledge_id: system.escalation_policy
title: Escalation Policy
category: system
status: active
owners:
  - pm
consumers:
  - pm
  - dock
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Escalation Policy

When to stop and hand a decision upward instead of proceeding. Escalating is
correct behavior, not failure — a paused, well-described blocker beats a wrong
autonomous step.

## Escalate (do not proceed) when

- The assignment is ambiguous about intent, scope, or acceptance criteria.
- A decision requires authority your role does not hold (see
  `role_boundary_matrix.md` and `decision_authority.md`).
- A required gate cannot run, or a gate returns BLOCK and the fix is not within
  your scope.
- A change would touch a protected path, an external system, production data, or
  user-facing behavior without an explicit approval.
- You discover work outside your assignment that looks important.
- Two policies conflict, or a policy seems wrong for this situation.

## How to escalate

1. Stop at a clean, recoverable point (commit WIP only if your role commits).
2. State the decision needed, the options, and your recommendation — concisely.
3. Route it to the right owner:
   - Implementation/scope ambiguity → Dock → PM via `questions.md`.
   - Policy / requirement / waiver / exception → PM / owner.
   - Security / privacy / license uncertainty → Guardian gate + a knowledge
     update request to the Librarian (see `knowledge_update_request.md`).
   - External-operation method or risk → PM (who approves) → Concierge (executes).
4. Set your state to `BLOCKED` (or the role-appropriate waiting state) and record
   the residual risk.

## Do NOT

- Guess the intent and proceed.
- Suppress a gate, warning, or failing check to avoid escalating.
- Invent an exception or a waiver yourself.

Generalized project knowledge, Librarian-maintained under PM approval.
