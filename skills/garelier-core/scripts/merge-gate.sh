#!/usr/bin/env bash
#
# Garelier Merge Gate (bash) — v2.2 (DEC-007).
#
# Mechanical merge + quality gate executor. Runs a workbench/anvil → studio
# merge, an OPTIONAL lightweight preflight step (W-023 — fail-fast, e.g. a
# stale-lockfile check, run right after the merge and before the quality
# gate), and the post-merge quality gate, as a background subprocess spawned
# by the driver. NO LLM call. NO Anthropic cost.
#
# Invoked by the driver with one argument: the path to a request JSON.
# Reads the request, runs the merge gate, writes a result JSON.
#
# Concurrency: the driver enforces single-active via locks/active.lock;
# this script trusts that and does not acquire its own lock.
#
# Exit codes are irrelevant to the driver (it reads result JSON).
# But we still exit non-zero on internal script error so the driver
# can flag a synthetic "aborted" result.
#
# Transient-failure retry (W-029, opt-in via [merge_gate] transient_retry in
# setup_config.toml, default false): when a quality-gate command fails with
# output matching a fixed pattern allowlist (parallel-compile / incremental
# artifact races, e.g. `error[E0463]`), it is re-run exactly ONCE — any other
# failure is reported as-is on the first attempt. A successful retry is always
# recorded in the result JSON as `transient_retry`, never hidden.
#
# Data-only fast path (W-031, opt-in via [merge_gate] data_only_paths +
# data_only_commands in setup_config.toml, default empty = inert): when EVERY
# file in the merge diff matches an allowed pattern (e.g. "mods/**",
# "assets/**"), the (often expensive — e.g. a full Rust workspace compile)
# quality_gate_commands step is skipped in favor of the configured
# data_only_commands (e.g. a cooker --validate-only). Preflight (W-023) still
# runs in BOTH modes. The chosen `gate_mode` ("data_only" | "full") and the
# classified file count are always recorded in the result/summary JSON.

set -euo pipefail

# Hardening — no interactive hangs.
export GIT_TERMINAL_PROMPT=0
exec </dev/null

# W-055: mark every git commit this gate makes (step 2 base-tracking merge,
# step 5 merge commit) as the gate's OWN so the PM commit-guard pre-commit hook
# exempts them from its race/absorb guard. WITHOUT this marker the hook cannot
# tell the gate committing its own merge from a foreign PM/Dock commit landing
# while the gate's `git merge --no-commit` is staged in the shared index — and
# it must block the latter (a foreign commit ABSORBS the gate's in-flight merge
# and strands the gate at its commit step). See hooks/pre-commit.
export GARELIER_MERGE_GATE_COMMIT=1

# Reproducible-build hardening for Rust projects (a no-op for every other stack,
# so it runs unconditionally): a Rust gate must reflect the committed source +
# the project's own .cargo/config.toml, NOT a host-machine RUSTC_WRAPPER /
# RUSTC_WORKSPACE_WRAPPER env var (which would OVERRIDE that config). A stray or
# broken wrapper — e.g. a leftover `RUSTC_WRAPPER=sccache` after the project
# removed it from config — would otherwise false-fail EVERY merge build. Non-Rust
# projects never set these vars, so clearing them changes nothing for them; a
# Rust project that genuinely wants a wrapper sets it in .cargo/config.toml.
unset RUSTC_WRAPPER RUSTC_WORKSPACE_WRAPPER

# === Args ===
REQUEST_JSON="${1:-}"
if [ -z "$REQUEST_JSON" ] || [ ! -f "$REQUEST_JSON" ]; then
    echo "Error: usage: merge-gate.sh <request_json_path>" >&2
    exit 2
fi
REQUEST_JSON="$(cd "$(dirname "$REQUEST_JSON")" && pwd -P)/$(basename "$REQUEST_JSON")"

# === Parse request (Bun; robust JSON + Observer gate) ===
# A grep/sed/awk parser mangles quote-escapes, embedded newlines, and special
# characters in quality-gate commands. Delegate to Bun (the driver runtime),
# which JSON.parses the request and emits NUL-delimited records; bash reads
# them with `mapfile -d ''` — no eval, no re-quoting. merge_gate_parse.ts also
# enforces the Observer merge gate (DEC-019): when the request sets
# observer_required=true, it surfaces a refusal reason unless a passing
# Observer verdict (PASS / PASS_WITH_NOTES) is present.
PARSE_TS="$(cd "$(dirname "$0")/../driver/src" 2>/dev/null && pwd -P)/merge_gate_parse.ts"
if ! command -v bun >/dev/null 2>&1; then
    echo "Error: merge gate requires 'bun' on PATH (the driver runtime)." >&2
    exit 2
fi
if [ ! -f "$PARSE_TS" ]; then
    echo "Error: merge_gate_parse.ts not found at $PARSE_TS" >&2
    exit 2
fi
# Resolve project root (5 levels up from requests/) so the parser can resolve a
# relative observer_report_path independently of cwd.
PROJECT_ROOT_FOR_PARSE="$(cd "$(dirname "$REQUEST_JSON")/../../../../.." 2>/dev/null && pwd -P)"
TARGET_ROOT_FOR_GIT="$(
    bun -e 'const fs=require("node:fs"),path=require("node:path");const req=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let p=(typeof req.target_root==="string"&&req.target_root.trim())?req.target_root.trim():process.argv[2];if(!path.isAbsolute(p))p=path.resolve(process.argv[2],p);process.stdout.write(p);' \
        "$REQUEST_JSON" "$PROJECT_ROOT_FOR_PARSE" 2>/dev/null || true
)"
[ -n "$TARGET_ROOT_FOR_GIT" ] || TARGET_ROOT_FOR_GIT="$PROJECT_ROOT_FOR_PARSE"
if ! mapfile -d '' -t MG_FIELDS < <(bun "$PARSE_TS" "$REQUEST_JSON" "$PROJECT_ROOT_FOR_PARSE"); then
    echo "Error: failed to parse request JSON via bun" >&2
    exit 2
fi
if [ "${#MG_FIELDS[@]}" -lt 16 ]; then
    echo "Error: request JSON parse produced too few fields (missing required keys?)" >&2
    exit 2
fi
REQUEST_ID="${MG_FIELDS[0]}"
WORKBENCH_BRANCH="${MG_FIELDS[1]}"
STUDIO_BRANCH="${MG_FIELDS[2]}"
MERGE_MESSAGE="${MG_FIELDS[3]}"
PRE_MERGE_BASE_TRACKING="${MG_FIELDS[4]}"
CMD_TIMEOUT_MINUTES="${MG_FIELDS[5]}"
[ -z "$CMD_TIMEOUT_MINUTES" ] && CMD_TIMEOUT_MINUTES=120
OBSERVER_GATE_FAIL="${MG_FIELDS[6]}"
HAS_PASSING_VERDICT="${MG_FIELDS[7]}"
GUARDIAN_GATE_FAIL="${MG_FIELDS[8]}"
HAS_PASSING_GUARDIAN_VERDICT="${MG_FIELDS[9]}"
# W-035: "" | "sha" | "tree" — how a passing Guardian verdict was bound to the
# workbench tip; "tree" means the G-15 stale-verdict guard accepted a
# message-only amend/reword (commit SHA changed, reviewed tree unchanged).
GUARDIAN_VERDICT_BOUND_BY="${MG_FIELDS[10]}"
# W-062: same field for a passing Observer verdict (symmetric with the Guardian
# one above); "tree" means the Observer stale-verdict guard accepted a
# message-only amend/reword.
OBSERVER_VERDICT_BOUND_BY="${MG_FIELDS[11]}"
# W-066: field 12 is the refuter-gate refusal reason (non-empty ONLY on a present
# REFUTED verdict → hold + PM escalate); field 13 is the resolved refuter verdict
# ("" | UPHELD | REFUTED). Consumed by the refuter gate block below.
REFUTER_GATE_FAIL="${MG_FIELDS[12]}"
REFUTER_VERDICT="${MG_FIELDS[13]}"
# W-023 (index shifted +2 by the W-066 refuter fields above): field 14 is the
# preflight command count; fields 15..(15+count-1) are the preflight commands
# themselves; everything after that is the (unchanged) quality_gate_commands
# list. See merge_gate_parse.ts's record-order comment.
PREFLIGHT_COMMAND_COUNT="${MG_FIELDS[14]}"
[[ "$PREFLIGHT_COMMAND_COUNT" =~ ^[0-9]+$ ]] || PREFLIGHT_COMMAND_COUNT=0
PREFLIGHT_COMMANDS=()
if [ "$PREFLIGHT_COMMAND_COUNT" -gt 0 ]; then
    PREFLIGHT_COMMANDS=("${MG_FIELDS[@]:15:$PREFLIGHT_COMMAND_COUNT}")
