---
knowledge_id: quality.quality_gate_policy
title: Quality Gate Policy
category: quality
status: active
owners:
  - pm
consumers:
  - worker
  - smith
  - artisan
  - dock
  - observer
  - pm
source_ids:
  - project-original
last_reviewed_at: 2026-08-02
review_cycle: on-change
---

# Quality Gate Policy

How to treat the project quality gate. The gate's **commands are canonical in
`AGENTS.md`**; this file is how to reason about it, not a second definition.

## Rules

- `AGENTS.md` is the source of truth for the project quality gate. Run it; do not
  invent or substitute commands.
- A role-specific extra gate must be named in the assignment, not assumed.
- Name the owner stage before execution. The project-declared formal/full gate
  runs once at that owner stage against the exact candidate. Roles may run
  declared focused or fast checks earlier; reviewers inspect the bound evidence
  and do not rerun the same full suite. Do not turn role, reviewer, merge,
  and closure stages into duplicate launches of one expensive command.
- Run a required gate as one whole command. Do not split it into partial jobs,
  resume halfway, or treat a helper/test-only check as the formal closure.
- Give every external command and subprocess a finite, operation-appropriate
  timeout. Record `timeout` separately from a non-zero code/test failure. After
  a timeout, inspect the recorded process and result evidence before any
  project-authorized retry; never blindly launch a duplicate.
- Never ignore a gate failure.
- Separate a **pre-existing failure** (already broken before your change) from an
  **own-change failure** (your change broke it). Report which, with evidence.
- Report gate results as a summary plus an artifact path — do not paste the full
  gate output (`garelier-core/compact_handoff.md`).
- If a required gate cannot run, the outcome is `BLOCKED`, not a silent PASS.
- When adding a test oracle, follow the project's permanent test-definition
  budget: consolidate or remove existing definitions in the same change when
  required, and record the before/after census. Moving or splitting identical
  definitions across files is not a reduction in test volume.

## Who applies it

- Worker / Smith / Artisan run the gate as part of their work.
- Smith applies decided quality policy; it does not invent new release criteria or
  approve test waivers without Dock / PM authority (see
  `../system/decision_authority.md`).
- Dock judges merge readiness using the gate evidence; Observer judges its
  plausibility without rerunning the owner-stage full gate.

Generalized project knowledge, Librarian-maintained under PM approval.
