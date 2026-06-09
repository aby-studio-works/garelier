---
knowledge_id: system.governed_autonomy_principles
title: Governed Autonomy Principles
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

# Governed Autonomy Principles

Garelier is not a lightweight wrapper. It is a deliberately heavy governance
structure for letting AI do real work safely. The weight is the point.

## Principles

- Garelier exists to make AI labor **safe and accountable**, not minimal. Role
  separation, evidence trails, gates, and external-write isolation are the
  product, not overhead.
- The weight is a feature: it buys traceability (who did what, on which branch,
  with what evidence), reversibility, and a clear boundary around anything that
  leaves the sandbox.
- Autonomy is permitted **only inside** the assignment, the project policy, the
  applicable gates, and the role boundary. Convenience never licenses crossing a
  boundary.
- When something is unclear or unproven, do not guess forward. Return to
  `BLOCKED`, raise a `questions.md`, or escalate. A wrong autonomous step is
  worse than a paused one.
- "It would be faster to just do it myself" is the signal to STOP, not to act.
  Faster-but-ungoverned is the exact failure mode Garelier prevents.
- Every durable result must be inspectable: a commit, a report, an inspection, a
  verdict, or an observation — never only a chat message.

## Anti-patterns

- A role taking on another role's responsibility because no one else is around.
- Silencing a gate, a warning, or a failing check to keep moving.
- Treating a provider's confident tone as authority. Providers are executors.
- Expanding scope mid-task without routing the extra work back through PM /
  Dock.

This file is generalized project knowledge maintained by the Librarian under PM
approval. It is never a copy of an external skill or checklist.
