#!/usr/bin/env bash
#
# Garelier Setup Wizard (bash) — v2.5.0
#
# Three modes:
#   --mode fresh (default): initialize a new PM under __garelier/<pm_id>/.
#                           Run from inside the project's __garelier/
#                           directory. The wizard prompts for pm_id (or
#                           accepts --pm-id), then creates
#                           __garelier/<pm_id>/{_pm,_dock,control,runtime}
#                           and worktrees under
#                           __garelier/<pm_id>/{_workers,_scouts,_smiths}/.
#                           Branches:
#                             garelier/<target-slug>/<pm_id>/studio
#                             garelier/<target-slug>/<pm_id>/workbench/...
#
#   --mode diff:            modify an existing per-PM Garelier installation.
#                           Run from inside __garelier/<pm_id>/_pm/ (the
#                           PM directory). Auto-detects pm_id from cwd.
#                           Compares --workers/--scouts/--smiths arguments with
#                           setup_config.toml and applies the differences.
#                           Removals require IDLE state unless PM already
#                           completed retire-and-requeue and passes
#                           --allow-requeued-removal. Before adding a
#                           worktree, integrates <target> into the
#                           per-PM studio branch via merge.
#
#   --mode migrate:         convert a v2.0 (flat) layout to v2.1 (per-PM).
#                           Run from inside __garelier/. Detects flat
#                           layout (__garelier/_pm/ at top level), prompts
#                           for pm_id, then:
#                             - git mv __garelier/{_pm,_dock,control}
#                                  into __garelier/<pm_id>/
#                             - git worktree move each worker / scout / smith
#                             - mv __garelier/runtime/ (gitignored)
#                             - git branch -m studio + each workbench
#                               to embed <pm_id> in the branch name
#                             - update setup_config.toml with pm_id
#                             - write nested __garelier/.gitignore + .ignore
#                               and migrate any legacy root block away (DEC-051)
#                           Local-only — does not push anything.
#
# Vocabulary (canonical, v2.0+):
#   target (formerly "base"), studio (formerly "develop"),
#   workbench (formerly "feature"), control (persistent),
#   runtime (formerly "workspace"), blueprint (formerly "spec"),
#   inspection (formerly "research_report"),
#   promote (formerly "release").
#

set -euo pipefail

# === Defaults ===

MODE="fresh"
PROJECT_NAME=""
TARGET=""
WORKERS=""
SCOUTS=""
SMITHS=""
SMITHS_SET="false"
SCOUT_IDLE_TASK="false"
DEFAULT_LANE="dock"           # [lanes] default: dock | artisan (DEC-056)
DEFAULT_LANE_SET="false"      # true once --default-lane is passed (fresh-only)
SKIP_CONFIRM="false"
ALLOW_REQUEUED_REMOVAL="false"
PM_ID=""
STACK="rust"                 # rust|typescript|python|go|mixed|custom
QG_CMDS=()                   # explicit --quality-gate values (override stack default)
PERMISSION_PROFILE="reviewed" # safe|reviewed|dangerous
AGENTS_POLICY="strict"        # strict (leave project-specific placeholders) | minimal (fill safe defaults)
LIBRARIANS=""                # id:provider[:model],... (dock lane, DEC-018)
LIBRARIANS_SET="false"       # true once --librarians is passed (diff: omit = keep existing)
OBSERVERS=""                 # id:provider[:model],... (review sidecar, DEC-019)
OBSERVERS_SET="false"        # true once --observers is passed (diff: omit = keep existing)
GUARDIANS=""                 # id:provider[:model],... (security gate, DEC-024)
GUARDIANS_SET="false"        # true once --guardians is passed (diff: omit = keep existing)
CONCIERGES=""                # id:provider[:model],... (external operations executor, DEC-025)
CONCIERGES_SET="false"       # true once --concierges is passed (diff: omit = keep existing)
ARTISAN_ENABLE="false"       # --artisan enables the artisan lane (DEC-017)
ARTISAN_DISABLE="false"      # --no-artisan disables it (diff mode)
ARTISAN_SET="false"          # true once --artisan or --no-artisan is passed (diff: omit = keep existing)
ARTISAN_SPEC=""              # optional id:provider[:model] for the Artisan
WS_EXILE="0"                 # DEC-036: 1 = put role worktrees in a machine-local
                             # home OUTSIDE the project (opt-in). Default 0 = in-project.
INSTALL_TOOLS="false"        # Best-effort setup of Bun/gitleaks + local driver assets.

WIZARD_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Resolve the skills dir holding garelier-* (DEC-053: cache-safe + dual-mode).
# Order:
#   1. ${CLAUDE_PLUGIN_ROOT}/skills (plugin runtime)
#   2. script-relative self-location (this wizard lives in
#      garelier-pm/scripts/, so dirname/../.. = the skills dir); verified by
#      garelier-core/SKILL.md presence — works in the read-only plugin cache too
#   3. legacy $HOME/.claude/skills (dev symlink last resort)
GARELIER_SELF_SKILLS_DIR="$(cd "${WIZARD_SCRIPT_DIR}/../.." && pwd)"
if [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] && [ -f "$CLAUDE_PLUGIN_ROOT/skills/garelier-core/SKILL.md" ]; then
    GARELIER_SKILLS_DIR="$CLAUDE_PLUGIN_ROOT/skills"
elif [ -f "$GARELIER_SELF_SKILLS_DIR/garelier-core/SKILL.md" ]; then
    GARELIER_SKILLS_DIR="$GARELIER_SELF_SKILLS_DIR"
else
    GARELIER_SKILLS_DIR="$HOME/.claude/skills"
fi
GARELIER_DRIVER_DIR="${GARELIER_SKILLS_DIR}/garelier-core/driver"

usage() {
    cat <<'EOF'
Usage: setup_wizard.sh [options]

Mode:
  --mode fresh           Initialize a new PM under __garelier/<pm_id>/ (default).
  --mode diff            Add or remove agents from an existing PM.
  --mode migrate         Convert a v2.0 (flat) layout to v2.1 (per-PM).

Required for fresh mode:
  --project-name "<name>"        Project name
  --workers "<id:model,...>"     Worker definitions. Also accepts
                                 "<id:provider:model,...>".
  --scouts "<id:model,...>"      Scout definitions. Also accepts
                                 "<id:provider:model,...>".

Required for diff mode:
  --workers "<id:model,...>"     Desired Worker set (must include all kept ones)
  --scouts "<id:model,...>"      Desired Scout set (must include all kept ones)
  --smiths "<id:model,...>"      Optional desired Smith set. Omit in diff
                                 mode to keep existing Smiths unchanged.
  --librarians "<id:model,...>"  Optional desired Librarian set (DEC-018).
                                 Omit to keep existing; pass "" to remove all.
  --observers "<id:model,...>"   Optional desired Observer set (DEC-019).
                                 Omit to keep existing; pass "" to remove all.
  --guardians "<id:model,...>"   Optional desired Guardian set (DEC-024).
                                 Omit to keep existing; pass "" to remove all.
  --concierges "<id:model,...>"  Optional desired Concierge set (DEC-025).
                                 Omit to keep existing; pass "" to remove all.
  --artisan                      Enable the artisan lane (DEC-017).
  --no-artisan                   Disable the artisan lane. Omit both to keep
                                 the current artisan state unchanged.

Optional:
  --pm-id <id>                   PM identifier (fresh & migrate modes).
                                 Format: _workshop or
                                 [a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?
                                 Default: _workshop for single-user projects.
                                 Shared/multi-user projects should specify a
                                 unique --pm-id explicitly.
                                 In diff mode, auto-detected from cwd.
  --target <branch>              Target branch (fresh only; default: current branch).
                                 In diff mode read from setup_config.toml.
                                 Alias: --base (deprecated).
  --stack <name>                 (fresh only) Tech stack driving the quality-gate
                                 default command set and AGENTS.md language:
                                 rust | typescript | python | go | mixed | custom.
                                 Default: rust. custom/mixed require --quality-gate.
  --quality-gate "<cmd>"         (fresh only, repeatable) Explicit quality-gate
                                 command; overrides the stack default set.
                                 Required when --stack is custom or mixed.
  --permission-profile <p>       (fresh only) Provider autonomy profile:
                                 safe | reviewed | dangerous. Default: reviewed.
                                 dangerous = full provider access (opt-in only).
  --agents-policy <p>            (fresh only) How AGENTS.md placeholders are
                                 handled: strict | minimal. Default: strict.
                                 strict leaves project-specific fields
                                 (restricted files, conventions) as {{...}} —
                                 doctor reports P0 and the driver won't start
                                 until you fill them. minimal fills safe initial
                                 values ("none initially" / "follow existing
                                 style") so doctor passes immediately — handy for
                                 quick trials; tighten later.
  --librarians / --observers     (fresh & diff) See the diff-mode section above;
  / --guardians / --concierges   also accepted in fresh mode to seed the set.
  --artisan / --no-artisan       Toggle the artisan lane in DIFF mode only:
                                  --artisan enables it, --no-artisan disables it
                                  (omit both to keep the current state). In FRESH
                                  mode the artisan lane is ALWAYS enabled and
                                  --no-artisan is ignored (DEC-055).
                                  Artisan is a SINGLETON — one instance only.
  --scout-idle-task <true|false> (fresh only) default: false
  --default-lane <dock|artisan>  (fresh) Lane the driver runs when no lane.lock
                                  is present. default: dock. "artisan" = the
                                  single-agent lane runs by default (DEC-056).
  --skip-confirm                  Skip interactive confirmation
  --install-tools                 Best-effort install/setup of missing local
                                  tooling: Bun, gitleaks when Guardian gates
                                  are configured, driver dependencies, and the
                                  offline Mermaid bundle. Without this flag,
                                  interactive runs ask only when something is
                                  missing; --skip-confirm never installs
                                  external tools implicitly.
  --allow-requeued-removal        Diff only: allow removing non-IDLE agents
                                  after PM has returned their tasks to
                                  runtime/backlog/pending.md with outcome
                                  requeued. Does not perform requeue itself.
  --help                          Show this help

Run locations:
  fresh   : __garelier/             (one level up from the new PM dir)
  diff    : __garelier/<pm_id>/_pm/
  migrate : __garelier/             (top level of the legacy flat layout)

Examples:

  # Fresh init from inside __garelier/:
  cd /path/to/project/__garelier
  garelier setup \
    --project-name "My Project" \
    --pm-id "acme" \
    --target "main" \
    --workers "worker-01:claude-code,worker-02:claude-code" \
    --scouts "scout-01:claude-code"

  # Diff mode: add worker-03
  cd /path/to/project/__garelier/acme/_pm
  garelier setup \
    --mode diff \
    --workers "worker-01:claude-code,worker-02:claude-code,worker-03:claude-code" \
    --scouts "scout-01:claude-code"

  # Mixed provider pool:
  garelier setup \
    --mode diff \
    --workers "worker-01:claude-code,worker-02:codex-cli:gpt-5-codex" \
    --scouts "scout-01:codex-cli:gpt-5-codex"

  # Migrate a v2.0 install to v2.1:
  cd /path/to/project/__garelier
  garelier setup \
    --mode migrate --pm-id "acme"
EOF
}

# === Argument parsing ===

while [ $# -gt 0 ]; do
    case "$1" in
        --mode)             MODE="$2"; shift 2 ;;
        --project-name)     PROJECT_NAME="$2"; shift 2 ;;
        --pm-id)            PM_ID="$2"; shift 2 ;;
        --target)           TARGET="$2"; shift 2 ;;
        --base)             TARGET="$2"; shift 2 ;;   # deprecated alias
        --workers)          WORKERS="$2"; shift 2 ;;
        --scouts)           SCOUTS="$2"; shift 2 ;;
        --smiths)           SMITHS="$2"; SMITHS_SET="true"; shift 2 ;;
        --stack)            STACK="$2"; shift 2 ;;
        --quality-gate)     QG_CMDS+=("$2"); shift 2 ;;
        --permission-profile) PERMISSION_PROFILE="$2"; shift 2 ;;
        --agents-policy)    AGENTS_POLICY="$2"; shift 2 ;;
        --librarians)       LIBRARIANS="$2"; LIBRARIANS_SET="true"; shift 2 ;;
        --observers)        OBSERVERS="$2"; OBSERVERS_SET="true"; shift 2 ;;
        --guardians)        GUARDIANS="$2"; GUARDIANS_SET="true"; shift 2 ;;
        --concierges)       CONCIERGES="$2"; CONCIERGES_SET="true"; shift 2 ;;
        --artisan)
            ARTISAN_ENABLE="true"; ARTISAN_SET="true"
            # Optional inline spec; only consume $2 when it isn't another flag.
            if [ -n "${2:-}" ] && [ "${2#-}" = "${2:-}" ]; then ARTISAN_SPEC="$2"; shift 2; else shift; fi
            ;;
        --no-artisan)       ARTISAN_DISABLE="true"; ARTISAN_SET="true"; shift ;;
        --exile)            WS_EXILE="1"; shift ;;   # DEC-036: opt into out-of-project role homes
        --scout-idle-task)  SCOUT_IDLE_TASK="$2"; shift 2 ;;
        --default-lane)     DEFAULT_LANE="$2"; DEFAULT_LANE_SET="true"; shift 2 ;;
        --skip-confirm)     SKIP_CONFIRM="true"; shift ;;
        --install-tools)    INSTALL_TOOLS="true"; shift ;;
        --allow-requeued-removal) ALLOW_REQUEUED_REMOVAL="true"; shift ;;
        --help|-h)          usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

# Guard the ambiguous `id:provider` mistake at the TOP level. (normalize_agent_entry
# also checks, but its `exit` runs inside a command-substitution subshell and
# would not abort the wizard — this runs in the main shell and does.) Only
# Provider aliases in the two-field form are dangerous: `worker-01:claude-code`
# is the normal Claude form (provider defaults to claude-code, model placeholder
# is harmless), whereas `worker-01:codex-cli` would silently run a claude-code
# agent with model "codex-cli".
check_agent_specs() {
    local label="$1" specs="$2" e
    [ -z "$specs" ] && return 0
    local IFS=','
    for e in $specs; do
        case "$e" in
            *:codex|*:codex-cli|*:gemini|*:gemini-cli|*:google-gemini|*:copilot|*:github-copilot|*:copilot-cli|*:cursor|*:cursor-cli|*:cursor-agent)
                echo "Error: ambiguous $label entry '$e'. '${e#*:}' is a provider, not a model;" >&2
                echo "       '$e' would silently run under provider=claude-code." >&2
                echo "       Use id:provider:model, e.g. ${e%%:*}:gemini-cli:gemini-default" >&2
                exit 1
                ;;
        esac
    done
}
check_agent_specs workers "$WORKERS"
check_agent_specs scouts "$SCOUTS"
check_agent_specs smiths "$SMITHS"
check_agent_specs librarians "$LIBRARIANS"
check_agent_specs observers "$OBSERVERS"
check_agent_specs guardians "$GUARDIANS"
check_agent_specs concierges "$CONCIERGES"
check_agent_specs artisan "$ARTISAN_SPEC"

# Default quality-gate command set per stack (mirrors STACK_QUALITY_GATES
# in driver/src/config.ts). mixed/custom intentionally emit nothing — the
# caller must supply --quality-gate.
qg_defaults_for_stack() {
    case "$1" in
        rust)       printf '%s\n' "cargo check --workspace" "cargo test --workspace" "cargo clippy --workspace -- -D warnings" ;;
        typescript) printf '%s\n' "npm ci" "npm run typecheck" "npm test" "npm run lint" ;;
        python)     printf '%s\n' "python -m pip install -e ." "ruff check ." "pytest" ;;
        go)         printf '%s\n' "go build ./..." "go vet ./..." "go test ./..." ;;
        *)          : ;;
    esac
}

case "$MODE" in
    fresh)
        if [ -z "$PROJECT_NAME" ]; then
            echo "Error: fresh mode requires --project-name." >&2
            usage >&2; exit 1
        fi
        # Workers/Scouts (and every other role) are no longer required: fresh
        # defaults to exactly one of each (DEC-055). Scale up later via the PM.
        ;;
    diff)
        if [ -z "$WORKERS" ] || [ -z "$SCOUTS" ]; then
            echo "Error: diff mode requires --workers and --scouts (the desired final set)." >&2
            usage >&2; exit 1
        fi
        ;;
    migrate)
        : # no required arguments; --pm-id is optional (prompted otherwise)
        ;;
    *)
        echo "Error: --mode must be 'fresh', 'diff', or 'migrate' (got: $MODE)." >&2
        exit 1
        ;;
esac

case "$DEFAULT_LANE" in
    dock|artisan) : ;;
    *) echo "Error: --default-lane must be 'dock' or 'artisan' (got: $DEFAULT_LANE)." >&2; exit 1 ;;
esac
if [ "$MODE" != "fresh" ] && [ "$DEFAULT_LANE_SET" = "true" ]; then
    echo "Error: --default-lane only applies to --mode fresh. In diff/migrate, edit '[lanes] default' in setup_config.toml directly (DEC-056)." >&2
    exit 1
fi

# === Fresh-mode defaults: EXACTLY ONE of every role (DEC-055) ===
#
# A FRESH setup creates exactly one of every role using the default provider/
# model (claude-code:claude-code), with NO composition prompts and NO zero
# option — every role is minimum one. An empty OR omitted value is coerced to a
# single default instance (0 is impossible in fresh). Scale up later (more
# instances, other providers such as codex-cli) via the PM, which runs
# `--mode diff`. The Artisan lane is always enabled in fresh too (see below).
#
# This block is fresh-only. Diff mode keeps its "omit = keep existing" /
# explicit-desired-set semantics untouched: it never consults these defaults
# and still honors explicit empties (the *_SET flags are for diff).
if [ "$MODE" = "fresh" ]; then
    [ -n "$WORKERS" ]    || WORKERS="worker-01:claude-code:claude-code"
    [ -n "$SCOUTS" ]     || SCOUTS="scout-01:claude-code:claude-code"
    [ -n "$SMITHS" ]     || SMITHS="smith-01:claude-code:claude-code"
    [ -n "$LIBRARIANS" ] || LIBRARIANS="librarian-01:claude-code:claude-code"
    [ -n "$OBSERVERS" ]  || OBSERVERS="observer-01:claude-code:claude-code"
    [ -n "$GUARDIANS" ]  || GUARDIANS="guardian-01:claude-code:claude-code"
    [ -n "$CONCIERGES" ] || CONCIERGES="concierge-01:claude-code:claude-code"
    # Artisan lane: ALWAYS enabled in a fresh full setup — like every other role
    # it is minimum one (DEC-055; full Garelier uses the Artisan lane). --no-artisan
    # is ignored in fresh; disable the lane later via --mode diff if ever needed.
    ARTISAN_ENABLE="true"
fi

# === Determine project root and pm_id from cwd ===

CWD="$(pwd)"
CWD_BASENAME="$(basename "$CWD")"
CWD_PARENT_BASENAME="$(basename "$(dirname "$CWD")")"

case "$MODE" in
    fresh|migrate)
        # Both modes run from __garelier/.
        if [ "$CWD_BASENAME" != "__garelier" ]; then
            echo "Error: --mode $MODE must run from the project's __garelier/ directory." >&2
            echo "Current directory: $CWD" >&2
            exit 1
        fi
        PROJECT_ROOT="$(dirname "$CWD")"
        ;;
    diff)
        # Diff runs from __garelier/<pm_id>/_pm/.
        if [ "$CWD_BASENAME" != "_pm" ]; then
            echo "Error: --mode diff must run from __garelier/<pm_id>/_pm/." >&2
            echo "Current directory: $CWD" >&2
            exit 1
        fi
        # PM_ID := basename of parent of cwd's parent
        PM_ID_FROM_CWD="$CWD_PARENT_BASENAME"
        GRANDPARENT_BASENAME="$(basename "$(dirname "$(dirname "$CWD")")")"
        if [ "$GRANDPARENT_BASENAME" != "__garelier" ]; then
            echo "Error: --mode diff must run from __garelier/<pm_id>/_pm/ (got: $CWD)." >&2
            exit 1
        fi
        if [ -z "$PM_ID" ]; then
            PM_ID="$PM_ID_FROM_CWD"
        elif [ "$PM_ID" != "$PM_ID_FROM_CWD" ]; then
            echo "Error: --pm-id ($PM_ID) does not match cwd PM ($PM_ID_FROM_CWD)." >&2
            exit 1
        fi
        PROJECT_ROOT="$(dirname "$(dirname "$(dirname "$CWD")")")"
        ;;
esac

cd "$PROJECT_ROOT"

NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# === Helpers ===

command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# DEC-051: Garelier keeps its ignore rules INSIDE __garelier/ (nested .gitignore
# / .ignore) and NEVER appends to the project's root files. git and ripgrep/fd
# both honor nested ignore files, so the rules still apply to every <pm_id> under
# __garelier/ while the project root stays pristine, churn-free, and removable.

# Remove a legacy Garelier block previously appended to a root ignore file
# (pre-DEC-051 installs). The block may sit in the MIDDLE of the file (a user
# can append their own rules after it), so we must remove only the contiguous
# Garelier block — never marker-to-EOF. Algorithm: from the marker line, consume
# Garelier pattern lines (dropping any comments/blanks buffered just before them,
# since those are block-internal section headers); the moment a non-blank,
# non-comment, NON-Garelier line appears, the block has ended — flush the buffered
# comments/blanks back (they belong to the next section, e.g. a trailing
# "# Build cache" header) and resume copying. Trailing buffered lines at EOF are
# block trailers and are dropped. If the file ends up empty (Garelier created it),
# delete it to restore a pristine root. Best-effort: no-op when marker is absent.
garelier_trim_legacy_root_block() {  # $1=file  $2=marker substring
    local file="$1" marker="$2"
    [ -f "$file" ] || return 0
    grep -q "$marker" "$file" 2>/dev/null || return 0
    awk -v marker="$marker" '
        function is_pat(l) {
            return (l ~ /^!?__garelier\//) ||
                   (l ~ /^!?\*\/(runtime|_workers|_scouts|_smiths|_librarians|_observers|_artisan|_guardians|_concierges|_dock)\/?$/) ||
                   (l ~ /^\*\/_pm\/CLAUDE\.md$/) ||
                   (l ~ /^!\*\/control\//) ||
                   (l ~ /^\/(STATE|assignment|review|questions|answers|report|under_review|merged|abort|track-target)\.md$/) ||
                   (l ~ /^\/archive\/$/) ||
                   (l ~ /^\*\.bak(\..*)?$/) ||
                   (l ~ /^\/?target\/$/)
        }
        function is_cb(l) { return (l ~ /^#/) || (l ~ /^[[:space:]]*$/) }
        BEGIN { removing = 0; nb = 0 }
        {
            if (!removing) {
                if (index($0, marker) > 0) { removing = 1 }
                else { print }
            } else if (is_pat($0)) {
                nb = 0
            } else if (is_cb($0)) {
                buf[nb++] = $0
            } else {
                removing = 0
                for (i = 0; i < nb; i++) print buf[i]
                nb = 0
                print
            }
        }
    ' "$file" > "$file.tmp"
    awk 'NF { last = NR } { a[NR] = $0 } END { for (i = 1; i <= last; i++) print a[i] }' \
        "$file.tmp" > "$file"
    rm -f "$file.tmp"
    if [ ! -s "$file" ]; then
        rm -f "$file"
        echo "  - removed now-empty root $file (Garelier no longer touches it)"
    else
        echo "  - migrated: removed legacy Garelier block from root $file"
    fi
}

# Write the nested __garelier/.gitignore and __garelier/.ignore from templates,
# then migrate away any legacy root block. Idempotent (safe to re-run). Both
# files are wholly Garelier-owned, so a rewrite never clobbers shared content.
garelier_write_nested_ignores() {
    local tdir="${GARELIER_CORE_TEMPLATES_DIR:-$GARELIER_SKILLS_DIR/garelier-core/templates}"
    local gi_tmpl="$tdir/runtime_gitignore"
    local ig_tmpl="$tdir/search_ignore"
    mkdir -p __garelier
    if [ -f "$gi_tmpl" ]; then
        cp "$gi_tmpl" __garelier/.gitignore
        echo "  + __garelier/.gitignore written (nested; project root untouched)"
    else
        echo "  ! runtime_gitignore template not found at $gi_tmpl" >&2
    fi
    if [ -f "$ig_tmpl" ]; then
        cp "$ig_tmpl" __garelier/.ignore
        echo "  + __garelier/.ignore written (nested; project root untouched)"
    else
        echo "  ! search_ignore template not found at $ig_tmpl" >&2
    fi
    garelier_trim_legacy_root_block .gitignore "Garelier runtime"
    garelier_trim_legacy_root_block .ignore "Garelier search-ignore"
}

is_windows_shell() {
    case "$(uname -s 2>/dev/null || echo "")" in
        MINGW*|MSYS*|CYGWIN*) return 0 ;;
        *) return 1 ;;
    esac
}

refresh_tool_path() {
    export PATH="$HOME/.bun/bin:$HOME/go/bin:$PATH"
    if [ -n "${USERPROFILE:-}" ] && command_exists cygpath; then
        local win_home
        win_home="$(cygpath -u "$USERPROFILE" 2>/dev/null || true)"
        if [ -n "$win_home" ]; then
            export PATH="$win_home/.bun/bin:$win_home/go/bin:$PATH"
        fi
    fi
}

toml_scalar_value() {
    local file="$1"
    local section="$2"
    local key="$3"
    [ -f "$file" ] || return 1
    awk -v section="$section" -v key="$key" '
        BEGIN { in_section = 0 }
        /^[[:space:]]*\[/ {
            in_section = ($0 ~ "^[[:space:]]*\\[" section "\\][[:space:]]*$")
            next
        }
        in_section && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
            sub("^[[:space:]]*" key "[[:space:]]*=[[:space:]]*", "")
            sub("[[:space:]]*(#.*)?$", "")
            gsub(/^"|"$/, "")
            print
            exit
        }
    ' "$file"
}

guardian_setup_config_path() {
    case "$MODE" in
        diff)
            [ -n "$PM_ID" ] && [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ] && {
                echo "__garelier/$PM_ID/_pm/setup_config.toml"
                return 0
            }
            ;;
        migrate)
            if [ -n "$PM_ID" ] && [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ]; then
                echo "__garelier/$PM_ID/_pm/setup_config.toml"
                return 0
            fi
            if [ -f "__garelier/_pm/setup_config.toml" ]; then
                echo "__garelier/_pm/setup_config.toml"
                return 0
            fi
            ;;
    esac
    return 1
}

guardian_secret_scan_requires_gitleaks() {
    local config_path
    config_path="$(guardian_setup_config_path 2>/dev/null || true)"
    if [ -z "$config_path" ]; then
        # Fresh setups have not written setup_config.toml yet; the default
        # Guardian secret scanner is gitleaks.
        return 0
    fi
    local scan
    scan="$(toml_scalar_value "$config_path" "guardian_tools" "secret_scan" 2>/dev/null || true)"
    scan="$(printf '%s' "$scan" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$scan" in
        ""|"off"|"none"|"disabled")
            return 1
            ;;
        *gitleaks*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

guardian_tools_needed() {
    case "$MODE" in
        fresh)
            [ -n "$GUARDIANS" ] && guardian_secret_scan_requires_gitleaks
            ;;
        diff)
            if [ "$GUARDIANS_SET" = "true" ]; then
                [ -n "$GUARDIANS" ] && guardian_secret_scan_requires_gitleaks
            elif [ -n "$PM_ID" ] && [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ]; then
                grep -q '^\[\[guardians\]\]' "__garelier/$PM_ID/_pm/setup_config.toml" && guardian_secret_scan_requires_gitleaks
            else
                return 1
            fi
            ;;
        migrate)
            if [ -n "$PM_ID" ] && [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ]; then
                grep -q '^\[\[guardians\]\]' "__garelier/$PM_ID/_pm/setup_config.toml" && guardian_secret_scan_requires_gitleaks
            elif [ -f "__garelier/_pm/setup_config.toml" ]; then
                grep -q '^\[\[guardians\]\]' "__garelier/_pm/setup_config.toml" && guardian_secret_scan_requires_gitleaks
            else
                return 1
            fi
            ;;
        *)
            return 1
            ;;
    esac
}

