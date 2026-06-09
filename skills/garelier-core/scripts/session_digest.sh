#!/usr/bin/env bash
#
# Garelier session digest (bash). A compact, DETERMINISTIC status summary
# meant to run from a Claude Code SessionStart hook when a human opens an
# interactive PM session (hybrid / manual mode).
#
# Why: it replaces "AI, summarize the current state" — a full token-spending
# model turn that reads runtime files — with a few printed lines produced by
# plain shell. No provider call, no tokens. It NEVER fails the session
# (always exits 0) and only reads files.
#
# pm_id / project root are inferred from the cwd (the hook runs in
# __garelier/<pm_id>/_pm/); --pm-id / --project override.

set -uo pipefail

PM_ID=""
PROJECT_ROOT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --pm-id)   PM_ID="${2:-}"; shift 2 ;;
        --project) PROJECT_ROOT="${2:-}"; shift 2 ;;
        *) shift ;;
    esac
done

CWD="$(pwd -P)"
if [ -z "$PM_ID" ] && [ "$(basename "$CWD")" = "_pm" ]; then
    PM_ID="$(basename "$(dirname "$CWD")")"
fi
if [ -z "$PROJECT_ROOT" ]; then
    cur="$CWD"
    while [ "$cur" != "/" ] && [ -n "$cur" ]; do
        if [ -d "$cur/__garelier" ]; then PROJECT_ROOT="$cur"; break; fi
        parent="$(dirname "$cur")"; [ "$parent" = "$cur" ] && break; cur="$parent"
    done
fi
# Can't infer context → stay silent (never disturb the session).
if [ -z "$PROJECT_ROOT" ] || [ -z "$PM_ID" ]; then exit 0; fi
PM_ROOT="$PROJECT_ROOT/__garelier/$PM_ID"
[ -d "$PM_ROOT" ] || exit 0
RUNTIME="$PM_ROOT/runtime"

# --- lane ---
lane="idle/dock"
if [ -f "$RUNTIME/lane.lock" ]; then
    l="$(grep -oE '"lane"[[:space:]]*:[[:space:]]*"[^"]*"' "$RUNTIME/lane.lock" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
    lane="${l:-held}"
fi

# --- driver ---
driver="stopped"
dpid_file="$RUNTIME/driver/driver.pid"
if [ -f "$dpid_file" ]; then
    pid="$(tr -dc '0-9' < "$dpid_file" 2>/dev/null)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then driver="running (pid $pid)"; else driver="stopped (stale pid)"; fi
fi

# --- counts ---
count_files() { [ -d "$1" ] && find "$1" -maxdepth 1 -type f ! -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ' || echo 0; }
count_merge_results() { [ -d "$1" ] && find "$1" -maxdepth 1 -type f -name '*.json' ! -name '*.summary.json' 2>/dev/null | wc -l | tr -d ' ' || echo 0; }
pm_inbox="$(count_files "$RUNTIME/pm/inbox")"
orch_inbox="$(count_files "$RUNTIME/dock/inbox")"
mg_results="$(count_merge_results "$RUNTIME/merge_gate/results")"
obs_results="$(count_files "$RUNTIME/observer/results")"

# --- stale detached leases ---
stale=0
if [ -d "$RUNTIME/driver/pids" ]; then
    for f in "$RUNTIME/driver/pids"/*.pid; do
        [ -f "$f" ] || continue
        p="$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$f" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
        st="$(grep -oE '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$f" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
        if [ -n "$p" ] && ! kill -0 "$p" 2>/dev/null && [ "$st" != "finished" ]; then stale=$((stale + 1)); fi
    done
fi

# --- doctor summary (best-effort; never blocks) ---
doctor_summary=""
DOCTOR="$(dirname "$0")/doctor.sh"
if [ -f "$DOCTOR" ]; then
    doctor_summary="$(bash "$DOCTOR" --pm-id "$PM_ID" --project "$PROJECT_ROOT" 2>/dev/null | grep -E '^Summary:' | head -1 | sed 's/^Summary: //')"
fi

echo "── Garelier · PM ${PM_ID} ──────────────────────────────"
echo "  lane: ${lane}    driver: ${driver}"
echo "  inbox: pm ${pm_inbox} / dock ${orch_inbox}    results: merge-gate ${mg_results} / observer ${obs_results}    stale leases: ${stale}"
[ -n "$doctor_summary" ] && echo "  doctor: ${doctor_summary}"
echo "  detail: status.sh --pm-id ${PM_ID} --project \"${PROJECT_ROOT}\"  |  doctor.sh --pm-id ${PM_ID}"
exit 0
