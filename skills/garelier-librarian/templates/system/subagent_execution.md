---
knowledge_id: system.subagent_execution
title: Subagent Execution
category: system
status: active
owners:
  - pm
consumers:
  - dock
  - worker
source_ids:
  - project-original
last_reviewed_at: 2026-06-08
review_cycle: on-change
---

# Subagent Execution

When and how a role uses provider subagents to parallelize work **inside its own
iteration**. Original wording; project-specific. This is an execution detail
within one role's turn, not a new coordination tier.

## When subagents help

Use them when parallelism or decomposition is a clear win — several independent
angles, a wide search, N similar checks — not for a single linear task:

- **Scout** — sweep several investigation angles at once (by-container,
  by-symbol, by-call-site, by-history).
- **Observer** — run distinct review lenses concurrently (correctness, security,
  test-gap, diff-vs-report).
- **Worker / Smith** — farm out independent read-only sub-tasks (survey call
  sites, gather failing-test context, check N modules); edits to the one
  worktree stay serial.
- **PM / Dock** — fan out a broad scan (many STATE files, blueprints, inbox
  items) and keep only the conclusion.

## Rules

- **Provider-aware.** Claude Code has the Agent/Task tool; Codex CLI has no
  subagent mechanism and simply does the work in one process — an accepted
  capability gap, not a parity defect (DEC-013). The role still completes its
  step, just without internal parallelism.
- **Within the iteration.** Subagents run and complete inside the current driver
  iteration; they do not change the one-step-per-iteration contract
  (garelier-core `state_machine.md`). A role never spawns a subagent and ends
  its turn waiting on it.
- **The role stays accountable.** Subagents are an internal tool of one role;
  they never cross a role boundary or relax a role rule. A Scout's subagents
  still produce no commits; an Observer's still change no code; a Worker remains
  the single accountable author of its commits. They gather, search, and draft —
  the role decides and owns the result.
- **Proportional.** Subagents cost tokens and add coordination; use them only
  where the parallel win is clear.

See also `role_boundary_matrix.md` (the boundaries subagents must not cross) and
`governed_autonomy_principles.md`. Generalized project knowledge,
Librarian-maintained under PM approval.

## Capacity resilience (provider session caps)

Provider capacity caps end subagents mid-flight with no partial output. A
fan-out designed without this in mind loses everything it spent. Rules:

- **Checkpoint before fan-out.** Persist the work list and per-item results
  as they complete (journal/resume), so a re-run reuses finished items
  instead of re-paying for them.
- **Prefer few resumable waves over one huge burst.** A 12-agent burst that
  dies at 90% costs more than three 4-agent waves that each land.
- **Failure of a verifier is NOT a verdict.** Distinguish three outcomes:
  confirmed, refuted, and UNVERIFIED (the checking agent died or errored).
  Treating unverified as refuted silently discards real findings — the
  producing agent's evidence stands until something actually refutes it.
- **Degrade to the main session.** When caps repeat, the cheapest reliable
  plan is usually sequential work in the primary session (cache-friendly,
  one context) with subagents reserved for genuinely parallel reads.

