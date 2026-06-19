#!/usr/bin/env bash
#
# Garelier Librarian knowledge import (DEC-048 section C) — bash.
#
# Import another project's knowledge bundle — but NOT as a free adoption. The
# bundle is STAGED into the Librarian's local-only working area
# (__garelier/<pm_id>/runtime/librarian/raw/, gitignored) and a source_registry
# stub is emitted. The Librarian then reviews it on a `shelf` branch, CONFIRMS
# the license, resolves any rule conflict (BLOCK -> escalate to PM), and promotes
# only the license-clean result into the tracked docs/garelier/* trees.
#
# This script never writes the tracked trees directly — that is the shelf-review
# path (DEC-029 boundary: only registered sources, never change a rule's
# meaning, provenance required).
#
# Usage:
#   knowledge_import.sh --from <bundle-dir> [--pm-id <id>] [--project <root>]
#
# --from is MANDATORY: the input source must be specified explicitly.
set -euo pipefail

PM_ID=""
PROJECT="$(pwd)"
SRC=""

while [ $# -gt 0 ]; do
  case "$1" in
    --pm-id)   PM_ID="${2:?--pm-id needs a value}"; shift 2 ;;
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --from)    SRC="${2:?--from needs a value}"; shift 2 ;;
    -h|--help) echo "usage: knowledge_import.sh --from <bundle-dir> [--pm-id <id>] [--project <root>]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$SRC" ] || { echo "ERROR: --from <bundle-dir> is required (the input source must be specified)." >&2; exit 2; }
[ -f "$SRC/knowledge_bundle_manifest.toml" ] || { echo "ERROR: not a knowledge bundle (no knowledge_bundle_manifest.toml in $SRC)." >&2; exit 2; }
KIND="$(grep -E '^kind *= *"' "$SRC/knowledge_bundle_manifest.toml" | head -1 | sed -E 's/.*"(.*)".*/\1/')"
[ "$KIND" = "knowledge_bundle" ] || { echo "ERROR: manifest kind is '$KIND', expected 'knowledge_bundle'." >&2; exit 2; }

GARELIER="$PROJECT/__garelier"
if [ ! -d "$GARELIER" ]; then
  if [ -n "$PM_ID" ]; then mkdir -p "$GARELIER"
  else echo "ERROR: no __garelier/ staging namespace; pass --pm-id (usually _workshop)." >&2; exit 2
  fi
fi
if [ -z "$PM_ID" ]; then
  cands=()
  for d in "$GARELIER"/*/; do
    { [ -f "${d}_pm/setup_config.toml" ] || [ -f "${d}control/control.toml" ] || [ -d "${d}runtime/librarian" ]; } && cands+=("$(basename "$d")")
  done
  case "${#cands[@]}" in
    1) PM_ID="${cands[0]}"; echo "  auto-detected pm-id: $PM_ID" ;;
    0) echo "ERROR: no knowledge staging namespace under $GARELIER; pass --pm-id." >&2; exit 2 ;;
    *) echo "ERROR: multiple PMs under $GARELIER; pass --pm-id <id>." >&2; exit 2 ;;
  esac
fi
if [ "$PM_ID" != "_workshop" ] && ! [[ "$PM_ID" =~ ^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$ ]]; then
  echo "ERROR: invalid pm_id '$PM_ID'." >&2; exit 2
fi

NAME="$(basename "$SRC")"
NAME="${NAME//[^A-Za-z0-9._-]/-}"
SRC_PROJ="$(grep -E '^source_project *= *"' "$SRC/knowledge_bundle_manifest.toml" | head -1 | sed -E 's/.*"(.*)".*/\1/')"
STAGE="$GARELIER/$PM_ID/runtime/librarian/raw/imported-$NAME"
if [ -e "$STAGE" ]; then echo "ERROR: already staged at $STAGE (remove it first)." >&2; exit 2; fi
mkdir -p "$STAGE"
cp -R "$SRC"/. "$STAGE/"

# Emit a source_registry stub (NOT auto-merged into the registry) for the
# Librarian to confirm and add during shelf review.
STUB="$STAGE/_source_registry.stub.toml"
{
  echo "# source_registry STUB for an imported knowledge bundle (DEC-048 section C)."
  echo "# Confirm license + authority, then add to docs/garelier/knowledge/source_registry.toml"
  echo "# on a shelf branch. Defaults are deliberately conservative."
  echo "[[sources]]"
  echo "id = \"imported-$NAME\""
  echo "title = \"Imported knowledge bundle from ${SRC_PROJ:-unknown}\""
  echo "kind = \"imported_knowledge_bundle\""
  echo "source_type = \"local_file\""
  echo "path = \"runtime/librarian/raw/imported-$NAME\""
  echo "owner = \"pm\""
  echo "update_mode = \"manual\""
  echo "authority = \"third-party\"      # confirm: official | recognized | internal | third-party"
  echo "license = \"unknown\"            # MUST confirm before adoption: confirmed | unknown | not-adoptable"
  echo "use = \"inspiration-only\"       # inspiration-only | allowed-summary | internal-policy-source"
  echo "trust = \"unreviewed\""
} > "$STUB"

echo ""
echo "==> Staged knowledge bundle into the Librarian local-only working area:"
echo "    $STAGE"
echo "    source_registry stub: $STUB"
echo ""
echo "Next (Librarian, on a shelf branch — never a free adoption):"
echo "  1. CONFIRM the license of each file (manifest 'license' fields are hints only)."
echo "  2. Add the (license-confirmed) source to docs/garelier/knowledge/source_registry.toml."
echo "  3. Generalize into ORIGINAL project wording with provenance; do NOT copy verbatim."
echo "  4. A rule CONFLICT with existing knowledge -> BLOCK + escalate to PM (never silently override)."
echo "  5. Promote only license-clean, reviewed content into docs/garelier/* via Dock shelf review."
echo "Raw staged content is gitignored (runtime/) and must never be committed as-is."
