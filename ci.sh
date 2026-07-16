#!/usr/bin/env bash
set -euo pipefail
# Trampoline: resolve the repo root from this file's own location and hand off to
# the TS CI gate. ci is the executor of verification oracles; the .ts owns the
# runner + the shim-form gate (W-083, replacing the former bash -n sweep).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export GARELIER_CI_ROOT="$SCRIPT_DIR"
exec bun "$SCRIPT_DIR/skills/garelier-core/driver/src/scripts/ci.ts" "$@"
