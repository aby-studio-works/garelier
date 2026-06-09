#!/usr/bin/env bash
# Install the Garelier mechanical push guard (DEC-030) into a Concierge
# worktree. Scopes the pre-push hook to THIS worktree only (via per-worktree
# config) so it never interferes with the user's own pushes elsewhere.
#
# Usage: install_concierge_guards.sh <concierge-checkout-dir>
#
# Idempotent: safe to re-run at every Concierge pickup. The Concierge SKILL runs
# this as a pre-flight step; doctor verifies it is present (P0 if absent).

set -eu

CHECKOUT="${1:?usage: install_concierge_guards.sh <concierge-checkout-dir>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$SCRIPT_DIR/hooks"

if [ ! -e "$CHECKOUT/.git" ]; then
  echo "install_concierge_guards: not a git worktree: $CHECKOUT" >&2
  exit 1
fi
if [ ! -f "$HOOKS_DIR/pre-push" ]; then
  echo "install_concierge_guards: pre-push hook missing at $HOOKS_DIR" >&2
  exit 1
fi

chmod +x "$HOOKS_DIR/pre-push" 2>/dev/null || true

# Per-worktree config so only the Concierge worktree gets this hooks path.
git -C "$CHECKOUT" config extensions.worktreeConfig true
git -C "$CHECKOUT" config --worktree core.hooksPath "$HOOKS_DIR"

echo "  + Concierge push guard installed (DEC-030): $CHECKOUT core.hooksPath -> $HOOKS_DIR"
