# Roles and execution routes

Framework definition of who owns what, who talks to whom, execution routes, and the
Worker / Scout / Smith distinction. For the per-project boundary *reasoning*
(when a boundary is crossed, how to escalate), see the Librarian system tree's
`system/role_boundary_matrix.md` knowledge doc (DEC-029).

## Role responsibility summary

Read the matching role skill for the full instructions. This is the
one-line summary used for cross-reference.

| Role       | Owns                                       | Talks to                  |
| ---------- | ------------------------------------------ | ------------------------- |
| PM         | blueprints, roadmap, promote decisions, execution-route choice | User, Dock, Artisan, Concierge |
| Dock  | orchestration phases, runtime backlog, studio integration requests | PM, Worker, Scout, Smith, Librarian, Observer, Guardian |
| Worker     | one workbench branch at a time             | Dock (only)          |
| Scout      | one commit-free task at a time             | Dock (only)          |
| Smith      | one anvil branch at a time                 | Dock (only)          |
| Librarian  | one shelf branch at a time (knowledge/registry/runbook) | Dock (only) |
| Artisan    | one satchel branch at a time; the full multi-role scope, solo | PM (only) |
| Observer   | nothing (commit-free, no branch); one review/advice request at a time | the requester (Dock / Artisan / Worker) |
| Guardian   | nothing (commit-free); one security gate at a time on an ephemeral `gavel` branch; emits a verdict, never merges, never edits the policy | the requester (Dock / Concierge / PM) |
| Concierge  | one external operation at a time on a local-only `clipboard` branch; executes the PM-approved op (promote/push/release/PR/ticket/sync) after a Guardian gate; never implements source, never decides policy | PM (only) |

PM owns no git branch: its role is to author blueprints, choose the route,
approve promotes on user instruction, and dispatch Concierge to merge
`garelier/<target-slug>/<pm_id>/studio` into `<target>`.

**Execution routes.** Dock orchestration coordinates the Dock, Worker, Scout,
Smith, and Librarian roles. Artisan single-role work performs the combined
scope on a `satchel`. PM selects either route per task; they may run concurrently.
Every studio write is serialized by `runtime/merge_gate/locks/active.lock`.
Artisan submits a gated merge request and forward-integrates/re-gates when its
expected studio SHA is stale. The **Observer** (DEC-019) is a commit-free,
read-only review/advice sidecar available to every applicable route.

## Roles vs carabiners vs lenses

A **role** (this doc) is a seat: identity, permissions, skill. A **carabiner**
(DEC-095) is a task-form the role clips on **without** changing that seat — the
Observer's `merge_review` vs `refuter`, the Guardian's `preflight` vs
`delta_gate`, the Scout's web-research vs test-suite-run are one role clipping
different carabiners. A **lens** tunes the *focus* of judgment only, orthogonal to
both. New work is expressed by adding a carabiner (or a lens), **not** a role;
adding a role is the last resort. Full taxonomy, the shared-carabiner + per-role
rack ownership model, and the initial carabiner list:
[`carabiners.md`](carabiners.md).

The distinction between Worker, Scout, and Smith is **where the task sits
in the lifecycle**:

- **Worker**: produces commits. Owns a workbench branch. Examples:
  feature implementation, bug fix, refactoring, dependency upgrade,
  documentation edit.
- **Scout**: produces no commits. Output is an inspection at
  `__garelier/<pm_id>/control/inspections/<category>/YYYY/MM/YYYY-MM-DD-<topic>.md`,
  drafted in the Scout worktree and committed by PM after acceptance. Examples:
  web research, accounting calculation, tax filing review, full test
  suite execution with report, deploy health check, benchmark run,
  external API health check, metrics collection.
- **Smith**: produces commits after Worker output is already merged
  into studio. Owns an Anvil branch. Examples: post-merge integration
  tests, system tests, conflict-resolution follow-up, release tooling,
  target-project spec consistency fixes, and enforcement of already
  decided license/security policy.
- **Librarian**: produces commits on a `shelf` branch (Dock-orchestrated,
  Dock-subordinate). Knowledge work: fetch external info from
  registered sources and reflect it into internal docs with
  project-specific augmentation, author runbooks/manuals, and maintain
  `source_registry`/`routine_registry` so PM can re-dispatch standardized
  routines to the right role next time. See `garelier-librarian`.
- **Artisan**: a Artisan route (talks only to PM). Produces commits on
  a `satchel` branch and merges them into `studio`
  itself, performing the combined Dock + Worker + Scout + Smith + Librarian
  scope for one task by itself (investigation / web research and knowledge
  work included). Its studio integration is serialized by the merge gate. See
  `garelier-artisan` and DEC-056.
- **Observer**: produces no commits and no branch. An independent,
  read-only review/advice sidecar (all applicable routes). Requested
  by Dock (before a merge), Artisan (before a studio
  merge), or Worker (non-binding direction advice). Returns a verdict
  (PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION) or
  advice; it is a review *layer*, not a replacement for the quality gate,
  Smith, or Dock review. See `garelier-observer` and DEC-019.

The category subdirectory under `__garelier/<pm_id>/control/inspections/` is
open: any slug works (`tech/`, `accounting/`, `deploy_check/`,
`test_results/`). The setup wizard creates a starter set (`tech/`,
`market/`, `status/`); add more as needs arise.

Workers, Scouts, and Smiths never communicate directly with each other or with PM.
All communication routes through Dock via files in
`__garelier/<pm_id>/runtime/`.
