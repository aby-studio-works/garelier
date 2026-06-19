# Agent Instructions

This file is the entry point for AI agents (Claude Code, Codex, etc.) working
in this repository. Read it before doing anything else.

> **Non-affiliation.** Garelier is an independent community project. It works
> with Claude Code and Codex CLI but is not affiliated with, endorsed, or
> sponsored by Anthropic or OpenAI. "Claude", "Claude Code", and other marks
> belong to their respective owners.

## Garelier control model

This repository develops the Garelier multi-agent coordination framework.
The framework coordinates AI roles through file-based handoff in a target
project's per-PM `__garelier/<pm_id>/` directory, across two mutually
exclusive lanes:

- **dock lane** — PM → Dock → {Worker, Scout, Smith, Librarian}
  → Guardian → Observer → Dock → `studio` → PM. The coordinated,
  parallel, multi-role path.
- **artisan lane** — PM → Artisan → Guardian → Observer → Artisan →
  `studio` → PM. One agent (the Artisan) performs the combined Dock +
  Worker + Scout + Smith + Librarian scope (build + investigation/web
  research + knowledge) and integrates its own `satchel`.

Both lanes finish at `studio`. After explicit user approval, PM dispatches
Concierge to promote `studio` into `target`.

The two lanes never run at the same time; `runtime/lane.lock` arbitrates
(see DEC-017). The **Observer** is a commit-free, read-only review/advice
sidecar (DEC-019) that runs in **both** lanes: it never takes `lane.lock`
and never merges, so it cannot violate lane exclusivity.

The **Wanderer** (DEC-076) is the **advisory-review role**: an external, opt-in
peer — a separately-launched Codex / Claude Code session (often a different,
strong model) that independently reviews PM design *before it is built*. Unlike
the other ten roles it runs as an external session, takes no lane and no branch,
and makes no commits and no decisions (advisory only); the always-available
**Observer** subagent is its fallback when it is absent or silent.

When working on this framework repository, read the repo-local dashboard in
this order:

1. `__garelier/<pm_id>/control/README.md`
2. `__garelier/<pm_id>/control/project_dashboard/current.md`
3. `__garelier/<pm_id>/control/project_dashboard/roadmap.md`
4. `__garelier/<pm_id>/control/project_dashboard/backlog.md`
5. `__garelier/<pm_id>/control/project_dashboard/decisions.md`
6. `__garelier/<pm_id>/control/project_dashboard/risks.md`
7. `__garelier/<pm_id>/control/project_dashboard/quality_gates.md`

## Terminology

The following names are canonical. Old git-flow-aligned names are
deprecated; do not introduce them in new content.

