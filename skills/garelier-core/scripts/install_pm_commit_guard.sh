#!/usr/bin/env bash
# Install the Garelier MAIN-worktree git-hook bundle (DEC-075 + DEC-088) into a
# TARGET project's main worktree hooks dir. Three hooks, each mechanical and
# reversible:
#   pre-commit  — misplace guard (no commit on a non-studio branch in the main
#                 worktree; a producer worktree never commits on studio) + race
#                 guard (no commit during an in-flight merge gate).  [DEC-075]
#   pre-rebase  — refuse rebasing studio / garelier/* (rebase strands detached-
#                 HEAD role worktrees; base tracking is always MERGE).  [DEC-088 #3]
#   pre-push    — never push garelier/*; no force push; opt-in target-push promote
#                 guard ([setup] promote_guard).  [DEC-030 + DEC-088 #5]
#
# Per-clone, commits nothing, reversible (rm the hook). A pre-existing
# non-Garelier hook is PRESERVED as <hook>.local and chained first. Idempotent.
#
# Run this in a TARGET project whose main worktree is on a */studio integration
# branch — the pre-commit misplace guard assumes that. Do NOT run it in the
# Garelier framework repo or a non-Garelier clone (HEAD != */studio would block
# every commit). Git hooks are OPT-IN by design and NEVER auto-installed at setup:
# they write to .git/hooks / core.hooksPath, which live outside __garelier/, so
# keeping them opt-in + per-clone + reversible (rm the hook) preserves Garelier's
# clean removability — deleting __garelier/ must leave no residue.
#
# Usage: install_pm_commit_guard.sh [<project-root>]    (default: git toplevel)
set -eu

ROOT="${1:-$(git rev-parse --show-toplevel)}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve the active hooks dir for the MAIN worktree (honor core.hooksPath).
HP="$(git -C "$ROOT" config --get core.hooksPath 2>/dev/null || true)"
if [ -n "$HP" ]; then
  case "$HP" in /*) HOOKS="$HP" ;; *) HOOKS="$ROOT/$HP" ;; esac
  echo "install_pm_commit_guard: NOTE core.hooksPath is set ($HP); installing the bundle there." >&2
else
  HOOKS="$(git -C "$ROOT" rev-parse --git-common-dir)/hooks"
fi
mkdir -p "$HOOKS"

# Install one hook, preserving a pre-existing non-Garelier hook as <hook>.local.
install_one() {
  local name="$1" mark="$2"
  local src="$SCRIPT_DIR/hooks/$name" dest="$HOOKS/$name"
  [ -f "$src" ] || { echo "install_pm_commit_guard: source hook missing at $src" >&2; return 1; }
  if [ -f "$dest" ] && ! grep -q "$mark" "$dest" 2>/dev/null; then
    if [ -e "$HOOKS/$name.local" ]; then
      echo "install_pm_commit_guard: $HOOKS/$name.local already exists; refusing to clobber it. Resolve manually." >&2
      return 1
    fi
    mv "$dest" "$HOOKS/$name.local"
    chmod +x "$HOOKS/$name.local" 2>/dev/null || true
    echo "  + preserved the existing $name hook as $name.local (the guard chains it first)"
  fi
  cp "$src" "$dest"
  chmod +x "$dest" 2>/dev/null || true
  echo "Installed Garelier $name guard -> $dest"
}

install_one pre-commit "Garelier PM commit guard"
install_one pre-rebase "Garelier pre-rebase guard"
install_one pre-push   "Garelier mechanical push guard"

echo "  per-clone, local only; main-worktree commit/rebase/push guards (DEC-075 + DEC-088)."
echo "  overrides: GARELIER_ALLOW_NONSTUDIO_COMMIT=1 | GARELIER_ALLOW_REBASE=1 | GARELIER_ALLOW_TARGET_PUSH=1"
echo "  disable a guard: rm \"$HOOKS/<hook>\""
