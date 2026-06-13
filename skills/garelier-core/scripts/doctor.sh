#!/usr/bin/env bash
#
# Garelier Doctor (bash) — health check for one PM's install.
#
# Read-only inspection. Detects setup breakage, placeholder leakage,
# dangerous configuration, and Guardian-report secret leakage (G-14) BEFORE
# dispatch runs work. Never mutates state (never deletes lane.lock,
# pid files, or anything else).
#
# Findings are grouped by severity:
#   P0  blocking   — must be fixed before dispatching work
#   P1  warning    — likely wrong / stale; start proceeds
#   P2  advisory   — informational
#
# Exit code: 1 if any P0 finding exists; 0 otherwise (P1/P2 only warn).
#
# Usage: doctor.sh [--pm-id <id>] [--project <path>] [<pm_id>]
#
# pm_id resolution mirrors status.sh:
#   1. --pm-id flag (or positional)
#   2. $GARELIER_PM_ID
#   3. cwd inference (walk up from __garelier/<pm_id>/...)
#   4. single-PM autodetect under __garelier/
#

set -euo pipefail

# Expected repo version. Bump this per release (canonical copy: VERSION).
EXPECTED_VERSION="2.6.4"

PROJECT_ROOT=""
PM_ID=""

usage() {
    cat <<'EOF'
Usage: doctor.sh [--pm-id <id>] [--project <path>] [<pm_id>]

Options:
  --pm-id <id>       PM identifier to inspect. Required when more than one
                     PM exists under __garelier/ (unless $GARELIER_PM_ID
                     is set or cwd is inside a PM dir).
  --project <path>   Project root (default: current working directory).
  -h, --help         Show this help.

Exit code is 1 if any P0 (blocking) finding exists, else 0.
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
            else echo "Unexpected positional argument: $1" >&2; exit 1
            fi
            shift
            ;;
    esac
done

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd -P)}"

# Walk up if cwd is inside __garelier/<pm_id>/... (mirror status.sh).
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

# pm_id resolution: env var, then cwd inference, then single-PM autodetect.
if [ -z "$PM_ID" ]; then
    PM_ID="${GARELIER_PM_ID:-}"
