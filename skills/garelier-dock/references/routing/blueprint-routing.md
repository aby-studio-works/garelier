# Garelier Dock Blueprint Routing Reference

## §4. Reading blueprints and deciding execution strategy

When a blueprint in `__garelier/<pm_id>/control/blueprints/<slug>.md` has
status `active` and is not yet present in
`__garelier/<pm_id>/runtime/backlog/pending.md` or any
`__garelier/<pm_id>/_workers/<id>/assignment.md`, you plan its execution.

### §4.0 Pickup priority (DEC-010)

When the queue holds multiple eligible blueprints (e.g., a Worker
went IDLE and you need to pick the next), sort candidates by:

```
(priority_rank,  milestone_phase_order,  task_id_numeric)
```

where `priority_rank` is read from the blueprint's `## Identity`
section `Priority:` field, mapped: `critical = 0, high = 1,
normal = 2, low = 3`. Missing field → treat as `normal` (rank 2).
Lower rank wins (picked first).

Examples:
- `critical` blueprint from m4 wins over `normal` from m3.
- Two `high` blueprints in same milestone: phase order then task id.
- All `normal` in same phase: task id order (existing behavior).

**Insert-only** (per DEC-010): higher priority arriving while a
Worker is mid-task does **not** preempt that Worker. The urgent
work waits for the next natural IDLE. If the user genuinely needs
a Worker freed up for an emergency, they invoke
garelier-pm/references/runtime/clean-stop.md §13.2 clean-stop;
that is the only mechanism for interrupt, and it is a user-driven
decision, not Dock's.

Priority is recorded in the blueprint file's git history (PM edits
it). Do not auto-promote / demote priority based on age, retries,
or any other heuristic — the field is exactly what PM committed.

Reflect the priority in `runtime/backlog/pending.md` so the operator
can see queue order at a glance. Format example:

```
- [P0 critical] BP-42 fix-render-crash       (m3 phase 1)
- [P1 high]     BP-30 refactor-bench-axis    (m2 phase 1)
- [P2 normal]   BP-25 add-doc-overview       (m1 phase 1)
```

