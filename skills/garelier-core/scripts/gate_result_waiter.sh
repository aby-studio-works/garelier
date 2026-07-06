#!/usr/bin/env bash
#
# gate_result_waiter.sh — attended push notification for a merge-gate result (W-079).
#
# The merge gate runs async: merge_request.sh enqueues a request and the gate
# subprocess later writes runtime/merge_gate/results/<request_id>.json (status
# success | failed | conflict | aborted). In DRIVER mode the driver's poll loop
# picks that result up and drives Dock; in ATTENDED mode (no driver, PM turns
# SendMessage/Agent by hand — pm_playbook.md) NOTHING watches results/, so a gate
# that finishes (or fails on a conflict) sits unnoticed until the PM happens to
# look. Real incident 2026-07-05: a conflict-failed gate sat 1h+ before the user
# flagged it.
#
# This is the lightweight, opt-in event bridge (same shape as the driver watchdog
# but for one request): run it in the background right after merge_request.sh and
# it cheaply polls for THIS request's terminal result, then echoes a one-line
# `MERGE_RESULT:` and exits with a status-derived code. Because the Claude Code
# harness re-wakes the main session when a `run_in_background` task completes, the
# PM is pushed the outcome instead of having to poll.
#
# It ONLY watches its own request_id's result file. It never polls the gate, never
# takes the active lock, and never advances the queue — the merge gate self-drains
# its own queue on completion (W-039), so a waiter must not (and does not) touch
# that machinery. Safe to run zero, one, or many in parallel (one per request).
#
# Usage:
#   gate_result_waiter.sh --project <control-root> --pm-id <id> --request-id <id>
#                         [--max-wait <seconds>] [--poll-interval <seconds>]
#
#   --request-id     the REQ_ID merge_request.sh printed (its request file stem).
#   --max-wait       seconds to wait before giving up. Default: the gate's own
#                    wall-clock ceiling + a margin, so the waiter outlives a
#                    healthy long gate and only times out when the gate itself has
#                    gone rogue. Resolution order: this flag → [merge_gate]
#                    gate_ceiling_minutes in setup_config × 60 + margin → a
#                    built-in worst-case default.
#   --poll-interval  seconds between existence checks (lean I/O). Default 30.
#
# Output (stdout, one line):
#   terminal → MERGE_RESULT: <status> <request_id> <studio_commit|failure_reason>
#   timeout  → MERGE_TIMEOUT: <request_id> waited <N>s (no terminal result)
#
# Exit code:
#   0    status == success   (merge landed)
#   1    status in {failed, conflict, aborted}  (needs attention)
#   124  timed out waiting    (idiomatic timeout code; check active.lock/results)
#   2    usage / precondition error
set -uo pipefail

# Gate ceiling fallback (mirrors merge_gate.ts): a healthy gate can, worst case,
# run several quality-gate commands each under a ~120-min per-command budget, so
# the waiter's last-resort ceiling is generous — it is NOT a tight per-command
# limit (that is merge-gate.sh's job). PM overrides with --max-wait for short gates.
DEFAULT_CEILING_MINUTES=240
CEILING_MARGIN_SECONDS=900   # 15 min, mirrors merge_gate.ts DEFAULT_GATE_CEILING_MARGIN_MS
DEFAULT_POLL_INTERVAL=30

PROJECT="" PM="" REQUEST_ID="" MAX_WAIT="" POLL_INTERVAL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project)       PROJECT="${2:?}"; shift 2 ;;
    --pm-id)         PM="${2:?}"; shift 2 ;;
    --request-id)    REQUEST_ID="${2:?}"; shift 2 ;;
    --max-wait)      MAX_WAIT="${2:?}"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="${2:?}"; shift 2 ;;
    -h|--help)       sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "gate_result_waiter: unknown arg: $1" >&2
       echo "gate_result_waiter: valid flags: --project --pm-id --request-id --max-wait --poll-interval -h/--help" >&2
       exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] && [ -n "$REQUEST_ID" ] || {
  echo "gate_result_waiter: --project, --pm-id, --request-id are required" >&2; exit 2; }

