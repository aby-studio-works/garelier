#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scheduler_adapter.sh --job-id JOB_ID [options]

Options:
  --pm-id PM_ID         PM whose scheduled_jobs/ owns this job. Required
                        when multiple PMs exist under __garelier/.
  --project-root PATH   Target project root. Defaults to current directory.
  --now ISO8601         Override trigger timestamp for tests.
  -h, --help            Show this help.

v2.1: pm-id aware. Jobs live under __garelier/<pm_id>/control/scheduled_jobs/
and run state under __garelier/<pm_id>/runtime/scheduled_jobs/. This
reference adapter is called by an external scheduler when a Garelier
scheduled job is due. It records a run and notifies PM; it never
executes the job body directly.
USAGE
}

PROJECT_ROOT="."
JOB_ID=""
NOW=""
PM_ID=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project-root)
      PROJECT_ROOT="${2:?missing --project-root value}"
      shift 2
      ;;
    --job-id)
      JOB_ID="${2:?missing --job-id value}"
      shift 2
      ;;
    --pm-id)
      PM_ID="${2:?missing --pm-id value}"
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

if [ -z "$JOB_ID" ]; then
  usage >&2
  exit 1
fi

if [[ ! "$JOB_ID" =~ ^J-[A-Za-z0-9._-]+$ ]]; then
  echo "Invalid job id: $JOB_ID" >&2
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

# Auto-detect pm_id when not provided
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

PM_CONFIG="$GARELIER_ROOT/$PM_ID/_pm/setup_config.toml"
if [ ! -f "$PM_CONFIG" ]; then
  echo "Error: PM '$PM_ID' not found ($PM_CONFIG missing)." >&2
  exit 1
fi

JOB_FILE="__garelier/$PM_ID/control/scheduled_jobs/$JOB_ID.toml"
if [ ! -f "$JOB_FILE" ]; then
  echo "Scheduled job file not found: $JOB_FILE" >&2
  exit 1
fi

if [ -z "$NOW" ]; then
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi
STAMP="$(date -u +%Y%m%d-%H%M%S)"
RUN_ID="$(printf '%s' "$NOW" | sed 's/[:+]/-/g; s/[^A-Za-z0-9._-]/-/g')"
RUN_DIR="__garelier/$PM_ID/runtime/scheduled_jobs/runs/$JOB_ID/$RUN_ID"

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

