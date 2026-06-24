# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For the canonical terminology table and hard rules, read `AGENTS.md`
at the repo root first. This file extends it with repository-specific
conventions.

## What this repository is

Garelier is a **framework, not an application**. It produces Claude Code skills (`skills/garelier-*`) that are symlinked into `~/.claude/skills/` and consumed by Claude Code instances in *other* projects; the Bun driver can also pass those same skill files to Codex CLI subprocesses. There is no application to build; work in this repo is editing skill documents, templates, setup wizards, helper scripts, and the Bun/TypeScript driver.

The framework coordinates eleven AI roles (PM, Dock, Worker, Scout, Smith, Artisan, Librarian, Observer, Guardian, Concierge, and the **Wanderer** — DEC-076) through file-based handoff in a target project's per-PM `__garelier/<pm_id>/` directory. The Wanderer is the advisory-review role: unlike the other ten it runs as an external, opt-in, separately-launched session that reviews PM design before build and only advises (no commits, no lane/branch). This repository does not contain or run any target project. Its own planning state is a control-only Garelier Control namespace at `__garelier/<pm_id>/control/`.

## Commands

The executable artifacts are installers, setup wizards, helper scripts, and the TypeScript driver. There is no app build; driver changes should be typechecked.

```bash
./install.sh         # bash (MSYS2 / Git Bash / Linux / macOS)
.\install.ps1        # PowerShell (native Windows; requires Developer Mode for symlinks)
cd skills/garelier-core/driver && bunx tsc --noEmit
```

For ZIP distributions where execute bits may be missing, use
`bash install.sh` or restore via `chmod +x`. The same applies to
`skills/garelier-pm/scripts/setup_wizard.sh`,
`skills/garelier-pm/scripts/control_export.sh`,
`skills/garelier-pm/scripts/control_import.sh`,
`skills/garelier-core/scripts/request_intake_handler.sh`,
`skills/garelier-core/scripts/scheduler_adapter.sh`,
`skills/garelier-core/scripts/merge-gate.sh`,
`skills/garelier-core/scripts/dispatch_prepare.sh`,
`skills/garelier-core/scripts/dispatch_cleanup.sh`,
`skills/garelier-librarian/scripts/knowledge_export.sh`, and
`skills/garelier-librarian/scripts/knowledge_import.sh`.