# The merge-gate request/result tree is ALWAYS under the control root (--project),
# never the git target-root — mergeGatePaths()/merge_request.sh both anchor it here.
RESULTS_DIR="$PROJECT/__garelier/$PM/runtime/merge_gate/results"
RESULT_FILE="$RESULTS_DIR/$REQUEST_ID.json"
CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"

# --- Resolve max-wait (seconds) ------------------------------------------------
# First value in a [section] matching a key, stripped of quotes/comment. Mirrors
# merge_request.sh's toml_in_section so bash reads one scalar without a TOML lib.
toml_in_section() {  # file section key -> first matching value, else empty
  [ -f "$1" ] || return 0
  awk -v section="$2" -v key="$3" '
    /^[[:space:]]*\[[^]]*\][[:space:]]*$/ { s=$0; gsub(/^[[:space:]]*\[|\][[:space:]]*$/,"",s); cur=s; next }
    cur==section && $0 ~ "^[[:space:]]*"key"[[:space:]]*=" {
      v=$0; sub(/^[^=]*=[[:space:]]*/,"",v); sub(/[[:space:]]*#.*$/,"",v); gsub(/[[:space:]"]+/,"",v); print v; exit }
  ' "$1"
}
is_pos_int() { case "$1" in ''|*[!0-9]*) return 1 ;; *) [ "$1" -gt 0 ] ;; esac; }

if [ -z "$MAX_WAIT" ]; then
  ceiling_min="$(toml_in_section "$CONFIG" merge_gate gate_ceiling_minutes)"
  is_pos_int "$ceiling_min" || ceiling_min="$DEFAULT_CEILING_MINUTES"
  MAX_WAIT=$(( ceiling_min * 60 + CEILING_MARGIN_SECONDS ))
fi
[ -z "$POLL_INTERVAL" ] && POLL_INTERVAL="$DEFAULT_POLL_INTERVAL"
is_pos_int "$MAX_WAIT" || { echo "gate_result_waiter: --max-wait must be a positive integer (seconds)" >&2; exit 2; }
is_pos_int "$POLL_INTERVAL" || { echo "gate_result_waiter: --poll-interval must be a positive integer (seconds)" >&2; exit 2; }

# --- Extract a top-level JSON string field from the (pretty-printed) result ----
# merge-gate.sh writes one `"key": value` per line and json-escapes newlines, so a
# per-line regex is sufficient. Returns empty for a null / absent field.
json_str_field() {  # file key -> string value (empty if null/absent)
  sed -n "s/^[[:space:]]*\"$2\"[[:space:]]*:[[:space:]]*\"\(.*\)\".*/\1/p" "$1" | head -1
}

# --- Poll ---------------------------------------------------------------------
elapsed=0
while :; do
  if [ -f "$RESULT_FILE" ]; then
    status="$(json_str_field "$RESULT_FILE" status)"
    # Defensive: an existing-but-empty status means we caught a torn read (should
    # not happen with the gate's atomic .tmp+rename); keep polling rather than
    # reporting a bogus result.
    if [ -n "$status" ]; then
      if [ "$status" = "success" ]; then
        detail="$(json_str_field "$RESULT_FILE" studio_commit)"
        echo "MERGE_RESULT: success $REQUEST_ID ${detail:-(no studio_commit)}"
        exit 0
      fi
      detail="$(json_str_field "$RESULT_FILE" failure_reason)"
      echo "MERGE_RESULT: $status $REQUEST_ID ${detail:-(no failure_reason)}"
      exit 1
    fi
  fi
  # Stop when the NEXT sleep would run past the ceiling — bounded total wait.
  [ "$elapsed" -ge "$MAX_WAIT" ] && break
  remaining=$(( MAX_WAIT - elapsed ))
  step=$POLL_INTERVAL
  [ "$step" -gt "$remaining" ] && step=$remaining
  sleep "$step"
  elapsed=$(( elapsed + step ))
done

echo "MERGE_TIMEOUT: $REQUEST_ID waited ${MAX_WAIT}s (no terminal result; check runtime/merge_gate/locks/active.lock and results/$REQUEST_ID.json)"
exit 124