fi
QUALITY_GATE_COMMANDS=("${MG_FIELDS[@]:$((15 + PREFLIGHT_COMMAND_COUNT))}")

# Observer-policy backstop (DEC-019): if the request did NOT already require a
# passing Observer verdict, ask the shared bun helper whether [observer_policy]
# mechanically MANDATES one (large diff / protected paths). If it does and none
# accompanies the merge, refuse. Default-inert (enabled=false) and skipped when
# a passing verdict is already present. Fail-open on tooling error.
if [ -z "$OBSERVER_GATE_FAIL" ]; then
    POLICY_TS="$(dirname "$PARSE_TS")/observer_policy_check.ts"
    # pm_id is the 3rd segment of garelier/<slug>/<pm_id>/studio; derive the
    # config from the validated project root (avoids fragile relative cd).
    POLICY_PM_ID="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"
    POLICY_CONFIG="$PROJECT_ROOT_FOR_PARSE/__garelier/$POLICY_PM_ID/_pm/setup_config.toml"
    if [ -f "$POLICY_TS" ] && [ -n "$POLICY_PM_ID" ] && [ -f "$POLICY_CONFIG" ]; then
        OBSERVER_GATE_FAIL="$(bun "$POLICY_TS" "$POLICY_CONFIG" "$TARGET_ROOT_FOR_GIT" "$STUDIO_BRANCH" "$WORKBENCH_BRANCH" "$HAS_PASSING_VERDICT" 2>/dev/null || true)"
    fi
fi

# Guardian-policy backstop (DEC-024): same shape for the SECURITY gate. If the
# request did not already carry a passing Guardian verdict, ask whether
# [guardian_policy] mechanically MANDATES one (security-sensitive paths, package
# manifests/lockfiles, protected paths). Default-inert; fail-open on error.
if [ -z "$GUARDIAN_GATE_FAIL" ]; then
    GUARDIAN_POLICY_TS="$(dirname "$PARSE_TS")/guardian_policy_check.ts"
    GUARDIAN_PM_ID="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"
    GUARDIAN_CONFIG="$PROJECT_ROOT_FOR_PARSE/__garelier/$GUARDIAN_PM_ID/_pm/setup_config.toml"
    if [ -f "$GUARDIAN_POLICY_TS" ] && [ -n "$GUARDIAN_PM_ID" ] && [ -f "$GUARDIAN_CONFIG" ]; then
        GUARDIAN_GATE_FAIL="$(bun "$GUARDIAN_POLICY_TS" "$GUARDIAN_CONFIG" "$TARGET_ROOT_FOR_GIT" "$STUDIO_BRANCH" "$WORKBENCH_BRANCH" "$HAS_PASSING_GUARDIAN_VERDICT" 2>/dev/null || true)"
    fi
fi

# Transient-retry policy (W-023 sibling, W-029): read [merge_gate].transient_retry
# from the same setup_config.toml as the Observer/Guardian backstops above.
# Default false — until a project opts in, quality-gate failures behave
# exactly as before this feature existed. Fail-open to false on tooling error.
TRANSIENT_RETRY_ENABLED="false"
TRANSIENT_RETRY_PM_ID="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"
TRANSIENT_RETRY_CONFIG="$PROJECT_ROOT_FOR_PARSE/__garelier/$TRANSIENT_RETRY_PM_ID/_pm/setup_config.toml"
if [ -n "$TRANSIENT_RETRY_PM_ID" ] && [ -f "$TRANSIENT_RETRY_CONFIG" ]; then
    TRANSIENT_RETRY_ENABLED="$(bun -e 'const c=require(process.argv[1]);process.stdout.write((c.merge_gate&&c.merge_gate.transient_retry===true)?"true":"false");' "$TRANSIENT_RETRY_CONFIG" 2>/dev/null || echo false)"
fi

# Data-only fast-path config (W-031, same config-guard shape as the transient-
# retry read above: no pm_id / no config file / tooling error all fail open to
# empty lists, so the fast path is inert until a project explicitly opts in).
# GATE_MODE defaults to "full" and only flips in step 3a below, AFTER the
# merge, once the actual diff can be classified.
GATE_MODE="full"
DATA_ONLY_FILE_COUNT=0
DATA_ONLY_PATHS=()
DATA_ONLY_COMMANDS=()
DATA_ONLY_PM_ID="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"
DATA_ONLY_CONFIG="$PROJECT_ROOT_FOR_PARSE/__garelier/$DATA_ONLY_PM_ID/_pm/setup_config.toml"
if [ -n "$DATA_ONLY_PM_ID" ] && [ -f "$DATA_ONLY_CONFIG" ]; then
    mapfile -d '' -t DATA_ONLY_PATHS < <(
        bun -e 'const c=require(process.argv[1]);const a=(c.merge_gate&&Array.isArray(c.merge_gate.data_only_paths))?c.merge_gate.data_only_paths:[];for(const x of a){if(typeof x==="string"&&x.trim())process.stdout.write(x+"\0")}' "$DATA_ONLY_CONFIG" 2>/dev/null
    ) || DATA_ONLY_PATHS=()
    mapfile -d '' -t DATA_ONLY_COMMANDS < <(
        bun -e 'const c=require(process.argv[1]);const a=(c.merge_gate&&Array.isArray(c.merge_gate.data_only_commands))?c.merge_gate.data_only_commands:[];for(const x of a){if(typeof x==="string"&&x.trim())process.stdout.write(x+"\0")}' "$DATA_ONLY_CONFIG" 2>/dev/null
    ) || DATA_ONLY_COMMANDS=()
fi

if [ -z "$REQUEST_ID" ] || [ -z "$WORKBENCH_BRANCH" ] || [ -z "$STUDIO_BRANCH" ]; then
    echo "Error: request JSON missing required fields (request_id / workbench_branch / studio_branch)" >&2
    exit 2
fi
if [ "${#QUALITY_GATE_COMMANDS[@]}" -eq 0 ]; then
    echo "Error: request JSON has no quality_gate_commands" >&2
    exit 2
fi

# === Locate result + log paths ===
# Result goes next to the request, but under results/ instead of requests/.
REQUEST_DIR="$(dirname "$REQUEST_JSON")"
REQUEST_FILE="$(basename "$REQUEST_JSON")"
MERGE_GATE_ROOT="$(cd "$(dirname "$REQUEST_DIR")" && pwd -P)"
RESULT_DIR="$MERGE_GATE_ROOT/results"
LOG_DIR="$MERGE_GATE_ROOT/logs"
LOCK_DIR="$MERGE_GATE_ROOT/locks"
ARCHIVE_DIR="$MERGE_GATE_ROOT/archive"
mkdir -p "$RESULT_DIR" "$LOG_DIR" "$LOCK_DIR" "$ARCHIVE_DIR"

# Strip .json suffix from request filename for sibling filenames.
STEM="${REQUEST_FILE%.json}"
RESULT_TMP="$RESULT_DIR/${STEM}.json.tmp"
RESULT_FINAL="$RESULT_DIR/${STEM}.json"
SUMMARY_TMP="$RESULT_DIR/${STEM}.summary.json.tmp"
SUMMARY_FINAL="$RESULT_DIR/${STEM}.summary.json"
LOG_FILE="$LOG_DIR/${STEM}.log"

# === Project/control root inference ===
# Request lives at __garelier/<pm_id>/runtime/merge_gate/requests/<f>.json.
# Control root = 5 levels up. Git operations run at target_root when present.
PROJECT_ROOT="$REQUEST_DIR/../../../../.."
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd -P)"
TARGET_ROOT="$TARGET_ROOT_FOR_GIT"
TARGET_ROOT="$(cd "$TARGET_ROOT" && pwd -P)"
cd "$TARGET_ROOT"

# === ISO timestamp helper ===
iso_now() { date -u +"%Y-%m-%dT%H:%M:%S.%3NZ"; }

STARTED_AT="$(iso_now)"
STARTED_EPOCH="$(date -u +%s)"
PREFLIGHT_STEPS_JSON=""
PREFLIGHT_STEPS_SUMMARY_JSON=""
GATE_STEPS_JSON=""
GATE_STEPS_SUMMARY_JSON=""
FAILURE_REASON=""
CONFLICT_FILES=""
STATUS=""
STUDIO_COMMIT=""
PRE_MERGE_TARGET_ADVANCED="false"
TRANSIENT_RETRY_JSON=""
# W-066: advisory (non-blocking) note recorded in the result when a high-stakes
# merge lands without a refuter verdict. Empty on every low-stakes merge and on
# every merge that carried a refuter verdict — so it changes nothing by default.
REFUTER_WARNING=""

