#!/usr/bin/env bash
# Install the Garelier PM commit guard (DEC-075 follow-up) into a project's MAIN
# worktree .git/hooks/pre-commit. Mechanically blocks the two recurring PM-commit
# incidents (misplace onto a non-studio branch; commit during an in-flight merge)
# that the manual checklist kept missing. Per-clone, commits nothing, reversible
# (rm the hook). A pre-existing non-Garelier pre-commit (e.g. check_assets) is
# PRESERVED as pre-commit.local and chained first. Idempotent (re-run safe).
#
# Usage: install_pm_commit_guard.sh [<project-root>]    (default: git toplevel)
set -eu

ROOT="${1:-$(git rev-parse --show-toplevel)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/hooks/pre-commit"
[ -f "$SRC" ] || { echo "install_pm_commit_guard: source hook missing at $SRC" >&2; exit 1; }

# Resolve the active hooks dir for the MAIN worktree (honor core.hooksPath).
HP="$(git -C "$ROOT" config --get core.hooksPath 2>/dev/null || true)"
if [ -n "$HP" ]; then
  case "$HP" in /*) HOOKS="$HP" ;; *) HOOKS="$ROOT/$HP" ;; esac
  echo "install_pm_commit_guard: NOTE core.hooksPath is set ($HP); installing the guard there." >&2
else
  HOOKS="$(git -C "$ROOT" rev-parse --git-common-dir)/hooks"
fi
mkdir -p "$HOOKS"
DEST="$HOOKS/pre-commit"
MARK="Garelier PM commit guard"

if [ -f "$DEST" ] && ! grep -q "$MARK" "$DEST" 2>/dev/null; then
  if [ -e "$HOOKS/pre-commit.local" ]; then
    echo "install_pm_commit_guard: $HOOKS/pre-commit.local already exists; refusing to clobber it. Resolve manually." >&2
    exit 1
  fi
  mv "$DEST" "$HOOKS/pre-commit.local"
  chmod +x "$HOOKS/pre-commit.local" 2>/dev/null || true
  echo "  + preserved the existing pre-commit hook as pre-commit.local (the guard chains it first)"
fi

cp "$SRC" "$DEST"
chmod +x "$DEST" 2>/dev/null || true
echo "Installed Garelier PM commit guard -> $DEST"
echo "  per-clone, local only; blocks non-studio / mid-merge commits on the MAIN worktree."
echo "  override once: GARELIER_ALLOW_NONSTUDIO_COMMIT=1 git commit ...   disable: rm \"$DEST\""