(`P0`/`P1`/`P2`/`P3` shorthand is for human scan; the source of
truth remains the blueprint's `Priority:` field.)

### §4.0.1 Skip non-active statuses (DEC-011)

When scanning `control/blueprints/*.md`, only consider blueprints
with `Status: active`. Skip `draft`, `paused`, `shipped`, `archived`.

`paused` is the operator's queue gate (DEC-011): PM has explicitly
marked the item to be withheld from dispatch (release prep, roadmap
refresh, deliberate idle window). Treat `paused` identically to
`draft` / `archived` for dispatch purposes — it does not appear in
`runtime/backlog/pending.md` and is not picked by the §4.0 sort.

**Do not abort an in-flight Worker just because its blueprint was
paused.** Pause is queue-only. Existing assignments run to
completion; the merge gate proceeds; the studio merge lands
normally. The pause only blocks future dispatches.

Optionally maintain a `## Paused` section in
`runtime/backlog/pending.md` listing paused blueprint ids + slugs
so the operator can see what is on hold at a glance. Example:

```
## Pending (Dock will dispatch)
- [P0 critical] BP-42 fix-render-crash       (m3 phase 1)
- [P2 normal]   BP-25 add-doc-overview       (m1 phase 1)

## Paused (held by PM; not dispatched until status flips to active)
- BP-30 refactor-bench-axis    (paused since 2026-05-26 — promote prep)
```

When PM flips `Status: paused → active`, your next iteration's
scan picks it up like any normal `active` blueprint.

### §4.1 The decision: workflow or phase-decomposed?

Read the blueprint carefully — especially the `Functional requirements`,
`Expected outputs`, and `Acceptance criteria` sections. Then decide:

**Workflow expansion** = one assignment to one agent.
Choose this when:

- `Functional requirements` is empty or has 1–3 items in one
  functional area (e.g., one module, one report).
- `Expected outputs` describes a single deliverable (one branch,
  one inspection file, one report table).
- The blueprint can be completed by a single Worker or Scout
  end-to-end with reasonable confidence.

**Phase-decomposed expansion** = multiple assignments, possibly across
multiple phases.
Choose this when:

- `Functional requirements` has 4+ items spanning multiple subsystems.
- Acceptance criteria reference distinct components that need
  different expertise or independent verification.
- The blueprint explicitly lists dependencies between sub-deliverables
  ("X must be done before Y").
- Risk concentration in one assignment is too high (e.g., touching
  10+ files in a refactor).

**When in doubt, prefer workflow.** Phase decomposition is heavier and
introduces coordination overhead. If a single Worker can handle it
even if it takes them longer, that is usually preferable to splitting
across multiple Workers.

If the blueprint has internal contradictions or you cannot determine
the right shape, **escalate to PM** via §11. Do not guess.

### §4.2 Worker or Scout routing

For each assignment (whether workflow or one phase of a decomposition),
decide Worker vs Scout based on the assignment's deliverable:

| Deliverable shape                                                              | Route to |
| ------------------------------------------------------------------------------ | -------- |
| Code commits on a workbench branch, merged to integration branch               | Worker   |
| Documentation edit committed to integration branch                             | Worker   |
| Refactor that touches code (commits)                                           | Worker   |
| Data-change script (Worker writes; production execution requires user approval per data_change_policy) | Worker |
| Inspection draft at `__garelier/<pm_id>/control/inspections/<cat>/YYYY/MM/<date>-<topic>.md` | Scout → PM intake |
| Test execution + report (no code change)                                       | Scout    |
| External-data fetch + report (e.g., accounting, compliance)                    | Scout    |
| Health check, benchmark, deploy verification report                            | Scout    |
| Post-merge integration/contract/system tests with commits                      | Smith    |
| Fixes after Worker output is already merged into studio                        | Smith    |
| Conflict-resolution follow-up validation or fixes                              | Smith    |
| Target-project spec consistency fixes after integrated code changes            | Smith    |
| Release-adjacent validation/packaging/tooling after integration                 | Smith    |
| Enforcement of project-decided license/security/compliance policy              | Smith    |
| Sync a **registered** external source (e.g. SharePoint rule page) into internal docs Markdown | Librarian |
| Standardize a repeatable procedure into a runbook/manual + routine_registry    | Librarian |
| Maintain `source_registry.toml` / `routine_registry.toml`                       | Librarian |
| Reflect coding/test/review rules into the project's `docs/rules/*.md` rules tree (distinct from the `__garelier/` knowledge store) with project augmentation | Librarian |
| Independent read-only review of a pending merge or an architecture/policy risk (no commits) | Observer |

The principle is: **Worker builds before merge, Scout produces
inspections, Smith hardens after merge, Librarian curates knowledge,
Observer reviews independently before merge.**
A blueprint with `Preferred role hint: librarian` routes here; Librarian
work uses a `shelf` branch
(`garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>`) created from studio
like a Worker workbench, and merges through Dock review (§7.4) + the
merge gate. Do **not** route free investigation (Scout), feature code
(Worker), or QA (Smith) to a Librarian. Mixed assignments should be
split into separate tasks with explicit dependencies.

Observer is **not** routed from a blueprint. Dock raises Observer
requests itself per `[observer_policy]`: `merge_review` before the merge
gate (§7.5), plus `architecture_risk_review` and
`policy_consistency_review` when a change carries design or
protected-path / API / security / data-change risk. The Observer is a
commit-free, read-only sidecar — it adds no branch, never merges, and
never takes `lane.lock` (DEC-019). You consume its verdict in §7.5.

### §4.2.1 When to dispatch Smith

Run this checklist after every Worker merge, and before marking the
blueprint/milestone slice fully done:

- **Mandatory**: dispatch Smith after Dock manually resolves a
  workbench merge conflict.
- Dispatch Smith when Worker-created tests did not cover integration,
  contract, end-to-end, smoke, release, or system boundaries touched by
  the merge.
- Dispatch Smith when the merge changed cross-cutting APIs, shared data
  schemas, packaging, installers, build/release scripts, dependency
  licenses, security-sensitive code, or compliance-sensitive behavior.
- Dispatch Smith when PM or the user explicitly asked for integration
  hardening, system testing, release tooling, spec consistency, or
  license/security checks.
- Before dispatching, check `runtime/backlog/pending.md`,
  `runtime/backlog/in_flight.md`, and `control/project_dashboard/backlog.md`.
  If the same residual work is already tracked, do **not** duplicate it.
  Add a compact note/dependency instead.
- For target-project specs: Smith may edit project docs/specs when the
  assignment says to check consistency. Garelier control docs remain
  PM-owned; inconsistencies there are escalated to PM.
- For license checks: enforce policies already decided by the project.
  If the license/compliance policy is not decided, escalate to PM
  instead of making a code or dependency change.

Smith assignments are task-scoped like Worker assignments and use:

```text
garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>
```

Concurrency and batch dispatch guard:

- The configured `[[smiths]]` set is the hard concurrency cap. One Smith
  can run one Anvil assignment; if all Smiths are non-IDLE, keep merging
  eligible Worker work and queue one Smith hardening batch in
  `runtime/backlog/pending.md`.
- Smith capacity is an operator tuning knob, normally adjusted by the
  user relative to Worker count. Do not auto-throttle Worker throughput
  based only on a Smith/Worker ratio; expose pressure by keeping the
  Smith hardening target counts current in `runtime/manifest.md` and
  parseable by `status.{sh,ps1}`.
- Smith work is **batch-oriented**. When a Smith becomes IDLE, assign it
  the accumulated post-merge hardening window since the last accepted
  Smith-covered studio tip. The assignment should list the covered Worker
  task ids, merge commits, `studio_base_commit`, and
  `studio_tip_at_dispatch`.
- Every queued or active Smith batch must carry a parseable target list:
  `smith_targets: #<worker_task_id>@<merge_sha> ...`. The status helper
  counts these from `pending.md` and active Smith `assignment.md` files.
- An active Smith does **not** freeze Worker dispatch or Worker merge
  gates. Continue dispatching and merging eligible Worker/Scout work.
  Later Worker merges simply fall outside the active Smith's coverage
  window and are included in the next Smith batch.
- If multiple Smiths run concurrently, prefer parallel focus lanes on the
  same coverage window (for example `integration`, `release`, `policy`,
  `spec`). Consecutive windows may be prepared while an earlier Smith is
  still running, but they are preliminary until any required earlier
  Smith fixes are merged into studio.
- Do not create one Smith task per Worker merge while Smith is busy.
  Coalesce compatible post-merge checks into the queued Smith batch unless
  PM/user explicitly asks for separate certification or the risks are
  incompatible.
- Promote readiness is the normal serialization point: if Smith hardening
  is required for a covered change, do not tell PM the slice is promote
  ready until the relevant Smith batch has merged or PM explicitly waives
  the remaining target count and risk.
- Only hold Worker dispatch/merge when PM/user explicitly requests a
  freeze, the Worker has an explicit dependency on a Smith-produced file,
  or the Worker would perform destructive/production work whose safety
  depends on the Smith result. Record the hold in `pending.md` as
  `blocked_on: smith #<task_id> <reason>`.

### §4.3 Pipeline package expansion (preferred, machine-rendered)

For a blueprint that contains `## Pipeline packages`:

1. Run
   `bun skills/garelier-core/driver/src/pipeline_packages.ts validate --blueprint <path>`.
   Any `ERROR` blocks dispatch; ask PM to fix the blueprint. Warnings may be
   dispatched only when Dock records why the warning is acceptable.
2. Run
   `bun skills/garelier-core/driver/src/pipeline_plan.ts --blueprint <path> --pm-id <id> --project <root> --base <studio-branch>`.
   This is a read-only plan: package id, role, dependencies, commit-bearing vs
   read-only path, and exact helper command shapes. It does not claim ids or
   dispatch. Legacy blueprints without `## Pipeline packages` fall back to §4.4.
3. Pick the ready `PP-N` whose `Dispatch` and `Depends on` conditions are
   satisfied. Smith packages are normally delayed until the covered Worker
   package has merged into studio; add the live merge SHA/window at render time.
4. Prepare the role using the package renderer:
   - Worker / Smith / Librarian / Artisan: run `dispatch_prepare.{sh,ps1}` with
     `--blueprint <path>` and `--pipeline-package PP-N`. The helper claims the
     task id, cuts the worktree, writes `context.json`, renders
     `<container>/assignment.md`, and writes advisory `pickup_pack.json`.
   - Scout: run
     `bun skills/garelier-core/driver/src/readonly_assignment_prep.ts --project <root> --pm-id <id> --role scout --blueprint <path> --package PP-N --task-id <id> --container <container>`.
     It writes `assignment.md`, `context.json`, and `pickup_pack.json` without a
     worktree. Scout remains commit-free; no TDD section is rendered.
5. Review the generated assignment for current-state hazards only: stale base,
   protected paths, missing live Smith coverage window, data-change approval, or
   role-boundary contradictions. Do not rewrite package scope by preference; if
   PM's package is wrong, escalate to PM.
6. Dispatch and monitor the role as usual. Dock remains responsible for
   progress, Guardian/Observer/merge gates, rework, and dependency release.

Pipeline packages may represent code work, investigations, routine/knowledge
updates, external read-only checks, and test-only runs. A package is not
Worker-specific; use `Pipeline package` consistently in new docs.

### §4.4 Legacy workflow expansion (one assignment)

For each workflow-shape blueprint without `## Pipeline packages`:

1. Pick a free agent (matching role, IDLE state). If none is free,
   queue the assignment in `__garelier/<pm_id>/runtime/backlog/pending.md`.
2. Generate a unique task ID. Use a monotonically increasing integer
   from `__garelier/<pm_id>/runtime/backlog/next_id` (create with `1` if
   absent).
3. Generate a short slug from the blueprint title (lowercase, hyphens,
   max 30 chars).
4. **Integrate `<target>` into the integration branch** (§8.0) so the
   Worker/Smith starts from the latest tip. Scout assignments do not
   need a task branch, but still read the current studio tip.
5. Write the assignment using
   `../../../garelier-core/templates/assignment.md`,
   filling in:
   - Task ID, agent, milestone, phase ("Phase 1 — workflow")
   - Branch name (Worker/Smith only):
     `garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>`
     or `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>`
   - Branched from: `garelier/<target-slug>/<pm_id>/studio`
   - Smith coverage window (Smith only):
     `studio_base_commit` → `studio_tip_at_dispatch`, plus covered
     Worker task ids and merge SHAs. Later Worker merges are outside
     this Smith task and belong to the next batch.
   - Goal copied from blueprint's `Goal`
   - Inputs: blueprint path + sections referenced + supporting files
   - **Test discipline** section copied from the blueprint when present for
     Worker assignments.
     If mode is `tdd`, include `quality/test_driven_development.md` in the
     assignment's knowledge pointer and add the TDD evidence acceptance
     criterion. If mode is `test-first-waived`, copy the waiver reason; do not
     invent or waive TDD yourself.
   - Acceptance criteria copied from blueprint's `Acceptance criteria`,
     possibly narrowed if the blueprint has out-of-scope items
   - References, estimated effort, notes
   - **Data-change guards** section copied verbatim from the
     blueprint if the blueprint had one. If the blueprint should
     have had one but didn't, escalate before dispatching.
6. Save to the role's container as `<container>/assignment.md` (e.g. for a
   Worker). The container is `__garelier/<pm_id>/_workers/<id>/` for the default
   **in-project** layout (DEC-036) — write there directly. ONLY when **exile**
   is opted in does that segment become a machine-local home outside the project;
   then resolve the container from `__garelier/<pm_id>/runtime/workspace_paths`
   (line `<role-singular>.<id>=<absolute container>`), and write
   `assignment.md` there — a bare in-project `_<role>/<id>/` would not exist and
   the agent would never see it. With no pointer entry (the default) the
   in-project path is the container. The driver also lists each role's resolved
   container in the Dock prompt. See
   `../../../garelier-core/protocol.md` §1 (DEC-036).
