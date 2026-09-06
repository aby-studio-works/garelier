# Entry routing — the one rule (DEC-063)

Which Garelier surface to use, as a codified default so the choice is not left
to the Dock's memory. This is a **default, not a toll booth**: a
confident Dock may route by judgment and skip straight to the right
surface. It exists so a mid-tier model (the default driver, e.g. opus-medium)
always has a front door.

## The decision

```
Does the request need CODE EXECUTION (agents changing files/branches)?
│
├─ NO  → PM, no execution route/worktree (DEC-097 retired control-only)
│        The PM works the two trees directly — they are ORTHOGONAL
│        (different trees), not competing:
│        • project management (roadmap, backlog, decisions, risks, gates,
│          runbooks, status) → the `control/` tree via `garelier control`
│          (garelier-pm, references/control-management.md)
│        • reference knowledge (curated docs, registries, runbooks,
│          provenance) → the `knowledge/` tree via the Librarian
│          (garelier-librarian, knowledge_contract.md)
│        Capturing a decision/plan here is ALSO the first step before any
│        execution work — land the blueprint/DEC, then execute.
│
└─ YES → is it a LIGHT control/docs/tooling/script change (no canonical-sim /
         heavy-workspace touch) on a repo with a FAST DETERMINISTIC verification
         of record (a ci.ts-class gate), single-repo blast radius, one integrator
         at a time?
         │
         ├─ YES → PM-DIRECTED LIGHTWEIGHT ROUTE (DEC-093)
         │        PM directly supervises ga-<step>-<slug> subagent(s) that commit
         │        to the integration branch. The canonical verification is the
         │        completion condition; the PM diff review is the merge-equivalent
         │        integration review (NOT a Guardian/Observer gate verdict — DEC-090).
         │        Guardian + Observer are ALWAYS required on PM-/Artisan-authored
         │        work (user rule 2026-07-11 — supersedes the earlier risk-class-
         │        only wording; the PM diff review alone never lands a change).
         │        Preventive-fix / mechanism work (framework scripts, gates,
         │        validators, hooks, CI, process rules) is NOT eligible for this
         │        route at all — Dock orchestration only; see references/lane_selection.md.
         │        When unsure, fall to dock. New patterns not in this tree (codex
         │        proxy seat, field investigation) are in lane_selection.md.
         │
         └─ NO  → does the work split into INDEPENDENT tasks that genuinely benefit
                  from CONCURRENT agents on a sizeable codebase?
                  │
                  ├─ NO  (sequential / one coherent task) → ARTISAN ARTISAN ROUTE
                  │       one agent does the whole Dock+Worker+Scout+Smith+Librarian
                  │       scope for the task, with full role discipline + gates +
                  │       studio integration. garelier-pm selects this route per task.
                  │
                  └─ YES (several independent parallelizable tasks) → DOCK ORCHESTRATION
                          PM + Dock + parallel dispatched-role fan-out (Workflow
                          tool / Codex-seated roles), Guardian→Observer→merge gate.
                          garelier-pm + dock.
```

## Why these defaults

- **Control layer is always cheap and always pays** — durable project memory +
  decision audit trail, useful even with zero agents. Start here.
- **Artisan is a Artisan route (DEC-056)** for one
  coherent task that wants discipline + gates but not the overhead of spinning
  up a multi-agent apparatus.
- **Dock orchestration is for real parallelism** — it earns its ceremony only
  when independent tasks can truly run at once (large codebase, isolatable
  work). Do not reach for it by default.
- **PM-directed is the lightweight route for light non-product change (DEC-093)** —
  control / docs / tooling / script work where a fast deterministic verification
  of record already exists. It carries no Dock, no merge-gate apparatus, and no
  satchel/Guardian→Observer/merge-request integration ritual; the PM's own diff
  review plus the canonical verification stand in for them. It is narrow, not a
  general execution route: product code that wants full role discipline is the
  Artisan route's job.

## The single-integrator invariant (all routes)

At most one integrator writes the integration branch (`studio`) at a time. Every
route enters the shared merge-gate critical section
`runtime/merge_gate/locks/active.lock`; routes may otherwise run concurrently.
When unsure whether the PM-directed criteria hold, select Dock orchestration — a
route must never read as a way to skip a gate.

## Choosing wrong is cheap

All routes share one control tree and file protocol, created once by
`garelier setup`; PM-direct, artisan, and dock all switch per task. Pick the
lighter option when unsure and widen later — it is not a one-way door. The one thing that does not flex is the
single-integrator invariant above: never run a second integrator against the
integration branch, on any route, at the same time.

## Per-seat model

Independently of WHICH surface, choose the model per seat by judgment density
(`model_routing.md`): the Dock and the gate seats
(Guardian/Observer/judge) want the strongest model; a dispatched role, gated
either way, is safe on mid-tier. A mid-tier Dock stays safe by keeping the human gates on
and (when fanning out) running the Jig tick so order is code (DEC-062).

Cross-references: `model_routing.md`, `role_subagent_dispatch.md`,
`jig.md`, `mid_tier_model_robustness.md`.
