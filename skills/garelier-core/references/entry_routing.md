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
├─ NO  → CONTROL LAYER (no roles/lanes/worktrees)
│        • project management (roadmap, backlog, decisions, risks, gates,
│          runbooks, status) → garelier-control-project
│        • reference knowledge (curated docs, registries, runbooks,
│          provenance) → garelier-control-library
│        These two are ORTHOGONAL (different trees), not competing.
│        Capturing a decision/plan here is ALSO the first step before any
│        execution work — land the blueprint/DEC, then execute.
│
└─ YES → does the work split into INDEPENDENT tasks that genuinely benefit
         from CONCURRENT agents on a sizeable codebase?
         │
         ├─ NO  (sequential / one coherent task) → ARTISAN LANE  (DEFAULT)
         │       one agent does the whole Dock+Worker+Scout+Smith+Librarian
         │       scope for the task, with full role discipline + gates +
         │       studio integration. garelier-pm picks the artisan lane.
         │
         └─ YES (several independent parallelizable tasks) → DOCK LANE
                 PM + Dock + parallel producer fan-out (Workflow tool / Codex
                 producers), Guardian→Observer→merge gate. garelier-pm + dock.
```

## Why these defaults

- **Control layer is always cheap and always pays** — durable project memory +
  decision audit trail, useful even with zero agents. Start here.
- **Artisan is the default execution lane (DEC-056)** because most work is one
  coherent task that wants discipline + gates but not the overhead of spinning
  up a multi-agent apparatus.
- **Dock lane is opt-in for real parallelism** — it earns its ceremony only
  when independent tasks can truly run at once (large codebase, isolatable
  work). Do not reach for it by default.

## Choosing wrong is cheap

All surfaces share one control tree and file protocol. Start light: a
`control-project` starter upgrades in place to full `pm` (DEC-044); artisan ⇄
dock switches per task (lane.lock). Pick the lighter option when unsure and
widen later — it is not a one-way door.

## Per-seat model

Independently of WHICH surface, choose the model per seat by judgment density
(`model_routing.md`): the Dock and the gate seats
(Guardian/Observer/judge) want the strongest model; gated producers are safe
on mid-tier. A mid-tier Dock stays safe by keeping the human gates on
and (when fanning out) running the Jig tick so order is code (DEC-062).

Cross-references: `model_routing.md`, `role_subagent_dispatch.md`,
`mode_e_jig.md`, `mid_tier_model_robustness.md`.
