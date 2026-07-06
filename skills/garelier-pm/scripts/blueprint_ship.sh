#!/usr/bin/env bash
#
# blueprint_ship.sh — one-command blueprint ship/abandon bookkeeping (W-064 #10).
#
# When a blueprint ships (or is abandoned), the PM hand-edits 2-3 tracked files
# every time (promote.md steps 3-5, history-tracking.md): flip the history entry
# Outcome, flip the blueprint Status, and git-mv the blueprint into archive/.
# That per-ship toil had no script (pm/scripts and core/scripts both lacked one),
# so it was easy to do partially. This derives the edits from existing artifacts
# — same "derive, don't hand-assemble; leave the commit to a human" pattern as
# merge_request.sh — so the bookkeeping is one command and the PM only commits.
#
# It does the DETERMINISTIC parts:
#   1. blueprint Status:  → `shipped` (shipped) / `archived` (abandoned)
#   2. git mv  control/blueprints/<slug>.md → control/blueprints/archive/<slug>.md
#   3. history.md: the entry whose `- Blueprint:` names <slug>.md gets its
#      `- Outcome: in-progress` flipped to the terminal outcome, and (only when
#      its `- Notes:` is the "-" placeholder) a `<outcome> <date>` Notes stamp.
#
# The roadmap "Recently promoted" move (promote.md step 3) is NOT automated: the
# milestone↔blueprint link is not derivable from <slug>, and a fuzzy edit could
# corrupt roadmap.md. The script prints a reminder for it instead.
#
# Usage:
#   blueprint_ship.sh --project <root> --pm-id <id> --slug <blueprint-slug>
#                     --outcome shipped|abandoned [--date <YYYY-MM-DD>] [--dry-run]
#
#   --project   project root that contains __garelier/ (default: cwd)
#   --pm-id     PM id (the <pm_id> segment under __garelier/)
#   --slug      blueprint file basename without .md (control/blueprints/<slug>.md)
#   --outcome   shipped | abandoned
#   --date      Notes stamp date (default: today, UTC)
#   --dry-run   print what would change; touch nothing
#
# Exit codes: 0 ok; 2 usage/precondition error.
set -euo pipefail

PROJECT="." PM="" SLUG="" OUTCOME="" DATE="" DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?}"; shift 2 ;;
    --pm-id)   PM="${2:?}"; shift 2 ;;
    --slug)    SLUG="${2:?}"; shift 2 ;;
    --outcome) OUTCOME="${2:?}"; shift 2 ;;
    --date)    DATE="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,38p' "$0"; exit 0 ;;
    *) echo "blueprint_ship: unknown arg: $1" >&2
       echo "blueprint_ship: valid flags: --project --pm-id --slug --outcome --date --dry-run -h/--help" >&2
       exit 2 ;;
  esac
done

[ -n "$PM" ]      || { echo "blueprint_ship: --pm-id is required" >&2; exit 2; }
[ -n "$SLUG" ]    || { echo "blueprint_ship: --slug is required" >&2; exit 2; }
case "$OUTCOME" in
  shipped|abandoned) : ;;
  *) echo "blueprint_ship: --outcome must be 'shipped' or 'abandoned' (got '${OUTCOME:-}')" >&2; exit 2 ;;
esac
[ -n "$DATE" ] || DATE="$(date -u +%Y-%m-%d)"

# shipped blueprints go Status: shipped; abandoned ones Status: archived (the
# blueprint template's Status enum). Both are moved into archive/.
STATUS="shipped"; [ "$OUTCOME" = "abandoned" ] && STATUS="archived"

PM_ROOT="$PROJECT/__garelier/$PM"
BLUEPRINT="$PM_ROOT/control/blueprints/$SLUG.md"
ARCHIVE_DIR="$PM_ROOT/control/blueprints/archive"
ARCHIVE="$ARCHIVE_DIR/$SLUG.md"
HISTORY="$PM_ROOT/_pm/history.md"

[ -f "$BLUEPRINT" ] || { echo "blueprint_ship: blueprint not found: $BLUEPRINT" >&2; exit 2; }
[ ! -e "$ARCHIVE" ] || { echo "blueprint_ship: already archived: $ARCHIVE" >&2; exit 2; }

GIT_ROOT="$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null || true)"

