#!/usr/bin/env sh
# garelier command_guard shim — PROJECT-OWNED, safe to commit.
#
# Purpose: let a repo TRACK the command_guard PreToolUse hook (so every clone /
# worktree inherits it) WITHOUT breaking contributors who do not use Garelier.
# A tracked hook that points straight at a Garelier-internal path would error on
# every tool call for someone who has not installed Garelier. This shim instead:
#   - exits 0 (allow, harmless no-op) if bun or the guard is not present, so a
#     non-Garelier developer is completely unaffected;
#   - otherwise delegates to the real guard (stdin/stdout pass straight through).
# The checks are two cheap lookups, fine to run on every tool call.
#
# Install (opt-in, tracked): copy this file into the repo (e.g.
# `.claude/hooks/garelier_command_guard_shim.sh`), commit it, and register it in
# the TRACKED `.claude/settings.json`:
#   { "hooks": { "PreToolUse": [ { "matcher": "Bash|PowerShell|Shell",
#       "hooks": [ { "type": "command",
#                    "command": "sh \".claude/hooks/garelier_command_guard_shim.sh\"" } ] } ] } }
# The default wizard wiring stays in the per-developer, untracked
# settings.local.json; tracking is this opt-in. See references/command_guard.md.

# Where the guard lives. Override with GARELIER_COMMAND_GUARD if installed
# elsewhere; otherwise the standard skills location.
guard="${GARELIER_COMMAND_GUARD:-$HOME/.claude/skills/garelier-core/driver/src/guard/command_guard.ts}"

# No bun, or no guard on disk -> Garelier is not installed here -> allow (no-op).
command -v bun >/dev/null 2>&1 || exit 0
[ -f "$guard" ] || exit 0

# Delegate. exec replaces this process so the guard's stdout/exit are the hook's.
exec bun "$guard"
