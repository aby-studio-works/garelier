#!/usr/bin/env bash
#
# base_tracking_scan.sh — forward-integration drift detector (DEC-039 §8.6, W-061).
#
# DEC-039 makes "studio -> in-flight workbench/anvil" forward-integration a
# SYSTEMATIC per-iteration duty: on each iteration Dock measures how far every
# in-flight Worker/Smith branch is behind the studio tip and, if it is behind
# beyond a threshold and no catch-up is already pending, drops an idempotent
# `track-target.md` trigger the producer consumes at its next iteration boundary
# (garelier-worker §6.5). merge-gate.md §8.6 spells this out as a literal
# `git log --oneline <branch>..<studio> | wc -l` loop Dock/PM was expected to run
# BY HAND for every producer — a mechanism with no reachability (DEC-067 class).
# This script is that loop as ONE command; the jig wires it per tick so driver
# mode gets it for free, and attended Dock/PM run it instead of hand-counting.
#
# What it does NOT do: it never merges, never touches studio, never resolves
# conflicts — the PRODUCER performs the merge and owns any conflict (DEC-039 does
# not widen Dock's no-code-writing boundary). This tool only measures + (with
# --write) drops the trigger file into the producer's own container.
#
# Eligibility (mirrors §8.5/§8.6): only a producer whose STATE.md Status is
# WORKING and whose checkout is on a `.../workbench/...` or `.../anvil/...` branch
# is a candidate — a BLOCKED/REPORTING/REVIEWING/REWORK producer must not be
# instructed, and non-producer roles (scout/observer/guardian/concierge) have no
# forward-integrated branch. Containers scanned: the dispatch-native
# `_dispatch<N>/` homes (DEC-063) plus in-project persistent `_workers/<id>/` and
# `_smiths/<id>/` containers (DEC-036 default). Exile-relocated containers
# (opt-in) are out of scope.
#
# Usage:
#   base_tracking_scan.sh --pm-id <id> [--project <root>] [--studio <branch>]
#       [--threshold <N>] [--write | --dry-run] [--format json|text]
#
#   --threshold N   commits-behind at/above which a trigger is warranted
#                   (default 3, matching merge-gate.md §8.6).
#   --write         actually drop track-target.md for each eligible producer
#                   (idempotent: never overwrites an existing pending trigger).
#   --dry-run       detect + report only, write nothing (DEFAULT).
#   --format        json (default) or text.
#
# Output (json): one object
#   {"pm_id","studio","threshold","mode":"dry-run"|"write","scanned","triggered",
#    "producers":[{"container","role","branch","behind","pending","action","wrote"}]}
#   action ∈ trigger | current | pending | below-threshold | no-studio | no-branch
# Exit: 0 always on a completed scan (drift is informational, not a failure);
#       2 = usage / precondition error.
set -uo pipefail

PROJECT="" PM="" STUDIO="" THRESHOLD=3 MODE="dry-run" FORMAT="json"
while [ $# -gt 0 ]; do
  case "$1" in
    --project)   PROJECT="${2:?}"; shift 2 ;;
    --pm-id)     PM="${2:?}"; shift 2 ;;
    --studio)    STUDIO="${2:?}"; shift 2 ;;
    --threshold) THRESHOLD="${2:?}"; shift 2 ;;
    --write)     MODE="write"; shift ;;
    --dry-run)   MODE="dry-run"; shift ;;
    --format)    FORMAT="${2:?}"; shift 2 ;;
    -h|--help)   sed -n '2,52p' "$0"; exit 0 ;;
    *) echo "base_tracking_scan: unknown arg: $1" >&2
       echo "base_tracking_scan: valid flags: --pm-id --project --studio --threshold --write --dry-run --format -h/--help" >&2
       exit 2 ;;
  esac
done

[ -n "$PM" ] || PM="${GARELIER_PM_ID:-}"
[ -n "$PM" ] || { echo "base_tracking_scan: --pm-id <id> required" >&2; exit 2; }
[ -n "$PROJECT" ] || PROJECT="${GARELIER_PROJECT:-$PWD}"
case "$THRESHOLD" in (*[!0-9]*|"") echo "base_tracking_scan: --threshold must be a non-negative integer" >&2; exit 2 ;; esac
case "$FORMAT" in json|text) ;; *) echo "base_tracking_scan: --format must be json or text" >&2; exit 2 ;; esac

BASE="$PROJECT/__garelier/$PM"
[ -d "$BASE" ] || { echo "base_tracking_scan: no PM environment at $BASE" >&2; exit 2; }

# Resolve the studio (integration) branch once — it is single per PM. Prefer an
# explicit --studio, else [branches] integration in setup_config (same key
# merge_request.sh derives from).
if [ -z "$STUDIO" ]; then
  CONFIG="$BASE/_pm/setup_config.toml"
  [ -f "$CONFIG" ] && STUDIO="$(sed -n 's/^[[:space:]]*integration[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONFIG" | head -1)"
fi

# git runs against the project's git tree; workbench/anvil/studio are all local
# refs in the shared .git that every worktree references.
git_ok() { git -C "$PROJECT" rev-parse --git-dir >/dev/null 2>&1; }
git_ok || { echo "base_tracking_scan: --project is not inside a git repository: $PROJECT" >&2; exit 2; }

