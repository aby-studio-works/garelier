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
#                       [--model M] [--effort E] [--scope MARKER] [--tags CSV] [--rework]
#
# --model/--effort/--scope/--tags/--rework are pass-through routing inputs (W-026):
# dispatch_prepare calls model_routing.ts to resolve the producer's model/effort
# and forward-supplies the decision in context.json + the output JSON. Resolver
# absence/failure leaves them empty = inherit (unchanged legacy behavior).
#
# --base overrides the integration branch; otherwise it is read from
# __garelier/<pm_id>/_pm/setup_config.toml ([branches] integration). Read-only
# roles (scout/observer/guardian) are rejected — they need no worktree under
# dispatch (role_subagent_dispatch.md §2).
#
# The cleanup twin is dispatch_cleanup.sh. Exit non-zero on any failure.
set -euo pipefail

PROJECT="" TARGET_ROOT="" PM="" ROLE="" SLUG="" BASE="" BLUEPRINT="" PIPELINE_PACKAGE="" FORCE=0
IN_MODEL="" IN_EFFORT="" IN_SCOPE="" IN_TAGS="" REWORK=0
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
    --model)     IN_MODEL="${2:?}"; shift 2 ;;
    --effort)    IN_EFFORT="${2:?}"; shift 2 ;;
    --scope)     IN_SCOPE="${2:?}"; shift 2 ;;
    --tags)      IN_TAGS="${2:?}"; shift 2 ;;
    --rework)    REWORK=1; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) echo "dispatch_prepare: unknown arg: $1" >&2
       echo "dispatch_prepare: valid flags: --project --target-root --pm-id --role --slug --base --blueprint --pipeline-package --model --effort --scope --tags --rework --force -h/--help" >&2
       exit 2 ;;
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

# Duplicate-dispatch guard (DEC-089): refuse to produce a slug that already has a
# live in-flight _dispatch<N> container. The branch name carries the id
# (.../#<id>/<slug>), so a second produce for the same slug does NOT collide on
# the branch and nothing else catches it — a silent duplicate (e.g. re-producing
# a slug that is already REPORTING). Resolve the existing dispatch first (gate it
# / dispatch_cleanup), or pass --force to dispatch a deliberate parallel. Run
# AFTER the self-heal sweep so genuinely-dead deferred dirs are already gone.
if [ "$FORCE" -ne 1 ]; then
  for _d in "$PROJECT/__garelier/$PM"/_dispatch*/; do
    [ -f "${_d}STATE.md" ] || continue
    _existing_slug="$(awk '/^##[[:space:]]*Current task/{f=1;next} f&&NF{print $2; exit}' "${_d}STATE.md")"
    [ "$_existing_slug" = "$SLUG" ] || continue
    _existing_n="$(basename "$_d")"
    _existing_state="$(awk '/^##[[:space:]]*Status/{f=1;next} f&&NF{gsub(/[[:space:]]/,"");print;exit}' "${_d}STATE.md")"
    echo "dispatch_prepare: slug '$SLUG' already has an in-flight dispatch ($_existing_n, state ${_existing_state:-?}) — producing another would silently duplicate it. Gate or dispatch_cleanup that one first (it is the same work), or pass --force for a deliberate parallel." >&2
    exit 2
  done
fi

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

# Model/effort routing (W-026): resolve the producer's model/effort by the
# canonical order (flag > blueprint hint > rule > seat default > inherit), clamped
# to the PM's model per [model_routing] above_pm. Best-effort — a resolver
# absence/failure leaves MODEL/EFFORT/MODEL_SOURCE empty = inherit (legacy).
MODEL="" EFFORT="" MODEL_SOURCE="" SUGGESTED_MODEL="" NEEDS_CONFIRMATION="false"
# PM model for the above-PM ceiling: env GARELIER_PM_MODEL wins, else config
# [runner] pm_model, else default_agent_model. Absent => resolver clamps
# conservatively to the mid tier.
PM_MODEL="${GARELIER_PM_MODEL:-}"
if [ -z "$PM_MODEL" ] && [ -f "$CONFIG" ]; then
  PM_MODEL="$(sed -n 's/^[[:space:]]*pm_model[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONFIG" | head -1)"
  [ -n "$PM_MODEL" ] || PM_MODEL="$(sed -n 's/^[[:space:]]*default_agent_model[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONFIG" | head -1)"