Both installers symlink each `skills/garelier-*` directory into `~/.claude/skills/` (or `%USERPROFILE%\.claude\skills\`). They MUST produce identical layouts — when changing one, change the other.

The PM setup wizards live under `skills/garelier-pm/scripts/` as `setup_wizard.sh` and `setup_wizard.ps1`. They are invoked by the PM skill at project bootstrap and have **fresh**, **diff**, and **migrate** modes; both shell variants must stay at feature parity.

## Architecture

### Skill dependency graph

```
garelier-core  ◄── garelier-pm
              ◄── garelier-dock
              ◄── garelier-worker
              ◄── garelier-scout
              ◄── garelier-smith
```

`garelier-core` is a reference library — it is never activated standalone. The role skills each declare a dependency on it (`requires: garelier-core ~2.6` in frontmatter) and instruct the agent to "consult garelier-core" for protocol, state machine, and template definitions.

### Two-layer documentation

The same information appears in two places by design, and the two MUST stay in sync:

| `docs/`                       | `skills/garelier-core/`         | Audience                |
| ----------------------------- | -------------------------------- | ----------------------- |
| `docs/concepts.md`            | (none — narrative-only)          | Humans reading the repo |
| `docs/protocol.md`            | `protocol.md` (operational)      | Claude Code at runtime  |
| `docs/compact_handoff.md`     | `compact_handoff.md` (operational) | Claude Code at runtime |
| `docs/state_machine.md`       | `state_machine.md` (operational) | Claude Code at runtime  |
| `docs/retention.md`           | `retention.md` (operational)     | Claude Code at runtime  |
| `docs/output_control.md`      | `output_control.md` (operational) | Claude Code at runtime |
| `docs/pipeline_flow*.md`      | `pipeline_flow*.md` (exact mirror) | Humans + Claude Code |
| `docs/web_console*.md`        | `web_console*.md` (exact mirror) | Humans + Claude Code |
| `docs/control_contract.md`    | `control_contract.md` (exact mirror) | Humans + Claude Code |
| `docs/knowledge_contract.md`  | `skills/garelier-librarian/knowledge_contract.md` (exact mirror) | Humans + Claude Code |
| `docs/getting_started.md`     | (none — bootstrap-only)          | Humans bootstrapping    |
| `__garelier/<pm_id>/control/decisions/` | (none)              | Canonical project decisions and rationale |

`docs/` is the human-readable explanation. `skills/garelier-core/protocol.md`,
`compact_handoff.md`, `state_machine.md`, `retention.md`, and `output_control.md`
are the canonical runtime contracts — when a Garelier role agent reads these,
it acts on them. Exact-mirror pairs must remain byte-identical. If you change
semantics in a primary/summary pair, update the summary in the same change.
`scripts/check_doc_sync.ts` enforces the mechanical parts of this contract.

### Templates are canonical

All Garelier file formats (`manifest.md`, `assignment.md`, `report.md`, `STATE.md`, etc.) are defined as templates under `skills/garelier-core/templates/` and `skills/garelier-pm/templates/`. Role skills tell agents to start from the template — never invent format. When adding a new file format, add the template; when changing an existing format, edit the template and audit references in the role SKILL.md files.

### Branch model the framework imposes on target projects

Target projects gain several local-only branch families under a `garelier/<target-slug>/<pm_id>/` namespace; this repo itself does NOT use them.

| Branch                                            | Owner role | Garelier touches `<target>`    | Notes                          |
| ------------------------------------------------- | ---------- | ------------------------------- | ------------------------------ |
| `<target>` (user-chosen, default `main`)          | User       | Only on explicit instruction    | Concierge merges studio in after PM approval |
| `garelier/<target-slug>/<pm_id>/studio`          | Dock / Artisan | Branched from `<target>`     | Shared integration branch      |
| `garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>` | Worker | One per assignment              | Created at task dispatch       |
| `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>` | Smith   | One per hardening assignment    | Created after studio integration when Dock dispatches Smith |
| `garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>` | Librarian | One per knowledge assignment  | Created from studio when Dock dispatches Librarian (DEC-018) |
| `garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>` | Artisan | One per artisan task        | Branched from `studio`; merged by Artisan into `studio` after gates (DEC-045) |
| `garelier/<target-slug>/<pm_id>/spyglass/#<id>/<slug>` | Scout  | One per investigation (ephemeral) | Cut from studio tip at pickup, deleted at IDLE; never committed (DEC-021) |
| `garelier/<target-slug>/<pm_id>/monocle/#<id>/<slug>` | Observer | One per review (ephemeral)    | Cut from review-target tip at pickup, deleted at IDLE; never committed (DEC-021) |
| `garelier/<target-slug>/<pm_id>/gavel/#<id>/<slug>` | Guardian | One per security gate (ephemeral) | Cut from review-target tip at pickup, deleted at IDLE; never committed (DEC-024) |
| `garelier/<target-slug>/<pm_id>/clipboard/#<id>/<slug>` | Concierge | One per external operation | Local-only work ticket; Concierge executes the approved external op (e.g. promote merge into `<target>`, tag, push); the clipboard branch is never pushed (DEC-025) |

`<target-slug>` replaces `/` with `-` so depth stays constant
(e.g., `target = develop/soft` → slug `develop-soft`).

v0.2.0 removed the `trunk/soft` release-candidate tier that existed in v0.1.0. PM owns no branch — it approves promotes on explicit user instruction and dispatches Concierge to merge `garelier/<target-slug>/<pm_id>/studio` into `<target>`. v1.0 added optional autonomous mode (driver supervises Claude Code sessions, PM auto-approves blueprints when `[autonomy]` is enabled). v2.0 renamed `develop` → `studio`, `feature` → `workbench`, `base` → `target`, `release` → `promote`, `workspace` → `runtime`, `spec` → `blueprint`, `research_report` → `inspection`, and introduced the `__garelier/control/` vs `__garelier/runtime/` split. **v2.1** (DEC-006) introduced per-PM isolation: every `__garelier/{_pm,_dock,_workers,_scouts,control,runtime}` path moved under a `<pm_id>` segment, branch names gained a `<pm_id>` segment, and the top-level shared `control/` was eliminated entirely so multiple developers can run Garelier on the same project. **DEC-014** added Smith and task-scoped Anvil branches for post-merge integration hardening. See DEC-001, DEC-002, DEC-003, DEC-006, and DEC-014.

### Worker / Scout / Smith distinction

The judgement criterion is **commit vs report**:
- **Worker** = produces commits, owns a workbench branch worktree (`__garelier/<pm_id>/_workers/<id>/`).
- **Scout** = produces no commits; output is an inspection draft under `__garelier/<pm_id>/control/inspections/<category>/` in the Scout worktree. PM commits accepted inspections from the primary checkout. Scouts stay on detached HEAD.
- **Smith** = produces commits only after Dock has merged work into studio, owns an Anvil branch worktree (`__garelier/<pm_id>/_smiths/<id>/`) for integration, system, release-tooling, spec-consistency, license, and compliance hardening.

Scouts have no `REVIEWING / MERGED / REWORK` states because there is nothing to merge — re-work means a new investigation. Preserve this asymmetry when editing state-machine docs.

### Directory layout (in target projects)

v2.1+ uses **per-PM isolation** (DEC-006). Each PM has a short id (`<pm_id>`, e.g., `acme`) and owns a fully self-contained Garelier environment at `__garelier/<pm_id>/`. There is no shared coordination state at the top level of `__garelier/`. **DEC-065 (dispatch-native):** fresh setup creates only `_pm/`, `control/`, `runtime/`; producers run in ephemeral `_dispatch<N>/` homes (DEC-063), and every persistent `_<role>/` container below is created on demand only (wizard diff-mode roster add).

```
__garelier/
└── <pm_id>/                       ← one PM's complete Garelier world
    ├── _pm/                       ← plain subdirectory of the main checkout (NOT a worktree)
    ├── _dispatch<N>/              ← ephemeral producer home (DEC-063): STATE.md + checkout/ worktree; created by dispatch_prepare, removed by dispatch_cleanup
    ├── _dock/                     ← plain subdirectory (NOT a worktree; on demand, DEC-065)
    ├── _workers/<id>/             ← container (on demand, DEC-065): coordination files + checkout/ worktree, in-project by default (DEC-036; exile opt-in); workbench branch (DEC-020)
    ├── _scouts/<id>/              ← container; git worktree in checkout/ on a spyglass branch (ephemeral, DEC-021)
    ├── _smiths/<id>/              ← container; git worktree in checkout/ (anvil branch)
    ├── _artisan/                  ← container; git worktree in checkout/ (single; artisan lane, DEC-017)
    ├── _librarians/<id>/          ← container; git worktree in checkout/ (shelf, DEC-018)
    ├── _observers/<id>/           ← container; git worktree in checkout/ on a monocle branch (read-only, DEC-019)
    ├── _guardians/<id>/           ← container; git worktree in checkout/ on a gavel branch (security gate, DEC-024)
    ├── _concierges/<id>/          ← container; git worktree in checkout/ on a clipboard branch (external ops, DEC-025)
    ├── control/                   ← THIS PM's persistent authority (tracked in git)
    │   ├── README.md
    │   ├── project_dashboard/     ← this PM's roadmap/backlog/current/notes/decisions/risks/quality_gates
    │   ├── operations/            ← runbook, promote_checklist, recovery, data_change_policy
    │   ├── blueprints/            ← PM specifications (BP-<N>-<slug>.md)
    │   ├── inspections/           ← accepted Scout inspections
    │   ├── observations/          ← accepted Observer reports (DEC-019)
    │   ├── delegation/            ← known_pms.toml (other local PMs) + remote_pms.toml
    │   ├── request_intake/        ← request branch schema and policy (FOR this PM)
    │   ├── scheduled_jobs/        ← RRULE job definitions
    │   ├── decisions/             ← per-PM DECs (optional)
    │   └── reports/               ← promote / benchmark / data_audit / request archives
    └── runtime/                   ← transient execution state (gitignored, machine-local)
        ├── manifest.md
        ├── backlog/               ← in-flight queue, next_id counter (BP-<N>)
        ├── dock/             ← inbox, escalation, tier_order.json (DEC-031 producer-tier reorder)
        ├── pm/                    ← inbox, resolutions
        ├── observer/              ← Observer request/result inbox (DEC-019)
        ├── guardian/              ← Guardian gate request/result inbox (DEC-024)
        ├── concierge/             ← Concierge external-op request/result inbox + locks/ (DEC-025)
        ├── librarian/             ← Librarian local-only working area: raw/ cache/ drafts/ (DEC-038; curated knowledge is promoted to the tracked knowledge trees)
        ├── requests/              ← normalized delegated requests
        ├── scheduled_jobs/        ← locks and per-run scratch
        ├── merge_gate/            ← async merge requests, results, logs, locks
        ├── workspace_paths        ← role→exile-container pointer, ONLY when exile is opted in (DEC-036; gitignored)
        ├── driver/                ← pids, stop file, logs/, usage/ (DEC-028 usage summary), change_tracker.json
        └── ...
```

**DEC-036 — role worktrees in-project by default (supersedes DEC-035 exile).**
Each `_<role>/<id>/` container lives IN the project (`__garelier/<pm_id>/_<role>/<id>/`)
with its git worktree at `…/checkout/`. The role's cwd (the checkout) is a project
descendant, so Claude Code's `CLAUDE.md` ancestry walk also loads the target's own
`<proj>/CLAUDE.md` — a duplicate of the worktree's copy. That is only a token cost
(identity is prompt-authoritative via the driver's `--append-system-prompt-file`,
not the `CLAUDE.md`), and the wizard neutralizes it in-project: each
`<checkout>/.claude/settings.local.json` sets `claudeMdExcludes` (absolute globs
for `<proj>/CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**`; honored headless)
and is added to the worktree's `info/exclude`. **Exile is opt-in** (`--exile` /
`-Exile` / `GARELIER_HOME` / `[workspace] home_root`): the container becomes a
machine-local home OUTSIDE the project (`$GARELIER_HOME/<home_id>/_<role>/<id>/`,
`home_id` = `<sanitized-basename>-<sha1(abs git-dir)[:8]>-<pm_id>`), recorded in
the gitignored `runtime/workspace_paths` pointer (flat
`<role-singular>.<id>=<absolute container>` lines, plus `artisan=…`). Tools
resolve a role's container through this pointer when present, else the in-project
path — driver `roleContainer()` (`workspace.ts`), wizard `ws_resolve_container` /
`Resolve-WsContainer`, doctor/status resolvers. `--mode migrate` is bidirectional
(default relocates exiled roles BACK in-project). The `_pm` / `_dock`
subdirectories are never relocated — they share the main checkout's index by
design. Default in-project respects Claude Code's launch-folder access model and
works in shared/restricted environments. See DEC-036 (supersedes 0035).

