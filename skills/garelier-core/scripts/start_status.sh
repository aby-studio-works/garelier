#!/usr/bin/env bash
#
# Launch the Garelier Status Web Console detached. Read-only: it never
# mutates state and never spawns a provider. It writes its own pidfile
# (runtime/status_web/status_web.json) so stop_status.sh can stop it without
# the launching terminal.
#
# LAN-reachable by default; pass --loopback to bind 127.0.0.1 only. Extra
# args after the known ones are forwarded to status_web.ts (e.g. --port).
#
# Usage: start_status.sh [--pm-id <id>] [--project <path>] [--port <n>]
#                        [--loopback] [<pm_id>]

set -euo pipefail

# On Windows the pidfile holds the native Windows PID; MSYS `kill -0` can't see
# it, so check liveness via tasklist there (// escapes the flag for MSYS).
is_windows() { case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }
pid_alive() {
    if is_windows; then tasklist //FI "PID eq $1" 2>/dev/null | grep -qw "$1"
    else kill -0 "$1" 2>/dev/null; fi
}

PROJECT_ROOT=""
PM_ID=""
EXTRA=()

usage() {
    cat <<'EOF'
Usage: start_status.sh [--pm-id <id>] [--project <path>] [--port <n>] [--loopback] [<pm_id>]

Options:
  --pm-id <id>       PM whose console to launch (auto-detected if exactly one).
  --project <path>   Project root (default: current directory).
  --port <n>         Port (default: [status_web] port or 3787).
  --loopback         Bind 127.0.0.1 only (default is LAN-reachable 0.0.0.0).
  --host <addr>      Explicit bind address (advanced; overrides the default).
  -h, --help         Show this help.

Stop it with: stop_status.sh --pm-id <id>
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --pm-id)   PM_ID="${2:?missing --pm-id value}"; shift 2 ;;
        --project) PROJECT_ROOT="${2:?missing --project value}"; shift 2 ;;
        --port)    EXTRA+=(--port "${2:?missing --port value}"); shift 2 ;;
        --loopback|--local) EXTRA+=(--loopback); shift ;;
        --host)    EXTRA+=(--host "${2:?missing --host value}"); shift 2 ;;
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
    echo "Error: not a Garelier project root: $PROJECT_ROOT (no __garelier/)" >&2
    exit 1
fi

# Auto-detect pm_id when exactly one full or control-only namespace exists.
if [ -z "$PM_ID" ]; then
    pm_candidates=()
    for d in "$GARELIER_ROOT"/*/; do
        [ -d "$d" ] || continue
        if [ -f "$d/_pm/setup_config.toml" ] || [ -f "$d/control/control.toml" ]; then
            pm_candidates+=("$(basename "$d")")
        fi
    done
    case "${#pm_candidates[@]}" in
        0) echo "Error: no Garelier control namespace under $GARELIER_ROOT; initialize Garelier Control or run setup_wizard." >&2; exit 1 ;;
        1) PM_ID="${pm_candidates[0]}" ;;
        *) echo "Error: multiple PMs found — pass --pm-id <id>." >&2
           for p in "${pm_candidates[@]}"; do echo "         - $p" >&2; done; exit 1 ;;
    esac
fi

# Resolve garelier-core dir (DEC-053: cache-safe + dual-mode). Order:
#   1. GARELIER_CORE_DIR (explicit override)
#   2. ${CLAUDE_PLUGIN_ROOT}/skills/garelier-core (plugin runtime)
#   3. script-relative self-location (this script lives in
#      garelier-core/scripts/, so dirname/.. = garelier-core); verified by
#      SKILL.md presence — works in the read-only plugin cache too
#   4. legacy $HOME/.claude/skills/garelier-core (dev symlink last resort)
SELF_CORE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${GARELIER_CORE_DIR:-}" ]; then
    SKILL_DIR="$GARELIER_CORE_DIR"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ]; then
    SKILL_DIR="$CLAUDE_PLUGIN_ROOT/skills/garelier-core"
elif [ -f "$SELF_CORE_DIR/SKILL.md" ]; then
    SKILL_DIR="$SELF_CORE_DIR"
else
    SKILL_DIR="$HOME/.claude/skills/garelier-core"
fi
export GARELIER_CORE_DIR="$SKILL_DIR"
ENTRY_POINT="$SKILL_DIR/driver/src/status_web.ts"
PID_FILE="$GARELIER_ROOT/$PM_ID/runtime/status_web/status_web.json"
LOG_DIR="$GARELIER_ROOT/$PM_ID/runtime/status_web"
STDOUT_LOG="$LOG_DIR/status_web.stdout.log"

if [ ! -f "$GARELIER_ROOT/$PM_ID/_pm/setup_config.toml" ] && [ ! -f "$GARELIER_ROOT/$PM_ID/control/control.toml" ]; then
    echo "Error: Garelier namespace '$PM_ID' not found." >&2; exit 1
fi
if [ ! -f "$ENTRY_POINT" ]; then
    echo "Error: status_web entry not found at $ENTRY_POINT" >&2
    echo "       Reinstall the garelier-core skill (or set GARELIER_CORE_DIR)." >&2
    exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
    echo "Error: 'bun' not found on PATH (curl -fsSL https://bun.sh/install | bash)." >&2; exit 1
fi

# Refuse if an instance is already alive for this PM.
if [ -f "$PID_FILE" ]; then
    existing="$(grep -oE '"pid":[[:space:]]*[0-9]+' "$PID_FILE" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
    if [ -n "$existing" ] && pid_alive "$existing"; then
        echo "Status console already running for PM '$PM_ID' (pid $existing)." >&2
        echo "  Stop it first: stop_status.sh --pm-id $PM_ID" >&2
        exit 1
    fi
    rm -f "$PID_FILE"
fi

mkdir -p "$LOG_DIR"
export GARELIER_PM_ID="$PM_ID"
cd "$PROJECT_ROOT"
if command -v setsid >/dev/null 2>&1; then
    setsid bun run "$ENTRY_POINT" --project "$PROJECT_ROOT" --pm-id "$PM_ID" "${EXTRA[@]}" </dev/null >>"$STDOUT_LOG" 2>&1 &
else
    nohup bun run "$ENTRY_POINT" --project "$PROJECT_ROOT" --pm-id "$PM_ID" "${EXTRA[@]}" </dev/null >>"$STDOUT_LOG" 2>&1 &
fi
launched=$!
disown "$launched" 2>/dev/null || true

# Give it a moment to bind + write the pidfile, then surface the URL.
for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -f "$PID_FILE" ] && break
    sleep 0.3
done
url="$(grep -oE '"url":[[:space:]]*"[^"]+"' "$PID_FILE" 2>/dev/null | sed -E 's/.*"url":[[:space:]]*"([^"]+)".*/\1/' || true)"
echo "Status console launched (PID $launched, detached) for PM '$PM_ID'."
[ -n "$url" ] && echo "  URL:   $url"
echo "  Log:   $STDOUT_LOG"
echo "  Stop:  stop_status.sh --pm-id $PM_ID"
