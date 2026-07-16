#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export GARELIER_SCRIPT_SHIM_DIR="$SCRIPT_DIR"
# W-076: the driver records THIS bash process's Windows pid as the merge
# active.lock owner; capture it before `exec` (on Windows Git-Bash the exec'd bun
# runs under a different Windows pid) so merge-gate.ts adopts the driver-written
# lock instead of misreading it as a second runner. Falls back to $$ off Windows.
export GARELIER_MERGE_GATE_OWNER_PID="$(cat "/proc/$$/winpid" 2>/dev/null || echo $$)"
TS="$SCRIPT_DIR/../driver/src/scripts/merge-gate.ts"
if [ ! -f "$TS" ]; then
  for _core in "${GARELIER_CORE_DIR:-}" "${HOME:-}/.claude/skills/garelier-core"; do
    [ -n "$_core" ] && [ -f "$_core/driver/src/scripts/merge-gate.ts" ] && { TS="$_core/driver/src/scripts/merge-gate.ts"; break; }
  done
fi
exec bun "$TS" "$@"