# === Anchor + heavy-compile wiring ===
# pm_id is the 3rd segment of the studio branch (garelier/<slug>/<pm_id>/studio),
# reused by the task_mirror hint (W-076), the heavy-compile lock (W-070), and the
# run-verify config read below.
MG_PM_ID="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"

# W-076: task_mirror anchor hint. A successful merge is a DEC-092 refresh anchor;
# emit the copyable `task_mirror --format ops` command in the SUCCESS result so the
# PM (attended) or the driver re-derives its session Task list from the canonical
# backlog without hand-bookkeeping (pm_playbook §11 anchor protocol). task_mirror.ts
# is the driver sibling of merge_gate_parse.ts; PROJECT_ROOT_FOR_PARSE is the
# validated control root, so the command is copy-runnable as printed.
TASK_MIRROR_HINT=""
if [ -n "$MG_PM_ID" ]; then
    TASK_MIRROR_HINT="bun $(dirname "$PARSE_TS")/dispatch/task_mirror.ts --pm-id $MG_PM_ID --project $PROJECT_ROOT_FOR_PARSE --format ops"
fi

# W-070 leftover wiring: serialize this gate's heavy quality-gate compile through
# the shared heavy_compile_lock (DEC-073 Part B / RAM build-lease) so a concurrent
# worker `cargo build --workspace` and this gate's `cargo test --workspace` cannot
# OOM the box. Acquired right before step 4, released at the single terminal
# chokepoint (clear_lock_if_mine) with the finished build's exit code + log so a
# known-OOM signature records an oom_hint that tightens the next admission
# (pm_playbook §6). Fail-open — acquire never deadlocks the pipeline.
HEAVY_LOCK_TS="$(cd "$(dirname "$0")" && pwd -P)/heavy_compile_lock.ts"
HEAVY_LOCK_TOKEN=""
LAST_GATE_EXIT=""
# W-024: record a WINDOWS-checkable owner pid (not the MSYS `$$`, which node's
# process.kill in heavy_compile_lock.ts cannot verify on Windows — a waiter would
# then read this live gate's lock as pid-dead and reclaim it out from under a
# running compile). `/proc/<pid>/winpid` is the Git-Bash idiom (this repo already
# uses it in merge_land.test.sh); it falls back to `$$` on native Linux/macOS,
# where the two pid spaces coincide.
MG_OWNER_PID="$(cat "/proc/$$/winpid" 2>/dev/null || echo $$)"

# === JSON escape helper ===
# Backslash and double-quote only — sufficient for our content.
json_escape() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

# === Bounded gate-command execution with SIGKILL escalation (W-063) ===
# Every preflight / quality-gate / run-verify command runs through this so a
# hung command can NEVER hold the single merge-gate active.lock forever (which
# blocked the whole merge queue permanently). Two hardenings over the old bare
# `timeout "$SECS" bash -c "$cmd"`:
#   1. `-k <grace>`: `timeout` alone only SENDS SIGTERM on expiry and then WAITS
#      for the child. A command that ignores SIGTERM (e.g. a wedged rustc) hangs
#      the gate for its full natural runtime. `-k` escalates to SIGKILL <grace>
#      seconds after the initial TERM, guaranteeing termination.
#   2. process group: GNU `timeout` in its default (non `--foreground`) mode runs
#      the command in its OWN process group and signals the whole group on
#      expiry, so descendants (cargo -> rustc) are terminated too — verified on
#      GNU coreutils incl. this MSYS2 build. When `setsid --wait` exists it is
#      layered on for an explicit new session (extra isolation). Bare `setsid`
#      is deliberately NOT used: without `--wait` it forks and the parent exits
#      0, masking the command's real exit code (every gate would false-pass).
# When coreutils `timeout` is absent (some Windows Git-Bash installs) a
# bash-native watchdog bounds the wall clock instead, so the queue still can
# never block forever; native grandchildren there are reaped by the driver
# watchdog's `taskkill /T` backstop (merge_gate.ts).
GATE_KILL_GRACE_SECS="${GARELIER_GATE_KILL_GRACE_SECS:-15}"
SETSID_WAIT=""
if command -v setsid >/dev/null 2>&1 && setsid --wait true >/dev/null 2>&1; then
    SETSID_WAIT="1"
fi

# run_gate_command <cmd> <stdout-file> <stderr-file> <limit-secs>
# Returns the command's exit code (124 on timeout, 137 on the SIGKILL escalation).
# MUST be called inside a `set +e` region (callers already are) — a non-zero
# return is an expected outcome, not a script error.
run_gate_command() {
    local cmd="$1" out="$2" err="$3" limit="$4"
    if command -v timeout >/dev/null 2>&1; then
        if [ -n "$SETSID_WAIT" ]; then
            timeout -k "$GATE_KILL_GRACE_SECS" "$limit" setsid --wait bash -c "$cmd" > "$out" 2> "$err"
        else
            timeout -k "$GATE_KILL_GRACE_SECS" "$limit" bash -c "$cmd" > "$out" 2> "$err"
        fi
        return $?
    fi
    # Fallback watchdog: run the command in the background, poll its liveness up
    # to <limit>, then TERM and (after grace) KILL the direct child. Native
    # grandchildren rely on the driver-side taskkill /T backstop.
    bash -c "$cmd" > "$out" 2> "$err" &
    local cmd_pid=$!
    (
        local waited=0
        while [ "$waited" -lt "$limit" ] && kill -0 "$cmd_pid" 2>/dev/null; do
            sleep 1; waited=$((waited + 1))
        done
        if kill -0 "$cmd_pid" 2>/dev/null; then
            kill -TERM "$cmd_pid" 2>/dev/null || true
            local g=0
            while [ "$g" -lt "$GATE_KILL_GRACE_SECS" ] && kill -0 "$cmd_pid" 2>/dev/null; do
                sleep 1; g=$((g + 1))
            done
            kill -KILL "$cmd_pid" 2>/dev/null || true
        fi
    ) &
    local wd_pid=$!
    wait "$cmd_pid" 2>/dev/null
    local ec=$?
    kill "$wd_pid" 2>/dev/null || true
    wait "$wd_pid" 2>/dev/null || true
    return $ec
}

# Human-readable suffix for a timeout/kill exit code, appended to failure_reason
# so a merge that timed out is distinguishable from a normal gate failure.
gate_timeout_note() {
    # $1 = exit code, $2 = per-command limit in seconds
    case "$1" in
        124) printf ' (timed out after %ss)' "$2" ;;
        137) printf ' (SIGKILL after %ss timeout + %ss grace)' "$2" "$GATE_KILL_GRACE_SECS" ;;
        *) : ;;
    esac
}

# === Transient gate-failure detection (W-029) ===
# Fixed, explicit allowlist only — NOT a blind retry. A failure that does not
# match one of these known parallel-compile / incremental-build artifact-race
# signatures is a real error and is reported as-is on the first attempt, same
# as before this feature existed. Extend this list only with a reproduced,
# evidenced transient signature.
transient_failure_pattern() {
    # $1, $2 = stdout, stderr files from the failed command
    if grep -Eq 'error\[E0463\]' "$1" "$2" 2>/dev/null; then
        printf 'E0463'
    elif grep -Eq 'undefined symbol.*anon\.llvm' "$1" "$2" 2>/dev/null; then
        printf 'undefined-symbol-anon-llvm'
    fi
}