# --- history.md Outcome/Notes flip (awk, block-scoped to the matching entry) ---
# Match the entry block (## # ... up to the next ## #) whose `- Blueprint:` line
# names <slug>.md, then flip `- Outcome: in-progress` and stamp a Notes date if
# Notes is the "-" placeholder. Other entries are copied verbatim.
history_rewrite() {
  awk -v slug="$SLUG" -v outcome="$OUTCOME" -v date="$DATE" '
    function flush() {
      if (matched) {
        for (i = 0; i < n; i++) {
          line = buf[i]
          if (!oc_done && line ~ /^- Outcome:[[:space:]]*in-progress[[:space:]]*$/) {
            line = "- Outcome: " outcome; oc_done = 1; flipped = 1
          } else if (!nt_done && line ~ /^- Notes:[[:space:]]*-[[:space:]]*$/) {
            line = "- Notes: " outcome " " date; nt_done = 1
          }
          print line
        }
      } else {
        for (i = 0; i < n; i++) print buf[i]
      }
      n = 0; matched = 0; oc_done = 0; nt_done = 0
    }
    BEGIN { n = 0; matched = 0; oc_done = 0; nt_done = 0; started = 0; flipped = 0 }
    /^## #/ { if (started) flush(); started = 1; buf[n++] = $0; next }
    {
      buf[n++] = $0
      if ($0 ~ ("^- Blueprint:.*/" slug "\\.md[[:space:]]*$")) matched = 1
      if ($0 ~ ("^- Blueprint:[[:space:]]*" slug "\\.md[[:space:]]*$")) matched = 1
    }
    END { if (started) flush(); exit flipped ? 0 : 3 }
  ' "$HISTORY"
}

CHANGED=()
NOTES=()

# 1. blueprint Status flip (in place; the git mv below moves the edited file).
if grep -qE '^- Status:' "$BLUEPRINT"; then
  if [ "$DRY" -eq 0 ]; then
    tmp="$(mktemp)"
    sed -E "s|^- Status:.*$|- Status: $STATUS|" "$BLUEPRINT" > "$tmp" && mv "$tmp" "$BLUEPRINT"
  fi
  CHANGED+=("blueprint Status -> $STATUS")
else
  NOTES+=("blueprint has no '- Status:' line; skipped Status flip")
fi

# 2. archive move (git mv when tracked; plain mv otherwise).
if [ "$DRY" -eq 0 ]; then
  mkdir -p "$ARCHIVE_DIR"
  if [ -n "$GIT_ROOT" ] && git -C "$GIT_ROOT" ls-files --error-unmatch "$BLUEPRINT" >/dev/null 2>&1; then
    git -C "$GIT_ROOT" mv "$BLUEPRINT" "$ARCHIVE" >&2
  else
    mv "$BLUEPRINT" "$ARCHIVE"
  fi
fi
CHANGED+=("blueprint $SLUG.md -> archive/$SLUG.md")

# 3. history.md Outcome/Notes flip.
if [ -f "$HISTORY" ]; then
  if out="$(history_rewrite)"; then
    if [ "$DRY" -eq 0 ]; then printf '%s\n' "$out" > "$HISTORY"; fi
    CHANGED+=("history entry Outcome -> $OUTCOME")
  else
    rc=$?
    if [ "$rc" -eq 3 ]; then
      NOTES+=("no history entry with '- Blueprint: .../$SLUG.md' + '- Outcome: in-progress' found; flip its Outcome by hand")
    else
      echo "blueprint_ship: history rewrite failed (awk rc=$rc)" >&2; exit 2
    fi
  fi
else
  NOTES+=("history.md not found at $HISTORY; skipped Outcome flip")
fi

# --- summary (never commits; leaves that to the PM) ---
prefix="applied"; [ "$DRY" -eq 1 ] && prefix="dry-run"
echo "blueprint_ship ($prefix): $SLUG -> $OUTCOME"
for c in "${CHANGED[@]}"; do echo "  changed: $c"; done
for ngt in "${NOTES[@]:-}"; do [ -n "$ngt" ] && echo "  note: $ngt"; done
echo "  reminder: move the milestone to roadmap.md 'Recently promoted' by hand (not auto — milestone<->blueprint link is not derivable)"
echo "  next: review the diff, then commit (this script never commits)"
