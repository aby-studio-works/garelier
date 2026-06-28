# Branches and layout

Framework structure for garelier-core: the branch families, the per-PM
directory layout, the `control/` vs `runtime/` split, and base-tracking
discipline. `protocol.md` remains the canonical source for the full ownership
matrix, the directory tree, and the branch push policy when those exact details
are needed — this reference gives orientation; `protocol.md` governs.

## Branch hierarchy

Garelier separates the management root from the target Git root when Plant-Crust
is active. Branches in this section are always created in `target_root`:

- Plant-Lithosphere: `control_root == target_root`.
- Plant-Crust: `workfolder_root` stores only `crust.toml`; each selected
  `container_root` is the `control_root` that stores `__garelier/`, while
  `target_root` stores the target repository and all `garelier/*` branches.
  `workfolder_root/__garelier` is not used.

The `<target>` is chosen by the user at setup (default: `main`). The
`<target-slug>` replaces `/` with `-` so branch depth stays constant.
Each PM has a short `<pm_id>` that namespaces both directories AND
branches.

| Branch                                                          | Owner     | Merge trigger                  |
| --------------------------------------------------------------- | --------- | ------------------------------ |
| `<target>` (e.g., `main`)                                       | User      | Concierge merges in after explicit user/PM approval (promote) |
| `garelier/<target-slug>/<pm_id>/studio`                        | Dock / Artisan | Accepted producer integration in the active lane |
| `garelier/<target-slug>/<pm_id>/workbench/#<N>/<name>`         | Worker    | Created on assignment          |
| `garelier/<target-slug>/<pm_id>/anvil/#<N>/<name>`             | Smith     | Created on post-merge hardening assignment |
| `garelier/<target-slug>/<pm_id>/satchel/#<N>/<name>`        | Artisan   | Artisan merges it into `studio` after Guardian + Observer (DEC-045) |
| `garelier/<target-slug>/<pm_id>/shelf/#<N>/<name>`             | Librarian | Created on knowledge/registry/runbook assignment; merged via Dock |
| `garelier/<target-slug>/<pm_id>/spyglass/#<N>/<name>`          | Scout     | Ephemeral; cut from studio tip at pickup, deleted at IDLE, never merged (DEC-021) |
| `garelier/<target-slug>/<pm_id>/monocle/#<N>/<name>`           | Observer  | Ephemeral; cut from the review-target tip at pickup, deleted at IDLE, never merged (DEC-021) |
| `garelier/<target-slug>/<pm_id>/gavel/#<N>/<name>`             | Guardian  | Ephemeral; cut from the review-target tip at pickup, deleted at IDLE, never merged (DEC-024) |
| `garelier/<target-slug>/<pm_id>/clipboard/#<N>/<name>`         | Concierge | Local-only work ticket; never pushed, never merged into a garelier branch (DEC-025) |

The `satchel` and `shelf` families belong to the artisan and dock
lanes respectively. The artisan lane (Artisan → `satchel` → `studio`)
and the dock lane (everything via `studio`) are mutually exclusive,
arbitrated by `runtime/lane.lock` (DEC-017).

The `spyglass`, `monocle`, and `gavel` families are ephemeral read-only
branches (cut at pickup, deleted at IDLE, never committed to or merged); the
`clipboard` family is a local-only Concierge work ticket (never pushed). Aside
from these, Garelier creates no other branch families. If a project requires
additional branches (release tags, hotfix branches), document them in the
project's `AGENTS.md`.

Garelier never modifies `<target>` except on explicit user instruction
executed by Concierge after PM approval (promote). There is no separate "trunk" tier in v2.0 —
the role of release candidate is implicit in
`garelier/<target-slug>/<pm_id>/studio` at the moment PM decides to
promote.

## Directory layout

v2.1+ uses per-PM isolation (DEC-006). Each PM has its own complete Garelier
environment under `__garelier/<pm_id>/` in the active control root. In
Plant-Crust, the workfolder is a registry only; the tree below lives in each
container, not under `workfolder_root`.