# === Result writer (atomic via .tmp + rename) ===
write_result() {
    local status="$1"
    local studio_commit="$2"
    local failure_reason="$3"
    local conflict_files="$4"  # JSON array literal "[]" or "[\"a\",\"b\"]"
    local ended="$(iso_now)"
    local duration_ms=$(( ($(date -u +%s) - STARTED_EPOCH) * 1000 ))

    {
        printf '{\n'
        printf '  "request_id": "%s",\n' "$(json_escape "$REQUEST_ID")"
        printf '  "status": "%s",\n' "$status"
        if [ "$status" = "success" ] && [ -n "$TASK_MIRROR_HINT" ]; then
            printf '  "task_mirror_hint": "%s",\n' "$(json_escape "$TASK_MIRROR_HINT")"
        fi
        if [ -n "$studio_commit" ]; then
            printf '  "studio_commit": "%s",\n' "$studio_commit"
        else
            printf '  "studio_commit": null,\n'
        fi
        printf '  "started_at": "%s",\n' "$STARTED_AT"
        printf '  "ended_at": "%s",\n' "$ended"
        printf '  "duration_ms": %d,\n' "$duration_ms"
        printf '  "preflight_steps": [%s],\n' "$PREFLIGHT_STEPS_JSON"
        printf '  "gate_steps": [%s],\n' "$GATE_STEPS_JSON"
        printf '  "gate_mode": "%s",\n' "$GATE_MODE"
        printf '  "data_only_file_count": %d,\n' "$DATA_ONLY_FILE_COUNT"
        if [ -n "$GUARDIAN_VERDICT_BOUND_BY" ]; then
            printf '  "guardian_verdict_bound_by": "%s",\n' "$GUARDIAN_VERDICT_BOUND_BY"
        else
            printf '  "guardian_verdict_bound_by": null,\n'
        fi
        if [ -n "$OBSERVER_VERDICT_BOUND_BY" ]; then
            printf '  "observer_verdict_bound_by": "%s",\n' "$OBSERVER_VERDICT_BOUND_BY"
        else
            printf '  "observer_verdict_bound_by": null,\n'
        fi
        if [ -n "$failure_reason" ]; then
            printf '  "failure_reason": "%s",\n' "$(json_escape "$failure_reason")"
        else
            printf '  "failure_reason": null,\n'
        fi
        if [ -n "$REFUTER_WARNING" ]; then
            printf '  "refuter_warning": "%s",\n' "$(json_escape "$REFUTER_WARNING")"
        else
            printf '  "refuter_warning": null,\n'
        fi
        printf '  "conflict_files": %s,\n' "${conflict_files:-null}"
        if [ -n "$TRANSIENT_RETRY_JSON" ]; then
            printf '  "pre_merge_target_advanced": %s,\n' "$PRE_MERGE_TARGET_ADVANCED"
            printf '  "transient_retry": %s\n' "$TRANSIENT_RETRY_JSON"
        else
            printf '  "pre_merge_target_advanced": %s\n' "$PRE_MERGE_TARGET_ADVANCED"
        fi
        printf '}\n'
    } > "$RESULT_TMP"
    mv -f "$RESULT_TMP" "$RESULT_FINAL"
    {
        printf '{\n'
        printf '  "schema_version": 1,\n'
        printf '  "request_id": "%s",\n' "$(json_escape "$REQUEST_ID")"
        printf '  "status": "%s",\n' "$status"
        if [ "$status" = "success" ] && [ -n "$TASK_MIRROR_HINT" ]; then
            printf '  "task_mirror_hint": "%s",\n' "$(json_escape "$TASK_MIRROR_HINT")"
        fi
        printf '  "quality_gate_mode": "full",\n'
        printf '  "gate_mode": "%s",\n' "$GATE_MODE"
        printf '  "data_only_file_count": %d,\n' "$DATA_ONLY_FILE_COUNT"
        printf '  "preflight_command_count": %d,\n' "${#PREFLIGHT_COMMANDS[@]}"
        printf '  "quality_gate_command_count": %d,\n' "${#QUALITY_GATE_COMMANDS[@]}"
        printf '  "quality_gate_timeout_minutes_per_cmd": %d,\n' "$CMD_TIMEOUT_MINUTES"
        if [ -n "$studio_commit" ]; then
            printf '  "studio_commit": "%s",\n' "$studio_commit"
        else
            printf '  "studio_commit": null,\n'
        fi
        printf '  "started_at": "%s",\n' "$STARTED_AT"
        printf '  "ended_at": "%s",\n' "$ended"
        printf '  "duration_ms": %d,\n' "$duration_ms"
        printf '  "preflight_steps": [%s],\n' "$PREFLIGHT_STEPS_SUMMARY_JSON"
        printf '  "gate_steps": [%s],\n' "$GATE_STEPS_SUMMARY_JSON"
        if [ -n "$GUARDIAN_VERDICT_BOUND_BY" ]; then
            printf '  "guardian_verdict_bound_by": "%s",\n' "$GUARDIAN_VERDICT_BOUND_BY"
        else
            printf '  "guardian_verdict_bound_by": null,\n'
        fi
        if [ -n "$OBSERVER_VERDICT_BOUND_BY" ]; then
            printf '  "observer_verdict_bound_by": "%s",\n' "$OBSERVER_VERDICT_BOUND_BY"
        else
            printf '  "observer_verdict_bound_by": null,\n'
        fi
        if [ -n "$failure_reason" ]; then
            printf '  "failure_reason": "%s",\n' "$(json_escape "$failure_reason")"
        else
            printf '  "failure_reason": null,\n'
        fi
        if [ -n "$REFUTER_WARNING" ]; then
            printf '  "refuter_warning": "%s",\n' "$(json_escape "$REFUTER_WARNING")"
        else
            printf '  "refuter_warning": null,\n'
        fi
        printf '  "conflict_files": %s,\n' "${conflict_files:-null}"
        printf '  "pre_merge_target_advanced": %s,\n' "$PRE_MERGE_TARGET_ADVANCED"
        if [ -n "$TRANSIENT_RETRY_JSON" ]; then
            printf '  "transient_retry": %s,\n' "$TRANSIENT_RETRY_JSON"
        fi
        printf '  "log_file": "runtime/merge_gate/logs/%s.log"\n' "$(json_escape "$STEM")"
        printf '}\n'
    } > "$SUMMARY_TMP"
    mv -f "$SUMMARY_TMP" "$SUMMARY_FINAL"

    prune_merge_gate_results
}

# === Results + archive retention (W-030 residual, extended by W-038) ===
# results/ gets one .json + one .summary.json per merge request and had no
# delete path (a live target project measured 184 files / ~92 requests,
# monotonic growth).
# archive/ gets one <stem>.request.json per resolved request via
# archive_request() below and had the same monotonic-growth gap, despite
# retention.md documenting a `merge_gate_archive_keep_days` policy for it
# since before either prune path existed (W-038 closes that doc/code gap).
# Prune at WRITE time — called from write_result() above, so it runs after
# EVERY result write (success/failed/conflict/aborted alike) — never at read
# time, so a caller reading results/, archive/, or logs/ never observes a file
# vanish mid-read. The actual keep-window + guard logic for all three lives in
# merge_gate.ts (pruneMergeGateResults + pruneMergeGateArchive +
# pruneMergeGateLogs, shared with the driver's own synthetic-abort
# result-writing path) so there is exactly one implementation of each and all
# are unit-testable via `bun test`; this just shells out. `--keep` /
# `--keep-days` / `--keep-logs` are intentionally omitted so the TS side reads
# `[merge_gate] results_keep` (default 40) / `archive_keep_days` (default 14) /
# `logs_keep` (default = results_keep) from setup_config.toml itself — bash
# never parses TOML for this. logs/ is the W-030-fix path: one <stem>.log per
# merge, previously with no delete path (a live target project hit 137MB/120 files).
prune_merge_gate_results() {
    local mg_ts
    mg_ts="$(dirname "$PARSE_TS")/merge_gate.ts"
    [ -f "$mg_ts" ] || return 0
    local pm_id
    pm_id="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"
    [ -n "$pm_id" ] || return 0
    bun "$mg_ts" prune --project "$PROJECT_ROOT_FOR_PARSE" --pm-id "$pm_id" >> "$LOG_FILE" 2>&1 || true
}

# === Self-drain the merge queue on completion (W-039) ===
# The merge gate serializes on ONE active.lock: a request submitted while this
# gate is running is written to requests/ but NOT started — poll refuses to
# spawn while the lock is held. Under a persistent driver a poll loop would pick
# it up, but dispatch-native (DEC-052/DEC-066) has no such loop, so in attended
# mode that queued request sat idle until a human ran `dock_merge.ts poll` by
# hand (observed live: a request stranded ~1.5h behind an active gate). Closing
# the gap: once THIS gate reaches a terminal outcome and has released its lock,
# call poll once to spawn the next queued request. Properties that keep this
# safe:
#   - idempotent + lock-serialized: poll is a no-op when the queue is empty and
#     never double-spawns a gate that is already running (it checks active.lock),
#     so there is no infinite chain and no double-drain if a driver/dock tick
#     also polls — the chain simply ends when nothing is left to spawn;
#   - detached: poll runs in a backgrounded subshell so this script exits
#     promptly and the gate poll spawns outlives it (reparented, like the driver
#     spawn path);
#   - suppressed on teardown: NOT called during an external TERM/INT stop
#     (MG_TEARDOWN=1), so a Ctrl-C / stop signal does not kick off new work.
self_drain_queue() {
    [ "${MG_TEARDOWN:-0}" = 1 ] && return 0
    local dm_ts pm_id
    dm_ts="$(dirname "$PARSE_TS")/dispatch/dock_merge.ts"
    [ -f "$dm_ts" ] || return 0
    pm_id="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"
    [ -n "$pm_id" ] || return 0
    ( bun "$dm_ts" poll --pm-id "$pm_id" --project "$PROJECT_ROOT_FOR_PARSE" >> "$LOG_FILE" 2>&1 & ) || true
}

