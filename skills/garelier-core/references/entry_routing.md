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
└─ YES → is it a LIGHT control/docs/tooling/script change (no canonical-sim /
         heavy-workspace touch) on a repo with a FAST DETERMINISTIC verification
         of record (a ci.sh-class gate), single-repo blast radius, one integrator
         at a time?
         │
         ├─ YES → PM-DIRECT LANE  (lightweight, DEC-093)
         │        PM directly supervises ga-<step>-<slug> subagent(s) that commit
         │        to the integration branch. The canonical verification is the
         │        completion condition; the PM diff review is the merge-equivalent
         │        integration review (NOT a Guardian/Observer gate verdict — DEC-090).
         │        Guardian + Observer are ALWAYS required on PM-/Artisan-authored
         │        work (user rule 2026-07-11 — supersedes the earlier risk-class-
         │        only wording; the PM diff review alone never lands a change).
         │        Preventive-fix / mechanism work (framework scripts, gates,
         │        validators, hooks, CI, process rules) is NOT eligible for this
         │        lane at all — dock lane only; see references/lane_selection.md.
         │        When unsure, fall to dock. New patterns not in this tree (codex
         │        proxy seat, field investigation) are in lane_selection.md.
         │
         └─ NO  → does the work split into INDEPENDENT tasks that genuinely benefit
                  from CONCURRENT agents on a sizeable codebase?
                  │
                  ├─ NO  (sequential / one coherent task) → ARTISAN LANE  (DEFAULT)
                  │       one agent does the whole Dock+Worker+Scout+Smith+Librarian
                  │       scope for the task, with full role discipline + gates +
                  │       studio integration. garelier-pm picks the artisan lane.
                  │
                  └─ YES (several independent parallelizable tasks) → DOCK LANE
                          PM + Dock + parallel dispatched-role fan-out (Workflow
                          tool / Codex-seated roles), Guardian→Observer→merge gate.
                          garelier-pm + dock.
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
- **PM-direct is the lightweight lane for light non-product change (DEC-093)** —
  control / docs / tooling / script work where a fast deterministic verification
  of record already exists. It carries no Dock, no merge-gate apparatus, and no
  satchel/lane.lock/Guardian→Observer integration ritual; the PM's own diff
  review plus the canonical verification stand in for them. It is narrow, not a
  general execution lane: product code that wants full role discipline is the
  artisan lane's job.

## The single-integrator invariant (all lanes)

At most one integrator writes the integration branch (`studio`) at a time. The
heavy lanes (dock, artisan) arbitrate that with `runtime/lane.lock`. The
PM-direct lane upholds the *same* invariant by judgment — criterion (d), one
dispatched role to the integration branch at a time, parallel work on isolate branches
(`workspace_isolate.sh`) — and by respecting an existing `lane.lock` rather than
taking one. The invariant is never relaxed; only the mechanism that enforces it
changes for light work. When unsure whether the PM-direct criteria hold, take
the heavier dock lane — the lane must never read as a way to skip a gate.

## Choosing wrong is cheap

All surfaces share one control tree and file protocol. Start light: a
`control-project` starter upgrades in place to full `pm` (DEC-044); PM-direct,
artisan, and dock all switch per task. Pick the lighter option when unsure and
widen later — it is not a one-way door. The one thing that does not flex is the
single-integrator invariant above: never run a second integrator against the
integration branch, in any lane, at the same time.

## Per-seat model

Independently of WHICH surface, choose the model per seat by judgment density
(`model_routing.md`): the Dock and the gate seats
(Guardian/Observer/judge) want the strongest model; a dispatched role, gated
either way, is safe on mid-tier. A mid-tier Dock stays safe by keeping the human gates on
and (when fanning out) running the Jig tick so order is code (DEC-062).

Cross-references: `model_routing.md`, `role_subagent_dispatch.md`,
`mode_e_jig.md`, `mid_tier_model_robustness.md`.
