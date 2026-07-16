#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Resolve the repo root from this shim's own location (== the old script's
# `dirname "$0"/..`) and hand it to the TS gate so a relocated/copied shim
# scans the tree it lives in, not the driver file's home.
export GARELIER_EXPORT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
exec bun "$SCRIPT_DIR/../skills/garelier-core/driver/src/scripts/make-public-export.ts" "$@"