# === Append a step record into GATE_STEPS_JSON ===
append_gate_step() {
    local cmd="$1"
    local exit_code="$2"
    local duration_ms="$3"
    local stdout_tail="$4"
    local stderr_tail="$5"

    local entry
    entry="$(
        printf '{"cmd":"%s","exit_code":%d,"duration_ms":%d,"stdout_tail":"%s","stderr_tail":"%s"}' \
            "$(json_escape "$cmd")" "$exit_code" "$duration_ms" \
            "$(json_escape "$stdout_tail")" "$(json_escape "$stderr_tail")"
    )"
    if [ -z "$GATE_STEPS_JSON" ]; then
        GATE_STEPS_JSON="$entry"
    else
        GATE_STEPS_JSON="$GATE_STEPS_JSON,$entry"
    fi
    local summary_entry
    summary_entry="$(
        printf '{"cmd":"%s","exit_code":%d,"duration_ms":%d}' \
            "$(json_escape "$cmd")" "$exit_code" "$duration_ms"
    )"
    if [ -z "$GATE_STEPS_SUMMARY_JSON" ]; then
        GATE_STEPS_SUMMARY_JSON="$summary_entry"
    else
        GATE_STEPS_SUMMARY_JSON="$GATE_STEPS_SUMMARY_JSON,$summary_entry"
    fi
}

# === Append a step record into PREFLIGHT_STEPS_JSON (W-023) ===
# Same shape as append_gate_step, kept as a separate list/field so a preflight
# failure is unambiguously distinguishable from a quality-gate failure in the
# result JSON (preflight_steps vs gate_steps).
append_preflight_step() {
    local cmd="$1"
    local exit_code="$2"
    local duration_ms="$3"
    local stdout_tail="$4"
    local stderr_tail="$5"

    local entry
    entry="$(
        printf '{"cmd":"%s","exit_code":%d,"duration_ms":%d,"stdout_tail":"%s","stderr_tail":"%s"}' \
            "$(json_escape "$cmd")" "$exit_code" "$duration_ms" \
            "$(json_escape "$stdout_tail")" "$(json_escape "$stderr_tail")"
    )"
    if [ -z "$PREFLIGHT_STEPS_JSON" ]; then
        PREFLIGHT_STEPS_JSON="$entry"
    else
        PREFLIGHT_STEPS_JSON="$PREFLIGHT_STEPS_JSON,$entry"
    fi
    local summary_entry
    summary_entry="$(
        printf '{"cmd":"%s","exit_code":%d,"duration_ms":%d}' \
            "$(json_escape "$cmd")" "$exit_code" "$duration_ms"
    )"
    if [ -z "$PREFLIGHT_STEPS_SUMMARY_JSON" ]; then
        PREFLIGHT_STEPS_SUMMARY_JSON="$summary_entry"
    else
        PREFLIGHT_STEPS_SUMMARY_JSON="$PREFLIGHT_STEPS_SUMMARY_JSON,$summary_entry"
    fi
}

archive_request() {
    # Subprocess archives ONLY the request. Result + log must remain in
    # results/ + logs/ until Dock consumes them; otherwise Dock
    # cannot observe merge completion.
    mv -f "$REQUEST_JSON" "$ARCHIVE_DIR/${STEM}.request.json" 2>/dev/null || true
}

clear_lock_if_mine() {
    # Release active.lock if it belongs to THIS request. Match by request_id,
    # NOT pid: on Windows + Git Bash the lock is written by the TS driver with
    # the Windows process pid, but this script's `$$` is the MSYS (Git Bash) pid
    # — a different namespace — so a pid match NEVER succeeds and the lock leaked
    # after every completed merge (driver-mode hid this because the driver poll
    # also releases dead-pid locks, but dispatch-native has no such poll). The
    # request_id uniquely identifies the request the lock is for and is
    # namespace-independent, so it is the correct, cross-platform ownership key.
    if [ -f "$LOCK_DIR/active.lock" ]; then
        if grep -q "\"request_id\":[[:space:]]*\"$REQUEST_ID\"" "$LOCK_DIR/active.lock"; then
            rm -f "$LOCK_DIR/active.lock"
        fi
    fi
    # W-070: release the heavy-compile lock (if this gate acquired one around its
    # quality gate) at the same single terminal chokepoint. Report the finished
    # build's exit code + log so a known-OOM signature records an oom_hint for the
    # next acquire (heavy_compile_lock.ts detectOomSignature). Idempotent — the
    # token is cleared so a re-entry (crash trap) never double-releases; a no-op
    # on paths that exited before step 4 (token still empty).
    if [ -n "$HEAVY_LOCK_TOKEN" ]; then
        local _hl_args
        _hl_args=(--project "$PROJECT_ROOT_FOR_PARSE" --pm-id "$MG_PM_ID" --mode release --token "$HEAVY_LOCK_TOKEN" --build-log "$LOG_FILE")
        [ -n "$LAST_GATE_EXIT" ] && _hl_args+=(--build-exit "$LAST_GATE_EXIT")
        bun "$HEAVY_LOCK_TS" "${_hl_args[@]}" >> "$LOG_FILE" 2>&1 || true
        HEAVY_LOCK_TOKEN=""
    fi
    # W-039: this is the single chokepoint hit exactly once on every terminal
    # outcome (success/failed/conflict/crash-abort), right after the lock is
    # released, so it is where the queue self-drain belongs. self_drain_queue is
    # a no-op on external TERM/INT teardown (MG_TEARDOWN=1) and when the queue is
    # empty.
    self_drain_queue
}

# === Cleanup trap (covers crashes + SIGTERM from driver stop) ===
cleanup_and_abort() {
    local signal="$1"
    # W-039: an external stop signal (TERM/INT) must NOT trigger the post-merge
    # queue self-drain — we are tearing down, not completing a gate. A crash
    # (ERR trap, no "teardown" arg) is a normal terminal outcome and DOES drain
    # the next request.
    [ "${2:-}" = teardown ] && MG_TEARDOWN=1
    {
        echo ""
        echo "=== cleanup_and_abort: signal=$signal at $(iso_now) ==="
    } >> "$LOG_FILE"
    # Always try to leave the working tree clean.
    git merge --abort >/dev/null 2>&1 || true
    if [ -z "$STATUS" ]; then
        STATUS="aborted"
        FAILURE_REASON="signal $signal during merge gate"
        write_result "aborted" "" "$FAILURE_REASON" "null"
    fi
    archive_request
    clear_lock_if_mine
    exit 0
}
trap 'cleanup_and_abort SIGTERM teardown' TERM
trap 'cleanup_and_abort SIGINT  teardown' INT
trap 'cleanup_and_abort EXIT_NONZERO' ERR

# === Log header ===
{
    echo "=== merge-gate.sh request $REQUEST_ID ==="
    echo "started_at:      $STARTED_AT"
    echo "workbench:       $WORKBENCH_BRANCH"
    echo "studio:          $STUDIO_BRANCH"
    echo "merge_message:   $MERGE_MESSAGE"
    echo "pre_merge_base:  $PRE_MERGE_BASE_TRACKING"
    echo "preflight:"
    for c in "${PREFLIGHT_COMMANDS[@]}"; do
        echo "  - $c"
    done
    echo "quality_gate:"
    for c in "${QUALITY_GATE_COMMANDS[@]}"; do
        echo "  - $c"
    done
    echo "cmd_timeout_min: $CMD_TIMEOUT_MINUTES"
    echo "control_root:    $PROJECT_ROOT"
    echo "target_root:     $TARGET_ROOT"
    echo ""
} > "$LOG_FILE"

# W-035: log when the G-15 stale-verdict guard accepted a message-only
# amend/reword via the tree-hash fallback (commit SHA moved, reviewed tree
# unchanged) — never silent, even though it does not block the merge.
if [ "$GUARDIAN_VERDICT_BOUND_BY" = "tree" ]; then
    { echo ""; echo "--- guardian gate: tree-identical amend accepted (G-15 tree fallback, W-035) ---"; } >> "$LOG_FILE"
fi
# W-062: same, for a passing Observer verdict accepted via the tree-hash fallback.
if [ "$OBSERVER_VERDICT_BOUND_BY" = "tree" ]; then
    { echo ""; echo "--- observer gate: tree-identical amend accepted (stale-verdict tree fallback, W-062) ---"; } >> "$LOG_FILE"
fi

# === Observer merge gate (DEC-019) ===
# Refuse the merge mechanically when a required Observer review is absent or
# non-passing. The reason is computed by merge_gate_parse.ts (verdict read
# from the Observer report, not trusted from the request).
if [ -n "$GUARDIAN_GATE_FAIL" ]; then
    STATUS="failed"
    FAILURE_REASON="$GUARDIAN_GATE_FAIL"
    { echo ""; echo "--- guardian gate: REFUSED ---"; echo "$GUARDIAN_GATE_FAIL"; } >> "$LOG_FILE"
    write_result "failed" "" "$FAILURE_REASON" "null"
    archive_request
    clear_lock_if_mine
    trap - EXIT TERM INT ERR
    exit 0
