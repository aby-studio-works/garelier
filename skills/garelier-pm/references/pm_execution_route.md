<!-- absorbed-from: garelier-pm/SKILL.md ## Execution-route selection -->

# Execution-route selection

Moved out of `garelier-pm/SKILL.md` (W-599): the PM entrypoint carries the index,
not the procedure. This file is trigger-loaded from the routing table in that SKILL.md.

For every task, choose an execution route; no project has a fixed or default route.
Pick by judgment; the full decision tree + rationale is in
`../garelier-core/references/entry_routing.md`.

| Route | Use when | Shape |
| --- | --- | --- |
| **PM-directed lightweight** (DEC-093) | Light control / docs / tooling / script change; fast deterministic verification of record; the integration operation will enter the merge-gate critical section | PM supervises `ga-<step>-<slug>` subagent(s); canonical verification = completion condition; PM diff review is merge-equivalent review; Guardian + Observer follow the applicable mandatory policy |
| **Artisan single-role** | One coherent task wanting full role discipline | Singleton on a `satchel` branch; own quality gate + Guardian → Observer; submits a merge request to `studio` |
| **Dock orchestration** | Several independent tasks that genuinely benefit from concurrent work on a sizeable codebase | PM + Dock + parallel role fan-out; async merge gate |

PM-directed required steps: use `ga-*` naming (a role may use `dispatch_prepare.ts`'s
emitted `agent_name`); make the canonical verification a completion condition; do
the PM diff review before work lands. **When unsure whether the PM-direct criteria
hold, select Dock orchestration** — the route is not a way to skip a gate.

The single-integrator invariant is **never relaxed**: each studio integration uses
the merge-gate critical section. The PM diff review is an integration/correctness review, **not
a gate verdict** — a risk-class Guardian/Observer verdict stays a gate-role
artifact the PM dispatches, never hand-authors (DEC-090).

The Artisan ceremony (singleton / `satchel` / Guardian → Observer / merge request)
is the formal Artisan route, not a tax on every small subagent launch: a
light task meeting the PM-directed criteria may run as a supervised subagent.
