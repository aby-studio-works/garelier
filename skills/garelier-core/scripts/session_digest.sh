#!/usr/bin/env bash
#
# Garelier session digest (bash). A compact, DETERMINISTIC status summary
# meant to run from a Claude Code SessionStart hook when a human opens an
# interactive PM/Dock session (dispatch-only, DEC-061/066).
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

# --- live dispatch producers (DEC-063 ephemeral _dispatch<N> homes) ---
live=0
for d in "$PM_ROOT"/_dispatch*/; do
    [ -f "${d}STATE.md" ] && live=$((live + 1))
done

# --- merge gate ---
gate="idle"
[ -f "$RUNTIME/merge_gate/locks/active.lock" ] && gate="RUNNING"
mg_pending=0
[ -d "$RUNTIME/merge_gate/requests" ] && mg_pending=$(find "$RUNTIME/merge_gate/requests" -maxdepth 1 -name '*.json' ! -name '*.summary.json' 2>/dev/null | wc -l | tr -d ' ')

# --- counts ---
count_files() { [ -d "$1" ] && find "$1" -maxdepth 1 -type f ! -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ' || echo 0; }
count_merge_results() { [ -d "$1" ] && find "$1" -maxdepth 1 -type f -name '*.json' ! -name '*.summary.json' 2>/dev/null | wc -l | tr -d ' ' || echo 0; }
pm_inbox="$(count_files "$RUNTIME/pm/inbox")"
orch_inbox="$(count_files "$RUNTIME/dock/inbox")"
mg_results="$(count_merge_results "$RUNTIME/merge_gate/results")"
obs_results="$(count_files "$RUNTIME/observer/results")"

# --- doctor summary (best-effort; never blocks) ---
doctor_summary=""
DOCTOR="$(dirname "$0")/doctor.sh"
if [ -f "$DOCTOR" ]; then
    doctor_summary="$(bash "$DOCTOR" --pm-id "$PM_ID" --project "$PROJECT_ROOT" 2>/dev/null | grep -E '^Summary:' | head -1 | sed 's/^Summary: //')"
fi

echo "── Garelier · PM ${PM_ID} ──────────────────────────────"
echo "  lane: ${lane}    gate: ${gate} (pending ${mg_pending})    live dispatch: ${live}"
echo "  inbox: pm ${pm_inbox} / dock ${orch_inbox}    results: merge-gate ${mg_results} / observer ${obs_results}"
[ -n "$doctor_summary" ] && echo "  doctor: ${doctor_summary}"
echo "  detail: garelier status --pm-id ${PM_ID} --project \"${PROJECT_ROOT}\"  |  doctor.sh --pm-id ${PM_ID}"
exit 0
