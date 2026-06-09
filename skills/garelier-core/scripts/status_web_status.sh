#!/usr/bin/env bash
#
# Report whether the Garelier Status Web Console is running for a PM, and at
# what URL. Reads the pidfile (runtime/status_web/status_web.json) the console
# wrote on launch. Read-only.
#
# Usage: status_web_status.sh [--pm-id <id>] [--project <path>] [<pm_id>]

set -euo pipefail

# Windows pidfile holds the native Windows PID; MSYS `kill -0` can't see it.
is_windows() { case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }
pid_alive() {
    if is_windows; then tasklist //FI "PID eq $1" 2>/dev/null | grep -qw "$1"
    else kill -0 "$1" 2>/dev/null; fi
}

PROJECT_ROOT=""
PM_ID=""

while [ $# -gt 0 ]; do
    case "$1" in
        --pm-id)   PM_ID="${2:?missing --pm-id value}"; shift 2 ;;
        --project) PROJECT_ROOT="${2:?missing --project value}"; shift 2 ;;
        -h|--help) echo "Usage: status_web_status.sh [--pm-id <id>] [--project <path>] [<pm_id>]"; exit 0 ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1" >&2; exit 1 ;;
        *)
            if [ -z "$PM_ID" ]; then PM_ID="$1"
            elif [ -z "$PROJECT_ROOT" ]; then PROJECT_ROOT="$1"
            else echo "Unexpected positional argument: $1" >&2; exit 1; fi
            shift ;;
    esac
done

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd -P)}"
GARELIER_ROOT="$PROJECT_ROOT/__garelier"

if [ ! -d "$GARELIER_ROOT" ]; then
    echo "Error: not a Garelier project root: $PROJECT_ROOT" >&2; exit 1
fi

if [ -z "$PM_ID" ]; then
    pm_candidates=()
    for d in "$GARELIER_ROOT"/*/; do
        [ -d "$d" ] || continue
        if [ -f "$d/_pm/setup_config.toml" ] || [ -f "$d/control/control.toml" ]; then
            pm_candidates+=("$(basename "$d")")
        fi
    done
    case "${#pm_candidates[@]}" in
        0) echo "Error: no Garelier control namespace under $GARELIER_ROOT." >&2; exit 1 ;;
        1) PM_ID="${pm_candidates[0]}" ;;
        *) echo "Error: multiple PMs found — pass --pm-id <id>." >&2
           for p in "${pm_candidates[@]}"; do echo "         - $p" >&2; done; exit 1 ;;
    esac
fi

PID_FILE="$GARELIER_ROOT/$PM_ID/runtime/status_web/status_web.json"

if [ ! -f "$PID_FILE" ]; then
    echo "Status console for PM '$PM_ID': DOWN (no pidfile)."
    exit 1
fi

pid="$(grep -oE '"pid":[[:space:]]*[0-9]+' "$PID_FILE" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
url="$(grep -oE '"url":[[:space:]]*"[^"]+"' "$PID_FILE" 2>/dev/null | sed -E 's/.*"url":[[:space:]]*"([^"]+)".*/\1/')"

if [ -n "$pid" ] && pid_alive "$pid"; then
    echo "Status console for PM '$PM_ID': UP (pid $pid)."
    [ -n "$url" ] && echo "  URL: $url"
    exit 0
else
    echo "Status console for PM '$PM_ID': DOWN (stale pidfile, pid ${pid:-?} not alive)."
    exit 1
fi
