---
name: garelier-control-project
requires: garelier-core ~2.5
description: Manage Garelier's canonical __garelier/<pm_id>/control/ project-control tree from the currently running Claude Code or Codex session without roles, lanes, worktrees, or driver. Use for roadmap, backlog, current state, decisions, risks, quality gates, runbooks, import/export, consolidation/splitting, derived control graph, read-only Status Web, compact handoff, and control-only diagnosis.
---

# Garelier Project Control

This skill turns the **currently running AI** into the manager of one canonical
Garelier control namespace. It uses full Garelier's persistent storage and
artifact formats without enabling roles, branches, worktrees, lanes, or driver.

`garelier-control-project` plus `garelier-control-library` is the standalone **Garelier Control**
management plane. It can remain lightweight indefinitely or later gain full
Garelier execution without changing its durable management data.

## Activation

1. Read `../garelier-core/control_contract.md`.
2. Resolve the managed `pm_id`:
   - use the id explicitly named by the user;
   - otherwise use the sole evident `__garelier/<pm_id>/control/control.toml`;
   - if multiple control namespaces exist, list them and ask which one to
     manage; never silently choose `_workshop` or the first match;
   - otherwise default to single-user id `_workshop`.
3. Treat that namespace as the management authority for this session.
4. Read `control/control.toml`, `control/project_dashboard/README.md`, then only
   the relevant dashboard/artifact files.

`_workshop` is preferred over `_workspace`: `workspace` is a deprecated Garelier
alias for `runtime` and would make the control/runtime boundary ambiguous.
This selection rule also applies after full Garelier is running: a separately
launched AI can use `garelier-control-project` against any full or control-only
namespace.

## Initialize

When the namespace is absent, run the matching helper:

```powershell
garelier control-init -Project <project-root> -PmId _workshop
```

```bash
garelier control-init --project <project-root> --pm-id _workshop
```

The helper copies missing files from the shared canonical
`garelier-core/templates/control_scaffold/`, writes `control.toml`, creates
gitignored `runtime/import/` staging, and never overwrites curated files.

To upgrade later, run the `garelier-pm` fresh setup wizard with the same
`pm_id`. It preserves this control tree and knowledge, adds full Garelier, and
continues operating as `_workshop`.

## Manage

- Keep `project_dashboard/` short and current.
- Create milestones and decisions from `control/templates/`.
- Keep backlog and risks open-only and in the canonical table schemas; delete
  resolved rows in the resolving commit.
- Use git history for completed work and prior hot-file state.
- Commit each coherent, reviewable, revertible durable outcome after its relevant
  quality gate. Include matching tests/control updates and backlog deletion in
  that commit.
- Treat compact handoff and control-only diagnosis as built-in project-control
  procedures, not separate skills or roles.
- Keep `project_dashboard/current.md` as the compact resume surface for `/loop`,
  `/goal`, compact, clear, and restarted sessions.
- Put long handoff or diagnostic detail under `reports/` only when it must
  survive; keep `current.md` to pointers and next actions.
- Use `references/management.md` for the detailed session workflow.
- For document-format standards and the minimal read set per task, use
  `skills/garelier-core/navigation.md` + `skills/garelier-core/document_standards.md`
  (reach the right format file without scanning trees).

## Import / export

When asked to import or export, read `references/import-export.md`.

- Clean Garelier data uses `control_import` / `control_export`.
- Messy external input is staged under `runtime/import/`, inventoried,
  normalized into canonical templates, validated, reviewed, and only then moved
  into tracked `control/`.
- Runtime/raw input is never exported or committed by default.

## Consolidate or split PM controls

When asked to combine multiple `pm_id` control trees, read
`references/consolidation.md`. Consolidation may target a new id or an existing
id such as `_workshop`. It preserves all source namespaces, stages snapshots and
conflicts under destination runtime, then normalizes reviewed authority into the
destination control tree. It does not merge or retire full-PM runtime, roles,
worktrees, or branches.

When asked to separate part of a namespace such as `_workshop`, read
`references/splitting.md`. Splitting stages only explicitly selected control
artifacts into a new/existing destination namespace, identifies dependencies,
and leaves the source unchanged until the user separately approves cleanup.

## Status Web, validate, and graph

This standalone skill may launch the shared read-only Status Web without
enabling the driver, roles, branches, or worktrees. Use loopback unless the user
explicitly asks for LAN access:

```powershell
garelier status-web -Project <root> -PmId <pm_id> -Loopback
```

```bash
garelier status-web --project <root> --pm-id <pm_id> --loopback
```

Use the matching `status_web_status` / `stop_status` helper to inspect or stop
it. In control-only mode, runtime/agent pages are naturally sparse; the
Control, Knowledge, graph, dashboard, and file views remain useful. Status Web
is read-only and never starts the full Garelier driver.

Run the shared graph/validator before claiming a management, import, or export
task is complete:

```bash
garelier control-graph --project <root> --pm-id <pm_id> --validate
```

Use `--format mermaid` or `--format json` for a derived view. Full Garelier also
shows the same graph in Status Web's **Control** page.

## Boundaries

- This skill manages control artifacts; it does not become a full
  Garelier PM and does not start the driver. Its only optional process is the
  read-only Status Web.
- This skill is not `garelier-pm`: it does not choose lanes, start Dock or
  Artisan, approve promote, or dispatch Concierge.
- Do not create separate `garelier-control-handoff` or
  `garelier-control-diagnose` skills. Those are procedures inside this skill.
- Never write durable authority into `runtime/`.
- Never silently overwrite import collisions or invent answers for ambiguous
  source data.
- Never commit secrets, raw external dumps, or unreviewed imported material.
