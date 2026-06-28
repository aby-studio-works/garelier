#!/usr/bin/env bash
#
# dispatch_prepare.sh — zero-LLM producer-dispatch scaffolding (DEC-063 Part A).
#
# Does the mechanical bookkeeping a dispatch Dock otherwise hand-builds
# (and a mid-tier model gets wrong): atomically claims the next task id, cuts an
# ISOLATED worktree off the integration branch on the role's branch family, and
# prints {id, container, checkout, branch, base_sha, context} as one JSON line for
# the producer prompt. It also writes a forward-supply fact-pack (context.json,
# DEC-081 Piece 1) and an advisory pickup_pack.json (W-017) into the container so
# the producer does not re-derive project facts (gate command, target_slug,
# branch names, base sha) in its cold worktree.
# Never touches an in-flight role's container (_workers/...);
# containers are __garelier/<pm_id>/_dispatch<id>/ with the worktree at checkout/.
#
# Usage:
#   dispatch_prepare.sh --project <control-root> --pm-id <id> --role <worker|smith|librarian|artisan>
#                       --slug <kebab-slug> [--base <integration-branch>] [--blueprint <path>]
#                       [--pipeline-package PP-N] [--target-root <git-root>]
#
# --base overrides the integration branch; otherwise it is read from
# __garelier/<pm_id>/_pm/setup_config.toml ([branches] integration). Read-only
# roles (scout/observer/guardian) are rejected — they need no worktree under
# dispatch (role_subagent_dispatch.md §2).
#
# The cleanup twin is dispatch_cleanup.sh. Exit non-zero on any failure.
set -euo pipefail

PROJECT="" TARGET_ROOT="" PM="" ROLE="" SLUG="" BASE="" BLUEPRINT="" PIPELINE_PACKAGE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)   PROJECT="${2:?}"; shift 2 ;;
    --target-root) TARGET_ROOT="${2:?}"; shift 2 ;;
    --pm-id)     PM="${2:?}"; shift 2 ;;
    --role)      ROLE="${2:?}"; shift 2 ;;
    --slug)      SLUG="${2:?}"; shift 2 ;;
    --base)      BASE="${2:?}"; shift 2 ;;
    --blueprint) BLUEPRINT="${2:?}"; shift 2 ;;
    --pipeline-package) PIPELINE_PACKAGE="${2:?}"; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "dispatch_prepare: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] && [ -n "$ROLE" ] && [ -n "$SLUG" ] || {
  echo "dispatch_prepare: --project, --pm-id, --role, --slug are required" >&2; exit 2; }
GIT_ROOT="${TARGET_ROOT:-$PROJECT}"
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
else
  CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
fi
case "$BASE" in
  */studio) ;;
  *) echo "dispatch_prepare: integration branch must end in /studio: $BASE" >&2; exit 2 ;;
esac

if [ -n "$PIPELINE_PACKAGE" ]; then
  [ -n "$BLUEPRINT" ] || { echo "dispatch_prepare: --pipeline-package requires --blueprint" >&2; exit 2; }
  bun "$(dirname "$0")/../driver/src/pipeline_packages.ts" render-assignment \
    --blueprint "$BLUEPRINT" --package "$PIPELINE_PACKAGE" --role "$ROLE" \
    --task-id 0 --agent-id "$ROLE(#0)" --pm-id "$PM" --slug "$SLUG" \
    --base-branch "$BASE" --config "$CONFIG" >/dev/null || {
      echo "dispatch_prepare: invalid pipeline package $PIPELINE_PACKAGE for role $ROLE" >&2
      exit 1
    }
fi

# Self-heal (DEC-073 Part C): sweep deferred stale worktree dirs from a prior
# cleanup that lost a handle race (Windows target/ lock). Best-effort.
bash "$(dirname "$0")/dispatch_cleanup.sh" --project "$PROJECT" --pm-id "$PM" --target-root "$GIT_ROOT" --sweep >/dev/null 2>&1 || true

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
git -C "$GIT_ROOT" worktree add "$CONTAINER/checkout" -b "$BRANCH" "$BASE" >&2
BASE_SHA="$(git -C "$GIT_ROOT" rev-parse --short "$BASE")"

# Visibility (operator-reported gap): STATE.md for the Status Web dispatch
# panel + a start event + the regenerated in_flight.md view - automatic,
# never remembered (W-011: dispatch_event appends the event AND derives the
# view from the live _dispatch<N> containers).
printf '# Dispatch #%s - %s %s\n\n## Status\n\nWORKING\n\n## Current task\n\n#%s %s (%s)\n' \
  "$ID" "$ROLE" "$SLUG" "$ID" "$SLUG" "$BRANCH" > "$CONTAINER/STATE.md"