fi
if [ -z "$PM_ID" ]; then
    # cwd inference: are we inside __garelier/<pm_id>/...?
    case "$(pwd -P)/" in
        "$GARELIER_ROOT"/*)
            rel="${PWD#$GARELIER_ROOT/}"
            PM_ID="${rel%%/*}"
            ;;
    esac
fi
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
        0) echo "Error: No Garelier PM initialized under $GARELIER_ROOT; run setup_wizard." >&2; exit 1 ;;
        1) PM_ID="${pm_candidates[0]}" ;;
        *)
            echo "Error: multiple PMs found under $GARELIER_ROOT — pass --pm-id <id>." >&2
            for p in "${pm_candidates[@]}"; do echo "         - $p" >&2; done
            exit 1
            ;;
    esac
fi

PM_ROOT="$GARELIER_ROOT/$PM_ID"
CONFIG="$PM_ROOT/_pm/setup_config.toml"
AGENTS_FILE="$PROJECT_ROOT/AGENTS.md"

if [ ! -f "$CONFIG" ]; then
    echo "Error: PM '$PM_ID' not found: $CONFIG missing." >&2
    exit 1
fi

# === Findings accumulator ===
P0_FINDINGS=()
P1_FINDINGS=()
P2_FINDINGS=()

add_finding() {
    local sev="$1" check="$2" detail="$3" fix="$4"
    local line="[$sev] $check: $detail — fix: $fix"
    case "$sev" in
        P0) P0_FINDINGS+=("$line") ;;
        P1) P1_FINDINGS+=("$line") ;;
        P2) P2_FINDINGS+=("$line") ;;
    esac
}

# === TOML helpers (copied from status.sh) ===

# Read a single scalar key from a [section]. Strips quotes and trailing comment.
read_toml() {
    local section="$1" key="$2"
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

# True if [section] exists at all.
toml_section_present() {
    local section="$1"
    awk -v sec="$section" '
        $0 == "[" sec "]" { found = 1; exit }
        END { exit (found ? 0 : 1) }
    ' "$CONFIG"
}

# Print the raw RHS of `key = ...` inside [section] (may be multi-line array).
# Used to inspect array bodies like commands = [...] and *_paths = [...].
# Returns everything from the key line through the closing bracket.
toml_array_body() {
    local section="$1" key="$2"
    awk -v sec="$section" -v k="$key" '
        BEGIN { in_section = 0; capture = 0 }
        $0 == "[" sec "]" { in_section = 1; next }
        /^\[/ { if (capture) exit; in_section = 0 }
        in_section && !capture && $0 ~ "^" k "[[:space:]]*=" {
            capture = 1
            print
            # single-line array closes on same line
            if ($0 ~ /\]/) exit
            next
        }
        capture {
            print
            if ($0 ~ /\]/) exit
        }
    ' "$CONFIG"
}

# Count non-comment, non-empty string elements inside an array body.
toml_array_count() {
    local section="$1" key="$2"
    toml_array_body "$section" "$key" | awk '
        {
            line = $0
            sub(/^[^=]*=/, "", line)       # drop "key =" on first line only matters loosely
        }
        {
            s = $0
            sub(/#.*$/, "", s)             # strip comments
        }
        {
            # count quoted string elements on this line
            while (match(s, /"[^"]*"/)) {
                n++
                s = substr(s, RSTART + RLENGTH)
            }
        }
        END { print n + 0 }
    '
}

# List [[section]] ids (copied from status.sh).
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

# Print the worktree value belonging to a given id within [[section]] blocks.
agent_worktree_for_id() {
    local section="$1" want_id="$2"
    awk -v sec="$section" -v want="$want_id" '
        BEGIN { in_section = 0; cur_id = ""; cur_wt = "" }
        function flush() {
            if (cur_id == want && cur_wt != "") { print cur_wt; found = 1 }
        }
        $0 == "[[" sec "]]" { if (in_section) flush(); in_section = 1; cur_id=""; cur_wt=""; next }
        /^\[/ { if (in_section) { flush(); in_section = 0 } }
        in_section && /^id[[:space:]]*=/ {
            match($0, /"[^"]*"/); cur_id = substr($0, RSTART+1, RLENGTH-2)
        }
        in_section && /^worktree[[:space:]]*=/ {
            match($0, /"[^"]*"/); cur_wt = substr($0, RSTART+1, RLENGTH-2)
        }
        END { if (in_section && !found) flush() }
    ' "$CONFIG"
}

# DEC-035: a role's container may live in a machine-local home OUTSIDE the
# project; the gitignored pointer records its absolute path. Resolve to that when
# present, else fall back to the in-proj relative worktree (project-root joined).
ws_pointer_key_d() {  # plural-role id -> "<role>.<id>" (or "artisan")
    local r
    case "$1" in
        workers) r=worker ;; scouts) r=scout ;; smiths) r=smith ;;
        librarians) r=librarian ;; observers) r=observer ;;
        guardians) r=guardian ;; concierges) r=concierge ;;
        artisan) r=artisan ;; *) r="${1%s}" ;;
    esac
    if [ "$1" = artisan ]; then printf 'artisan'; else printf '%s.%s' "$r" "$2"; fi
}

doctor_resolve_container() {  # plural-role id in-proj-relative-wt -> absolute container
    local pf key v
    pf="$PROJECT_ROOT/__garelier/$PM_ID/runtime/workspace_paths"
    key="$(ws_pointer_key_d "$1" "$2")"
    if [ -f "$pf" ]; then
        v="$(awk -v k="$key" 'index($0, k"=")==1 { print substr($0, length(k)+2); exit }' "$pf")"
        if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
    fi
    printf '%s/%s' "$PROJECT_ROOT" "$3"
}

# DEC-035: the RESOLVED absolute container for every configured id of a role.
# Security scans (concierge push-guard, report-leak) must walk these, not the
# in-project `_<role>/*` glob, which is empty once the role is exiled.
resolved_role_containers() {  # plural-role -> newline list of abs containers
    local role="$1" id wt
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        wt="$(agent_worktree_for_id "$role" "$id")"
        [ -z "$wt" ] && wt="__garelier/$PM_ID/_${role}/$id"
        # doctor_resolve_container prints with no trailing newline; add one so the
        # `while read` consumers below get a terminated line per container.
        printf '%s\n' "$(doctor_resolve_container "$role" "$id" "$wt")"
    done < <(list_agent_ids "$role")
}

# Print the bare-bool `checkout` value for a given id within [[section]] blocks
# (DEC-021; empty if unset → caller treats as the default true).
agent_checkout_for_id() {
    local section="$1" want_id="$2"
    awk -v sec="$section" -v want="$want_id" '
        BEGIN { in_section = 0; cur_id = ""; cur_co = "" }
        function flush() {
            if (cur_id == want && cur_co != "") { print cur_co; found = 1 }
        }
        $0 == "[[" sec "]]" { if (in_section) flush(); in_section = 1; cur_id=""; cur_co=""; next }
        /^\[/ { if (in_section) { flush(); in_section = 0 } }
        in_section && /^id[[:space:]]*=/ {
            match($0, /"[^"]*"/); cur_id = substr($0, RSTART+1, RLENGTH-2)
        }
        in_section && /^checkout[[:space:]]*=/ {
            v = $0; sub(/^checkout[[:space:]]*=[[:space:]]*/, "", v); gsub(/[[:space:]]/, "", v); cur_co = v
        }
        END { if (in_section && !found) flush() }
    ' "$CONFIG"
}

pid_alive() { kill -0 "$1" 2>/dev/null; }

# Extract numeric pid or "pid"/"child_pid" json value from a file's content.
pid_from_file() {
    local file="$1" raw
    raw="$(cat "$file" 2>/dev/null || true)"
    if printf '%s' "$raw" | grep -Eq '^[[:space:]]*[0-9]+[[:space:]]*$'; then
        printf '%s' "$raw" | tr -d '[:space:]'
        return 0
    fi
    printf '%s\n' "$raw" \
        | grep -oE '"(pid|child_pid)"[[:space:]]*:[[:space:]]*[0-9]+' \
        | grep -oE '[0-9]+' \
        | head -1
}

json_string_field() {
    local file="$1" field="$2"
    grep -oE "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$file" 2>/dev/null \
        | head -1 \
        | sed -E "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/"
}

# === Checks ===

# --- 1. Placeholder leakage (P0) ---
if grep -q '{{' "$CONFIG" 2>/dev/null; then
    sample="$(grep -oE '\{\{[^}]*\}\}' "$CONFIG" | sort -u | head -3 | tr '\n' ' ')"
    add_finding P0 "placeholder-leak" \
        "unresolved {{...}} marker in setup_config.toml ($sample)" \
        "re-run setup_wizard to substitute placeholders"
fi
if [ ! -f "$AGENTS_FILE" ]; then
    add_finding P0 "agents-missing" \
        "AGENTS.md not found at project root ($AGENTS_FILE)" \
        "every role reads AGENTS.md for project-specific rules; create it (re-run setup_wizard from __garelier/ with GARELIER_CORE_TEMPLATES_DIR set, or copy skills/garelier-core/templates/agents.md and fill it in)"
