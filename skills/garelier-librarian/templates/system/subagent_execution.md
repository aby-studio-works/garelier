---
knowledge_id: system.subagent_execution
title: Subagent Execution
category: system
status: active
owners:
  - pm
consumers:
  - pm
  - dock
  - worker
  - scout
  - smith
  - artisan
  - observer
source_ids:
  - project-original
last_reviewed_at: 2026-08-02
review_cycle: on-change
---

# Subagent Execution

When and how a role uses provider-native delegation to parallelize work **inside
its own iteration**. Original wording; project-specific. This is an execution
detail within one role's turn, not a new coordination tier.

## Discover capabilities at runtime

Treat the tools and surfaces exposed to the current session as authority. Check
whether the runtime offers independent-agent launch, message delivery,
completion notification, cancellation, and bounded process recovery before
choosing a plan. Provider, product, or version names are descriptive only:
Claude Code Agent/Task and Codex native collaboration agents are examples, not
a fixed capability table. If the needed capability is absent, keep the work in
the accountable session or choose another PM-approved route; do not pretend a
launch occurred.

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
- **PM / Dock** — fan out a broad read-only scan (many STATE files,
  blueprints, inbox items) and keep only the conclusion.

## Rules

- **Capability-aware.** Use only delegation and lifecycle operations actually
  exposed by this runtime. Never infer availability or absence from a provider
  label, an old compatibility note, or another session's tool list.
- **Within the accountable turn.** Subagents run and complete inside the
  current role turn; they do not create a new coordination tier or change the
  role state machine. A role never spawns a subagent and ends its turn waiting
  on it.
- **The role stays accountable.** Subagents are an internal tool of one role;
  they never cross a role boundary or relax a role rule. A Scout's subagents
  still produce no commits; an Observer's still change no code; a Worker remains
  the single accountable author of its commits. They gather, search, and draft —
  the role decides and owns the result.
- **Proportional.** Subagents cost tokens and add coordination; use them only
  where the parallel win is clear.
- **Serialize shared authority and scarce resources.** Parallelize isolated or
  read-only work when capacity permits. Keep edits to one worktree, writes to
  `studio`, merge-gate ownership, and project-declared heavy build resources
  under their single writer or lock. A second agent does not make a shared
  writer safe.
- **Prefer completion events.** When the runtime delivers child completion to
  the parent automatically, consume that event and continue. Do not add a
  polling or repeated-wait loop to confirm it. Explicit waiting is reserved for
  a user-requested monitor or the tool protocol needed to collect a process
  that already yielded a live process handle; every such wait stays bounded.

## Completion is not landing

A child-completion event means only that the delegated turn returned. The
accountable role separately verifies report acceptance, an exact committed SHA,
required Guardian and Observer artifacts, the formal gate result, the exact
`studio` merge result, and terminal land-aftercare evidence. Never infer a later
state from an earlier notification.

See also `role_boundary_matrix.md` (the boundaries subagents must not cross) and
`governed_autonomy_principles.md`. Generalized project knowledge,
Librarian-maintained under PM approval.

## Capacity resilience (provider session caps)

Provider capacity caps can end subagents mid-flight with no partial output. A
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