# Report scaffold: producers converged on different report locations in live
# runs; pre-creating the file makes the location structural. dispatch_cleanup
# archives it to runtime/backlog/done/ when the container is removed.
{
  printf '# Report - #%s %s (%s)\n\n' "$ID" "$SLUG" "$ROLE"
  printf -- '- Branch: %s\n- Base SHA: %s\n\n' "$BRANCH" "$BASE_SHA"
  printf '## Status\n\n(REPORTING | BLOCKED)\n\n'
  printf '## Summary\n\n(what changed and why - compact; reference paths/SHAs, never paste diffs)\n\n'
  printf '## Gates\n\n(commands run + results)\n\n'
  printf '## Evidence\n\n(red->green proof, measurements, writer-audit conclusions)\n\n'
  printf '## Context pack gaps\n\n(facts you had to rediscover that the assignment/blueprint should have carried - exact paths, invariants, verify commands; "none" when the context pack sufficed - DEC-071)\n'
} > "$CONTAINER/report.md"

TASK_LABEL="#$ID $SLUG dispatched"
[ -n "$PIPELINE_PACKAGE" ] && TASK_LABEL="$TASK_LABEL [$PIPELINE_PACKAGE]"
bash "$(dirname "$0")/dispatch_event.sh" --project "$PROJECT" --pm-id "$PM" \
  --kind start --role "$ROLE(#$ID)" --task "$TASK_LABEL" >&2

# Forward-supply fact-pack (DEC-081 Piece 1): the project facts a producer would
# otherwise re-derive in its cold worktree (gate command, target/target_slug,
# branch names, base sha) + blueprint anchors. Best-effort — dispatch must NOT
# fail on the fact-pack; the producer can still read setup_config / the blueprint.
CONTEXT="$CONTAINER/context.json"
CTX_ARGS=(
      --config "$PROJECT/__garelier/$PM/_pm/setup_config.toml"
      --pm-id "$PM" --project "$GIT_ROOT" --integration "$BASE" \
      --task-id "$ID" --role "$ROLE" --slug "$SLUG" --branch "$BRANCH" --base-sha "$BASE_SHA" \
      --out "$CONTEXT"
)
[ -n "$BLUEPRINT" ] && CTX_ARGS+=(--blueprint "$BLUEPRINT")
if ! bun "$(dirname "$0")/../driver/src/context_pack.ts" "${CTX_ARGS[@]}" >/dev/null 2>&1; then
  echo "dispatch_prepare: context.json best-effort skipped (bun/context_pack unavailable)" >&2
  CONTEXT=""
fi

if [ -n "$PIPELINE_PACKAGE" ]; then
  TARGET_SLUG=""
  case "$BASE" in
    garelier/*)
      REST="${BASE#garelier/}"
      TARGET_SLUG="${REST%%/*}"
      ;;
  esac
  if ! bun "$(dirname "$0")/../driver/src/pipeline_packages.ts" render-assignment \
        --blueprint "$BLUEPRINT" --package "$PIPELINE_PACKAGE" --role "$ROLE" \
        --task-id "$ID" --agent-id "$ROLE(#$ID)" --pm-id "$PM" \
        --target-slug "$TARGET_SLUG" --slug "$SLUG" --branch "$BRANCH" \
        --base-branch "$BASE" --base-sha "$BASE_SHA" --config "$CONFIG" \
        --out "$CONTAINER/assignment.md"; then
    echo "dispatch_prepare: failed to render assignment for $PIPELINE_PACKAGE" >&2
    exit 1
  fi
fi

PICKUP="$CONTAINER/pickup_pack.json"
if [ -f "$CONTAINER/assignment.md" ]; then
  ROLE_INDEX="$PROJECT/__garelier/__atmos/knowledge/role_index.toml"
  [ -f "$ROLE_INDEX" ] || ROLE_INDEX="$PROJECT/__garelier/$PM/knowledge/role_index.toml"
  PICKUP_ARGS=(--role "$ROLE" --assignment "$CONTAINER/assignment.md" --out "$PICKUP")
  [ -n "$CONTEXT" ] && PICKUP_ARGS+=(--context "$CONTEXT")
  [ -f "$ROLE_INDEX" ] && PICKUP_ARGS+=(--role-index "$ROLE_INDEX")
  if ! bun "$(dirname "$0")/../driver/src/role_pickup_pack.ts" "${PICKUP_ARGS[@]}" >/dev/null 2>&1; then
    echo "dispatch_prepare: pickup_pack.json best-effort skipped (bun/role_pickup_pack unavailable)" >&2
    PICKUP=""
  fi
else
  PICKUP=""
fi

printf '{"id":%s,"container":"%s","checkout":"%s","branch":"%s","base_sha":"%s","target_root":"%s","context":"%s","pickup_pack":"%s"}\n' \
  "$ID" "$CONTAINER" "$CONTAINER/checkout" "$BRANCH" "$BASE_SHA" "$GIT_ROOT" "$CONTEXT" "$PICKUP"
