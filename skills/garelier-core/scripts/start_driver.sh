#!/usr/bin/env bash
#
# Launch the Garelier driver detached. Calls `bun run` on the TS driver
# in garelier-core/driver/ and returns immediately.
#
# v2.1: pm-id aware. Driver instances are per-PM. Pass <pm_id> explicitly
# when more than one PM lives under __garelier/. If exactly one exists it
# is auto-detected.
#
# Authentication: the driver shells out to the provider configured in
# _pm/setup_config.toml (`claude -p` or `codex exec`). Run `claude login`
# or `codex login` once for whichever provider is enabled. No provider
# API key is managed by this script.
#
# Usage: start_driver.sh [--pm-id <id>] [--project <path>] [<pm_id>]
#        start_driver.sh [<project-root>] [<pm_id>]   (legacy positional)
#

set -euo pipefail

PROJECT_ROOT=""
PM_ID=""
FORCE=0
NO_WATCHDOG=0

usage() {
    cat <<'EOF'
Usage: start_driver.sh [--pm-id <id>] [--project <path>] [--force] [--no-watchdog] [<pm_id>]

Options:
  --pm-id <id>       PM identifier whose driver to launch. Required when
                     more than one PM exists under __garelier/.
  --project <path>   Project root (default: current working directory).
  --force            Start even if doctor reports P0 (blocking) findings.
  --no-watchdog      Do NOT tie the driver to this PM session. By default the
                     driver self-stops (and tears down its detached role
                     children/leases) when the PM's interactive claude terminal
                     closes (no zombies);
                     pass this to keep it running detached afterwards.
  -h, --help         Show this help.

If --pm-id is omitted and exactly one PM directory exists under
__garelier/, it is auto-detected.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --pm-id)       PM_ID="${2:?missing --pm-id value}"; shift 2 ;;
        --project)     PROJECT_ROOT="${2:?missing --project value}"; shift 2 ;;
        --force)       FORCE=1; shift ;;
        --no-watchdog) NO_WATCHDOG=1; shift ;;
        -h|--help) usage; exit 0 ;;
        --) shift; break ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
        *)
            # Positional: first = pm_id, but historically callers might
            # pass project-root first. Accept pm_id-as-positional.
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

# ── Dispatch-only (DEC-061): the headless driver (Mode B) is disabled ─────────
# Garelier runs roles via DISPATCH (the interactive PM/Dock session dispatches
# each role as an in-session subagent, or a `codex exec` subprocess), NOT the
# per-iteration `claude -p` headless driver. This entrypoint refuses to launch.
# The driver code is retained (not deleted) but gated off; GARELIER_ALLOW_DRIVER=1
# is an UNSUPPORTED internal recovery escape hatch only.
if [ "${GARELIER_ALLOW_DRIVER:-0}" != "1" ]; then
    echo "Garelier is DISPATCH-ONLY: the headless driver (Mode B) is disabled (DEC-061)." >&2
    echo "Run roles via dispatch — the interactive PM/Dock session dispatches each role as" >&2
    echo "an in-session subagent (or a 'codex exec' subprocess). See README / docs/execution_backends.md." >&2
    exit 2
fi

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd -P)}"
GARELIER_ROOT="$PROJECT_ROOT/__garelier"

if [ ! -d "$GARELIER_ROOT" ]; then
    echo "Error: not a Garelier project root: $PROJECT_ROOT" >&2
    echo "       (no __garelier/ directory)" >&2
    exit 1
fi