| Garelier term       | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `pm_id`              | Short PM identifier. Each target-project PM owns `__garelier/<pm_id>/` and `garelier/<target-slug>/<pm_id>/...`. |
| `target`             | Final user-owned branch (e.g., `main`). Garelier touches it only with explicit user approval. |
| `target-slug`        | `target` with `/` replaced by `-` (e.g., `develop/soft` → `develop-soft`). |
| `studio`             | Shared integration and verification branch for both lanes. Managed by Dock in the dock lane and by Artisan for its own integration in the artisan lane. Full name: `garelier/<target-slug>/<pm_id>/studio`. |
| `workbench`          | Individual Worker branch / worktree. Full name: `garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>`. |
| `anvil`              | Individual Smith branch / worktree. Full name: `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>`. |
| `satchel`         | Artisan branch / worktree (artisan lane). Full name: `garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>`. Branched from and merged into `studio` by the Artisan after Guardian + Observer gates (DEC-045). |
| `shelf`              | Librarian branch / worktree (dock lane). Full name: `garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>`. For docs / registry / runbook / internal-knowledge updates; merged through Dock review. |
| `gavel`              | Guardian branch / worktree (security gate, DEC-024). Full name: `garelier/<target-slug>/<pm_id>/gavel/#<id>/<slug>`. Ephemeral — cut at pickup, deleted at IDLE, never committed. Local-only. |
| `clipboard`          | Concierge branch / worktree (external operations, DEC-025). Full name: `garelier/<target-slug>/<pm_id>/clipboard/#<id>/<slug>`. Local-only work ticket; the external write itself goes to `<target>` / non-`garelier/*` prefixes, never to the clipboard branch. |
| `lane`               | One of `artisan` or `dock`. Mutually exclusive execution paths arbitrated by `runtime/lane.lock` (DEC-017). |
| `Artisan`            | Single agent performing the combined Dock + Worker + Scout + Smith + Librarian scope by itself in the artisan lane. Skill: `garelier-artisan`. |
| `Librarian`          | Dock-subordinate role for external-info sync, internal rules, runbooks, and `source_registry`/`routine_registry`. Skill: `garelier-librarian`. |
| `Observer`           | Commit-free, read-only review/advice sidecar (DEC-019 / DEC-045). Independently reviews diffs/reports before Dock or Artisan integrates into `studio`, and gives Workers non-binding code-direction advice. Verdicts: PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION. No branch, no `lane.lock`; runs in both lanes. Skill: `garelier-observer`. |
| `Guardian`           | Commit-free security/privacy/dependency/license **gate** (DEC-024) on an ephemeral `gavel` branch. Applies Librarian-owned `docs/garelier/security/` knowledge; verdicts PASS / PASS_WITH_NOTES / BLOCK / NO_OPINION. Skill: `garelier-guardian`. |
| `Concierge`          | External operations executor / PM's delegate of last resort (DEC-025) on a local-only `clipboard` branch. Executes PM-approved work that leaves the sandbox (Phase 1: promote merge/tag/push); reads Librarian-owned `docs/garelier/external_operations/`; never implements code, decides policy, or gates. Skill: `garelier-concierge`. |
| `Wanderer`           | The **advisory-review role** (DEC-076) — an external, opt-in peer: a separately-launched Codex / Claude Code session (often a different, strong model) that independently reviews non-trivial PM design (blueprints / specs) over the **peer-channel** before it is finalized. Unlike the other ten roles it runs as an external session; opt-in (PM launches it only on explicit user instruction), commit-free, decision-free, singleton, no lane/branch, read-only. Falls back to the **Observer** subagent when absent / silent / rate-limited. Skill: `garelier-wanderer`. |
| `peer-channel`       | Garelier-native append-only inter-session message store under `runtime/peer/<channel>/` (DEC-076) for **advisory** peer review/advice only — never dispatch or merge authority. Carries PM ↔ Wanderer messages; `presence/<peer>.json` heartbeats declare a peer running. |
| `project_dashboard`  | Persistent per-PM planning state (current/roadmap/backlog/decisions/risks/quality_gates/notes). |
| `blueprint`          | PM-authored task specification. In target projects, lives in `__garelier/<pm_id>/control/blueprints/`. |
| `inspection`         | Scout-authored verification, benchmark, dry-run, or research result. Scout drafts it; PM commits the accepted copy under `__garelier/<pm_id>/control/inspections/<category>/`. |
| `delegation`         | Remote/local PM registry and capability boundaries. In target projects, lives in `__garelier/<pm_id>/control/delegation/`. |
| `request_intake`     | Schema and policy for PM-handled request branches. In target projects, lives in `__garelier/<pm_id>/control/request_intake/`. |
| `scheduled_jobs`     | RRULE job definitions owned by Garelier and triggered by external schedulers. In target projects, lives in `__garelier/<pm_id>/control/scheduled_jobs/`. |
| `compact handoff`    | Always-on concise format for role-to-role runtime files, assignments, reports, questions, and manifest activity. |
| `promote`            | Human-approved merge from `studio` into `target`. Replaces the term `release`. |
| `merge_gate`         | Async mechanical merge + configured quality-gate subprocess protocol under `runtime/merge_gate/`. |
| `retention`          | High-volume history / inspection / runtime archive policy. Operational source: `skills/garelier-core/retention.md`. |
| `role_index`         | Single source of truth (`docs/garelier/knowledge/role_index.toml`, DEC-048) mapping each role to its ordered knowledge reading list, with a `read_first` subset every role reads before a non-trivial task. The by-role axis of the DEC-029 topic trees; Librarian-owned. |
| `knowledge_query`    | Read-only request (DEC-048) asking the Librarian to search the curated `docs/garelier/*` trees and return compact pointers when a role's `read_first` set does not resolve a question. Changes no rule (cf. `knowledge_update_request`); not free web research (that is Scout). |
| `control bundle`     | Portable, self-describing snapshot of a PM's tracked `control/` authority (DEC-048), produced by `control_export` with a `control_bundle_manifest.toml`. A local primitive — leaving the sandbox is Concierge + Guardian; handing it to another PM is `request_intake`. |
| `knowledge bundle`   | Portable export of the curated Librarian knowledge trees + registries (DEC-048) with per-file provenance / license. Imported into another project by registering it as a source (never a free adoption). |
| `control`            | Persistent Garelier management documents. In target projects, `__garelier/<pm_id>/control/`. |
| `Garelier Control`   | Standalone management plane using `garelier-control-project`, `garelier-control-library`, or both: canonical control and/or knowledge with bundles, validation, and graphs. The small starter is its minimum deployment; full Garelier adds execution while retaining it. |
| `Garelier Plugin Artisan` | User-facing composition name for Garelier Control plus the PM-guided Artisan lane. `Plugin` is a composition label, not a skill-folder prefix or technical plugin package. |
| `Garelier Plugin Full Garelier` | User-facing composition name for Garelier Control plus full coordinated roles, both lanes, runtime, branches, and driver. |
| `runtime`            | Temporary execution state and inter-role message handoff. In target projects, `__garelier/<pm_id>/runtime/`. |
| `_workshop`          | Default single-user `pm_id` shared by the small starters and full Garelier. Full setup can upgrade the same namespace in place. Shared/multi-user projects use an explicit unique `pm_id`. |

