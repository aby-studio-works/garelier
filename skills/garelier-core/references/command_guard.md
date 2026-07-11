# command_guard — the safety enforcement point (operator reference)

The command_guard is a Claude Code **PreToolUse hook** that evaluates a shell
command *before it runs* and returns allow / ask / deny. It mechanically enforces
the written safety references (`deletion_and_forcewrite_safety.md`,
`injection_and_egress.md`, `package_policy.md`). Implementation:
`driver/src/guard/command_guard.ts`; tunable policy:
`control/operations/command_guard_policy.toml`.

## What it decides (rule classes)

| Class | Trigger | Default |
| --- | --- | --- |
| pipe_to_shell | `curl`/`wget`/`iwr … \| sh/bash/pwsh` | deny |
| network_egress | `curl`/`wget`/`Invoke-*` upload/POST/PUT/PATCH (`-d`/`-F`/`-T`) | deny (Concierge exempt) |
| network_offlist | plain GET to a host not in `network_allow_domains` | deny (Concierge exempt) |
| git_egress | `git push` / `git fetch` / `git pull` / `git remote add\|set-url` (reaches a remote) | deny (Concierge exempt) |
| install_run | `uvx` / `pipx run` / `npx <remote>` / `pnpm dlx` | deny |
| codex_raw_exec | raw `codex exec` (not via `dispatch_codex_producer.sh`): workspace-write/unspecified sandbox | ask (danger-full-access: deny; read-only probe: allow) |
| recursive_delete | `rm -rf` / `Remove-Item -Recurse` outside `$GARELIER_CONTAINER` | deny |
| indirect_delete | a delete/`reset`/`clean` command whose flags/targets are hidden behind shell indirection (`$VAR` / `$(…)` / backtick), e.g. `F=-rf; rm $F` | ask (heuristic; not a full shell parse) |
| force_write | `git push --force` / `reset --hard` / `clean -f` / `branch -f` / `--amend` / `restore` / `checkout -- <path>` | ask |
| secret_file | delete/overwrite `*.db` / `*.sqlite` / `*.env` / `credentials*` | ask in-container, deny outside |

A deny/ask reason always tells the agent to escalate to the PM, so a blocked
command is never a dead end. On its own internal error the guard **fails to
`ask`** (never fail-open).

## Where the hook must live — two applicability paths

Claude Code applies hooks from the settings of the **session that owns the tool
call**. A Garelier role reaches the tool call by one of two launch shapes, and
the hook has to be registered in the right place for each:

| Launch shape | Whose settings apply | Where the guard hook lives | Wired by |
| --- | --- | --- | --- |
| **Independent session** (driver mode / a role started with cwd = its `checkout/`) | the checkout's `.claude/settings.local.json` | each role checkout | wizard `write_role_settings` (per checkout) |
| **Attended subagent** (a PM session spawns it with the Agent tool — *not* a separate session) | the **parent PM session's** settings: the target **project-root** `.claude/settings.local.json` / `.claude/settings.json`, or user `~/.claude/settings.json` | target project root | wizard project-root install (`install_hook.ts`, merge) |

Both are wired at setup. If only the checkout hook existed, attended parallel
work (a PM spawning several subagents) would run **unguarded** — which is exactly
the case this second path closes.

## How the wizard installs it

- **Per checkout:** `write_role_settings` writes the hook (plus `claudeMdExcludes`)
  into each role checkout's `.claude/settings.local.json`.
- **Project root:** the wizard merges the hook into
  `<project>/.claude/settings.local.json` with `install_hook.ts` — a
  key-preserving, idempotent merge that never clobbers a user's existing
  settings. `settings.local.json` (local, gitignored by convention) is used, not
  the tracked `settings.json`, so Garelier's project-root footprint stays
  local-only (DEC-051 keeps the repo Garelier-free for non-users).

### Opt-in: propagate via tracked settings + a project-owned shim

If you want every worktree/clone to inherit the guard without re-running the
wizard, you can TRACK it — but **never register a Garelier-internal path in a
tracked `settings.json`**: a contributor who has not installed Garelier would
then get an error on *every* tool call. Instead use the shipped **shim**
(`templates/command_guard_shim.sh`), which is project-owned and degrades to a
no-op:

1. copy `command_guard_shim.sh` into the repo, e.g.
   `.claude/hooks/garelier_command_guard_shim.sh`, and commit it;
2. register the **shim** (a repo-relative path) in the tracked
   `.claude/settings.json`:
   `{"type":"command","command":"sh \".claude/hooks/garelier_command_guard_shim.sh\""}`.

The shim exits 0 (allow, harmless) when `bun` or the guard is not present, so a
non-Garelier developer is unaffected; when Garelier is installed it delegates to
`command_guard.ts`. This mirrors the framework's **non-mandatory-layer** rule
(as with the commit convention): Garelier work merged onto a shared branch must
never impose Garelier on people who do not use it.

## General wiring principles (apply to every hook/setting the wizard writes)

These hold for the command_guard hook and for any future wiring the wizard adds
(`claudeMdExcludes`, SessionStart digests, …):

- **Non-mandatory layer.** The default is the per-developer, **untracked**
  `settings.local.json` — opt-in per person, zero footprint in the tracked repo
  (DEC-051). Tracking is opt-in and, when done, goes through a graceful shim so
  non-users are a no-op, never an error.
- **Self-identifying + reversible.** Wizard-written wiring is identifiable
  (the command references `command_guard`) so it can be removed precisely without
  disturbing a user's own keys or other tools' hooks. **Easy in, easy out.**

## Teardown — removing the wiring

`setup_wizard.sh --mode teardown` (run from `__garelier/<pm_id>/_pm/`) reverses
the wiring:

- **(a)** strips *only* the command_guard hook from the project-root and each
  role checkout's `settings.local.json` — a merge-aware removal that leaves every
  other key and any other tool's hooks intact, and deletes a settings file only
  if it becomes empty (via `install_hook.ts --uninstall`);
- **(b)** **inventories** the remaining worktrees / containers and hands them to
  the `deletion_and_forcewrite_safety.md` two-stage rule (inventory → approval →
  remove) — teardown never deletes a worktree or any data on its own;
- then prints the `doctor` command to verify no wiring residue remains.

`doctor` reports **`command-guard-residue`** (P1) if a hook is still registered
but the guard binary is gone (a move or a partial teardown), and
**`command-guard-hook`** (P2) when no hook is registered at all.

## Diagnosing where the hook is

- Check a checkout: look for `command_guard` in
  `<checkout>/.claude/settings.local.json`.
- Check the attended path: look for it in `<project>/.claude/settings.local.json`
  (and `.claude/settings.json`, `~/.claude/settings.json`).
- `doctor` reports `command-guard-hook` (P2) when no hook is registered and
  `command-guard-residue` (P1) when a hook is registered but the guard is gone
  (see Teardown below).

## See also

- `deletion_and_forcewrite_safety.md`, `injection_and_egress.md`,
  `package_policy.md` — the prose this hook enforces.
- `command_guard_policy.toml` (control/operations/) — per-class action overrides
  and the network allow-list.