Multiple PMs coexist as sibling directories under `__garelier/`. They never write into each other's trees; cross-PM coordination uses the `request_intake/` mechanism (PM A pushes a request branch, PM B's `request_intake/` ingests into PM B's runtime inbox).

`<pm_id>/_pm/` and `<pm_id>/_dock/` share the main checkout's index because both write to `garelier/<target-slug>/<pm_id>/studio`. This is intentional — do not propose making them worktrees.

Each `__garelier/<pm_id>/control/` is tracked in git. Each `__garelier/<pm_id>/runtime/` is gitignored. The two have different lifetimes; do not mix them. See `__garelier/<pm_id>/control/README.md` for the authority order.

**Project-wide planning**: durable project-management authority lives in the
selected `__garelier/<pm_id>/control/` namespace. Project `docs/` may explain
goals and architecture, but must not maintain a parallel roadmap or backlog.

### Base tracking

`garelier/<target-slug>/<pm_id>/studio` is kept current with `<target>` via **merge** (never rebase — rebase rewrites history that detached-HEAD worktrees reference). Tracking runs before Dock creates a new workbench or Anvil worktree, before Dock merges a workbench or Anvil branch into studio, before Artisan integrates a satchel into studio, and before PM approves and dispatches Concierge for a promote. When `git merge <target>` produces conflicts, the active integration owner (Dock/PM or Artisan in the artisan lane) **resolves them itself** (defined exception to the "no code writing" boundary; see DEC-001 §2.5).