elif grep -q '{{' "$AGENTS_FILE" 2>/dev/null; then
    sample="$(grep -oE '\{\{[^}]*\}\}' "$AGENTS_FILE" | sort -u | head -3 | tr '\n' ' ')"
    add_finding P0 "placeholder-leak" \
        "unresolved {{...}} marker in AGENTS.md ($sample)" \
        "edit AGENTS.md and fill the remaining project-specific fields (restricted files, conventions); re-running setup_wizard will NOT fill these (it skips an existing AGENTS.md)"
fi

# --- 2/3. Quality gate (P0) + stack/rust-default mismatch (P1) ---
qg_stack="$(read_toml quality_gate stack)"
qg_cmd_count="$(toml_array_count quality_gate commands)"
qg_body="$(toml_array_body quality_gate commands)"
qg_full_cmd_count="$(toml_array_count quality_gate.full commands)"
qg_full_body="$(toml_array_body quality_gate.full commands)"
qg_effective_cmd_count="$qg_cmd_count"
qg_effective_body="$qg_body"
if [ "$qg_full_cmd_count" -gt 0 ]; then
    qg_effective_cmd_count="$qg_full_cmd_count"
    qg_effective_body="$qg_full_body"
fi
recognized_stack=0
case "$qg_stack" in
    rust|typescript|python|go) recognized_stack=1 ;;
esac

if ! toml_section_present quality_gate; then
    add_finding P0 "quality-gate" \
        "[quality_gate] section missing" \
        "add [quality_gate] with stack or commands (see setup_config.toml template)"
elif [ "$qg_stack" = "custom" ] && [ "$qg_effective_cmd_count" -eq 0 ]; then
    add_finding P0 "quality-gate" \
        "stack = \"custom\" but full commands list is empty" \
        "fill in [quality_gate] commands or [quality_gate.full] commands (custom stack requires explicit full commands)"
elif [ "$qg_effective_cmd_count" -eq 0 ] && [ "$recognized_stack" -eq 0 ]; then
    add_finding P0 "quality-gate" \
        "no commands and unrecognized stack '${qg_stack:-<unset>}'" \
        "set stack to rust/typescript/python/go, or list explicit full commands"
fi

# Rust-default-but-non-rust-stack heuristic (P1).
if [ "$qg_effective_cmd_count" -gt 0 ] && [ -n "$qg_stack" ] && [ "$qg_stack" != "rust" ]; then
    if printf '%s' "$qg_effective_body" | grep -qE '"\s*cargo[ "]'; then
        add_finding P1 "quality-gate-stale" \
            "commands still use 'cargo ...' but stack = \"$qg_stack\"" \
            "replace the Rust default commands with ones for your stack"
    fi
fi

# --- 4. Dangerous permission profile (P1) ---
perm_profile="$(read_toml permissions profile)"
if [ "$perm_profile" = "dangerous" ]; then
    add_finding P1 "permissions-dangerous" \
        "[permissions] profile = \"dangerous\" (full provider access)" \
        "confirm this is a deliberate isolated autonomous run; else use reviewed/safe"
fi

# --- 5. Protected paths unset (P2) ---
if toml_section_present permissions; then
    approval_count="$(toml_array_count permissions require_pm_approval_paths)"
    if [ "$approval_count" -eq 0 ]; then
        add_finding P2 "protected-paths" \
            "[permissions] require_pm_approval_paths is empty/absent" \
            "list sensitive globs (.env*, infra/**, migrations/**, deploy/**) to gate PM approval"
    fi
fi

# --- 5b. Jig mode configured (DEC-062 Phase 1) (P2) ---
jig_enabled="$(read_toml jig enabled)"
if [ "$jig_enabled" = "false" ]; then
    add_finding P2 "jig-mode"         "[jig] enabled = false — jig is DEFAULT-ON (DEC-062 amended 2026-06-11); this is an explicit opt-out"         "the Mode D prose tick operates; remove the key (or set true) to run templates/jig_tick.workflow.js per tick"
fi

# --- 5c. Jig Smith-window knowledge dependency (DEC-069/071) ---
# The jig SMITH phase hands the producer the ordered views in
# docs/garelier/quality/integration_hardening_views.md. Producers silently
# skip a missing read, so a project seeded BEFORE that template existed runs
# window batches without the views and nothing notices (surfaced live
# 2026-06-12). Jig is default-on and smith_batch_every defaults to 5, so the
# check applies unless either is explicitly disabled.
jig_smith_every="$(read_toml jig smith_batch_every)"
if [ "$jig_enabled" != "false" ] && [ "$jig_smith_every" != "0" ] \
   && [ -d "$PROJECT_ROOT/docs/garelier" ] \
   && [ ! -f "$PROJECT_ROOT/docs/garelier/quality/integration_hardening_views.md" ]; then
    add_finding P1 "jig-smith-views-missing" \
        "jig Smith window is active but docs/garelier/quality/integration_hardening_views.md is not seeded — window batches run without the V1-V7 views" \
        "seed it from garelier-librarian/templates/quality/integration_hardening_views.md (knowledge-sync Librarian dispatch), or set [jig] smith_batch_every = 0 to disable the window"
fi

# --- 6. Role container layout (P1 only when half-created) ---
# DEC-065 dispatch-native: a configured seat with NO container is the healthy
# default — roster entries are seat defaults (model routing); producers run in
# ephemeral _dispatch<N>/ homes. A container that EXISTS but has no checkout/
# is half-created and still flagged. Stray _<role>/<id> dirs with no config
# entry are flagged below.
declare -A CONFIGURED_DIRS=()

