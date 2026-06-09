---
knowledge_id: quality.quality_gate_policy
title: Quality Gate Policy
category: quality
status: active
owners:
  - pm
consumers:
  - worker
  - pm
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Quality Gate Policy

How to treat the project quality gate. The gate's **commands are canonical in
`AGENTS.md`**; this file is how to reason about it, not a second definition.

## Rules

- `AGENTS.md` is the source of truth for the project quality gate. Run it; do not
  invent or substitute commands.
- A role-specific extra gate must be named in the assignment, not assumed.
- Never ignore a gate failure.
- Separate a **pre-existing failure** (already broken before your change) from an
  **own-change failure** (your change broke it). Report which, with evidence.
- Report gate results as a summary plus an artifact path — do not paste the full
  gate output (`garelier-core/compact_handoff.md`).
- If a required gate cannot run, the outcome is `BLOCKED`, not a silent PASS.

## Who applies it

- Worker / Smith / Artisan run the gate as part of their work.
- Smith applies decided quality policy; it does not invent new release criteria or
  approve test waivers without Dock / PM authority (see
  `../system/decision_authority.md`).
- Dock judges merge readiness using the gate evidence; Observer judges its
  plausibility.

Generalized project knowledge, Librarian-maintained under PM approval.