Older artifacts may still mention `develop`, `feature`, `base`, `release`,
`workspace`, `project_state`, `spec`, or `research_report`. When you see
these in historical content (DECs, CHANGELOG entries, prior releases),
treat them as deprecated aliases for the table above.

## Hard rules

- Do not confuse `control/` (persistent authority) with `runtime/`
  (transient state). In target projects both are scoped under
  `__garelier/<pm_id>/`. They have different permissions, different
  audiences, and different git treatment.
- Do not call `runtime/manifest.md` a dashboard. The dashboard is
  `control/project_dashboard/`. The runtime manifest is just an index
  of live agent state.
- Do not promote `studio` to `target` without explicit user approval.
  There is no `auto_promote` flag and there will not be one.
- Do not write production data (database mutation, external API write,
  destructive filesystem operation) without:
  1. A dry-run mode that prints intended changes,
  2. A rollback plan,
  3. Before/after counts and sample records,
  4. Explicit user approval.
  See `control/operations/data_change_policy.md` in the active PM's
  `__garelier/<pm_id>/` tree.
- Garelier role boundaries are firm: PM never writes code or executes a
  promote, Dock
  never writes specs, Worker never merges its own branch, Scout never
  commits. The defined exceptions are: (a) target-tracking / merge-gate
  conflict resolution by Dock/PM (see DEC-001 §2.5 and
  DEC-007); and (b) the **Artisan**,
  which is its own integrator — it merges its own `satchel` branch
  into `studio` after its own quality gate + coverage audits and the
  required Guardian + Observer gates. The Artisan exception is bounded by lane
  exclusivity (never concurrent with the dock lane) and applies
  only in the artisan lane (see DEC-045).
  Every promote of `studio` into `target` requires explicit user instruction
  and is executed by Concierge.
- Non-trivial PM design (a blueprint / project spec that is a large diff, a new
  top-level key, a protected-path / architecture / policy change) must pass
  **independent review and mutual sign-off before it is finalized** (DEC-076).
  The primary reviewer is the **Wanderer** (external advisory peer); when the
  Wanderer is absent, silent past a timeout, or rate-limited, the PM falls back
  to the **Observer** subagent. `auto_approve_blueprints` does NOT bypass this
  gate for a non-trivial design; small blueprints skip it.
- Accepted Scout inspections are persistent control artifacts. Scout
  drafts them, Dock validates them, and PM commits or verifies the
  accepted copy before the Scout task is marked complete.
- For daily/high-volume operation, keep hot files small: rotate PM
  history, date-partition inspections, and prune only role-owned
  gitignored runtime archives per `skills/garelier-core/retention.md`.

## Working in this repository

This is the framework repo. It produces Claude Code skills under
`skills/garelier-*` that are symlinked into `~/.claude/skills/`. There
is no application to build. Work means editing skill documents,
templates, setup wizards, helper scripts, and the Bun/TypeScript driver.

Project-level convention (commits, file layout, two-layer docs sync) is
in `CLAUDE.md`. Read it for repository-specific rules.
