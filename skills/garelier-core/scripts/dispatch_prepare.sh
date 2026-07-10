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
#                       [--touches '<glob>,<glob>'] [--depends-on '<slug|#id>,...'] [--allow-conflict]
#                       [--full-gate]
#
# QUOTE glob-valued flags with SINGLE quotes (W-054): --touches 'docs/**'. If the
# value (e.g. docs/**) is left unquoted, the invoking shell expands it against the
# cwd into multiple words BEFORE this script sees them, so the extra path words
# arrive as stray positionals and fail arg parsing ("unknown arg: docs/engine").
# This script's own expansions are all quoted; the fix is at the call site.
#
# --touches / --depends-on are declared conflict/dependency metadata (W-053):
# --touches lists the path globs this dispatch expects to edit; --depends-on lists
# prior dispatches (by slug or #id) it should follow. They persist into
# context.json (task.touches / task.depends_on) and drive a dispatch-time
# mechanical check: the new touches are intersected with every active
# _dispatch*/context.json's touches (simple prefix + basename glob heuristic,
# false-positive-leaning). An overlap, or an unfinished --depends-on, prints a
# "serialize / split / --allow-conflict" WARNING to stderr and lands under the
# output JSON `conflict_check` key. It NEVER blocks (the attended PM decides);
# --allow-conflict silences the warning for a deliberate parallel.
#
# --touches also drives the scoped self-gate (W-068): context_pack resolves the
# CARGO PACKAGE names the declared globs refer to (nearest ancestor Cargo.toml
# `[package] name`) into context.json `task.touched_packages`, and sets
# `quality_gate.scoped` (`cargo check -p <pkg>` + `cargo test -p <pkg> --lib`) as
# the producer's DEFAULT gate (`quality_gate.default_gate = "scoped"`). This keeps
# the producer self-gate RAM-cheap and inside the foreground limit (DEC-091); the
# whole-workspace compile stays the merge gate's authoritative job. Pass
# --full-gate for a task that genuinely needs the whole-workspace gate as its
# self-gate (sets default_gate = "full"). Without --touches nothing can be scoped,
# so default_gate falls back to "full" (unchanged legacy behavior).
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
IN_TOUCHES="" IN_DEPENDS="" ALLOW_CONFLICT=0 FULL_GATE=0
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
    --touches)   IN_TOUCHES="${2:?}"; shift 2 ;;
    --depends-on) IN_DEPENDS="${2:?}"; shift 2 ;;
    --allow-conflict) ALLOW_CONFLICT=1; shift ;;
    --full-gate) FULL_GATE=1; shift ;;
    --rework)    REWORK=1; shift ;;
    --force)     FORCE=1; shift ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) echo "dispatch_prepare: unknown arg: $1" >&2
       if [ -e "$1" ]; then
         echo "dispatch_prepare: hint: '$1' is an existing path — a glob-valued flag was almost certainly left UNQUOTED, so the shell expanded it into multiple words before this script ran (e.g. --touches docs/** became --touches docs/main docs/engine …). Single-quote the value so no pathname expansion happens: --touches 'docs/**' (same for --depends-on). See W-054." >&2
       fi
       echo "dispatch_prepare: valid flags: --project --target-root --pm-id --role --slug --base --blueprint --pipeline-package --model --effort --scope --tags --touches --depends-on --allow-conflict --full-gate --rework --force -h/--help" >&2
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
TARGET_BRANCH=""
if [ -f "$CONFIG" ]; then
  TARGET_BRANCH="$(sed -n 's/^[[:space:]]*target[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONFIG" | head -1)"
fi
if [ -n "$PIPELINE_PACKAGE" ] && [ "$ROLE" = "artisan" ] && [ -z "$TARGET_BRANCH" ]; then
  echo "dispatch_prepare: [branches] target not found in $CONFIG" >&2
  exit 2
fi
PIPELINE_TARGET_ARGS=()
[ -n "$TARGET_BRANCH" ] && PIPELINE_TARGET_ARGS+=(--target-branch "$TARGET_BRANCH")
case "$BASE" in
  */studio) ;;
  *) echo "dispatch_prepare: integration branch must end in /studio: $BASE" >&2; exit 2 ;;
esac

