# Setup Wizard Runtime Checklist

> Purpose: keep setup wizard behavior stable after retiring native Windows
> script parity. Windows operation is through Git Bash.

## Current Contract

- Canonical entrypoint: `skills/garelier-pm/scripts/setup_wizard.sh`.
- Windows users run it from Git Bash.
- New helper logic should move toward TypeScript modules where practical.
- Shell remains acceptable for bootstrap wiring and Git Bash entrypoints.

## Project-root hooks the wizard wires

Fresh and diff modes merge two framework-owned hooks into the TARGET PROJECT
ROOT's `.claude/settings.local.json` (merge-aware, idempotent, user keys and any
other hooks preserved; teardown removes both):

- **`PreToolUse` command_guard** — the safety guard for land/dispatch/git ops
  (`src/guard/install_hook.ts`).
- **`PostToolUse` task_mirror** (W-030) — after a `merge_land` / `dispatch_prepare`
  / `dispatch_cleanup` command, refresh the Task-list mirror and inject only the
  delta into the PM session (zero tokens when unchanged). Wired by
  `register_task_mirror_hook` via `src/dispatch/install_task_mirror_hook.ts`; the
  hook (`skills/garelier-core/hooks/task_mirror_hook.sh`) is self-configuring
  (reads pm_id/project from the intercepted command), so the registered command
  takes no arguments and one entry serves every project.

## Required Checks

- `bash -n skills/garelier-pm/scripts/setup_wizard.sh`
- `bash ci.sh`
- A fresh setup smoke in a throwaway git repo.
- A diff-mode role add/remove smoke.
- A migrate-mode smoke when migration behavior changes.
- When changing hook wiring: confirm both hooks land at the project-root
  `settings.local.json`, coexist, stay single on a re-run (idempotent), and are
  removed by `--mode teardown`.

When setup behavior changes, update this checklist, `CLAUDE.md`, and
`docs/getting_started.md` in the same change.
