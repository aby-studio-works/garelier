#!/usr/bin/env bash
set -euo pipefail
# The only officially sanctioned .sh in Garelier: PostToolUse latency
# pre-filter, approved by the user on 2026-07-17 (W-111).
# Latency-critical PostToolUse hook: it fires on EVERY Bash tool call, so the
# common non-matching case must exit WITHOUT paying bun startup (~200ms). This
# pure-bash fast-reject is the single sanctioned shell exception. It MUST stay
# in lockstep with the
# identical guard in task_mirror_hook.ts main() — the
# input.includes("merge_land.ts" | "dispatch_prepare.ts" | "dispatch_cleanup.ts"
# | "dock_integrate.ts") check; the .ts re-checks the same four tokens, so this is a pre-filter, not the
# sole gate. On a match the buffered stdin is re-fed to the TS hook verbatim.
INPUT="$(cat)"
case "$INPUT" in
  *merge_land.ts*|*dispatch_prepare.ts*|*dispatch_cleanup.ts*|*dock_integrate.ts*) ;;
  *) exit 0 ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/task_mirror_hook.ts" "$@" <<<"$INPUT"
