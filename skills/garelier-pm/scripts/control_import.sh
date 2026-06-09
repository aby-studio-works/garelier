#!/usr/bin/env bash
#
# Garelier PM control import (DEC-048 §B) — bash.
#
# Import a control bundle (produced by control_export) INTO a PM's control/ tree
# — for restoring a backup or seeding a new PM from a template project.
#
# Safety: NO-OVERWRITE. Existing files are never clobbered; every collision is
# reported for the PM to reconcile by hand (mirrors request_intake's
# no-silent-overwrite discipline). Importing from ANOTHER PM across machines is
# request_intake/'s job (DEC-006), not this script.
#
# Usage:
#   control_import.sh --from <bundle-dir> [--pm-id <id>] [--project <root>] [--apply]
#
# --from is MANDATORY: the input source must be specified explicitly.
# Without --apply the script does a DRY RUN (reports what would be written /
# what collides) and writes nothing.
set -euo pipefail

PM_ID=""
PROJECT="$(pwd)"
SRC=""
APPLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --pm-id)   PM_ID="${2:?--pm-id needs a value}"; shift 2 ;;
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --from)    SRC="${2:?--from needs a value}"; shift 2 ;;
    --apply)   APPLY=1; shift ;;
    -h|--help) echo "usage: control_import.sh --from <bundle-dir> [--pm-id <id>] [--project <root>] [--apply]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Input source is required — the user must specify where the bundle comes from.
[ -n "$SRC" ] || { echo "ERROR: --from <bundle-dir> is required (the input source must be specified)." >&2; exit 2; }
[ -d "$SRC/control" ] || { echo "ERROR: not a control bundle (no control/ under $SRC)." >&2; exit 2; }
[ -f "$SRC/control_bundle_manifest.toml" ] || { echo "ERROR: missing control_bundle_manifest.toml in $SRC." >&2; exit 2; }

KIND="$(grep -E '^kind *= *"' "$SRC/control_bundle_manifest.toml" | head -1 | sed -E 's/.*"(.*)".*/\1/')"
[ "$KIND" = "control_bundle" ] || { echo "ERROR: manifest kind is '$KIND', expected 'control_bundle'." >&2; exit 2; }

GARELIER="$PROJECT/__garelier"
if [ ! -d "$GARELIER" ]; then
  if [ -n "$PM_ID" ]; then mkdir -p "$GARELIER"
  else echo "ERROR: not a Garelier project (no __garelier/): $PROJECT; pass --pm-id to create a control namespace." >&2; exit 2
  fi
fi

if [ -z "$PM_ID" ]; then
  cands=()
  for d in "$GARELIER"/*/; do
    { [ -f "${d}_pm/setup_config.toml" ] || [ -f "${d}control/control.toml" ]; } && cands+=("$(basename "$d")")
  done
  case "${#cands[@]}" in
    1) PM_ID="${cands[0]}"; echo "  auto-detected pm-id: $PM_ID" ;;
    0) echo "ERROR: no control namespace under $GARELIER; pass --pm-id." >&2; exit 2 ;;
    *) echo "ERROR: multiple PMs under $GARELIER; pass --pm-id <id>." >&2; exit 2 ;;
  esac
fi
if [ "$PM_ID" != "_workshop" ] && ! [[ "$PM_ID" =~ ^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$ ]]; then
  echo "ERROR: invalid pm_id '$PM_ID'." >&2; exit 2
fi

DEST="$GARELIER/$PM_ID/control"
mkdir -p "$DEST"

new=0; collide=0
declare -a NEW_FILES=() COLLISIONS=()
while IFS= read -r -d '' f; do
  rel="${f#"$SRC/control/"}"
  [ "$rel" = "control.toml" ] && continue
  target="$DEST/$rel"
  if [ -e "$target" ]; then
    COLLISIONS+=("$rel"); collide=$((collide + 1))
  else
    NEW_FILES+=("$rel"); new=$((new + 1))
  fi
done < <(find "$SRC/control" -type f -print0 | sort -z)

echo ""
echo "==> Control import into PM '$PM_ID'  (mode: $([ "$APPLY" -eq 1 ] && echo APPLY || echo DRY-RUN))"
echo "    new files: $new   collisions (NOT overwritten): $collide"
if [ "$collide" -gt 0 ]; then
  echo "  -- collisions (kept existing; reconcile by hand):"
  for c in "${COLLISIONS[@]}"; do echo "       $c"; done
fi

if [ "$APPLY" -eq 0 ]; then
  echo ""
  echo "Dry run only — nothing written. Re-run with --apply to write the $new new file(s)."
  echo "Collisions are never auto-overwritten; resolve them manually first."
  exit 0
fi

for rel in "${NEW_FILES[@]}"; do
  mkdir -p "$DEST/$(dirname "$rel")"
  cp "$SRC/control/$rel" "$DEST/$rel"
done
if [ ! -f "$DEST/control.toml" ]; then
  printf 'schema_version = 1\nkind = "garelier_control"\npm_id = "%s"\nmode = "control_only"\n' "$PM_ID" > "$DEST/control.toml"
fi

echo ""
echo "==> Wrote $new new file(s) into $DEST"
[ "$collide" -gt 0 ] && echo "    $collide collision(s) left untouched — reconcile and re-run if needed."
echo "Review, then commit the control/ changes (run commit-hygiene first)."