toml_escape() {
  printf -- '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

safe_name() {
  printf -- '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'
}

write_run() {
  local status="$1"
  local reason="${2:-}"
  mkdir -p "$RUN_DIR"
  {
    printf -- 'job_id = "%s"\n' "$(toml_escape "$JOB_ID")"
    printf -- 'run_id = "%s"\n' "$(toml_escape "$RUN_ID")"
    printf -- 'pm_id = "%s"\n' "$(toml_escape "$PM_ID")"
    printf -- 'triggered_at = "%s"\n' "$(toml_escape "$NOW")"
    printf -- 'status = "%s"\n' "$(toml_escape "$status")"
    printf -- 'adapter = "scheduler_adapter.sh"\n'
    if [ -n "$reason" ]; then
      printf -- 'reason = "%s"\n' "$(toml_escape "$reason")"
    fi
  } > "$RUN_DIR/run.toml"
}

MANIFEST_JOB_ID="$(toml_value "" job_id "$JOB_FILE")"
STATUS="$(toml_value "" status "$JOB_FILE")"
OWNER_ROLE="$(toml_value "" owner_role "$JOB_FILE")"
TIMEZONE="$(toml_value "" timezone "$JOB_FILE")"
SCHEDULE="$(toml_value "" schedule "$JOB_FILE")"
PURPOSE="$(toml_value "" purpose "$JOB_FILE")"
ALLOW_COMMITS="$(toml_value safety allow_commits "$JOB_FILE")"
ALLOW_PROMOTE="$(toml_value safety allow_promote "$JOB_FILE")"
ALLOW_PRODUCTION_WRITE="$(toml_value safety allow_production_write "$JOB_FILE")"
LOCK_RESOURCE="$(toml_value lock resource "$JOB_FILE")"
LOCK_MODE="$(toml_value lock mode "$JOB_FILE")"

if [ "$MANIFEST_JOB_ID" != "$JOB_ID" ]; then
  echo "job_id field does not match --job-id" >&2
  write_run "failed_validation" "job_id field does not match --job-id"
  exit 2
fi

if [ "$STATUS" != "active" ]; then
  write_run "skipped_status" "job status is $STATUS"
  echo "SKIPPED_STATUS $JOB_ID $STATUS"
  exit 0
fi

for field in owner_role timezone schedule purpose; do
  value="$(toml_value "" "$field" "$JOB_FILE")"
  if [ -z "$value" ]; then
    echo "Missing required field: $field" >&2
    write_run "failed_validation" "missing required field: $field"
    exit 2
  fi
done
for field in allow_commits allow_promote allow_production_write; do
  value="$(toml_value safety "$field" "$JOB_FILE")"
  if [ -z "$value" ]; then
    echo "Missing required field: safety.$field" >&2
    write_run "failed_validation" "missing required field: safety.$field"
    exit 2
  fi
done

if [ "$ALLOW_PROMOTE" = "true" ]; then
  echo "allow_promote=true is forbidden for scheduled jobs" >&2
  write_run "failed_validation" "allow_promote=true is forbidden"
  exit 2
fi

if [ "$ALLOW_PRODUCTION_WRITE" = "true" ]; then
  if ! toml_section_exists data_change_guards "$JOB_FILE"; then
    echo "Production write job is missing data_change_guards" >&2
    write_run "failed_validation" "production write job is missing data_change_guards"
    exit 2
  fi
  if [ "$(toml_value data_change_guards dry_run_supported "$JOB_FILE")" != "true" ] || \
     [ -z "$(toml_value data_change_guards rollback_plan "$JOB_FILE")" ] || \
     [ "$(toml_value data_change_guards user_approval_required_per_run "$JOB_FILE")" != "true" ]; then
    echo "Production write job has incomplete data_change_guards" >&2
    write_run "failed_validation" "production write job has incomplete data_change_guards"
    exit 2
  fi
fi

if [ -z "$LOCK_RESOURCE" ]; then
  LOCK_RESOURCE="$JOB_ID"
fi
if [ -z "$LOCK_MODE" ]; then
  LOCK_MODE="skip_if_running"
fi
LOCK_NAME="$(safe_name "$LOCK_RESOURCE")"
LOCK_DIR="__garelier/$PM_ID/runtime/scheduled_jobs/locks/$LOCK_NAME.lock"

mkdir -p "__garelier/$PM_ID/runtime/scheduled_jobs/locks" "__garelier/$PM_ID/runtime/pm/inbox"

if [ "$LOCK_MODE" != "skip_if_running" ]; then
  echo "Unsupported lock mode in reference adapter: $LOCK_MODE" >&2
  write_run "failed_validation" "unsupported lock mode: $LOCK_MODE"
  exit 2
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  write_run "skipped_locked" "lock already exists: $LOCK_DIR"
  echo "SKIPPED_LOCKED $JOB_ID $LOCK_DIR"
  exit 0
fi

{
  printf -- 'job_id = "%s"\n' "$(toml_escape "$JOB_ID")"
  printf -- 'run_id = "%s"\n' "$(toml_escape "$RUN_ID")"
  printf -- 'pm_id = "%s"\n' "$(toml_escape "$PM_ID")"
  printf -- 'created_at = "%s"\n' "$(toml_escape "$NOW")"
  printf -- 'resource = "%s"\n' "$(toml_escape "$LOCK_RESOURCE")"
  printf -- 'mode = "%s"\n' "$(toml_escape "$LOCK_MODE")"
  printf -- 'owner = "scheduler_adapter.sh"\n'
} > "$LOCK_DIR/lock.toml"

write_run "notified_pm"
{
  printf -- 'lock_dir = "%s"\n' "$(toml_escape "$LOCK_DIR")"
} >> "$RUN_DIR/run.toml"

PM_NOTE="__garelier/$PM_ID/runtime/pm/inbox/$STAMP-scheduled-job-$JOB_ID.md"
{
  printf -- '# Scheduled job due: %s\n\n' "$JOB_ID"
  printf -- '- PM: `%s`\n' "$PM_ID"
  printf -- '- Owner role: `%s`\n' "$OWNER_ROLE"
  printf -- '- Timezone: `%s`\n' "$TIMEZONE"
  printf -- '- Schedule: `%s`\n' "$SCHEDULE"
  printf -- '- Purpose: %s\n' "$PURPOSE"
  printf -- '- Triggered at: `%s`\n' "$NOW"
  printf -- '- Job file: `%s`\n' "$JOB_FILE"
  printf -- '- Run directory: `%s`\n' "$RUN_DIR"
  printf -- '- Lock directory: `%s`\n' "$LOCK_DIR"
  printf -- '- allow_commits: `%s`\n' "$ALLOW_COMMITS"
  printf -- '- allow_production_write: `%s`\n' "$ALLOW_PRODUCTION_WRITE"
  printf -- '\nPM action:\n'
  printf -- '1. Review job inputs, safety flags, and dashboard context.\n'
  printf -- '2. Convert the due job into normal PM/Dock work as needed.\n'
  printf -- '3. Update `%s/run.toml` to a terminal status and remove `%s` when complete.\n' "$RUN_DIR" "$LOCK_DIR"
} > "$PM_NOTE"

echo "NOTIFIED_PM $JOB_ID $RUN_ID"
