#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  request_intake_handler.sh --request-dir PATH --request-branch BRANCH --target-pm ID [options]

Options:
  --project-root PATH   Target project root. Defaults to current directory.
  --commit-sha SHA      Request branch commit SHA. Defaults to git rev-parse HEAD in request-dir.
  --now ISO8601         Override received timestamp for tests.
  -h, --help            Show this help.

v2.1: pm-id aware. The target PM is named in the request branch
(`garelier/request/<target_pm>/<source_pm>/<id>-<uid>`) and passed via
--target-pm. All writes go under __garelier/<target_pm>/{control,runtime}/.

This reference handler validates a delegated request export and writes
only Garelier runtime/control files. It never executes request-provided
commands.
USAGE
}

PROJECT_ROOT="."
REQUEST_DIR=""
REQUEST_BRANCH=""
TARGET_PM=""
COMMIT_SHA=""
NOW=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-root)
      PROJECT_ROOT="${2:?missing --project-root value}"
      shift 2
      ;;
    --request-dir)
      REQUEST_DIR="${2:?missing --request-dir value}"
      shift 2
      ;;
    --request-branch)
      REQUEST_BRANCH="${2:?missing --request-branch value}"
      shift 2
      ;;
    --target-pm)
      TARGET_PM="${2:?missing --target-pm value}"
      shift 2
      ;;
    --commit-sha)
      COMMIT_SHA="${2:?missing --commit-sha value}"
      shift 2
      ;;
    --now)
      NOW="${2:?missing --now value}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "$REQUEST_DIR" ] || [ -z "$REQUEST_BRANCH" ] || [ -z "$TARGET_PM" ]; then
  usage >&2
  exit 1
fi

if [ ! -d "$PROJECT_ROOT" ]; then
  echo "Project root not found: $PROJECT_ROOT" >&2
  exit 1
fi

cd "$PROJECT_ROOT"
PROJECT_ROOT="$(pwd -P)"
GARELIER_ROOT="$PROJECT_ROOT/__garelier"

if [ ! -d "$GARELIER_ROOT" ]; then
  echo "Error: not a Garelier project root: $PROJECT_ROOT" >&2
  exit 1
fi

# Verify the target PM exists locally. If --target-pm names a PM that
# isn't initialized on this machine, fail fast — we cannot deliver.
TARGET_PM_CONFIG="$GARELIER_ROOT/$TARGET_PM/_pm/setup_config.toml"
if [ ! -f "$TARGET_PM_CONFIG" ]; then
  echo "Error: target PM '$TARGET_PM' is not initialized at $TARGET_PM_CONFIG" >&2
  pm_candidates=()
  for d in "$GARELIER_ROOT"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    [ -f "$d/_pm/setup_config.toml" ] && pm_candidates+=("$name")
  done
  if [ "${#pm_candidates[@]}" -gt 0 ]; then
    echo "       Available PMs:" >&2
    for p in "${pm_candidates[@]}"; do echo "         - $p" >&2; done
  else
    echo "       No PMs initialized; run setup_wizard." >&2
  fi
  exit 1
fi

if [ ! -d "$REQUEST_DIR" ]; then
  echo "Request directory not found: $REQUEST_DIR" >&2
  exit 1
fi
REQUEST_DIR="$(cd "$REQUEST_DIR" && pwd -P)"

REQUEST_TOML="$REQUEST_DIR/.garelier/request.toml"
REQUEST_MD="$REQUEST_DIR/.garelier/request.md"

# Control + runtime trees live under the target PM.
PM_CONTROL="__garelier/$TARGET_PM/control"
PM_RUNTIME="__garelier/$TARGET_PM/runtime"
ALLOW_SOURCES="$PM_CONTROL/request_intake/allowed_sources.toml"
ALLOW_KINDS="$PM_CONTROL/request_intake/allowed_request_kinds.toml"
CAPABILITIES="$PM_CONTROL/delegation/capability_registry.toml"

