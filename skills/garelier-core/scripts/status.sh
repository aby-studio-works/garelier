#!/usr/bin/env bash
#
# Garelier Status (bash) — v2.1 (pm-id aware)
#
# Show current project state in a human-readable form. Reads, per PM:
#   - __garelier/<pm_id>/_pm/setup_config.toml         (mode, branches, agent set)
#   - __garelier/<pm_id>/runtime/driver/driver.pid     (driver liveness)
#   - __garelier/<pm_id>/runtime/driver/pids/*.pid     (detached agent leases)
#   - __garelier/<pm_id>/runtime/driver/logs/...       (last lines)
#   - __garelier/<pm_id>/_workers/<id>/STATE.md        (per-Worker state)
#   - __garelier/<pm_id>/_scouts/<id>/STATE.md         (per-Scout state)
#   - __garelier/<pm_id>/_smiths/<id>/STATE.md         (per-Smith state)
#   - __garelier/<pm_id>/runtime/manifest.md           (backlog, milestones, recent activity)
#
# Without --pm-id, lists ALL PMs found under __garelier/. With
# --pm-id, shows only that PM. --watch refreshes in place.
#

set -euo pipefail

WATCH=""
PROJECT_ROOT=""
PM_ID=""

usage() {
    cat <<'EOF'
Usage: status.sh [--pm-id <id>] [--project <path>] [--watch <seconds>]

Options:
  --pm-id <id>        Restrict output to a single PM. Without this flag,
                      every PM under __garelier/ is shown.
  --project <path>    Project root to inspect. Defaults to current cwd.
  --watch <seconds>   Clear screen and re-print every <seconds> seconds.
  --help              Show this help.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --pm-id)   PM_ID="${2:?missing --pm-id value}"; shift 2 ;;
        --watch)   WATCH="${2:-5}"; shift 2 ;;
        --project) PROJECT_ROOT="$2"; shift 2 ;;
        --help|-h) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd -P)}"

# If $PROJECT_ROOT has no __garelier/, walk up — the user may have cd'd
# into __garelier/<pm_id>/_pm/ (the natural place to be).
if [ ! -d "$PROJECT_ROOT/__garelier" ]; then
    cur="$PROJECT_ROOT"
    while [ "$cur" != "/" ] && [ -n "$cur" ]; do
        parent="$(dirname "$cur")"
        if [ -d "$parent/__garelier" ]; then
            PROJECT_ROOT="$parent"
            break
        fi
        if [ "$parent" = "$cur" ]; then break; fi
        cur="$parent"
    done
fi

GARELIER_ROOT="$PROJECT_ROOT/__garelier"

if [ ! -d "$GARELIER_ROOT" ]; then
    echo "Error: not a Garelier project root: $PROJECT_ROOT" >&2
    echo "       (no __garelier/ found here or in any parent)" >&2
    echo "       Pass --project <path> explicitly." >&2
    exit 1
fi

# Per-PM state (populated for each iteration by setup_pm_paths).
CONFIG=""
PM_ROOT=""
DRIVER_DIR=""
DRIVER_PID_FILE=""
PIDS_DIR=""
LOGS_DIR=""
MANIFEST=""

setup_pm_paths() {
    local pm="$1"
    PM_ROOT="$GARELIER_ROOT/$pm"
    CONFIG="$PM_ROOT/_pm/setup_config.toml"
    DRIVER_DIR="$PM_ROOT/runtime/driver"
    DRIVER_PID_FILE="$DRIVER_DIR/driver.pid"
    PIDS_DIR="$DRIVER_DIR/pids"
    LOGS_DIR="$DRIVER_DIR/logs"
    MANIFEST="$PM_ROOT/runtime/manifest.md"
}

discover_pms() {
    local d name
    for d in "$GARELIER_ROOT"/*/; do
        [ -d "$d" ] || continue
        name="$(basename "$d")"
        if [ -f "$d/_pm/setup_config.toml" ]; then
            printf '%s\n' "$name"
        fi
    done
}

# === Helpers ===

# Read a single key from a [section] of setup_config.toml. Strips
# surrounding quotes and trailing `# comment` text.
read_toml() {
    local section="$1"
    local key="$2"
    awk -v sec="$section" -v k="$key" '
        BEGIN { in_section = 0 }
        $0 == "[" sec "]" { in_section = 1; next }
        /^\[/ { in_section = 0 }
        in_section && $0 ~ "^" k "[[:space:]]*=" {
            line = $0
            sub(/^[^=]*=[[:space:]]*/, "", line)
            sub(/[[:space:]]*#.*$/, "", line)
            sub(/^"/, "", line); sub(/"$/, "", line)
            print line
            exit
        }
    ' "$CONFIG"
}

