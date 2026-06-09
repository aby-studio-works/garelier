# Execution and operations

How Garelier roles execute and how the framework runs: subagents, loading
templates, the autonomous driver, the intake/schedule adapters, compatibility,
and what this skill is not.

## Execution: use subagents where they help (DEC-022)

The subagent-execution guidance now lives in the Librarian system knowledge tree
so every role consults one canonical copy:
`docs/garelier/system/subagent_execution.md`. In short: when your provider
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

## The driver (autonomous mode)

When the user enables autonomous mode in
`__garelier/<pm_id>/_pm/setup_config.toml` (`[autonomy] enabled = true`),
a long-running **driver** invokes each role's configured local provider
CLI on demand:

- `skills/garelier-core/scripts/start_driver.sh` (bash)
- `skills/garelier-core/scripts/start_driver.ps1` (PowerShell)

Model: **per-iteration spawn**. Every poll interval, the driver runs
`claude -p` for `claude-code` roles or `codex exec` for `codex-cli`
roles that need an iteration. Each invocation is a fresh, short-lived
process that runs one iteration and exits.

- **PM** and **Dock** are invoked every poll. They decide for
  themselves whether there's work; if not, they exit immediately.
- **Workers**, **Scouts**, and **Smiths** are invoked only when their `STATE.md`
  reports an active state (e.g., `ASSIGNED`, `WORKING`, `BLOCKED`).

There is no long-lived role session. Context is recovered from
files (STATE.md, runtime/manifest.md, _pm/history.md, control/blueprints/,
etc.) on each cold start. This eliminates any need for session-level
lifecycle tricks (`/compact`, `/clear`).

The driver runs one poll cycle at a time; Worker/Scout/Smith iterations may
run in parallel inside the cycle, but the next poll does not start until
the current cycle finishes. Driver liveness is tracked by
`__garelier/<pm_id>/runtime/driver/driver.pid`.

The driver reads its config from `[autonomy]`, `[runner]`, and the
`[[workers]]` / `[[scouts]]` blocks in
`__garelier/<pm_id>/_pm/setup_config.toml`:

- `enabled` — top-level switch; driver exits if not `true`
- `driver_poll_interval_seconds` — how often the driver invokes role
  iterations (default 30 seconds; tune higher for cost, lower for
  responsiveness)
- `[runner]` provider/model/effort defaults for PM, Dock, and
  agents. Changing provider/model/effort requires driver restart.
- `[lanes] default` (`"dock"` | `"artisan"`, default `dock`) — the lane the
  driver runs when `runtime/lane.lock` is absent. `default = "artisan"` runs the
  single-agent Artisan and gates off Dock/Worker/Scout/Smith/Librarian/merge-gate
  (they stay configured but idle). Read at driver start; restart the driver to
  apply. A per-task `lane.lock` still overrides it. See `garelier-pm` planning.md
  (DEC-056) for the switch procedure.

The user invokes the driver once after enabling autonomous mode. The
setup wizard does not auto-start it; PM does not spawn it itself.
The user closes any existing Garelier terminals, then runs the
driver in a fresh terminal at the project root. Stop via
`__garelier/<pm_id>/runtime/driver/stop` (touch-file) — see garelier-pm
SKILL.md §15.6.

Spawn command defaults by provider: `claude` for `claude-code`, `codex`
for `codex-cli`. Override via `GARELIER_SPAWN_CMD` env var only for
tests/debug wrappers.

## Reference intake and schedule adapters

Garelier includes local, dependency-free reference CLIs for guarded
external triggers:

- `skills/garelier-core/scripts/request_intake_handler.sh`
- `skills/garelier-core/scripts/request_intake_handler.ps1`
- `skills/garelier-core/scripts/scheduler_adapter.sh`
- `skills/garelier-core/scripts/scheduler_adapter.ps1`

These scripts are adapters, not autonomous executors. The webhook
receiver still owns signature checks and git checkout. The external
scheduler still owns the clock. The scripts validate the relevant
`control/` contract, write normalized runtime state, and notify PM
through `__garelier/<pm_id>/runtime/pm/inbox/`.

They must never execute request-provided shell fields or scheduled job
bodies directly. PM remains the decision point, and `promote` remains
user-approved only.

## Compatibility

`garelier-core` v2.x (current: v2.5.0). Role skills must declare a
compatible range in their frontmatter (e.g., `requires: garelier-core ~2.5`).

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
