#!/usr/bin/env bash
#
# dispatch_prepare.sh — zero-LLM producer-dispatch scaffolding (DEC-063 Part A).
#
# Does the mechanical bookkeeping a dispatch orchestrator otherwise hand-builds
# (and a mid-tier model gets wrong): atomically claims the next task id, cuts an
# ISOLATED worktree off the integration branch on the role's branch family, and
# prints {id, container, checkout, branch, base_sha} as one JSON line for the
# producer prompt. Never touches an in-flight role's container (_workers/...);
# containers are __garelier/<pm_id>/_dispatch<id>/ with the worktree at checkout/.
#
# Usage:
#   dispatch_prepare.sh --project <root> --pm-id <id> --role <worker|smith|librarian|artisan>
#                       --slug <kebab-slug> [--base <integration-branch>]
#
# --base overrides the integration branch; otherwise it is read from
# __garelier/<pm_id>/_pm/setup_config.toml ([branches] integration). Read-only
# roles (scout/observer/guardian) are rejected — they need no worktree under
# dispatch (role_subagent_dispatch.md §2).
#
# The cleanup twin is dispatch_cleanup.sh. Exit non-zero on any failure.
set -euo pipefail

PROJECT="" PM="" ROLE="" SLUG="" BASE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?}"; shift 2 ;;
    --pm-id)   PM="${2:?}"; shift 2 ;;
    --role)    ROLE="${2:?}"; shift 2 ;;
    --slug)    SLUG="${2:?}"; shift 2 ;;
    --base)    BASE="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,21p' "$0"; exit 0 ;;
    *) echo "dispatch_prepare: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] && [ -n "$ROLE" ] && [ -n "$SLUG" ] || {
  echo "dispatch_prepare: --project, --pm-id, --role, --slug are required" >&2; exit 2; }
case "$SLUG" in (*[!a-z0-9-]*) echo "dispatch_prepare: --slug must be kebab-case [a-z0-9-]" >&2; exit 2 ;; esac

case "$ROLE" in
  worker)    FAMILY="workbench" ;;
  smith)     FAMILY="anvil" ;;
  librarian) FAMILY="shelf" ;;
  artisan)   FAMILY="satchel" ;;
  scout|observer|guardian)
    echo "dispatch_prepare: $ROLE is read-only under dispatch — no worktree needed (role_subagent_dispatch.md §2)" >&2; exit 2 ;;
  *) echo "dispatch_prepare: unknown role: $ROLE (worker|smith|librarian|artisan)" >&2; exit 2 ;;
esac

if [ -z "$BASE" ]; then
  CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
  [ -f "$CONFIG" ] || { echo "dispatch_prepare: no --base and no $CONFIG" >&2; exit 2; }
  BASE="$(sed -n 's/^[[:space:]]*integration[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONFIG" | head -1)"
  [ -n "$BASE" ] || { echo "dispatch_prepare: [branches] integration not found in $CONFIG" >&2; exit 2; }
fi
case "$BASE" in
  */studio) ;;
  *) echo "dispatch_prepare: integration branch must end in /studio: $BASE" >&2; exit 2 ;;
esac

# Atomic id claim: mkdir is atomic; the lock guards read-increment-write.
IDFILE="$PROJECT/__garelier/$PM/runtime/backlog/next_id"
mkdir -p "$(dirname "$IDFILE")"
LOCK="$IDFILE.lock"
tries=0
until mkdir "$LOCK" 2>/dev/null; do
  tries=$((tries + 1))
  [ "$tries" -lt 50 ] || { echo "dispatch_prepare: could not lock $LOCK" >&2; exit 1; }
  sleep 0.1
done
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
[ -f "$IDFILE" ] || printf '1\n' > "$IDFILE"
ID="$(tr -cd '0-9' < "$IDFILE")"
[ -n "$ID" ] || { echo "dispatch_prepare: $IDFILE is not a number" >&2; exit 1; }
printf '%s\n' "$((ID + 1))" > "$IDFILE"
rmdir "$LOCK" 2>/dev/null || true
trap - EXIT

CONTAINER="$PROJECT/__garelier/$PM/_dispatch$ID"
[ ! -e "$CONTAINER" ] || { echo "dispatch_prepare: container already exists: $CONTAINER" >&2; exit 1; }
BRANCH="${BASE%studio}$FAMILY/#$ID/$SLUG"

mkdir -p "$CONTAINER"
git -C "$PROJECT" worktree add "$CONTAINER/checkout" -b "$BRANCH" "$BASE" >&2
BASE_SHA="$(git -C "$PROJECT" rev-parse --short "$BASE")"

# Visibility (operator-reported gap): STATE.md for the Status Web dispatch
# panel + a start event + the regenerated in_flight.md view - automatic,
# never remembered (W-011: dispatch_event appends the event AND derives the
# view from the live _dispatch<N> containers).
printf '# Dispatch #%s - %s %s\n\n## Status\n\nWORKING\n\n## Current task\n\n#%s %s (%s)\n' \
  "$ID" "$ROLE" "$SLUG" "$ID" "$SLUG" "$BRANCH" > "$CONTAINER/STATE.md"
bash "$(dirname "$0")/dispatch_event.sh" --project "$PROJECT" --pm-id "$PM" \
  --kind start --role "$ROLE(#$ID)" --task "#$ID $SLUG dispatched" >&2

printf '{"id":%s,"container":"%s","checkout":"%s","branch":"%s","base_sha":"%s"}\n' \
  "$ID" "$CONTAINER" "$CONTAINER/checkout" "$BRANCH" "$BASE_SHA"