**Forward-integration (`studio` → in-flight workbench/anvil), DEC-039.** The above is one-directional (`target` → `studio`); to keep a *long-running* in-flight producer from drifting, Dock also pushes `studio` forward into open `workbench`/`anvil` branches: each iteration it checks whether a branch is behind the `studio` tip and, if so, drops an (idempotent) `track-target.md` catch-up trigger. The **producer** (Worker / Smith) performs the `git merge <studio>` at its next iteration boundary and **resolves any conflicts itself** — it owns the code, so this does *not* widen Dock's no-code-writing exception (Dock only triggers + verifies). Merge, never rebase. See DEC-039.

## Conventions specific to this repo

- **Bilingual content (JP/EN)**: every human-facing doc should exist in both languages. The standard is an English canonical `X.md` plus a Japanese companion `X.ja.md` (as with `web_console.md`/`web_console.ja.md` and `pipeline_flow.md`/`pipeline_flow.ja.md`; mirror pairs stay byte-identical *within* each language and are registered in `scripts/check_doc_sync.ts` + `docs/canonical_index.md`). The root `README.md` carries both languages in one file (JP then EN). `CHANGELOG.md` is bilingual going forward; past entries stay English. Keep skill frontmatter `description` in English so Claude Code's activation keeps its trigger keywords. When you change one language of a pair, update the other in the same change — don't let the two drift in meaning.
- **`{{placeholder}}`** is the template substitution marker. Don't use `{placeholder}` or `${placeholder}`.
- **Skill frontmatter `description`** is critical: Claude Code uses it to decide when to activate a skill. When editing, keep it dense with trigger keywords and concrete activation conditions — it's not a tagline.
- **No code in `_pm/` or `_dock/` paths** (when they exist in target projects). PM never edits source; Dock only merges and resolves base-tracking conflicts. This is a hard role boundary documented in the role skills — preserve it in any edits.
- **Decisions for big changes**: Significant cross-role or breaking changes get
  a canonical DEC under `__garelier/<pm_id>/control/decisions/`. Keep its
  context, alternatives, decision, and consequences in that record. Use
  `__garelier/<pm_id>/control/project_dashboard/notes.md` only for temporary
  in-flight rationale.
- **Use canonical terminology**: studio / workbench / anvil / shelf / satchel / spyglass / monocle / gavel / clipboard / target / control / runtime / checkout / blueprint / inspection / observation / gate / promote / concierge / pm_id. Don't introduce `develop`, `feature`, `base`, `release`, `workspace`, `spec`, `research_report` in new content. Historical mentions (DECs, CHANGELOG entries) keep the old terms with a "deprecated" note.
- **Commit discipline**: Commit each coherent, reviewable, revertible outcome
  after its relevant quality gate and before starting unrelated work. Do not
  accumulate multiple completed outcomes in one uncommitted worktree. Follow the
  canonical commit-message standard in
  [`skills/garelier-core/commit_convention.md`](skills/garelier-core/commit_convention.md)
  (Conventional Commits + bound item ID; explain *why*, never paste diffs). It is
  a non-mandatory layer — enforced for Garelier-produced commits + opt-in for
  humans, never a repo-global gate that affects non-Garelier contributors.
