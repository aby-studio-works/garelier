#!/usr/bin/env bash
#
# Garelier Status (bash) — dispatch-native (DEC-066).
#
# Human-readable snapshot of what is REAL under dispatch-only:
#   - lane.lock (artisan/dock arbitration)
#   - merge gate (active.lock, pending requests, latest result)
#   - backlog (pending rows / done count / next id)
#   - LIVE ephemeral producers (__garelier/<pm>/_dispatch<N>/STATE.md)
#   - parked inventory (any non-IDLE STATE.md in legacy role containers)
#   - the last dispatch events (runtime/dispatch/events.jsonl)
#   - the Status Web pidfile (URL when running)
#
# No driver pids, no leases, no usage logs — those were deleted with the
# headless driver (DEC-066). For the full picture use the Status Web.
#
# Usage: status.sh [--pm-id <id>] [--project <path>] [--watch <seconds>]
set -u

PROJECT_ROOT="$(pwd)" PM_ID="" WATCH=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project|-p) PROJECT_ROOT="${2:?}"; shift 2 ;;
    --pm-id)      PM_ID="${2:?}"; shift 2 ;;
    --watch)      WATCH="${2:?}"; shift 2 ;;
    -h|--help)    sed -n '2,17p' "$0"; exit 0 ;;
    *) PM_ID="$1"; shift ;;
  esac
done
GARELIER_ROOT="$PROJECT_ROOT/__garelier"