fi
if [ -n "$OBSERVER_GATE_FAIL" ]; then
    STATUS="failed"
    FAILURE_REASON="$OBSERVER_GATE_FAIL"
    { echo ""; echo "--- observer gate: REFUSED ---"; echo "$OBSERVER_GATE_FAIL"; } >> "$LOG_FILE"
    write_result "failed" "" "$FAILURE_REASON" "null"
    archive_request
    clear_lock_if_mine
    trap - EXIT TERM INT ERR
    exit 0
fi

# === Refuter gate (W-066) — opt-in adversarial verify ON TOP of the Observer ===
# The refuter is a +1 independent agent that VERIFIES the Observer's verdict
# (can a PASS be overturned / is a REWORK finding invalid), refute-default — not
# a re-review of the code. It is opt-in and, by design, fires only on HIGH-STAKES
# merges (the require_for_* subset), so daily merges are untouched (cost design).
# Two effects, both narrow:
#   1. refuter_verdict REFUTED (REFUTER_GATE_FAIL non-empty) → an independent
#      agent overturned the Observer verdict: HOLD the merge and fail for PM
#      escalation, fail-closed like the Observer/Guardian gates (W-057 style).
#   2. refuter_verdict ABSENT on a high-stakes merge → advisory WARN recorded in
#      the result (non-blocking: the refuter is non-mandatory; the warn tells the
#      PM a high-stakes merge landed without the extra check).
# A present UPHELD verdict, or any low-stakes merge, is a no-op — behavior is
# identical to before this gate existed.
if [ -n "$REFUTER_GATE_FAIL" ]; then
    STATUS="failed"
    FAILURE_REASON="$REFUTER_GATE_FAIL"
    { echo ""; echo "--- refuter gate: REFUTED (held for PM escalation) ---"; echo "$REFUTER_GATE_FAIL"; } >> "$LOG_FILE"
    write_result "failed" "" "$FAILURE_REASON" "null"
    archive_request
    clear_lock_if_mine
    trap - EXIT TERM INT ERR
    exit 0
fi
if [ -z "$REFUTER_VERDICT" ]; then
    # No refuter verdict — advisory only, and only when this merge is high-stakes.
    # High-stakes = an explicit --high-stakes flag on the request (set by the PM
    # for a semantic trigger the gate cannot see — migration / public API /
    # auth-security), OR the mechanical require_for_* subset (large diff /
    # protected paths) fired REGARDLESS of an Observer verdict being present
    # (observer_policy_check.ts "high-stakes" mode, which — unlike the gate mode —
    # does not short-circuit on a passing verdict and never counts
    # require_for_all_merges, so a project's "review every merge" policy does not
    # make every daily merge high-stakes).
    REFUTER_HS_WHY=""
    REFUTER_HS_FLAG="$(bun -e 'try{const c=require(process.argv[1]);process.stdout.write(c.high_stakes===true?"true":"false")}catch{process.stdout.write("false")}' "$REQUEST_JSON" 2>/dev/null || echo false)"
    if [ "$REFUTER_HS_FLAG" = "true" ]; then
        REFUTER_HS_WHY="explicit --high-stakes flag on the request"
    else
        REFUTER_POLICY_TS="$(dirname "$PARSE_TS")/observer_policy_check.ts"
        REFUTER_POLICY_CONFIG="$PROJECT_ROOT_FOR_PARSE/__garelier/$MG_PM_ID/_pm/setup_config.toml"
        if [ -f "$REFUTER_POLICY_TS" ] && [ -n "$MG_PM_ID" ] && [ -f "$REFUTER_POLICY_CONFIG" ]; then
            REFUTER_HS_WHY="$(bun "$REFUTER_POLICY_TS" "$REFUTER_POLICY_CONFIG" "$TARGET_ROOT_FOR_GIT" "$STUDIO_BRANCH" "$WORKBENCH_BRANCH" false high-stakes 2>/dev/null || true)"
        fi
    fi
    if [ -n "$REFUTER_HS_WHY" ]; then
        REFUTER_WARNING="high-stakes merge landed without a refuter verdict (W-066 advisory, non-blocking): $REFUTER_HS_WHY"
        { echo ""; echo "--- refuter gate: ADVISORY WARN — $REFUTER_WARNING ---"; } >> "$LOG_FILE"
    fi
fi

# === Step 1: ensure on studio ===
echo "--- step 1: checkout studio ---" >> "$LOG_FILE"
if ! git checkout "$STUDIO_BRANCH" >> "$LOG_FILE" 2>&1; then
    STATUS="failed"
    FAILURE_REASON="could not checkout $STUDIO_BRANCH (working tree dirty?)"
    write_result "failed" "" "$FAILURE_REASON" "null"
    archive_request
    clear_lock_if_mine
    trap - EXIT TERM INT ERR
    exit 0
fi

# Defense-in-depth (DEC-050): confirm checkout ATTACHED HEAD to the studio
# BRANCH (not a detached commit). A detached HEAD here would make the merge
# commit strand on a fork instead of advancing the studio ref — the failure mode
# that parked the pipeline after the Garelier rebrand. Refuse before merging.
HEAD_REF="$(git symbolic-ref -q --short HEAD 2>/dev/null || true)"
if [ "$HEAD_REF" != "$STUDIO_BRANCH" ]; then
    STATUS="failed"
    FAILURE_REASON="after checkout, HEAD is '${HEAD_REF:-<detached>}', not studio branch '$STUDIO_BRANCH' — refusing to merge onto a detached HEAD (would strand the merge on a fork instead of advancing studio; DEC-050)"
    { echo ""; echo "--- studio-attached assert: FAILED ($FAILURE_REASON) ---"; } >> "$LOG_FILE"
    write_result "failed" "" "$FAILURE_REASON" "null"
    archive_request
    clear_lock_if_mine
    trap - EXIT TERM INT ERR
    exit 0
fi

