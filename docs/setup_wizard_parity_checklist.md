# Setup Wizard Runtime Checklist

> Purpose: keep setup wizard behavior stable after retiring native Windows
> script parity. Windows operation is through Git Bash.

## Current Contract

- Canonical entrypoint: `skills/garelier-pm/scripts/setup_wizard.sh`.
- Windows users run it from Git Bash.
- New helper logic should move toward TypeScript modules where practical.
- Shell remains acceptable for bootstrap wiring and Git Bash entrypoints.

## Required Checks

- `bash -n skills/garelier-pm/scripts/setup_wizard.sh`
- `bash ci.sh`
- A fresh setup smoke in a throwaway git repo.
- A diff-mode role add/remove smoke.
- A migrate-mode smoke when migration behavior changes.

When setup behavior changes, update this checklist, `CLAUDE.md`, and
`docs/getting_started.md` in the same change.