# Compress whitespace and cap a string at $2 chars (with "..." suffix when
# truncated). STATE.md fields and Dock result lines tend to contain
# multi-paragraph narratives that blow the status display.
truncate_field() {
    local value="$1"
    local max="${2:-100}"
    [ -z "$value" ] && return 0
    # Replace any whitespace sequence (incl. embedded newlines) with single space
    local compact
    compact="$(printf '%s' "$value" | tr -s '[:space:]' ' ' | sed -e 's/^ //' -e 's/ $//')"
    if [ "${#compact}" -gt "$max" ]; then
        printf '%s...' "${compact:0:$((max-3))}"
    else
        printf '%s' "$compact"
    fi
}

# Read first non-empty line under "## <section>" in a STATE.md file.
# Falls back to "- Field: value" list-item style when the canonical
# header form is absent (some Workers deviate from the template).
state_field() {
    local file="$1"
    local section="$2"
    [ -f "$file" ] || { echo "(no STATE.md)"; return; }
    # Canonical "## <section>" header form first.
    local val
    val="$(awk -v sec="## $section" '
        $0 == sec { capture = 1; next }
        capture && /^## / { exit }
        capture && NF { print; exit }
    ' "$file")"
    if [ -n "$val" ]; then
        echo "$val"
        return
    fi
    # Fallback: "- <field>: <value>" with common aliases.
    local aliases
    case "$section" in
        "Status")         aliases="Current state|Status|State" ;;
        "Current task")   aliases="Task ID|Current task|Task" ;;
        "Current branch") aliases="Branch|Current branch" ;;
        "Last activity")  aliases="Reported at|Picked up at|Last activity" ;;
        *)                aliases="$section" ;;
    esac
    awk -v aliases="$aliases" '
        BEGIN { n = split(aliases, keys, "|") }
        {
            for (i = 1; i <= n; i++) {
                # Match "- Key: value" or "* Key: value"
                pat = "^[-*][ \t]+" keys[i] "[ \t]*:[ \t]*(.+)$"
                if (match($0, pat, m)) {
                    val = m[1]
                    if (val != "" && val != "n/a") { print val; exit }
                }
            }
        }
    ' "$file"
}

# Stream a "## <section>" block from manifest.md.
manifest_section() {
    local section="$1"
    [ -f "$MANIFEST" ] || return 0
    awk -v section="$section" '
        $0 ~ "^##[ \t]+" section "([ \t(]|$)" { capture = 1; next }
        capture && /^## / { exit }
        capture { print }
    ' "$MANIFEST"
}

manifest_agent_status() {
    local role="$1"
    local id="$2"
    local section
    case "$role" in
        workers) section="Active Workers" ;;
        scouts)  section="Active Scouts" ;;
        smiths)  section="Active Smiths" ;;
        *)       return 0 ;;
    esac
    manifest_section "$section" | awk -F'|' -v id="$id" '
        /^\|/ {
            name = $2
            state = $3
            gsub(/^[ \t]+|[ \t]+$/, "", name)
            gsub(/^[ \t]+|[ \t]+$/, "", state)
            if (name == id && state !~ /^-+$/) {
                print state
                exit
            }
        }
    '
}