# Auto-detect pm_id if not provided
if [ -z "$PM_ID" ]; then
    pm_candidates=()
    for d in "$GARELIER_ROOT"/*/; do
        [ -d "$d" ] || continue
        name="$(basename "$d")"
        # A real PM has _pm/setup_config.toml inside it.
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
# Export so the driver (main.ts) and its subprocesses inherit the resolved dir.
export GARELIER_CORE_DIR="$SKILL_DIR"
DRIVER_DIR="$SKILL_DIR/driver"
ENTRY_POINT="$DRIVER_DIR/src/main.ts"
CONFIG_FILE="$GARELIER_ROOT/$PM_ID/_pm/setup_config.toml"
PID_FILE="$GARELIER_ROOT/$PM_ID/runtime/driver/driver.pid"
STOP_FILE="$GARELIER_ROOT/$PM_ID/runtime/driver/stop"
LOGS_DIR="$GARELIER_ROOT/$PM_ID/runtime/driver/logs"
STDOUT_LOG="$LOGS_DIR/driver.stdout.log"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: PM '$PM_ID' not found: $CONFIG_FILE missing." >&2
    exit 1
fi
if [ ! -f "$ENTRY_POINT" ]; then
    echo "Error: driver entry not found at $ENTRY_POINT" >&2
    echo "       Reinstall the garelier-core skill (or set GARELIER_CORE_DIR)." >&2
    exit 1
fi
# Refuse if a live driver is already running
if [ -f "$PID_FILE" ]; then
    existing="$(cat "$PID_FILE" 2>/dev/null)"
    if [ -n "$existing" ] && kill -0 "$existing" 2>/dev/null; then
        echo "Driver already running for PM '$PM_ID' (pid $existing). Stop it with stop_driver.sh --pm-id $PM_ID, or touch $STOP_FILE." >&2
        exit 1
    fi
fi

if [ -f "$STOP_FILE" ]; then
    rm -f "$STOP_FILE"
    echo "Removed stale $STOP_FILE from previous run."
fi

# === Shell-level pre-flight cleanup (PM history-and-operations §13.4 subset) ===
#
# When PM is mediating the restart, PM runs the full audit in §13.4
# (categorizing dirty files into PM-owned / Worker-leak / etc, asking
# user for PM-owned items). When the user invokes start_driver
# directly (bypassing PM, common in Mode B Hybrid), no LLM runs the
# audit. This block performs the shell-safe subset that doesn't need
# judgment:
#
#   1. Stale merge_gate active.lock with dead pid → remove
#   2. Orphan .git/MERGE_HEAD → git merge --abort
#   3. Working-tree dirty → warn (do not auto-fix; needs PM/user judgment)
#
# Anything requiring judgment (PM-owned files, unknown patterns) is
# only WARNED about — the start proceeds because the driver itself
# doesn't read those files; PM is responsible for resolving them on
# next interactive session.

MERGE_GATE_LOCK="$GARELIER_ROOT/$PM_ID/runtime/merge_gate/locks/active.lock"
if [ -f "$MERGE_GATE_LOCK" ]; then
    lock_pid="$(grep -oE '"pid":[[:space:]]*[0-9]+' "$MERGE_GATE_LOCK" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
    if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
        rm -f "$MERGE_GATE_LOCK"
        echo "Removed stale merge_gate active.lock (pid $lock_pid was dead)."
    fi
fi

if [ -f "$PROJECT_ROOT/.git/MERGE_HEAD" ]; then
    echo "Aborting orphan merge state (.git/MERGE_HEAD present) ..."
    (cd "$PROJECT_ROOT" && git merge --abort 2>&1) | sed 's/^/  /' || true
fi

# Working-tree dirt: warn only.
if [ -d "$PROJECT_ROOT/.git" ] || [ -f "$PROJECT_ROOT/.git" ]; then
    dirty_count="$(cd "$PROJECT_ROOT" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${dirty_count:-0}" -gt 0 ]; then
        echo ""
        echo "WARNING: $dirty_count dirty path(s) in primary checkout. Examples:"
        (cd "$PROJECT_ROOT" && git status --short 2>/dev/null | head -10) | sed 's/^/  /'
        echo ""
        echo "  Driver will start anyway. PM-owned dirt (AGENTS.md, CLAUDE.md,"
        echo "  __garelier/<pm_id>/{_pm,control}/*) should be reviewed and committed"
        echo "  in your next PM session — see garelier-pm/references/history-and-operations.md §13.4 for the full audit"
        echo "  + classification procedure."
        echo ""
    fi
fi

# === Doctor pre-flight ===
#
# Run the health check before launching. A P0 (blocking) finding — broken
# setup, placeholder leakage, dangerous config without commands — refuses
# the start unless --force was passed. P1/P2 only warn; the start proceeds.
DOCTOR="$(dirname "$0")/doctor.sh"
if [ -f "$DOCTOR" ]; then
    doctor_out=""
    doctor_rc=0
    doctor_out="$(bash "$DOCTOR" --pm-id "$PM_ID" --project "$PROJECT_ROOT" 2>&1)" || doctor_rc=$?
    if [ "$doctor_rc" -ne 0 ]; then
        echo "$doctor_out" | sed 's/^/  /'
        if [ "$FORCE" -ne 1 ]; then
            echo "" >&2
            echo "Refusing to start: doctor reported P0 (blocking) findings for PM '$PM_ID'." >&2
            echo "  Fix them (re-run doctor.sh --pm-id $PM_ID), or pass --force to override." >&2
            exit 1
        fi
        echo "  --force given: starting despite P0 findings."
    else
        # Surface any P1/P2 warnings (non-empty findings) without blocking.
        if echo "$doctor_out" | grep -qE '^\[(P1|P2)\]'; then
            echo "Doctor warnings (non-blocking):"
            echo "$doctor_out" | grep -E '^\[(P1|P2)\]' | sed 's/^/  /'
        fi
    fi
fi

# === Bun runtime (needed only to LAUNCH) ===
# Checked after the doctor pre-flight so a broken config is still diagnosed
# (doctor is pure bash) even when Bun isn't installed yet.
if ! command -v bun >/dev/null 2>&1; then
    echo "Error: 'bun' not found on PATH." >&2
    echo "       Install: curl -fsSL https://bun.sh/install | bash" >&2
    exit 1
fi
if [ ! -d "$DRIVER_DIR/node_modules" ]; then
    echo "First-time setup: running 'bun install' in $DRIVER_DIR ..."
    (cd "$DRIVER_DIR" && bun install)
fi

mkdir -p "$LOGS_DIR"

# Pass pm_id to the driver via both env var and CLI flag so main.ts can
# pick whichever it prefers.
export GARELIER_PM_ID="$PM_ID"

# === No-zombie watchdog: discover the PM's interactive claude session PID ===
#
# The driver is launched DETACHED (setsid/nohup) so it survives this script's
# parent shell. That means closing the PM terminal would orphan the driver and
# its detached role children. To prevent zombies we pass the PM session PID as
# --watchdog-pid; the driver self-stops (and tears down its role children) when that
# process exits. Discovery: walk the parent chain from this script up to the
# nearest `claude` process. Best-effort — if not found we omit the flag (driver
# runs as before; --no-watchdog forces that explicitly). Note: under MSYS/Git
# Bash on Windows the parent chain is flattened (PPID=1); prefer start_driver.ps1
# there, which resolves the ancestor reliably.
find_claude_ancestor_pid() {
    local pid="$$"
    local i comm parent
    for i in $(seq 1 24); do
        [ "${pid:-0}" -gt 1 ] 2>/dev/null || { echo 0; return; }
        comm="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')"
        case "$comm" in
            *claude*) echo "$pid"; return ;;
        esac
        parent="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')"
        [ -n "$parent" ] || { echo 0; return; }
        pid="$parent"
    done
    echo 0
}

WATCHDOG_PID=0
if [ "$NO_WATCHDOG" -ne 1 ]; then
    WATCHDOG_PID="$(find_claude_ancestor_pid 2>/dev/null || echo 0)"
    if { [ -z "$WATCHDOG_PID" ] || [ "$WATCHDOG_PID" -eq 0 ]; } && [ "${CLAUDECODE:-}" = "1" ]; then
        echo "Note: running under a Claude Code session but could not resolve its PID; driver will run without a watchdog (closing the terminal will NOT auto-stop it)."
    fi
fi

watchdog_args=()
if [ "${WATCHDOG_PID:-0}" -gt 0 ] 2>/dev/null; then
    watchdog_args=(--watchdog-pid "$WATCHDOG_PID")
fi

# Detached spawn. setsid puts the driver in its own session/process group;
# nohup is the fallback for systems without setsid. Either way the driver
# survives the caller exiting (PM Bash subprocess, etc.).
cd "$PROJECT_ROOT"
if command -v setsid >/dev/null 2>&1; then
    setsid bun run "$ENTRY_POINT" --project "$PROJECT_ROOT" --pm-id "$PM_ID" "${watchdog_args[@]}" </dev/null >>"$STDOUT_LOG" 2>&1 &
else
    nohup bun run "$ENTRY_POINT" --project "$PROJECT_ROOT" --pm-id "$PM_ID" "${watchdog_args[@]}" </dev/null >>"$STDOUT_LOG" 2>&1 &
fi
launched_pid=$!
disown "$launched_pid" 2>/dev/null || true

echo "Driver launched (PID $launched_pid, detached) for PM '$PM_ID'."
echo "  Project: $PROJECT_ROOT"
echo "  Stdout:  $STDOUT_LOG"
echo "  JSONL:   $LOGS_DIR/driver.jsonl"
if [ "${WATCHDOG_PID:-0}" -gt 0 ] 2>/dev/null; then
    echo "  Watchdog: tied to PM claude session PID $WATCHDOG_PID (closing this terminal stops the driver + its role children)."
else
    echo "  Watchdog: none (driver keeps running after this terminal closes; stop it explicitly)."
fi
echo "  Stop:    stop_driver.sh --pm-id $PM_ID  (or touch $STOP_FILE)"
