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
project's per-PM `__garelier/<pm_id>/` directory. For each task, the PM chooses
an **execution route**; projects have no fixed or default route:

- **PM planning** — persistent planning/control work with no execution route.
- **PM-directed lightweight** — a small, verified task under PM supervision.
- **Artisan** — one Artisan performs the combined Dock + Worker +
  Scout + Smith + Librarian scope on its own `satchel`.
- **Dock orchestration** — Dock coordinates independent Worker, Scout, Smith, and
  Librarian work.

Execution routes may run in parallel. Every write to `studio` is serialized by the
shared merge-gate critical section (`runtime/merge_gate/locks/active.lock`). After
explicit user approval, PM dispatches Concierge to promote `studio` into `target`.
The **Observer** is a commit-free, read-only review/advice sidecar (DEC-019)
available to every applicable route; it never merges.

The **Wanderer** (DEC-076) is the **advisory-review role**: an external, opt-in
peer — a separately-launched Codex / Claude Code session (often a different,
strong model) that independently reviews PM design *before it is built*. Unlike
the other ten roles it runs as an external session, takes no execution route and no branch,
and makes no commits and no decisions (advisory only); the always-available
**Observer** subagent is its fallback when it is absent or silent.

When working on this framework repository, resolve the exact
`schema_version`/`storage` pair in `control/control.toml` before reading project
state. Schema 3 (`plan_graph_markdown`) is the current default: use bounded
`garelier control context`/`resume`, then expand only the referenced Current,
Checkpoint, Backlog, and nearby plan graph. Direct Markdown authoring remains
canonical after strict parse and validation; shared or automated lifecycle
changes use revision-checked, crash-recoverable `garelier control`
transactions. Run strict doctor and Git reconciliation before completion.

Control supports only schema 3 with `plan_graph_markdown` storage. Every other
version or storage pairing is rejected explicitly; no automated migration entry
point is provided.

## Terminology

The following names are canonical. Old git-flow-aligned names are
deprecated; do not introduce them in new content.