# === Step 2: pre-merge base tracking (target → studio) ===
if [ "$PRE_MERGE_BASE_TRACKING" = "true" ]; then
    # Derive target branch from this request's PM tree. Do not glob across
    # sibling PMs; each PM may target a different branch.
    PM_ROOT="$(cd "$MERGE_GATE_ROOT/../.." && pwd -P)"
    SETUP_CONFIG="$PM_ROOT/_pm/setup_config.toml"
    if [ -f "$SETUP_CONFIG" ]; then
        TARGET_BRANCH="$(grep -oE '^target[[:space:]]*=[[:space:]]*"[^"]*"' "$SETUP_CONFIG" \
                          | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
        if [ -n "$TARGET_BRANCH" ]; then
            echo "--- step 2: base tracking ($TARGET_BRANCH → studio) ---" >> "$LOG_FILE"
            # Check if target is ahead of studio
            if git merge-base --is-ancestor "$TARGET_BRANCH" HEAD; then
                echo "studio already contains $TARGET_BRANCH tip, skipping merge" >> "$LOG_FILE"
            else
                if git merge --no-edit "$TARGET_BRANCH" >> "$LOG_FILE" 2>&1; then
                    PRE_MERGE_TARGET_ADVANCED="true"
                else
                    # Base-tracking conflict — abort, escalate to Dock LLM
                    CF="$(git diff --name-only --diff-filter=U 2>/dev/null | head -20)"
                    git merge --abort >/dev/null 2>&1 || true
                    STATUS="conflict"
                    local_cf_json="["
                    first=1
                    while IFS= read -r f; do
                        [ -z "$f" ] && continue
                        if [ $first -eq 0 ]; then local_cf_json="$local_cf_json,"; fi
                        local_cf_json="$local_cf_json\"$(json_escape "$f")\""
                        first=0
                    done <<< "$CF"
                    local_cf_json="$local_cf_json]"
                    FAILURE_REASON="base-tracking merge of $TARGET_BRANCH into studio produced conflicts"
                    write_result "conflict" "" "$FAILURE_REASON" "$local_cf_json"
                    archive_request
                    clear_lock_if_mine
                    trap - EXIT TERM INT ERR
                    exit 0
                fi
            fi
        fi
    fi
fi

# === Step 3: merge the workbench ===
echo "" >> "$LOG_FILE"
echo "--- step 3: git merge --no-ff --no-commit $WORKBENCH_BRANCH ---" >> "$LOG_FILE"
if ! git merge --no-ff --no-commit "$WORKBENCH_BRANCH" >> "$LOG_FILE" 2>&1; then
    # Check if it's a conflict
    CF="$(git diff --name-only --diff-filter=U 2>/dev/null)"
    if [ -n "$CF" ]; then
        STATUS="conflict"
        git merge --abort >/dev/null 2>&1 || true
        cf_json="["
        first=1
        while IFS= read -r f; do
            [ -z "$f" ] && continue
            if [ $first -eq 0 ]; then cf_json="$cf_json,"; fi
            cf_json="$cf_json\"$(json_escape "$f")\""
            first=0
        done <<< "$CF"
        cf_json="$cf_json]"
        FAILURE_REASON="merge produced $(echo "$CF" | wc -l) conflicted files"
        write_result "conflict" "" "$FAILURE_REASON" "$cf_json"
    else
        STATUS="failed"
        git merge --abort >/dev/null 2>&1 || true
        FAILURE_REASON="git merge failed (no conflict markers); see log"
        write_result "failed" "" "$FAILURE_REASON" "null"
    fi
    archive_request
    clear_lock_if_mine
    trap - EXIT TERM INT ERR
    exit 0
fi

# === Step 3-empty: already-up-to-date short-circuit (W-055) ===
# `git merge --no-ff --no-commit` prints "Already up to date." and writes NO
# MERGE_HEAD when the workbench tip is already an ancestor of studio — e.g. a
# re-submitted request whose content already landed (the W-055 incident: an
# earlier concurrent commit absorbed the gate's merge). Nothing was staged, so
# there is nothing to gate or commit; step 5 would hit "nothing to commit" and
# abort with EXIT_NONZERO. Complete idempotently as success instead, so a
# re-submission of an already-merged branch is a clean no-op (HEAD already
# includes any step-2 base-tracking advance, which auto-committed above).
MERGE_HEAD_NOW="$(git rev-parse --git-path MERGE_HEAD 2>/dev/null || echo "")"
if { [ -z "$MERGE_HEAD_NOW" ] || [ ! -f "$MERGE_HEAD_NOW" ]; } && git diff --cached --quiet 2>/dev/null; then
    echo "" >> "$LOG_FILE"
    echo "--- step 3: already up to date — workbench tip already in studio; nothing to gate/commit (already_merged), completing success ---" >> "$LOG_FILE"
    STUDIO_COMMIT="$(git rev-parse HEAD)"
    STATUS="success"
    write_result "success" "$STUDIO_COMMIT" "" "null"
    archive_request
    clear_lock_if_mine
    trap - EXIT TERM INT ERR
    exit 0
fi

TIMEOUT_SECS=$(( CMD_TIMEOUT_MINUTES * 60 ))

# === Step 3a: data-only fast-path classification (W-031) ===
# Only engages when BOTH data_only_paths and data_only_commands were read
# above (config-guarded, default empty = skip this block, GATE_MODE stays
# "full"). Classifies the STAGED diff — `git diff --cached --name-only`
# compares the index (the merge result, still --no-commit) against HEAD, so
# it is exactly the file list this merge introduces, unaffected by any
# earlier base-tracking commit. Matching uses bash `[[ "$f" == $pat ]]`
# pattern semantics (an UNQUOTED pattern, so `*` matches `/` too — patterns
# like "mods/**" or "assets/*" both work as prefix matches). An empty diff or
# any single unmatched file falls back to "full" — this never guesses.
if [ "${#DATA_ONLY_PATHS[@]}" -gt 0 ] && [ "${#DATA_ONLY_COMMANDS[@]}" -gt 0 ]; then
    mapfile -t DATA_ONLY_DIFF_FILES < <(git diff --cached --name-only 2>/dev/null || true)
    DATA_ONLY_FILE_COUNT=0
    ALL_DATA_ONLY=1
    for f in "${DATA_ONLY_DIFF_FILES[@]}"; do
        [ -z "$f" ] && continue
        DATA_ONLY_FILE_COUNT=$((DATA_ONLY_FILE_COUNT + 1))
        matched=0
        for pat in "${DATA_ONLY_PATHS[@]}"; do
            if [[ "$f" == $pat ]]; then
                matched=1
                break
            fi
        done
        [ "$matched" -eq 0 ] && ALL_DATA_ONLY=0
    done
    if [ "$DATA_ONLY_FILE_COUNT" -gt 0 ] && [ "$ALL_DATA_ONLY" -eq 1 ]; then
        GATE_MODE="data_only"
    fi
fi
echo "" >> "$LOG_FILE"
echo "--- step 3a: data-only classification: gate_mode=$GATE_MODE (diff_files=$DATA_ONLY_FILE_COUNT, allow_patterns=${#DATA_ONLY_PATHS[@]}, data_only_commands=${#DATA_ONLY_COMMANDS[@]}) ---" >> "$LOG_FILE"

# === Step 3b: preflight commands (W-023) ===
# Lightweight, fail-fast checks run on the MERGE RESULT (--no-commit, still
# uncommitted) right after step 3 and BEFORE the potentially expensive quality
# gate below — e.g. `cargo metadata --locked --offline` catches a stale
# Cargo.lock in seconds instead of waiting for a multi-minute
# `cargo test --workspace --locked` to fail at the very end. Optional; a
# request with no `preflight` array (PREFLIGHT_COMMANDS empty) is a no-op —
# behavior is identical to before this step existed.
if [ "${#PREFLIGHT_COMMANDS[@]}" -gt 0 ]; then
    echo "" >> "$LOG_FILE"
    echo "--- step 3b: preflight (${#PREFLIGHT_COMMANDS[@]} cmd, fail-fast before quality gate) ---" >> "$LOG_FILE"
    for cmd in "${PREFLIGHT_COMMANDS[@]}"; do
        [ -z "$cmd" ] && continue
        echo "" >> "$LOG_FILE"
        echo "--- preflight: $cmd ---" >> "$LOG_FILE"
        cmd_start=$(date -u +%s)
        cmd_stdout="$(mktemp)"
        cmd_stderr="$(mktemp)"
        trap - ERR
        set +e
        run_gate_command "$cmd" "$cmd_stdout" "$cmd_stderr" "$TIMEOUT_SECS"
        exit_code=$?
        set -e
        trap 'cleanup_and_abort EXIT_NONZERO' ERR
        cmd_end=$(date -u +%s)
        cmd_duration_ms=$(( (cmd_end - cmd_start) * 1000 ))
        cat "$cmd_stdout" >> "$LOG_FILE"
        cat "$cmd_stderr" >> "$LOG_FILE"
        stdout_tail="$(tail -c 800 "$cmd_stdout")"
        stderr_tail="$(tail -c 800 "$cmd_stderr")"
        rm -f "$cmd_stdout" "$cmd_stderr"

        append_preflight_step "$cmd" "$exit_code" "$cmd_duration_ms" "$stdout_tail" "$stderr_tail"

        if [ "$exit_code" -ne 0 ]; then
            STATUS="failed"
            git merge --abort >/dev/null 2>&1 || true
            FAILURE_REASON="preflight command failed: '$cmd' (exit $exit_code)$(gate_timeout_note "$exit_code" "$TIMEOUT_SECS")"
            write_result "failed" "" "$FAILURE_REASON" "null"
            archive_request
            clear_lock_if_mine
            trap - EXIT TERM INT ERR
            exit 0
        fi
    done
fi

# === Step 4-lock: acquire the heavy-compile lock (W-070) ===
# Wrap the (potentially ~16GB) quality gate so it cannot OOM against a concurrent
# worker build. acquire fail-opens (prints a slot path, "OPEN" when disabled/
# timed-out; always exits 0), so it never deadlocks this gate. Released with the
# build outcome at the terminal chokepoint (clear_lock_if_mine).
# W-024: a data-only gate runs no heavy compile (step 3a substituted the cheap
# data_only_commands for the workspace build), so it must NOT queue behind the
# heavy-compile lock — that directly caused the 2026-07-06 90-min docs-only gate
# stall. Skip the lock in data_only mode; otherwise acquire it. Also skipped when
# pm_id or the lock script cannot be resolved.
if [ "$GATE_MODE" = "data_only" ]; then
    { echo ""; echo "--- step 4-lock: heavy_compile_lock SKIPPED — gate_mode=data_only runs no heavy compile (W-024) ---"; } >> "$LOG_FILE"
elif [ -n "$MG_PM_ID" ] && [ -f "$HEAVY_LOCK_TS" ]; then
    HEAVY_LOCK_TOKEN="$(bun "$HEAVY_LOCK_TS" --project "$PROJECT_ROOT_FOR_PARSE" --pm-id "$MG_PM_ID" --mode acquire --label "mg-$STEM" --owner-pid "$MG_OWNER_PID" 2>>"$LOG_FILE" || true)"
    { echo ""; echo "--- step 4-lock: heavy_compile_lock acquire token=${HEAVY_LOCK_TOKEN:-<none>} (W-070) ---"; } >> "$LOG_FILE"
fi

# === Step 4: run quality gate commands (or the data-only substitute, W-031) ===
if [ "$GATE_MODE" = "data_only" ]; then
    ACTIVE_GATE_COMMANDS=("${DATA_ONLY_COMMANDS[@]}")
    echo "" >> "$LOG_FILE"
    echo "--- step 4: data-only fast path active — running ${#ACTIVE_GATE_COMMANDS[@]} data_only_commands instead of ${#QUALITY_GATE_COMMANDS[@]} quality_gate_commands ---" >> "$LOG_FILE"
else
    ACTIVE_GATE_COMMANDS=("${QUALITY_GATE_COMMANDS[@]}")
fi
for cmd in "${ACTIVE_GATE_COMMANDS[@]}"; do
    [ -z "$cmd" ] && continue
    echo "" >> "$LOG_FILE"
    echo "--- gate: $cmd ---" >> "$LOG_FILE"
    cmd_start=$(date -u +%s)
    cmd_stdout="$(mktemp)"
    cmd_stderr="$(mktemp)"
    # `timeout` from coreutils; if missing the command just runs without timeout
    trap - ERR
    set +e
    run_gate_command "$cmd" "$cmd_stdout" "$cmd_stderr" "$TIMEOUT_SECS"
    exit_code=$?
    set -e
    trap 'cleanup_and_abort EXIT_NONZERO' ERR
    cmd_end=$(date -u +%s)
    cmd_duration_ms=$(( (cmd_end - cmd_start) * 1000 ))

    # W-029: pattern-limited transient retry, ONE attempt, opt-in only.
    if [ "$exit_code" -ne 0 ] && [ "$TRANSIENT_RETRY_ENABLED" = "true" ]; then
        MATCHED_PATTERN="$(transient_failure_pattern "$cmd_stdout" "$cmd_stderr")"
        if [ -n "$MATCHED_PATTERN" ]; then
            echo "" >> "$LOG_FILE"
            echo "--- gate: '$cmd' failed (exit $exit_code), matched transient pattern '$MATCHED_PATTERN' — retrying once ---" >> "$LOG_FILE"
            cat "$cmd_stdout" >> "$LOG_FILE"
            cat "$cmd_stderr" >> "$LOG_FILE"
            rm -f "$cmd_stdout" "$cmd_stderr"
            cmd_stdout="$(mktemp)"
            cmd_stderr="$(mktemp)"
            retry_start=$(date -u +%s)
            trap - ERR
            set +e
            run_gate_command "$cmd" "$cmd_stdout" "$cmd_stderr" "$TIMEOUT_SECS"
            exit_code=$?
            set -e
            trap 'cleanup_and_abort EXIT_NONZERO' ERR
            retry_end=$(date -u +%s)
            cmd_duration_ms=$(( cmd_duration_ms + (retry_end - retry_start) * 1000 ))
            echo "--- gate retry result: exit $exit_code ---" >> "$LOG_FILE"
            if [ "$exit_code" -eq 0 ]; then
                TRANSIENT_RETRY_JSON="{\"cmd\":\"$(json_escape "$cmd")\",\"pattern\":\"$(json_escape "$MATCHED_PATTERN")\"}"
            fi
        fi
    fi

    cat "$cmd_stdout" >> "$LOG_FILE"
    cat "$cmd_stderr" >> "$LOG_FILE"
    stdout_tail="$(tail -c 800 "$cmd_stdout")"
    stderr_tail="$(tail -c 800 "$cmd_stderr")"
    rm -f "$cmd_stdout" "$cmd_stderr"

    # W-070: remember the last quality-gate exit so the heavy_compile_lock release
    # can detect an OOM signature (exit 137 / anon.llvm link error in the log).
    LAST_GATE_EXIT="$exit_code"
    append_gate_step "$cmd" "$exit_code" "$cmd_duration_ms" "$stdout_tail" "$stderr_tail"

    if [ "$exit_code" -ne 0 ]; then
        STATUS="failed"
        git merge --abort >/dev/null 2>&1 || true
        FAILURE_REASON="quality gate command failed: '$cmd' (exit $exit_code)$(gate_timeout_note "$exit_code" "$TIMEOUT_SECS")"
        write_result "failed" "" "$FAILURE_REASON" "null"
        archive_request
        clear_lock_if_mine
        trap - EXIT TERM INT ERR
        exit 0
    fi
done

# === Step 4b: run-verify commands (optional post-merge RUNTIME gate) ===
# OPTIONAL [quality_gate] run_verify_commands from the project's setup_config are
# executed on the MERGED working tree in THIS primary checkout (warm target),
# AFTER the compile/test gate and BEFORE the commit — so a runtime-effect
# regression that compiles + unit-tests clean is still caught and aborts the
# merge (the W-012 class: a build that "passes" but does the wrong thing at run).
# Default-absent = inert (zero behavior change). The framework only RUNS whatever
# command STRINGS the project supplies; it bakes in no command, app contract, or
# runtime assumption — the project owns those (each command must exit non-zero on
# failure). Serialized by the driver's single active.lock, like the gate above.
# MG_PM_ID resolved once near the top (task_mirror hint + heavy-compile lock).
MG_SETUP_CONFIG="$PROJECT_ROOT/__garelier/$MG_PM_ID/_pm/setup_config.toml"
RUN_VERIFY_COMMANDS=()
if [ -n "$MG_PM_ID" ] && [ -f "$MG_SETUP_CONFIG" ]; then
    # Bun parses TOML natively (require of a .toml path); emit NUL-delimited
    # strings so bash reads them with `mapfile -d ''` (no eval / re-quoting).
    mapfile -d '' -t RUN_VERIFY_COMMANDS < <(
        bun -e 'const c=require(process.argv[1]);const a=(c.quality_gate&&Array.isArray(c.quality_gate.run_verify_commands))?c.quality_gate.run_verify_commands:[];for(const x of a){if(typeof x==="string"&&x.trim())process.stdout.write(x+"\0")}' "$MG_SETUP_CONFIG" 2>/dev/null
    ) || RUN_VERIFY_COMMANDS=()
fi
if [ "${#RUN_VERIFY_COMMANDS[@]}" -gt 0 ]; then
    echo "" >> "$LOG_FILE"
    echo "--- step 4b: run-verify (${#RUN_VERIFY_COMMANDS[@]} cmd, post-merge RUNTIME gate) ---" >> "$LOG_FILE"
    for cmd in "${RUN_VERIFY_COMMANDS[@]}"; do
        [ -z "$cmd" ] && continue
        echo "" >> "$LOG_FILE"
        echo "--- run-verify: $cmd ---" >> "$LOG_FILE"
        cmd_start=$(date -u +%s)
        cmd_stdout="$(mktemp)"
        cmd_stderr="$(mktemp)"
        trap - ERR
        set +e
        run_gate_command "$cmd" "$cmd_stdout" "$cmd_stderr" "$TIMEOUT_SECS"
        exit_code=$?
        set -e
        trap 'cleanup_and_abort EXIT_NONZERO' ERR
        cmd_end=$(date -u +%s)
        cmd_duration_ms=$(( (cmd_end - cmd_start) * 1000 ))
        cat "$cmd_stdout" >> "$LOG_FILE"
        cat "$cmd_stderr" >> "$LOG_FILE"
        stdout_tail="$(tail -c 800 "$cmd_stdout")"
        stderr_tail="$(tail -c 800 "$cmd_stderr")"
        rm -f "$cmd_stdout" "$cmd_stderr"

        append_gate_step "run-verify: $cmd" "$exit_code" "$cmd_duration_ms" "$stdout_tail" "$stderr_tail"

        if [ "$exit_code" -ne 0 ]; then
            STATUS="failed"
            git merge --abort >/dev/null 2>&1 || true
            FAILURE_REASON="run-verify command failed: '$cmd' (exit $exit_code)$(gate_timeout_note "$exit_code" "$TIMEOUT_SECS")"
            write_result "failed" "" "$FAILURE_REASON" "null"
            archive_request
            clear_lock_if_mine
            trap - EXIT TERM INT ERR
            exit 0
        fi
    done
fi

# === Step 5: commit the merge ===
echo "" >> "$LOG_FILE"
echo "--- step 5: git commit (merge message) ---" >> "$LOG_FILE"
echo "$MERGE_MESSAGE" | git commit -F - >> "$LOG_FILE" 2>&1
STUDIO_COMMIT="$(git rev-parse HEAD)"
STATUS="success"
write_result "success" "$STUDIO_COMMIT" "" "null"

# === Step 6: archive request only ===
archive_request
clear_lock_if_mine

# Disarm traps so EXIT/ERR doesn't double-run cleanup.
trap - EXIT TERM INT ERR
exit 0