if [ -n "$PIPELINE_PACKAGE" ]; then
  [ -n "$BLUEPRINT" ] || { echo "dispatch_prepare: --pipeline-package requires --blueprint" >&2; exit 2; }
  bun "$(dirname "$0")/../driver/src/pipeline_packages.ts" render-assignment \
    --blueprint "$BLUEPRINT" --package "$PIPELINE_PACKAGE" --role "$ROLE" \
    --task-id 0 --agent-id "$ROLE(#0)" --pm-id "$PM" --slug "$SLUG" \
    "${PIPELINE_TARGET_ARGS[@]}" --base-branch "$BASE" --config "$CONFIG" >/dev/null || {
      echo "dispatch_prepare: invalid pipeline package $PIPELINE_PACKAGE for role $ROLE" >&2
      exit 1
    }
fi

# Design-review reachability trigger (W-067). A high-stakes design records its
# DEC-076 review verdict in a `## Review sign-off` footer (blueprint template).
# When a blueprint declares that footer but no canonical Verdict is filled in,
# warn (advisory, NON-blocking) that work is being dispatched from a design
# whose independent review is unrecorded. Trivial designs omit the footer and
# never trip this — deliberately NOT a gate on daily dispatch (non-mandatory).
if [ -n "$BLUEPRINT" ] && [ -f "$BLUEPRINT" ] \
   && grep -qE '^##[[:space:]]+Review sign-off[[:space:]]*$' "$BLUEPRINT" \
   && ! grep -qE '^[-*]?[[:space:]]*Verdict:[[:space:]]*(PASS|PASS_WITH_NOTES|REWORK_RECOMMENDED|BLOCK|NO_OPINION)\b' "$BLUEPRINT"; then
  echo "dispatch_prepare: WARNING — blueprint '$BLUEPRINT' declares a '## Review sign-off' footer (DEC-076 high-stakes) but records no design-review Verdict. Route it through Wanderer->Observer and fill the sign-off before dispatch (W-067). Proceeding (advisory)." >&2
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
# rm -rf (not rmdir) so recovery works whether or not the owner marker exists.
release_lock() { rm -rf "$LOCK" 2>/dev/null || true; }
tries=0
until mkdir "$LOCK" 2>/dev/null; do
  tries=$((tries + 1))
  # A SIGKILL/OOM between the mkdir and the release strands this bare-dir lock
  # (unlike lane.lock/external.lock it had no pid to check). Point the operator
  # at the marker + a concrete recovery command instead of a bare failure; the
  # doctor also flags a dead-pid next_id.lock (section 7d).
  [ "$tries" -lt 50 ] || {
    echo "dispatch_prepare: could not lock $LOCK after 5s" >&2
    echo "  if a prior run was killed the lock may be stranded; inspect $LOCK/owner," >&2
    echo "  and if its pid is not alive recover with: rm -rf \"$LOCK\"" >&2
    exit 1
  }
  sleep 0.1
done
# Owner marker (JSON so doctor's pid_from_file/json_string_field parse it) — lets
# the doctor and the operator tell a live claim from a crashed one.
printf '{"pid": %s, "ts": "%s", "kind": "next_id"}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK/owner" 2>/dev/null || true
trap 'release_lock' EXIT
[ -f "$IDFILE" ] || printf '1\n' > "$IDFILE"
ID="$(tr -cd '0-9' < "$IDFILE")"
[ -n "$ID" ] || { echo "dispatch_prepare: $IDFILE is not a number" >&2; exit 1; }
printf '%s\n' "$((ID + 1))" > "$IDFILE"
release_lock
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
  printf '<!-- Register-canonical (W-019): if the harness blocks writing this file, your compact\n'
  printf '     register message IS the canonical record - the PM transcribes it here at cleanup via\n'
  printf '     `dispatch_cleanup.sh --report-from-file <path>`. Do not stall completion on this write. -->\n\n'
  printf '## Status\n\n(REPORTING | BLOCKED)\n\n'
  printf '## Summary\n\n(what changed and why - compact; reference paths/SHAs, never paste diffs)\n\n'
  printf '## Gates\n\n(commands run + results)\n\n'
  printf '## Evidence\n\n(red->green proof, measurements, writer-audit conclusions)\n\n'
  printf '## Context pack gaps\n\n(facts you had to rediscover that the assignment/blueprint should have carried - exact paths, invariants, verify commands; "none" when the context pack sufficed - DEC-071)\n'
} > "$CONTAINER/report.md"

