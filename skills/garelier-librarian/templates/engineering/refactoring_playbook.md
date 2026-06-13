---
knowledge_id: engineering.refactoring_playbook
title: Large-Scale Refactoring Playbook
category: engineering
status: active
owners:
  - pm
consumers:
  - pm
  - worker
  - artisan
  - smith
  - observer
  - scout
source_ids:
  - project-original
last_reviewed_at: 2026-06-12
review_cycle: on-change
---

# Large-Scale Refactoring Playbook

The ordered perspectives for restructuring a whole codebase (or a whole
subsystem) without losing what already works. Per-change discipline lives in
`change_propagation_policy.md` / `change_isolation_policy.md`; this playbook
is the layer ABOVE it: how to decide, sequence, and prove a refactor that
spans many changes. The classic failure it prevents: weeks of "cleanup" that
ends with a different-shaped codebase, no evidence behavior survived, and no
guard stopping the old shape from growing back.

## Phase 0 — Decide WHAT and WHETHER (planning layer)

1. **A whole-codebase refactor is a milestone, never one task.** Write the
   target architecture on ONE page first: module responsibilities, allowed
   dependency directions, and what becomes possible after that is impossible
   now. No written target = wandering, not refactoring.
2. **Hotspot triage decides scope.** Rank by churn × complexity: refactor
   what changes often AND resists change. Stable ugly code is left alone —
   restructuring it is cost without payoff. Record the deliberate exclusions.
3. **Riskiest structural unknown first.** The target architecture always
   rests on an unproven assumption (a boundary that may not hold, an
   abstraction that may cost performance). Spike THAT first as the
   milestone's riskiest-unknown entry — before it, the milestone has no
   completion estimate.

## Phase 1 — Safety net BEFORE moving anything

4. **Record a green baseline at the start SHA.** Full quality-gate output,
   performance numbers, and behavioral snapshots, kept as evidence. Every
   later "behavior unchanged" claim is a diff against this baseline, not
   against memory.
5. **Characterization tests along the cut lines.** Where coverage is thin
   exactly where you will cut, pin CURRENT observable behavior first
   (golden outputs, snapshot parity). They pin behavior including its bugs —
   bug fixes are separate, later changes, never smuggled into the pin.
6. **Inventory the public surfaces.** Separate external contract (consumed
   outside the refactor's reach) from internal shape. Refactoring freedom is
   inversely proportional to exposure; surfaces you cannot freely change get
   adapters, not edits.

## Phase 2 — Map before moving

7. **Refactor the dependency GRAPH, not files.** Chart what actually depends
   on what: cycles, layering inversions, accidental coupling. The plan is a
   sequence of graph edits ("break this cycle, then this layer can move");
   file moves fall out of it, never lead it.
8. **Run the consumer census at codebase scale** (see
   `change_propagation_policy.md` Step 1): twins and parallels, gated code
   (`cfg(test)`, features, platforms), cross-module literals, docs-as-
   consumers. The census output IS the work breakdown — each cluster of
   consumers becomes one dispatchable step.

## Phase 3 — Sequencing rules (per step)

9. **Strangler steps, never a big-bang branch.** Every step lands green on
   the integration branch; the system is releasable between any two steps. A
   refactor branch that diverges for weeks converts review into archaeology
   and merge into a second project.
10. **Mechanical and semantic changes never share a change.** Rename / move /
    extract steps contain ZERO behavior edits and are verified by tooling +
    baseline parity; behavior steps are small and verified by tests. A
    reviewer must be able to say "this diff is large but provably
    behavior-neutral" or "this diff is small and semantically loaded" —
    never both.
11. **One axis per change.** Renaming + restructuring + behavior in one diff
    means none of the three can be verified independently.
12. **Shims are debt with a due date.** Temporary adapters / deprecation
    forwards keep steps small, but each one goes on an explicit removal
    list. The refactor is NOT done while shims remain — "done" with
    permanent shims is the old architecture wearing a costume.

## Phase 4 — Prove completion

13. **Make the target shape enforceable.** Add the lint / layer test /
    dependency check that makes the OLD shape impossible to reintroduce. An
    architecture that only exists in a doc regresses one convenient import
    at a time.
14. **Window-scale parity, not just per-step parity.** At the end, re-run
    the Phase-1 baseline comparison across the WHOLE window: behavior,
    performance, determinism. Per-step green does not compose into
    end-to-end parity (small regressions accumulate below per-step noise).
15. **Claims-vs-reality sweep.** Architecture docs, READMEs, and comments
    describing the old shape now lie; update or delete them. Honestly
    backlog what was deliberately left out (Phase-0 exclusions, remaining
    shims) — an "all done" report with silent leftovers costs more than the
    leftovers.

## Role mapping (Garelier)

| Phase | Owner |
| --- | --- |
| 0 (target, triage, riskiest unknown) | PM (milestone + blueprints, `Kills risk:` linkage) |
| 1–2 (baseline, census, graph map) | Scout inspections (commit-free evidence), Worker for characterization tests |
| 3 (steps) | Worker / Artisan, one step per assignment |
| 4 (enforcement, window parity, doc sweep) | Smith (the window views in `quality/integration_hardening_views.md` are this phase's checklist), Observer for direction advice |