| Garelier term       | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `pm_id`              | Short PM identifier. Each target-project PM owns `__garelier/<pm_id>/` and `garelier/<target-slug>/<pm_id>/...`. |
| `target`             | Final user-owned branch (e.g., `main`). Garelier touches it only with explicit user approval. |
| `target-slug`        | `target` with `/` replaced by `-` (e.g., `develop/soft` → `develop-soft`). |
| `studio`             | Shared integration and verification branch. Dock integrates its route's candidates; Artisan submits its gated `satchel` through the same merge-gate critical section. Full name: `garelier/<target-slug>/<pm_id>/studio`. |
| `workbench`          | Individual Worker branch / worktree. Full name: `garelier/<target-slug>/<pm_id>/workbench/#<id>/<slug>`. |
| `anvil`              | Individual Smith branch / worktree. Full name: `garelier/<target-slug>/<pm_id>/anvil/#<id>/<slug>`. |
| `satchel`         | Artisan branch / worktree. Full name: `garelier/<target-slug>/<pm_id>/satchel/#<id>/<slug>`. After Guardian + Observer gates, the Artisan submits it to the merge gate; a stale expected studio SHA requires forward-integration and re-gating (DEC-045). |
| `shelf`              | Librarian branch / worktree. Full name: `garelier/<target-slug>/<pm_id>/shelf/#<id>/<slug>`. For docs / registry / runbook / internal-knowledge updates; integrated through Dock review and the merge gate. |
| `gavel`              | Guardian branch / worktree (security gate, DEC-024). Full name: `garelier/<target-slug>/<pm_id>/gavel/#<id>/<slug>`. Ephemeral — cut at pickup, deleted at IDLE, never committed. Local-only. |
| `clipboard`          | Concierge branch / worktree (external operations, DEC-025). Full name: `garelier/<target-slug>/<pm_id>/clipboard/#<id>/<slug>`. Local-only work ticket; the external write itself goes to `<target>` / non-`garelier/*` prefixes, never to the clipboard branch. |
| `execution route`    | Per-task PM choice: PM planning, PM-directed lightweight, Artisan, Dock orchestration, or another documented execution route. Routes are not fixed project modes. |
| `Artisan`            | Single agent performing the combined Dock + Worker + Scout + Smith + Librarian scope by itself on an Artisan route. Skill: `garelier-artisan`. |
| `Librarian`          | Dock-subordinate role for external-info sync, internal rules, runbooks, and `source_registry`/`routine_registry`. Skill: `garelier-librarian`. |
| `Observer`           | Commit-free, read-only review/advice sidecar (DEC-019 / DEC-045). Independently reviews diffs/reports before Dock or Artisan submits to `studio`, and gives Workers non-binding code-direction advice. Verdicts: PASS / PASS_WITH_NOTES / REWORK_RECOMMENDED / BLOCK / NO_OPINION. No branch and no integration ownership. Skill: `garelier-observer`. |
| `Guardian`           | Commit-free security/privacy/dependency/license **gate** (DEC-024) on an ephemeral `gavel` branch. Applies the Librarian-owned `security/` knowledge tree; verdicts PASS / PASS_WITH_NOTES / BLOCK / NO_OPINION. Skill: `garelier-guardian`. |
| `Concierge`          | External operations executor / PM's delegate of last resort (DEC-025) on a local-only `clipboard` branch. Executes PM-approved work that leaves the sandbox (Phase 1: promote merge/tag/push); reads the Librarian-owned `external_operations/` knowledge tree; never implements code, decides policy, or gates. Skill: `garelier-concierge`. |
| `Wanderer`           | The **advisory-review role** (DEC-076) — an external, opt-in peer: a separately-launched Codex / Claude Code session (often a different, strong model) that independently reviews non-trivial PM design (blueprints / specs) over the **peer-channel** before it is finalized. Unlike the other ten roles it runs as an external session; opt-in (PM launches it only on explicit user instruction), commit-free, decision-free, singleton, no execution route/branch, read-only. Falls back to the **Observer** subagent when absent / silent / rate-limited. Skill: `garelier-wanderer`. |
| `peer-channel`       | Garelier-native append-only inter-session message store under `runtime/peer/<channel>/` (DEC-076) for **advisory** peer review/advice only — never dispatch or merge authority. Carries PM ↔ Wanderer messages; `presence/<peer>.json` heartbeats declare a peer running. |
| `project_dashboard`  | Schema-3 tracked Current/Notes plus curated/marker-bounded indexes. |
| `blueprint`          | PM-authored task specification. In target projects, lives in `__garelier/<pm_id>/control/blueprints/`. |
| `inspection`         | Scout-authored verification, benchmark, dry-run, or research result. Scout drafts it; PM commits the accepted copy under `__garelier/<pm_id>/control/inspections/<category>/`. |
| `delegation`         | Remote/local PM registry and capability boundaries. In target projects, lives in `__garelier/<pm_id>/control/delegation/`. |
| `request_intake`     | Schema and policy for PM-handled request branches. In target projects, lives in `__garelier/<pm_id>/control/request_intake/`. |
| `scheduled_jobs`     | RRULE job definitions owned by Garelier and triggered by external schedulers. In target projects, lives in `__garelier/<pm_id>/control/scheduled_jobs/`. |
| `compact handoff`    | Always-on concise format for role-to-role runtime files, assignments, reports, questions, and manifest activity. |
| `promote`            | Human-approved merge from `studio` into `target`. Replaces the term `release`. |
| `merge_gate`         | Async mechanical merge + configured quality-gate subprocess protocol under `runtime/merge_gate/`. |
| `retention`          | High-volume history / inspection / runtime archive policy. Operational source: `skills/garelier-core/retention.md`. |
| `role_index`         | Single source of truth (the `role_index.toml` knowledge index, DEC-048) mapping each role to its ordered knowledge reading list, with a `read_first` subset every role reads before a non-trivial task. The by-role axis of the DEC-029 topic trees; Librarian-owned. |
| `knowledge_query`    | Read-only request (DEC-048) asking the Librarian to search the curated knowledge trees and return compact pointers when a role's `read_first` set does not resolve a question. Changes no rule (cf. `knowledge_update_request`); not free web research (that is Scout). |
| `control bundle`     | Portable, self-describing snapshot of a PM's tracked `control/` authority (DEC-048), produced by `control_export` with a `control_bundle_manifest.toml`. A local primitive — leaving the sandbox is Concierge + Guardian; handing it to another PM is `request_intake`. |
| `knowledge bundle`   | Portable export of the curated Librarian knowledge trees + registries (DEC-048) with per-file provenance / license. Imported into another project by registering it as a source (never a free adoption). |
| `control`            | Persistent Garelier management documents. In target projects, `__garelier/<pm_id>/control/`. |
| `Garelier Control`   | The management plane: the canonical `control/` and `knowledge/` trees with bundles, validation, and graphs. Created by `garelier setup` and worked by the PM and Librarian. Execution routes sit on top of it and never replace it. |
| `Garelier Plugin Artisan` | User-facing composition name for Garelier Control plus the PM-guided Artisan route. `Plugin` is a composition label, not a skill-folder prefix or technical plugin package. |
| `Garelier Plugin Full Garelier` | User-facing composition name for Garelier Control plus full coordinated roles, execution routes, runtime, branches, and driver. |
| `runtime`            | Temporary execution state and inter-role message handoff. In target projects, `__garelier/<pm_id>/runtime/`. |
| `_workshop`          | Default single-user `pm_id`. Shared/multi-user projects use an explicit unique `pm_id`. |