# Instruction ledger (W-092): the durable, append-only record of mid-flight PM
# instructions (scope changes) so a scope-expansion message can't cross the
# producer's completion register and be dropped unconsumed. Pre-created empty with
# the check-off convention in the header; the PM appends `- [ ] I<n> …` entries as
# scope changes, the producer checks each off (`- [x] … (consumed: <sha|register>)`)
# BEFORE REPORTING. contract_check --stall-scan flags a REPORTING dispatch that
# still has an unchecked entry (UNCONSUMED-INSTRUCTIONS).
{
  printf '# Instruction ledger - #%s %s\n\n' "$ID" "$SLUG"
  printf '<!-- W-092 - guards the "PM scope-change crosses the producer'"'"'s completion register" class.\n'
  printf '     PM: append ONE entry per added instruction (`- [ ] I<n> <one line> [-> pointer]`); never rewrite prior entries.\n'
  printf '     Producer: BEFORE REPORTING, check off EVERY entry -> `- [x] I<n> …` + append `(consumed: <sha|register>)`.\n'
  printf '     Do NOT reach REPORTING while any entry is `- [ ]`; state "ledger N/N consumed" in your register. -->\n\n'
  printf '(no instructions yet - the PM appends `- [ ] I<n> …` entries here as scope changes)\n'
} > "$CONTAINER/instructions.md"

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
[ -n "$IN_TOUCHES" ]   && CTX_ARGS+=(--touches "$IN_TOUCHES")
[ -n "$IN_DEPENDS" ]   && CTX_ARGS+=(--depends-on "$IN_DEPENDS")
[ "$FULL_GATE" -eq 1 ] && CTX_ARGS+=(--full-gate)
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
        --target-slug "$TARGET_SLUG" "${PIPELINE_TARGET_ARGS[@]}" \
        --slug "$SLUG" --branch "$BRANCH" \
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

# gate_agents (W-040): the attended PM hand-builds the Guardian/Observer
# Agent-tool `name` and verdict-marker `report` path per session
# (attended-gate-dispatch.md / workflow-naming.md §5) — mechanize it here so
# dispatch_prepare emits the same ga-guardian-<slug> / ga-observer-<slug>
# names and runtime/<role>/results/<slug>-<role>.md report paths verbatim.
# Same regex-safe sanitize + 64-char truncate as AGENT_NAME above. Read-only
# roles still get no worktree/container — this only emits name + path.
GUARDIAN_NAME="$(printf 'ga-guardian-%s' "$SLUG" | tr -c 'A-Za-z0-9_-' '-')"
case "$GUARDIAN_NAME" in
  [A-Za-z0-9]*) ;;
  *) GUARDIAN_NAME="a$GUARDIAN_NAME" ;;
esac
GUARDIAN_NAME="${GUARDIAN_NAME:0:64}"
OBSERVER_NAME="$(printf 'ga-observer-%s' "$SLUG" | tr -c 'A-Za-z0-9_-' '-')"
case "$OBSERVER_NAME" in
  [A-Za-z0-9]*) ;;
  *) OBSERVER_NAME="a$OBSERVER_NAME" ;;
esac
OBSERVER_NAME="${OBSERVER_NAME:0:64}"
GUARDIAN_REPORT="runtime/guardian/results/$SLUG-guardian.md"
OBSERVER_REPORT="runtime/observer/results/$SLUG-observer.md"
# The verdict-marker template (W-020): the canonical starting point the gate role
# copies so its `## Verdict` marker is a bare token the parser reads (fail-closed
# contract in the template header). Repo-relative so the PM pastes it verbatim into
# the gate request. context_pack.ts emits the identical literal (GATE_VERDICT_TEMPLATE).
GATE_VERDICT_TEMPLATE="skills/garelier-core/templates/gate_verdict.md"

# commit_template (W-051): a ready-to-copy commit skeleton whose `Garelier:` marker
# trailer is fully filled (pm_id, `<role>#<id>` actor, runtime task `#<id>` item id)
# so the producer copies the trailer VERBATIM instead of re-deriving the convention
# (the recurring per-role drift). The `<type>(<scope>): <summary>` subject stays a
# placeholder — only the producer knows the change type/scope/summary. `\n` are
# literal JSON escapes (no embedded double-quote → no further escaping needed);
# context_pack.ts emits the identical string into context.json. commit_convention.md.
COMMIT_TEMPLATE="$(printf '<type>(<scope>): <summary>  [#%s]\\n\\nGarelier: %s %s#%s #%s' "$ID" "$PM" "$ROLE" "$ID" "$ID")"

