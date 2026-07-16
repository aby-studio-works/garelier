#!/usr/bin/env bash
set -euo pipefail
# Trampoline: resolve the checkout root from this file's own location (== the
# old BASH_SOURCE SCRIPT_DIR) so a symlinked/PATH invocation still finds the
# skills tree, then hand off to the TS installer. The root is passed through for
# git-bash-form path display; the TS body does the symlink work.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export GARELIER_INSTALL_ROOT="$SCRIPT_DIR"
exec bun "$SCRIPT_DIR/skills/garelier-core/driver/src/scripts/install.ts" "$@"
