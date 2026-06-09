#!/usr/bin/env bash
set -euo pipefail

PROJECT="$(pwd)"
FROM_PM_ID="_workshop"
TO_PM_ID=""
BATCH_ID="$(date +%Y%m%d-%H%M%S)"
APPLY=false
SELECTS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --from-pm-id) FROM_PM_ID="${2:?--from-pm-id needs a value}"; shift 2 ;;
    --to-pm-id) TO_PM_ID="${2:?--to-pm-id needs a value}"; shift 2 ;;
    --select) SELECTS+=("${2:?--select needs a value}"); shift 2 ;;
    --batch-id) BATCH_ID="${2:?--batch-id needs a value}"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    -h|--help) echo "usage: split_control.sh --to-pm-id <id> --select <control-relative-path>... [--from-pm-id _workshop] [--project <root>] [--apply]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
valid_pm_id() { [ "$1" = "_workshop" ] || [[ "$1" =~ ^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$ ]]; }
valid_pm_id "$FROM_PM_ID" || { echo "ERROR: invalid source pm_id '$FROM_PM_ID'" >&2; exit 2; }
[ -n "$TO_PM_ID" ] && valid_pm_id "$TO_PM_ID" || { echo "ERROR: valid --to-pm-id is required" >&2; exit 2; }
[ "$FROM_PM_ID" != "$TO_PM_ID" ] || { echo "ERROR: source and destination pm_id must differ" >&2; exit 2; }
[ ${#SELECTS[@]} -gt 0 ] || { echo "ERROR: at least one --select is required" >&2; exit 2; }
SOURCE_ROOT="$PROJECT/__garelier/$FROM_PM_ID/control"
[ -d "$SOURCE_ROOT" ] || { echo "ERROR: source control tree not found: $SOURCE_ROOT" >&2; exit 2; }

FILES=()
for selection in "${SELECTS[@]}"; do
  case "$selection" in /*|*../*|../*|*/..) echo "ERROR: selection must be control-relative and cannot contain '..': $selection" >&2; exit 2 ;; esac
  candidate="$SOURCE_ROOT/$selection"
  if [ -f "$candidate" ]; then
    FILES+=("$candidate")
  elif [ -d "$candidate" ]; then
    while IFS= read -r f; do FILES+=("$f"); done < <(find "$candidate" -type f -print)
  else
    echo "ERROR: selection matched no files: $selection" >&2
    exit 2
  fi
done
mapfile -t FILES < <(printf '%s\n' "${FILES[@]}" | sort -u)

echo "Control split plan: $FROM_PM_ID -> $TO_PM_ID"
echo "Selected files: ${#FILES[@]}"
for f in "${FILES[@]}"; do echo "  ${f#"$SOURCE_ROOT/"}"; done
echo "Source control will remain unchanged. Destination control will not be written directly."
if [ "$APPLY" != "true" ]; then
  echo "Dry run only. Re-run with --apply to create a gitignored staging batch."
  exit 0
fi

DEST_ROOT="$PROJECT/__garelier/$TO_PM_ID/control"
if [ ! -d "$DEST_ROOT" ]; then
  bash "$(dirname "$0")/init_control.sh" --project "$PROJECT" --pm-id "$TO_PM_ID"
fi
BATCH_ROOT="$PROJECT/__garelier/$TO_PM_ID/runtime/import/split/$BATCH_ID"
[ ! -e "$BATCH_ROOT" ] || { echo "ERROR: batch already exists: $BATCH_ROOT" >&2; exit 2; }
mkdir -p "$BATCH_ROOT/source/control" "$BATCH_ROOT/drafts" "$BATCH_ROOT/reports"
for f in "${FILES[@]}"; do
  rel="${f#"$SOURCE_ROOT/"}"
  mkdir -p "$BATCH_ROOT/source/control/$(dirname "$rel")"
  cp "$f" "$BATCH_ROOT/source/control/$rel"
done
{
  echo "# Control Split Staging Report"
  echo
  echo "- Source: \`$FROM_PM_ID\`"
  echo "- Destination: \`$TO_PM_ID\`"
  echo "- Batch: \`$BATCH_ID\`"
  echo "- Selected files: ${#FILES[@]}"
  echo
  echo "## Selected"
  echo
  for f in "${FILES[@]}"; do echo "- \`${f#"$SOURCE_ROOT/"}\`"; done
  echo
  echo "## Required review"
  echo
  echo "- Find references into and out of the selected set."
  echo "- Rebuild destination dashboard summaries; do not copy source hot files wholesale."
  echo "- Resolve decision IDs, ownership, policies, and quality gates."
  echo "- Preserve source until destination validation and approved cutover."
} > "$BATCH_ROOT/reports/plan.md"
echo "Staged split batch: $BATCH_ROOT"
echo "Next: analyze dependencies, normalize drafts, validate, and promote reviewed destination control changes."
