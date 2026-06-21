#!/usr/bin/env bash
#
# Garelier Librarian knowledge export (DEC-048 section C) — bash.
#
# Export the TRACKED, CURATED knowledge (both the per-pm __garelier/<pm_id>/knowledge/* and the optional shared __garelier/__atmos/knowledge/* trees + the
# knowledge/*.toml registries + runbooks/manuals + docs/rules) into a portable
# bundle with per-file provenance, so another Garelier project can adopt it.
#
# Exports only git-tracked, secret/PII-clean content. Missing license
# provenance is recorded in the manifest as a warning count; unknown or
# not-adoptable licenses are refused. The Librarian's
# local-only working area (__garelier/<pm_id>/runtime/librarian/{raw,cache,drafts})
# is NEVER exported — raw external content has unknown license / size / PII risk
# (DEC-038). Leaving the sandbox is Concierge + Guardian (DEC-024 / DEC-025).
#
# Usage:
#   knowledge_export.sh --to <dest-dir> [--project <root>] [--pm-id <id>] [--allow-dirty]
#
# --to is MANDATORY: the output destination must be specified explicitly.
# DEC-077: knowledge lives in the per-pm layer (__garelier/<pm_id>/knowledge,
# default pm_id=_workshop) plus the OPTIONAL shared __atmos tier; export covers
# both layers when present.
set -euo pipefail

PROJECT="$(pwd)"
PM_ID="_workshop"
DEST=""
ALLOW_DIRTY=false

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?--project needs a value}"; shift 2 ;;
    --pm-id)   PM_ID="${2:?--pm-id needs a value}"; shift 2 ;;
    --to)      DEST="${2:?--to needs a value}"; shift 2 ;;
    --allow-dirty) ALLOW_DIRTY=true; shift ;;
    -h|--help) echo "usage: knowledge_export.sh --to <dest-dir> [--project <root>] [--pm-id <id>] [--allow-dirty]"; exit 0 ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

PM_KNOWLEDGE="__garelier/$PM_ID/knowledge"
ATMOS_KNOWLEDGE="__garelier/__atmos/knowledge"
[ -n "$DEST" ] || { echo "ERROR: --to <dest-dir> is required (the output destination must be specified)." >&2; exit 2; }
[ -d "$PROJECT/$PM_KNOWLEDGE" ] || [ -d "$PROJECT/$ATMOS_KNOWLEDGE" ] || { echo "ERROR: no curated knowledge at $PROJECT/$PM_KNOWLEDGE (nor shared $ATMOS_KNOWLEDGE) — nothing to export." >&2; exit 2; }
if [ -e "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
  echo "ERROR: destination exists and is not empty: $DEST" >&2; exit 2
fi
if ! git -C "$PROJECT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: knowledge export requires a git worktree so tracked/dirty state can be verified." >&2
  exit 2
fi

# Tracked, curated roots only. A dirty target tree is refused by default so
# temporary edits and untracked files cannot silently enter a bundle.
# Both knowledge layers (per-pm home + optional shared __atmos) are exported.
# git ls-files / status tolerate paths that do not exist on disk.
ROOTS=(
  "$PM_KNOWLEDGE" "$ATMOS_KNOWLEDGE"
  "docs/rules"
)
DIRTY="$(git -C "$PROJECT" status --porcelain -- "${ROOTS[@]}" 2>/dev/null || true)"
CLEAN_WORKTREE=true
if [ -n "$DIRTY" ]; then
  CLEAN_WORKTREE=false
  if [ "$ALLOW_DIRTY" != "true" ]; then
    echo "ERROR: curated knowledge export tree is dirty; commit, stash, or pass --allow-dirty intentionally." >&2
    echo "$DIRTY" | sed 's/^/    /' >&2
    exit 2
  fi
fi

TRACKED_FILES="$(git -C "$PROJECT" ls-files -- "${ROOTS[@]}")"
[ -n "$TRACKED_FILES" ] || { echo "ERROR: no tracked curated knowledge files found under export roots." >&2; exit 2; }

mkdir -p "$DEST"
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  src="$PROJECT/$rel"
  [ -f "$src" ] || continue
  dest_file="$DEST/$rel"
  mkdir -p "$(dirname "$dest_file")"
  cp "$src" "$dest_file"
done <<< "$TRACKED_FILES"

SECRET_RE='(api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|authorization)[[:space:]]*[:=][[:space:]]*[^[:space:]]+|-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[psoru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+'
PII_RE='[[:alnum:]._%+-]+@[[:alnum:].-]+\.[[:alpha:]]{2,}|(\+[0-9][0-9 ()_.-]{8,}[0-9]|[0-9]{3}[-. ][0-9]{3,4}[-. ][0-9]{4})'
SECRET_HITS="$(grep -R -n -I -E "$SECRET_RE" "$DEST" 2>/dev/null || true)"
if [ -n "$SECRET_HITS" ]; then
  echo "ERROR: possible secret detected in exported knowledge; refusing bundle." >&2
  echo "$SECRET_HITS" | head -20 | sed 's/^/    /' >&2
  exit 2
fi
PII_HITS="$(grep -R -n -I -E "$PII_RE" "$DEST" 2>/dev/null || true)"
if [ -n "$PII_HITS" ]; then
  echo "ERROR: possible PII detected in exported knowledge; refusing bundle." >&2
  echo "$PII_HITS" | head -20 | sed 's/^/    /' >&2
  exit 2
fi

REGISTRY_RIGHTS_HITS=""
for reg in "$DEST/$PM_KNOWLEDGE/source_registry.toml" "$DEST/$ATMOS_KNOWLEDGE/source_registry.toml"; do
  [ -f "$reg" ] || continue
  hits="$(grep -n -I -E '^[[:space:]]*license[[:space:]]*=[[:space:]]*"(unknown|not-adoptable)"' "$reg" 2>/dev/null || true)"
  [ -n "$hits" ] && REGISTRY_RIGHTS_HITS="$REGISTRY_RIGHTS_HITS"$'\n'"$reg:"$'\n'"$hits"
done
if [ -n "$(printf '%s' "$REGISTRY_RIGHTS_HITS" | tr -d '[:space:]')" ]; then
  echo "ERROR: source_registry contains license=unknown/not-adoptable; refusing knowledge bundle." >&2
  echo "$REGISTRY_RIGHTS_HITS" | head -20 | sed 's/^/    /' >&2
  exit 2
fi

VERSION="$(cat "$PROJECT/VERSION" 2>/dev/null || echo unknown)"
SHA="$(git -C "$PROJECT" rev-parse --short HEAD 2>/dev/null || echo nogit)"
NOW="${GARELIER_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
MAN="$DEST/knowledge_bundle_manifest.toml"
ENTRIES="$(mktemp)"
LICENSE_BLOCKS="$(mktemp)"
trap 'rm -f "$ENTRIES" "$LICENSE_BLOCKS"' EXIT

# Extract a provenance value from a knowledge file's front matter (best-effort).
prov() {
  # Missing provenance is recorded as a manifest warning below; it is not a
  # shell failure. The final `|| true` also absorbs pipefail/SIGPIPE when
  # head bounds an unusually long value.
  grep -m1 -iE "^[#> -]*$2[[:space:]]*[:=]" "$1" 2>/dev/null |
    sed -E 's/^[#> -]*[^:=]*[:=][[:space:]]*//; s/^["'\'' ]+//; s/["'\'' ]+$//' |
    head -c 120 || true
}
toml_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

