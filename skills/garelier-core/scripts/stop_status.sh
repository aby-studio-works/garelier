#!/usr/bin/env bash
#
# Stop the Garelier Status Web Console for a PM. Reads the pidfile
# (runtime/status_web/status_web.json) the console wrote on launch, signals
# the process, and removes the pidfile. Read-only console → a plain TERM is
# safe (no state to flush).
#
# Usage: stop_status.sh [--pm-id <id>] [--project <path>] [<pm_id>]

set -euo pipefail

# The pidfile records process.pid, which on Windows is the native Windows PID.
# MSYS/Git-Bash `kill` operates on MSYS PIDs, so on Windows we must check/kill
# via tasklist/taskkill (// = MSYS-escaped / so the flags aren't path-mangled).
is_windows() { case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }
pid_alive() {
    if is_windows; then tasklist //FI "PID eq $1" 2>/dev/null | grep -qw "$1"
    else kill -0 "$1" 2>/dev/null; fi
}
pid_term() {
    if is_windows; then taskkill //PID "$1" //T //F >/dev/null 2>&1 || true
    else kill "$1" 2>/dev/null || true; fi
}
pid_kill9() {
    if is_windows; then taskkill //PID "$1" //T //F >/dev/null 2>&1 || true
    else kill -9 "$1" 2>/dev/null || true; fi
}

PROJECT_ROOT=""
PM_ID=""

usage() {
    cat <<'EOF'
Usage: stop_status.sh [--pm-id <id>] [--project <path>] [<pm_id>]

Options:
  --pm-id <id>       PM whose console to stop (auto-detected if exactly one).
  --project <path>   Project root (default: current directory).
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --pm-id)   PM_ID="${2:?missing --pm-id value}"; shift 2 ;;
        --project) PROJECT_ROOT="${2:?missing --project value}"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
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
    echo "No status console pidfile for PM '$PM_ID' — not running. Nothing to stop."
    exit 0
fi

pid="$(grep -oE '"pid":[[:space:]]*[0-9]+' "$PID_FILE" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
if [ -z "$pid" ]; then
    echo "Pidfile present but no pid parsed; removing stale $PID_FILE."
    rm -f "$PID_FILE"; exit 0
fi

if ! pid_alive "$pid"; then
    echo "Status console (pid $pid) is not alive; removing stale pidfile."
    rm -f "$PID_FILE"; exit 0
fi

pid_term "$pid"
# Wait briefly for graceful exit, then escalate.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    pid_alive "$pid" || break
    sleep 0.3
done
if pid_alive "$pid"; then
    pid_kill9 "$pid"
    sleep 0.3
fi
rm -f "$PID_FILE"
echo "Status console stopped for PM '$PM_ID' (pid $pid)."