# List [[workers]], [[scouts]], or [[smiths]] ids.
list_agent_ids() {
    local section="$1"
    awk -v sec="$section" '
        BEGIN { in_section = 0 }
        $0 == "[[" sec "]]" { in_section = 1; next }
        /^\[/ { in_section = 0 }
        in_section && /^id[[:space:]]*=/ {
            match($0, /"[^"]*"/); print substr($0, RSTART+1, RLENGTH-2)
        }
    ' "$CONFIG"
}

pid_alive() {
    kill -0 "$1" 2>/dev/null
}

pid_file_value() {
    local file="$1" raw
    raw="$(cat "$file" 2>/dev/null || true)"
    if printf '%s' "$raw" | grep -Eq '^[[:space:]]*[0-9]+[[:space:]]*$'; then
        printf '%s' "$raw" | tr -d '[:space:]'
        return 0
    fi
    printf '%s\n' "$raw" \
        | grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' \
        | grep -oE '[0-9]+' \
        | head -1
}

pid_file_field() {
    local file="$1" field="$2"
    grep -oE "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null \
        | head -1 \
        | sed -E "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/"
}

git_dirty_summary() {
    local path="$1"
    [ -d "$path" ] || return 0
    # DEC-020 / DEC-035: a worktree role's git tree is <container>/checkout; the bare
    # container has no .git, so `git -C <container>` would walk UP to the primary
    # (studio) checkout and misreport ITS dirtiness as the role's. Prefer the
    # nested checkout worktree when present (PM/Dock have no checkout and
    # legitimately share the primary checkout).
    if [ -e "$path/checkout/.git" ]; then path="$path/checkout"; fi
    git -C "$path" rev-parse --show-toplevel >/dev/null 2>&1 || return 0
    local output count sample suffix=""
    output="$(git -C "$path" status --short --untracked-files=normal 2>/dev/null || true)"
    [ -n "$output" ] || return 0
    count="$(printf '%s\n' "$output" | awk 'NF { n++ } END { print n + 0 }')"
    [ "$count" -gt 0 ] || return 0
    sample="$(printf '%s\n' "$output" | awk '
        NF {
            sub(/^[ \t]+/, "")
            if (n < 5) {
                if (n > 0) { printf "; " }
                printf "%s", $0
                n++
            }
        }
    ')"
    if [ "$count" -gt 5 ]; then suffix="; ..."; fi
    printf "%s entries (%s%s)\n" "$count" "$sample" "$suffix"
}

smith_target_count_in_file() {
    local file="$1"
    [ -f "$file" ] || { echo 0; return; }
    awk '
        {
            raw = $0
            line = tolower($0)
            if (line !~ /(smith_targets|smith target|covered worker merges|covered merges|smith hardening targets)/) {
                next
            }
            if (line ~ /(none|n\/a)/) {
                next
            }
            while (match(raw, /#[0-9]+@[0-9A-Fa-f]+/)) {
                token = substr(raw, RSTART, RLENGTH)
                seen[token] = 1
                raw = substr(raw, RSTART + RLENGTH)
            }
            while (match(raw, /#[0-9]+/)) {
                token = substr(raw, RSTART, RLENGTH)
                seen[token] = 1
                raw = substr(raw, RSTART + RLENGTH)
            }
        }
        END {
            n = 0
            for (token in seen) { n++ }
            print n + 0
        }
    ' "$file"
}

is_active_agent_status() {
    case "$1" in
        ASSIGNED|WORKING|REPORTING|REVIEWING|REWORK|BLOCKED) return 0 ;;
        *) return 1 ;;
    esac
}

smith_active_target_summary() {
    local active_targets=0 active_batches=0 unknown_batches=0
    local dir="$PM_ROOT/_smiths"
    local id agent_dir sf assignment status count
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        agent_dir="$(status_resolve_container smiths "$id" "$dir/$id")"   # DEC-035
        sf="$agent_dir/STATE.md"
        assignment="$agent_dir/assignment.md"
        status="$(state_field "$sf" "Status")"
        if is_active_agent_status "$status" || { [ -f "$assignment" ] && [ "$status" != "MERGED" ] && [ "$status" != "ABORTED" ]; }; then
            active_batches=$((active_batches + 1))
            count="$(smith_target_count_in_file "$assignment")"
            if [ "$count" -gt 0 ]; then
                active_targets=$((active_targets + count))
            else
                unknown_batches=$((unknown_batches + 1))
            fi
        fi
    done < <(list_agent_ids smiths)
    printf '%s %s %s\n' "$active_targets" "$active_batches" "$unknown_batches"
}

print_smith_hardening_counters() {
    local pending_count active_count active_batches unknown_batches total note
    pending_count="$(smith_target_count_in_file "$PM_ROOT/runtime/backlog/pending.md")"
    read -r active_count active_batches unknown_batches < <(smith_active_target_summary)
    total=$((pending_count + active_count))
    note="    Smith hardening targets remaining:       $total (pending $pending_count, active $active_count)"
    if [ "$unknown_batches" -gt 0 ]; then
        note="$note; active batches missing parseable targets: $unknown_batches"
    fi
    printf '%s\n' "$note"
}

# DEC-035: a role's container may live in a machine-local home OUTSIDE the
# project; the gitignored pointer records its absolute path. Resolve to that when
# present, else fall back to the in-proj container path passed in.
status_pointer_key() {  # plural-role id -> "<role>.<id>" (or "artisan")
    local r
    case "$1" in
        workers) r=worker ;; scouts) r=scout ;; smiths) r=smith ;;
        librarians) r=librarian ;; observers) r=observer ;;
        guardians) r=guardian ;; concierges) r=concierge ;;
        artisan) r=artisan ;; *) r="${1%s}" ;;
    esac
    if [ "$1" = artisan ]; then printf 'artisan'; else printf '%s.%s' "$r" "$2"; fi
}
status_resolve_container() {  # plural-role id in-proj-fallback -> absolute container
    local pf key v
    pf="$PM_ROOT/runtime/workspace_paths"
    key="$(status_pointer_key "$1" "$2")"
    if [ -f "$pf" ]; then
        v="$(awk -v k="$key" 'index($0, k"=")==1 { print substr($0, length(k)+2); exit }' "$pf")"
        if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
    fi
    printf '%s' "$3"
}