7. Execution-state bookkeeping is DERIVED, not hand-written (W-011,
   DEC-064 §3): `runtime/backlog/in_flight.md` is a generated view and the
   manifest carries no per-agent roster rows. Record the dispatch with one
   command — `garelier-core/scripts/dispatch_event.{sh,ps1} --kind start
   --role "<role>(<id>)" --task "#<id> <slug> dispatched"` — which appends
   the event to `runtime/dispatch/events.jsonl` AND regenerates the view.
   Never hand-edit `in_flight.md`.

### §4.5 Phase decomposition (multiple assignments)

For phase-decomposed blueprints:

1. Read the blueprint and identify natural breakpoints: groupings of
   functional requirements that can be implemented independently or
   that have a clear sequencing.
2. Write a phase breakdown document at
   `__garelier/<pm_id>/runtime/backlog/<blueprint_slug>_phases.md` using
   `templates/phase_breakdown.md`. This document is your record of
   how the blueprint was decomposed; the user can review it through
   PM.
3. For each phase, list the assignments. Assignments within a phase
   may run in parallel if there are enough free agents. Phases run
   sequentially unless explicitly marked parallel.
4. For phase 1 (or all parallel-eligible phase-1 assignments),
   generate `assignment.md` files for available agents and queue the
   rest in `pending.md`.
5. For later phases, queue all assignments in `pending.md` with a
   `blocks_on:` field referring to the previous phase's task IDs.
6. Update manifest and backlog.

### §4.6 Dependencies between blueprints

If blueprint A's `Dependencies` lists blueprint B with status
`active` or `shipped`, you may proceed with A only if B is `shipped`.
Otherwise, queue A's assignments with a dependency note and wait.

If B is in `Open questions` state from PM (no status decision), file
an escalation: "Cannot plan A; depends on undecided blueprint B."
