#!/usr/bin/env bash
#
# Plant-Crust initializer.
#
# Creates:
#   <workfolder>/crust.toml
#   <workfolder>/<container-id>/container.lock.toml
#   <workfolder>/<container-id>/__garelier/
#   <workfolder>/<container-id>/target/
#
# Then, unless --skip-setup is passed, runs the normal setup wizard from
# container/__garelier with --target-root target.

set -euo pipefail

WORKFOLDER=""
WORKFOLDER_ID=""
CONTAINER_ID=""
TARGET_REMOTE=""
TARGET_BRANCH="main"
PM_ID="_workshop"
PROJECT_NAME=""
TARGET_INIT="false"
SKIP_SETUP="false"
SKIP_CONFIRM="false"
RESUME="false"
REPAIR_LOCK="false"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CORE_TEMPLATES_DIR="${GARELIER_CORE_TEMPLATES_DIR:-$SKILLS_DIR/garelier-core/templates}"
PLANT_TS="$SKILLS_DIR/garelier-core/driver/src/plant.ts"
SETUP_WIZARD="$SKILLS_DIR/garelier-pm/scripts/setup_wizard.sh"

usage() {
    cat <<'EOF'
Usage: crust_init.sh --workfolder <path> --container-id <id> [options]

Options:
  --workfolder-id <id>       Workfolder id written to crust.toml.
  --container-id <id>        Container id and directory name.
  --target-remote <url>      Clone target repo into <container>/target when absent.
  --target-branch <branch>   Target branch for clone/setup (default: main).
  --target-init              Initialize an empty target repo when target/ is absent.
  --pm-id <id>               PM id for setup (default: _workshop).
  --project-name <name>      Project name for setup (default: container id).
  --skip-setup               Only write Plant-Crust descriptors and directories.
  --skip-confirm             Pass --skip-confirm to setup wizard.
  --resume                   Continue an existing container after a prior failed run.
  --repair-lock              Rewrite container.lock.toml for an existing container and exit.
  --help                     Show this help.

If target/ already exists, it must be a git repository. If target/ is absent,
pass either --target-remote or --target-init.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --workfolder) WORKFOLDER="$2"; shift 2 ;;
        --workfolder-id) WORKFOLDER_ID="$2"; shift 2 ;;
        --container-id) CONTAINER_ID="$2"; shift 2 ;;
        --target-remote) TARGET_REMOTE="$2"; shift 2 ;;
        --target-branch) TARGET_BRANCH="$2"; shift 2 ;;
        --target-init) TARGET_INIT="true"; shift ;;
        --pm-id) PM_ID="$2"; shift 2 ;;
        --project-name) PROJECT_NAME="$2"; shift 2 ;;
        --skip-setup) SKIP_SETUP="true"; shift ;;
        --skip-confirm) SKIP_CONFIRM="true"; shift ;;
        --resume) RESUME="true"; shift ;;
        --repair-lock) REPAIR_LOCK="true"; RESUME="true"; shift ;;
        --help|-h) usage; exit 0 ;;
        *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
    esac
done

[ -n "$WORKFOLDER" ] || { echo "Error: --workfolder is required." >&2; exit 1; }
[ -n "$CONTAINER_ID" ] || { echo "Error: --container-id is required." >&2; exit 1; }
case "$CONTAINER_ID" in
    *[!A-Za-z0-9._-]*|.*|*/|*/*|*\\*) echo "Error: unsafe --container-id '$CONTAINER_ID'." >&2; exit 1 ;;
esac

mkdir -p "$WORKFOLDER"
WORKFOLDER="$(cd "$WORKFOLDER" && pwd)"
if [ -z "$WORKFOLDER_ID" ]; then
    WORKFOLDER_ID="$(basename "$WORKFOLDER" | tr -c 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//')"
    [ -n "$WORKFOLDER_ID" ] || WORKFOLDER_ID="workfolder"
fi
[ -n "$PROJECT_NAME" ] || PROJECT_NAME="$CONTAINER_ID"

CONTAINER_ROOT="$WORKFOLDER/$CONTAINER_ID"
GARELIER_ROOT="$CONTAINER_ROOT/__garelier"
TARGET_ROOT="$CONTAINER_ROOT/target"

crust_container_path() {
    local crust="$1" id="$2"
    awk -v want="$id" '
        function clean(v) {
            sub(/^[^=]*=[[:space:]]*/, "", v)
            sub(/[[:space:]]*#.*$/, "", v)
            sub(/^"/, "", v); sub(/"$/, "", v)
            return v
        }
        function flush() {
            if (cid == want) {
                if (cpath == "") cpath = cid
                print cpath
                found = 1
            }
        }
        /^\[\[containers\]\]/ { if (in_container && !found) flush(); in_container = 1; cid = ""; cpath = ""; next }
        /^\[/ { if (in_container && !found) flush(); in_container = 0; cid = ""; cpath = ""; next }
        in_container && /^[[:space:]]*id[[:space:]]*=/ { cid = clean($0); next }
        in_container && /^[[:space:]]*path[[:space:]]*=/ { cpath = clean($0); next }
        END { if (in_container && !found) flush() }
    ' "$crust"
}