check_role_table() {
    local table="$1" role_dir="$2"
    local id wt
    while IFS= read -r id; do
        [ -z "$id" ] && continue
        wt="$(agent_worktree_for_id "$table" "$id")"
        [ -z "$wt" ] && wt="__garelier/$PM_ID/$role_dir/$id"
        # DEC-035: resolve the (possibly exiled) container via the pointer.
        local abs; abs="$(doctor_resolve_container "$table" "$id" "$wt")"
        CONFIGURED_DIRS["$(basename "$wt")@$role_dir"]=1
        if [ ! -d "$abs" ]; then
            : # dispatch-native default (DEC-065): seat declared, no container.
        elif [ ! -d "$abs/checkout" ]; then
            # DEC-021: a read-only role with checkout=false has no worktree by design.
            if [ "$(agent_checkout_for_id "$table" "$id")" != "false" ]; then
                add_finding P1 "worktree-layout" \
                    "[[$table]] id '$id' container exists but has no checkout/ worktree: $abs" \
                    "remove the leftover container, or recreate the seat home via diff mode (remove the seat, then re-add it)"
            fi
        fi
    done < <(list_agent_ids "$table")
}

check_role_table workers    _workers
check_role_table scouts     _scouts
check_role_table smiths     _smiths
check_role_table librarians _librarians
check_role_table observers  _observers
check_role_table guardians  _guardians
check_role_table concierges _concierges

# Artisan (single [artisan] block, gated by enabled = true).
artisan_enabled="$(read_toml artisan enabled)"
if [ "$artisan_enabled" = "true" ]; then
    artisan_id="$(read_toml artisan id)"
    artisan_wt="$(read_toml artisan worktree)"
    [ -z "$artisan_wt" ] && artisan_wt="__garelier/$PM_ID/_artisan"
    CONFIGURED_DIRS["$(basename "$artisan_wt")@_artisan"]=1
    artisan_abs="$(doctor_resolve_container artisan "" "$artisan_wt")"   # DEC-035
    # DEC-065: an enabled artisan lane with no container is the dispatch-native
    # default; only a half-created container (no checkout/) is flagged.
    if [ -d "$artisan_abs" ] && [ ! -d "$artisan_abs/checkout" ]; then
        add_finding P1 "worktree-layout" \
            "[artisan] container exists but has no checkout/ worktree: $artisan_abs" \
            "remove the leftover container, or recreate the seat home via diff mode (remove the seat, then re-add it)"
    fi
fi

# Guardian policy enabled but no [[guardians]] defined (DEC-024): the security
# gate would be mandatory with no Guardian to satisfy it.
guardian_policy_enabled="$(read_toml guardian_policy enabled)"
if [ "$guardian_policy_enabled" = "true" ]; then
    guardian_n="$(list_agent_ids guardians | grep -c . || true)"
    if [ "${guardian_n:-0}" -eq 0 ]; then
        add_finding P0 "guardian-policy" \
            "[guardian_policy] enabled = true but no [[guardians]] are defined — the security gate is mandatory with no Guardian to satisfy it" \
            "add a [[guardians]] block, or set [guardian_policy].enabled = false"
    fi
fi

# Concierge policy enabled but no [[concierges]] (DEC-025), and the external-
# write safety guards must not be disabled while enabled.
concierge_policy_enabled="$(read_toml concierge_policy enabled)"
if [ "$concierge_policy_enabled" = "true" ]; then
    concierge_n="$(list_agent_ids concierges | grep -c . || true)"
    if [ "${concierge_n:-0}" -eq 0 ]; then
        add_finding P0 "concierge-policy" \
            "[concierge_policy] enabled = true but no [[concierges]] are defined — external operations are enabled with no Concierge to run them" \
            "add a [[concierges]] block, or set [concierge_policy].enabled = false"
    fi
    # Footguns: these guard external writes and must stay on when enabled.
    for cflag in require_pm_approval require_user_instruction_for_write require_guardian_before_external_write forbid_push_garelier_branches forbid_force_push forbid_blind_git_pull; do
        if [ "$(read_toml concierge_policy "$cflag")" = "false" ]; then
            add_finding P0 "concierge-safety" \
                "[concierge_policy].$cflag = false weakens an external-write safety guard" \
                "set [concierge_policy].$cflag = true (it guards against unapproved / destructive external writes)"
        fi
    done
    # Mechanical push guard (DEC-030): every existing Concierge worktree must have
    # the pre-push hook installed (per-worktree core.hooksPath pointing at a dir
    # that contains pre-push). Without it, the garelier/* + force-push bans are
    # prompt-only. The Concierge installs it at pickup (install_concierge_guards).
    # DEC-035: resolve each Concierge container (it may be exiled outside the
    # project) so an exiled Concierge missing its push guard is still caught.
    while IFS= read -r ccontainer; do
        [ -z "$ccontainer" ] && continue
        cdir="$ccontainer/checkout"
        [ -e "$cdir/.git" ] || continue
        hp="$(git -C "$cdir" config --get core.hooksPath 2>/dev/null || true)"
        if [ -z "$hp" ] || [ ! -f "$hp/pre-push" ]; then
            add_finding P0 "concierge-push-guard" \
                "Concierge worktree ${cdir#"$PROJECT_ROOT"/} has no mechanical push guard (core.hooksPath -> a dir with pre-push)" \
                "run garelier install-concierge-guards \"$cdir\" (DEC-030); the Concierge does this at pickup"
        fi
    done < <(resolved_role_containers concierges)
fi

