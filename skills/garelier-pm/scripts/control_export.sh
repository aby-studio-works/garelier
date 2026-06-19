#!/usr/bin/env bash
#
# Garelier PM control export (DEC-048 §B) — bash.
#
# Snapshot a PM's TRACKED control/ authority tree into a portable, self-describing
# bundle (for backup, for seeding a new PM from a template project, or for handing
# planning state to another environment).
#
# This is the LOCAL bundle primitive. It does NOT leave the sandbox by itself:
#   - publishing the bundle outside the sandbox / pushing it  -> Concierge + Guardian gate
#   - handing it to ANOTHER PM                                 -> request_intake/ (DEC-006)
# Run commit-hygiene before sharing a bundle: control/ can hold planning notes,
# customer names, decisions.
#
# Usage:
#   control_export.sh --to <dest-dir> [--pm-id <id>] [--project <root>]
#
# --to is MANDATORY: the output destination must be specified explicitly
# (no implied scope). --pm-id auto-detects when exactly one PM exists.
set -euo pipefail

PM_ID=""
PROJECT="$(pwd)"
DEST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pm-id)   PM_ID="${2:?--pm-id needs a value}"; shift 2 ;;
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --to)      DEST="${2:?--to needs a value}"; shift 2 ;;
    -h|--help) echo "usage: control_export.sh --to <dest-dir> [--pm-id <id>] [--project <root>]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Output destination is required — the user must specify where the bundle goes.
[ -n "$DEST" ] || { echo "ERROR: --to <dest-dir> is required (the output destination must be specified)." >&2; exit 2; }

GARELIER="$PROJECT/__garelier"
[ -d "$GARELIER" ] || { echo "ERROR: not a Garelier project (no __garelier/): $PROJECT" >&2; exit 2; }

# Resolve pm-id (auto-detect only when exactly one PM exists).
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

CONTROL="$GARELIER/$PM_ID/control"
[ -d "$CONTROL" ] || { echo "ERROR: no control/ tree at $CONTROL" >&2; exit 2; }

# Refuse to clobber a non-empty destination.
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
  echo "ERROR: destination exists and is not empty: $DEST" >&2; exit 2
fi

mkdir -p "$DEST/control"
# control/ is the tracked authority. runtime/ is a SIBLING (gitignored,
# machine-local) and is therefore excluded by construction — we copy control/ only.
cp -R "$CONTROL"/. "$DEST/control/"

VERSION="$(cat "$PROJECT/VERSION" 2>/dev/null || echo unknown)"
SHA="$(git -C "$PROJECT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
NOW="${GARELIER_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
MAN="$DEST/control_bundle_manifest.toml"

{
  echo "# Control bundle manifest (DEC-048 §B) — a snapshot of a PM's tracked control/ authority."
  echo "schema_version = 1"
  echo "kind = \"control_bundle\""
  echo "pm_id = \"$PM_ID\""
  echo "source_project = \"$(basename "$PROJECT")\""
  echo "garelier_version = \"$VERSION\""
  echo "source_git_sha = \"$SHA\""
  echo "generated_at = \"$NOW\""
  echo "excluded = [\"runtime/ (gitignored, machine-local)\"]"
  echo ""
  echo "# Per-file content ids (git blob sha; verify on import). Paths are bundle-relative."
} > "$MAN"

count=0
while IFS= read -r -d '' f; do
  rel="control/${f#"$DEST/control/"}"
  hash="$(git hash-object "$f" 2>/dev/null || echo "")"
  printf '[[files]]\npath = "%s"\nblob = "%s"\n\n' "$rel" "$hash" >> "$MAN"
  count=$((count + 1))
done < <(find "$DEST/control" -type f -print0 | sort -z)

echo ""
echo "==> Exported PM '$PM_ID' control/ ($count files) to:"
echo "    $DEST"
echo "    manifest: $MAN"
echo "Next: review it. To publish outside the sandbox use Concierge (Guardian-gated);"
echo "to hand it to another PM use the request_intake/ mechanism (DEC-006)."