Older artifacts may still mention `develop`, `feature`, `base`, `release`,
`workspace`, `project_state`, `spec`, or `research_report`. When you see
these in historical content (DECs, CHANGELOG entries, prior releases),
treat them as deprecated aliases for the table above.

## Hard rules

- Do not confuse `control/` (persistent authority) with `runtime/`
  (transient state). In target projects both are scoped under
  `__garelier/<pm_id>/`. They have different permissions, different
  audiences, and different git treatment.
- Do not call `runtime/manifest.md` project authority. It is only a transient
  live-agent index. Durable authority lives only in `control/`; sessions,
  claims, locks, journals, caches, and generated views live only in
  `runtime/control/`. Schema-3 authority includes its tracked
  `control/project_dashboard/`; every non-canonical Control format is rejected
  explicitly.
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
  required Guardian + Observer gates. The Artisan exception applies only to its
  Artisan route; its studio write is serialized by the merge gate
  (see DEC-045).
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

This is the framework repo. It produces agent skills under
`skills/garelier-*` that are symlinked into `~/.claude/skills/` and
`~/.codex/skills/` for Claude Code and Codex CLI. There is no application to
build. Work means editing skill documents,
templates, setup wizards, helper scripts, and the Bun/TypeScript driver.

Project-level convention (commits, file layout, two-layer docs sync) is
in `CLAUDE.md`. Read it for repository-specific rules.

**Fresh worktree → `bun install` first (W-026).** The driver's
`node_modules/` is gitignored, so a newly created worktree
(`git worktree add …`) has no dependencies. Run `bun install` in the
driver before any typecheck / test, or `ci.ts` fails fast with a
misleading "module not found":

```bash
git worktree add .worktrees/<name> -b <branch> feature/none/soft
( cd .worktrees/<name>/skills/garelier-core/driver && bun install )
bash .worktrees/<name>/ci.ts
```

## Repository quality gate

The Garelier repository owns its Bun/TypeScript commands in its project-local
PM setup configuration; the public framework keeps no language-specific
custom-project default.

- Worker and PM-proxy verification runs the local compiler command
  `node skills/garelier-core/driver/node_modules/typescript/lib/tsc.js --noEmit --project skills/garelier-core/driver/tsconfig.json`
  plus one `bun test <changed existing aggregate targets...>` invocation. It
  does not run the canonical full suite.
- A formal merge candidate runs
  `bun skills/garelier-core/driver/src/scripts/ci.ts` exactly once. Do not run a
  separate doc-sync pass or repeat the full CI before or after that closure.
- Every command has a finite project-configured timeout. Fast verification uses
  10 minutes; full/merge verification uses 120 minutes per command. A merge
  request records `quality_gate_timeout_minutes_per_cmd` explicitly so execution
  does not depend on a runner-side default.

## Permanent test budget

The canonical repository suite is intentionally compact. This is a permanent
development rule, not a one-time cleanup:

- The repository may contain at most 300 executable test definitions. CI fails
  closed at 301. W-327's tighter canonical source ceiling is 245 definitions,
  and the driver suite must report 220–270 tests (target: about 245).
- The source inventory is derived exclusively from paths reported by
  `git ls-files`. Untracked and ignored checkout scratch never consumes the
  budget; if Git cannot enumerate tracked paths, CI fails closed as uncovered
  instead of treating the inventory as zero. A tracked test path absent from
  the worktree fails closed with the path and an unstaged-deletion hint; stage
  an intentional deletion before rerunning CI. Present tracked test files are
  counted from their current worktree contents.
- A standalone test addition is forbidden. A new oracle must consolidate or
  delete existing definitions in the same change, with a net test-definition
  increase of zero or less.
- Aggregate scenario cases obey the same non-growth rule: additions consolidate
  or remove at least as many existing cases. Do not run the same named test once
  as focused coverage and again inside a declared superset; normalize that one
  gate plan through project-declared register supersession. Report before/after
  wall-clock, but do not make wall-clock alone a pass/fail condition.
- Preserve high-risk boundary, negative/fail-closed, integration-contract,
  security, cleanup, Git-ref, lock, and concurrency oracles. Compress repeated
  happy paths, syntax/fixture matrices, and behavior already proven at a lower
  layer.
- Do not meet the budget with runner filters, `skip`/`only`, environment
  switches, weakened assertions, or hidden post-driver reruns. Change the test
  definitions themselves and keep each test unit single-launched.