# Provider permission verification on write roles (DEC-033). Gemini/Cursor are
# first-class: their permission profiles ARE wired to CLI flags (Gemini approval-
# mode + sandbox, Cursor --force), but those flags are version-sensitive. So when
# a write/external role uses them, nudge the user to verify the flags for their
# installed CLI via the provider smoke (advisory, not a restriction).
risky_provider_in_table() {
    awk -v sec="$1" '
        $0 == "[[" sec "]]" { inblk=1; next }
        /^\[/ { inblk=0 }
        inblk && $0 ~ /^[[:space:]]*provider[[:space:]]*=/ {
            v=$0; sub(/^[^=]*=[[:space:]]*/,"",v); gsub(/[" ]/,"",v);
            if (v ~ /gemini|cursor/) print v;
        }
    ' "$CONFIG" | sort -u | tr '\n' ' '
}
for sec in workers smiths concierges; do
    rp="$(risky_provider_in_table "$sec")"
    if [ -n "$(printf '%s' "$rp" | tr -d ' ')" ]; then
        add_finding P2 "provider-verify" \
            "[[$sec]] uses $rp on a write/external role; its permission flags (DEC-033) are wired but version-sensitive" \
            "verify the CLI works by running it once manually; if a flag is rejected, set GARELIER_PROVIDER_<KIND>_PERMISSION=off"
    fi
done
sol_provider="$(read_toml artisan provider)"
if printf '%s' "$sol_provider" | grep -qiE 'gemini|cursor'; then
    add_finding P2 "provider-verify" \
        "[artisan] uses $sol_provider and integrates its own satchel into studio; its permission flags (DEC-033 / DEC-045) are version-sensitive" \
        "verify with the provider smoke before relying on it; GARELIER_PROVIDER_<KIND>_PERMISSION=off falls back if a flag is rejected"
fi

# Guardian report output safety (G-14, P0, DEC-024): a Guardian report is
# pointer-only / redacted by rule — evidence must NEVER be the raw value, so
# the report cannot itself become the leak. Scan the Guardian report areas for
# unambiguous secret-value formats (private keys, cloud/provider tokens, JWTs).
# These never appear in a correctly redacted report; placeholders like
# {{...}} / [REDACTED] / pointers do not match. All scanned paths are
# gitignored, but a local leak is still a leak the moment it is read or
# accidentally committed. High-confidence formats only, to avoid false P0s.
SECRET_RE='-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|gh[posru]_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+|sk-[A-Za-z0-9]{32,}'
for gfile in \
    "$PM_ROOT"/_guardians/*/guardian_report.md \
    "$PM_ROOT"/_guardians/*/checkout/guardian_report.md \
    "$PM_ROOT"/runtime/guardian/results/* \
    "$PM_ROOT"/runtime/guardian/inbox/*; do
    [ -f "$gfile" ] || continue
    # -e is required: the regex starts with '-----BEGIN', which grep would
    # otherwise parse as options.
    if grep -Eq -e "$SECRET_RE" "$gfile" 2>/dev/null; then
        add_finding P0 "guardian-report-leak" \
            "Guardian report appears to contain an unredacted secret-like value: ${gfile#"$PROJECT_ROOT"/}" \
            "redact to pointer-only per the report's REDACTION RULE; if the value is real, rotate it immediately"
    fi
done
# DEC-035: also scan reports in exiled Guardian containers (outside the project).
while IFS= read -r gc; do
    [ -z "$gc" ] && continue
    for gfile in "$gc/guardian_report.md" "$gc/checkout/guardian_report.md"; do
        [ -f "$gfile" ] || continue
        if grep -Eq -e "$SECRET_RE" "$gfile" 2>/dev/null; then
            add_finding P0 "guardian-report-leak" \
                "Guardian report appears to contain an unredacted secret-like value: $gfile" \
                "redact to pointer-only per the report's REDACTION RULE; if the value is real, rotate it immediately"
        fi
    done
done < <(resolved_role_containers guardians)

# Concierge report output safety (P0, DEC-025): concierge_report.md is
# pointer-only / redacted like a Guardian report — it must never carry a raw
# secret. Same high-confidence scan, reusing SECRET_RE.
for cfile in \
    "$PM_ROOT"/_concierges/*/concierge_report.md \
    "$PM_ROOT"/_concierges/*/checkout/concierge_report.md \
    "$PM_ROOT"/runtime/concierge/results/* \
    "$PM_ROOT"/runtime/concierge/inbox/*; do
    [ -f "$cfile" ] || continue
    if grep -Eq -e "$SECRET_RE" "$cfile" 2>/dev/null; then
        add_finding P0 "concierge-report-leak" \
            "Concierge report appears to contain an unredacted secret-like value: ${cfile#"$PROJECT_ROOT"/}" \
            "redact to pointer-only per the report's redaction rule; if the value is real, rotate it immediately"
    fi
done
# DEC-035: also scan reports in exiled Concierge containers (outside the project).
while IFS= read -r cc; do
    [ -z "$cc" ] && continue
    for cfile in "$cc/concierge_report.md" "$cc/checkout/concierge_report.md"; do
        [ -f "$cfile" ] || continue
        if grep -Eq -e "$SECRET_RE" "$cfile" 2>/dev/null; then
            add_finding P0 "concierge-report-leak" \
                "Concierge report appears to contain an unredacted secret-like value: $cfile" \
                "redact to pointer-only per the report's redaction rule; if the value is real, rotate it immediately"
        fi
    done
done < <(resolved_role_containers concierges)

# Stray on-disk role dirs without a config entry.
for role_dir in _workers _scouts _smiths _librarians _observers _guardians _concierges; do
    base="$PM_ROOT/$role_dir"
    [ -d "$base" ] || continue
    for d in "$base"/*/; do
        [ -d "$d" ] || continue
        name="$(basename "$d")"
        if [ -z "${CONFIGURED_DIRS["$name@$role_dir"]:-}" ]; then
            add_finding P1 "stray-worktree" \
                "$role_dir/$name exists on disk but has no config entry" \
                "add a config block for '$name', or remove the stale worktree (git worktree remove)"
        fi
    done
done

# --- 7. Stale lane.lock (P1) ---
LANE_LOCK="$PM_ROOT/runtime/lane.lock"
if [ -f "$LANE_LOCK" ]; then
    lane_pid="$(pid_from_file "$LANE_LOCK")"
    lane_owner="$(json_string_field "$LANE_LOCK" owner)"
    if [ -n "$lane_pid" ] && ! pid_alive "$lane_pid"; then
        add_finding P1 "stale-lane-lock" \
            "lane.lock owner '${lane_owner:-?}' pid $lane_pid is not alive" \
            "verify no role is mid-lane, then clear lane.lock via PM (doctor never deletes it)"
    fi
fi

# --- 7b. Stale Concierge external lock (P1, DEC-025) ---
# A Concierge that crashed mid external operation may leave a target-scoped lock
# held under runtime/concierge/locks/. A live Concierge reclaims a dead-pid lock
# at pickup (SKILL §5/§10.5), but surface it so PM can reconcile (confirm whether
# the push/PR/release landed).
EXTERNAL_LOCK_DIR="$PM_ROOT/runtime/concierge/locks"
if [ -d "$EXTERNAL_LOCK_DIR" ]; then
    for lk in "$EXTERNAL_LOCK_DIR"/*.lock; do
        [ -f "$lk" ] || continue
        ext_pid="$(pid_from_file "$lk")"
        ext_op="$(json_string_field "$lk" operation_kind)"
        ext_req="$(json_string_field "$lk" request_id)"
        if [ -n "$ext_pid" ] && ! pid_alive "$ext_pid"; then
            add_finding P1 "stale-external-lock" \
                "concierge lock ${lk##*/} (${ext_req:-?}, ${ext_op:-?}) pid $ext_pid is not alive" \
                "a Concierge crashed holding the lock; on pickup it reconciles (SKILL §10.5) — verify the external operation's actual state before clearing"
        fi
    done
fi

# --- 7c. Provider CLI availability (P1, DEC-026) ---
# For each provider actually referenced in the config, check its CLI is on PATH
# so a configured-but-missing provider surfaces before dispatch trusts it. A
# per-provider command override (GARELIER_PROVIDER_<KIND>_CMD) is honored.
if [ -f "$CONFIG" ]; then
    used_providers="$(grep -v '^[[:space:]]*#' "$CONFIG" \
        | grep -oE 'provider[[:space:]]*=[[:space:]]*"[a-z-]+"' \
        | grep -oE '"[a-z-]+"' | tr -d '"' | sort -u)"
    for p in $used_providers; do
        case "$p" in
            claude-code) pbin="claude" ;;
            codex-cli)   pbin="codex" ;;
            gemini-cli)  pbin="gemini" ;;
            copilot-cli) pbin="copilot" ;;
            cursor-cli)  pbin="cursor-agent" ;;
            *) continue ;;
        esac
        envkey="GARELIER_PROVIDER_$(printf '%s' "$p" | tr 'a-z-' 'A-Z_')_CMD"
        [ -n "${!envkey:-}" ] && continue   # overridden — can't resolve here, trust it
        avail=0
        if [ "$p" = "cursor-cli" ]; then
            if command -v cursor-agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1; then avail=1; fi
        elif command -v "$pbin" >/dev/null 2>&1; then
            avail=1
        fi
        if [ "$avail" -eq 0 ]; then
            add_finding P1 "provider-unavailable" \
                "provider '$p' is configured but its CLI ('$pbin') is not on PATH" \
                "install the $p CLI, set $envkey / a per-agent provider_command, or remove agents using it"
        fi
    done