```
<control_root>/                                      Garelier control root
├── __garelier/
│   └── <pm_id>/                                      One PM's complete Garelier world
│       ├── _pm/                                      PM role's subdirectory (NOT a worktree)
│       ├── _dock/                               Dock role's subdirectory (NOT a worktree)
│       ├── _workers/<id>/                            Worker worktrees (one per Worker)
│       ├── _scouts/<id>/                             Scout worktrees (one per Scout)
│       ├── _smiths/<id>/                             Smith worktrees (one per Smith)
│       ├── _librarians/<id>/                         Librarian worktrees (one per Librarian; dock lane)
│       ├── _observers/<id>/                          Observer worktrees (one per Observer; read-only sidecar, both lanes; detached HEAD)
│       ├── _guardians/<id>/                          Guardian worktrees (one per Guardian; gavel branch, ephemeral, DEC-024)
│       ├── _concierges/<id>/                         Concierge worktrees (one per Concierge; clipboard branch, local-only, DEC-025)
│       ├── _artisan/                                 Artisan worktree (singleton; artisan lane)
│       ├── control/                                  This PM's persistent authority (tracked in git)
│       │   ├── README.md
│       │   ├── project_dashboard/                    This PM's roadmap/backlog/current/notes/decisions/risks/quality_gates
│       │   ├── operations/                           Runbook, promote_checklist, recovery, data_change_policy
│       │   ├── blueprints/                           PM-authored task specifications (BP-<N>-<slug>.md)
│       │   ├── inspections/                          Accepted Scout inspections
│       │   ├── delegation/                           Other PMs this PM knows about (known_pms.toml + remote_pms.toml)
│       │   ├── request_intake/                       Request branch schema and intake policy (FOR this PM)
│       │   ├── scheduled_jobs/                       RRULE job definitions
│       │   ├── decisions/                            Per-PM DECs (optional)
│       │   └── reports/                              Persistent promote/benchmark/data_audit/request records
│       └── runtime/                                  Transient execution state (gitignored)
│           ├── manifest.md                           Live agent state index
│           ├── backlog/                              pending / in_flight / done / requeued / next_id
│           ├── dock/                            Inbox, outbox, escalation, tier_order.json
│           ├── pm/                                   Inbox, resolutions
│           ├── observer/                             Observer review request/result inbox (DEC-019)
│           ├── guardian/                             Guardian security-gate request/result inbox (DEC-024)
│           ├── concierge/                            Concierge external-op request/result inbox + locks/ (DEC-025)
│           ├── requests/                             Delegated request intake state
│           ├── scheduled_jobs/                       Locks and per-run scratch
│           └── driver/                               Pids, stop file
├── AGENTS.md                                         Garelier/container rules in Plant-Crust; target rules in Lithosphere
└── ...

<target_root>/                                       Target project Git root
├── AGENTS.md                                         Target-project rules
├── docs/                                             Project explanation and design docs; not management authority
└── (project source)
```

In Plant-Lithosphere, `control_root` and `target_root` are the same directory,
so the two blocks above collapse into the traditional single checkout.

In Plant-Crust, PM may read registered containers listed in `crust.toml` and
write per-container Dock requests under
`container_root/__garelier/<pm_id>/runtime/dock/inbox/`. Dock and all
subordinate roles are scoped to one active container and must not read or write
sibling containers.

Multiple PMs coexist as sibling directories under `__garelier/`.
They never write into each other's trees; cross-PM coordination uses
the `request_intake/` mechanism.

`__garelier/<pm_id>/_pm/` and `__garelier/<pm_id>/_dock/` are
plain directories under the primary worktree (which is on
`garelier/<target-slug>/<pm_id>/studio`). They share the same git
index — PM's blueprint commits and Dock's merge commits both
land on the studio branch from the same checkout.

`__garelier/<pm_id>/_workers/<id>/`,
`__garelier/<pm_id>/_scouts/<id>/`, and
`__garelier/<pm_id>/_smiths/<id>/` ARE separate `git worktree`
directories. Workers are on detached HEAD when IDLE and on
`garelier/<target-slug>/<pm_id>/workbench/#<N>/<slug>` when
assigned. Smiths are on detached HEAD when IDLE and on
`garelier/<target-slug>/<pm_id>/anvil/#<N>/<slug>` when assigned.
Scouts cut a throwaway `spyglass/#<N>/<slug>` branch from the studio tip at
pickup and delete it on return to IDLE (DEC-021); Observers and Guardians do
the same with `monocle` / `gavel`. They never commit to these branches.

Agent IDs identify stable role slots, not providers. Prefer `<role>-NN`,
e.g., `worker-01`, `worker-02`, `scout-01`, `smith-01`, and `artisan-01`.
The same ID is reused inside `__garelier/<pm_id>/runtime/` to refer to that
role instance. `provider` / `model` can change while the slot and its container
stay the same. IDs only need to be unique within one PM's tree — two PMs can
each have their own `worker-01` without collision.

## `control/` vs `runtime/`

This is the most important distinction in v2.0. Mixing them causes
subtle bugs.

| Aspect            | `__garelier/<pm_id>/control/`                       | `__garelier/<pm_id>/runtime/`                  |
| ----------------- | -------------------------------------------- | --------------------------------------- |
| Lifetime          | Project-long                                 | Iteration-long (often seconds-to-hours) |
| Git tracking      | Yes                                          | No (nested `__garelier/.gitignore`, DEC-051) |
| Audience          | PM, user, future onboarding, audit           | Live agents passing messages            |
| Typical writer    | PM (mostly), Scout (inspections)             | Dock (manifest), Worker/Scout/Smith (inbox notifications) |
| Authority         | Source of truth for plans, decisions, rules  | Source of truth for "what is running right now" |

Always ask: does this file persist past the next driver poll? If yes,
it belongs in `control/`. If no, it belongs in `runtime/`.

## Base-tracking discipline

`garelier/<target-slug>/<pm_id>/studio` is kept current with `<target>` via
**merge** (never rebase). Tracking runs at three points:

1. **Before Dock creates a new workbench/Anvil branch or Artisan creates a satchel** —
   `git merge <target>` into the studio branch first.
2. **Before Dock merges a workbench or Anvil branch into studio** —
   `git merge <target>` into studio, then merge the branch.
3. **Immediately before PM approves and dispatches Concierge for a promote** —
   `git merge <target>` into studio as a safety net. Concierge performs the
   approved `studio` to `<target>` merge; PM never executes it.

When `git merge <target>` produces conflicts, Dock/PM **resolve them
themselves** (this is a defined exception to the "no code writing"
boundary; see DEC-001 §2.5 in the repo). They escalate only when the
resolution is genuinely ambiguous from blueprint + code context.

Workers and Smiths do not see target conflicts — those happen on studio,
not on their task branch.