print_role_block() {
    local role="$1"   # workers, scouts, smiths, librarians, observers, guardians, or concierges
    local dir
    case "$role" in
        workers)    dir="$PM_ROOT/_workers" ;;
        scouts)     dir="$PM_ROOT/_scouts" ;;
        smiths)     dir="$PM_ROOT/_smiths" ;;
        librarians) dir="$PM_ROOT/_librarians" ;;
        observers)  dir="$PM_ROOT/_observers" ;;
        guardians)  dir="$PM_ROOT/_guardians" ;;
        concierges) dir="$PM_ROOT/_concierges" ;;
    esac
    local id status task last manifest_status dirty
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        local agent_dir; agent_dir="$(status_resolve_container "$role" "$id" "$dir/$id")"
        local sf="$agent_dir/STATE.md"
        status="$(state_field "$sf" "Status")"
        task="$(truncate_field "$(state_field "$sf" "Current task")" 100)"
        last="$(truncate_field "$(state_field "$sf" "Last activity")" 120)"
        printf "  %-12s %-10s  task: %s\n" "$id" "$status" "$task"
        printf "  %-12s %-10s  last: %s\n" "" "" "$last"
        manifest_status="$(manifest_agent_status "$role" "$id")"
        if [ -n "$manifest_status" ] && [ "$manifest_status" != "$status" ]; then
            printf "  %-12s %-10s  manifest: %s; STATE: %s\n" "" "STALE" "$manifest_status" "$status"
        fi
        dirty="$(git_dirty_summary "$agent_dir")"
        if [ -n "$dirty" ]; then
            printf "  %-12s %-10s  git dirty: %s\n" "" "DIRTY" "$dirty"
        fi
    done < <(list_agent_ids "$role")
}

# Artisan is a singleton [artisan] table (not an array); worktree _artisan/.
print_artisan_block() {
    local wt enabled
    wt="$(status_resolve_container artisan "" "$PM_ROOT/_artisan")"   # DEC-035
    enabled="$(read_toml artisan enabled)"
    if [ "$enabled" != "true" ] && [ ! -d "$wt" ]; then
        printf "  %-12s %-10s\n" "artisan" "disabled"
        return
    fi
    local sf="$wt/STATE.md" status task last dirty
    status="$(state_field "$sf" "Status")"
    task="$(truncate_field "$(state_field "$sf" "Current task")" 100)"
    last="$(truncate_field "$(state_field "$sf" "Last activity")" 120)"
    printf "  %-12s %-10s  task: %s\n" "artisan" "$status" "$task"
    printf "  %-12s %-10s  last: %s\n" "" "" "$last"
    dirty="$(git_dirty_summary "$wt")"
    [ -n "$dirty" ] && printf "  %-12s %-10s  git dirty: %s\n" "" "DIRTY" "$dirty"
}