tool_setup_missing() {
    refresh_tool_path
    if ! command_exists bun; then
        echo "Bun"
    else
        if [ -d "$GARELIER_DRIVER_DIR" ] && [ ! -d "$GARELIER_DRIVER_DIR/node_modules" ]; then
            echo "driver dependencies"
        fi
        if [ -d "$GARELIER_DRIVER_DIR" ] && [ ! -f "$GARELIER_DRIVER_DIR/static/vendor/mermaid.min.js" ]; then
            echo "offline Mermaid bundle"
        fi
    fi
    if guardian_tools_needed && ! command_exists gitleaks; then
        echo "gitleaks"
    fi
    return 0
}

print_tool_setup_missing() {
    local missing="$1"
    printf '%s\n' "$missing" | while IFS= read -r item; do
        [ -n "$item" ] && echo "  - $item"
    done
}

try_install_bun() {
    refresh_tool_path
    if command_exists bun; then
        return 0
    fi

    echo "==> Installing Bun (best effort)..."
    if is_windows_shell && command_exists powershell.exe; then
        powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex" || true
        refresh_tool_path
    fi
    if ! command_exists bun && command_exists brew; then
        brew install bun || true
        refresh_tool_path
    fi
    if ! command_exists bun && command_exists curl; then
        curl -fsSL https://bun.com/install | bash || true
        refresh_tool_path
    fi

    command_exists bun
}

try_install_gitleaks() {
    if command_exists gitleaks; then
        return 0
    fi

    echo "==> Installing gitleaks (best effort)..."
    if is_windows_shell && command_exists winget.exe; then
        winget.exe install --exact --id Gitleaks.Gitleaks --accept-source-agreements --accept-package-agreements || true
        refresh_tool_path
    fi
    if ! command_exists gitleaks && is_windows_shell && command_exists choco.exe; then
        choco.exe install gitleaks -y || true
        refresh_tool_path
    fi
    if ! command_exists gitleaks && command_exists brew; then
        brew install gitleaks || true
        refresh_tool_path
    fi
    if ! command_exists gitleaks && command_exists go; then
        go install github.com/gitleaks/gitleaks/v8@latest || true
        refresh_tool_path
    fi

    command_exists gitleaks
}

setup_driver_assets() {
    if [ ! -d "$GARELIER_DRIVER_DIR" ]; then
        echo "  ! driver directory not found: $GARELIER_DRIVER_DIR" >&2
        return 0
    fi
    if ! command_exists bun; then
        echo "  ! Bun is not available; skipping driver dependencies and Mermaid bundle." >&2
        return 0
    fi

    echo "==> Setting up Garelier driver dependencies..."
    (cd "$GARELIER_DRIVER_DIR" && bun install --frozen-lockfile) || \
        echo "  ! bun install failed; run it manually in $GARELIER_DRIVER_DIR" >&2

    echo "==> Vendoring offline Mermaid bundle for Status Web..."
    (cd "$GARELIER_DRIVER_DIR" && bun run vendor:mermaid) || \
        echo "  ! Mermaid vendoring failed; Status Web will show diagram source until this succeeds." >&2
}

run_garelier_tool_setup() {
    if ! command_exists bun; then
        if ! try_install_bun; then
            echo "  ! Bun installation did not make 'bun' available on PATH." >&2
            echo "    Install Bun manually, then rerun setup_wizard or run 'bun install --frozen-lockfile' in $GARELIER_DRIVER_DIR." >&2
        fi
    fi

    refresh_tool_path
    setup_driver_assets

    if guardian_tools_needed && ! command_exists gitleaks; then
        if ! try_install_gitleaks; then
            echo "  ! gitleaks is still unavailable; Guardian secret_scan gates will fail until it is installed or [guardian_tools].secret_scan is set to \"off\" with block_when_required_scanner_unavailable = false." >&2
        fi
    fi
}

maybe_setup_garelier_tools() {
    local missing
    missing="$(tool_setup_missing)"
    [ -z "$missing" ] && return 0

    if [ "$INSTALL_TOOLS" = "true" ]; then
        echo "Garelier tool setup requested. Missing:"
        print_tool_setup_missing "$missing"
        run_garelier_tool_setup
        return 0
    fi

    if [ "$SKIP_CONFIRM" = "true" ]; then
        echo "Garelier tool setup skipped. Missing:"
        print_tool_setup_missing "$missing"
        echo "Rerun setup_wizard with --install-tools, or install them manually."
        return 0
    fi

    if ! [ -t 0 ]; then
        echo "Garelier tool setup needs user approval before project changes. Missing:"
        print_tool_setup_missing "$missing"
        echo "Ask the user whether to install/setup these tools, then rerun with --install-tools."
        echo "Use --skip-confirm only when you intentionally want to continue without tool setup."
        exit 3
    fi

    echo "Garelier can set up missing local tooling:"
    print_tool_setup_missing "$missing"
    printf 'Install/setup these now? [y/N] '
    local response
    read -r response
    case "$response" in
        y|Y|yes|YES)
            run_garelier_tool_setup
            ;;
        *)
            echo "Tool setup skipped. Rerun with --install-tools if you want the wizard to do this later."
            ;;
    esac
}

maybe_setup_garelier_tools

# Convert a target branch name to a slug usable inside garelier/<slug>/...
# (e.g., develop/soft -> develop-soft).
slugify_target() {
    echo "$1" | tr '/' '-'
}

# Validate pm_id against the normal format or the single-user `_workshop`.
validate_pm_id() {
    local id="$1"
    if [ -z "$id" ]; then
        echo "Error: pm_id is empty." >&2
        return 1
    fi
    if [ "$id" = "_workshop" ]; then
        return 0
    fi
    if [ ${#id} -lt 1 ] || [ ${#id} -gt 20 ]; then
        echo "Error: pm_id '$id' must be 1–20 characters." >&2
        return 1
    fi
    if ! echo "$id" | grep -Eq '^[a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?$'; then
        echo "Error: pm_id '$id' must match [a-z0-9]([a-z0-9_-]{0,18}[a-z0-9])?." >&2
        echo "       (lowercase ASCII + digits + internal hyphens, no leading/trailing hyphen)" >&2
        return 1
    fi
    return 0
}

# Single-user default. Shared/multi-user projects must pass a unique id.
default_pm_id() {
    echo "_workshop"
}

# Parse a comma-separated agent list into canonical "id:provider:model"
# tokens. Backward-compatible input:
#   id:model                    -> id:claude-code:model
# New explicit provider input:
#   id:provider:model           -> id:provider:model
parse_entries() {
    local input="$1"
    local IFS=','
    local arr
    read -ra arr <<< "$input"
    local out=""
    for e in "${arr[@]}"; do
        [ -z "$e" ] && continue
        out="$out $(normalize_agent_entry "$e")"
    done
    echo "$out"
}

normalize_agent_entry() {
    local raw="$1"
    local id provider model rest
    id="${raw%%:*}"
    rest="${raw#*:}"
    if [ "$raw" = "$rest" ] || [ -z "$id" ] || [ -z "$rest" ]; then
        echo "Error: agent entry must be id:model or id:provider:model (got: $raw)." >&2
        exit 1
    fi
    if [[ "$rest" == *:* ]]; then
        provider="${rest%%:*}"
        model="${rest#*:}"
    else
        # Two-field form is id:model with provider defaulting to claude-code.
        # `worker-01:claude-code` is the normal Claude form (model placeholder
        # "claude-code", provider already claude-code — harmless). But
        # `worker-01:codex` / `worker-01:codex-cli` CONTRADICTS the default
        # provider: the user meant a Codex agent and would silently get a
        # claude-code one.
        # Reject that and require the explicit three-field form.
        case "$rest" in
            codex|codex-cli|gemini|gemini-cli|google-gemini|copilot|github-copilot|copilot-cli|cursor|cursor-cli|cursor-agent)
                echo "Error: ambiguous agent entry '$raw'. '$rest' is a provider, not a model;" >&2
                echo "       id:$rest would silently run under provider=claude-code." >&2
                echo "       Use id:provider:model, e.g. ${id}:gemini-cli:gemini-default" >&2
                exit 1
                ;;
        esac
        provider="claude-code"
        model="$rest"
    fi
    case "$provider" in
        claude|claude-code) provider="claude-code" ;;
        codex|codex-cli) provider="codex-cli" ;;
        gemini|gemini-cli|google-gemini) provider="gemini-cli" ;;
        copilot|github-copilot|copilot-cli) provider="copilot-cli" ;;
        cursor|cursor-cli|cursor-agent) provider="cursor-cli" ;;
        *)
            echo "Error: unsupported provider '$provider' in agent entry '$raw'." >&2
            echo "       Expected claude-code, codex-cli, gemini-cli, copilot-cli, or cursor-cli." >&2
            exit 1
            ;;
    esac
    echo "$id:$provider:$model"
}

entry_id() {
    echo "${1%%:*}"
}

entry_provider() {
    local rest="${1#*:}"
    echo "${rest%%:*}"
}

entry_model() {
    local rest="${1#*:}"
    echo "${rest#*:}"
}

