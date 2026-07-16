#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export GARELIER_SCRIPT_SHIM_DIR="$SCRIPT_DIR"
# The sibling scripts (merge_request.sh / gate_result_waiter.sh /
# dispatch_cleanup.sh / merge_request_id_recover.sh / lint_commits.ts) and
# dock_merge.ts are resolved by merge_land.ts relative to GARELIER_SCRIPT_SHIM_DIR
# above, so a relocated shim (e.g. merge_land.test.sh's W-055 stub harness) drives
# the stand-ins next to it. The TS itself is loaded adjacent, else from
# GARELIER_CORE_DIR / the installed garelier-core (relocated-shim fallback).
TS="$SCRIPT_DIR/../driver/src/scripts/merge_land.ts"
if [ ! -f "$TS" ]; then
  for _core in "${GARELIER_CORE_DIR:-}" "${HOME:-}/.claude/skills/garelier-core"; do
    [ -n "$_core" ] && [ -f "$_core/driver/src/scripts/merge_land.ts" ] && { TS="$_core/driver/src/scripts/merge_land.ts"; break; }
  done
fi
exec bun "$TS" "$@"