# Active lane from runtime/lane.lock (artisan | dock). Default: idle.
read_lane() {
    local lf="$PM_ROOT/runtime/lane.lock" lane
    if [ -f "$lf" ]; then
        lane="$(grep -oE '"lane"[[:space:]]*:[[:space:]]*"[^"]*"' "$lf" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
        [ -n "$lane" ] && { printf '%s (lane.lock held)' "$lane"; return; }
        printf 'held (unparseable lane.lock)'; return
    fi
    printf 'idle/dock (no lane.lock)'
}

# Observer request/result inbox counts + recent verdicts (schema-agnostic).
print_observer_io() {
    local req_dir="$PM_ROOT/runtime/observer/requests"
    local res_dir="$PM_ROOT/runtime/observer/results"
    local req=0 res=0
    [ -d "$req_dir" ] && req="$(find "$req_dir" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
    [ -d "$res_dir" ] && res="$(find "$res_dir" -maxdepth 1 -type f 2>/dev/null | wc -l | tr -d ' ')"
    printf "    pending requests: %s    results: %s\n" "$req" "$res"
    if [ -d "$res_dir" ]; then
        local f verdict
        while IFS= read -r f; do
            [ -f "$f" ] || continue
            verdict="$(grep -oE 'PASS_WITH_NOTES|REWORK_RECOMMENDED|NO_OPINION|PASS|BLOCK' "$f" 2>/dev/null | head -1)"
            printf "    - %s: %s\n" "$(basename "$f")" "${verdict:-?}"
        done < <(find "$res_dir" -maxdepth 1 -type f 2>/dev/null | sort | head -3)
    fi
}

# Format seconds-ago from an ISO timestamp.
format_ago() {
    local iso="$1"
    if command -v date >/dev/null 2>&1; then
        local epoch
        epoch="$(date -u -d "$iso" +%s 2>/dev/null || echo "")"
        if [ -n "$epoch" ]; then
            local now_e secs
            now_e="$(date -u +%s)"
            secs=$(( now_e - epoch ))
            if [ "$secs" -lt 60 ]; then echo "${secs}s ago"; return; fi
            if [ "$secs" -lt 3600 ]; then echo "$((secs / 60))m ago"; return; fi
            echo "$((secs / 3600))h ago"
            return
        fi
    fi
    echo "$iso"
}

# Print one summary line for PM or Dock by parsing the role's
# JSONL log for the most recent iteration_end / iteration_failed +
# preceding model_result.
print_driver_role_block() {
    local role="$1"
    local supervised="$2"  # "true" or "false" (only matters for pm)

    if [ "$role" = "pm" ] && [ "$supervised" = "false" ]; then
        printf "  %-12s %-10s  user-managed interactive session (driver supervise_pm = false)\n" "$role" "HYBRID"
        return
    fi

    local jsonl="$LOGS_DIR/$role.jsonl"
    if [ ! -f "$jsonl" ]; then
        printf "  %-12s %-10s  no iterations yet\n" "$role" "—"
        return
    fi

    # Tail last ~200 lines, scan for the most recent iteration_end /
    # iteration_failed and the most recent model_result line.
    local last_line
    last_line="$(tail -n 200 "$jsonl" 2>/dev/null | awk -F'"event":"' '
        /"event":"iteration_end"|"event":"iteration_failed"/ { end = $0 }
        /"event":"model_result"/ { result = $0 }
        END { print end "\n" result }
    ')"
    local end_line result_line
    end_line="$(echo "$last_line" | head -n 1)"
    result_line="$(echo "$last_line" | tail -n 1)"

    if [ -z "$end_line" ]; then
        printf "  %-12s %-10s  no completed iterations yet\n" "$role" "—"
        return
    fi

    local ts cost turns dur outcome
    ts="$(echo "$end_line" | sed -n 's/.*"ts":"\([^"]*\)".*/\1/p')"
    cost="$(echo "$end_line" | sed -n 's/.*"cost_usd":\([0-9.]*\).*/\1/p')"
    turns="$(echo "$end_line" | sed -n 's/.*"num_turns":\([0-9]*\).*/\1/p')"
    dur="$(echo "$end_line" | sed -n 's/.*"duration_ms":\([0-9]*\).*/\1/p')"
    if echo "$end_line" | grep -q '"iteration_failed"'; then
        outcome="FAILED"
    else
        outcome="OK"
    fi
    local ago dur_pretty cost_pretty
    ago="$(format_ago "$ts")"
    if [ -n "$dur" ] && [ "$dur" -gt 0 ]; then
        if [ "$dur" -lt 60000 ]; then
            dur_pretty="$((dur / 1000))s"
        else
            dur_pretty="$((dur / 60000))m$((dur / 1000 % 60))s"
        fi
    else
        dur_pretty="?"
    fi
    [ -n "$cost" ] && cost_pretty="\$${cost}" || cost_pretty="?"
    [ -z "$turns" ] && turns="?"

    printf "  %-12s %-10s  last iter: %s  cost %s  %s turns  duration %s\n" \
        "$role" "$outcome" "$ago" "$cost_pretty" "$turns" "$dur_pretty"

    if [ -n "$result_line" ]; then
        local result_raw result
        result_raw="$(echo "$result_line" | sed -n 's/.*"text":"\(.*\)".*/\1/p' | sed 's/\\n/ /g' | sed 's/\\"/"/g')"
        result="$(truncate_field "$result_raw" 140)"
        if [ -n "$result" ]; then
            printf "  %-12s %-10s  result: %s\n" "" "" "$result"
        fi
    fi
}

print_pm_section() {
    local pm="$1"
    setup_pm_paths "$pm"

    if [ ! -f "$CONFIG" ]; then
        echo "=== PM: $pm === (missing setup_config.toml — skipping)"
        return
    fi

    # Top-line liveness summary: RUNNING / STOPPED / SHUTTING_DOWN / STOPPED_DIRTY.
    local summary="STOPPED" dpid_alive=0 dpid_stale=0
    if [ -f "$DRIVER_PID_FILE" ]; then
        local raw
        raw="$(tr -d '[:space:]' < "$DRIVER_PID_FILE")"
        if [ -n "$raw" ] && pid_alive "$raw"; then
            dpid_alive=1
        elif [ -n "$raw" ]; then
            dpid_stale=1
        fi
    fi
    # Scan recent driver.jsonl for rate-limit events.
    local rate_limit_note=""
    if [ -f "$LOGS_DIR/driver.jsonl" ]; then
        local rl_count
        rl_count="$(tail -n 50 "$LOGS_DIR/driver.jsonl" 2>/dev/null | grep -cE '"event"[[:space:]]*:[[:space:]]*"(rate_limited|rate_limit_backoff|rate_limited_recorded)"' || true)"
        if [ "${rl_count:-0}" -gt 0 ]; then
            local latest_rl
            latest_rl="$(tail -n 50 "$LOGS_DIR/driver.jsonl" 2>/dev/null | grep -E '"event"[[:space:]]*:[[:space:]]*"(rate_limited|rate_limit_backoff|rate_limited_recorded)"' | tail -n 1)"
            local rl_ts
            rl_ts="$(printf '%s' "$latest_rl" | sed -n 's/.*"ts"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
            if [ -n "$rl_ts" ]; then
                local rl_ago
                rl_ago="$(format_ago "$rl_ts")"
                rate_limit_note=" — RATE_LIMITED ($rl_count hits in last 50 events, latest $rl_ago)"
            fi
        fi
    fi

    if [ "$dpid_alive" -eq 1 ] && [ -f "$DRIVER_DIR/stop" ]; then
        summary="SHUTTING_DOWN"
    elif [ "$dpid_alive" -eq 1 ] && [ -n "$rate_limit_note" ]; then
        summary="RUNNING${rate_limit_note}"
    elif [ "$dpid_alive" -eq 1 ]; then
        summary="RUNNING"
    elif [ "$dpid_stale" -eq 1 ]; then
        summary="STOPPED_DIRTY (stale pid file — see Driver below)"
    fi

    echo "=== PM: $pm — $summary ==="

    local proj target integration enabled supervise poll
    proj="$(read_toml project name)"
    target="$(read_toml branches target)"
    integration="$(read_toml branches integration)"
    enabled="$(read_toml autonomy enabled)"
    supervise="$(read_toml autonomy supervise_pm)"
    poll="$(read_toml autonomy driver_poll_interval_seconds)"

    echo "  Project: $proj"
    echo "  Target:  $target"
    echo "  Studio:  $integration"
    if [ "$enabled" = "true" ]; then
        if [ "$supervise" = "false" ]; then
            echo "  Mode:    autonomous (hybrid: PM interactive, others driver-supervised), poll=${poll:-30}s"
        else
            echo "  Mode:    autonomous (full: driver supervises all roles), poll=${poll:-30}s"
        fi
    else
        echo "  Mode:    classic (autonomy disabled, no driver)"
    fi

    echo ""
    echo "  --- Driver ---"
    if [ -f "$DRIVER_PID_FILE" ]; then
        local dpid
        dpid="$(cat "$DRIVER_PID_FILE" 2>/dev/null)"
        if [ -n "$dpid" ] && pid_alive "$dpid"; then
            echo "  Driver: alive (PID $dpid)"
        else
            echo "  Driver: STALE pid file (PID $dpid not alive — zombie marker, kill -9 / crash / power loss)"
        fi
    else
        echo "  Driver: not running"
    fi

    if [ -d "$PIDS_DIR" ]; then
        local running="" finished="" stale="" alive_n=0
        for f in "$PIDS_DIR"/*.pid; do
            [ -f "$f" ] || continue
            local name rp status branch hash short_hash
            name="$(basename "$f" .pid)"
            rp="$(pid_file_value "$f")"
            status="$(pid_file_field "$f" status)"
            branch="$(pid_file_field "$f" branch)"
            hash="$(pid_file_field "$f" assignment_hash)"
            short_hash=""
            [ -n "$hash" ] && short_hash=", assignment ${hash:0:12}"
            if [ -n "$rp" ] && pid_alive "$rp"; then
                running="$running $name(PID $rp${branch:+, $branch}$short_hash)"
                alive_n=$((alive_n + 1))
            elif [ "$status" = "finished" ]; then
                finished="$finished $name(finished)"
            elif [ -n "$rp" ]; then
                stale="$stale $name(STALE PID $rp)"
            fi
        done
        if [ -n "$running" ]; then
            echo "  Agent leases running:$running"
        else
            echo "  Agent leases running: (none right now)"
        fi
        [ -z "$finished" ] || echo "  Agent leases finished, pending driver cleanup:$finished"
        [ -z "$stale" ] || echo "  Agent leases stale:$stale"
        # Concurrency cap (DEC-027): how the budget looks right now.
        local cc_max
        cc_max="$(read_toml concurrency max_concurrent_agents)"
        [ -n "$cc_max" ] || cc_max=4
        if [ "$cc_max" = "0" ]; then
            echo "  Concurrency cap: disabled (0) — $alive_n detached agent(s) alive, no bound"
        else
            echo "  Concurrency cap: $alive_n / $cc_max detached agents alive (PM/Dock/merge-gate uncapped)"
        fi
        # Output control (DEC-028): enabled + latest-month over-budget ratio.
        local oc_enabled
        oc_enabled="$(read_toml output_control enabled)"
        if [ "$oc_enabled" = "false" ]; then
            echo "  Output control: disabled"
        else
            local latest_usage oc_total oc_over oc_default
            oc_default="$(read_toml output_control default_profile)"
            [ -n "$oc_default" ] || oc_default="compact"
            latest_usage="$(ls -1 "$DRIVER_DIR/usage"/*.jsonl 2>/dev/null | sort | tail -1)"
            if [ -n "$latest_usage" ] && [ -f "$latest_usage" ]; then
                oc_total="$(grep -c . "$latest_usage" 2>/dev/null || echo 0)"
                oc_over="$(grep -c '"over_budget":true' "$latest_usage" 2>/dev/null || echo 0)"
                echo "  Output control: enabled (default $oc_default); $(basename "$latest_usage" .jsonl) over soft budget: $oc_over / $oc_total iterations"
            else
                echo "  Output control: enabled (default $oc_default; no usage recorded yet)"
            fi
        fi
    fi

    echo ""
    echo "  --- PM ---"
    print_driver_role_block pm "${supervise:-true}"

    echo ""
    echo "  --- Dock ---"
    print_driver_role_block dock true

    echo ""
    echo "  --- Workers ---"
    print_role_block workers

    echo ""
    echo "  --- Scouts ---"
    print_role_block scouts

    echo ""
    echo "  --- Smiths ---"
    print_role_block smiths

    echo ""
    echo "  --- Artisan (lane: $(read_lane)) ---"
    print_artisan_block

    echo ""
    echo "  --- Librarians ---"
    print_role_block librarians

    echo ""
    echo "  --- Observers ---"
    print_role_block observers

    echo ""
    echo "  --- Guardians ---"
    print_role_block guardians

    echo ""
    echo "  --- Concierges ---"
    print_role_block concierges

    echo ""
    echo "  --- Observer requests/results ---"
    print_observer_io

    echo ""
    echo "  --- Backlog ---"
    manifest_section "Backlog summary" | sed -e 's/^/    /' -e '/^[[:space:]]*$/d'

    # Filesystem counters (DEC-008 + 0009): authoritative when manifest stale.
    local donedir="$PM_ROOT/runtime/backlog/done"
    local insp_dir="$PM_ROOT/control/inspections"
    local pm_inbox="$PM_ROOT/runtime/pm/inbox"
    local done_count=0 insp_count=0 intake_pending=0
    if [ -d "$donedir" ]; then
        done_count="$(find "$donedir" -maxdepth 1 -type f -name '*.md' 2>/dev/null | wc -l | tr -d ' ')"
    fi
    if [ -d "$insp_dir" ]; then
        insp_count="$(find "$insp_dir" -type f -name '*.md' ! -name 'README.md' ! -name '.gitkeep' 2>/dev/null | wc -l | tr -d ' ')"
    fi
    if [ -d "$pm_inbox" ]; then
        intake_pending="$(find "$pm_inbox" -maxdepth 1 -type f -name '*scout-intake*.md' 2>/dev/null | wc -l | tr -d ' ')"
    fi
    printf '    Tasks done (runtime/backlog/done/):           %s\n' "$done_count"
    printf '    Inspections committed (control/inspections/): %s\n' "$insp_count"
    printf '    Scout intake pending in PM inbox:             %s\n' "$intake_pending"
    print_smith_hardening_counters

    echo ""
    echo "  --- Active milestones ---"
    manifest_section "Active milestones" | sed -e 's/^/    /' -e '/^[[:space:]]*$/d'

    echo ""
    echo "  --- Open escalations ---"
    manifest_section "Open escalations" | sed -e 's/^/    /' -e '/^[[:space:]]*$/d'

    echo ""
    echo "  --- Recent activity (manifest, latest 5, truncated) ---"
    # Dock LLM tends to write very long bullets (verbose narrative).
    # Show only the most recent 5 bullets, truncated to 160 chars each.
    # Full content lives in runtime/manifest.md.
    activity="$(manifest_section "Recent activity" | grep -E '^[[:space:]]*[-*][[:space:]]' | head -n 5)"
    if [ -z "$activity" ]; then
        echo "    (none)"
    else
        echo "$activity" | awk '{
            line = $0
            sub(/^[ \t]+/, "", line)
            if (length(line) > 160) {
                printf "    %s...\n", substr(line, 1, 157)
            } else {
                printf "    %s\n", line
            }
        }'
        total="$(manifest_section "Recent activity" | grep -cE '^[[:space:]]*[-*][[:space:]]')"
        if [ "$total" -gt 5 ]; then
            echo "    (... see __garelier/<pm_id>/runtime/manifest.md for full history)"
        fi
    fi

    echo ""
    echo "  --- driver log (last 8 lines of meaningful events) ---"
    local shown=""
    for candidate in "$LOGS_DIR/driver.stdout.log" "$LOGS_DIR/driver.jsonl" "$LOGS_DIR/driver.log"; do
        if [ -f "$candidate" ]; then
            echo "    (source: ${candidate#$PROJECT_ROOT/})"
            tail -n 8 "$candidate" | sed 's/^/    /'
            shown="yes"
            break
        fi
    done
    if [ -z "$shown" ]; then
        echo "    (driver never started for this PM)"
    fi

    # Heartbeat: driver.stdout.log only updates on info-level events
    # (iteration_start/end, merge_gate_spawned, etc). The driver may be alive
    # and polling every poll_seconds while stdout.log stays silent for tens of
    # minutes. Show driver.jsonl's last line so the operator can see the actual
    # poll heartbeat. Mirrors status.ps1.
    if [ -f "$LOGS_DIR/driver.jsonl" ]; then
        local last_jsonl hb_ts hb_event hb_source hb_ago
        last_jsonl="$(tail -n 1 "$LOGS_DIR/driver.jsonl" 2>/dev/null)"
        if [ -n "$last_jsonl" ]; then
            hb_ts="$(printf '%s' "$last_jsonl" | sed -n 's/.*"ts"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
            hb_event="$(printf '%s' "$last_jsonl" | sed -n 's/.*"event"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
            hb_source="$(printf '%s' "$last_jsonl" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
            if [ -n "$hb_ts" ]; then
                hb_ago="$(format_ago "$hb_ts")"
                echo "    heartbeat: $hb_ago — ${hb_event:-?} (${hb_source:-?})"
            fi
        fi
    fi
}

print_status() {
    local now
    now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

    echo "=== Garelier Status — $now ==="
    echo "Root: $PROJECT_ROOT"
    echo ""

    local pms=()
    if [ -n "$PM_ID" ]; then
        pms=("$PM_ID")
    else
        while IFS= read -r p; do
            [ -z "$p" ] && continue
            pms+=("$p")
        done < <(discover_pms)
    fi

    if [ "${#pms[@]}" -eq 0 ]; then
        echo "No Garelier PMs found under $GARELIER_ROOT."
        echo "Run setup_wizard to initialize a PM."
        return
    fi

    local first=1
    for pm in "${pms[@]}"; do
        if [ "$first" -eq 0 ]; then echo ""; fi
        first=0
        print_pm_section "$pm"
    done
}

if [ -n "$WATCH" ]; then
    # Validate WATCH is a positive integer.
    case "$WATCH" in
        ''|*[!0-9]*) echo "Error: --watch requires a positive integer" >&2; exit 1 ;;
    esac
    while true; do
        clear
        print_status
        sleep "$WATCH"
    done
else
    print_status
fi