# Read [[workers]] or [[scouts]] block IDs from this PM's setup_config.toml.
read_existing_block_ids() {
    local section="$1"
    local toml="__garelier/$PM_ID/_pm/setup_config.toml"
    [ -f "$toml" ] || return 0
    awk -v sec="$section" '
        BEGIN { in_section = 0; cur_id = ""; cur_provider = ""; cur_model = "" }
        $0 == "[[" sec "]]" {
            if (cur_id != "") print cur_id ":" (cur_provider != "" ? cur_provider : "claude-code") ":" cur_model
            in_section = 1; cur_id = ""; cur_provider = ""; cur_model = ""; next
        }
        /^\[\[/ {
            if (in_section && cur_id != "") print cur_id ":" (cur_provider != "" ? cur_provider : "claude-code") ":" cur_model
            in_section = 0; cur_id = ""; cur_provider = ""; cur_model = ""; next
        }
        /^\[/ {
            if (in_section && cur_id != "") print cur_id ":" (cur_provider != "" ? cur_provider : "claude-code") ":" cur_model
            in_section = 0; cur_id = ""; cur_provider = ""; cur_model = ""; next
        }
        in_section && /^id[[:space:]]*=/ {
            match($0, /"[^"]*"/); cur_id = substr($0, RSTART+1, RLENGTH-2)
        }
        in_section && /^provider[[:space:]]*=/ {
            match($0, /"[^"]*"/); cur_provider = substr($0, RSTART+1, RLENGTH-2)
        }
        in_section && /^model[[:space:]]*=/ {
            match($0, /"[^"]*"/); cur_model = substr($0, RSTART+1, RLENGTH-2)
        }
        END { if (in_section && cur_id != "") print cur_id ":" (cur_provider != "" ? cur_provider : "claude-code") ":" cur_model }
    ' "$toml"
}

read_existing_agent_effort() {
    local section="$1"
    local wanted_id="$2"
    local toml="__garelier/$PM_ID/_pm/setup_config.toml"
    [ -f "$toml" ] || return 0
    awk -v sec="$section" -v wanted="$wanted_id" '
        BEGIN { in_section = 0; cur_id = ""; cur_effort = ""; found = 0 }
        function quoted_value(line) {
            match(line, /"[^"]*"/)
            if (RSTART > 0) return substr(line, RSTART+1, RLENGTH-2)
            return ""
        }
        function flush() {
            if (!found && in_section && cur_id == wanted && cur_effort != "") {
                print cur_effort
                found = 1
            }
        }
        $0 == "[[" sec "]]" {
            flush()
            in_section = 1; cur_id = ""; cur_effort = ""; next
        }
        /^\[\[/ || /^\[/ {
            flush()
            in_section = 0; cur_id = ""; cur_effort = ""; next
        }
        in_section && /^id[[:space:]]*=/ { cur_id = quoted_value($0); next }
        in_section && /^effort[[:space:]]*=/ { cur_effort = quoted_value($0); next }
        END { flush() }
    ' "$toml"
}

emit_effort_line() {
    local section="$1"
    local id="$2"
    local effort
    effort="$(read_existing_agent_effort "$section" "$id" | head -n 1)"
    if [ -n "$effort" ]; then
        printf 'effort = "%s"\n' "$effort"
    else
        echo "# effort = \"xhigh\""
    fi
}

# Read a single key value from [section] in a specific toml path.
read_toml_value_from() {
    local toml="$1"
    local section="$2"
    local key="$3"
    [ -f "$toml" ] || return 1
    awk -v sec="$section" -v k="$key" '
        BEGIN { in_section = 0 }
        $0 == "[" sec "]" { in_section = 1; next }
        /^\[/ { in_section = 0 }
        in_section && $0 ~ "^" k "[[:space:]]*=" {
            match($0, /"[^"]*"/)
            if (RSTART > 0) print substr($0, RSTART+1, RLENGTH-2)
            exit
        }
    ' "$toml"
}

# Read a single key value from [section] in this PM's setup_config.toml.
read_toml_value() {
    local section="$1"
    local key="$2"
    read_toml_value_from "__garelier/$PM_ID/_pm/setup_config.toml" "$section" "$key"
}

# Read a bare (unquoted) scalar — e.g., a boolean — from [section]. The quoted
# reader above only matches "double-quoted" values, so booleans need this.
read_toml_bare() {
    local section="$1"
    local key="$2"
    local toml="__garelier/$PM_ID/_pm/setup_config.toml"
    [ -f "$toml" ] || return 1
    awk -v sec="$section" -v k="$key" '
        BEGIN { in_section = 0 }
        $0 == "[" sec "]" { in_section = 1; next }
        /^\[/ { in_section = 0 }
        in_section && $0 ~ "^" k "[[:space:]]*=" {
            v = $0
            sub(/^[^=]*=[[:space:]]*/, "", v)
            sub(/[[:space:]]*#.*$/, "", v)
            gsub(/[[:space:]]/, "", v)
            print v
            exit
        }
    ' "$toml"
}

# Detect this PM's setup state. Echoes one of:
#   complete   — setup_config.toml present and [setup] complete = true
#   partial    — any role dir under __garelier/<pm_id>/ exists but
#                completion marker is absent
#   absent     — no scaffolding for this PM
detect_setup_state() {
    local pm_root="__garelier/$PM_ID"
    local toml="$pm_root/_pm/setup_config.toml"
    if [ -f "$toml" ]; then
        if grep -q '^\[setup\]' "$toml" 2>/dev/null \
           && awk '
                BEGIN { in_section = 0 }
                $0 == "[setup]" { in_section = 1; next }
                /^\[/ { in_section = 0 }
                in_section && /^complete[[:space:]]*=[[:space:]]*true/ { found = 1; exit }
                END { exit (found ? 0 : 1) }
              ' "$toml"; then
            echo "complete"
            return
        fi
        # setup_config.toml exists but no completion marker; treat as
        # partial unless [branches] + runtime + history are all present.
        if grep -q '^\[branches\]' "$toml" 2>/dev/null \
           && [ -f "$pm_root/runtime/manifest.md" ] \
           && [ -f "$pm_root/_pm/history.md" ]; then
            echo "complete"
            return
        fi
        echo "partial"
        return
    fi
    if [ -f "$pm_root/control/control.toml" ] \
       && grep -Eq '^kind[[:space:]]*=[[:space:]]*"garelier_control"[[:space:]]*$' "$pm_root/control/control.toml" \
       && grep -Eq '^mode[[:space:]]*=[[:space:]]*"control_only"[[:space:]]*$' "$pm_root/control/control.toml"; then
        echo "starter"
        return
    fi
    if [ -d "$pm_root/runtime" ] || [ -d "$pm_root/control" ] \
       || [ -d "$pm_root/_dock" ] || [ -d "$pm_root/_workers" ] \
       || [ -d "$pm_root/_scouts" ] || [ -d "$pm_root/_smiths" ]; then
        echo "partial"
        return
    fi
    echo "absent"
}

# Resolve a non-garelier target branch for cleanup or fresh-init default.
# Priority: explicit $TARGET → existing partial config → current HEAD →
# main → develop → first non-garelier branch.
resolve_cleanup_target() {
    local candidate=""
    if [ -n "$TARGET" ] && [[ "$TARGET" != garelier/* ]]; then
        candidate="$TARGET"
    fi
    if [ -z "$candidate" ] && [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ]; then
        candidate="$(read_toml_value branches target || true)"
        case "$candidate" in garelier/*) candidate="" ;; esac
    fi
    if [ -z "$candidate" ]; then
        local cur
        cur="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
        case "$cur" in garelier/*) ;; "") ;; *) candidate="$cur" ;; esac
    fi
    if [ -z "$candidate" ]; then
        for cand in main develop; do
            if git rev-parse --verify "$cand" >/dev/null 2>&1; then
                candidate="$cand"
                break
            fi
        done
    fi
    if [ -z "$candidate" ]; then
        candidate="$(git for-each-ref --format='%(refname:short)' refs/heads/ \
                     | grep -v '^garelier/' | head -n1)"
    fi
    echo "$candidate"
}

# Tear down a partial Garelier install for this PM so fresh mode can retry.
# Removes worktrees under __garelier/<pm_id>/_workers, _scouts, and _smiths,
# switches the primary worktree off any garelier/* branch onto $1,
# deletes only the specified studio branch, and removes __garelier/<pm_id>/.
cleanup_partial_install() {
    local target_for_switch="$1"
    local studio_to_delete="$2"
    local pm_root="__garelier/$PM_ID"

    case "$target_for_switch" in
        garelier/*|"")
            echo "Error: cleanup target '$target_for_switch' is not a valid user target." >&2
            echo "       Pass --target <branch> explicitly to recover." >&2
            return 1
            ;;
    esac

    if git worktree list --porcelain >/dev/null 2>&1; then
        while IFS= read -r wtline; do
            case "$wtline" in
                worktree\ *)
                    local wtpath="${wtline#worktree }"
                    case "$wtpath" in
                        */$pm_root/_workers/*|*/$pm_root/_scouts/*|*/$pm_root/_smiths/*)
                            git worktree remove --force "$wtpath" >/dev/null 2>&1 || true
                            echo "  - removed worktree $wtpath"
                            # DEC-020: drop the container (coordination files) too.
                            case "$wtpath" in */checkout) rm -rf "${wtpath%/checkout}" ;; esac
                            ;;
                    esac
                    ;;
            esac
        done < <(git worktree list --porcelain)
    fi

    local cur_branch
    cur_branch="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
    case "$cur_branch" in
        garelier/*)
            if git rev-parse --verify "$target_for_switch" >/dev/null 2>&1; then
                git checkout "$target_for_switch" >/dev/null 2>&1 || true
                echo "  - primary worktree switched back to $target_for_switch"
            else
                echo "Error: target '$target_for_switch' does not exist; cannot switch off $cur_branch." >&2
                return 1
            fi
            ;;
    esac

    if [ -n "$studio_to_delete" ] \
       && git rev-parse --verify "$studio_to_delete" >/dev/null 2>&1; then
        git branch -D "$studio_to_delete" >/dev/null 2>&1 || true
        echo "  - deleted branch $studio_to_delete"
    fi

    if [ -d "$pm_root" ]; then
        rm -rf "$pm_root"
        echo "  - removed $pm_root/"
    fi

    # DEC-051: ignore rules live in nested __garelier/.gitignore / .ignore, which
    # is shared across PMs — leave it while other PMs remain. Still clean up any
    # legacy block a pre-DEC-051 install left in the root files (best-effort).
    garelier_trim_legacy_root_block .gitignore "Garelier runtime"
    garelier_trim_legacy_root_block .ignore "Garelier search-ignore"
    # When this was the last PM, remove the orphaned nested ignore files too.
    if [ -d __garelier ] \
       && [ -z "$(find __garelier -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]; then
        rm -f __garelier/.gitignore __garelier/.ignore
        echo "  - removed orphaned __garelier/.gitignore + .ignore (no PMs left)"
    fi
}

# === DEC-035: role homes outside the project tree ===
# Worktree roles keep their container (mailbox + checkout/) in a machine-local
# studio home OUTSIDE the target project, so the worktree's CLAUDE.md ancestry
# never crosses <proj>/CLAUDE.md and a stray git in the container fails loud. A
# gitignored pointer (__garelier/<pm_id>/runtime/workspace_paths) maps
# <role>.<id> -> abs container; tools resolve through it and fall back to the
# legacy in-proj path when absent (mixed/un-migrated installs still resolve).

ws_role_plural() {  # singular pointer-key role -> plural (inverse of ws_role_singular)
    case "$1" in
        worker) echo workers ;; scout) echo scouts ;; smith) echo smiths ;;
        librarian) echo librarians ;; observer) echo observers ;;
        guardian) echo guardians ;; concierge) echo concierges ;;
        artisan) echo artisan ;; *) echo "${1}s" ;;
    esac
}

ws_role_singular() {
    case "$1" in
        workers) echo worker ;; scouts) echo scout ;; smiths) echo smith ;;
        librarians) echo librarian ;; observers) echo observer ;;
        guardians) echo guardian ;; concierges) echo concierge ;;
        artisan) echo artisan ;; *) echo "${1%s}" ;;
    esac
}

ws_home_root() {
    local r="${GARELIER_HOME:-}"
    if [ -z "$r" ] && [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ]; then
        r="$(read_toml_value workspace home_root 2>/dev/null || true)"
    fi
    [ -z "$r" ] && r="$HOME/.garelier"
    case "$r" in "~/"*) r="$HOME/${r#~/}" ;; "~") r="$HOME" ;; esac
    r="$r/studios"
    # Normalize to a native (mixed C:/...) path so BOTH git and the Bun driver
    # resolve it — a raw MSYS /c/... path breaks Bun's fs on Windows and won't
    # match `git worktree list` output. No-op on Linux/macOS.
    if command -v cygpath >/dev/null 2>&1; then r="$(cygpath -m "$r" 2>/dev/null || printf '%s' "$r")"; fi
    printf '%s' "$r"
}

ws_sha8() {
    if command -v sha1sum >/dev/null 2>&1; then printf '%s' "$1" | sha1sum | cut -c1-8
    elif command -v shasum >/dev/null 2>&1; then printf '%s' "$1" | shasum | cut -c1-8
    else printf '%s' "$1" | cksum | tr -d ' ' | cut -c1-8; fi
}

# home_id = <sanitized basename>-<sha1(abs git-dir)[:8]>-<pm_id>. Machine-local
# (hashes a machine-local absolute path) — never tracked; recorded in the pointer.
ws_home_id() {
    local base gitdir
    base="$(basename "$PROJECT_ROOT" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-\{1,\}//; s/-\{1,\}$//')"
    gitdir="$(git -C "$PROJECT_ROOT" rev-parse --absolute-git-dir 2>/dev/null || echo "$PROJECT_ROOT/.git")"
    printf '%s-%s-%s' "$base" "$(ws_sha8 "$gitdir")" "$PM_ID"
}

ws_legacy_container() {
    if [ "$1" = artisan ]; then printf '__garelier/%s/_artisan' "$PM_ID"
    else printf '__garelier/%s/_%s/%s' "$PM_ID" "$1" "$2"; fi
}

ws_exile_container() {
    if [ "$1" = artisan ]; then printf '%s/%s/_artisan' "$(ws_home_root)" "$(ws_home_id)"
    else printf '%s/%s/_%s/%s' "$(ws_home_root)" "$(ws_home_id)" "$1" "$2"; fi
}

ws_pointer_file() { printf '__garelier/%s/runtime/workspace_paths' "$PM_ID"; }

ws_pointer_key() {
    if [ "$1" = artisan ]; then printf 'artisan'; else printf '%s.%s' "$(ws_role_singular "$1")" "$2"; fi
}

# Resolve a role's container: pointer entry (abs exile path) else legacy in-proj.
ws_resolve_container() {
    local key pf v
    pf="$(ws_pointer_file)"; key="$(ws_pointer_key "$1" "$2")"
    if [ -f "$pf" ]; then
        v="$(awk -v k="$key" 'index($0, k"=")==1 { print substr($0, length(k)+2); exit }' "$pf")"
        if [ -n "$v" ]; then printf '%s' "$v"; return 0; fi
    fi
    ws_legacy_container "$1" "$2"
}

# Write/replace a pointer entry. Args: role id abs-container.
ws_write_pointer() {
    local key pf; pf="$(ws_pointer_file)"; key="$(ws_pointer_key "$1" "$2")"
    mkdir -p "$(dirname "$pf")"
    [ -f "$pf" ] || printf '# DEC-036 exile role-home pointer (gitignored, machine-local; only when exile opted in). <role>.<id>=<abs container>\n' > "$pf"
    awk -v k="$key" 'index($0, k"=")!=1' "$pf" > "$pf.tmp" 2>/dev/null && mv "$pf.tmp" "$pf"
    printf '%s=%s\n' "$key" "$3" >> "$pf"
}

# DEC-036: exile (a machine-local studio home OUTSIDE the project) is OPT-IN.
# The DEFAULT is in-project — it respects Claude Code's launch-folder access model
# and works in shared/restricted environments where writing outside the project is
# denied. Opt in via --exile, GARELIER_HOME, or [workspace] home_root. If an
# explicitly-requested exile home root is not writable, fall back to in-project.
ws_use_exile() {
    local want=0 hr
    [ "${WS_EXILE:-0}" = "1" ] && want=1
    [ -n "${GARELIER_HOME:-}" ] && want=1
    if [ "$want" = 0 ] && [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ]; then
        hr="$(read_toml_value workspace home_root 2>/dev/null || true)"
        [ -n "$hr" ] && [ "$hr" != ":in-project:" ] && want=1
    fi
    [ "$want" = 1 ] || return 1
    # Safety probe: only exile if the home root is actually creatable/writable.
    local root; root="$(ws_home_root)"
    mkdir -p "$root" 2>/dev/null || true
    if [ -d "$root" ] && [ -w "$root" ]; then return 0; fi
    echo "  ! exile home '$root' not writable — using in-project layout (DEC-036)" >&2
    return 1
}

# The container to CREATE for a role: in-project (default) or exile (opt-in).
ws_container() {
    if ws_use_exile; then ws_exile_container "$1" "$2"; else ws_legacy_container "$1" "$2"; fi
}

# DEC-036: an in-project role worktree (<proj>/__garelier/.../checkout) sits
# inside the target project, so Claude Code's CLAUDE.md ancestry walk from the
# checkout would ALSO load the target's mainline <proj>/CLAUDE.md (a duplicate of
# the copy already in the worktree). Identity is prompt-authoritative regardless,
# so this is only a token cost — neutralize it with the official `claudeMdExcludes`
# setting (honored headless), written into the checkout's local settings. Absolute
# globs; no-op for an exiled checkout (the excluded paths aren't on its ancestry).
write_role_settings() {
    local checkout="$1" absproj
    absproj="$PROJECT_ROOT"
    if command -v cygpath >/dev/null 2>&1; then absproj="$(cygpath -m "$absproj" 2>/dev/null || printf '%s' "$absproj")"; fi
    mkdir -p "$checkout/.claude"
    cat > "$checkout/.claude/settings.local.json" <<EOF
{
  "claudeMdExcludes": [
    "$absproj/CLAUDE.md",
    "$absproj/.claude/CLAUDE.md",
    "$absproj/.claude/rules/**"
  ]
}
EOF
    # Keep the role worktree clean: ignore the local settings within THIS worktree
    # so it never shows as untracked / gets committed to the role branch.
    local exclude="$checkout/.git"
    if [ -f "$exclude" ]; then
        # linked worktree: .git is a file -> resolve the worktree's info/exclude
        local gd; gd="$(git -C "$checkout" rev-parse --git-path info/exclude 2>/dev/null)"
        if [ -n "$gd" ]; then mkdir -p "$(dirname "$gd")"; grep -qxF '.claude/settings.local.json' "$gd" 2>/dev/null || echo '.claude/settings.local.json' >> "$gd"; fi
    fi
}

# Check whether an agent is in IDLE state.
is_agent_idle() {
    local role="$1"
    local id="$2"
    local state_file
    state_file="$(ws_resolve_container "$role" "$id")/STATE.md"
    [ -f "$state_file" ] || return 1
    grep -A1 -E "^## Status" "$state_file" 2>/dev/null \
        | tail -n+2 | head -n1 | tr -d '[:space:]' | grep -q "^IDLE$"
}

# === Helpers shared by fresh and diff for adding agents ===

# Derive a role's container dir / skill name / scout-only extra CLAUDE line.
# Sets RM_DIR, RM_SKILL, RM_EXTRA (globals) for the given role+id.
role_meta() {
    local role="$1" id="$2"
    RM_EXTRA=""
    case "$role" in
        workers)    RM_DIR="__garelier/$PM_ID/_workers/$id";    RM_SKILL="garelier-worker" ;;
        scouts)     RM_DIR="__garelier/$PM_ID/_scouts/$id";     RM_SKILL="garelier-scout"
                    RM_EXTRA="Inspections to:   $PROJECT_ROOT/__garelier/$PM_ID/control/inspections/" ;;  # DEC-035: absolute (exile home)
        smiths)     RM_DIR="__garelier/$PM_ID/_smiths/$id";     RM_SKILL="garelier-smith" ;;
        librarians) RM_DIR="__garelier/$PM_ID/_librarians/$id"; RM_SKILL="garelier-librarian" ;;
        observers)  RM_DIR="__garelier/$PM_ID/_observers/$id";  RM_SKILL="garelier-observer" ;;
        guardians)  RM_DIR="__garelier/$PM_ID/_guardians/$id";  RM_SKILL="garelier-guardian" ;;
        concierges) RM_DIR="__garelier/$PM_ID/_concierges/$id"; RM_SKILL="garelier-concierge" ;;
        artisan)    RM_DIR="__garelier/$PM_ID/_artisan";        RM_SKILL="garelier-artisan" ;;
    esac
    # DEC-035: the container may be a machine-local exile home; the pointer (if
    # present for this role/id) overrides the legacy in-proj path above.
    RM_DIR="$(ws_resolve_container "$role" "$id")"
}

# Write ONLY the role's CLAUDE.md, with DEC-020 cwd=checkout relative paths.
# Shared by fresh/diff (via write_role_files) and migrate (which must NOT reset
# STATE.md). The cwd at runtime is the git worktree at $RM_DIR/checkout — one
# level deeper than the container — so coordination files are one `../` up and
# runtime/ + control/ gain one extra `../` vs. the container depth. The artisan
# container (`_artisan`) is one level shallower than the id-scoped containers.
write_role_claude() {
    local role="$1" id="$2" provider="$3" model="$4"
    role_meta "$role" "$id"
    # DEC-035: the container may live in a machine-local home OUTSIDE the
    # project, so runtime/control/primary are addressed by ABSOLUTE path (a
    # relative `../../` would escape the home, not reach the project). The
    # coordination files (assignment/STATE) are still one `../` up from cwd.
    {
        echo "You are ${role%s} $id (provider: $provider, model: $model) in a Garelier project."
        echo "PM identifier:       $PM_ID"
        echo "Your working directory (cwd) is this git worktree — the target project tree."
        echo "Garelier coordination files are in the PARENT dir (one ../ up)."
        echo "Primary checkout (where __garelier/ lives): $PROJECT_ROOT"
        echo "Runtime directory:   $PROJECT_ROOT/__garelier/$PM_ID/runtime/"
        echo "Control directory:   $PROJECT_ROOT/__garelier/$PM_ID/control/"
        echo "Your assignment file: ../assignment.md"
        echo "Your state file: ../STATE.md"
        [ -n "$RM_EXTRA" ] && echo "$RM_EXTRA"
        echo ""
        echo "Follow the $RM_SKILL skill."
    } > "$RM_DIR/CLAUDE.md"
}

write_role_files() {
    local role="$1"     # workers, scouts, smiths, librarians, observers, guardians, concierges, artisan
    local id="$2"
    local provider="$3"
    local model="$4"

    role_meta "$role" "$id"
    local role_dir="$RM_DIR"
    write_role_claude "$role" "$id" "$provider" "$model"

    local state_branch="$STUDIO_BRANCH"

    cat > "$role_dir/STATE.md" <<EOF
# ${role%s} $id — State

## Status
IDLE

## Current branch
(detached HEAD at $state_branch)

## Current task
(none)

## Last activity
$NOW — Initialized by setup wizard

## Recent log
- $NOW Initialized by setup wizard

## Next planned action
Wait for assignment.
EOF
}

create_agent_worktree() {
    local role="$1"     # workers, scouts, or smiths
    local id="$2"
    local provider="$3"
    local model="$4"
    local path
    # DEC-036: the role container is IN-PROJECT by default
    # (<proj>/__garelier/<pm>/_<role>/<id>/) — the git worktree lives in its
    # `checkout/` subdir and the coordination files (CLAUDE.md, STATE.md, …) sit
    # beside it at the container root. Exile (a machine-local home outside the
    # project) is opt-in (ws_use_exile) and then records the gitignored
    # workspace_paths pointer; in-project relies on the resolver's default fallback.
    path="$(ws_container "$role" "$id")"
    mkdir -p "$path"
    git worktree add --detach "$path/checkout" "$STUDIO_BRANCH" >/dev/null
    ws_use_exile && ws_write_pointer "$role" "$id" "$path"
    write_role_settings "$path/checkout"   # DEC-036: claudeMdExcludes (skip the target's mainline CLAUDE.md)
    # DEC-030: a Concierge worktree gets the mechanical push guard at creation,
    # so it ships installed (doctor P0 otherwise). The Concierge also re-runs the
    # idempotent installer at pickup.
    if [ "$role" = "concierges" ]; then
        local _ct="${GARELIER_CORE_TEMPLATES_DIR:-$GARELIER_SKILLS_DIR/garelier-core/templates}"
        local _guard="${_ct%/templates}/scripts/install_concierge_guards.sh"
        if [ -f "$_guard" ]; then
            bash "$_guard" "$path/checkout" >/dev/null 2>&1 || \
                echo "  ! could not install Concierge push guard for $id (DEC-030); it installs at pickup" >&2
        fi
    fi
    write_role_files "$role" "$id" "$provider" "$model"
}

remove_agent_worktree() {
    local role="$1"
    local id="$2"
    local path
    path="$(ws_resolve_container "$role" "$id")"   # DEC-035: exile home or legacy
    # Remove the nested worktree, then the container (which also holds the
    # coordination files). Tolerate a pre-DEC-020 layout where the worktree was
    # the container itself.
    git worktree remove --force "$path/checkout" >/dev/null 2>&1 || true
    git worktree remove --force "$path" >/dev/null 2>&1 || true
    if [ -d "$path" ]; then
        rm -rf "$path"
    fi
    # DEC-035: drop the pointer entry and prune stale worktree registrations.
    local pf key; pf="$(ws_pointer_file)"; key="$(ws_pointer_key "$role" "$id")"
    if [ -f "$pf" ]; then awk -v k="$key" 'index($0, k"=")!=1' "$pf" > "$pf.tmp" 2>/dev/null && mv "$pf.tmp" "$pf"; fi
    git worktree prune >/dev/null 2>&1 || true
}

# === DEC-020 migration (worktree -> container/checkout nesting) ===
MIG_DONE=0; MIG_SKIP=0; MIG_FAIL=0

# DEC-035: relocate one role's worktree+mailbox from its legacy in-proj
# container to its machine-local exile home, and record the pointer. Handles
# both DEC-020 (worktree at $legacy/checkout) and pre-0020 flat ($legacy is the
# worktree) sources. Gate: porcelain-empty (uncommitted work is skipped; any
# committed work survives the move). role plural; id "" for artisan.
migrate_role_to_checkout() {
    local role="$1" id="$2" legacy="$3"
    local exile; exile="$(ws_exile_container "$role" "$id")"

    # Already relocated to the exile home? Ensure the pointer, reap any leftover.
    if [ -d "$exile/checkout" ]; then
        ws_write_pointer "$role" "$id" "$exile"
        [ -d "$legacy" ] && [ "$legacy" != "$exile" ] && rm -rf "$legacy" 2>/dev/null || true
        return 0
    fi
    [ -d "$legacy" ] || return 0   # nothing in-proj to migrate

    # Locate the current git worktree: nested (DEC-020) or flat (pre-0020).
    local wt=""
    if [ -e "$legacy/checkout/.git" ]; then wt="$legacy/checkout"
    elif [ -e "$legacy/.git" ]; then wt="$legacy"; fi

    # Gate: skip if the worktree has uncommitted TRACKED changes (real WIP to the
    # target code). `git worktree move` preserves everything anyway, but a tracked
    # modification means an agent may be mid-edit — re-run after it commits.
    # Untracked files are tolerated: for a pre-0020 flat worktree they are the
    # Garelier coordination files (STATE.md, …), not target work, and they ride
    # along with the move regardless.
    if [ -n "$wt" ] && [ -n "$(git -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        echo "  ! $legacy has uncommitted tracked changes — commit them, then re-run migrate" >&2
        MIG_SKIP=$((MIG_SKIP+1)); return 0
    fi

    # Preserve provider/model from the existing CLAUDE.md identity line.
    local prov="claude-code" model="claude-code" line p m
    if [ -f "$legacy/CLAUDE.md" ]; then
        line="$(head -n1 "$legacy/CLAUDE.md")"
        p="$(printf '%s' "$line" | sed -n 's/.*provider: \([^,]*\),.*/\1/p')"
        m="$(printf '%s' "$line" | sed -n 's/.*model: \([^)]*\)).*/\1/p')"
        [ -n "$p" ] && prov="$p"; [ -n "$m" ] && model="$m"
    fi

    mkdir -p "$exile"
    if [ -n "$wt" ]; then
        if ! git worktree move "$wt" "$exile/checkout" >/dev/null 2>&1; then
            # cross-drive / cross-fs: re-create on the same commit, drop the old.
            local sha; sha="$(git -C "$wt" rev-parse HEAD 2>/dev/null)"
            git worktree remove --force "$wt" >/dev/null 2>&1 || true
            if ! git worktree add --detach "$exile/checkout" "${sha:-$STUDIO_BRANCH}" >/dev/null 2>&1; then
                echo "  ! could not relocate worktree for $legacy to $exile" >&2; MIG_FAIL=$((MIG_FAIL+1)); return 0
            fi
        fi
    fi
    # Move coordination files to the exile container: from the legacy container
    # root (DEC-020) and from the relocated worktree (pre-0020 flat, where they
    # rode inside the worktree, now under $exile/checkout). The role CLAUDE.md is
    # regenerated below, so it is not pulled out of the clean checkout.
    local f
    for f in CLAUDE.md STATE.md assignment.md report.md review.md questions.md answers.md \
             under_review.md merged.md abort.md track-target.md committed.md acked.md \
             guardian_report.md concierge_report.md archive checkpoints; do
        [ -e "$legacy/$f" ] && mv "$legacy/$f" "$exile/$f" 2>/dev/null || true
    done
    for f in STATE.md assignment.md report.md review.md questions.md answers.md \
             under_review.md merged.md abort.md track-target.md committed.md acked.md \
             guardian_report.md concierge_report.md archive checkpoints; do
        [ -e "$exile/checkout/$f" ] && [ ! -e "$exile/$f" ] && mv "$exile/checkout/$f" "$exile/$f" 2>/dev/null || true
    done
    ws_write_pointer "$role" "$id" "$exile"
    write_role_claude "$role" "$id" "$prov" "$model"   # absolute-path role CLAUDE.md
    rm -rf "$legacy" 2>/dev/null || true
    git worktree prune >/dev/null 2>&1 || true
    echo "  + $legacy -> $exile"
    MIG_DONE=$((MIG_DONE+1))
}

# Nest every worktree role under $PM_ROOT into checkout/ (idempotent).
run_dec020_nesting() {
    echo ""
    echo "==> DEC-035: relocating role worktrees to the machine-local studio home ..."
    local base role d id
    for base in _workers _scouts _smiths _librarians _observers _guardians _concierges; do
        role="${base#_}"
        [ -d "__garelier/$PM_ID/$base" ] || continue
        for d in "__garelier/$PM_ID/$base"/*/; do
            [ -d "$d" ] || continue
            id="$(basename "$d")"
            migrate_role_to_checkout "$role" "$id" "__garelier/$PM_ID/$base/$id"
        done
    done
    [ -d "__garelier/$PM_ID/_artisan" ] && migrate_role_to_checkout artisan "" "__garelier/$PM_ID/_artisan"
    echo "  DEC-035 relocate: $MIG_DONE relocated, $MIG_SKIP skipped (uncommitted), $MIG_FAIL failed"
    [ "$MIG_FAIL" -eq 0 ]
}

# DEC-036: the INVERSE — relocate one role's worktree+mailbox from its machine-
# local exile home BACK into the project, write claudeMdExcludes, drop the pointer.
# Args: role(plural) id exile-container.
migrate_role_to_inproject() {
    local role="$1" id="$2" exile="$3"
    local inproj; inproj="$(ws_legacy_container "$role" "$id")"
    local pf key; pf="$(ws_pointer_file)"; key="$(ws_pointer_key "$role" "$id")"

    # Already in-project? just drop the stale pointer entry.
    if [ -e "$inproj/checkout/.git" ]; then
        [ -f "$pf" ] && { awk -v k="$key" 'index($0, k"=")!=1' "$pf" > "$pf.tmp" 2>/dev/null && mv "$pf.tmp" "$pf"; }
        [ -d "$exile" ] && [ "$exile" != "$inproj" ] && rm -rf "$exile" 2>/dev/null || true
        return 0
    fi
    [ -e "$exile/checkout/.git" ] || return 0   # nothing at exile to move

    # Gate: skip if the exile worktree has uncommitted TRACKED changes (real WIP).
    if [ -n "$(git -C "$exile/checkout" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        echo "  ! $exile has uncommitted tracked changes — commit them, then re-run migrate" >&2
        MIG_SKIP=$((MIG_SKIP+1)); return 0
    fi

    # Preserve provider/model from the existing CLAUDE.md identity line.
    local prov="claude-code" model="claude-code" line p m
    if [ -f "$exile/CLAUDE.md" ]; then
        line="$(head -n1 "$exile/CLAUDE.md")"
        p="$(printf '%s' "$line" | sed -n 's/.*provider: \([^,]*\),.*/\1/p')"
        m="$(printf '%s' "$line" | sed -n 's/.*model: \([^)]*\)).*/\1/p')"
        [ -n "$p" ] && prov="$p"; [ -n "$m" ] && model="$m"
    fi

    mkdir -p "$inproj"
    if ! git worktree move "$exile/checkout" "$inproj/checkout" >/dev/null 2>&1; then
        # cross-drive / cross-fs: re-create on the same commit, drop the old.
        local sha; sha="$(git -C "$exile/checkout" rev-parse HEAD 2>/dev/null)"
        git worktree remove --force "$exile/checkout" >/dev/null 2>&1 || true
        if ! git worktree add --detach "$inproj/checkout" "${sha:-$STUDIO_BRANCH}" >/dev/null 2>&1; then
            echo "  ! could not relocate worktree $exile -> $inproj" >&2; MIG_FAIL=$((MIG_FAIL+1)); return 0
        fi
    fi
    # Move coordination files exile container -> in-proj container.
    local f
    for f in STATE.md assignment.md report.md review.md questions.md answers.md \
             under_review.md merged.md abort.md track-target.md committed.md acked.md \
             guardian_report.md concierge_report.md archive checkpoints; do
        [ -e "$exile/$f" ] && mv "$exile/$f" "$inproj/$f" 2>/dev/null || true
    done
    # Drop the pointer FIRST so write_role_claude (via ws_resolve_container) targets
    # the in-proj container, then regenerate CLAUDE.md + claudeMdExcludes there.
    [ -f "$pf" ] && { awk -v k="$key" 'index($0, k"=")!=1' "$pf" > "$pf.tmp" 2>/dev/null && mv "$pf.tmp" "$pf"; }
    write_role_settings "$inproj/checkout"
    write_role_claude "$role" "$id" "$prov" "$model"
    [ -d "$exile" ] && rm -rf "$exile" 2>/dev/null || true
    git worktree prune >/dev/null 2>&1 || true
    MIG_DONE=$((MIG_DONE+1))
    echo "  + $exile -> $inproj"
}

# Relocate every EXILED role (pointer entries) back into the project.
run_relocate_to_inproject() {
    echo ""
    echo "==> DEC-036: relocating role worktrees back into the project ..."
    local pf; pf="$(ws_pointer_file)"
    if [ ! -f "$pf" ]; then echo "  no workspace_paths pointer — already in-project"; return 0; fi
    # Snapshot the entries (the pointer is rewritten as we drop them).
    local entries; entries="$(grep -vE '^\s*#|^\s*$' "$pf" 2>/dev/null || true)"
    local line key val role id rsing
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        key="${line%%=*}"; val="${line#*=}"
        if [ "$key" = "artisan" ]; then role="artisan"; id=""
        else rsing="${key%%.*}"; id="${key#*.}"; role="$(ws_role_plural "$rsing")"; fi
        migrate_role_to_inproject "$role" "$id" "$val"
    done <<EOF
$entries
EOF
    # Remove the pointer file if it is now empty (only the comment header left).
    [ -f "$pf" ] && [ -z "$(grep -vE '^\s*#|^\s*$' "$pf" 2>/dev/null)" ] && rm -f "$pf"
    echo "  DEC-036 relocate: $MIG_DONE relocated, $MIG_SKIP skipped (uncommitted), $MIG_FAIL failed"
    [ "$MIG_FAIL" -eq 0 ]
}

# Direction dispatcher: exile is opt-in (--exile/GARELIER_HOME/home_root); the
# default relocates BACK in-project. Idempotent in both directions.
run_relocate() {
    if ws_use_exile; then run_dec020_nesting; else run_relocate_to_inproject; fi
}

# Attempt to fast-forward / merge <target> into the integration branch.
# Returns 0 on success, non-zero on conflict (with merge aborted).
integrate_target_into_studio() {
    git checkout "$STUDIO_BRANCH" >/dev/null 2>&1
    if git merge-base --is-ancestor "$TARGET" HEAD >/dev/null 2>&1; then
        return 0
    fi
    if git merge --no-edit "$TARGET" >/dev/null 2>&1; then
        echo "  + integrated $TARGET into $STUDIO_BRANCH"
        return 0
    fi
    git merge --abort >/dev/null 2>&1 || true
    echo "  ! merge of $TARGET into $STUDIO_BRANCH had conflicts" >&2
    echo "  ! PM must resolve manually (see DEC-001 §2.5) then re-run." >&2
    return 3
}

# Resolve the pm_id, prompting if needed. Used by fresh and migrate.
# Sets the global PM_ID. Honors --pm-id when set, otherwise prompts
# (or accepts the default in --skip-confirm mode).
resolve_pm_id_interactively() {
    if [ -n "$PM_ID" ]; then
        validate_pm_id "$PM_ID" || exit 1
        return 0
    fi
    local default_id
    default_id="$(default_pm_id)"
    # Non-TTY guard: when invoked from an AI agent / driver / CI etc.
    # (stdin is not a terminal), refuse to silently apply a derived
    # default. Shared/multi-user projects require a unique explicit id.
    if [ ! -t 0 ]; then
        echo "Error: --pm-id was not provided and stdin is not a terminal." >&2
        echo "  Re-run with --pm-id _workshop for a single-user project," >&2
        echo "  or a unique --pm-id <slug> for a shared/multi-user project." >&2
        exit 2
    fi
    if [ "$SKIP_CONFIRM" = "true" ]; then
        if [ -z "$default_id" ]; then
            echo "Error: no default pm_id is available; pass --pm-id explicitly." >&2
            exit 1
        fi
        PM_ID="$default_id"
        validate_pm_id "$PM_ID" || exit 1
        return 0
    fi
    while true; do
        if [ -n "$default_id" ]; then
            printf "PM identifier (default: %s): " "$default_id" >&2
        else
            printf "PM identifier: " >&2
        fi
        read -r entered
        if [ -z "$entered" ]; then
            entered="$default_id"
        fi
        if validate_pm_id "$entered"; then
            PM_ID="$entered"
            return 0
        fi
    done
}

# === Mode-specific entry points ===

if [ "$MODE" = "fresh" ]; then

    # === FRESH MODE ===

    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Error: $PROJECT_ROOT is not inside a git repository." >&2
        exit 1
    fi
    if ! git rev-parse HEAD >/dev/null 2>&1; then
        echo "Error: repository has no commits. Make at least one commit first." >&2
        exit 1
    fi

    # Resolve pm_id BEFORE checking for existing layout.
    resolve_pm_id_interactively
    UPGRADE_CONTROL_ONLY=false

    # Abort if this exact pm_id is already present and fully initialized.
    if [ -d "__garelier/$PM_ID" ]; then
        # If the PM dir exists, check its state.
        SETUP_STATE="$(detect_setup_state)"
        case "$SETUP_STATE" in
            complete)
                echo "Error: PM '$PM_ID' already initialized at __garelier/$PM_ID/." >&2
                echo "       Choose another --pm-id, or cd __garelier/$PM_ID/_pm and use --mode diff." >&2
                exit 1
                ;;
            partial)
                echo "Detected a partial install for PM '$PM_ID' (wizard was interrupted)." >&2
                echo "" >&2
                echo "Found leftovers under __garelier/$PM_ID/:" >&2
                for d in __garelier/$PM_ID/runtime __garelier/$PM_ID/control \
                         __garelier/$PM_ID/_pm __garelier/$PM_ID/_dock \
                         __garelier/$PM_ID/_workers __garelier/$PM_ID/_scouts \
                         __garelier/$PM_ID/_smiths; do
                    [ -e "$d" ] && echo "  - $d" >&2
                done
                for br in $(git for-each-ref --format='%(refname:short)' "refs/heads/garelier/*/$PM_ID/studio" 2>/dev/null); do
                    echo "  - branch $br" >&2
                done
                for wt in $(git worktree list --porcelain 2>/dev/null | awk '/^worktree / { print $2 }' | grep -E "__garelier/$PM_ID/_(workers|scouts|smiths)/" || true); do
                    echo "  - worktree $wt" >&2
                done
                echo "" >&2

                CLEANUP_TARGET="$(resolve_cleanup_target)"
                if [ -z "$CLEANUP_TARGET" ]; then
                    echo "Error: cannot determine a non-Garelier branch to switch to." >&2
                    echo "       Pass --target <branch> explicitly to recover." >&2
                    exit 1
                fi
                STUDIO_TO_DELETE=""
                if [ -f "__garelier/$PM_ID/_pm/setup_config.toml" ]; then
                    STUDIO_TO_DELETE="$(read_toml_value branches integration || true)"
                fi
                if [ -z "$STUDIO_TO_DELETE" ]; then
                    STUDIO_TO_DELETE="garelier/$(slugify_target "$CLEANUP_TARGET")/$PM_ID/studio"
                fi

                if [ "$SKIP_CONFIRM" = "true" ]; then
                    echo "Auto-cleaning (--skip-confirm passed)." >&2
                    cleanup_partial_install "$CLEANUP_TARGET" "$STUDIO_TO_DELETE" || exit 1
                else
                    echo "Cleanup target: $CLEANUP_TARGET (real branch to switch to)" >&2
                    echo "Studio to delete: $STUDIO_TO_DELETE" >&2
                    printf "Clean these up and continue with fresh init? [y/N] " >&2
                    read -r response
                    case "$response" in
                        [yY]|[yY][eE][sS])
                            cleanup_partial_install "$CLEANUP_TARGET" "$STUDIO_TO_DELETE" || exit 1
                            ;;
                        *)
                            echo "Aborted. Resolve the partial install manually then re-run." >&2
                            exit 1
                            ;;
                    esac
                fi
                ;;
            starter)
                UPGRADE_CONTROL_ONLY=true
                echo "Detected a Garelier small starter at __garelier/$PM_ID/." >&2
                echo "Its existing control and knowledge will be preserved while full Garelier is added." >&2
                ;;
            absent)
                : # PM dir exists but empty — odd but allowed.
                ;;
        esac
    fi

    if [ -z "$TARGET" ]; then
        TARGET="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"
        if [ -z "$TARGET" ]; then
            echo "Error: cannot determine current branch (detached HEAD?). Pass --target <branch>." >&2
            exit 1
        fi
    fi
    if ! git rev-parse --verify "$TARGET" >/dev/null 2>&1; then
        echo "Error: target branch '$TARGET' does not exist." >&2
        exit 1
    fi

    TARGET_SLUG="$(slugify_target "$TARGET")"
    STUDIO_BRANCH="garelier/$TARGET_SLUG/$PM_ID/studio"

    # Refuse to clobber a different PM that already owns the same studio branch.
    if git rev-parse --verify "$STUDIO_BRANCH" >/dev/null 2>&1; then
        echo "Error: branch $STUDIO_BRANCH already exists." >&2
        echo "       Either choose a different --pm-id, or delete the stale branch first." >&2
        exit 1
    fi

    WORKER_ENTRIES_STR="$(parse_entries "$WORKERS")"
    SCOUT_ENTRIES_STR="$(parse_entries "$SCOUTS")"
    SMITH_ENTRIES_STR="$(parse_entries "$SMITHS")"
    read -ra WORKER_ENTRIES <<< "$WORKER_ENTRIES_STR"
    read -ra SCOUT_ENTRIES <<< "$SCOUT_ENTRIES_STR"
    read -ra SMITH_ENTRIES <<< "$SMITH_ENTRIES_STR"
    LIBRARIAN_ENTRIES_STR="$(parse_entries "$LIBRARIANS")"
    OBSERVER_ENTRIES_STR="$(parse_entries "$OBSERVERS")"
    GUARDIAN_ENTRIES_STR="$(parse_entries "$GUARDIANS")"
    CONCIERGE_ENTRIES_STR="$(parse_entries "$CONCIERGES")"
    read -ra LIBRARIAN_ENTRIES <<< "$LIBRARIAN_ENTRIES_STR"
    read -ra OBSERVER_ENTRIES <<< "$OBSERVER_ENTRIES_STR"
    read -ra GUARDIAN_ENTRIES <<< "$GUARDIAN_ENTRIES_STR"
    read -ra CONCIERGE_ENTRIES <<< "$CONCIERGE_ENTRIES_STR"
    # Resolve the (optional) Artisan identity.
    ARTISAN_ID="artisan-01"; ARTISAN_PROVIDER="claude-code"; ARTISAN_MODEL="claude-code"
    if [ -n "$ARTISAN_SPEC" ]; then
        read -ra _sol_arr <<< "$(parse_entries "$ARTISAN_SPEC")"
        if [ "${#_sol_arr[@]}" -gt 1 ]; then
            echo "Error: the Artisan is a singleton — only one --artisan entry is allowed (got ${#_sol_arr[@]}). (DEC-017/DEC-056)" >&2
            exit 1
        fi
        if [ "${#_sol_arr[@]}" -gt 0 ]; then
            ARTISAN_ID="$(entry_id "${_sol_arr[0]}")"
            ARTISAN_PROVIDER="$(entry_provider "${_sol_arr[0]}")"
            ARTISAN_MODEL="$(entry_model "${_sol_arr[0]}")"
        fi
    fi

    PM_ROOT="__garelier/$PM_ID"

    echo "Garelier setup plan (fresh mode)"
    echo "================================="
    echo "  Project name:   $PROJECT_NAME"
    echo "  Project root:   $PROJECT_ROOT"
    echo "  PM identifier:  $PM_ID"
    echo "  PM root:        $PM_ROOT"
    echo "  Target branch:  $TARGET"
    echo "  Target slug:    $TARGET_SLUG"
    echo "  Will create branch: $STUDIO_BRANCH (from $TARGET)"
    echo "  Workers (${#WORKER_ENTRIES[@]}):"
    for e in "${WORKER_ENTRIES[@]}"; do echo "      + $e"; done
    echo "  Scouts (${#SCOUT_ENTRIES[@]}):"
    for e in "${SCOUT_ENTRIES[@]}"; do echo "      + $e"; done
    echo "  Smiths (${#SMITH_ENTRIES[@]}):"
    for e in "${SMITH_ENTRIES[@]}"; do echo "      + $e"; done
    echo ""

    if [ "$SKIP_CONFIRM" != "true" ]; then
        printf "Proceed? [y/N] "
        read -r response
        case "$response" in [yY]|[yY][eE][sS]) ;; *) echo "Aborted."; exit 0 ;; esac
    fi

    # Create the PM root early so all subsequent writes have a home.
    mkdir -p "$PM_ROOT/_pm"

    echo ""
    echo "==> Creating integration (studio) branch..."
    git branch "$STUDIO_BRANCH" "$TARGET"
    echo "  + $STUDIO_BRANCH created from $TARGET"
    git checkout "$STUDIO_BRANCH" >/dev/null 2>&1
    echo "  + primary worktree switched to $STUDIO_BRANCH"

    echo ""
    echo "==> Creating $PM_ROOT/runtime/ structure..."
    mkdir -p "$PM_ROOT/runtime/dock/inbox" "$PM_ROOT/runtime/dock/inbox-archive"
    mkdir -p "$PM_ROOT/runtime/dock/escalation" "$PM_ROOT/runtime/dock/escalation-archive"
    mkdir -p "$PM_ROOT/runtime/pm/inbox" "$PM_ROOT/runtime/pm/inbox-archive" "$PM_ROOT/runtime/pm/resolutions"
    mkdir -p "$PM_ROOT/runtime/backlog/done" "$PM_ROOT/runtime/backlog/archive" "$PM_ROOT/runtime/backlog/requeued"
    mkdir -p "$PM_ROOT/runtime/driver"
    mkdir -p "$PM_ROOT/runtime/requests/inbox" "$PM_ROOT/runtime/requests/processing"
    mkdir -p "$PM_ROOT/runtime/requests/processed" "$PM_ROOT/runtime/requests/rejected"
    mkdir -p "$PM_ROOT/runtime/requests/failed" "$PM_ROOT/runtime/requests/locks"
    mkdir -p "$PM_ROOT/runtime/scheduled_jobs/locks" "$PM_ROOT/runtime/scheduled_jobs/runs"
    # DEC-007: merge gate async subprocess artifacts
    mkdir -p "$PM_ROOT/runtime/merge_gate/requests" "$PM_ROOT/runtime/merge_gate/results"
    mkdir -p "$PM_ROOT/runtime/merge_gate/logs"     "$PM_ROOT/runtime/merge_gate/locks"
    mkdir -p "$PM_ROOT/runtime/merge_gate/archive"
    # Observer (DEC-019) request/result inbox (sidecar; both lanes).
    mkdir -p "$PM_ROOT/runtime/observer/inbox" "$PM_ROOT/runtime/observer/requests"
    mkdir -p "$PM_ROOT/runtime/observer/results" "$PM_ROOT/runtime/observer/locks"
    # Guardian (DEC-024) gate request/result inbox (security gate; both lanes).
    mkdir -p "$PM_ROOT/runtime/guardian/inbox" "$PM_ROOT/runtime/guardian/requests"
    mkdir -p "$PM_ROOT/runtime/guardian/results" "$PM_ROOT/runtime/guardian/locks"
    # Concierge (DEC-025) external-operations request/result inbox + archive.
    mkdir -p "$PM_ROOT/runtime/concierge/inbox" "$PM_ROOT/runtime/concierge/requests"
    mkdir -p "$PM_ROOT/runtime/concierge/results" "$PM_ROOT/runtime/concierge/locks"
    mkdir -p "$PM_ROOT/runtime/concierge/archive"
    # Librarian (DEC-038) local-only working area: raw external pulls, sync
    # cache, pre-publication drafts. Gitignored via runtime/. Curated knowledge
    # is promoted to the TRACKED docs/garelier/<category>/ trees on a shelf branch.
    mkdir -p "$PM_ROOT/runtime/librarian/raw" "$PM_ROOT/runtime/librarian/cache" "$PM_ROOT/runtime/librarian/drafts"
    if [ ! -f "$PM_ROOT/runtime/librarian/README.md" ]; then
        cat > "$PM_ROOT/runtime/librarian/README.md" <<'LIBREADME'
# Librarian local-only working area (NOT committed)

Gitignored (under `runtime/`). Holds the Librarian's machine-local working
material; nothing here is shared or committed.

- `raw/`    — raw external pulls (fetched pages, downloads) before review.
- `cache/`  — sync caches keyed by source (see knowledge/source_registry.toml).
- `drafts/` — pre-publication drafts of knowledge files.

**Curated, shareable knowledge is promoted to the TRACKED trees** under
`docs/garelier/<category>/` (engineering / quality / review / system /
security / external_operations) via a `shelf` branch reviewed by Dock.
Never commit raw external content with unknown license or PII — see
`docs/garelier/security/commit_hygiene_policy.md` + `license_policy.md`.
LIBREADME
    fi
    touch "$PM_ROOT/runtime/dock/inbox/.gitkeep"
    touch "$PM_ROOT/runtime/dock/escalation/.gitkeep"
    touch "$PM_ROOT/runtime/pm/inbox/.gitkeep"
    touch "$PM_ROOT/runtime/backlog/done/.gitkeep"
    touch "$PM_ROOT/runtime/backlog/requeued/.gitkeep"
    touch "$PM_ROOT/runtime/requests/inbox/.gitkeep"
    touch "$PM_ROOT/runtime/requests/rejected/.gitkeep"
    touch "$PM_ROOT/runtime/scheduled_jobs/locks/.gitkeep"
    echo "  + $PM_ROOT/runtime/ tree created"

    mkdir -p "$PM_ROOT/_pm/history/archive"
    touch "$PM_ROOT/_pm/history/archive/.gitkeep"

    echo ""
    echo "==> Creating $PM_ROOT/control/ structure..."
    mkdir -p "$PM_ROOT/control/project_dashboard"
    mkdir -p "$PM_ROOT/control/operations"
    mkdir -p "$PM_ROOT/control/blueprints/archive"
    mkdir -p "$PM_ROOT/control/delegation"
    mkdir -p "$PM_ROOT/control/inspections/tech"
    mkdir -p "$PM_ROOT/control/inspections/market"
    mkdir -p "$PM_ROOT/control/inspections/status"
    mkdir -p "$PM_ROOT/control/request_intake/templates"
    mkdir -p "$PM_ROOT/control/scheduled_jobs/templates" "$PM_ROOT/control/scheduled_jobs/examples"
    mkdir -p "$PM_ROOT/control/decisions"
    mkdir -p "$PM_ROOT/control/reports/promote"
    mkdir -p "$PM_ROOT/control/reports/benchmark"
    mkdir -p "$PM_ROOT/control/reports/data_audit"
    mkdir -p "$PM_ROOT/control/reports/requests"
    mkdir -p "$PM_ROOT/control/reports/delegated_requests"
    mkdir -p "$PM_ROOT/control/reports/notifications"
    mkdir -p "$PM_ROOT/control/reports/scheduled_jobs"
    # Observer (DEC-019) accepted observations, committed by PM/Dock/Artisan.
    mkdir -p "$PM_ROOT/control/observations"
    touch "$PM_ROOT/control/observations/.gitkeep"
    touch "$PM_ROOT/control/blueprints/archive/.gitkeep"
    touch "$PM_ROOT/control/inspections/tech/.gitkeep"
    touch "$PM_ROOT/control/inspections/market/.gitkeep"
    touch "$PM_ROOT/control/inspections/status/.gitkeep"
    touch "$PM_ROOT/control/reports/promote/.gitkeep"
    touch "$PM_ROOT/control/reports/benchmark/.gitkeep"
    touch "$PM_ROOT/control/reports/data_audit/.gitkeep"
    touch "$PM_ROOT/control/reports/requests/.gitkeep"
    touch "$PM_ROOT/control/reports/delegated_requests/.gitkeep"
    touch "$PM_ROOT/control/reports/notifications/.gitkeep"
    touch "$PM_ROOT/control/reports/scheduled_jobs/.gitkeep"

    CORE_TEMPLATES_DIR="${GARELIER_CORE_TEMPLATES_DIR:-$GARELIER_SKILLS_DIR/garelier-core/templates}"
    if [ "$UPGRADE_CONTROL_ONLY" != "true" ]; then
    cat > "$PM_ROOT/control/README.md" <<EOF
# Garelier Control — PM: $PM_ID

This tree holds the persistent project authority for PM \`$PM_ID\`:
project dashboard, operations rules, blueprints, inspections, request
intake, delegation, scheduled jobs, decisions, and reports.

Sibling \`$PM_ROOT/runtime/\` holds transient execution state.

For the read order and authority order, see
\`project_dashboard/README.md\` and the individual operations files.
EOF
    cat > "$PM_ROOT/control/project_dashboard/README.md" <<'EOF'
# Project Dashboard

Persistent planning state for this PM. The order of authority
(highest first):

1. ../operations/  (safety rules)
2. quality_gates.md
3. decisions.md
4. current.md
5. roadmap.md
6. backlog.md
7. notes.md  (lowest authority)

`notes.md` is unsorted scratch; promote validated entries to a
higher-authority file and trim notes when they outgrow.
EOF
    cat > "$PM_ROOT/control/project_dashboard/current.md" <<'EOF'
# Current

(populate when the project starts work)
EOF
    cat > "$PM_ROOT/control/project_dashboard/roadmap.md" <<'EOF'
# Roadmap

(populate as milestones are defined)
EOF
    cat > "$PM_ROOT/control/project_dashboard/backlog.md" <<'EOF'
# Backlog

(populate as work items accumulate)
EOF
    cat > "$PM_ROOT/control/project_dashboard/decisions.md" <<'EOF'
# Decisions

(append settled judgments here; reference DECs when applicable)
EOF
    cat > "$PM_ROOT/control/project_dashboard/risks.md" <<'EOF'
# Risks

(populate as risks are identified)
EOF
    cat > "$PM_ROOT/control/project_dashboard/quality_gates.md" <<'EOF'
# Quality Gates

Completion criteria that bind review and promote. See AGENTS.md §2
for the project's quality-gate commands.
EOF
    cat > "$PM_ROOT/control/project_dashboard/notes.md" <<'EOF'
# Notes

Unsorted scratch. Lowest authority. Promote validated entries to
the appropriate higher-authority file.
EOF
    cat > "$PM_ROOT/control/operations/README.md" <<'EOF'
# Operations

Highest-authority rules. Editing these is a Garelier-wide change.

- runbook.md             — startup/shutdown/monitoring
- promote_checklist.md   — what must hold before studio → target
- recovery.md            — driver crashes, marker collisions, etc.
- data_change_policy.md  — guardrails for any data-mutating task
EOF
    cat > "$PM_ROOT/control/operations/runbook.md" <<EOF
# Runbook

Project: $PROJECT_NAME
PM:            $PM_ID
Target branch: $TARGET
Studio branch: $STUDIO_BRANCH

(Add project-specific startup/shutdown notes here.)
EOF
    cat > "$PM_ROOT/control/operations/promote_checklist.md" <<'EOF'
# Promote Checklist

Before promoting studio to target:

- [ ] Studio branch is clean.
- [ ] All workbench branches are merged or explicitly abandoned.
- [ ] Required tests passed.
- [ ] Quality gates in project_dashboard/quality_gates.md are satisfied.
- [ ] Active risks are reviewed.
- [ ] Runtime manifest is consistent with reality.
- [ ] Smith hardening targets remaining is 0, or PM recorded an explicit user waiver.
- [ ] No production data write is pending.
- [ ] User explicitly approved this promote.
EOF
    cat > "$PM_ROOT/control/operations/recovery.md" <<'EOF'
# Recovery

Procedures for recovering from driver crashes, state inconsistency,
and marker-file corruption. See the framework recovery template for
the full procedure.
EOF
    cat > "$PM_ROOT/control/operations/data_change_policy.md" <<'EOF'
# Data Change Policy

Any task that mutates external data must:

- Run in a dry-run mode that prints intended changes.
- Provide before/after counts and sample changed records.
- Include a rollback plan in the blueprint and report.
- Show explicit user approval (timestamp + words) in `_pm/history.md`.
- Not commit secrets.
- Treat customer-facing notifications as data-changing; allowlisted
  scheduled-job operational email must be audited in reports/notifications/.

Dock refuses the merge gate if any of the above is missing.
EOF
    CONTROL_SCAFFOLD_TEMPLATE="$CORE_TEMPLATES_DIR/control_scaffold"
    if [ -d "$CONTROL_SCAFFOLD_TEMPLATE" ]; then
        cp -R "$CONTROL_SCAFFOLD_TEMPLATE"/. "$PM_ROOT/control/"
        echo "  + control_scaffold templates copied"
    else
        echo "ERROR: canonical control_scaffold template not found at $CONTROL_SCAFFOLD_TEMPLATE" >&2
        return 1
    fi
    else
        echo "  = existing small-starter control preserved"
    fi
    cat > "$PM_ROOT/control/control.toml" <<EOF
schema_version = 1
kind = "garelier_control"
pm_id = "$PM_ID"
mode = "full"
EOF
    # Guardian security knowledge (DEC-024): seed docs/garelier/security/ from
    # the Librarian-owned defaults if absent. PM/user curate from there.
    LIBRARIAN_TEMPLATES_DIR="${GARELIER_LIBRARIAN_TEMPLATES_DIR:-${CORE_TEMPLATES_DIR/garelier-core/garelier-librarian}}"
    SECURITY_SCAFFOLD="$LIBRARIAN_TEMPLATES_DIR/security"
    if [ -d "$SECURITY_SCAFFOLD" ] && [ ! -d "docs/garelier/security" ]; then
        mkdir -p "docs/garelier/security"
        cp -R "$SECURITY_SCAFFOLD"/. "docs/garelier/security/"
        echo "  + Guardian security knowledge seeded at docs/garelier/security/ (edit per project)"
    fi
    # Librarian-managed role knowledge trees (DEC-029): seed if absent. PM/user
    # curate from there; gate/producing roles read but do not edit. No-overwrite.
    for KTREE in engineering quality review system; do
        KSCAFFOLD="$LIBRARIAN_TEMPLATES_DIR/$KTREE"
        if [ -d "$KSCAFFOLD" ] && [ ! -d "docs/garelier/$KTREE" ]; then
            mkdir -p "docs/garelier/$KTREE"
            cp -R "$KSCAFFOLD"/. "docs/garelier/$KTREE/"
            echo "  + Librarian $KTREE knowledge seeded at docs/garelier/$KTREE/ (edit per project)"
        fi
    done
    # Concierge external-operation policy (DEC-025) and routine runbooks are
    # referenced by default role knowledge / registries, so fresh setup must
    # install their starter docs too. No-overwrite.
    EXTERNAL_OPS_SCAFFOLD="$LIBRARIAN_TEMPLATES_DIR/external_operations"
    if [ -d "$EXTERNAL_OPS_SCAFFOLD" ] && [ ! -d "docs/garelier/external_operations" ]; then
        mkdir -p "docs/garelier/external_operations"
        cp -R "$EXTERNAL_OPS_SCAFFOLD"/. "docs/garelier/external_operations/"
        echo "  + Concierge external-operations knowledge seeded at docs/garelier/external_operations/ (edit per project)"
    fi
    RUNBOOKS_SCAFFOLD="$LIBRARIAN_TEMPLATES_DIR/runbooks"
    if [ -d "$RUNBOOKS_SCAFFOLD" ] && [ ! -d "docs/garelier/runbooks" ]; then
        mkdir -p "docs/garelier/runbooks"
        cp -R "$RUNBOOKS_SCAFFOLD"/. "docs/garelier/runbooks/"
        echo "  + Librarian runbooks seeded at docs/garelier/runbooks/ (edit per project)"
    fi
    # Role knowledge index (DEC-048): the by-role reading map every role reads
    # first (read_first set), authoritative for the role->docs mapping. Seed to
    # docs/garelier/knowledge/ if absent. No-overwrite.
    if [ -f "$LIBRARIAN_TEMPLATES_DIR/role_index.toml" ] && [ ! -f "docs/garelier/knowledge/role_index.toml" ]; then
        mkdir -p "docs/garelier/knowledge"
        cp "$LIBRARIAN_TEMPLATES_DIR/role_index.toml" "docs/garelier/knowledge/role_index.toml"
        echo "  + Role knowledge index seeded at docs/garelier/knowledge/role_index.toml (DEC-048)"
    fi
    # Git command policy (DEC-048 capability invariant): the SoT for which git
    # commands roles may run. The driver grant is CI-enforced to mirror it; roles
    # consult it. Seed if absent. No-overwrite.
    if [ -f "$LIBRARIAN_TEMPLATES_DIR/git_command_policy.toml" ] && [ ! -f "docs/garelier/knowledge/git_command_policy.toml" ]; then
        mkdir -p "docs/garelier/knowledge"
        cp "$LIBRARIAN_TEMPLATES_DIR/git_command_policy.toml" "docs/garelier/knowledge/git_command_policy.toml"
        echo "  + Git command policy seeded at docs/garelier/knowledge/git_command_policy.toml (DEC-048)"
    fi
    # Librarian registries (DEC-029 / DEC-018): seed the starter source_registry +
    # routine_registry so the console + Librarian have them from day one (the
    # Librarian curates entries later). No-overwrite.
    for REG in source_registry routine_registry; do
        if [ -f "$LIBRARIAN_TEMPLATES_DIR/$REG.toml" ] && [ ! -f "docs/garelier/knowledge/$REG.toml" ]; then
            mkdir -p "docs/garelier/knowledge"
            cp "$LIBRARIAN_TEMPLATES_DIR/$REG.toml" "docs/garelier/knowledge/$REG.toml"
            echo "  + Librarian registry seeded at docs/garelier/knowledge/$REG.toml"
        fi
    done
    if [ -f "$LIBRARIAN_TEMPLATES_DIR/knowledge.toml" ] && [ ! -f "docs/garelier/knowledge/knowledge.toml" ]; then
        cp "$LIBRARIAN_TEMPLATES_DIR/knowledge.toml" "docs/garelier/knowledge/knowledge.toml"
        echo "  + Knowledge contract marker seeded at docs/garelier/knowledge/knowledge.toml"
    fi
    echo "  + $PM_ROOT/control/ tree created"

    echo ""
    echo "==> Creating $PM_ROOT/_dock/ subdirectory..."
    mkdir -p "$PM_ROOT/_dock"
    cat > "$PM_ROOT/_dock/CLAUDE.md" <<EOF
You are the Dock in a Garelier project.
PM identifier:       $PM_ID
Project root:        ../../../
Runtime directory:   ../runtime/
Control directory:   ../control/

Follow the garelier-dock skill.
EOF
    echo "  + $PM_ROOT/_dock/CLAUDE.md placed"

    echo ""
    echo "==> Creating Worker worktrees..."
    for entry in "${WORKER_ENTRIES[@]}"; do
        worker_id="$(entry_id "$entry")"; worker_provider="$(entry_provider "$entry")"; worker_model="$(entry_model "$entry")"
        create_agent_worktree workers "$worker_id" "$worker_provider" "$worker_model"
        echo "  + $worker_id ($worker_provider:$worker_model) at $PM_ROOT/_workers/$worker_id"
    done

    echo ""
    echo "==> Creating Scout worktrees..."
    for entry in "${SCOUT_ENTRIES[@]}"; do
        scout_id="$(entry_id "$entry")"; scout_provider="$(entry_provider "$entry")"; scout_model="$(entry_model "$entry")"
        create_agent_worktree scouts "$scout_id" "$scout_provider" "$scout_model"
        echo "  + $scout_id ($scout_provider:$scout_model) at $PM_ROOT/_scouts/$scout_id"
    done

    echo ""
    echo "==> Creating Smith worktrees..."
    for entry in "${SMITH_ENTRIES[@]}"; do
        smith_id="$(entry_id "$entry")"; smith_provider="$(entry_provider "$entry")"; smith_model="$(entry_model "$entry")"
        create_agent_worktree smiths "$smith_id" "$smith_provider" "$smith_model"
        echo "  + $smith_id ($smith_provider:$smith_model) at $PM_ROOT/_smiths/$smith_id"
    done

    if [ "${#LIBRARIAN_ENTRIES[@]}" -gt 0 ]; then
        echo ""
        echo "==> Creating Librarian worktrees..."
        for entry in "${LIBRARIAN_ENTRIES[@]}"; do
            lib_id="$(entry_id "$entry")"; lib_provider="$(entry_provider "$entry")"; lib_model="$(entry_model "$entry")"
            create_agent_worktree librarians "$lib_id" "$lib_provider" "$lib_model"
            echo "  + $lib_id ($lib_provider:$lib_model) at $PM_ROOT/_librarians/$lib_id"
        done
    fi
    if [ "${#OBSERVER_ENTRIES[@]}" -gt 0 ]; then
        echo ""
        echo "==> Creating Observer worktrees..."
        for entry in "${OBSERVER_ENTRIES[@]}"; do
            obs_id="$(entry_id "$entry")"; obs_provider="$(entry_provider "$entry")"; obs_model="$(entry_model "$entry")"
            create_agent_worktree observers "$obs_id" "$obs_provider" "$obs_model"
            echo "  + $obs_id ($obs_provider:$obs_model) at $PM_ROOT/_observers/$obs_id"
        done
    fi
    if [ "${#GUARDIAN_ENTRIES[@]}" -gt 0 ]; then
        echo ""
        echo "==> Creating Guardian worktrees..."
        for entry in "${GUARDIAN_ENTRIES[@]}"; do
            grd_id="$(entry_id "$entry")"; grd_provider="$(entry_provider "$entry")"; grd_model="$(entry_model "$entry")"
            create_agent_worktree guardians "$grd_id" "$grd_provider" "$grd_model"
            echo "  + $grd_id ($grd_provider:$grd_model) at $PM_ROOT/_guardians/$grd_id"
        done
    fi
    if [ "${#CONCIERGE_ENTRIES[@]}" -gt 0 ]; then
        echo ""
        echo "==> Creating Concierge worktrees..."
        for entry in "${CONCIERGE_ENTRIES[@]}"; do
            con_id="$(entry_id "$entry")"; con_provider="$(entry_provider "$entry")"; con_model="$(entry_model "$entry")"
            create_agent_worktree concierges "$con_id" "$con_provider" "$con_model"
            echo "  + $con_id ($con_provider:$con_model) at $PM_ROOT/_concierges/$con_id"
        done
    fi
    if [ "$ARTISAN_ENABLE" = "true" ]; then
        echo ""
        echo "==> Creating Artisan worktree..."
        # Artisan branches `satchel` from and integrates it into studio (DEC-045).
        # DEC-036: in-project by default; exile (+pointer) is opt-in.
        sol_c="$(ws_container artisan "")"
        mkdir -p "$sol_c"
        git worktree add --detach "$sol_c/checkout" "$STUDIO_BRANCH" >/dev/null
        ws_use_exile && ws_write_pointer artisan "" "$sol_c"
        write_role_settings "$sol_c/checkout"
        write_role_files artisan "$ARTISAN_ID" "$ARTISAN_PROVIDER" "$ARTISAN_MODEL"
        echo "  + $ARTISAN_ID ($ARTISAN_PROVIDER:$ARTISAN_MODEL) at $sol_c"
    fi

    # Observer policy is enabled automatically when Observers are configured.
    OBS_POLICY_ENABLED="false"
    [ "${#OBSERVER_ENTRIES[@]}" -gt 0 ] && OBS_POLICY_ENABLED="true"

    # Guardian policy is enabled automatically when Guardians are configured;
    # otherwise it stays disabled by default (DEC-024).
    GRD_POLICY_ENABLED="false"
    [ "${#GUARDIAN_ENTRIES[@]}" -gt 0 ] && GRD_POLICY_ENABLED="true"

    # Concierge policy is enabled automatically when Concierges are configured;
    # otherwise it stays disabled by default (DEC-025).
    CON_POLICY_ENABLED="false"
    [ "${#CONCIERGE_ENTRIES[@]}" -gt 0 ] && CON_POLICY_ENABLED="true"

    # Resolve quality-gate commands + validate the autonomy profile (P0-4/P0-5).
    case "$PERMISSION_PROFILE" in
        safe|reviewed|dangerous) ;;
        *) echo "Error: --permission-profile must be safe|reviewed|dangerous (got: $PERMISSION_PROFILE)." >&2; exit 1 ;;
    esac
    case "$AGENTS_POLICY" in
        strict|minimal) ;;
        *) echo "Error: --agents-policy must be strict|minimal (got: $AGENTS_POLICY)." >&2; exit 1 ;;
    esac
    if [ "${#QG_CMDS[@]}" -eq 0 ]; then
        while IFS= read -r _qgc; do [ -n "$_qgc" ] && QG_CMDS+=("$_qgc"); done < <(qg_defaults_for_stack "$STACK")
    fi
    if [ "${#QG_CMDS[@]}" -eq 0 ]; then
        echo "Error: quality gate has no commands. stack=\"$STACK\" has no default set." >&2
        echo "       Pass --stack rust|typescript|python|go, or one or more --quality-gate \"<cmd>\"." >&2
        echo "       (stack=custom and stack=mixed always require explicit --quality-gate.)" >&2
        exit 1
    fi
    if [ "$PERMISSION_PROFILE" = "dangerous" ]; then
        echo "WARNING: permission profile 'dangerous' grants full provider access"
        echo "         (Claude --dangerously-skip-permissions / Codex danger-full-access)."
        echo "         Use only in an isolated environment. Recorded in setup_config.toml."
    fi

    echo ""
    echo "==> Generating $PM_ROOT/_pm/setup_config.toml..."
    {
        echo "# Garelier setup configuration"
        echo "# Generated by setup_wizard.sh on $NOW"
        echo "#"
        echo "# Add or remove agents by re-running setup_wizard.sh in --mode diff"
        echo "# from inside $PM_ROOT/_pm/."
        echo "# To enable health check warnings, uncomment the [health_check] section"
        echo "# at the bottom and adjust thresholds."
        echo ""
        echo "[project]"
        echo "name = \"$PROJECT_NAME\""
        echo "initialized_at = \"$NOW\""
        echo "garelier_version = \"2.5.0\""
        echo ""
        echo "[pm]"
        echo "pm_id = \"$PM_ID\""
        echo ""
        echo "[branches]"
        echo "target = \"$TARGET\""
        echo "target_slug = \"$TARGET_SLUG\""
        echo "integration = \"$STUDIO_BRANCH\""
        echo ""
        echo "[runner]"
        echo "pm_provider = \"claude-code\""
        echo "pm_model = \"claude-code\""
        echo "dock_provider = \"claude-code\""
        echo "dock_model = \"claude-code\""
        echo "default_agent_provider = \"claude-code\""
        echo "default_agent_model = \"claude-code\""
        echo "# Optional per-role / per-agent effort. Applied on driver start;"
        echo "# changing it while the driver is running requires restart."
        echo "# pm_effort = \"xhigh\""
        echo "# dock_effort = \"xhigh\""
        echo "# default_agent_effort = \"xhigh\""
        echo ""
        for entry in "${WORKER_ENTRIES[@]}"; do
            worker_id="$(entry_id "$entry")"; worker_provider="$(entry_provider "$entry")"; worker_model="$(entry_model "$entry")"
            echo "[[workers]]"
            echo "id = \"$worker_id\""
            echo "provider = \"$worker_provider\""
            echo "model = \"$worker_model\""
            echo "# effort = \"xhigh\""
            echo "worktree = \"$PM_ROOT/_workers/$worker_id\""
            echo ""
        done
        for entry in "${SCOUT_ENTRIES[@]}"; do
            scout_id="$(entry_id "$entry")"; scout_provider="$(entry_provider "$entry")"; scout_model="$(entry_model "$entry")"
            echo "[[scouts]]"
            echo "id = \"$scout_id\""
            echo "provider = \"$scout_provider\""
            echo "model = \"$scout_model\""
            echo "# effort = \"xhigh\""
            echo "worktree = \"$PM_ROOT/_scouts/$scout_id\""
            echo "idle_task = $SCOUT_IDLE_TASK"
            echo "idle_interval_hours = 24"
            echo ""
        done
        for entry in "${SMITH_ENTRIES[@]}"; do
            smith_id="$(entry_id "$entry")"; smith_provider="$(entry_provider "$entry")"; smith_model="$(entry_model "$entry")"
            echo "[[smiths]]"
            echo "id = \"$smith_id\""
            echo "provider = \"$smith_provider\""
            echo "model = \"$smith_model\""
            echo "# effort = \"xhigh\""
            echo "worktree = \"$PM_ROOT/_smiths/$smith_id\""
            echo ""
        done
        echo "# === Lane selection (DEC-056) ==="
        echo "#"
        echo "# Lane the driver runs when runtime/lane.lock is absent. \"dock\""
        echo "# (default) = the parallel pipeline; \"artisan\" = the single-agent"
        echo "# Artisan lane runs by default (small projects). An explicit"
        echo "# lane.lock still overrides this per task."
        echo "[lanes]"
        echo "default = \"$DEFAULT_LANE\""
        echo ""
        echo "# === Artisan (artisan lane) ==="
        echo "#"
        echo "# The Artisan performs the combined Dock + Worker + Scout + Smith +"
        echo "# Librarian scope by ITSELF — build, investigation/web research, and"
        echo "# knowledge work — on a \`satchel\` branch, then passes Guardian +"
        echo "# Observer and integrates into \`studio\` (DEC-045). SINGLETON: one"
        echo "# [artisan] table only. Mutually exclusive with the dock lane"
        echo "# (arbitrated by runtime/lane.lock)."
        echo "[artisan]"
        echo "enabled = $ARTISAN_ENABLE"
        echo "id = \"$ARTISAN_ID\""
        echo "provider = \"$ARTISAN_PROVIDER\""
        echo "model = \"$ARTISAN_MODEL\""
        echo "# effort = \"xhigh\""
        echo "worktree = \"$PM_ROOT/_artisan\""
        echo "branch_namespace = \"satchel\""
        echo ""
        echo "# === Librarian definitions (dock lane) ==="
        echo "#"
        echo "# One [[librarians]] block per Librarian instance. Librarians do"
        echo "# knowledge / registry / runbook work on a \`shelf\` branch, merged"
        echo "# through Dock review. Dock-subordinate; never dispatched"
        echo "# directly by PM."
        if [ "${#LIBRARIAN_ENTRIES[@]}" -gt 0 ]; then
            for entry in "${LIBRARIAN_ENTRIES[@]}"; do
                lib_id="$(entry_id "$entry")"; lib_provider="$(entry_provider "$entry")"; lib_model="$(entry_model "$entry")"
                echo "[[librarians]]"
                echo "id = \"$lib_id\""
                echo "provider = \"$lib_provider\""
                echo "model = \"$lib_model\""
                echo "enabled = true"
                echo "# effort = \"xhigh\""
                echo "worktree = \"$PM_ROOT/_librarians/$lib_id\""
                echo "branch_namespace = \"shelf\""
                echo ""
            done
        else
            echo "# (none configured — add one [[librarians]] block per Librarian)"
            echo ""
        fi
        echo "# === Observer definitions (read-only review/advice sidecar, DEC-019) ==="
        echo "#"
        echo "# One [[observers]] block per Observer. Commit-free; runs in both"
        echo "# lanes; never takes lane.lock. Gated by [observer_policy] below."
        if [ "${#OBSERVER_ENTRIES[@]}" -gt 0 ]; then
            for entry in "${OBSERVER_ENTRIES[@]}"; do
                obs_id="$(entry_id "$entry")"; obs_provider="$(entry_provider "$entry")"; obs_model="$(entry_model "$entry")"
                echo "[[observers]]"
                echo "id = \"$obs_id\""
                echo "provider = \"$obs_provider\""
                echo "model = \"$obs_model\""
                echo "enabled = true"
                echo "# effort = \"xhigh\""
                echo "worktree = \"$PM_ROOT/_observers/$obs_id\""
                echo "allowed_request_kinds = [\"merge_review\", \"artisan_premerge_review\", \"direction_advice\", \"architecture_risk_review\", \"policy_consistency_review\"]"
                echo ""
            done
        else
            echo "# (none configured — add one [[observers]] block per Observer)"
            echo ""
        fi
        echo "# === Guardian definitions (security/privacy/dependency/license gate, DEC-024) ==="
        echo "#"
        echo "# One [[guardians]] block per Guardian. Commit-free; runs on an"
        echo "# ephemeral \`gavel\` branch; gated by [guardian_policy] below."
        if [ "${#GUARDIAN_ENTRIES[@]}" -gt 0 ]; then
            for entry in "${GUARDIAN_ENTRIES[@]}"; do
                grd_id="$(entry_id "$entry")"; grd_provider="$(entry_provider "$entry")"; grd_model="$(entry_model "$entry")"
                echo "[[guardians]]"
                echo "id = \"$grd_id\""
                echo "provider = \"$grd_provider\""
                echo "model = \"$grd_model\""
                echo "enabled = true"
                echo "# effort = \"xhigh\""
                echo "checkout = true"
                echo "worktree = \"$PM_ROOT/_guardians/$grd_id\""
                echo "allowed_request_kinds = [\"preflight\", \"delta_gate\", \"final_gate\", \"promote_gate\", \"knowledge_update_request\"]"
                echo ""
            done
        else
            echo "# (none configured — add one [[guardians]] block per Guardian)"
            echo ""
        fi
        echo "# === Concierge definitions (external operations executor, DEC-025) ==="
        echo "#"
        echo "# One [[concierges]] block per Concierge. Always checkout=true (external"
        echo "# operations need live git state); runs on a \`clipboard\` branch; gated"
        echo "# by [concierge_policy] below."
        if [ "${#CONCIERGE_ENTRIES[@]}" -gt 0 ]; then
            for entry in "${CONCIERGE_ENTRIES[@]}"; do
                con_id="$(entry_id "$entry")"; con_provider="$(entry_provider "$entry")"; con_model="$(entry_model "$entry")"
                echo "[[concierges]]"
                echo "id = \"$con_id\""
                echo "provider = \"$con_provider\""
                echo "model = \"$con_model\""
                echo "enabled = true"
                echo "# effort = \"xhigh\""
                echo "checkout = true"
                echo "worktree = \"$PM_ROOT/_concierges/$con_id\""
                echo "branch_namespace = \"clipboard\""
                echo "allowed_operation_kinds = [\"promote_target\", \"sync_remote\"]"
                echo ""
            done
        else
            echo "# (none configured — add one [[concierges]] block per Concierge)"
            echo ""
        fi
        echo "[milestones]"
        echo "current = []"
        echo ""
        echo "# === Status Web Console (read-only) ==="
        echo "#"
        echo "# A local, read-only browser view of Garelier state (lane, roles,"
        echo "# branches, merge gate, recent reports, warnings, source/routine"
        echo "# registries). Zero AI tokens — it only reads runtime files. Start it"
        echo "# with \`bun run status -- --pm-id <pm_id>\` from the driver directory."
        echo "# It binds to loopback only and never mutates state."
        echo "[status_web]"
        echo "enabled = false              # informational; the standalone command runs regardless"
        echo "host = \"127.0.0.1\"           # loopback only; non-loopback values are rejected"
        echo "port = 3787"
        echo "auto_refresh_seconds = 5"
        echo "read_only = true             # phase 1 is read-only; no operation UI"
        echo "show_source_urls = true      # false => show only the host of source registry URLs"
        echo ""
        echo "# === Retention (high-volume operation) ==="
        echo "#"
        echo "# Defaults from garelier-core/retention.md. Tune when daily reports,"
        echo "# Scout inspections, or runtime archives become high-volume."
        echo "[retention]"
        echo "history_hot_entries = 120"
        echo "history_archive_granularity = \"month\""
        echo "inspection_path_granularity = \"month\""
        echo "inspection_monthly_summary = true"
        echo "runtime_archive_keep_days = 30"
        echo "runtime_archive_keep_files = 300"
        echo "merge_gate_archive_keep_days = 14"
        echo "role_local_archive_keep_days = 30"
        echo ""
        echo "# === Execution backend (DEC-042) ==="
        echo "#"
        echo "# This axis only configures the now-DISABLED headless driver (DEC-061: the driver"
        echo "# refuses to launch in this dispatch-only build; retained as historical/reference)."
        echo "# It does NOT affect dispatch. Model + effort stay your per-role choice; this NEVER"
        echo "# tiers/downgrades. Provider terms and billing are the operator's responsibility."
        echo "#   headless (driver path, DISABLED per DEC-061) — classic 'claude -p'. An absent"
        echo "#       [execution] section also defaults to headless (back-compat)."
        echo "#   codex — run iterations with the Codex CLI ('codex exec') instead. A per-role"
        echo "#       provider = \"codex-cli\" is also respected."
        echo "[execution]"
        echo "backend = \"headless\""
        echo ""
        echo "# === Concurrency cap (DEC-027) ==="
        echo "#"
        echo "# A memory bound on how many detached provider CLIs run at once. Enabling"
        echo "# every role is encouraged for governance, but launching them all at once"
        echo "# can exhaust machine memory. The driver counts live detached children each"
        echo "# poll and launches at most max_concurrent_agents; over-budget roles are"
        echo "# deferred to a later poll (and aged so a low-priority role can't starve)."
        echo "# PM, Dock, and the merge-gate subprocess are NOT counted here."
        echo "#"
        echo "# Rough rule of thumb: ~1.5-2 GB RAM per concurrent provider CLI. 4 suits"
        echo "# an 8-16 GB machine. Set max_concurrent_agents = 0 to disable the cap."
        echo "[concurrency]"
        echo "max_concurrent_agents = 4"
        echo "tiers = [[\"concierge\", \"guardian\", \"observer\"], [\"smith\", \"librarian\"], [\"worker\", \"scout\", \"artisan\"], []]"
        echo "starvation_cycles = 3"
        echo ""
        echo "# === Output control (DEC-028) ==="
        echo "#"
        echo "# Keeps provider FINAL responses short and driver logs from bloating, on top"
        echo "# of compact-handoff + retention. Over-budget responses are WARNED, not failed."
        echo "# Never shortens code/paths/commands/URLs/errors/SHAs, never hides risks."
        echo "[output_control]"
        echo "enabled = true"
        echo "default_profile = \"compact\"          # normal | compact | micro"
        echo "violation_mode = \"warn\"              # warn (observe) | fail (experimental)"
        echo "model_result_log_chars = 600         # excerpt cap in driver JSONL (100-5000)"
        echo "error_tail_chars = 500"
        echo "driver_log_max_bytes = 10485760      # rotate JSONL past this size"
        echo "driver_log_keep_files = 10"
        echo "usage_summary = true                 # runtime/driver/usage/YYYY-MM.jsonl"
        echo ""
        echo "[output_control.profiles.normal]"
        echo "soft_result_chars = 1600"
        echo "max_bullets = 8"
        echo "[output_control.profiles.compact]"
        echo "soft_result_chars = 900"
        echo "max_bullets = 5"
        echo "[output_control.profiles.micro]"
        echo "soft_result_chars = 500"
        echo "max_bullets = 3"
        echo ""
        echo "# guardian/concierge stay normal so warnings/approvals are not pressured short."
        echo "[output_control.roles]"
        echo "pm = \"normal\""
        echo "dock = \"compact\""
        echo "worker = \"compact\""
        echo "smith = \"compact\""
        echo "artisan = \"compact\""
        echo "scout = \"micro\""
        echo "observer = \"micro\""
        echo "librarian = \"compact\""
        echo "guardian = \"normal\""
        echo "concierge = \"normal\""
        echo ""
        echo "# === Optional: Health check ==="
        echo "#"
        echo "# Uncomment to enable. PM will perform a stale-state scan when the"
        echo "# user explicitly invokes a health check (garelier-pm/references/history-and-operations.md §14)."
        echo "# Thresholds are in hours. Omit any threshold to disable that check."
        echo "#"
        echo "# [health_check]"
        echo "# worker_working_warn_hours = 24"
        echo "# worker_blocked_warn_hours = 12"
        echo "# scout_working_warn_hours = 12"
        echo "# scout_reporting_warn_hours = 6"
        echo "# dock_silent_warn_hours = 24"
        echo "# pending_backlog_warn_hours = 48"
        echo ""
        echo "# === Optional: Autonomous mode ==="
        echo "#"
        echo "# Garelier can run unattended for large, long-running roadmaps."
        echo "# Set enabled = true to start the driver and skip PM user-confirmation"
        echo "# gates (per auto_approve_* flags). Promote flow ALWAYS requires"
        echo "# explicit user instruction; there is no auto_promote flag."
        echo "# See DEC-002 (autonomous mode)."
        echo "#"
        echo "# [autonomy]"
        echo "# enabled = false                          # top-level switch (autonomous /loop is opt-in)"
        echo "# auto_approve_blueprints = false          # PM auto-proceeds on its own judgment (soft-gate collapse)"
        echo "# auto_approve_milestones = false          # (Mode A's \"proceed when safe\" lives here, WITHIN B/D)"
        echo "#"
        echo "# # Canonical modes (DEC-059) — Garelier ALWAYS runs an interactive PM."
        echo "# # DEFAULT is \"d\" (dispatch) even when this block is absent; set \"b\" for the driver."
        echo "# mode = \"d\"                               # \"d\" = interactive PM + DISPATCH (DEFAULT; in-session subagents)"
        echo "#                                          # \"b\" = interactive PM + headless DRIVER (DISABLED, DEC-061; historical/reference)"
        echo "#"
        echo "# # Mode B (driver) supervision:"
        echo "# driver_poll_interval_seconds = 30        # how often the driver invokes role iterations"
        echo "# supervise_pm = true                      # false = hybrid: driver skips PM; user runs interactive PM in _pm/"
        echo "#"
        echo "# # Mode D (DEC-059 gated Dock auto-loop; see garelier-dock/references/mode-d-tick.md):"
        echo "# fan_out_cap = 3                          # max parallel producer subagents per tick"
        echo "# protected_paths = [                      # HARD gates to the human PM (engine-core/protected)"
        echo "#   \"core/engine/**\", \"Cargo.toml\", \"Cargo.lock\", \".github/**\", \"infra/**\", \"deploy/**\", \"migrations/**\","
        echo "# ]"
        echo ""
        echo "# === Quality gate (DEC-007) ==="
        echo "#"
        echo "# Commands run by the merge-gate subprocess after"
        echo "# 'git merge --no-ff --no-commit'. Each is a single shell line."
        echo "# Failure of any aborts the merge. The subprocess runs in the"
        echo "# background relative to driver iterations so Workers, Scouts, and Smiths"
        echo "# continue in parallel during the merge."
        echo "#"
        echo "# Garelier targets any large app, not just Rust. 'stack' picks a"
        echo "# default command set; 'commands' overrides it (explicit wins)."
        echo "[quality_gate]"
        echo "stack = \"$STACK\""
        echo "commands = ["
        for _qgc in "${QG_CMDS[@]}"; do echo "    \"$_qgc\","; done
        echo "]"
        echo "timeout_minutes_per_cmd = 120"
        echo ""
        echo "# === Permissions (autonomy profile) ==="
        echo "#"
        echo "# dangerous = full provider access (opt-in: Claude"
        echo "# --dangerously-skip-permissions / Codex danger-full-access)."
        echo "# reviewed = auto-accept edits / workspace-write. safe = inspection only."
        echo "[permissions]"
        echo "profile = \"$PERMISSION_PROFILE\""
        echo "allow_network = false"
        echo "allow_destructive_commands = false"
        echo "allow_secret_read = false"
        echo "require_pm_approval_paths = [\".env*\", \"infra/**\", \"migrations/**\", \".github/workflows/**\", \"deploy/**\"]"
        echo "forbidden_paths = [\"**/*.pem\", \"**/*secret*\", \"**/id_rsa\"]"
        echo ""
        echo "# === Observer policy (DEC-019) ==="
        echo "#"
        echo "# When Observer review is mandatory. Disabled by default; enable +"
        echo "# add [[observers]] blocks to gate merges with independent review."
        echo "[observer_policy]"
        echo "enabled = $OBS_POLICY_ENABLED"
        echo "require_for_all_merges = true         # review EVERY merge (worker->guardian->observer->dock); false = review only on the triggers below"
        echo "require_for_artisan_premerge = true"
        echo "require_for_large_diff = true"
        echo "large_diff_lines = 800"
        echo "require_for_protected_paths = true"
        echo "require_for_public_api_change = true"
        echo "require_for_migration = true"
        echo "require_for_auth_security = true"
        echo "allow_worker_direction_request = true"
        echo "max_parallel_requests = 1"
        echo "advice_is_binding = false"
        echo "# [[observers]] — one block per Observer; see the setup_config.toml template."
        echo ""
        echo "# === Guardian policy (DEC-024) ==="
        echo "#"
        echo "# Guardian is the security GATE: commit-free, on an ephemeral \`gavel\`"
        echo "# branch, reads Librarian-owned security knowledge"
        echo "# (docs/garelier/security/) and emits PASS / PASS_WITH_NOTES / BLOCK /"
        echo "# NO_OPINION. Disabled by default; enable + add [[guardians]] blocks."
        echo "[guardian_policy]"
        echo "enabled = $GRD_POLICY_ENABLED"
        echo "require_for_all_merges = true         # security-gate EVERY merge (guardian step of worker->guardian->observer->dock); false = gate only on the mechanical triggers below"
        echo "branch_namespace = \"gavel\""
        echo "# Gate timings (delta is the core; preflight/final are staged)."
        echo "require_delta_before_observer = true"
        echo "require_final_before_merge = true"
        echo "require_for_artisan_premerge = true"
        echo "require_for_promote = true"
        echo "# Mechanical triggers (when a gate is mandatory)."
        echo "require_for_dependency_changes = true"
        echo "require_for_lockfile_changes = true"
        echo "require_for_auth_security = true"
        echo "require_for_config_infra_ci_deploy = true"
        echo "require_for_protected_paths = true"
        echo "# Blocking rules."
        echo "block_on_secret = true"
        echo "block_on_pii = true"
        echo "block_on_customer_data = true"
        echo "block_on_private_key = true"
        echo "block_on_critical_vulnerability = true"
        echo "block_on_high_vulnerability = true"
        echo "block_on_forbidden_license = true"
        echo "block_on_unknown_license = false"
        echo "block_when_required_scanner_unavailable = true"
        echo "# Output safety."
        echo "redact_evidence = true"
        echo "forbid_secret_value_in_report = true"
        echo ""
        echo "[guardian_policy.security_sensitive_paths]"
        echo "paths = [\".env*\", \"**/*.pem\", \"**/*.key\", \"**/*secret*\", \"**/*credential*\", \"infra/**\", \"deploy/**\", \".github/workflows/**\", \"migrations/**\"]"
        echo ""
        echo "[guardian_policy.package_files]"
        echo "paths = [\"package.json\", \"package-lock.json\", \"pnpm-lock.yaml\", \"yarn.lock\", \"Cargo.toml\", \"Cargo.lock\", \"requirements.txt\", \"pyproject.toml\", \"poetry.lock\", \"go.mod\", \"go.sum\"]"
        echo ""
        echo "# Scanner commands. Empty = Guardian uses available project tools and"
        echo "# reports NO_OPINION/BLOCK per policy if a required command is missing."
        echo "# If gitleaks cannot be used, PM may set:"
        echo "#   block_when_required_scanner_unavailable = false"
        echo "#   secret_scan = \"off\""
        echo "# Guardian then runs in degraded mode and must report that scanner coverage"
        echo "# was intentionally disabled; it must not claim full secret-scanner coverage."
        echo "[guardian_tools]"
        echo "secret_scan = \"gitleaks detect --no-banner --redact --source .\""
        echo "pii_scan = \"\""
        echo "dependency_scan = \"\""
        echo "license_scan = \"\""
        echo "sast_scan = \"\""
        echo "# [[guardians]] — one block per Guardian; see the setup_config.toml template."
        echo ""
        echo "# === Concierge policy (external operations executor, DEC-025) ==="
        echo "#"
        echo "# Concierge EXECUTES PM-approved operations that leave Garelier's local"
        echo "# sandbox (Phase 1: promote_target + read-only sync_remote). Reads"
        echo "# Librarian-owned docs/garelier/external_operations/ and consumes the"
        echo "# Guardian promote_gate verdict. Disabled by default; enable + add"
        echo "# [[concierges]] blocks. Enabling does NOT auto-push — external writes"
        echo "# still require an explicit user instruction behind the PM assignment."
        echo "[concierge_policy]"
        echo "enabled = $CON_POLICY_ENABLED"
        echo "branch_namespace = \"clipboard\""
        echo "require_pm_approval = true"
        echo "require_user_instruction_for_write = true"
        echo "require_librarian_policy_sources = true"
        echo "require_guardian_before_external_write = true"
        echo "require_external_lock = true"
        echo "forbid_push_garelier_branches = true"
        echo "forbid_force_push = true"
        echo "forbid_blind_git_pull = true"
        echo "redact_sensitive_output = true"
        echo "# Remote-visible work uses these prefixes — never garelier/* (Phase 2)."
        echo "allowed_external_branch_prefixes = [\"publish/\", \"pr/\", \"release/\"]"
        echo ""
        echo "[concierge_policy.required_knowledge]"
        echo "paths = ["
        echo "    \"docs/garelier/external_operations/external_operations_policy.md\","
        echo "    \"docs/garelier/external_operations/git_remote_policy.md\","
        echo "    \"docs/garelier/external_operations/promote_policy.md\","
        echo "    \"docs/garelier/external_operations/rollback_policy.md\","
        echo "]"
        echo "# [[concierges]] — one block per Concierge; see the setup_config.toml template."
    } > "$PM_ROOT/_pm/setup_config.toml"
    echo "  + $PM_ROOT/_pm/setup_config.toml written"

    echo ""
    echo "==> Generating $PM_ROOT/_pm/.claude/settings.json (SessionStart digest + SessionEnd hook)..."
    mkdir -p "$PM_ROOT/_pm/.claude"
    {
        echo '{'
        echo '  "hooks": {'
        echo '    "SessionStart": ['
        echo '      {'
        echo '        "hooks": ['
        echo '          {'
        echo '            "type": "command",'
        echo '            "command": "bash \"$HOME/.claude/skills/garelier-core/scripts/session_digest.sh\" 2>/dev/null || true"'
        echo '          }'
        echo '        ]'
        echo '      }'
        echo '    ],'
        echo '    "SessionEnd": ['
        echo '      {'
        echo '        "hooks": ['
        echo '          {'
        echo '            "type": "command",'
        echo '            "command": "test -n \"${GARELIER_DRIVER:-}\" || { mkdir -p ../runtime/driver && touch ../runtime/driver/stop; }"'
        echo '          }'
        echo '        ]'
        echo '      }'
        echo '    ]'
        echo '  }'
        echo '}'
    } > "$PM_ROOT/_pm/.claude/settings.json"
    echo "  + $PM_ROOT/_pm/.claude/settings.json written (SessionStart shows a token-free status digest)"

    echo ""
    echo "==> Generating $PM_ROOT/_pm/history.md..."
    {
        echo "# Garelier PM History — $PM_ID"
        echo ""
        echo "Hot index of blueprints PM has dispatched. PM appends here while"
        echo "entries are active/recent, then rotates old completed entries into"
        echo "_pm/history/archive/YYYY-MM.md per garelier-core/retention.md."
        echo ""
        echo "Entries are numbered sequentially. The number is also the"
        echo "user-visible reference for re-execution (\"re-run #042\")."
        echo ""
        echo "## Archived history"
        echo ""
        echo "(none yet)"
        echo ""
        echo "## #001 — $NOW — Project initialized"
        echo "- Blueprint: -"
        echo "- Milestone: -"
        echo "- Outcome: setup-only (no blueprint dispatched)"
        echo "- Notes: PM \"$PM_ID\" for project \"$PROJECT_NAME\" initialized by setup_wizard. target=$TARGET, integration=$STUDIO_BRANCH"
        echo ""
        echo "<!-- Next entry number: 2 -->"
    } > "$PM_ROOT/_pm/history.md"
    echo "  + $PM_ROOT/_pm/history.md written"

    echo ""
    echo "==> Generating initial $PM_ROOT/runtime/manifest.md..."
    {
        echo "# Runtime Manifest — $PM_ID"
        echo ""
        echo "Last updated: $NOW"
        echo "Updated by: setup_wizard"
        echo "Garelier version: 2.5.0"
        echo "PM: $PM_ID"
        echo "Target branch: $TARGET"
        echo "Integration (studio) branch: $STUDIO_BRANCH"
        echo ""
        echo "## Active milestones"
        echo ""
        echo "(none yet — PM will define after setup)"
        echo ""
        echo "## Active Workers"
        echo ""
        echo "| Worker | State | Milestone | Phase | Task |"
        echo "| ------ | ----- | --------- | ----- | ---- |"
        for entry in "${WORKER_ENTRIES[@]}"; do
            echo "| ${entry%%:*} | IDLE | - | - | - |"
        done
        echo ""
        echo "## Active Scouts"
        echo ""
        echo "| Scout | State | Investigation |"
        echo "| ----- | ----- | ------------- |"
        for entry in "${SCOUT_ENTRIES[@]}"; do
            echo "| ${entry%%:*} | IDLE | - |"
        done
        echo ""
        echo "## Active Smiths"
        echo ""
        echo "| Smith | State | Focus | Task |"
        echo "| ----- | ----- | ----- | ---- |"
        for entry in "${SMITH_ENTRIES[@]}"; do
            echo "| ${entry%%:*} | IDLE | - | - |"
        done
        echo ""
        echo "## Backlog summary"
        echo ""
        echo "- Pending: 0 items"
        echo "- In flight: 0 items"
        echo "- Smith hardening targets remaining: 0 (pending 0, active 0)"
        echo "- Done this milestone: 0 items"
        echo ""
        echo "## Open escalations"
        echo ""
        echo "(none)"
        echo ""
        echo "## Recent activity"
        echo ""
        echo "- $NOW — setup_wizard — PM $PM_ID initialized ($PROJECT_NAME)"
    } > "$PM_ROOT/runtime/manifest.md"
    echo "  + $PM_ROOT/runtime/manifest.md written"

    echo ""
    echo "==> Writing nested __garelier/.gitignore + .ignore (DEC-051; root untouched)..."
    garelier_write_nested_ignores

    echo ""
    echo "==> Creating AGENTS.md skeleton..."
    if [ -f AGENTS.md ]; then
        echo "  ~ AGENTS.md already exists (skipping)"
    else
        AGENTS_TEMPLATE="$CORE_TEMPLATES_DIR/agents.md"
        if [ -f "$AGENTS_TEMPLATE" ]; then
            # Pre-fill the §1 language / build / test fields from --stack so a
            # fresh AGENTS.md needs no manual edit for the derivable parts. Only
            # genuinely project-specific fields (restricted files, conventions)
            # are left as {{placeholders}} for the human to complete.
            case "$STACK" in
                rust)       AG_LANG="Rust";       AG_BUILD="cargo build --workspace"; AG_TEST="cargo test --workspace" ;;
                typescript) AG_LANG="TypeScript"; AG_BUILD="npm run build";            AG_TEST="npm test" ;;
                python)     AG_LANG="Python";     AG_BUILD="python -m build";          AG_TEST="pytest" ;;
                go)         AG_LANG="Go";         AG_BUILD="go build ./...";           AG_TEST="go test ./..." ;;
                *)          AG_LANG="(edit: project language(s))"; AG_BUILD="(see Quality gate below)"; AG_TEST="(see Quality gate below)" ;;
            esac
            sed -e "s|{{project_name}}|$PROJECT_NAME|g" \
                -e "s|{{target_branch}}|$TARGET|g" \
                -e "s|{{target_slug}}|$TARGET_SLUG|g" \
                -e "s|{{pm_id}}|$PM_ID|g" \
                -e "s|{{e.g., Rust, TypeScript, Python}}|$AG_LANG|g" \
                -e "s|{{e.g., cargo build, npm run build}}|$AG_BUILD|g" \
                -e "s|{{e.g., cargo test, npm test}}|$AG_TEST|g" \
                -e "s|{{e.g., cargo run --bin check_assets}}|(none — configure if this project has an asset check)|g" \
                "$AGENTS_TEMPLATE" > AGENTS.md.tmp
            # --agents-policy minimal: fill the remaining project-specific
            # placeholders with safe initial values so doctor passes with no
            # P0. strict (default) leaves them for the human to complete.
            if [ "$AGENTS_POLICY" = "minimal" ]; then
                sed -e "s|{{file_path_or_glob}}|(none initially)|g" \
                    -e "s|{{worker_id}}|-|g" \
                    -e "s|{{reason}}|add conflict-prone files here as they emerge|g" \
                    -e "s|{{convention_1}}|Follow the existing project style and conventions.|g" \
                    -e "s|{{convention_2}}|(add project-specific conventions as they emerge)|g" \
                    AGENTS.md.tmp > AGENTS.md.tmp2 && mv AGENTS.md.tmp2 AGENTS.md.tmp
                # Collapse the one remaining multi-line {{...}} block (bilingual
                # policy, §8) — the only placeholder that spans lines.
                awk '
                    skip == 1 { if ($0 ~ /}}/) skip = 0; next }
                    /{{[^}]*$/ { print "Follow the existing documentation language conventions."; skip = 1; next }
                    { print }
                ' AGENTS.md.tmp > AGENTS.md.tmp2 && mv AGENTS.md.tmp2 AGENTS.md.tmp
            fi
            # Replace the two {{quality_gate_command_*}} placeholder lines with
            # the resolved quality gate command set.
            {
                while IFS= read -r _line; do
                    case "$_line" in
                        *'{{quality_gate_command_1}}'*)
                            for _c in "${QG_CMDS[@]}"; do echo "$_c"; done ;;
                        *'{{quality_gate_command_2}}'*) : ;;
                        *) echo "$_line" ;;
                    esac
                done < AGENTS.md.tmp
            } > AGENTS.md
            rm -f AGENTS.md.tmp
            if [ "$AGENTS_POLICY" = "minimal" ]; then
                echo "  + AGENTS.md created from template (stack=$STACK; agents-policy=minimal — all placeholders filled with safe defaults)"
            else
                echo "  + AGENTS.md created from template (stack=$STACK; language + quality gate pre-filled; restricted files / conventions left as placeholders — edit before launch)"
            fi
        else
            echo "  ! agents.md template not found at $AGENTS_TEMPLATE" >&2
        fi
    fi

    echo ""
    echo "==> Writing setup completion marker..."
    {
        echo ""
        echo "# === Setup completion marker ==="
        echo "#"
        echo "# Written as the wizard's last step. PM treats this project as"
        echo "# fully initialized only when [setup] complete = true is present."
        echo "# Absence of this section indicates a partial (interrupted) install"
        echo "# and the wizard will offer to clean up before retrying fresh init."
        echo ""
        echo "[setup]"
        echo "complete = true"
        echo "completed_at = \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\""
        echo "wizard_version = \"2.5.0\""
    } >> "$PM_ROOT/_pm/setup_config.toml"
    echo "  + [setup] complete = true appended to setup_config.toml"

    echo ""
    echo "==================================="
    echo "Garelier setup complete (fresh)."
    echo "==================================="
    echo ""
    echo "Worktrees:"
    git worktree list | sed 's/^/  /'
    echo ""
    echo "Next steps:"
    echo "  1. Edit AGENTS.md and replace the remaining project-specific {{...}}"
    echo "     fields (restricted files §3, conventions §5). The driver refuses to"
    echo "     start while any {{placeholder}} remains (doctor P0) — this is the"
    echo "     one required manual step. Language and quality gate are pre-filled."
    echo "  2. Commit the initial state (local-only — do NOT push):"
    echo "       git add AGENTS.md __garelier/.gitignore __garelier/.ignore $PM_ROOT/_pm/ $PM_ROOT/control/"
    echo "       git commit -m 'Garelier: initialize PM $PM_ID (v2.5.0)'"
    echo "     ($STUDIO_BRANCH stays local per protocol.md §6.5; only <target> is pushed at promote.)"
    echo "  3. Launch this PM with the configured provider:"
    echo "       cd $PM_ROOT/_pm && claude   # or codex after reading the PM skill docs"
    echo "  4. In manual mode, open $PM_ROOT/_dock/ with the configured provider."

elif [ "$MODE" = "migrate" ]; then

    # === MIGRATE MODE ===

    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Error: $PROJECT_ROOT is not inside a git repository." >&2
        exit 1
    fi

    # Two migration paths:
    #   (a) flat v2.0 layout (__garelier/_pm/...) -> per-PM (v2.1), then DEC-020 nesting.
    #   (b) already per-PM but worktrees not yet nested -> DEC-020 nesting only.
    if [ ! -f "__garelier/_pm/setup_config.toml" ]; then
        resolve_pm_id_interactively
        PM_ROOT="__garelier/$PM_ID"
        if [ ! -f "$PM_ROOT/_pm/setup_config.toml" ]; then
            echo "Error: no Garelier install found to migrate." >&2
            echo "       Expected a flat v2.0 layout (__garelier/_pm/setup_config.toml)" >&2
            echo "       or a per-PM layout ($PM_ROOT/_pm/setup_config.toml)." >&2
            exit 1
        fi
        if ws_use_exile; then
            echo "Garelier migration: relocating role worktrees to the machine-local studio home (exile, opt-in)"
        else
            echo "Garelier migration: relocating role worktrees back into the project (DEC-036, default)"
        fi
        echo "  Project root:  $PROJECT_ROOT"
        echo "  PM identifier: $PM_ID"
        echo ""
        echo "  Each role worktree is moved between its in-project container"
        echo "  (__garelier/$PM_ID/_<role>/<id>/checkout) and its machine-local exile"
        echo "  home; coordination files (STATE.md, assignment.md, …) ride along. Roles"
        echo "  with uncommitted tracked changes are skipped — commit them, then re-run."
        if [ "$SKIP_CONFIRM" != "true" ]; then
            printf "Proceed? [y/N] "
            read -r response
            case "$response" in [yY]|[yY][eE][sS]) ;; *) echo "Aborted."; exit 0 ;; esac
        fi
        run_relocate; rc=$?
        echo ""
        echo "Relocation done for pm_id=$PM_ID. Review with: git status"
        exit "$rc"
    fi

    # Read target / slug / studio from the OLD config (before pm_id is known).
    OLD_TARGET="$(read_toml_value_from __garelier/_pm/setup_config.toml branches target || true)"
    OLD_TARGET_SLUG="$(read_toml_value_from __garelier/_pm/setup_config.toml branches target_slug || true)"
    OLD_STUDIO="$(read_toml_value_from __garelier/_pm/setup_config.toml branches integration || true)"
    if [ -z "$OLD_TARGET" ] || [ -z "$OLD_TARGET_SLUG" ] || [ -z "$OLD_STUDIO" ]; then
        echo "Error: could not read [branches] from __garelier/_pm/setup_config.toml." >&2
        exit 1
    fi

    # Prompt for pm_id (or accept --pm-id).
    resolve_pm_id_interactively
    PM_ROOT="__garelier/$PM_ID"

    if [ -d "$PM_ROOT" ]; then
        echo "Error: $PM_ROOT/ already exists; pick a different --pm-id." >&2
        exit 1
    fi

    NEW_STUDIO="garelier/$OLD_TARGET_SLUG/$PM_ID/studio"
    if git rev-parse --verify "$NEW_STUDIO" >/dev/null 2>&1; then
        echo "Error: target branch $NEW_STUDIO already exists; pick a different --pm-id." >&2
        exit 1
    fi

    echo "Garelier migration plan (v2.0 → v2.1)"
    echo "======================================"
    echo "  Project root:        $PROJECT_ROOT"
    echo "  PM identifier:       $PM_ID"
    echo "  Old studio branch:   $OLD_STUDIO"
    echo "  New studio branch:   $NEW_STUDIO"
    echo ""
    echo "  Filesystem moves (git-tracked via git mv):"
    echo "    __garelier/_pm        -> $PM_ROOT/_pm"
    echo "    __garelier/_dock -> $PM_ROOT/_dock"
    echo "    __garelier/control    -> $PM_ROOT/control"
    echo ""
    echo "  Worktree moves (git worktree move):"
    if [ -d __garelier/_workers ]; then
        for d in __garelier/_workers/*/; do
            [ -d "$d" ] || continue
            wid="$(basename "$d")"
            echo "    __garelier/_workers/$wid -> $PM_ROOT/_workers/$wid"
        done
    fi
    if [ -d __garelier/_scouts ]; then
        for d in __garelier/_scouts/*/; do
            [ -d "$d" ] || continue
            sid="$(basename "$d")"
            echo "    __garelier/_scouts/$sid -> $PM_ROOT/_scouts/$sid"
        done
    fi
    if [ -d __garelier/_smiths ]; then
        for d in __garelier/_smiths/*/; do
            [ -d "$d" ] || continue
            smid="$(basename "$d")"
            echo "    __garelier/_smiths/$smid -> $PM_ROOT/_smiths/$smid"
        done
    fi
    if [ -d __garelier/runtime ]; then
        echo "  Plain mv (gitignored):"
        echo "    __garelier/runtime -> $PM_ROOT/runtime"
    fi
    echo ""
    echo "  Branch renames (git branch -m):"
    echo "    $OLD_STUDIO -> $NEW_STUDIO"
    for br in $(git for-each-ref --format='%(refname:short)' "refs/heads/garelier/$OLD_TARGET_SLUG/workbench/*" 2>/dev/null); do
        suffix="${br#garelier/$OLD_TARGET_SLUG/workbench/}"
        echo "    $br -> garelier/$OLD_TARGET_SLUG/$PM_ID/workbench/$suffix"
    done
    echo ""

    if [ "$SKIP_CONFIRM" != "true" ]; then
        printf "Proceed? [y/N] "
        read -r response
        case "$response" in [yY]|[yY][eE][sS]) ;; *) echo "Aborted."; exit 0 ;; esac
    fi

    mkdir -p "$PM_ROOT"

    echo ""
    echo "==> Moving tracked directories via git mv..."
    for d in _pm _dock control; do
        if [ -d "__garelier/$d" ]; then
            git mv "__garelier/$d" "$PM_ROOT/$d"
            echo "  + git mv __garelier/$d -> $PM_ROOT/$d"
        fi
    done

    echo ""
    echo "==> Moving worktrees via git worktree move..."
    if [ -d __garelier/_workers ]; then
        mkdir -p "$PM_ROOT/_workers"
        for d in __garelier/_workers/*/; do
            [ -d "$d" ] || continue
            wid="$(basename "$d")"
            git worktree move "__garelier/_workers/$wid" "$PM_ROOT/_workers/$wid"
            echo "  + worker $wid -> $PM_ROOT/_workers/$wid"
        done
        # Remove the now-empty _workers container if nothing remains.
        rmdir __garelier/_workers 2>/dev/null || true
    fi
    if [ -d __garelier/_scouts ]; then
        mkdir -p "$PM_ROOT/_scouts"
        for d in __garelier/_scouts/*/; do
            [ -d "$d" ] || continue
            sid="$(basename "$d")"
            git worktree move "__garelier/_scouts/$sid" "$PM_ROOT/_scouts/$sid"
            echo "  + scout $sid -> $PM_ROOT/_scouts/$sid"
        done
        rmdir __garelier/_scouts 2>/dev/null || true
    fi
    if [ -d __garelier/_smiths ]; then
        mkdir -p "$PM_ROOT/_smiths"
        for d in __garelier/_smiths/*/; do
            [ -d "$d" ] || continue
            smid="$(basename "$d")"
            git worktree move "__garelier/_smiths/$smid" "$PM_ROOT/_smiths/$smid"
            echo "  + smith $smid -> $PM_ROOT/_smiths/$smid"
        done
        rmdir __garelier/_smiths 2>/dev/null || true
    fi

    echo ""
    echo "==> Moving runtime/ (gitignored)..."
    if [ -d __garelier/runtime ]; then
        mv __garelier/runtime "$PM_ROOT/runtime"
        echo "  + mv __garelier/runtime -> $PM_ROOT/runtime"
    fi

    echo ""
    echo "==> Renaming branches..."
    # Studio branch first.
    if git rev-parse --verify "$OLD_STUDIO" >/dev/null 2>&1; then
        # We can rename even if HEAD is on it.
        git branch -m "$OLD_STUDIO" "$NEW_STUDIO"
        echo "  + $OLD_STUDIO -> $NEW_STUDIO"
    fi
    # Workbench branches.
    for br in $(git for-each-ref --format='%(refname:short)' "refs/heads/garelier/$OLD_TARGET_SLUG/workbench/*" 2>/dev/null); do
        suffix="${br#garelier/$OLD_TARGET_SLUG/workbench/}"
        new_br="garelier/$OLD_TARGET_SLUG/$PM_ID/workbench/$suffix"
        git branch -m "$br" "$new_br"
        echo "  + $br -> $new_br"
    done

    echo ""
    echo "==> Patching $PM_ROOT/_pm/setup_config.toml..."
    TOML="$PM_ROOT/_pm/setup_config.toml"
    # Insert [pm] section after [project] if missing, update integration,
    # rewrite worktree paths and version, bump wizard_version.
    if ! grep -q '^\[pm\]' "$TOML"; then
        awk -v pmid="$PM_ID" '
            BEGIN { inserted = 0 }
            /^\[project\]/ { print; in_project = 1; next }
            /^\[/ {
                if (in_project && !inserted) {
                    print "[pm]"
                    print "pm_id = \"" pmid "\""
                    print ""
                    inserted = 1
                }
                in_project = 0
                print
                next
            }
            { print }
            END {
                if (in_project && !inserted) {
                    print ""
                    print "[pm]"
                    print "pm_id = \"" pmid "\""
                }
            }
        ' "$TOML" > "$TOML.tmp" && mv "$TOML.tmp" "$TOML"
    fi
    # integration = "<NEW_STUDIO>"
    sed -i.bak \
        -e "s|^integration = \"$OLD_STUDIO\"|integration = \"$NEW_STUDIO\"|" \
        -e "s|^worktree = \"__garelier/_workers/|worktree = \"$PM_ROOT/_workers/|g" \
        -e "s|^worktree = \"__garelier/_scouts/|worktree = \"$PM_ROOT/_scouts/|g" \
        -e "s|^worktree = \"__garelier/_smiths/|worktree = \"$PM_ROOT/_smiths/|g" \
        -e "s|^garelier_version = \"2.0.0\"|garelier_version = \"2.5.0\"|" \
        -e "s|^garelier_version = \"2.1.0\"|garelier_version = \"2.5.0\"|" \
        -e "s|^wizard_version = \"2.0.0\"|wizard_version = \"2.5.0\"|" \
        -e "s|^wizard_version = \"2.1.0\"|wizard_version = \"2.5.0\"|" \
        "$TOML"
    rm -f "$TOML.bak"
    echo "  + $TOML updated (pm_id, integration, worktree paths, version)"

    # Append blocks introduced after v2.0 (artisan/librarian/status web) if
    # the migrated config predates them. Top-level tables are order-independent.
    if ! grep -qE '^\[artisan\]' "$TOML"; then
        {
            echo ""
            echo "# === Artisan (artisan lane) ==="
            echo "#"
            echo "# The Artisan performs the combined Dock + Worker + Scout + Smith +"
            echo "# Librarian scope by ITSELF on a \`satchel\` branch, then passes"
            echo "# Guardian + Observer and integrates into \`studio\` (DEC-045)."
            echo "# Mutually exclusive with the dock"
            echo "# lane (arbitrated by runtime/lane.lock). Disabled by default."
            echo "[artisan]"
            echo "enabled = false"
            echo "id = \"artisan-01\""
            echo "provider = \"claude-code\""
            echo "model = \"claude-code\""
            echo "# effort = \"xhigh\""
            echo "worktree = \"$PM_ROOT/_artisan\""
            echo "branch_namespace = \"satchel\""
        } >> "$TOML"
        echo "  + appended [artisan] block (DEC-017)"
    fi
    if ! grep -qE '^#?[[:space:]]*\[\[librarians\]\]' "$TOML"; then
        {
            echo ""
            echo "# === Librarian definitions (dock lane) ==="
            echo "#"
            echo "# One [[librarians]] block per Librarian instance. Knowledge /"
            echo "# registry / runbook work on a \`shelf\` branch, merged through"
            echo "# Dock review. Dock-subordinate; never dispatched by PM."
            echo "# [[librarians]]"
            echo "# id = \"librarian-01\""
            echo "# provider = \"claude-code\""
            echo "# model = \"claude-code\""
            echo "# enabled = true"
            echo "# worktree = \"$PM_ROOT/_librarians/librarian-01\""
            echo "# branch_namespace = \"shelf\""
        } >> "$TOML"
        echo "  + appended [[librarians]] example (DEC-018)"
    fi
    if ! grep -qE '^\[status_web\]' "$TOML"; then
        {
            echo ""
            echo "# === Status Web Console (read-only) ==="
            echo "#"
            echo "# A local, read-only browser view of Garelier state. Zero AI"
            echo "# tokens — it only reads runtime files. Start with"
            echo "# \`bun run status -- --pm-id <pm_id>\` from the driver directory."
            echo "# Binds to loopback only and never mutates state."
            echo "[status_web]"
            echo "enabled = false"
            echo "host = \"127.0.0.1\""
            echo "port = 3787"
            echo "auto_refresh_seconds = 5"
            echo "read_only = true"
            echo "show_source_urls = true"
        } >> "$TOML"
        echo "  + appended [status_web] block"
    fi
    if ! grep -qE '^\[concurrency\]' "$TOML"; then
        {
            echo ""
            echo "# === Concurrency cap (DEC-027) ==="
            echo "#"
            echo "# Memory bound on concurrent detached provider CLIs. The driver launches"
            echo "# at most max_concurrent_agents at once; over-budget roles are deferred"
            echo "# (and aged so a low-priority role can't starve). PM, Dock, and the"
            echo "# merge-gate subprocess are NOT counted. Set 0 to disable the cap."
            echo "[concurrency]"
            echo "max_concurrent_agents = 4"
            echo "tiers = [[\"concierge\", \"guardian\", \"observer\"], [\"smith\", \"librarian\"], [\"worker\", \"scout\", \"artisan\"], []]"
            echo "starvation_cycles = 3"
        } >> "$TOML"
        echo "  + appended [concurrency] block (DEC-027)"
    fi
    if ! grep -qE '^\[lanes\]' "$TOML"; then
        {
            echo ""
            echo "# === Lane selection (DEC-056) ==="
            echo "#"
            echo "# Lane the driver runs when runtime/lane.lock is absent. \"dock\""
            echo "# (default) = the parallel pipeline; \"artisan\" = the single-agent"
            echo "# Artisan lane. An explicit lane.lock still overrides this per task."
            echo "[lanes]"
            echo "default = \"dock\""
        } >> "$TOML"
        echo "  + appended [lanes] block (DEC-056)"
    fi
    if ! grep -qE '^\[output_control\]' "$TOML"; then
        {
            echo ""
            echo "# === Output control (DEC-028) ==="
            echo "#"
            echo "# Keeps provider FINAL responses short and driver logs from bloating, on top"
            echo "# of compact-handoff + retention. Over-budget responses are WARNED, not failed."
            echo "[output_control]"
            echo "enabled = true"
            echo "default_profile = \"compact\""
            echo "violation_mode = \"warn\""
            echo "model_result_log_chars = 600"
            echo "error_tail_chars = 500"
            echo "driver_log_max_bytes = 10485760"
            echo "driver_log_keep_files = 10"
            echo "usage_summary = true"
            echo ""
            echo "[output_control.profiles.normal]"
            echo "soft_result_chars = 1600"
            echo "max_bullets = 8"
            echo "[output_control.profiles.compact]"
            echo "soft_result_chars = 900"
            echo "max_bullets = 5"
            echo "[output_control.profiles.micro]"
            echo "soft_result_chars = 500"
            echo "max_bullets = 3"
            echo ""
            echo "[output_control.roles]"
            echo "pm = \"normal\""
            echo "dock = \"compact\""
            echo "worker = \"compact\""
            echo "smith = \"compact\""
            echo "artisan = \"compact\""
            echo "scout = \"micro\""
            echo "observer = \"micro\""
            echo "librarian = \"compact\""
            echo "guardian = \"normal\""
            echo "concierge = \"normal\""
        } >> "$TOML"
        echo "  + appended [output_control] block (DEC-028)"
    fi

    echo ""
    echo "==> Migrating ignores to nested __garelier/ form (DEC-051; root untouched)..."
    garelier_write_nested_ignores

    # After the per-PM move, bring the worktrees to the chosen layout (in-project
    # by default; exile if opted in). DEC-036.
    run_relocate || true

    echo ""
    echo "==================================="
    echo "Garelier migration complete (v2.0 -> v2.1 + DEC-020)."
    echo "==================================="
    echo ""
    echo "Worktrees:"
    git worktree list | sed 's/^/  /'
    echo ""
    echo "Next steps:"
    echo "  1. Review the changes:"
    echo "       git status"
    echo "       git diff --stat"
    echo "  2. Commit the migration (local-only — do NOT push the studio branch):"
    echo "       git add -A"
    echo "       git commit -m 'Garelier: migrate to v2.1 (per-PM namespace, pm_id=$PM_ID)'"
    echo "  3. Launch this PM from its new directory:"
    echo "       cd $PM_ROOT/_pm && claude"

else

    # === DIFF MODE ===

    PM_ROOT="__garelier/$PM_ID"

    if [ ! -f "$PM_ROOT/_pm/setup_config.toml" ]; then
        echo "Error: $PM_ROOT/_pm/setup_config.toml not found. Use --mode fresh to initialize." >&2
        exit 1
    fi
    if [ ! -d "$PM_ROOT/runtime" ]; then
        echo "Error: $PM_ROOT/runtime/ not found. Use --mode fresh to initialize." >&2
        exit 1
    fi

    # Read target / integration branch from config.
    if [ -z "$TARGET" ]; then
        TARGET="$(read_toml_value branches target)"
    fi
    TARGET_SLUG="$(read_toml_value branches target_slug)"
    STUDIO_BRANCH="$(read_toml_value branches integration)"
    if [ -z "$TARGET" ] || [ -z "$TARGET_SLUG" ] || [ -z "$STUDIO_BRANCH" ]; then
        echo "Error: could not read [branches] from $PM_ROOT/_pm/setup_config.toml." >&2
        exit 1
    fi

    EXISTING_WORKERS_STR="$(read_existing_block_ids workers | tr '\n' ' ')"
    EXISTING_SCOUTS_STR="$(read_existing_block_ids scouts | tr '\n' ' ')"
    EXISTING_SMITHS_STR="$(read_existing_block_ids smiths | tr '\n' ' ')"
    read -ra EXISTING_WORKERS <<< "$EXISTING_WORKERS_STR"
    read -ra EXISTING_SCOUTS  <<< "$EXISTING_SCOUTS_STR"
    read -ra EXISTING_SMITHS  <<< "$EXISTING_SMITHS_STR"

    DESIRED_WORKERS_STR="$(parse_entries "$WORKERS" | tr ' ' '\n' | grep -v '^$' | tr '\n' ' ')"
    DESIRED_SCOUTS_STR="$(parse_entries "$SCOUTS" | tr ' ' '\n' | grep -v '^$' | tr '\n' ' ')"
    if [ "$SMITHS_SET" = "true" ]; then
        DESIRED_SMITHS_STR="$(parse_entries "$SMITHS" | tr ' ' '\n' | awk 'NF' | tr '\n' ' ')"
    else
        DESIRED_SMITHS_STR="$EXISTING_SMITHS_STR"
    fi
    read -ra DESIRED_WORKERS <<< "$DESIRED_WORKERS_STR"
    read -ra DESIRED_SCOUTS  <<< "$DESIRED_SCOUTS_STR"
    read -ra DESIRED_SMITHS  <<< "$DESIRED_SMITHS_STR"

    # Librarians (DEC-018) and Observers (DEC-019) reconcile like Smiths:
    # omitting the flag keeps the existing set; passing it (even empty) is the
    # desired final set.
    EXISTING_LIBRARIANS_STR="$(read_existing_block_ids librarians | tr '\n' ' ')"
    EXISTING_OBSERVERS_STR="$(read_existing_block_ids observers | tr '\n' ' ')"
    EXISTING_GUARDIANS_STR="$(read_existing_block_ids guardians | tr '\n' ' ')"
    EXISTING_CONCIERGES_STR="$(read_existing_block_ids concierges | tr '\n' ' ')"
    read -ra EXISTING_LIBRARIANS <<< "$EXISTING_LIBRARIANS_STR"
    read -ra EXISTING_OBSERVERS  <<< "$EXISTING_OBSERVERS_STR"
    read -ra EXISTING_GUARDIANS  <<< "$EXISTING_GUARDIANS_STR"
    read -ra EXISTING_CONCIERGES <<< "$EXISTING_CONCIERGES_STR"
    if [ "$LIBRARIANS_SET" = "true" ]; then
        DESIRED_LIBRARIANS_STR="$(parse_entries "$LIBRARIANS" | tr ' ' '\n' | awk 'NF' | tr '\n' ' ')"
    else
        DESIRED_LIBRARIANS_STR="$EXISTING_LIBRARIANS_STR"
    fi
    if [ "$OBSERVERS_SET" = "true" ]; then
        DESIRED_OBSERVERS_STR="$(parse_entries "$OBSERVERS" | tr ' ' '\n' | awk 'NF' | tr '\n' ' ')"
    else
        DESIRED_OBSERVERS_STR="$EXISTING_OBSERVERS_STR"
    fi
    if [ "$GUARDIANS_SET" = "true" ]; then
        DESIRED_GUARDIANS_STR="$(parse_entries "$GUARDIANS" | tr ' ' '\n' | awk 'NF' | tr '\n' ' ')"
    else
        DESIRED_GUARDIANS_STR="$EXISTING_GUARDIANS_STR"
    fi
    if [ "$CONCIERGES_SET" = "true" ]; then
        DESIRED_CONCIERGES_STR="$(parse_entries "$CONCIERGES" | tr ' ' '\n' | awk 'NF' | tr '\n' ' ')"
    else
        DESIRED_CONCIERGES_STR="$EXISTING_CONCIERGES_STR"
    fi
    read -ra DESIRED_LIBRARIANS <<< "$DESIRED_LIBRARIANS_STR"
    read -ra DESIRED_OBSERVERS  <<< "$DESIRED_OBSERVERS_STR"
    read -ra DESIRED_GUARDIANS  <<< "$DESIRED_GUARDIANS_STR"
    read -ra DESIRED_CONCIERGES <<< "$DESIRED_CONCIERGES_STR"

    # Artisan (DEC-017) is a single toggle, not a set. --artisan enables,
    # --no-artisan disables; omitting both keeps the current state.
    ARTISAN_EXISTING_ENABLED="$(read_toml_bare artisan enabled)"
    [ "$ARTISAN_EXISTING_ENABLED" = "true" ] || ARTISAN_EXISTING_ENABLED="false"
    ARTISAN_WT_EXISTS="false"; [ -d "$(ws_resolve_container artisan "")" ] && ARTISAN_WT_EXISTS="true"  # DEC-035: exile-aware
    ARTISAN_DESIRED_ENABLED="$ARTISAN_EXISTING_ENABLED"
    if [ "$ARTISAN_SET" = "true" ]; then
        if [ "$ARTISAN_DISABLE" = "true" ]; then ARTISAN_DESIRED_ENABLED="false"; else ARTISAN_DESIRED_ENABLED="true"; fi
    fi
    ARTISAN_CHANGE="none"
    if [ "$ARTISAN_SET" = "true" ] && [ "$ARTISAN_DESIRED_ENABLED" != "$ARTISAN_EXISTING_ENABLED" ]; then
        [ "$ARTISAN_DESIRED_ENABLED" = "true" ] && ARTISAN_CHANGE="enable" || ARTISAN_CHANGE="disable"
    fi

    extract_id() { echo "${1%%:*}"; }

    ADDITIONS_W=()
    REMOVALS_W=()
    KEPT_W=()
    for d in "${DESIRED_WORKERS[@]}"; do
        d_id="$(extract_id "$d")"
        found=0
        for e in "${EXISTING_WORKERS[@]}"; do
            [ "$(extract_id "$e")" = "$d_id" ] && found=1 && break
        done
        if [ "$found" = "0" ]; then
            ADDITIONS_W+=("$d")
        else
            KEPT_W+=("$d")
        fi
    done
    for e in "${EXISTING_WORKERS[@]}"; do
        e_id="$(extract_id "$e")"
        found=0
        for d in "${DESIRED_WORKERS[@]}"; do
            [ "$(extract_id "$d")" = "$e_id" ] && found=1 && break
        done
        [ "$found" = "0" ] && REMOVALS_W+=("$e")
    done

    ADDITIONS_S=()
    REMOVALS_S=()
    KEPT_S=()
    for d in "${DESIRED_SCOUTS[@]}"; do
        d_id="$(extract_id "$d")"
        found=0
        for e in "${EXISTING_SCOUTS[@]}"; do
            [ "$(extract_id "$e")" = "$d_id" ] && found=1 && break
        done
        if [ "$found" = "0" ]; then
            ADDITIONS_S+=("$d")
        else
            KEPT_S+=("$d")
        fi
    done
    for e in "${EXISTING_SCOUTS[@]}"; do
        e_id="$(extract_id "$e")"
        found=0
        for d in "${DESIRED_SCOUTS[@]}"; do
            [ "$(extract_id "$d")" = "$e_id" ] && found=1 && break
        done
        [ "$found" = "0" ] && REMOVALS_S+=("$e")
    done

    ADDITIONS_SM=()
    REMOVALS_SM=()
    KEPT_SM=()
    for d in "${DESIRED_SMITHS[@]}"; do
        d_id="$(extract_id "$d")"
        found=0
        for e in "${EXISTING_SMITHS[@]}"; do
            [ "$(extract_id "$e")" = "$d_id" ] && found=1 && break
        done
        if [ "$found" = "0" ]; then
            ADDITIONS_SM+=("$d")
        else
            KEPT_SM+=("$d")
        fi
    done
    for e in "${EXISTING_SMITHS[@]}"; do
        e_id="$(extract_id "$e")"
        found=0
        for d in "${DESIRED_SMITHS[@]}"; do
            [ "$(extract_id "$d")" = "$e_id" ] && found=1 && break
        done
        [ "$found" = "0" ] && REMOVALS_SM+=("$e")
    done

    ADDITIONS_LIB=()
    REMOVALS_LIB=()
    KEPT_LIB=()
    for d in "${DESIRED_LIBRARIANS[@]}"; do
        d_id="$(extract_id "$d")"
        found=0
        for e in "${EXISTING_LIBRARIANS[@]}"; do
            [ "$(extract_id "$e")" = "$d_id" ] && found=1 && break
        done
        if [ "$found" = "0" ]; then ADDITIONS_LIB+=("$d"); else KEPT_LIB+=("$d"); fi
    done
    for e in "${EXISTING_LIBRARIANS[@]}"; do
        e_id="$(extract_id "$e")"
        found=0
        for d in "${DESIRED_LIBRARIANS[@]}"; do
            [ "$(extract_id "$d")" = "$e_id" ] && found=1 && break
        done
        [ "$found" = "0" ] && REMOVALS_LIB+=("$e")
    done

    ADDITIONS_OBS=()
    REMOVALS_OBS=()
    KEPT_OBS=()
    for d in "${DESIRED_OBSERVERS[@]}"; do
        d_id="$(extract_id "$d")"
        found=0
        for e in "${EXISTING_OBSERVERS[@]}"; do
            [ "$(extract_id "$e")" = "$d_id" ] && found=1 && break
        done
        if [ "$found" = "0" ]; then ADDITIONS_OBS+=("$d"); else KEPT_OBS+=("$d"); fi
    done
    for e in "${EXISTING_OBSERVERS[@]}"; do
        e_id="$(extract_id "$e")"
        found=0
        for d in "${DESIRED_OBSERVERS[@]}"; do
            [ "$(extract_id "$d")" = "$e_id" ] && found=1 && break
        done
        [ "$found" = "0" ] && REMOVALS_OBS+=("$e")
    done

    ADDITIONS_GRD=()
    REMOVALS_GRD=()
    KEPT_GRD=()
    for d in "${DESIRED_GUARDIANS[@]}"; do
        d_id="$(extract_id "$d")"
        found=0
        for e in "${EXISTING_GUARDIANS[@]}"; do
            [ "$(extract_id "$e")" = "$d_id" ] && found=1 && break
        done
        if [ "$found" = "0" ]; then ADDITIONS_GRD+=("$d"); else KEPT_GRD+=("$d"); fi
    done
    for e in "${EXISTING_GUARDIANS[@]}"; do
        e_id="$(extract_id "$e")"
        found=0
        for d in "${DESIRED_GUARDIANS[@]}"; do
            [ "$(extract_id "$d")" = "$e_id" ] && found=1 && break
        done
        [ "$found" = "0" ] && REMOVALS_GRD+=("$e")
    done

    ADDITIONS_CON=()
    REMOVALS_CON=()
    KEPT_CON=()
    for d in "${DESIRED_CONCIERGES[@]}"; do
        d_id="$(extract_id "$d")"
        found=0
        for e in "${EXISTING_CONCIERGES[@]}"; do
            [ "$(extract_id "$e")" = "$d_id" ] && found=1 && break
        done
        if [ "$found" = "0" ]; then ADDITIONS_CON+=("$d"); else KEPT_CON+=("$d"); fi
    done
    for e in "${EXISTING_CONCIERGES[@]}"; do
        e_id="$(extract_id "$e")"
        found=0
        for d in "${DESIRED_CONCIERGES[@]}"; do
            [ "$(extract_id "$d")" = "$e_id" ] && found=1 && break
        done
        [ "$found" = "0" ] && REMOVALS_CON+=("$e")
    done

    BLOCKED_REMOVALS=()
    for e in "${REMOVALS_W[@]}"; do
        e_id="$(extract_id "$e")"
        if ! is_agent_idle workers "$e_id"; then
            BLOCKED_REMOVALS+=("workers:$e_id")
        fi
    done
    for e in "${REMOVALS_S[@]}"; do
        e_id="$(extract_id "$e")"
        if ! is_agent_idle scouts "$e_id"; then
            BLOCKED_REMOVALS+=("scouts:$e_id")
        fi
    done
    for e in "${REMOVALS_SM[@]}"; do
        e_id="$(extract_id "$e")"
        if ! is_agent_idle smiths "$e_id"; then
            BLOCKED_REMOVALS+=("smiths:$e_id")
        fi
    done
    for e in "${REMOVALS_LIB[@]}"; do
        e_id="$(extract_id "$e")"
        if ! is_agent_idle librarians "$e_id"; then
            BLOCKED_REMOVALS+=("librarians:$e_id")
        fi
    done
    for e in "${REMOVALS_OBS[@]}"; do
        e_id="$(extract_id "$e")"
        if ! is_agent_idle observers "$e_id"; then
            BLOCKED_REMOVALS+=("observers:$e_id")
        fi
    done
    for e in "${REMOVALS_GRD[@]}"; do
        e_id="$(extract_id "$e")"
        if ! is_agent_idle guardians "$e_id"; then
            BLOCKED_REMOVALS+=("guardians:$e_id")
        fi
    done
    for e in "${REMOVALS_CON[@]}"; do
        e_id="$(extract_id "$e")"
        if ! is_agent_idle concierges "$e_id"; then
            BLOCKED_REMOVALS+=("concierges:$e_id")
        fi
    done
    if [ "$ARTISAN_CHANGE" = "disable" ] && [ "$ARTISAN_WT_EXISTS" = "true" ]; then
        if ! is_agent_idle artisan ""; then
            BLOCKED_REMOVALS+=("artisan:artisan")
        fi
    fi

    echo "Garelier setup plan (diff mode)"
    echo "================================"
    echo "  Project root:       $PROJECT_ROOT"
    echo "  PM identifier:      $PM_ID"
    echo "  PM root:            $PM_ROOT"
    echo "  Target branch:      $TARGET"
    echo "  Integration branch: $STUDIO_BRANCH"
    echo ""
    echo "  Workers (existing → desired):"
    [ ${#KEPT_W[@]} -gt 0 ] && for e in "${KEPT_W[@]}"; do echo "    = $e (kept)"; done
    [ ${#ADDITIONS_W[@]} -gt 0 ] && for e in "${ADDITIONS_W[@]}"; do echo "    + $e (add)"; done
    [ ${#REMOVALS_W[@]} -gt 0 ] && for e in "${REMOVALS_W[@]}"; do echo "    - $e (remove)"; done
    [ ${#KEPT_W[@]} -eq 0 ] && [ ${#ADDITIONS_W[@]} -eq 0 ] && [ ${#REMOVALS_W[@]} -eq 0 ] && echo "    (no workers)"
    echo ""
    echo "  Scouts (existing → desired):"
    [ ${#KEPT_S[@]} -gt 0 ] && for e in "${KEPT_S[@]}"; do echo "    = $e (kept)"; done
    [ ${#ADDITIONS_S[@]} -gt 0 ] && for e in "${ADDITIONS_S[@]}"; do echo "    + $e (add)"; done
    [ ${#REMOVALS_S[@]} -gt 0 ] && for e in "${REMOVALS_S[@]}"; do echo "    - $e (remove)"; done
    [ ${#KEPT_S[@]} -eq 0 ] && [ ${#ADDITIONS_S[@]} -eq 0 ] && [ ${#REMOVALS_S[@]} -eq 0 ] && echo "    (no scouts)"
    echo ""
    echo "  Smiths (existing -> desired):"
    [ ${#KEPT_SM[@]} -gt 0 ] && for e in "${KEPT_SM[@]}"; do echo "    = $e (kept)"; done
    [ ${#ADDITIONS_SM[@]} -gt 0 ] && for e in "${ADDITIONS_SM[@]}"; do echo "    + $e (add)"; done
    [ ${#REMOVALS_SM[@]} -gt 0 ] && for e in "${REMOVALS_SM[@]}"; do echo "    - $e (remove)"; done
    [ ${#KEPT_SM[@]} -eq 0 ] && [ ${#ADDITIONS_SM[@]} -eq 0 ] && [ ${#REMOVALS_SM[@]} -eq 0 ] && echo "    (no smiths)"
    echo ""
    echo "  Librarians (existing -> desired):"
    [ ${#KEPT_LIB[@]} -gt 0 ] && for e in "${KEPT_LIB[@]}"; do echo "    = $e (kept)"; done
    [ ${#ADDITIONS_LIB[@]} -gt 0 ] && for e in "${ADDITIONS_LIB[@]}"; do echo "    + $e (add)"; done
    [ ${#REMOVALS_LIB[@]} -gt 0 ] && for e in "${REMOVALS_LIB[@]}"; do echo "    - $e (remove)"; done
    [ ${#KEPT_LIB[@]} -eq 0 ] && [ ${#ADDITIONS_LIB[@]} -eq 0 ] && [ ${#REMOVALS_LIB[@]} -eq 0 ] && echo "    (no librarians)"
    echo ""
    echo "  Observers (existing -> desired):"
    [ ${#KEPT_OBS[@]} -gt 0 ] && for e in "${KEPT_OBS[@]}"; do echo "    = $e (kept)"; done
    [ ${#ADDITIONS_OBS[@]} -gt 0 ] && for e in "${ADDITIONS_OBS[@]}"; do echo "    + $e (add)"; done
    [ ${#REMOVALS_OBS[@]} -gt 0 ] && for e in "${REMOVALS_OBS[@]}"; do echo "    - $e (remove)"; done
    [ ${#KEPT_OBS[@]} -eq 0 ] && [ ${#ADDITIONS_OBS[@]} -eq 0 ] && [ ${#REMOVALS_OBS[@]} -eq 0 ] && echo "    (no observers)"
    echo ""
    echo "  Guardians (existing -> desired):"
    [ ${#KEPT_GRD[@]} -gt 0 ] && for e in "${KEPT_GRD[@]}"; do echo "    = $e (kept)"; done
    [ ${#ADDITIONS_GRD[@]} -gt 0 ] && for e in "${ADDITIONS_GRD[@]}"; do echo "    + $e (add)"; done
    [ ${#REMOVALS_GRD[@]} -gt 0 ] && for e in "${REMOVALS_GRD[@]}"; do echo "    - $e (remove)"; done
    [ ${#KEPT_GRD[@]} -eq 0 ] && [ ${#ADDITIONS_GRD[@]} -eq 0 ] && [ ${#REMOVALS_GRD[@]} -eq 0 ] && echo "    (no guardians)"
    echo ""
    echo "  Concierges (existing -> desired):"
    [ ${#KEPT_CON[@]} -gt 0 ] && for e in "${KEPT_CON[@]}"; do echo "    = $e (kept)"; done
    [ ${#ADDITIONS_CON[@]} -gt 0 ] && for e in "${ADDITIONS_CON[@]}"; do echo "    + $e (add)"; done
    [ ${#REMOVALS_CON[@]} -gt 0 ] && for e in "${REMOVALS_CON[@]}"; do echo "    - $e (remove)"; done
    [ ${#KEPT_CON[@]} -eq 0 ] && [ ${#ADDITIONS_CON[@]} -eq 0 ] && [ ${#REMOVALS_CON[@]} -eq 0 ] && echo "    (no concierges)"
    echo ""
    echo "  Artisan lane:"
    if [ "$ARTISAN_CHANGE" = "enable" ]; then
        echo "    + enable (was: enabled=$ARTISAN_EXISTING_ENABLED)"
    elif [ "$ARTISAN_CHANGE" = "disable" ]; then
        echo "    - disable (was: enabled=$ARTISAN_EXISTING_ENABLED)"
    else
        echo "    = enabled=$ARTISAN_EXISTING_ENABLED (unchanged)"
    fi
    echo ""

    if [ ${#BLOCKED_REMOVALS[@]} -gt 0 ] && [ "$ALLOW_REQUEUED_REMOVAL" != "true" ]; then
        echo "  ERROR: cannot remove the following agents (state is not IDLE):" >&2
        for b in "${BLOCKED_REMOVALS[@]}"; do echo "    - $b" >&2; done
        echo "" >&2
        echo "  Wait for these agents to complete their current work, or" >&2
        echo "  clean-stop abort / retire-and-requeue their tasks via PM, then re-run." >&2
        echo "  Use --allow-requeued-removal only after PM has restored the tasks to pending." >&2
        exit 2
    fi

    if [ ${#BLOCKED_REMOVALS[@]} -gt 0 ]; then
        echo "  WARNING: removing non-IDLE agents because --allow-requeued-removal was set." >&2
        echo "  This assumes PM already moved their task rows from in_flight.md to pending.md" >&2
        echo "  and recorded Outcome: requeued." >&2
        for b in "${BLOCKED_REMOVALS[@]}"; do echo "    - $b" >&2; done
        echo "" >&2
    fi

    if [ ${#ADDITIONS_W[@]} -eq 0 ] && [ ${#REMOVALS_W[@]} -eq 0 ] \
       && [ ${#ADDITIONS_S[@]} -eq 0 ] && [ ${#REMOVALS_S[@]} -eq 0 ] \
       && [ ${#ADDITIONS_SM[@]} -eq 0 ] && [ ${#REMOVALS_SM[@]} -eq 0 ] \
       && [ ${#ADDITIONS_LIB[@]} -eq 0 ] && [ ${#REMOVALS_LIB[@]} -eq 0 ] \
       && [ ${#ADDITIONS_OBS[@]} -eq 0 ] && [ ${#REMOVALS_OBS[@]} -eq 0 ] \
       && [ ${#ADDITIONS_GRD[@]} -eq 0 ] && [ ${#REMOVALS_GRD[@]} -eq 0 ] \
       && [ ${#ADDITIONS_CON[@]} -eq 0 ] && [ ${#REMOVALS_CON[@]} -eq 0 ] \
       && [ "$ARTISAN_CHANGE" = "none" ]; then
        echo "No changes required. Setup matches desired state."
        exit 0
    fi

    if [ "$SKIP_CONFIRM" != "true" ]; then
        printf "Apply this diff? [y/N] "
        read -r response
        case "$response" in [yY]|[yY][eE][sS]) ;; *) echo "Aborted."; exit 0 ;; esac
    fi

    git checkout "$STUDIO_BRANCH" >/dev/null 2>&1 || true

    if [ ${#ADDITIONS_W[@]} -gt 0 ] || [ ${#ADDITIONS_S[@]} -gt 0 ] || [ ${#ADDITIONS_SM[@]} -gt 0 ] \
       || [ ${#ADDITIONS_LIB[@]} -gt 0 ] || [ ${#ADDITIONS_OBS[@]} -gt 0 ] || [ ${#ADDITIONS_GRD[@]} -gt 0 ] \
       || [ ${#ADDITIONS_CON[@]} -gt 0 ] || [ "$ARTISAN_CHANGE" = "enable" ]; then
        echo ""
        echo "==> Integrating $TARGET into $STUDIO_BRANCH (base tracking)..."
        if ! integrate_target_into_studio; then
            exit 3
        fi
    fi

    echo ""
    echo "==> Removing agents..."
    for e in "${REMOVALS_W[@]}"; do
        e_id="$(extract_id "$e")"
        remove_agent_worktree workers "$e_id"
        echo "  - removed worker $e_id"
    done
    for e in "${REMOVALS_S[@]}"; do
        e_id="$(extract_id "$e")"
        remove_agent_worktree scouts "$e_id"
        echo "  - removed scout $e_id"
    done
    for e in "${REMOVALS_SM[@]}"; do
        e_id="$(extract_id "$e")"
        remove_agent_worktree smiths "$e_id"
        echo "  - removed smith $e_id"
    done
    for e in "${REMOVALS_LIB[@]}"; do
        e_id="$(extract_id "$e")"
        remove_agent_worktree librarians "$e_id"
        echo "  - removed librarian $e_id"
    done
    for e in "${REMOVALS_OBS[@]}"; do
        e_id="$(extract_id "$e")"
        remove_agent_worktree observers "$e_id"
        echo "  - removed observer $e_id"
    done
    for e in "${REMOVALS_GRD[@]}"; do
        e_id="$(extract_id "$e")"
        remove_agent_worktree guardians "$e_id"
        echo "  - removed guardian $e_id"
    done
    for e in "${REMOVALS_CON[@]}"; do
        e_id="$(extract_id "$e")"
        remove_agent_worktree concierges "$e_id"
        echo "  - removed concierge $e_id"
    done
    if [ "$ARTISAN_CHANGE" = "disable" ] && [ "$ARTISAN_WT_EXISTS" = "true" ]; then
        remove_agent_worktree artisan ""   # DEC-035: resolve exile, drop pointer, prune
        echo "  - disabled artisan lane"
    fi

    echo ""
    echo "==> Adding agents..."
    for e in "${ADDITIONS_W[@]}"; do
        e_id="$(entry_id "$e")"; e_provider="$(entry_provider "$e")"; e_model="$(entry_model "$e")"
        create_agent_worktree workers "$e_id" "$e_provider" "$e_model"
        echo "  + added worker $e_id ($e_provider:$e_model)"
    done
    for e in "${ADDITIONS_S[@]}"; do
        e_id="$(entry_id "$e")"; e_provider="$(entry_provider "$e")"; e_model="$(entry_model "$e")"
        create_agent_worktree scouts "$e_id" "$e_provider" "$e_model"
        echo "  + added scout $e_id ($e_provider:$e_model)"
    done
    for e in "${ADDITIONS_SM[@]}"; do
        e_id="$(entry_id "$e")"; e_provider="$(entry_provider "$e")"; e_model="$(entry_model "$e")"
        create_agent_worktree smiths "$e_id" "$e_provider" "$e_model"
        echo "  + added smith $e_id ($e_provider:$e_model)"
    done
    for e in "${ADDITIONS_LIB[@]}"; do
        e_id="$(entry_id "$e")"; e_provider="$(entry_provider "$e")"; e_model="$(entry_model "$e")"
        create_agent_worktree librarians "$e_id" "$e_provider" "$e_model"
        echo "  + added librarian $e_id ($e_provider:$e_model)"
    done
    if [ ${#ADDITIONS_OBS[@]} -gt 0 ]; then
        # Scaffold the Observer sidecar runtime/control dirs on first observer.
        mkdir -p "$PM_ROOT/runtime/observer/inbox" "$PM_ROOT/runtime/observer/requests" \
                 "$PM_ROOT/runtime/observer/results" "$PM_ROOT/runtime/observer/locks"
        mkdir -p "$PM_ROOT/control/observations"
        [ -e "$PM_ROOT/control/observations/.gitkeep" ] || touch "$PM_ROOT/control/observations/.gitkeep"
    fi
    for e in "${ADDITIONS_OBS[@]}"; do
        e_id="$(entry_id "$e")"; e_provider="$(entry_provider "$e")"; e_model="$(entry_model "$e")"
        create_agent_worktree observers "$e_id" "$e_provider" "$e_model"
        echo "  + added observer $e_id ($e_provider:$e_model)"
    done
    if [ ${#ADDITIONS_GRD[@]} -gt 0 ]; then
        # Scaffold the Guardian gate runtime dirs on first guardian (DEC-024).
        mkdir -p "$PM_ROOT/runtime/guardian/inbox" "$PM_ROOT/runtime/guardian/requests" \
                 "$PM_ROOT/runtime/guardian/results" "$PM_ROOT/runtime/guardian/locks"
    fi
    for e in "${ADDITIONS_GRD[@]}"; do
        e_id="$(entry_id "$e")"; e_provider="$(entry_provider "$e")"; e_model="$(entry_model "$e")"
        create_agent_worktree guardians "$e_id" "$e_provider" "$e_model"
        echo "  + added guardian $e_id ($e_provider:$e_model)"
    done
    if [ ${#ADDITIONS_CON[@]} -gt 0 ]; then
        # Scaffold the Concierge external-ops runtime dirs on first concierge (DEC-025).
        mkdir -p "$PM_ROOT/runtime/concierge/inbox" "$PM_ROOT/runtime/concierge/requests" \
                 "$PM_ROOT/runtime/concierge/results" "$PM_ROOT/runtime/concierge/locks" \
                 "$PM_ROOT/runtime/concierge/archive"
    fi
    for e in "${ADDITIONS_CON[@]}"; do
        e_id="$(entry_id "$e")"; e_provider="$(entry_provider "$e")"; e_model="$(entry_model "$e")"
        create_agent_worktree concierges "$e_id" "$e_provider" "$e_model"
        echo "  + added concierge $e_id ($e_provider:$e_model)"
    done
    if [ "$ARTISAN_CHANGE" = "enable" ] && [ "$ARTISAN_WT_EXISTS" != "true" ]; then
        # Resolve identity from --artisan inline spec, else existing config, else defaults.
        if [ -n "$ARTISAN_SPEC" ]; then
            _sol_norm="$(normalize_agent_entry "$ARTISAN_SPEC")"
            SOL_ID="$(entry_id "$_sol_norm")"; SOL_PROV="$(entry_provider "$_sol_norm")"; SOL_MODEL="$(entry_model "$_sol_norm")"
        else
            SOL_ID="$(read_toml_value artisan id)"; [ -z "$SOL_ID" ] && SOL_ID="artisan-01"
            SOL_PROV="$(read_toml_value artisan provider)"; [ -z "$SOL_PROV" ] && SOL_PROV="claude-code"
            SOL_MODEL="$(read_toml_value artisan model)"; [ -z "$SOL_MODEL" ] && SOL_MODEL="claude-code"
        fi
        # Artisan branches `satchel` from and integrates it into studio (DEC-045).
        # DEC-036: in-project by default; exile (+pointer) is opt-in.
        sol_c="$(ws_container artisan "")"
        mkdir -p "$sol_c"
        git worktree add --detach "$sol_c/checkout" "$STUDIO_BRANCH" >/dev/null
        ws_use_exile && ws_write_pointer artisan "" "$sol_c"
        write_role_settings "$sol_c/checkout"
        write_role_files artisan "$SOL_ID" "$SOL_PROV" "$SOL_MODEL"
        echo "  + enabled artisan lane ($SOL_ID $SOL_PROV:$SOL_MODEL at $sol_c)"
    fi

    echo ""
    echo "==> Updating $PM_ROOT/_pm/setup_config.toml..."

    NEW_TOML_STRIPPED="$(mktemp)"

    awk '
        BEGIN { skip = 0 }
        /^\[\[workers\]\]/ || /^\[\[scouts\]\]/ || /^\[\[smiths\]\]/ || /^\[\[librarians\]\]/ || /^\[\[observers\]\]/ || /^\[\[guardians\]\]/ || /^\[\[concierges\]\]/ { skip = 1; next }
        /^\[/ { skip = 0 }
        !skip { print }
    ' "$PM_ROOT/_pm/setup_config.toml" > "$NEW_TOML_STRIPPED"

    # Inject blocks introduced after this project was first initialized
    # (DEC-017 artisan, DEC-018 librarian, status web console). Existing
    # blocks are preserved verbatim above; only absent ones are added.
    ARTISAN_PRESENT=0;   grep -qE '^\[artisan\]'    "$NEW_TOML_STRIPPED" && ARTISAN_PRESENT=1
    STATUSWEB_PRESENT=0; grep -qE '^\[status_web\]' "$NEW_TOML_STRIPPED" && STATUSWEB_PRESENT=1
    CONCURRENCY_PRESENT=0; grep -qE '^\[concurrency\]' "$NEW_TOML_STRIPPED" && CONCURRENCY_PRESENT=1
    OUTPUTCTL_PRESENT=0; grep -qE '^\[output_control\]' "$NEW_TOML_STRIPPED" && OUTPUTCTL_PRESENT=1
    LIBRARIANS_PRESENT=0; grep -qE '^#?[[:space:]]*\[\[librarians\]\]' "$NEW_TOML_STRIPPED" && LIBRARIANS_PRESENT=1
    # Guardian sections (DEC-024) may be absent in pre-Guardian configs.
    GUARDIANS_HDR_PRESENT=0; grep -qE '^#?[[:space:]]*\[\[guardians\]\]' "$NEW_TOML_STRIPPED" && GUARDIANS_HDR_PRESENT=1
    GUARDIAN_POLICY_PRESENT=0; grep -qE '^\[guardian_policy\]' "$NEW_TOML_STRIPPED" && GUARDIAN_POLICY_PRESENT=1
    # Concierge sections (DEC-025) may be absent in pre-Concierge configs.
    CONCIERGES_HDR_PRESENT=0; grep -qE '^#?[[:space:]]*\[\[concierges\]\]' "$NEW_TOML_STRIPPED" && CONCIERGES_HDR_PRESENT=1
    CONCIERGE_POLICY_PRESENT=0; grep -qE '^\[concierge_policy\]' "$NEW_TOML_STRIPPED" && CONCIERGE_POLICY_PRESENT=1
    DESIRED_LIB_COUNT=$(( ${#KEPT_LIB[@]} + ${#ADDITIONS_LIB[@]} ))
    DESIRED_OBS_COUNT=$(( ${#KEPT_OBS[@]} + ${#ADDITIONS_OBS[@]} ))
    DESIRED_GRD_COUNT=$(( ${#KEPT_GRD[@]} + ${#ADDITIONS_GRD[@]} ))
    DESIRED_CON_COUNT=$(( ${#KEPT_CON[@]} + ${#ADDITIONS_CON[@]} ))

    awk '
        !inserted && /^\[milestones\]/ {
            print "###AGENTS_HERE###"
            inserted = 1
        }
        { print }
    ' "$NEW_TOML_STRIPPED" > "$NEW_TOML_STRIPPED.marked"

    {
        while IFS= read -r line; do
            if [ "$line" = "###AGENTS_HERE###" ]; then
                for e in $(printf '%s\n' "${KEPT_W[@]}" "${ADDITIONS_W[@]}" | sort -u | grep -v '^$'); do
                    id="$(entry_id "$e")"; provider="$(entry_provider "$e")"; model="$(entry_model "$e")"
                    echo "[[workers]]"
                    echo "id = \"$id\""
                    echo "provider = \"$provider\""
                    echo "model = \"$model\""
                    emit_effort_line workers "$id"
                    echo "worktree = \"$PM_ROOT/_workers/$id\""
                    echo ""
                done
                for e in $(printf '%s\n' "${KEPT_S[@]}" "${ADDITIONS_S[@]}" | sort -u | grep -v '^$'); do
                    id="$(entry_id "$e")"; provider="$(entry_provider "$e")"; model="$(entry_model "$e")"
                    echo "[[scouts]]"
                    echo "id = \"$id\""
                    echo "provider = \"$provider\""
                    echo "model = \"$model\""
                    emit_effort_line scouts "$id"
                    echo "worktree = \"$PM_ROOT/_scouts/$id\""
                    echo "idle_task = false"
                    echo "idle_interval_hours = 24"
                    echo ""
                done
                for e in $(printf '%s\n' "${KEPT_SM[@]}" "${ADDITIONS_SM[@]}" | sort -u | grep -v '^$'); do
                    id="$(entry_id "$e")"; provider="$(entry_provider "$e")"; model="$(entry_model "$e")"
                    echo "[[smiths]]"
                    echo "id = \"$id\""
                    echo "provider = \"$provider\""
                    echo "model = \"$model\""
                    emit_effort_line smiths "$id"
                    echo "worktree = \"$PM_ROOT/_smiths/$id\""
                    echo ""
                done
                # Librarians (DEC-018) — emit the desired set (header is preserved above).
                for e in $(printf '%s\n' "${KEPT_LIB[@]}" "${ADDITIONS_LIB[@]}" | sort -u | grep -v '^$'); do
                    id="$(entry_id "$e")"; provider="$(entry_provider "$e")"; model="$(entry_model "$e")"
                    echo "[[librarians]]"
                    echo "id = \"$id\""
                    echo "provider = \"$provider\""
                    echo "model = \"$model\""
                    echo "enabled = true"
                    emit_effort_line librarians "$id"
                    echo "worktree = \"$PM_ROOT/_librarians/$id\""
                    echo "branch_namespace = \"shelf\""
                    echo ""
                done
                # Observers (DEC-019) — emit the desired set (header is preserved above).
                for e in $(printf '%s\n' "${KEPT_OBS[@]}" "${ADDITIONS_OBS[@]}" | sort -u | grep -v '^$'); do
                    id="$(entry_id "$e")"; provider="$(entry_provider "$e")"; model="$(entry_model "$e")"
                    echo "[[observers]]"
                    echo "id = \"$id\""
                    echo "provider = \"$provider\""
                    echo "model = \"$model\""
                    echo "enabled = true"
                    emit_effort_line observers "$id"
                    echo "worktree = \"$PM_ROOT/_observers/$id\""
                    echo "allowed_request_kinds = [\"merge_review\", \"artisan_premerge_review\", \"direction_advice\", \"architecture_risk_review\", \"policy_consistency_review\"]"
                    echo ""
                done
                # Guardians (DEC-024) — emit the desired set (header is preserved above).
                for e in $(printf '%s\n' "${KEPT_GRD[@]}" "${ADDITIONS_GRD[@]}" | sort -u | grep -v '^$'); do
                    id="$(entry_id "$e")"; provider="$(entry_provider "$e")"; model="$(entry_model "$e")"
                    echo "[[guardians]]"
                    echo "id = \"$id\""
                    echo "provider = \"$provider\""
                    echo "model = \"$model\""
                    echo "enabled = true"
                    emit_effort_line guardians "$id"
                    echo "checkout = true"
                    echo "worktree = \"$PM_ROOT/_guardians/$id\""
                    echo "allowed_request_kinds = [\"preflight\", \"delta_gate\", \"final_gate\", \"promote_gate\", \"knowledge_update_request\"]"
                    echo ""
                done
                # Concierges (DEC-025) — emit the desired set (header is preserved above).
                for e in $(printf '%s\n' "${KEPT_CON[@]}" "${ADDITIONS_CON[@]}" | sort -u | grep -v '^$'); do
                    id="$(entry_id "$e")"; provider="$(entry_provider "$e")"; model="$(entry_model "$e")"
                    echo "[[concierges]]"
                    echo "id = \"$id\""
                    echo "provider = \"$provider\""
                    echo "model = \"$model\""
                    echo "enabled = true"
                    emit_effort_line concierges "$id"
                    echo "checkout = true"
                    echo "worktree = \"$PM_ROOT/_concierges/$id\""
                    echo "branch_namespace = \"clipboard\""
                    echo "allowed_operation_kinds = [\"promote_target\", \"sync_remote\"]"
                    echo ""
                done
                if [ "$ARTISAN_PRESENT" -eq 0 ]; then
                    echo "# === Artisan (artisan lane) ==="
                    echo "#"
                    echo "# The Artisan performs the combined Dock + Worker + Scout + Smith +"
                    echo "# Librarian scope by ITSELF on a \`satchel\` branch, then passes"
                    echo "# Guardian + Observer and integrates into \`studio\` (DEC-045)."
                    echo "# Mutually exclusive with the dock"
                    echo "# lane (arbitrated by runtime/lane.lock). Disabled by default."
                    echo "[artisan]"
                    echo "enabled = false"
                    echo "id = \"artisan-01\""
                    echo "provider = \"claude-code\""
                    echo "model = \"claude-code\""
                    echo "# effort = \"xhigh\""
                    echo "worktree = \"$PM_ROOT/_artisan\""
                    echo "branch_namespace = \"satchel\""
                    echo ""
                fi
                if [ "$LIBRARIANS_PRESENT" -eq 0 ] && [ "$DESIRED_LIB_COUNT" -eq 0 ]; then
                    echo "# === Librarian definitions (dock lane) ==="
                    echo "#"
                    echo "# One [[librarians]] block per Librarian instance. Librarians do"
                    echo "# knowledge / registry / runbook work (external-info sync, internal"
                    echo "# rules, runbooks, source_registry/routine_registry) on a \`shelf\`"
                    echo "# branch, merged through Dock review. Dock-subordinate;"
                    echo "# never dispatched directly by PM."
                    echo "# [[librarians]]"
                    echo "# id = \"librarian-01\""
                    echo "# provider = \"claude-code\""
                    echo "# model = \"claude-code\""
                    echo "# enabled = true"
                    echo "# worktree = \"$PM_ROOT/_librarians/librarian-01\""
                    echo "# branch_namespace = \"shelf\""
                    echo ""
                fi
                if [ "$GUARDIANS_HDR_PRESENT" -eq 0 ] && [ "$DESIRED_GRD_COUNT" -eq 0 ]; then
                    echo "# === Guardian definitions (security/privacy/dependency/license gate, DEC-024) ==="
                    echo "#"
                    echo "# One [[guardians]] block per Guardian. Commit-free; runs on an"
                    echo "# ephemeral \`gavel\` branch; gated by [guardian_policy] below."
                    echo "# [[guardians]]"
                    echo "# id = \"guardian-01\""
                    echo "# provider = \"claude-code\""
                    echo "# model = \"claude-code\""
                    echo "# enabled = true"
                    echo "# checkout = true"
                    echo "# worktree = \"$PM_ROOT/_guardians/guardian-01\""
                    echo "# allowed_request_kinds = [\"preflight\", \"delta_gate\", \"final_gate\", \"promote_gate\", \"knowledge_update_request\"]"
                    echo ""
                fi
                if [ "$CONCIERGES_HDR_PRESENT" -eq 0 ] && [ "$DESIRED_CON_COUNT" -eq 0 ]; then
                    echo "# === Concierge definitions (external operations executor, DEC-025) ==="
                    echo "#"
                    echo "# One [[concierges]] block per Concierge. Always checkout=true (external"
                    echo "# operations need live git state); runs on a \`clipboard\` branch; gated"
                    echo "# by [concierge_policy] below."
                    echo "# [[concierges]]"
                    echo "# id = \"concierge-01\""
                    echo "# provider = \"claude-code\""
                    echo "# model = \"claude-code\""
                    echo "# enabled = true"
                    echo "# checkout = true"
                    echo "# worktree = \"$PM_ROOT/_concierges/concierge-01\""
                    echo "# branch_namespace = \"clipboard\""
                    echo "# allowed_operation_kinds = [\"promote_target\", \"sync_remote\"]"
                    echo ""
                fi
                if [ "$STATUSWEB_PRESENT" -eq 0 ]; then
                    echo "# === Status Web Console (read-only) ==="
                    echo "#"
                    echo "# A local, read-only browser view of Garelier state (lane, roles,"
                    echo "# branches, merge gate, recent reports, warnings, source/routine"
                    echo "# registries). Zero AI tokens — it only reads runtime files. Start it"
                    echo "# with \`bun run status -- --pm-id <pm_id>\` from the driver directory."
                    echo "# It binds to loopback only and never mutates state."
                    echo "[status_web]"
                    echo "enabled = false              # informational; the standalone command runs regardless"
                    echo "host = \"127.0.0.1\"           # loopback only; non-loopback values are rejected"
                    echo "port = 3787"
                    echo "auto_refresh_seconds = 5"
                    echo "read_only = true             # phase 1 is read-only; no operation UI"
                    echo "show_source_urls = true      # false => show only the host of source registry URLs"
                    echo ""
                fi
                if [ "$CONCURRENCY_PRESENT" -eq 0 ]; then
                    echo "# === Concurrency cap (DEC-027) ==="
                    echo "#"
                    echo "# Memory bound on concurrent detached provider CLIs. The driver launches"
                    echo "# at most max_concurrent_agents at once; over-budget roles are deferred"
                    echo "# (and aged so a low-priority role can't starve). PM, Dock, and the"
                    echo "# merge-gate subprocess are NOT counted. Set 0 to disable the cap."
                    echo "[concurrency]"
                    echo "max_concurrent_agents = 4"
                    echo "tiers = [[\"concierge\", \"guardian\", \"observer\"], [\"smith\", \"librarian\"], [\"worker\", \"scout\", \"artisan\"], []]"
                    echo "starvation_cycles = 3"
                    echo ""
                fi
                if [ "$OUTPUTCTL_PRESENT" -eq 0 ]; then
                    echo "# === Output control (DEC-028) ==="
                    echo "#"
                    echo "# Keeps provider FINAL responses short and driver logs from bloating, on top"
                    echo "# of compact-handoff + retention. Over-budget responses are WARNED, not failed."
                    echo "[output_control]"
                    echo "enabled = true"
                    echo "default_profile = \"compact\""
                    echo "violation_mode = \"warn\""
                    echo "model_result_log_chars = 600"
                    echo "error_tail_chars = 500"
                    echo "driver_log_max_bytes = 10485760"
                    echo "driver_log_keep_files = 10"
                    echo "usage_summary = true"
                    echo ""
                    echo "[output_control.profiles.normal]"
                    echo "soft_result_chars = 1600"
                    echo "max_bullets = 8"
                    echo "[output_control.profiles.compact]"
                    echo "soft_result_chars = 900"
                    echo "max_bullets = 5"
                    echo "[output_control.profiles.micro]"
                    echo "soft_result_chars = 500"
                    echo "max_bullets = 3"
                    echo ""
                    echo "[output_control.roles]"
                    echo "pm = \"normal\""
                    echo "dock = \"compact\""
                    echo "worker = \"compact\""
                    echo "smith = \"compact\""
                    echo "artisan = \"compact\""
                    echo "scout = \"micro\""
                    echo "observer = \"micro\""
                    echo "librarian = \"compact\""
                    echo "guardian = \"normal\""
                    echo "concierge = \"normal\""
                    echo ""
                fi
            else
                echo "$line"
            fi
        done < "$NEW_TOML_STRIPPED.marked"
    } > "$PM_ROOT/_pm/setup_config.toml"

    rm -f "$NEW_TOML_STRIPPED" "$NEW_TOML_STRIPPED.marked"

    # Append the Guardian policy + tools sections (DEC-024) if a pre-Guardian
    # config lacks them. Default disabled; the enable toggle below flips it on
    # when guardians are now configured.
    if [ "$GUARDIAN_POLICY_PRESENT" -eq 0 ]; then
        {
            echo ""
            echo "# === Guardian policy (DEC-024) ==="
            echo "#"
            echo "# Guardian is the security GATE: commit-free, on an ephemeral \`gavel\`"
            echo "# branch, reads Librarian-owned security knowledge"
            echo "# (docs/garelier/security/) and emits PASS / PASS_WITH_NOTES / BLOCK /"
            echo "# NO_OPINION. Disabled by default; enable + add [[guardians]] blocks."
            echo "[guardian_policy]"
            echo "enabled = false"
            echo "require_for_all_merges = true         # security-gate EVERY merge (guardian step of worker->guardian->observer->dock); false = gate only on the mechanical triggers below"
            echo "branch_namespace = \"gavel\""
            echo "# Gate timings (delta is the core; preflight/final are staged)."
            echo "require_delta_before_observer = true"
            echo "require_final_before_merge = true"
            echo "require_for_artisan_premerge = true"
            echo "require_for_promote = true"
            echo "# Mechanical triggers (when a gate is mandatory)."
            echo "require_for_dependency_changes = true"
            echo "require_for_lockfile_changes = true"
            echo "require_for_auth_security = true"
            echo "require_for_config_infra_ci_deploy = true"
            echo "require_for_protected_paths = true"
            echo "# Blocking rules."
            echo "block_on_secret = true"
            echo "block_on_pii = true"
            echo "block_on_customer_data = true"
            echo "block_on_private_key = true"
            echo "block_on_critical_vulnerability = true"
            echo "block_on_high_vulnerability = true"
            echo "block_on_forbidden_license = true"
            echo "block_on_unknown_license = false"
            echo "block_when_required_scanner_unavailable = true"
            echo "# Output safety."
            echo "redact_evidence = true"
            echo "forbid_secret_value_in_report = true"
            echo ""
            echo "[guardian_policy.security_sensitive_paths]"
            echo "paths = [\".env*\", \"**/*.pem\", \"**/*.key\", \"**/*secret*\", \"**/*credential*\", \"infra/**\", \"deploy/**\", \".github/workflows/**\", \"migrations/**\"]"
            echo ""
            echo "[guardian_policy.package_files]"
            echo "paths = [\"package.json\", \"package-lock.json\", \"pnpm-lock.yaml\", \"yarn.lock\", \"Cargo.toml\", \"Cargo.lock\", \"requirements.txt\", \"pyproject.toml\", \"poetry.lock\", \"go.mod\", \"go.sum\"]"
            echo ""
            echo "# Scanner commands. Empty = Guardian uses available project tools and"
            echo "# reports NO_OPINION/BLOCK per policy if a required command is missing."
            echo "# If gitleaks cannot be used, PM may set:"
            echo "#   block_when_required_scanner_unavailable = false"
            echo "#   secret_scan = \"off\""
            echo "# Guardian then runs in degraded mode and must report that scanner coverage"
            echo "# was intentionally disabled; it must not claim full secret-scanner coverage."
            echo "[guardian_tools]"
            echo "secret_scan = \"gitleaks detect --no-banner --redact --source .\""
            echo "pii_scan = \"\""
            echo "dependency_scan = \"\""
            echo "license_scan = \"\""
            echo "sast_scan = \"\""
        } >> "$PM_ROOT/_pm/setup_config.toml"
    fi

    # Append the Concierge policy section (DEC-025) if a pre-Concierge config
    # lacks it. Default disabled; the enable toggle below flips it on when
    # concierges are now configured.
    if [ "$CONCIERGE_POLICY_PRESENT" -eq 0 ]; then
        {
            echo ""
            echo "# === Concierge policy (external operations executor, DEC-025) ==="
            echo "#"
            echo "# Concierge EXECUTES PM-approved operations that leave Garelier's local"
            echo "# sandbox (Phase 1: promote_target + read-only sync_remote). Reads"
            echo "# Librarian-owned docs/garelier/external_operations/ and consumes the"
            echo "# Guardian promote_gate verdict. Disabled by default; enable + add"
            echo "# [[concierges]] blocks. Enabling does NOT auto-push — external writes"
            echo "# still require an explicit user instruction behind the PM assignment."
            echo "[concierge_policy]"
            echo "enabled = false"
            echo "branch_namespace = \"clipboard\""
            echo "require_pm_approval = true"
            echo "require_user_instruction_for_write = true"
            echo "require_librarian_policy_sources = true"
            echo "require_guardian_before_external_write = true"
            echo "require_external_lock = true"
            echo "forbid_push_garelier_branches = true"
            echo "forbid_force_push = true"
            echo "forbid_blind_git_pull = true"
            echo "redact_sensitive_output = true"
            echo "# Remote-visible work uses these prefixes — never garelier/* (Phase 2)."
            echo "allowed_external_branch_prefixes = [\"publish/\", \"pr/\", \"release/\"]"
            echo ""
            echo "[concierge_policy.required_knowledge]"
            echo "paths = ["
            echo "    \"docs/garelier/external_operations/external_operations_policy.md\","
            echo "    \"docs/garelier/external_operations/git_remote_policy.md\","
            echo "    \"docs/garelier/external_operations/promote_policy.md\","
            echo "    \"docs/garelier/external_operations/rollback_policy.md\","
            echo "]"
        } >> "$PM_ROOT/_pm/setup_config.toml"
    fi

    # When --guardians was explicitly passed, sync [guardian_policy].enabled to
    # whether any Guardian is now configured (mirrors fresh-mode auto-on). When
    # --guardians is omitted, leave the policy's enabled flag untouched.
    if [ "$GUARDIANS_SET" = "true" ]; then
        GRD_DIFF_POLICY_ENABLED="false"
        [ "$DESIRED_GRD_COUNT" -gt 0 ] && GRD_DIFF_POLICY_ENABLED="true"
        awk -v val="$GRD_DIFF_POLICY_ENABLED" '
            /^\[guardian_policy\]/ { in_gp = 1; print; next }
            /^\[/ { in_gp = 0 }
            in_gp && /^enabled[[:space:]]*=/ { print "enabled = " val; next }
            { print }
        ' "$PM_ROOT/_pm/setup_config.toml" > "$PM_ROOT/_pm/setup_config.toml.tmp" \
            && mv "$PM_ROOT/_pm/setup_config.toml.tmp" "$PM_ROOT/_pm/setup_config.toml"
    fi

    # When --concierges was explicitly passed, sync [concierge_policy].enabled to
    # whether any Concierge is now configured (mirrors fresh-mode auto-on). When
    # --concierges is omitted, leave the policy's enabled flag untouched.
    if [ "$CONCIERGES_SET" = "true" ]; then
        CON_DIFF_POLICY_ENABLED="false"
        [ "$DESIRED_CON_COUNT" -gt 0 ] && CON_DIFF_POLICY_ENABLED="true"
        awk -v val="$CON_DIFF_POLICY_ENABLED" '
            /^\[concierge_policy\]/ { in_cp = 1; print; next }
            /^\[/ { in_cp = 0 }
            in_cp && /^enabled[[:space:]]*=/ { print "enabled = " val; next }
            { print }
        ' "$PM_ROOT/_pm/setup_config.toml" > "$PM_ROOT/_pm/setup_config.toml.tmp" \
            && mv "$PM_ROOT/_pm/setup_config.toml.tmp" "$PM_ROOT/_pm/setup_config.toml"
    fi

    # Toggle [artisan].enabled in place when --artisan / --no-artisan was given.
    if [ "$ARTISAN_SET" = "true" ]; then
        awk -v val="$ARTISAN_DESIRED_ENABLED" '
            /^\[artisan\]/ { in_sol = 1; print; next }
            /^\[/ { in_sol = 0 }
            in_sol && /^enabled[[:space:]]*=/ { print "enabled = " val; next }
            { print }
        ' "$PM_ROOT/_pm/setup_config.toml" > "$PM_ROOT/_pm/setup_config.toml.tmp" \
            && mv "$PM_ROOT/_pm/setup_config.toml.tmp" "$PM_ROOT/_pm/setup_config.toml"
    fi
    echo "  + setup_config.toml updated"

    next_num=$(grep -oE '<!-- Next entry number: [0-9]+' "$PM_ROOT/_pm/history.md" 2>/dev/null \
               | grep -oE '[0-9]+' || echo "2")
    grep -v "Next entry number:" "$PM_ROOT/_pm/history.md" > "$PM_ROOT/_pm/history.md.tmp"
    mv "$PM_ROOT/_pm/history.md.tmp" "$PM_ROOT/_pm/history.md"

    adds=""
    if [ ${#ADDITIONS_W[@]} -gt 0 ]; then
        for e in "${ADDITIONS_W[@]}"; do
            adds="${adds:+$adds, }worker $e"
        done
    fi
    if [ ${#ADDITIONS_S[@]} -gt 0 ]; then
        for e in "${ADDITIONS_S[@]}"; do
            adds="${adds:+$adds, }scout $e"
        done
    fi
    if [ ${#ADDITIONS_SM[@]} -gt 0 ]; then
        for e in "${ADDITIONS_SM[@]}"; do
            adds="${adds:+$adds, }smith $e"
        done
    fi
    if [ ${#ADDITIONS_LIB[@]} -gt 0 ]; then
        for e in "${ADDITIONS_LIB[@]}"; do
            adds="${adds:+$adds, }librarian $e"
        done
    fi
    if [ ${#ADDITIONS_OBS[@]} -gt 0 ]; then
        for e in "${ADDITIONS_OBS[@]}"; do
            adds="${adds:+$adds, }observer $e"
        done
    fi
    if [ ${#ADDITIONS_GRD[@]} -gt 0 ]; then
        for e in "${ADDITIONS_GRD[@]}"; do
            adds="${adds:+$adds, }guardian $e"
        done
    fi
    if [ ${#ADDITIONS_CON[@]} -gt 0 ]; then
        for e in "${ADDITIONS_CON[@]}"; do
            adds="${adds:+$adds, }concierge $e"
        done
    fi
    [ "$ARTISAN_CHANGE" = "enable" ] && adds="${adds:+$adds, }artisan lane"
    [ -z "$adds" ] && adds="none"

    rems=""
    if [ ${#REMOVALS_W[@]} -gt 0 ]; then
        for e in "${REMOVALS_W[@]}"; do
            rems="${rems:+$rems, }worker $e"
        done
    fi
    if [ ${#REMOVALS_S[@]} -gt 0 ]; then
        for e in "${REMOVALS_S[@]}"; do
            rems="${rems:+$rems, }scout $e"
        done
    fi
    if [ ${#REMOVALS_SM[@]} -gt 0 ]; then
        for e in "${REMOVALS_SM[@]}"; do
            rems="${rems:+$rems, }smith $e"
        done
    fi
    if [ ${#REMOVALS_LIB[@]} -gt 0 ]; then
        for e in "${REMOVALS_LIB[@]}"; do
            rems="${rems:+$rems, }librarian $e"
        done
    fi
    if [ ${#REMOVALS_OBS[@]} -gt 0 ]; then
        for e in "${REMOVALS_OBS[@]}"; do
            rems="${rems:+$rems, }observer $e"
        done
    fi
    if [ ${#REMOVALS_GRD[@]} -gt 0 ]; then
        for e in "${REMOVALS_GRD[@]}"; do
            rems="${rems:+$rems, }guardian $e"
        done
    fi
    if [ ${#REMOVALS_CON[@]} -gt 0 ]; then
        for e in "${REMOVALS_CON[@]}"; do
            rems="${rems:+$rems, }concierge $e"
        done
    fi
    [ "$ARTISAN_CHANGE" = "disable" ] && rems="${rems:+$rems, }artisan lane"
    [ -z "$rems" ] && rems="none"

    {
        echo ""
        printf '## #%03d — %s — Agent set updated\n' "$next_num" "$NOW"
        echo "- Blueprint: -"
        echo "- Milestone: -"
        echo "- Outcome: setup-change"
        echo "- Notes: diff-mode wizard. Added: $adds. Removed: $rems."
        echo ""
        echo "<!-- Next entry number: $((next_num + 1)) -->"
    } >> "$PM_ROOT/_pm/history.md"
    echo "  + $PM_ROOT/_pm/history.md appended (entry #$(printf '%03d' "$next_num"))"

    echo ""
    echo "==> Updating $PM_ROOT/runtime/manifest.md..."
    awk -v now="$NOW" '
        BEGIN { in_workers = 0; in_scouts = 0; in_smiths = 0; skipped = 0; saw_smiths = 0 }
        /^## Active Workers/ { in_workers = 1; in_scouts = 0; in_smiths = 0; print; next }
        /^## Active Scouts/  { in_workers = 0; in_scouts = 1; in_smiths = 0; print; next }
        /^## Active Smiths/  { in_workers = 0; in_scouts = 0; in_smiths = 1; saw_smiths = 1; print; next }
        /^## Backlog summary/ && !saw_smiths {
            print "## Active Smiths"
            print ""
            print "SMITHS_TABLE_PLACEHOLDER"
            print ""
            saw_smiths = 1
        }
        /^## / && !/^## Active/ { in_workers = 0; in_scouts = 0; in_smiths = 0 }
        in_workers && /^\| / { skipped = 1; next }
        in_scouts && /^\| / { skipped = 1; next }
        in_smiths && /^\| / { skipped = 1; next }
        in_workers && /^$/ && skipped { print "WORKERS_TABLE_PLACEHOLDER"; print; skipped = 0; in_workers = 0; next }
        in_scouts && /^$/ && skipped { print "SCOUTS_TABLE_PLACEHOLDER"; print; skipped = 0; in_scouts = 0; next }
        in_smiths && /^$/ && skipped { print "SMITHS_TABLE_PLACEHOLDER"; print; skipped = 0; in_smiths = 0; next }
        { print }
    ' "$PM_ROOT/runtime/manifest.md" > "$PM_ROOT/runtime/manifest.md.tmp"

    {
        echo "| Worker | State | Milestone | Phase | Task |"
        echo "| ------ | ----- | --------- | ----- | ---- |"
        for e in $(printf '%s\n' "${KEPT_W[@]}" "${ADDITIONS_W[@]}" | sort -u); do
            id="${e%%:*}"
            echo "| $id | IDLE | - | - | - |"
        done
    } > "$PM_ROOT/runtime/manifest.md.workers"
    {
        echo "| Scout | State | Investigation |"
        echo "| ----- | ----- | ------------- |"
        for e in $(printf '%s\n' "${KEPT_S[@]}" "${ADDITIONS_S[@]}" | sort -u); do
            id="${e%%:*}"
            echo "| $id | IDLE | - |"
        done
    } > "$PM_ROOT/runtime/manifest.md.scouts"
    {
        echo "| Smith | State | Focus | Task |"
        echo "| ----- | ----- | ----- | ---- |"
        for e in $(printf '%s\n' "${KEPT_SM[@]}" "${ADDITIONS_SM[@]}" | sort -u); do
            id="${e%%:*}"
            echo "| $id | IDLE | - | - |"
        done
    } > "$PM_ROOT/runtime/manifest.md.smiths"

    {
        while IFS= read -r line; do
            case "$line" in
                WORKERS_TABLE_PLACEHOLDER) cat "$PM_ROOT/runtime/manifest.md.workers" ;;
                SCOUTS_TABLE_PLACEHOLDER)  cat "$PM_ROOT/runtime/manifest.md.scouts" ;;
                SMITHS_TABLE_PLACEHOLDER)  cat "$PM_ROOT/runtime/manifest.md.smiths" ;;
                *) echo "$line" ;;
            esac
        done < "$PM_ROOT/runtime/manifest.md.tmp"

        echo ""
        echo "## Recent activity"
        echo ""
        echo "- $NOW — setup_wizard --mode diff — Agent set updated"
    } > "$PM_ROOT/runtime/manifest.md.new"

    awk '
        /^## Recent activity/ {
            count++; if (count == 1) { skip_until = 1 }
        }
        skip_until && /^## / && !/^## Recent activity/ { skip_until = 0 }
        !skip_until { print }
    ' "$PM_ROOT/runtime/manifest.md.new" > "$PM_ROOT/runtime/manifest.md"
    rm -f "$PM_ROOT/runtime/manifest.md.tmp" "$PM_ROOT/runtime/manifest.md.new" \
          "$PM_ROOT/runtime/manifest.md.workers" "$PM_ROOT/runtime/manifest.md.scouts" \
          "$PM_ROOT/runtime/manifest.md.smiths"
    sed -i.bak "s|^Last updated: .*|Last updated: $NOW|" "$PM_ROOT/runtime/manifest.md"
    sed -i.bak "s|^Updated by: .*|Updated by: setup_wizard (diff mode)|" "$PM_ROOT/runtime/manifest.md"
    rm -f "$PM_ROOT/runtime/manifest.md.bak"
    echo "  + manifest.md tables regenerated"

    echo ""
    echo "==================================="
    echo "Garelier setup complete (diff)."
    echo "==================================="
    echo ""
    echo "Worktrees:"
    git worktree list | sed 's/^/  /'

fi
