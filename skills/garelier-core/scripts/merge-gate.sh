#!/usr/bin/env bash
#
# Garelier Merge Gate (bash) — v2.2 (DEC-007).
#
# Mechanical merge + quality gate executor. Runs a workbench/anvil → studio
# merge and the post-merge quality gate as a background subprocess
# spawned by the driver. NO LLM call. NO Anthropic cost.
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

set -euo pipefail

# Hardening — no interactive hangs.
export GIT_TERMINAL_PROMPT=0
exec </dev/null

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
if [ "${#MG_FIELDS[@]}" -lt 11 ]; then
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
QUALITY_GATE_COMMANDS=("${MG_FIELDS[@]:10}")

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
GATE_STEPS_JSON=""
GATE_STEPS_SUMMARY_JSON=""
FAILURE_REASON=""
CONFLICT_FILES=""
STATUS=""
STUDIO_COMMIT=""
PRE_MERGE_TARGET_ADVANCED="false"

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
        if [ -n "$studio_commit" ]; then
            printf '  "studio_commit": "%s",\n' "$studio_commit"
        else
            printf '  "studio_commit": null,\n'
        fi
        printf '  "started_at": "%s",\n' "$STARTED_AT"
        printf '  "ended_at": "%s",\n' "$ended"
        printf '  "duration_ms": %d,\n' "$duration_ms"
        printf '  "gate_steps": [%s],\n' "$GATE_STEPS_JSON"
        if [ -n "$failure_reason" ]; then
            printf '  "failure_reason": "%s",\n' "$(json_escape "$failure_reason")"
        else
            printf '  "failure_reason": null,\n'
        fi
        printf '  "conflict_files": %s,\n' "${conflict_files:-null}"
        printf '  "pre_merge_target_advanced": %s\n' "$PRE_MERGE_TARGET_ADVANCED"
        printf '}\n'
    } > "$RESULT_TMP"
    mv -f "$RESULT_TMP" "$RESULT_FINAL"
    {
        printf '{\n'
        printf '  "schema_version": 1,\n'
        printf '  "request_id": "%s",\n' "$(json_escape "$REQUEST_ID")"
        printf '  "status": "%s",\n' "$status"
        printf '  "quality_gate_mode": "full",\n'
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
        printf '  "gate_steps": [%s],\n' "$GATE_STEPS_SUMMARY_JSON"
        if [ -n "$failure_reason" ]; then
            printf '  "failure_reason": "%s",\n' "$(json_escape "$failure_reason")"
        else
            printf '  "failure_reason": null,\n'
        fi
        printf '  "conflict_files": %s,\n' "${conflict_files:-null}"
        printf '  "pre_merge_target_advanced": %s,\n' "$PRE_MERGE_TARGET_ADVANCED"
        printf '  "log_file": "runtime/merge_gate/logs/%s.log"\n' "$(json_escape "$STEM")"
        printf '}\n'
    } > "$SUMMARY_TMP"
    mv -f "$SUMMARY_TMP" "$SUMMARY_FINAL"
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
}

# === Cleanup trap (covers crashes + SIGTERM from driver stop) ===
cleanup_and_abort() {
    local signal="$1"
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
trap 'cleanup_and_abort SIGTERM' TERM
trap 'cleanup_and_abort SIGINT'  INT
trap 'cleanup_and_abort EXIT_NONZERO' ERR

# === Log header ===
{
    echo "=== merge-gate.sh request $REQUEST_ID ==="
    echo "started_at:      $STARTED_AT"
    echo "workbench:       $WORKBENCH_BRANCH"
    echo "studio:          $STUDIO_BRANCH"
    echo "merge_message:   $MERGE_MESSAGE"
    echo "pre_merge_base:  $PRE_MERGE_BASE_TRACKING"
    echo "quality_gate:"
    for c in "${QUALITY_GATE_COMMANDS[@]}"; do
        echo "  - $c"
    done
    echo "cmd_timeout_min: $CMD_TIMEOUT_MINUTES"
    echo "control_root:    $PROJECT_ROOT"
    echo "target_root:     $TARGET_ROOT"
    echo ""
} > "$LOG_FILE"

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

# === Step 4: run quality gate commands ===
TIMEOUT_SECS=$(( CMD_TIMEOUT_MINUTES * 60 ))
for cmd in "${QUALITY_GATE_COMMANDS[@]}"; do
    [ -z "$cmd" ] && continue
    echo "" >> "$LOG_FILE"
    echo "--- gate: $cmd ---" >> "$LOG_FILE"
    cmd_start=$(date -u +%s)
    cmd_stdout="$(mktemp)"
    cmd_stderr="$(mktemp)"
    # `timeout` from coreutils; if missing the command just runs without timeout
    trap - ERR
    set +e
    if command -v timeout >/dev/null 2>&1; then
        timeout "$TIMEOUT_SECS" bash -c "$cmd" > "$cmd_stdout" 2> "$cmd_stderr"
        exit_code=$?
    else
        bash -c "$cmd" > "$cmd_stdout" 2> "$cmd_stderr"
        exit_code=$?
    fi
    set -e
    trap 'cleanup_and_abort EXIT_NONZERO' ERR
    cmd_end=$(date -u +%s)
    cmd_duration_ms=$(( (cmd_end - cmd_start) * 1000 ))
    cat "$cmd_stdout" >> "$LOG_FILE"
    cat "$cmd_stderr" >> "$LOG_FILE"
    stdout_tail="$(tail -c 800 "$cmd_stdout")"
    stderr_tail="$(tail -c 800 "$cmd_stderr")"
    rm -f "$cmd_stdout" "$cmd_stderr"

    append_gate_step "$cmd" "$exit_code" "$cmd_duration_ms" "$stdout_tail" "$stderr_tail"

    if [ "$exit_code" -ne 0 ]; then
        STATUS="failed"
        git merge --abort >/dev/null 2>&1 || true
        FAILURE_REASON="quality gate command failed: '$cmd' (exit $exit_code)"
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
MG_PM_ID="$(printf '%s' "$STUDIO_BRANCH" | awk -F/ '{print $3}')"
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
        if command -v timeout >/dev/null 2>&1; then
            timeout "$TIMEOUT_SECS" bash -c "$cmd" > "$cmd_stdout" 2> "$cmd_stderr"
            exit_code=$?
        else
            bash -c "$cmd" > "$cmd_stdout" 2> "$cmd_stderr"
            exit_code=$?
        fi
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
            FAILURE_REASON="run-verify command failed: '$cmd' (exit $exit_code)"
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