fi

# --- 9. Version mismatch (P2) ---
cfg_version="$(read_toml project garelier_version)"
if [ -n "$cfg_version" ] && [ "$cfg_version" != "$EXPECTED_VERSION" ]; then
    add_finding P2 "version-mismatch" \
        "setup_config.toml garelier_version = $cfg_version, expected $EXPECTED_VERSION" \
        "re-run setup_wizard (migrate mode) to align with the installed framework version"
fi

# --- 9b. Concurrency cap (DEC-027) ---
# The cap bounds detached provider CLIs so enabling every role does not exhaust
# memory. 0 disables it. Absent section is fine (tooling applies cap=4 default).
if toml_section_present concurrency; then
    cc_max="$(read_toml concurrency max_concurrent_agents)"
    if [ "$cc_max" = "0" ]; then
        add_finding P2 "concurrency-unbounded" \
            "[concurrency] max_concurrent_agents = 0 (cap disabled): all detached agents may run at once" \
            "set a bound (e.g. 4) if running many roles on a memory-constrained machine"
    elif printf '%s' "$cc_max" | grep -qE '^-'; then
        add_finding P1 "concurrency-invalid" \
            "[concurrency] max_concurrent_agents = $cc_max is negative; tooling clamps it to 0 (unbounded)" \
            "set max_concurrent_agents to a non-negative integer (0 disables the cap)"
    fi
fi