# bug_fix_discipline (W-052): a constant one-line pointer to the 4-phase
# debugging discipline shipped on EVERY dispatch (the runtime task carries no
# type, so this is not bug-gated — it is a no-op pointer for non-bug work). Same
# forward-supply route as commit_template; context_pack.ts BUG_FIX_DISCIPLINE
# emits the identical literal into context.json. No double-quote → JSON-safe.
BUG_FIX_DISCIPLINE="bug fix discipline: observe -> hypothesize -> verify -> fix the confirmed root cause only; reproduction test RED->GREEN first (instrumentation-log before/after when a test is impossible, e.g. visual/GPU); no guess fix / symptom-silencing guard / shotgun fix. Full rule: garelier-core/references/debugging_discipline.md (W-052)."

# conflict_check (W-053): when this dispatch declared --touches / --depends-on,
# intersect them against every OTHER active _dispatch*/context.json (excluding
# this just-created container by --self $ID) and emit the advisory result.
# Default (no declaration) is the empty-clean object so the output JSON key is
# always present and well-typed. The check is advisory — it prints a stderr
# warning (unless --allow-conflict) and lands under the `conflict_check` key, but
# never changes dispatch success. Best-effort: a bun/conflict_check failure
# leaves the empty-clean object.
CONFLICT_CHECK='{"touches":[],"depends_on":[],"conflicts":[],"unmet_deps":[],"warning":""}'
if [ -n "$IN_TOUCHES" ] || [ -n "$IN_DEPENDS" ]; then
  CC_ARGS=(check --pm-root "$PROJECT/__garelier/$PM" --self "$ID")
  [ -n "$IN_TOUCHES" ] && CC_ARGS+=(--touches "$IN_TOUCHES")
  [ -n "$IN_DEPENDS" ] && CC_ARGS+=(--depends-on "$IN_DEPENDS")
  if CC_JSON="$(bun "$(dirname "$0")/../driver/src/dispatch/conflict_check.ts" "${CC_ARGS[@]}" 2>/dev/null)" && [ -n "$CC_JSON" ]; then
    CONFLICT_CHECK="$CC_JSON"
    # Surface the single-line, quote-free warning to stderr unless silenced.
    CC_WARNING="$(printf '%s' "$CC_JSON" | sed -n 's/.*"warning":"\([^"]*\)".*/\1/p')"
    if [ -n "$CC_WARNING" ] && [ "$ALLOW_CONFLICT" -ne 1 ]; then
      echo "dispatch_prepare: [conflict_check] $CC_WARNING" >&2
    fi
  else
    echo "dispatch_prepare: conflict_check best-effort skipped (bun/conflict_check unavailable)" >&2
  fi
fi

# watch_cmd (W-085): a ready-to-run one-liner that arms dispatch_watch.sh on THIS
# dispatch (single mode). The attended PM/operator runs it with run_in_background
# IMMEDIATELY AFTER spawning the producer, so the reactive stall/RUNAWAY backstop is
# armed without hand-building the args — the recurring omission that let a fleet of
# producers go dormant overnight when a watch was simply never armed (2026-07-06).
# Paths are double-quoted (a path with spaces survives) and the embedded quotes are
# JSON-escaped for the output string. The detective twin is contract_check.ts
# --stall-scan, which reports a WORKING dispatch with no live watch heartbeat as
# UNWATCHED. Additive key; existing consumers picking only {id,container,...} ignore it.
WATCH_SCRIPT="$(cd "$(dirname "$0")" && pwd)/dispatch_watch.sh"
WATCH_CMD="bash \"$WATCH_SCRIPT\" --project \"$PROJECT\" --pm-id $PM --id $ID --target-root \"$GIT_ROOT\""
WATCH_CMD_JSON="${WATCH_CMD//\"/\\\"}"

# prompt_preamble (W-095): the fixed boilerplate the PM otherwise hand-writes into
# every producer prompt — a write-error class (a dropped base-track note, a wrong
# commit trailer, a forgotten register/ledger rule). dispatch_prepare fills THIS
# dispatch's concrete values (checkout, branch, id) and ships the constant rules,
# so the PM's prompt is just this preamble + the task body. The commit trailer keeps
# a {{TASK_ID}} placeholder — only the PM knows the bound backlog item id. Emitted as
# a JSON string (newlines/quotes escaped); additive key, existing consumers ignore it.
PROMPT_PREAMBLE="$(cat <<PREAMBLE_EOF
You are the Garelier $ROLE for dispatch #$ID ($SLUG).
- Work ONLY inside your checkout worktree: $CONTAINER/checkout - never edit the parent repo / primary checkout.
- Branch: $BRANCH. At pickup, base-track FIRST: merge the studio tip into your branch (merge, never rebase) and resolve any conflicts yourself before implementing.
- Commit: the subject ends with [#$ID]; end the message with a blank line then this trailer VERBATIM, replacing {{TASK_ID}} with the bound backlog id (e.g. W-123):
    Garelier: $PM $ROLE#$ID {{TASK_ID}}
  Explain WHY the change is needed; never paste diffs.
- Instruction ledger (W-092): before REPORTING, open instructions.md and check off EVERY entry ("- [ ]" -> "- [x] ... (consumed: <sha|register>)"); do NOT reach REPORTING while any entry is unchecked. State "ledger N/N consumed" in your register.
- Register-terminate (W-085): your LAST turn MUST end with the compact register message (final STATE, branch + commit SHA, report path, gate result, any BLOCKED question) - a commit/STATE update alone is not a completion signal.
- Heavy discipline: run a long gate (compile/test/headless) as ONE chained script under run_in_background - the completion notification auto-resumes you; NEVER end a turn on a foreground long-run (the harness kills it at the timeout ceiling and the turn falls silent). A heavy full-workspace compile still serializes via the operator's heavy_compile_lock; send ONE interim progress message during a long build.
- Runtime recovery: the final line of every subagent final output MUST be exactly one `GARELIER_RUNTIME_STATUS: {"runtime_ok": true|false, ...}` marker.
- After a timeout, do not immediately re-run the same command; inspect the incident/log first and change the execution plan (scope, log file, or background watch).
- End EVERY turn one of two ways: (a) the compact register, or (b) a progress message WITH a background job still running. Falling silent at a milestone (commit, compile start, report) is a stall and a violation.
- Do NOT push any branch; the operator integrates it through the merge gate.
PREAMBLE_EOF
)"
# JSON-escape (backslash, then double-quote, then newline) for the output string.
_pp="$PROMPT_PREAMBLE"; _pp="${_pp//\\/\\\\}"; _pp="${_pp//\"/\\\"}"; _pp="${_pp//$'\n'/\\n}"
PROMPT_PREAMBLE_JSON="$_pp"

# model/effort/model_source (W-026): the resolved routing decision, empty when
# inherit (jig/attended launcher passes them to the Agent/Workflow spawn — the
# attended Agent tool honors `model` only; `effort` needs the jig/Workflow path).
# `model` is already clamped to the PM ceiling (deny/ask), so an unattended spawn
# is safe; needs_confirmation + suggested_model let an attended PM escalate only
# after user confirmation (above_pm=ask).
# `conflict_check` (W-053) is spliced raw (already a valid JSON object).
# `watch_cmd` (W-085) is the ready-to-run dispatch_watch one-liner for THIS dispatch.
# `prompt_preamble` (W-095) is the fixed producer-prompt boilerplate for THIS dispatch.
printf '{"id":%s,"container":"%s","checkout":"%s","branch":"%s","base_sha":"%s","target_root":"%s","context":"%s","pickup_pack":"%s","label":"produce:%s","name":"%s(#%s)","agent_name":"%s","model":"%s","effort":"%s","model_source":"%s","suggested_model":"%s","needs_confirmation":%s,"commit_template":"%s","bug_fix_discipline":"%s","watch_cmd":"%s","prompt_preamble":"%s","conflict_check":%s,"gate_agents":{"guardian":{"name":"%s","report":"%s","verdict_template":"%s"},"observer":{"name":"%s","report":"%s","verdict_template":"%s"}}}\n' \
  "$ID" "$CONTAINER" "$CONTAINER/checkout" "$BRANCH" "$BASE_SHA" "$GIT_ROOT" "$CONTEXT" "$PICKUP" "$SLUG" "$ROLE" "$ID" "$AGENT_NAME" "$MODEL" "$EFFORT" "$MODEL_SOURCE" "$SUGGESTED_MODEL" "$NEEDS_CONFIRMATION" "$COMMIT_TEMPLATE" "$BUG_FIX_DISCIPLINE" "$WATCH_CMD_JSON" "$PROMPT_PREAMBLE_JSON" "$CONFLICT_CHECK" \
  "$GUARDIAN_NAME" "$GUARDIAN_REPORT" "$GATE_VERDICT_TEMPLATE" "$OBSERVER_NAME" "$OBSERVER_REPORT" "$GATE_VERDICT_TEMPLATE"