discover_pms() {
  [ -d "$GARELIER_ROOT" ] || return 0
  for d in "$GARELIER_ROOT"/*/; do
    [ -f "${d}_pm/setup_config.toml" ] && basename "$d"
  done
}

toml_val() { # file key → first key = "value"
  sed -n 's/^[[:space:]]*'"$2"'[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$1" 2>/dev/null | head -1
}

state_of() { # STATE.md → status word (first non-blank line under "## Status")
  awk '/^##[[:space:]]*Status/{f=1;next} f && NF {gsub(/[[:space:]]/,""); print; exit}' "$1" 2>/dev/null
}

task_of() { # STATE.md → first non-blank line under "## Current task"
  awk '/^##[[:space:]]*Current task/{f=1;next} f && NF {print; exit}' "$1" 2>/dev/null | cut -c1-100
}

print_pm() {
  local pm="$1" base cfg
  base="$GARELIER_ROOT/$pm"
  cfg="$base/_pm/setup_config.toml"
  echo "--- PM: $pm ---"
  if [ -f "$cfg" ]; then
    echo "  target:  $(toml_val "$cfg" target)"
    echo "  studio:  $(toml_val "$cfg" integration)"
  fi

  local lane="$base/runtime/lane.lock"
  if [ -f "$lane" ]; then
    echo "  lane:    $(tr -d '\n' < "$lane" | cut -c1-120)"
  else
    echo "  lane:    dock (default; no lane.lock)"
  fi

  local mg="$base/runtime/merge_gate"
  local act="$mg/locks/active.lock"
  local pend=0
  [ -d "$mg/requests" ] && pend=$(find "$mg/requests" -name '*.json' ! -name '*.summary.json' 2>/dev/null | wc -l | tr -d ' ')
  if [ -f "$act" ]; then
    echo "  gate:    RUNNING ($(tr -d '\n' < "$act" | cut -c1-100)) | pending=$pend"
  else
    local last
    last=$(ls -t "$mg/results/"*.json 2>/dev/null | grep -v summary | head -1)
    if [ -n "${last:-}" ]; then
      local st
      st=$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$last" | head -1)
      echo "  gate:    idle | last=$st ($(basename "$last")) | pending=$pend"
    else
      echo "  gate:    idle | pending=$pend"
    fi
  fi

  local bl="$base/runtime/backlog"
  if [ -d "$bl" ]; then
    local pn=0 dn=0 nid="-"
    [ -f "$bl/pending.md" ] && pn=$(grep -c '^|[[:space:]]*[0-9#]' "$bl/pending.md" 2>/dev/null || true)
    [ -d "$bl/done" ] && dn=$(find "$bl/done" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
    [ -f "$bl/next_id" ] && nid=$(tr -cd '0-9' < "$bl/next_id")
    echo "  backlog: pending=${pn:-0} done=$dn next_id=#$nid"
  fi

  # Plan-layer signal (DEC-070): open dashboard rows + the oldest open item's
  # first-commit age. Stagnation surfaces as a growing age, not a hidden queue.
  local db="$base/control/project_dashboard/backlog.md"
  if [ -f "$db" ]; then
    local rows hi oldest age=""
    rows=$(grep -cE '^\|[[:space:]]*W-[0-9]' "$db" 2>/dev/null || true)
    hi=$(grep -cE '^\|[[:space:]]*W-[0-9]+[[:space:]]*\|[^|]*\|[[:space:]]*(critical|high)[[:space:]]*\|' "$db" 2>/dev/null || true)
    oldest=$(grep -oE '^\|[[:space:]]*W-[0-9]+' "$db" 2>/dev/null | grep -oE 'W-[0-9]+' | sort -t- -k2 -n | head -1)
    if [ -n "$oldest" ]; then
      local ts
      ts=$(git -C "$PROJECT_ROOT" log --reverse --format=%ct -S "$oldest" -- \
        "__garelier/$pm/control/project_dashboard/backlog.md" 2>/dev/null | head -1)
      [ -n "$ts" ] && age=" oldest=$oldest (~$(( ($(date +%s) - ts) / 86400 ))d)"
    fi
    echo "  plan:    open=${rows:-0} high/critical=${hi:-0}$age"
  fi

  local found=0 d
  for d in "$base"/_dispatch*/; do
    [ -f "${d}STATE.md" ] || continue
    found=1
    echo "  LIVE:    $(basename "$d") $(state_of "${d}STATE.md") - $(task_of "${d}STATE.md")"
  done
  [ "$found" -eq 0 ] && echo "  LIVE:    none (producers exist only while a task executes)"

  local parked=0 st
  for d in "$base"/_workers/*/ "$base"/_scouts/*/ "$base"/_smiths/*/ "$base"/_librarians/*/ \
           "$base"/_observers/*/ "$base"/_guardians/*/ "$base"/_concierges/*/ "$base"/_artisan/; do
    [ -f "${d}STATE.md" ] || continue
    st=$(state_of "${d}STATE.md")
    case "$st" in IDLE|idle|"") continue ;; esac
    parked=1
    echo "  PARKED:  ${d#"$base"/} $st - $(task_of "${d}STATE.md")"
  done
  [ "$parked" -eq 0 ] && echo "  PARKED:  none"

  local ev="$base/runtime/dispatch/events.jsonl"
  if [ -f "$ev" ]; then
    echo "  recent events:"
    tail -5 "$ev" | sed -n 's/.*"kind":"\([a-z]*\)".*"task":"\([^"]\{1,90\}\)[^"]*".*/    [\1] \2/p'
  fi

  local swf="$base/runtime/status_web/status_web.json"
  if [ -f "$swf" ]; then
    echo "  status web: $(sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$swf" | head -1)"
  fi
}

print_status() {
  echo "=== Garelier Status - $(date -u +"%Y-%m-%dT%H:%M:%SZ") (dispatch-only) ==="
  echo "Root: $PROJECT_ROOT"
  local pms=() p
  if [ -n "$PM_ID" ]; then pms=("$PM_ID"); else
    while IFS= read -r p; do [ -n "$p" ] && pms+=("$p"); done < <(discover_pms)
  fi
  if [ "${#pms[@]}" -eq 0 ]; then
    echo "No Garelier PMs found under $GARELIER_ROOT. Run setup_wizard to initialize a PM."
    return
  fi
  local pm
  for pm in "${pms[@]}"; do echo ""; print_pm "$pm"; done
}

if [ -n "$WATCH" ]; then
  case "$WATCH" in ''|*[!0-9]*) echo "Error: --watch requires a positive integer" >&2; exit 1 ;; esac
  while true; do clear; print_status; sleep "$WATCH"; done
else
  print_status
fi
