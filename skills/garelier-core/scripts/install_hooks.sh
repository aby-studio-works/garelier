#!/usr/bin/env bash
# OPT-IN local git hooks for Garelier (DEC-051 commit-message lint).
#
# Installs a commit-msg hook into THIS clone's .git/hooks only. It does NOT set
# core.hooksPath and commits nothing, so it never affects other contributors,
# non-Garelier users, or other-skill users. It is per-developer and reversible:
#   rm .git/hooks/commit-msg
# The installed hook also self-disables when bun is unavailable, so it can never
# block a plain `git commit` in a non-Garelier environment.
set -euo pipefail

ROOT="${1:-$(git rev-parse --show-toplevel)}"
HOOKS="$ROOT/.git/hooks"
SKILL="${GARELIER_CORE_DIR:-$HOME/.claude/skills/garelier-core}"
mkdir -p "$HOOKS"

if [ -e "$HOOKS/commit-msg" ] && ! grep -q "Garelier commit-msg lint" "$HOOKS/commit-msg" 2>/dev/null; then
  echo "Refusing to overwrite an existing non-Garelier commit-msg hook at $HOOKS/commit-msg." >&2
  exit 1
fi

cat > "$HOOKS/commit-msg" <<EOF
#!/usr/bin/env bash
# Garelier commit-msg lint (opt-in, DEC-051). Remove this file to disable.
command -v bun >/dev/null 2>&1 || exit 0   # no bun -> skip (never block a non-Garelier env)
exec bun "$SKILL/scripts/lint_commits.ts" "\$1"
EOF
chmod +x "$HOOKS/commit-msg"
echo "Installed opt-in commit-msg hook -> $HOOKS/commit-msg"
echo "  (per-developer, local only; remove the file to disable; never affects others)"
