#!/usr/bin/env bash
set -euo pipefail
PROJECT="$(pwd)"
PM_ID="_workshop"
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --pm-id) PM_ID="${2:?--pm-id needs a value}"; shift 2 ;;
    -h|--help) echo "usage: init_library.sh [--project <root>] [--pm-id <id>]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$PM_ID" != "_workspace" ] || { echo "ERROR: use '_workshop', not '_workspace'." >&2; exit 2; }
if [ "$PM_ID" != "_workshop" ] && ! [[ "$PM_ID" =~ ^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$ ]]; then
  echo "ERROR: invalid pm_id '$PM_ID'" >&2; exit 2
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL="$(cd "$SCRIPT_DIR/../../garelier-librarian/templates" 2>/dev/null && pwd || true)"
TEMPLATES="${GARELIER_LIBRARIAN_TEMPLATES_DIR:-${LOCAL:-$HOME/.claude/skills/garelier-librarian/templates}}"
[ -d "$TEMPLATES" ] || { echo "ERROR: Librarian templates not found: $TEMPLATES" >&2; exit 2; }
STARTER_TEMPLATES="$SCRIPT_DIR/../templates"

# DEC-077: knowledge is seeded into THIS pm's layer (the home). The SHARED
# __atmos tier is NOT created here — it is created on demand only when the user
# decides to share knowledge project-wide. Local staging stays under runtime/.
KNOWLEDGE="$PROJECT/__garelier/$PM_ID/knowledge"
CATEGORY="$KNOWLEDGE/project"
RUNTIME="$PROJECT/__garelier/$PM_ID/runtime/librarian"
mkdir -p "$KNOWLEDGE" "$CATEGORY" "$RUNTIME/raw" "$RUNTIME/cache" "$RUNTIME/drafts" "$RUNTIME/reports"
[ -e "$KNOWLEDGE/knowledge.toml" ] || cp "$TEMPLATES/knowledge.toml" "$KNOWLEDGE/knowledge.toml"
for name in role_index.toml source_registry.toml routine_registry.toml; do
  [ -e "$KNOWLEDGE/$name" ] || cp "$STARTER_TEMPLATES/$name" "$KNOWLEDGE/$name"
done
if [ ! -e "$CATEGORY/index.md" ]; then
  sed \
    -e 's|{{Category}}|Project|g' \
    -e 's|{{category}}|project|g' \
    -e 's|{{knowledge/policy owner}}|user / project owner|g' \
    -e 's|{{condition}}|project-specific knowledge is needed|g' \
    -e 's|{{on change / scheduled review}}|on change|g' \
    "$TEMPLATES/knowledge_index.md" > "$CATEGORY/index.md"
fi
# DEC-051: ignore rules live in a nested __garelier/.gitignore (git honors nested
# ignore files), so the project's ROOT .gitignore is never touched. Never clobber
# an existing (possibly fuller, full-PM) nested file.
NESTED_GITIGNORE="$PROJECT/__garelier/.gitignore"
if [ ! -f "$NESTED_GITIGNORE" ]; then
  CORE_TMPL_DIR="$(cd "$SCRIPT_DIR/../../garelier-core/templates" 2>/dev/null && pwd || true)"
  if [ -n "$CORE_TMPL_DIR" ] && [ -f "$CORE_TMPL_DIR/runtime_gitignore" ]; then
    cp "$CORE_TMPL_DIR/runtime_gitignore" "$NESTED_GITIGNORE"
  else
    printf '# Garelier nested .gitignore (control-only)\n*/runtime/\n' > "$NESTED_GITIGNORE"
  fi
fi
# Best-effort: migrate away the legacy 2-line block a pre-DEC-051 init left in root.
LEGACY_GITIGNORE="$PROJECT/.gitignore"
if [ -f "$LEGACY_GITIGNORE" ] && grep -q "Garelier transient state" "$LEGACY_GITIGNORE" 2>/dev/null; then
  grep -vE '^# Garelier transient state$|^__garelier/\*/runtime/[[:space:]]*$' \
    "$LEGACY_GITIGNORE" > "$LEGACY_GITIGNORE.tmp" && mv "$LEGACY_GITIGNORE.tmp" "$LEGACY_GITIGNORE"
  grep -q '[^[:space:]]' "$LEGACY_GITIGNORE" 2>/dev/null || rm -f "$LEGACY_GITIGNORE"
fi
echo "Initialized Garelier library at $KNOWLEDGE"
echo "Local staging: $RUNTIME"
echo "(Shared __atmos tier is created on demand when you share knowledge project-wide.)"