# STATE.md '## Status' value (first non-blank line under the heading), squeezed —
# same convention dispatch_event.sh / contract_check read.
state_status() {
  awk '/^##[[:space:]]*Status/{f=1;next} f && NF {gsub(/[[:space:]]/,""); print; exit}' "$1" 2>/dev/null
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }

# studio_ref_exists: the resolved studio must be a real ref, else every count is
# meaningless — report a single no-studio state per producer rather than 0-behind.
STUDIO_EXISTS=0
if [ -n "$STUDIO" ] && git -C "$PROJECT" rev-parse --verify --quiet "refs/heads/$STUDIO" >/dev/null 2>&1; then
  STUDIO_EXISTS=1
fi

NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PRODUCERS_JSON=""
SCANNED=0
TRIGGERED=0

emit() {  # container role branch behind pending action wrote
  local rec
  rec="$(printf '{"container":"%s","role":"%s","branch":"%s","behind":%s,"pending":%s,"action":"%s","wrote":%s}' \
    "$(json_escape "$1")" "$2" "$(json_escape "$3")" "$4" "$5" "$6" "$7")"
  [ -n "$PRODUCERS_JSON" ] && PRODUCERS_JSON="$PRODUCERS_JSON,"
  PRODUCERS_JSON="$PRODUCERS_JSON$rec"
}

# write_trigger: drop the §8.5 track-target.md into the container root (one level
# above the checkout — where the producer reads it). Idempotent: never clobbers
# an existing pending trigger.
write_trigger() {  # container behind branch
  local f="$1/track-target.md"
  [ -e "$f" ] && return 1
  cat > "$f" <<EOF
# Track target

Issued at: $NOW
Issued by: Dock
Strategy: merge
Reason: studio advanced $2 commit(s) past this branch — merge studio in per garelier-worker §6.5 (base_tracking_scan, DEC-039 §8.6).
EOF
}

# scan_container: evaluate ONE producer container (its checkout is on the
# producer branch). Records a producer row only for WORKING producers on a
# workbench/anvil branch — everything else is silently out of scope.
scan_container() {
  local container="$1" checkout="$1/checkout" state branch role behind pending action wrote
  [ -f "$container/STATE.md" ] || return 0
  [ -d "$checkout" ] || return 0
  state="$(state_status "$container/STATE.md")"
  [ "$state" = "WORKING" ] || return 0

  branch="$(git -C "$checkout" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  case "$branch" in
    */workbench/*) role="worker" ;;
    */anvil/*)     role="smith" ;;
    *) return 0 ;;   # detached / non-producer branch — no forward-integration
  esac

  local rel="${container#"$BASE"/}"
  SCANNED=$((SCANNED + 1))
  wrote="false"
  pending="false"
  [ -e "$container/track-target.md" ] && pending="true"

  if [ "$STUDIO_EXISTS" -ne 1 ]; then
    emit "$rel" "$role" "$branch" 0 "$pending" "no-studio" "false"; return 0
  fi
  behind="$(git -C "$PROJECT" rev-list --count "$branch..$STUDIO" 2>/dev/null)"
  case "$behind" in (*[!0-9]*|"") emit "$rel" "$role" "$branch" 0 "$pending" "no-branch" "false"; return 0 ;; esac

  if [ "$behind" -eq 0 ]; then
    action="current"
  elif [ "$pending" = "true" ]; then
    action="pending"                       # idempotent: a catch-up is already queued
  elif [ "$behind" -lt "$THRESHOLD" ]; then
    action="below-threshold"
  else
    action="trigger"
    if [ "$MODE" = "write" ]; then
      if write_trigger "$container" "$behind" "$branch"; then wrote="true"; pending="true"; fi
    fi
    TRIGGERED=$((TRIGGERED + 1))
  fi
  emit "$rel" "$role" "$branch" "$behind" "$pending" "$action" "$wrote"
}

# Dispatch-native ephemeral homes (DEC-063).
for d in "$BASE"/_dispatch*/; do
  [ -d "$d" ] || continue
  scan_container "${d%/}"
done
# In-project persistent producer containers (DEC-036 default; on-demand).
for d in "$BASE"/_workers/*/ "$BASE"/_smiths/*/; do
  [ -d "$d" ] || continue
  scan_container "${d%/}"
done

if [ "$FORMAT" = "text" ]; then
  echo "base-tracking scan: pm=$PM studio=${STUDIO:-<unresolved>} threshold=$THRESHOLD mode=$MODE"
  echo "  scanned=$SCANNED triggered=$TRIGGERED"
  # Re-render rows from the JSON we built (one per line) without a JSON parser:
  printf '%s' "$PRODUCERS_JSON" | tr ',' '\n' | sed -n 's/.*"branch":"\([^"]*\)".*"behind":\([0-9]*\).*"action":"\([^"]*\)".*/  \3: \1 (behind \2)/p'
else
  printf '{"pm_id":"%s","studio":"%s","threshold":%s,"mode":"%s","scanned":%s,"triggered":%s,"producers":[%s]}\n' \
    "$(json_escape "$PM")" "$(json_escape "$STUDIO")" "$THRESHOLD" "$MODE" "$SCANNED" "$TRIGGERED" "$PRODUCERS_JSON"
fi
exit 0