fi
ROUTE_ARGS=(--project "$PROJECT" --pm-id "$PM" --seat "$ROLE")
[ -n "$BLUEPRINT" ] && ROUTE_ARGS+=(--blueprint "$BLUEPRINT")
[ -n "$IN_MODEL" ]  && ROUTE_ARGS+=(--model "$IN_MODEL")
[ -n "$IN_EFFORT" ] && ROUTE_ARGS+=(--effort "$IN_EFFORT")
[ -n "$IN_SCOPE" ]  && ROUTE_ARGS+=(--scope "$IN_SCOPE")
[ -n "$IN_TAGS" ]   && ROUTE_ARGS+=(--tags "$IN_TAGS")
[ "$REWORK" -eq 1 ] && ROUTE_ARGS+=(--rework)
[ -n "$PM_MODEL" ]  && ROUTE_ARGS+=(--pm-model "$PM_MODEL")
if ROUTING_JSON="$(bun "$(dirname "$0")/../driver/src/dispatch/model_routing.ts" "${ROUTE_ARGS[@]}" 2>/dev/null)"; then
  MODEL="$(printf '%s' "$ROUTING_JSON" | sed -n 's/.*"model":"\([^"]*\)".*/\1/p')"
  EFFORT="$(printf '%s' "$ROUTING_JSON" | sed -n 's/.*"effort":"\([^"]*\)".*/\1/p')"
  MODEL_SOURCE="$(printf '%s' "$ROUTING_JSON" | sed -n 's/.*"source":"\([^"]*\)".*/\1/p')"
  SUGGESTED_MODEL="$(printf '%s' "$ROUTING_JSON" | sed -n 's/.*"suggested_model":"\([^"]*\)".*/\1/p')"
  case "$ROUTING_JSON" in *'"needs_confirmation":true'*) NEEDS_CONFIRMATION="true" ;; esac
  # MODEL is already the SAFE (ceiling-clamped) value under deny AND ask, so this
  # unattended dispatch is deny-equivalent by construction; needs_confirmation +
  # suggested_model are surfaced only for an operator/jig to act on (W-026).
  [ "$NEEDS_CONFIRMATION" = "true" ] && \
    echo "dispatch_prepare: routing suggests '$SUGGESTED_MODEL' above the PM model (above_pm=ask); dispatched at the safe '$MODEL' — an attended PM confirms before using the suggestion." >&2
else
  echo "dispatch_prepare: model routing best-effort skipped (bun/model_routing unavailable)" >&2
fi

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
[ -n "$MODEL" ]        && CTX_ARGS+=(--model "$MODEL")
[ -n "$EFFORT" ]       && CTX_ARGS+=(--effort "$EFFORT")
[ -n "$MODEL_SOURCE" ] && CTX_ARGS+=(--model-source "$MODEL_SOURCE")
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

# Also emit the canonical agent label (produce:<slug>, workflow-naming.md §4) and
# the dispatch agent-id name (<role>(#<id>), the same form built for the start
# event at L136) so the operator — jig, a manual launch, or a mid-tier model —
# copies them verbatim instead of reconstructing the label. This keeps a
# hand/jig-spawned subagent's name aligned with the board Task column, the branch
# <slug>, and the events.jsonl role. Additive keys; existing consumers that pick
# only {id,container,checkout,branch} are unaffected.
#
# agent_name = attended bare-Agent use (Claude Code Agent tool `name`,
# workflow-naming.md §5): `ga-produce-<slug>`, sanitized to the Agent name
# regex `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` and truncated to 64 chars. `label`
# and `name` above keep their colon/parenthesis forms unchanged for jig/board/
# events consumers; `agent_name` is the separate regex-safe form for a PM
# calling the Agent tool directly.
AGENT_NAME="$(printf 'ga-produce-%s' "$SLUG" | tr -c 'A-Za-z0-9_-' '-')"
case "$AGENT_NAME" in
  [A-Za-z0-9]*) ;;
  *) AGENT_NAME="a$AGENT_NAME" ;;
esac
AGENT_NAME="${AGENT_NAME:0:64}"

# model/effort/model_source (W-026): the resolved routing decision, empty when
# inherit (jig/attended launcher passes them to the Agent/Workflow spawn — the
# attended Agent tool honors `model` only; `effort` needs the jig/Workflow path).
# `model` is already clamped to the PM ceiling (deny/ask), so an unattended spawn
# is safe; needs_confirmation + suggested_model let an attended PM escalate only
# after user confirmation (above_pm=ask).
printf '{"id":%s,"container":"%s","checkout":"%s","branch":"%s","base_sha":"%s","target_root":"%s","context":"%s","pickup_pack":"%s","label":"produce:%s","name":"%s(#%s)","agent_name":"%s","model":"%s","effort":"%s","model_source":"%s","suggested_model":"%s","needs_confirmation":%s}\n' \
  "$ID" "$CONTAINER" "$CONTAINER/checkout" "$BRANCH" "$BASE_SHA" "$GIT_ROOT" "$CONTEXT" "$PICKUP" "$SLUG" "$ROLE" "$ID" "$AGENT_NAME" "$MODEL" "$EFFORT" "$MODEL_SOURCE" "$SUGGESTED_MODEL" "$NEEDS_CONFIRMATION"
