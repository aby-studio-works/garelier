#!/usr/bin/env bash
set -euo pipefail
# Latency-critical PostToolUse hook: it fires on EVERY Bash tool call, so the
# common non-matching case must exit WITHOUT paying bun startup (~200ms). This
# pure-bash fast-reject is the sanctioned exception to the dumb-shim contract
# (W-083 PM decision / blueprint §exception-3) — same class as the bin/garelier
# trampoline where "being sh is the feature". It MUST stay in lockstep with the
# identical guard in task_mirror_hook.ts main() — the
# input.includes("merge_land.sh" | "dispatch_prepare.sh" | "dispatch_cleanup.sh")
# check; the .ts re-checks the same three tokens, so this is a pre-filter, not the
# sole gate. On a match the buffered stdin is re-fed to the TS hook verbatim.
INPUT="$(cat)"
case "$INPUT" in
  *merge_land.sh*|*dispatch_prepare.sh*|*dispatch_cleanup.sh*) ;;
  *) exit 0 ;;
esac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bun "$SCRIPT_DIR/task_mirror_hook.ts" "$@" <<<"$INPUT"
