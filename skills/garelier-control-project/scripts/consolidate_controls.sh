#!/usr/bin/env bash
set -euo pipefail

PROJECT="$(pwd)"
FROM_PM_IDS=""
TO_PM_ID="_workshop"
BATCH_ID="$(date +%Y%m%d-%H%M%S)"
APPLY=false
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --from-pm-id) FROM_PM_IDS="${2:?--from-pm-id needs a value}"; shift 2 ;;
    --to-pm-id) TO_PM_ID="${2:?--to-pm-id needs a value}"; shift 2 ;;
    --batch-id) BATCH_ID="${2:?--batch-id needs a value}"; shift 2 ;;
    --apply) APPLY=true; shift ;;
    -h|--help) echo "usage: consolidate_controls.sh --from-pm-id <a,b> [--to-pm-id _workshop] [--project <root>] [--batch-id <id>] [--apply]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$FROM_PM_IDS" ] || { echo "ERROR: --from-pm-id is required" >&2; exit 2; }
valid_pm_id() { [ "$1" = "_workshop" ] || [[ "$1" =~ ^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$ ]]; }
valid_pm_id "$TO_PM_ID" || { echo "ERROR: invalid pm_id '$TO_PM_ID'" >&2; exit 2; }

IFS=',' read -ra SOURCES <<< "$FROM_PM_IDS"
declare -A OWNERS
declare -A HASHES
declare -A CONFLICTS
DEST_ROOT="$PROJECT/__garelier/$TO_PM_ID/control"
if [ -d "$DEST_ROOT" ]; then
  while IFS= read -r -d '' f; do
    rel="${f#"$DEST_ROOT/"}"
    OWNERS["$rel"]="destination:$TO_PM_ID"
    HASHES["$rel"]="$(git hash-object "$f")"
  done < <(find "$DEST_ROOT" -type f -print0)
fi
for raw in "${SOURCES[@]}"; do
  id="$(echo "$raw" | xargs)"
  valid_pm_id "$id" || { echo "ERROR: invalid pm_id '$id'" >&2; exit 2; }
  root="$PROJECT/__garelier/$id/control"
  [ -d "$root" ] || { echo "ERROR: source control tree not found: $root" >&2; exit 2; }
  while IFS= read -r -d '' f; do
    rel="${f#"$root/"}"
    hash="$(git hash-object "$f")"
    if [ -n "${OWNERS[$rel]:-}" ]; then
      OWNERS["$rel"]="${OWNERS[$rel]}, source:$id"
      [ "${HASHES[$rel]}" = "$hash" ] || CONFLICTS["$rel"]=true
    else
      OWNERS["$rel"]="source:$id"
      HASHES["$rel"]="$hash"
    fi
  done < <(find "$root" -type f -print0)
done

OVERLAPS=0
echo "Control consolidation plan: $FROM_PM_IDS -> $TO_PM_ID"
echo "Destination exists: $([ -d "$DEST_ROOT" ] && echo true || echo false)"
for rel in "${!OWNERS[@]}"; do
  case "${OWNERS[$rel]}" in
    *,*) OVERLAPS=$((OVERLAPS + 1)) ;;
  esac
done
for rel in "${!CONFLICTS[@]}"; do echo "  CONFLICT $rel: ${OWNERS[$rel]}"; done
IDENTICAL=$((OVERLAPS - ${#CONFLICTS[@]}))
echo "Distinct paths: ${#OWNERS[@]}; identical overlaps: $IDENTICAL; conflicts requiring reconciliation: ${#CONFLICTS[@]}"
if [ "$APPLY" != "true" ]; then
  echo "Dry run only. Re-run with --apply to create a gitignored staging batch; source controls remain unchanged."
  exit 0
fi

if [ ! -d "$DEST_ROOT" ]; then
  bash "$(dirname "$0")/init_control.sh" --project "$PROJECT" --pm-id "$TO_PM_ID"
fi
BATCH_ROOT="$PROJECT/__garelier/$TO_PM_ID/runtime/import/consolidation/$BATCH_ID"
[ ! -e "$BATCH_ROOT" ] || { echo "ERROR: batch already exists: $BATCH_ROOT" >&2; exit 2; }
mkdir -p "$BATCH_ROOT/sources" "$BATCH_ROOT/drafts" "$BATCH_ROOT/reports"
for raw in "${SOURCES[@]}"; do
  id="$(echo "$raw" | xargs)"
  mkdir -p "$BATCH_ROOT/sources/$id/control"
  cp -R "$PROJECT/__garelier/$id/control/." "$BATCH_ROOT/sources/$id/control/"
done
{
  echo "# Control Consolidation Staging Report"
  echo
  echo "- Destination: \`$TO_PM_ID\`"
  echo "- Sources: $FROM_PM_IDS"
  echo "- Batch: \`$BATCH_ID\`"
  echo "- Distinct paths: ${#OWNERS[@]}"
  echo "- Identical overlaps ignored: $IDENTICAL"
  echo "- Conflicts requiring semantic reconciliation: ${#CONFLICTS[@]}"
  echo
  echo "## Conflicts"
  echo
  [ ${#CONFLICTS[@]} -gt 0 ] || echo "- None"
  for rel in "${!CONFLICTS[@]}"; do echo "- \`$rel\`: ${OWNERS[$rel]}"; done
  echo
  echo "## Rules"
  echo
  echo "- Source namespaces are snapshots only and remain unchanged."
  echo "- Destination control is the base authority."
  echo "- Normalize into drafts; do not overwrite destination files."
  echo "- Resolve policy/decision conflicts with the owner."
} > "$BATCH_ROOT/reports/plan.md"
echo "Staged consolidation batch: $BATCH_ROOT"
echo "Next: normalize into drafts, reconcile conflicts, validate, then promote reviewed control changes."