count=0
license_warning_count=0
license_block_count=0
while IFS= read -r -d '' f; do
  rel="${f#"$DEST/"}"
  hash="$(git hash-object "$f" 2>/dev/null || echo "")"
  sid="$(prov "$f" source_id)"; lic="$(prov "$f" license)"
  rev="$(prov "$f" last_reviewed_at)"; [ -z "$rev" ] && rev="$(prov "$f" last_synced_at)"
  lic_lower="$(printf '%s' "$lic" | tr '[:upper:]' '[:lower:]')"
  lic_status=""
  if [ -z "$lic" ]; then
    lic_status="missing"
    license_warning_count=$((license_warning_count + 1))
  elif [ "$lic_lower" = "unknown" ] || [ "$lic_lower" = "not-adoptable" ]; then
    lic_status="$lic_lower"
    license_block_count=$((license_block_count + 1))
    printf '%s: license=%s\n' "$rel" "$lic_lower" >> "$LICENSE_BLOCKS"
  fi
  {
    printf '[[files]]\npath = "%s"\nblob = "%s"\n' "$(toml_escape "$rel")" "$(toml_escape "$hash")"
    [ -n "$sid" ] && printf 'source_id = "%s"\n' "$(toml_escape "$sid")"
    [ -n "$lic" ] && printf 'license = "%s"\n' "$(toml_escape "$lic")"
    [ -n "$lic_status" ] && printf 'license_status = "%s"\n' "$lic_status"
    [ -n "$rev" ] && printf 'last_reviewed_at = "%s"\n' "$(toml_escape "$rev")"
    printf '\n'
  } >> "$ENTRIES"
  count=$((count + 1))
done < <(find "$DEST" -type f ! -name "knowledge_bundle_manifest.toml" -print0 | sort -z)

if [ "$license_block_count" -gt 0 ]; then
  echo "ERROR: exported knowledge contains license=unknown/not-adoptable provenance; refusing bundle." >&2
  head -20 "$LICENSE_BLOCKS" | sed 's/^/    /' >&2
  exit 2
fi

{
  echo "# Knowledge bundle manifest (DEC-048 section C) — curated, tracked, secret/PII-clean knowledge."
  echo "schema_version = 1"
  echo "kind = \"knowledge_bundle\""
  echo "source_project = \"$(toml_escape "$(basename "$PROJECT")")\""
  echo "garelier_version = \"$(toml_escape "$VERSION")\""
  echo "source_git_sha = \"$(toml_escape "$SHA")\""
  echo "generated_at = \"$(toml_escape "$NOW")\""
  echo "tracked_only = true"
  echo "clean_worktree = $CLEAN_WORKTREE"
  echo "allow_dirty = $ALLOW_DIRTY"
  echo "secret_scan = \"simple\""
  echo "secret_scan_passed = true"
  echo "pii_scan_passed = true"
  echo "license_warning_count = $license_warning_count"
  echo "license_block_count = 0"
  echo "excluded = [\"runtime/librarian/{raw,cache,drafts,reports} (local-only, never exported)\"]"
  echo ""
  echo "# IMPORTANT (import side): treat every file as a THIRD-PARTY source. Confirm"
  echo "# license before adoption; register it in source_registry.toml; review on a"
  echo "# shelf branch; a rule conflict BLOCKS and escalates to PM. Never free-adopt."
  echo ""
  echo "# Per-file: content id + any provenance found in the file's front matter."
  cat "$ENTRIES"
} > "$MAN"

echo ""
echo "==> Exported curated knowledge ($count files) to:"
echo "    $DEST"
echo "    manifest: $MAN"
echo "Import side adopts this ONLY via source registration + shelf review (knowledge_import)."