# --- 9c. Output control (DEC-028) ---
if toml_section_present output_control; then
    oc_default="$(read_toml output_control default_profile)"
    if [ -n "$oc_default" ] && ! printf '%s' "$oc_default" | grep -qE '^(normal|compact|micro)$'; then
        add_finding P0 "output-control-profile" \
            "[output_control] default_profile = \"$oc_default\" is not normal/compact/micro" \
            "set default_profile to normal, compact, or micro"
    fi
    oc_viol="$(read_toml output_control violation_mode)"
    if [ -n "$oc_viol" ] && ! printf '%s' "$oc_viol" | grep -qE '^(warn|fail)$'; then
        add_finding P0 "output-control-violation-mode" \
            "[output_control] violation_mode = \"$oc_viol\" must be warn or fail" \
            "set violation_mode = \"warn\" (default) or \"fail\" (experimental)"
    elif [ "$oc_viol" = "fail" ]; then
        add_finding P1 "output-control-violation-fail" \
            "[output_control] violation_mode = \"fail\" is experimental: a role writing a long but legitimate warning could be failed" \
            "prefer violation_mode = \"warn\" until fail-mode has been validated for your roster"
    fi
    oc_logmax="$(read_toml output_control driver_log_max_bytes)"
    if [ -n "$oc_logmax" ] && printf '%s' "$oc_logmax" | grep -qE '^[0-9]+$' && [ "$oc_logmax" -lt 1048576 ]; then
        add_finding P0 "output-control-log-rotation" \
            "[output_control] driver_log_max_bytes = $oc_logmax is below 1MB; logs would rotate constantly" \
            "set driver_log_max_bytes to at least 1048576 (1MB)"
    fi
    for prof in normal compact micro; do
        soft="$(read_toml "output_control.profiles.$prof" soft_result_chars)"
        if [ -n "$soft" ] && printf '%s' "$soft" | grep -qE '^[0-9]+$' && [ "$soft" -lt 200 ]; then
            add_finding P0 "output-control-soft-chars" \
                "[output_control.profiles.$prof] soft_result_chars = $soft is below 200 (too terse to be safe)" \
                "raise soft_result_chars to at least 200"
        fi
    done
    for role in guardian concierge; do
        if [ "$(read_toml output_control.roles "$role")" = "micro" ]; then
            add_finding P1 "output-control-safety-micro" \
                "[output_control.roles] $role = \"micro\" can pressure warnings / approvals / responsibility boundaries short" \
                "keep $role at \"normal\" (or \"compact\"); safety-critical roles should not be micro"
        fi
    done
    if [ "$(read_toml output_control enabled)" = "false" ]; then
        add_finding P2 "output-control-disabled" \
            "[output_control] enabled = false: provider final responses and tool logs are not bounded" \
            "leave enabled = true unless you are deliberately debugging full output"
    fi
    if [ "$(read_toml output_control usage_summary)" = "false" ]; then
        add_finding P2 "output-control-no-usage" \
            "[output_control] usage_summary = false: token / output / over-budget trends are not recorded" \
            "set usage_summary = true to track which roles bloat output over time"
    fi
fi

# --- 9d. Librarian role knowledge trees (DEC-029) ---
# Seeded by the wizard at docs/garelier/<tree>/. A tree dir present but missing
# its index.md is broken (P1); a tree absent entirely is advisory (P2 — re-run
# the wizard to seed it). Forbidden "convenience" Skills are linted in ci.sh.
# Entirely-absent knowledge tree (DEC-050 follow-up): if docs/garelier/ has no
# knowledge at all, the role knowledge index + status-web Knowledge / RoleKnowledge
# / Source / Routine panels are empty and roles cannot read curated knowledge. A
# brand/path rename that moved __garelier but forgot docs/<old>/ → docs/garelier/
# lands here (the symptom that surfaced after the Garelier rebrand).
if [ ! -d "$PROJECT_ROOT/docs/garelier" ]; then
    add_finding P1 "knowledge-tree-absent" \
        "docs/garelier/ is entirely absent — role knowledge + status-web Knowledge/Source/Routine panels are empty" \
        "run setup_wizard to seed it; or if a brand/path rename moved __garelier, ensure docs/<old>/ was also moved to docs/garelier/ (tracked_path_rename_migration runbook)"
fi
for ktree in security engineering quality review system; do
    kdir="$PROJECT_ROOT/docs/garelier/$ktree"
    if [ -d "$kdir" ]; then
        if [ ! -f "$kdir/index.md" ]; then
            add_finding P1 "knowledge-tree-index" \
                "docs/garelier/$ktree/ exists but index.md is missing" \
                "restore docs/garelier/$ktree/index.md (re-run setup_wizard, or copy from garelier-librarian/templates/$ktree/index.md)"
        fi
    elif [ -d "$PROJECT_ROOT/docs/garelier" ]; then
        add_finding P2 "knowledge-tree-missing" \
            "docs/garelier/$ktree/ is not seeded" \
            "run setup_wizard (it seeds Librarian role knowledge trees), or seed from garelier-librarian/templates/$ktree/"
    fi
done

# --- 9e. role_index closure (DEC-071 follow-up) ---
# Every knowledge doc the role_index names must exist: producers and the jig
# silently SKIP a missing read, so a stale tree (templates added to the
# framework after this project was seeded) hides itself. Surfaced live
# 2026-06-12: a project's role_index/jig referenced docs that were never
# seeded and nothing noticed.
RIDX="$PROJECT_ROOT/docs/garelier/knowledge/role_index.toml"
if [ -f "$RIDX" ]; then
    ri_missing=""
    for ref in $(grep -oE 'docs/garelier/[A-Za-z0-9_/.-]+\.md' "$RIDX" | sort -u); do
        [ -f "$PROJECT_ROOT/$ref" ] || ri_missing="$ri_missing $ref"
    done
    if [ -n "$ri_missing" ]; then
        add_finding P1 "role-index-dangling" \
            "role_index.toml names knowledge docs that do not exist:$ri_missing" \
            "seed them from garelier-librarian/templates/ (knowledge-sync Librarian dispatch), or remove the stale entries"
    fi
fi

# --- 10. Compact-handoff bloat (P2) ---
# compact_handoff.md mandates pointers over pasted bodies. A handoff / inbox
# file far past the terse size almost always means a diff / full report /
# blueprint was pasted in — a token leak and a non-authoritative copy.
# Advisory only.
HANDOFF_MAX_BYTES=16384
handoff_big="$(find "$PM_ROOT" -type f -size +"${HANDOFF_MAX_BYTES}c" \
    \( -name 'assignment.md' -o -name 'report.md' -o -name 'questions.md' \
       -o -name 'review.md' -o -name 'answers.md' -o -name 'checkpoint.md' \
       -o -path '*/inbox/*.md' \) 2>/dev/null | head -20)"
