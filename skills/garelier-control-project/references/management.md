# Management Workflow

## Session start

1. Resolve the project root and managed `pm_id`. When more than one
   `__garelier/<pm_id>/control/control.toml` exists and the user did not name
   one, list the ids/modes and ask which to manage. Do not infer from ordering.
2. Read `control.toml` and `garelier-core/control_contract.md`.
3. Read `project_dashboard/current.md`, then the relevant roadmap, backlog,
   decision, risk, quality-gate, milestone, and blueprint files.
4. Compare the hot files with repository reality before changing them.

## During work

- Record durable decisions immediately in a canonical decision file and add its
  dashboard index row.
- Put multi-step outcomes in a canonical milestone file and link it from roadmap.
- Keep current state concise: active focus, next actions, blockers.
- Add backlog rows only for open outcomes using the canonical `W-NNN` schema.
  Keep acceptance criteria and detailed plans in linked artifacts.
- Remove completed backlog/risk rows in the same commit that resolves them.
- Prefer exact paths, issues, and commit SHAs over pasted narrative.

## Commit timing

Commit when one coherent outcome is reviewable, quality-gated, and revertible.
The commit should include the implementation or document change, relevant tests,
matching control updates, and deletion of its completed backlog row.

Do not create default checkpoints for timestamp-only updates, formatting churn,
broken/WIP state, or multiple unrelated outcomes. An explicit user-requested WIP
checkpoint is the exception.

## Session end

1. Reconcile `current.md` and open-only backlog/risks with reality.
2. Run the control validator.
3. Run the project's relevant quality gate.
4. Commit the coherent outcome when the repository policy permits it.
5. Report changed authority, validation/gate results, and unresolved blockers.

## Compact handoff discipline

Use this when ending a meaningful session, before compact/clear, or when the
next AI session must resume safely.

1. Update `project_dashboard/current.md` with only:
   - active focus;
   - next concrete action;
   - active blockers;
   - read-first pointers.
2. If the handoff needs more detail, write it under `reports/handoffs/` and link
   it from `current.md`.
3. A handoff report may contain what changed, durable authority updated,
   unresolved decisions, open blockers, the exact next action, and files the
   next session should read first.
4. Do not turn `current.md` into a session log.
5. Do not store durable authority in `runtime/`.

## Control-only diagnosis discipline

Use this when the user asks whether project control state is consistent, or
before claiming management work is complete.

Check:

1. `control.toml` exists and identifies the intended namespace.
2. `project_dashboard/current.md` matches repository reality.
3. `backlog.md` and `risks.md` use the canonical tables and contain open items
   only.
4. `decisions.md` indexes canonical files under `decisions/` without
   duplicating their bodies.
5. `notes.md` contains only temporary scratch; promote or delete stale notes.
6. No durable authority is written under `runtime/`.
7. The control graph validator passes.
8. Relevant project quality gates are known or explicitly missing.

Output diagnostics as concise findings and concrete repair actions. Write a
durable report under `reports/diagnostics/` only when it must survive. Do not
emit Guardian-style `PASS` / `BLOCK` verdicts.

## Read-only Status Web

When the user asks to view the managed namespace, launch the shared Status Web
with the resolved project root and `pm_id`. Default to loopback. Do not launch
the autonomous dispatch or create role/runtime execution state.

Control-only namespaces intentionally have no setup config or live agents.
Treat sparse Work/Agents pages as normal; use Control, Knowledge, dashboard,
graph, and Files for management visibility.