mkdir -p "$GARELIER_ROOT"

if [ ! -e "$TARGET_ROOT" ]; then
    if [ -n "$TARGET_REMOTE" ]; then
        git clone --branch "$TARGET_BRANCH" "$TARGET_REMOTE" "$TARGET_ROOT"
    elif [ "$TARGET_INIT" = "true" ]; then
        mkdir -p "$TARGET_ROOT"
        git -C "$TARGET_ROOT" init
        git -C "$TARGET_ROOT" checkout -B "$TARGET_BRANCH" >/dev/null 2>&1
        if ! git -C "$TARGET_ROOT" commit --allow-empty -m "chore: initialize target" >/dev/null 2>&1; then
            echo "Error: target repo initialized but initial empty commit failed." >&2
            echo "Fix git user.name/user.email, create the first commit, then rerun with --skip-setup or rerun setup from $GARELIER_ROOT." >&2
            exit 1
        fi
    else
        echo "Error: $TARGET_ROOT does not exist." >&2
        echo "Pass --target-remote <url>, --target-init, or create target/ first." >&2
        exit 1
    fi
fi

if [ ! -e "$TARGET_ROOT/.git" ]; then
    echo "Error: target root is not a git repository: $TARGET_ROOT" >&2
    exit 1
fi
if [ -e "$TARGET_ROOT/__garelier" ]; then
    echo "Error: Plant-Crust forbids target_root/__garelier: $TARGET_ROOT/__garelier" >&2
    exit 1
fi
if ! git -C "$TARGET_ROOT" rev-parse HEAD >/dev/null 2>&1; then
    echo "Error: target repository has no commits. Create one before setup." >&2
    exit 1
fi
if ! git -C "$TARGET_ROOT" rev-parse --verify "$TARGET_BRANCH" >/dev/null 2>&1; then
    echo "Error: target branch '$TARGET_BRANCH' does not exist in $TARGET_ROOT." >&2
    exit 1
fi

ADD_OUTPUT=""
if ! ADD_OUTPUT="$(bun "$PLANT_TS" add-container \
    --crust "$WORKFOLDER/crust.toml" \
    --workfolder-id "$WORKFOLDER_ID" \
    --container-id "$CONTAINER_ID" \
    --container-path "$CONTAINER_ID" 2>&1 >/dev/null)"; then
    if [ "$RESUME" = "true" ] && printf '%s' "$ADD_OUTPUT" | grep -Fq "container already exists"; then
        existing_path="$(crust_container_path "$WORKFOLDER/crust.toml" "$CONTAINER_ID")"
        if [ "$existing_path" != "$CONTAINER_ID" ]; then
            echo "Error: existing container '$CONTAINER_ID' uses path '$existing_path'; crust-init resume only supports path '$CONTAINER_ID'." >&2
            exit 1
        fi
    else
        printf '%s\n' "$ADD_OUTPUT" >&2
        exit 1
    fi
fi

bun "$PLANT_TS" write-lock \
    --crust "$WORKFOLDER/crust.toml" \
    --lock "$CONTAINER_ROOT/container.lock.toml" \
    --container "$CONTAINER_ID" \
    --target-remote "$TARGET_REMOTE" \
    --target-branch "$TARGET_BRANCH" >/dev/null

if [ "$REPAIR_LOCK" = "true" ]; then
    echo "Plant-Crust lock repaired: $CONTAINER_ROOT/container.lock.toml"
    exit 0
fi
if [ -f "$CORE_TEMPLATES_DIR/plant_crust_gitignore" ] && [ ! -f "$WORKFOLDER/.gitignore" ]; then
    cp "$CORE_TEMPLATES_DIR/plant_crust_gitignore" "$WORKFOLDER/.gitignore"
fi

echo "Plant-Crust initialized:"
echo "  workfolder: $WORKFOLDER"
echo "  container:  $CONTAINER_ROOT"
echo "  control:    $GARELIER_ROOT"
echo "  target:     $TARGET_ROOT"

if [ "$SKIP_SETUP" = "true" ]; then
    exit 0
fi

SETUP_ARGS=(--mode fresh --pm-id "$PM_ID" --project-name "$PROJECT_NAME" --target "$TARGET_BRANCH" --target-root "target")
if [ "$SKIP_CONFIRM" = "true" ]; then
    SETUP_ARGS+=(--skip-confirm)
fi

echo ""
echo "Running Garelier setup inside Plant-Crust container..."
(
    cd "$GARELIER_ROOT"
    bash "$SETUP_WIZARD" "${SETUP_ARGS[@]}"
)