if [ -n "$handoff_big" ]; then
    hb_count="$(printf '%s\n' "$handoff_big" | grep -c . )"
    hb_sample="$(printf '%s\n' "$handoff_big" | head -3 | while IFS= read -r f; do
        [ -f "$f" ] || continue
        sz="$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
        printf '%s (%sB) ' "${f#$PROJECT_ROOT/}" "$sz"
    done)"
    add_finding P2 "handoff-bloat" \
        "$hb_count compact-handoff/inbox file(s) exceed ${HANDOFF_MAX_BYTES}B: $hb_sample" \
        "reference artifacts by path (compact_handoff.md: never paste a diff/report/blueprint body into a handoff)"
fi

# --- 11. Role worktree containers must be gitignored (P1) ---
# A worktree container the target repo does NOT ignore shows up as untracked
# churn (and risks being committed). DEC-051: the ignore rules live in the nested
# __garelier/.gitignore (git check-ignore honors nested ignore files, so this
# check is location-agnostic and works whether the rules are nested or legacy
# root). The fragment must cover every role — including _librarians/ _observers/
# _artisan/.
if git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    for wd in _workers _scouts _smiths _librarians _observers _artisan _guardians _concierges; do
        [ -d "$PM_ROOT/$wd" ] || continue
        rel="__garelier/$PM_ID/$wd"
        if ! git -C "$PROJECT_ROOT" check-ignore -q "$rel" 2>/dev/null; then
            add_finding P1 "worktree-not-ignored" \
                "$rel exists but is not gitignored — its worktree content shows as untracked in the target repo" \
                "copy skills/garelier-core/templates/runtime_gitignore to __garelier/.gitignore (nested; project root untouched — it must include _librarians/ _observers/ _artisan/); re-run setup_wizard --mode migrate to do this automatically"
        fi
    done
fi

# --- 12. Studio integration-branch topology (DEC-050 operator-surgery class) ---
# The main checkout is where PM/Dock operate and is expected to sit on the studio
# integration branch. A DETACHED HEAD means the integration point has drifted — a
# merge may have landed on a detached fork instead of advancing the studio ref
# (the failure mode that parked the pipeline after the Garelier rebrand). A
# non-studio branch is usually transient (e.g. mid-promote) so it is advisory.
# Read-only; surfaces the drift before dispatch trusts the layout.
if git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    studio_branch="$(git -C "$PROJECT_ROOT" for-each-ref --format='%(refname:short)' refs/heads/ 2>/dev/null \
        | grep -E "^garelier/.*/$PM_ID/studio$" | head -1 || true)"
    head_branch="$(git -C "$PROJECT_ROOT" symbolic-ref -q --short HEAD 2>/dev/null || true)"
    if [ -z "$studio_branch" ]; then
        add_finding P2 "studio-branch-missing" \
            "no 'garelier/<slug>/$PM_ID/studio' branch found — integration-branch topology cannot be verified" \
            "confirm the studio branch exists (setup_wizard creates it); if the target slug changed, re-run setup_wizard --mode migrate"
    elif [ -z "$head_branch" ]; then
        head_sha="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
        extra=""
        if git -C "$PROJECT_ROOT" log -1 --format='%s' HEAD 2>/dev/null | grep -qiE 'merge .*into studio' \
           && ! git -C "$PROJECT_ROOT" merge-base --is-ancestor HEAD "$studio_branch" 2>/dev/null; then
            extra=" — this commit is a 'Merge into studio' fork NOT contained in the studio branch (a merge landed on a detached HEAD instead of advancing studio)"
        fi
        add_finding P1 "studio-detached-head" \
            "main checkout is on a DETACHED HEAD ($head_sha), expected studio branch '$studio_branch'$extra" \
            "switch the main checkout back to studio (git -C \"$PROJECT_ROOT\" switch \"$studio_branch\"); if a merge landed on a detached fork, replay it onto studio via cherry-pick (DEC-050 operator-surgery)"
    elif [ "$head_branch" != "$studio_branch" ]; then
        add_finding P2 "studio-not-checked-out" \
            "main checkout is on '$head_branch', not studio '$studio_branch' (PM/Dock operate from studio; fine if mid-promote)" \
            "if not mid-promote, switch back: git -C \"$PROJECT_ROOT\" switch \"$studio_branch\""
    fi
fi

# === Report ===
echo "=== Garelier Doctor — PM '$PM_ID' ==="
echo "Project: $PROJECT_ROOT"
echo ""

print_group() {
    local label="$1"; shift
    local -a items=("$@")
    [ "${#items[@]}" -eq 0 ] && return 0
    for line in "${items[@]}"; do
        echo "$line"
    done
}

if [ "${#P0_FINDINGS[@]}" -gt 0 ]; then print_group P0 "${P0_FINDINGS[@]}"; fi
if [ "${#P1_FINDINGS[@]}" -gt 0 ]; then print_group P1 "${P1_FINDINGS[@]}"; fi
if [ "${#P2_FINDINGS[@]}" -gt 0 ]; then print_group P2 "${P2_FINDINGS[@]}"; fi

total=$(( ${#P0_FINDINGS[@]} + ${#P1_FINDINGS[@]} + ${#P2_FINDINGS[@]} ))
if [ "$total" -eq 0 ]; then
    echo "No issues found. (0 findings)"
fi

echo ""
echo "Summary: ${#P0_FINDINGS[@]} P0 (blocking), ${#P1_FINDINGS[@]} P1 (warning), ${#P2_FINDINGS[@]} P2 (advisory)."

if [ "${#P0_FINDINGS[@]}" -gt 0 ]; then
    exit 1
fi
exit 0