if [ ! -f "$REQUEST_TOML" ]; then
  echo "Missing request manifest: $REQUEST_TOML" >&2
  exit 1
fi

if [ -z "$NOW" ]; then
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
STAMP="$(date -u +%Y%m%d-%H%M%S)"

if [ -z "$COMMIT_SHA" ]; then
  COMMIT_SHA="$(git -C "$REQUEST_DIR" rev-parse HEAD 2>/dev/null || printf '%s' unknown)"
fi

toml_value() {
  local section="$1"
  local key="$2"
  local file="$3"
  awk -v section="$section" -v key="$key" '
    BEGIN { inside = (section == "") }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*\[/ {
      line = $0
      sub(/^[[:space:]]*\[/, "", line)
      sub(/\][[:space:]]*$/, "", line)
      inside = (line == section)
      next
    }
    inside {
      pattern = "^[[:space:]]*" key "[[:space:]]*="
      if ($0 ~ pattern) {
        value = $0
        sub(/^[^=]*=[[:space:]]*/, "", value)
        sub(/[[:space:]]+#.*$/, "", value)
        sub(/^[[:space:]]+/, "", value)
        sub(/[[:space:]]+$/, "", value)
        sub(/^"/, "", value)
        sub(/"$/, "", value)
        print value
        exit
      }
    }
  ' "$file"
}

toml_section_exists() {
  local section="$1"
  local file="$2"
  grep -Eq "^[[:space:]]*\\[$section\\][[:space:]]*$" "$file"
}

list_contains() {
  local list="$1"
  local needle="$2"
  local item
  list="${list#[}"
  list="${list%]}"
  list="${list//\"/}"
  list="${list// /}"
  IFS=',' read -r -a items <<< "$list"
  for item in "${items[@]}"; do
    if [ "$item" = "$needle" ]; then
      return 0
    fi
  done
  return 1
}

list_empty() {
  local list="$1"
  list="${list#[}"
  list="${list%]}"
  list="${list//\"/}"
  list="${list// /}"
  [ -z "$list" ]
}

source_id_exists() {
  local file="$1"
  local source_id="$2"
  awk -v source_id="$source_id" '
    /^[[:space:]]*id[[:space:]]*=/ {
      value = $0
      sub(/^[^=]*=[[:space:]]*/, "", value)
      sub(/[[:space:]]+#.*$/, "", value)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      sub(/^"/, "", value)
      sub(/"$/, "", value)
      if (value == source_id) {
        found = 1
        exit
      }
    }
    END { exit(found ? 0 : 1) }
  ' "$file"
}

bool_true() {
  [ "${1,,}" = "true" ]
}

priority_rank() {
  case "$1" in
    low) printf '%s' 1 ;;
    normal) printf '%s' 2 ;;
    high) printf '%s' 3 ;;
    urgent) printf '%s' 4 ;;
    *) printf '%s' 0 ;;
  esac
}

toml_escape() {
  printf -- '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_rejection() {
  local rid="$1"
  local reason="$2"
  local safe_id="$rid"
  if [ -z "$safe_id" ]; then
    safe_id="unknown-$STAMP"
  fi

  mkdir -p "$PM_RUNTIME/requests/rejected" "$PM_CONTROL/reports/requests"
  {
    printf -- '# Rejected delegated request\n'
    printf -- 'request_id = "%s"\n' "$(toml_escape "$safe_id")"
    printf -- 'target_pm = "%s"\n' "$(toml_escape "$TARGET_PM")"
    printf -- 'request_branch = "%s"\n' "$(toml_escape "$REQUEST_BRANCH")"
    printf -- 'commit_sha = "%s"\n' "$(toml_escape "$COMMIT_SHA")"
    printf -- 'rejected_at = "%s"\n' "$(toml_escape "$NOW")"
    printf -- 'reason = "%s"\n' "$(toml_escape "$reason")"
  } > "$PM_RUNTIME/requests/rejected/$safe_id.toml"

  {
    printf -- '# Request rejected: %s\n\n' "$safe_id"
    printf -- '- Target PM: `%s`\n' "$TARGET_PM"
    printf -- '- Request branch: `%s`\n' "$REQUEST_BRANCH"
    printf -- '- Commit SHA: `%s`\n' "$COMMIT_SHA"
    printf -- '- Rejected at: `%s`\n' "$NOW"
    printf -- '- Reason: %s\n' "$reason"
    if [ -f "$REQUEST_TOML" ]; then
      printf -- '- Manifest: `%s`\n' "$REQUEST_TOML"
    fi
  } > "$PM_CONTROL/reports/requests/$safe_id-rejected.md"

  echo "REJECTED $safe_id: $reason" >&2
}

REASONS=()
reject() {
  REASONS+=("$1")
}

REQUEST_ID="$(toml_value "" request_id "$REQUEST_TOML")"
SHORT_UID="$(toml_value "" short_uid "$REQUEST_TOML")"
SOURCE_PM="$(toml_value "" source_pm "$REQUEST_TOML")"
MANIFEST_TARGET_PM="$(toml_value "" target_pm "$REQUEST_TOML")"
KIND="$(toml_value "" kind "$REQUEST_TOML")"
PRIORITY="$(toml_value "" priority "$REQUEST_TOML")"
MANIFEST_BRANCH="$(toml_value git request_branch "$REQUEST_TOML")"
ALLOW_COMMITS="$(toml_value safety allow_commits "$REQUEST_TOML")"
ALLOW_PROMOTE="$(toml_value safety allow_promote "$REQUEST_TOML")"
ALLOW_PRODUCTION_WRITE="$(toml_value safety allow_production_write "$REQUEST_TOML")"

if [[ "$REQUEST_BRANCH" =~ ^garelier/request/([^/]+)/([^/]+)/(R-[0-9]{8}-[0-9]{4}-[a-z0-9-]+)-([a-f0-9]{6,8})$ ]]; then
  BRANCH_TARGET="${BASH_REMATCH[1]}"
  BRANCH_SOURCE="${BASH_REMATCH[2]}"
  BRANCH_REQUEST_ID="${BASH_REMATCH[3]}"
  BRANCH_UID="${BASH_REMATCH[4]}"
else
  reject "request branch does not match garelier/request/<target>/<source>/<request_id>-<uid>"
  BRANCH_TARGET=""
  BRANCH_SOURCE=""
  BRANCH_REQUEST_ID=""
  BRANCH_UID=""
fi

for field in request_id short_uid source_pm target_pm kind priority created_at; do
  value="$(toml_value "" "$field" "$REQUEST_TOML")"
  if [ -z "$value" ]; then
    reject "missing required field: $field"
  fi
done
for field in request_branch; do
  value="$(toml_value git "$field" "$REQUEST_TOML")"
  if [ -z "$value" ]; then
    reject "missing required field: git.$field"
  fi
done
for field in allow_commits allow_promote allow_production_write; do
  value="$(toml_value safety "$field" "$REQUEST_TOML")"
  if [ -z "$value" ]; then
    reject "missing required field: safety.$field"
  fi
done

if grep -Eq '^[[:space:]]*(command|commands|script|shell|exec|run|entrypoint|arguments|args|env)[[:space:]]*=' "$REQUEST_TOML"; then
  reject "request manifest contains a forbidden executable field"
fi

if [ -n "$BRANCH_REQUEST_ID" ] && [ "$REQUEST_ID" != "$BRANCH_REQUEST_ID" ]; then
  reject "request_id does not match request branch"
fi
if [ -n "$BRANCH_UID" ] && [ "$SHORT_UID" != "$BRANCH_UID" ]; then
  reject "short_uid does not match request branch"
fi
if [ -n "$BRANCH_SOURCE" ] && [ "$SOURCE_PM" != "$BRANCH_SOURCE" ]; then
  reject "source_pm does not match request branch"
fi
if [ -n "$BRANCH_TARGET" ] && [ "$BRANCH_TARGET" != "$TARGET_PM" ]; then
  reject "branch target_pm '$BRANCH_TARGET' does not match --target-pm '$TARGET_PM'"
fi
if [ "$MANIFEST_BRANCH" != "$REQUEST_BRANCH" ]; then
  reject "git.request_branch does not match request branch"
fi
if [ "$MANIFEST_TARGET_PM" != "$TARGET_PM" ]; then
  reject "target_pm is not this local PM"
fi

if [ ! -f "$ALLOW_SOURCES" ]; then
  reject "allowed_sources.toml is missing for target PM '$TARGET_PM'"
elif [ -n "$SOURCE_PM" ] && ! source_id_exists "$ALLOW_SOURCES" "$SOURCE_PM"; then
  reject "source_pm is not allowlisted"
fi

if [ ! -f "$ALLOW_KINDS" ]; then
  reject "allowed_request_kinds.toml is missing for target PM '$TARGET_PM'"
elif [ -n "$KIND" ]; then
  if ! toml_section_exists "kind\\.$KIND" "$ALLOW_KINDS"; then
    reject "kind is not listed in allowed_request_kinds.toml"
  fi
  if [ "$(toml_value "kind.$KIND" allowed "$ALLOW_KINDS")" = "false" ]; then
    reject "kind is explicitly disabled"
  fi
fi

if [ ! -f "$CAPABILITIES" ]; then
  reject "capability_registry.toml is missing for target PM '$TARGET_PM'"
elif [ -n "$KIND" ]; then
  if ! toml_section_exists "capability\\.$KIND" "$CAPABILITIES"; then
    reject "kind is not present in capability_registry.toml"
  else
    CAP_ENABLED="$(toml_value "capability.$KIND" enabled "$CAPABILITIES")"
    CAP_ALLOW_COMMITS="$(toml_value "capability.$KIND" allow_commits "$CAPABILITIES")"
    CAP_ALLOW_PROD="$(toml_value "capability.$KIND" allow_production_write "$CAPABILITIES")"
    CAP_SOURCES="$(toml_value "capability.$KIND" allowed_sources "$CAPABILITIES")"
    CAP_MAX_PRIORITY="$(toml_value "capability.$KIND" max_priority "$CAPABILITIES")"

    if [ "$CAP_ENABLED" != "true" ]; then
      reject "capability is not enabled"
    fi
    if bool_true "$ALLOW_COMMITS" && [ "$CAP_ALLOW_COMMITS" != "true" ]; then
      reject "request allows commits but capability does not"
    fi
    if bool_true "$ALLOW_PRODUCTION_WRITE" && [ "$CAP_ALLOW_PROD" != "true" ]; then
      reject "request allows production write but capability does not"
    fi
    if [ -z "$CAP_SOURCES" ] || list_empty "$CAP_SOURCES"; then
      reject "capability has no enrolled source PMs"
    elif ! list_contains "$CAP_SOURCES" "$SOURCE_PM"; then
      reject "source_pm is not enrolled for this capability"
    fi
    if [ -n "$CAP_MAX_PRIORITY" ]; then
      if [ "$(priority_rank "$PRIORITY")" -gt "$(priority_rank "$CAP_MAX_PRIORITY")" ]; then
        reject "priority exceeds capability max_priority"
      fi
    fi
  fi
fi

if bool_true "$ALLOW_PROMOTE"; then
  reject "allow_promote=true is forbidden"
fi

if bool_true "$ALLOW_PRODUCTION_WRITE"; then
  if ! toml_section_exists data_change_guards "$REQUEST_TOML"; then
    reject "production write request is missing data_change_guards"
  else
    if [ "$(toml_value data_change_guards dry_run_supported "$REQUEST_TOML")" != "true" ]; then
      reject "production write request must support dry_run"
    fi
    if [ -z "$(toml_value data_change_guards rollback_plan "$REQUEST_TOML")" ]; then
      reject "production write request is missing rollback_plan"
    fi
    if [ "$(toml_value data_change_guards user_approval_required_per_run "$REQUEST_TOML")" != "true" ]; then
      reject "production write request must require per-run user approval"
    fi
  fi
fi

INBOX_TOML="$PM_RUNTIME/requests/inbox/$REQUEST_ID.toml"
PROCESSED_TOML="$PM_RUNTIME/requests/processed/$REQUEST_ID.toml"
if [ -n "$REQUEST_ID" ]; then
  for existing in "$INBOX_TOML" "$PROCESSED_TOML"; do
    if [ -f "$existing" ]; then
      EXISTING_SHA="$(toml_value intake commit_sha "$existing")"
      if [ "$EXISTING_SHA" = "$COMMIT_SHA" ]; then
        echo "ALREADY_ACCEPTED $REQUEST_ID $COMMIT_SHA"
        exit 0
      fi
      reject "duplicate request_id exists with a different commit SHA"
    fi
  done
fi

if [ "${#REASONS[@]}" -gt 0 ]; then
  REASON="$(IFS='; '; printf '%s' "${REASONS[*]}")"
  write_rejection "$REQUEST_ID" "$REASON"
  exit 2
fi

mkdir -p "$PM_RUNTIME/requests/inbox" "$PM_RUNTIME/pm/inbox" \
  "$PM_RUNTIME/requests/processed" "$PM_RUNTIME/requests/rejected" \
  "$PM_CONTROL/reports/requests"

{
  printf -- '# Normalized by Garelier request_intake_handler.sh\n'
  cat "$REQUEST_TOML"
  printf -- '\n\n[intake]\n'
  printf -- 'target_pm = "%s"\n' "$(toml_escape "$TARGET_PM")"
  printf -- 'commit_sha = "%s"\n' "$(toml_escape "$COMMIT_SHA")"
  printf -- 'received_at = "%s"\n' "$(toml_escape "$NOW")"
  printf -- 'request_dir = "%s"\n' "$(toml_escape "$REQUEST_DIR")"
  printf -- 'handler = "request_intake_handler.sh"\n'
} > "$INBOX_TOML"

PM_NOTE="$PM_RUNTIME/pm/inbox/$STAMP-request-$REQUEST_ID.md"
{
  printf -- '# Delegated request accepted: %s\n\n' "$REQUEST_ID"
  printf -- '- Source PM: `%s`\n' "$SOURCE_PM"
  printf -- '- Target PM: `%s`\n' "$MANIFEST_TARGET_PM"
  printf -- '- Kind: `%s`\n' "$KIND"
  printf -- '- Priority: `%s`\n' "$PRIORITY"
  printf -- '- Request branch: `%s`\n' "$REQUEST_BRANCH"
  printf -- '- Commit SHA: `%s`\n' "$COMMIT_SHA"
  printf -- '- Received at: `%s`\n' "$NOW"
  printf -- '- Normalized request: `%s`\n' "$INBOX_TOML"
  if [ -f "$REQUEST_MD" ]; then
    printf -- '- Request brief: `%s`\n' "$REQUEST_MD"
  fi
  printf -- '\nPM action:\n'
  printf -- '1. Review the normalized request and delegated capability bounds.\n'
  printf -- '2. Convert acceptable work into a blueprint or dashboard task.\n'
  printf -- '3. Move the normalized request to `%s/requests/processed/` when handled.\n' "$PM_RUNTIME"
} > "$PM_NOTE"

echo "ACCEPTED $REQUEST_ID $COMMIT_SHA"
