# Execution and operations

How Garelier roles execute and how the framework runs: subagents, loading
templates, the autonomous dispatch loop, the intake/schedule adapters, compatibility,
and what this skill is not.

## Execution: use subagents where they help (DEC-022)

The subagent-execution guidance lives in the Librarian system knowledge tree so
every role consults one canonical copy: `system/subagent_execution.md`. Discover
the current runtime's exposed delegation and lifecycle capabilities before
planning; provider and product names are examples, never availability
authority. Apply that document's parallelism, single-writer, completion-event,
bounded-wait, and landing-evidence rules without restating them here.

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
(PM for the Artisan Artisan route, Dock for Dock orchestration) delegates each assignment to
a run-to-completion subagent or a recorded provider CLI helper selected by
`dispatch_prepare.provider_parent_routes`. The helper is synchronous; an
over-budget launch is owned by the durable single-flight broker. The former headless
per-iteration driver was deleted (DEC-066); there is no daemon, no poll
interval, no pid/lease files.

- **One-off work** needs no `[autonomy]` at all — dispatch directly
  (`references/role_subagent_dispatch.md`; roles prepared by
  `driver/src/scripts/dispatch_prepare.ts`).
- **The auto-loop** (`[autonomy] enabled = true`) self-paces ticks via
  `/loop`; each tick is OBSERVE → PLAN → DISPATCH → GATE → INTEGRATE →
  RECORD, run as code by the jig (DEC-062, default-on) with the prose tick
  as fallback. See `garelier-pm/references/autonomous-mode.md` §15.
- **State is files**: STATE.md, runtime/manifest.md, control/blueprints/,
  `runtime/dispatch/events.jsonl` — recovered on any session restart; no
  session-lifecycle tricks needed.
- `[runner]` `pm_*` / `dock_*` keys affect only those controlling sessions.
  `[[workers]]`-style blocks are optional persistent-container inventory and
  never route role tasks. PM selects the route/provider/model/effort per
  task; blueprint hints and `[model_routing]` are fallbacks
  (`references/model_routing.md`).


## Reference intake and schedule adapters

Garelier includes local, dependency-free reference CLIs for guarded
external triggers:

- `skills/garelier-core/driver/src/scripts/request_intake_handler.ts`
- `skills/garelier-core/driver/src/scripts/scheduler_adapter.ts`

These scripts are adapters, not autonomous executors. The webhook
receiver still owns signature checks and git checkout. The external
scheduler still owns the clock. The scripts validate the relevant
`control/` contract, write normalized runtime state, and notify PM
through `__garelier/<pm_id>/runtime/pm/inbox/`.

They must never execute request-provided shell fields or scheduled job
bodies directly. PM remains the decision point, and `promote` remains
user-approved only.

## Compatibility

`garelier-core` v2.x (current: v2.10.0). Role skills must declare a
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
- Not a CI system. Garelier does not replace your test suite, GitHub
  Actions, or other build infrastructure. Quality gates run inside
  Dock's merge step but are project-defined.
- Not a project management tool. PM in Garelier is an AI role within the
  framework, not a Jira/Linear replacement.
