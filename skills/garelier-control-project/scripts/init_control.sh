#!/usr/bin/env bash
set -euo pipefail

PROJECT="$(pwd)"
PM_ID="_workshop"
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --pm-id) PM_ID="${2:?--pm-id needs a value}"; shift 2 ;;
    -h|--help) echo "usage: init_control.sh [--project <root>] [--pm-id <id>]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ "$PM_ID" != "_workspace" ] || { echo "ERROR: '_workspace' is forbidden; use '_workshop'." >&2; exit 2; }
if [ "$PM_ID" != "_workshop" ] && ! [[ "$PM_ID" =~ ^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$ ]]; then
  echo "ERROR: invalid pm_id '$PM_ID'" >&2; exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_TEMPLATES="$(cd "$SCRIPT_DIR/../../garelier-core/templates/control_scaffold" 2>/dev/null && pwd || true)"
if [ -n "${GARELIER_CORE_TEMPLATES_DIR:-}" ]; then
  TEMPLATES="$GARELIER_CORE_TEMPLATES_DIR/control_scaffold"
elif [ -n "$LOCAL_TEMPLATES" ]; then
  TEMPLATES="$LOCAL_TEMPLATES"
else
  TEMPLATES="$HOME/.claude/skills/garelier-core/templates/control_scaffold"
fi
[ -d "$TEMPLATES" ] || { echo "ERROR: canonical control scaffold not found: $TEMPLATES" >&2; exit 2; }

PM_ROOT="$PROJECT/__garelier/$PM_ID"
CONTROL="$PM_ROOT/control"
IMPORT="$PM_ROOT/runtime/import"
mkdir -p "$CONTROL" "$IMPORT/raw" "$IMPORT/drafts" "$IMPORT/reports"
for rel in blueprints/archive decisions inspections/tech inspections/market \
  inspections/status observations reports/promote reports/benchmark \
  reports/data_audit reports/requests reports/delegated_requests \
  reports/notifications reports/scheduled_jobs reports/handoffs reports/diagnostics \
  delegation request_intake/templates \
  scheduled_jobs/templates scheduled_jobs/examples; do
  mkdir -p "$CONTROL/$rel"
  touch "$CONTROL/$rel/.gitkeep"
done

while IFS= read -r -d '' src; do
  rel="${src#"$TEMPLATES/"}"
  dest="$CONTROL/$rel"
  if [ ! -e "$dest" ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
  fi
done < <(find "$TEMPLATES" -type f -print0)

if [ ! -f "$CONTROL/control.toml" ]; then
  printf 'schema_version = 1\nkind = "garelier_control"\npm_id = "%s"\nmode = "control_only"\n' "$PM_ID" > "$CONTROL/control.toml"
fi

# DEC-051: ignore rules live in a nested __garelier/.gitignore (git honors nested
# ignore files), so the project's ROOT .gitignore is never touched. Control-only
# namespaces just need runtime/ ignored; a later full-PM upgrade (setup wizard)
# overwrites this with the complete worktree set. Never clobber an existing
# (possibly fuller) nested file.
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

echo "Initialized control namespace '$PM_ID' at $CONTROL"
echo "Existing files were preserved; runtime/import is gitignored staging."
