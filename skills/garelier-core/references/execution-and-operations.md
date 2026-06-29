# Execution and operations

How Garelier roles execute and how the framework runs: subagents, loading
templates, the autonomous dispatch loop, the intake/schedule adapters, compatibility,
and what this skill is not.

## Execution: use subagents where they help (DEC-022)

The subagent-execution guidance now lives in the Librarian system knowledge tree
so every role consults one canonical copy:
the `system/subagent_execution.md` knowledge doc. In short: when your provider
supports subagents (Claude Code's Agent/Task tool), use them for parallelizable
or decomposable sub-work **within your current iteration** — Scout sweeps,
Observer lenses, Worker/Smith independent read-only sub-tasks, PM/Dock
broad scans — but they never cross a role boundary and you remain the
accountable author. Codex CLI has no subagent mechanism and simply does the work
in one process (an accepted capability gap, not a parity defect — DEC-013).

## Loading templates

Templates live in `templates/` and use `{{placeholder}}` syntax for fields
the caller fills in. When generating a Garelier file:

1. Read the matching template from `templates/<name>`.
2. Replace every `{{placeholder}}` with the appropriate value.
3. Write to the canonical location (see `protocol.md` for paths).
4. Never delete sections of the template; if a section is empty, write
   `(none)` or `(N/A)` so the structure remains parseable.

Internal role-to-role files also follow `compact_handoff.md`: keep facts
short, cite source paths instead of pasting context, and expand only where
compression would create ambiguity or hide risk.

## The autonomous dispatch loop (DEC-057/059/061/066)

Roles execute as **dispatch**: the attended interactive Dock session
(PM in the artisan lane, Dock in the dock lane) delegates each assignment to
a run-to-completion subagent (Agent/Workflow tool) or, for Codex-assigned
roles, a synchronous `codex exec` subprocess. The former headless
per-iteration driver was deleted (DEC-066); there is no daemon, no poll
interval, no pid/lease files.

- **One-off work** needs no `[autonomy]` at all — dispatch directly
  (`references/role_subagent_dispatch.md`; producers prepared by
  `scripts/dispatch_prepare.{sh,ps1}`).
- **The auto-loop** (`[autonomy] enabled = true`) self-paces ticks via
  `/loop`; each tick is OBSERVE → PLAN → DISPATCH → GATE → INTEGRATE →
  RECORD, run as code by the jig (DEC-062, default-on) with the prose tick
  as fallback. See `garelier-pm/references/autonomous-mode.md` §15.
- **State is files**: STATE.md, runtime/manifest.md, control/blueprints/,
  `runtime/dispatch/events.jsonl` — recovered on any session restart; no
  session-lifecycle tricks needed.
- `[runner]` / `[[workers]]`-style blocks remain valid as per-seat
  provider/model defaults (`references/model_routing.md`); `[lanes] default`
  picks the lane when `runtime/lane.lock` is absent (DEC-056).


## Reference intake and schedule adapters

Garelier includes local, dependency-free reference CLIs for guarded
external triggers:

- `skills/garelier-core/scripts/request_intake_handler.sh`
- `skills/garelier-core/scripts/scheduler_adapter.sh`

These scripts are adapters, not autonomous executors. The webhook
receiver still owns signature checks and git checkout. The external
scheduler still owns the clock. The scripts validate the relevant
`control/` contract, write normalized runtime state, and notify PM
through `__garelier/<pm_id>/runtime/pm/inbox/`.

They must never execute request-provided shell fields or scheduled job
bodies directly. PM remains the decision point, and `promote` remains
user-approved only.

## Compatibility

`garelier-core` v2.x (current: v2.9.2). Role skills must declare a
dependency name in their frontmatter (e.g., `requires: garelier-core`).

v2.0.0 is a strictly-renamed superset of v1.0.0 (no behavior changes;
new directory roots `control/` and `runtime/` replace `workspace/`;
templates and skills use the new vocabulary). v0.1.0 → v2.0 has no
automated migration since v0.1 had no production install base; v1.0 →
v2.0 has no automated migration either, but the rename is mechanical
(sed-friendly) for any in-progress v1.0 project.

## What this skill is not

- Not a code generator. Garelier does not produce application code; it
  coordinates agents that do.
- Not a CI system. Garelier does not replace `cargo test`, GitHub
  Actions, or other build infrastructure. Quality gates run inside
  Dock's merge step but are project-defined.
- Not a project management tool. PM in Garelier is an AI role within the
  framework, not a Jira/Linear replacement.
