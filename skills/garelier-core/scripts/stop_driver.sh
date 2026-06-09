#!/usr/bin/env bash
#
# Stop the Garelier driver gracefully by writing the stop file.
#
# v2.1: pm-id aware. Each PM has its own driver. Auto-detects pm_id when
# exactly one PM is initialized under __garelier/.
#
# Usage: stop_driver.sh [--pm-id <id>] [--project <path>]
#                       [--wait] [--timeout <seconds>] [<pm_id>]

set -euo pipefail

WAIT="false"
TIMEOUT="180"
PROJECT_ROOT=""
PM_ID=""

usage() {
    cat <<'EOF'
Usage: stop_driver.sh [--pm-id <id>] [--project <path>] [--wait] [--timeout <seconds>] [<pm_id>]

Options:
  --pm-id <id>          PM whose driver to stop. Required when more than
                        one PM exists under __garelier/.
  --project <path>      Project root (default: current directory).
  --wait                Poll until the driver actually exits.
  --timeout <seconds>   Max wait time with --wait. Default 180.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --pm-id)   PM_ID="${2:?missing --pm-id value}"; shift 2 ;;
        --project) PROJECT_ROOT="${2:?missing --project value}"; shift 2 ;;
        --wait)    WAIT="true"; shift ;;
        --timeout) TIMEOUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
        *)
            if [ -z "$PM_ID" ]; then
                PM_ID="$1"
            elif [ -z "$PROJECT_ROOT" ]; then
                PROJECT_ROOT="$1"
            else
                echo "Unexpected positional argument: $1" >&2
                exit 1
            fi
            shift
            ;;
    esac
done

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd -P)}"
GARELIER_ROOT="$PROJECT_ROOT/__garelier"

if [ ! -d "$GARELIER_ROOT" ]; then
    echo "Error: not a Garelier project root: $PROJECT_ROOT" >&2
    exit 1
fi

# Auto-detect pm_id if not provided
if [ -z "$PM_ID" ]; then
    pm_candidates=()
    for d in "$GARELIER_ROOT"/*/; do
        [ -d "$d" ] || continue
        name="$(basename "$d")"
        if [ -f "$d/_pm/setup_config.toml" ]; then
            pm_candidates+=("$name")
        fi
    done
    case "${#pm_candidates[@]}" in
        0)
            echo "Error: No Garelier PM initialized under $GARELIER_ROOT; run setup_wizard." >&2
            exit 1
            ;;
        1)
            PM_ID="${pm_candidates[0]}"
            ;;
        *)
            echo "Error: multiple PMs found under $GARELIER_ROOT — pass --pm-id <id>." >&2
            echo "       Available PMs:" >&2
            for p in "${pm_candidates[@]}"; do echo "         - $p" >&2; done
            exit 1
            ;;
    esac
fi

PID_FILE="$GARELIER_ROOT/$PM_ID/runtime/driver/driver.pid"
STOP_FILE="$GARELIER_ROOT/$PM_ID/runtime/driver/stop"
CONFIG_FILE="$GARELIER_ROOT/$PM_ID/_pm/setup_config.toml"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: PM '$PM_ID' not found: $CONFIG_FILE missing." >&2
    exit 1
fi

if [ ! -f "$PID_FILE" ]; then
    echo "No driver.pid for PM '$PM_ID' — driver is not running. Nothing to stop."
    rm -f "$STOP_FILE"
    exit 0
fi

mkdir -p "$(dirname "$STOP_FILE")"
touch "$STOP_FILE"
echo "Stop signal written for PM '$PM_ID': $STOP_FILE"
echo "  Driver will exit on its next stop-file check."

if [ "$WAIT" = "true" ]; then
    echo "  Waiting up to ${TIMEOUT}s for driver to exit..."
    deadline=$(( $(date +%s) + TIMEOUT ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if [ ! -f "$PID_FILE" ]; then
            echo "  Driver exited."
            exit 0
        fi
        sleep 2
    done
    echo "Warning: driver did not exit within ${TIMEOUT}s. Check logs or kill manually." >&2
    exit 1
fi
