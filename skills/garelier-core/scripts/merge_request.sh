#!/usr/bin/env bash
#
# merge_request.sh — one-command merge-gate request (DEC-064 §1).
#
# Derives everything the merge gate's request JSON needs from existing
# artifacts, so the Dock never hand-assembles it (the two live-failure
# classes — missing verdicts, empty merge_message — become impossible):
#   studio branch   ← setup_config.toml [branches] integration (or --studio)
#   request_id      ← UTC timestamp + task label
#   merge_message   ← generated non-empty (or --message)
#   verdicts        ← --guardian / --observer flags
# Writes runtime/merge_gate/requests/<id>.json and (unless --no-poll) runs the
# zero-LLM dock_merge.ts poll so the gate subprocess starts immediately.
#
# Usage:
#   merge_request.sh --project <control-root> --pm-id <id> --branch <workbench-branch>
#                    --guardian <PASS|PASS_WITH_NOTES> [--observer <verdict>]
#                    [--task <label>] [--message <msg>] [--studio <branch>]
#                    [--target-root <git-root>] [--core <garelier-core-dir>] [--no-poll]
set -euo pipefail

PROJECT="" TARGET_ROOT="" PM="" BRANCH="" TASK="" GUARDIAN="" OBSERVER="" MESSAGE="" STUDIO="" CORE="" NO_POLL=0
GUARDIAN_REPORT="" OBSERVER_REPORT="" GUARDIAN_REVIEW_SHA=""
QG_CMDS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project)  PROJECT="${2:?}"; shift 2 ;;
    --target-root) TARGET_ROOT="${2:?}"; shift 2 ;;
    --pm-id)    PM="${2:?}"; shift 2 ;;
    --branch)   BRANCH="${2:?}"; shift 2 ;;
    --task)     TASK="${2:?}"; shift 2 ;;
    --guardian) GUARDIAN="${2:?}"; shift 2 ;;
    --observer) OBSERVER="${2:?}"; shift 2 ;;
    --guardian-report) GUARDIAN_REPORT="${2:?}"; shift 2 ;;
    --observer-report) OBSERVER_REPORT="${2:?}"; shift 2 ;;
    --guardian-review-sha) GUARDIAN_REVIEW_SHA="${2:?}"; shift 2 ;;
    --message)  MESSAGE="${2:?}"; shift 2 ;;
    --studio)   STUDIO="${2:?}"; shift 2 ;;
    --core)     CORE="${2:?}"; shift 2 ;;
    --quality-gate) QG_CMDS+=("${2:?}"); shift 2 ;;
    --no-poll)  NO_POLL=1; shift ;;
    -h|--help)  sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "merge_request: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] && [ -n "$BRANCH" ] || {
  echo "merge_request: --project, --pm-id, --branch are required" >&2; exit 2; }
GIT_ROOT="${TARGET_ROOT:-$PROJECT}"
[ -n "$GUARDIAN" ] || {
  echo "merge_request: --guardian <verdict> is required ([guardian_policy] require_for_all_merges rejects requests without it)" >&2; exit 2; }

if [ -z "$STUDIO" ]; then
  CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
  [ -f "$CONFIG" ] || { echo "merge_request: no --studio and no $CONFIG" >&2; exit 2; }
  STUDIO="$(sed -n 's/^[[:space:]]*integration[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CONFIG" | head -1)"
  [ -n "$STUDIO" ] || { echo "merge_request: [branches] integration not found in $CONFIG" >&2; exit 2; }
fi

# Task label defaults to the branch tail (…/#<id>/<slug> → "#<id>-<slug>").
if [ -z "$TASK" ]; then
  TASK="$(printf '%s' "$BRANCH" | awk -F/ '{print $(NF-1)"-"$NF}')"
fi
SAFE_TASK="$(printf '%s' "$TASK" | tr -cd 'a-zA-Z0-9_-' | cut -c1-40)"
REQ_ID="$(date -u +%Y%m%d-%H%M%S)-${SAFE_TASK:-req}"

if [ -z "$MESSAGE" ]; then
  MESSAGE="merge $TASK into studio"$'\n\n'"Guardian $GUARDIAN${OBSERVER:+; Observer $OBSERVER}."
fi

# Quality-gate commands run by the merge gate ON THE MERGE RESULT (re-verify so a
# broken base cannot land via the normal merge path). Explicit --quality-gate flags
# win; else fall back to [quality_gate] merge_gate_commands (single-line array) in
# setup_config. Empty → the field is omitted → the merge gate runs no quality step
# (prior behavior preserved for projects that do not opt in).
if [ ${#QG_CMDS[@]} -eq 0 ]; then
  QG_CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
  if [ -f "$QG_CONFIG" ]; then
    QG_LINE="$(sed -n 's/^[[:space:]]*merge_gate_commands[[:space:]]*=[[:space:]]*\[\(.*\)\].*$/\1/p' "$QG_CONFIG" | head -1)"
    if [ -n "$QG_LINE" ]; then
      while IFS= read -r _c; do
        [ -n "$_c" ] && QG_CMDS+=("$_c")
      done < <(printf '%s' "$QG_LINE" | grep -oE '"[^"]*"' | sed -e 's/^"//' -e 's/"$//' || true)
    fi
  fi
fi

# Verdict-to-report binding (DEC-088, C1/C2). The merge gate has a report-
# authoritative resolver + stale-sha guard (merge_gate_parse.ts), but they are
# DEAD on this canonical path unless the request carries guardian_report_path /
# guardian_required / guardian_review_sha. When a reviewer report is supplied we
# emit them so an asserted --guardian/--observer string can no longer pass a gate
# the report does not back. When [guardian_policy]/[observer_policy]
# require_report = true (opt-in, default false → inert), we REFUSE to write a
# report-less request at all — closing the "merge_request.sh --guardian PASS with
# no Guardian run" bypass at the canonical tool.
CONFIG_FILE="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
toml_in_section() {  # file section key -> first matching value (stripped), else empty
  [ -f "$1" ] || return 0
  awk -v section="$2" -v key="$3" '
    /^[[:space:]]*\[[^]]*\][[:space:]]*$/ { s=$0; gsub(/^[[:space:]]*\[|\][[:space:]]*$/,"",s); cur=s; next }
    cur==section && $0 ~ "^[[:space:]]*"key"[[:space:]]*=" {
      v=$0; sub(/^[^=]*=[[:space:]]*/,"",v); sub(/[[:space:]]*#.*$/,"",v); gsub(/[[:space:]"]+/,"",v); print v; exit }
  ' "$1"
}
GUARDIAN_REQUIRE_REPORT="$(toml_in_section "$CONFIG_FILE" guardian_policy require_report)"
OBSERVER_REQUIRE_REPORT="$(toml_in_section "$CONFIG_FILE" observer_policy require_report)"

if [ "$GUARDIAN_REQUIRE_REPORT" = "true" ] && [ -z "$GUARDIAN_REPORT" ]; then
  echo "merge_request: [guardian_policy] require_report = true but no --guardian-report <path> given — an asserted --guardian '$GUARDIAN' cannot bind to a real Guardian review. Run Guardian and pass its report path." >&2
  exit 2
fi
if [ "$OBSERVER_REQUIRE_REPORT" = "true" ] && [ -n "$OBSERVER" ] && [ -z "$OBSERVER_REPORT" ]; then
  echo "merge_request: [observer_policy] require_report = true but no --observer-report <path> given — an asserted --observer '$OBSERVER' cannot bind to a real Observer review." >&2
  exit 2
fi

# Default each bound review_sha to the workbench tip (the G-15 stale-verdict guard
# then enforces the Guardian reviewed THIS code, not an older commit).
if [ -n "$GUARDIAN_REPORT" ] && [ -z "$GUARDIAN_REVIEW_SHA" ]; then
  GUARDIAN_REVIEW_SHA="$(git -C "$GIT_ROOT" rev-parse --short "$BRANCH" 2>/dev/null || true)"
fi

# Minimal JSON string escaping (backslash, quote, newline).
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'NR>1{printf "\\n"} {printf "%s", $0} END{print ""}'; }

REQ_DIR="$PROJECT/__garelier/$PM/runtime/merge_gate/requests"
mkdir -p "$REQ_DIR"
REQ_FILE="$REQ_DIR/$REQ_ID.json"
{
  printf '{\n'
  printf '  "request_id": "%s",\n'        "$(esc "$REQ_ID")"
  printf '  "workbench_branch": "%s",\n'  "$(esc "$BRANCH")"
  printf '  "studio_branch": "%s",\n'     "$(esc "$STUDIO")"
  printf '  "target_root": "%s",\n'       "$(esc "$GIT_ROOT")"
  printf '  "task_id": "%s",\n'           "$(esc "$TASK")"
  printf '  "agent": "merge_request.sh",\n'
  printf '  "guardian_verdict": "%s",\n'  "$(esc "$GUARDIAN")"
  if [ -n "$GUARDIAN_REPORT" ]; then
    printf '  "guardian_required": true,\n'
    printf '  "guardian_report_path": "%s",\n' "$(esc "$GUARDIAN_REPORT")"
    [ -n "$GUARDIAN_REVIEW_SHA" ] && printf '  "guardian_review_sha": "%s",\n' "$(esc "$GUARDIAN_REVIEW_SHA")"
  fi
  [ "$GUARDIAN_REQUIRE_REPORT" = "true" ] && printf '  "guardian_require_report": true,\n'
  if [ -n "$OBSERVER" ]; then
    printf '  "observer_verdict": "%s",\n' "$(esc "$OBSERVER")"
    if [ -n "$OBSERVER_REPORT" ]; then
      printf '  "observer_required": true,\n'
      printf '  "observer_report_path": "%s",\n' "$(esc "$OBSERVER_REPORT")"
    fi
    [ "$OBSERVER_REQUIRE_REPORT" = "true" ] && printf '  "observer_require_report": true,\n'
  fi
  if [ ${#QG_CMDS[@]} -gt 0 ]; then
    printf '  "quality_gate_commands": ['
    for _i in "${!QG_CMDS[@]}"; do
      [ "$_i" -gt 0 ] && printf ', '
      printf '"%s"' "$(esc "${QG_CMDS[$_i]}")"
    done
    printf '],\n'
  fi
  printf '  "merge_message": "%s"\n'      "$(esc "$MESSAGE")"
  printf '}\n'
} > "$REQ_FILE"
echo "merge_request: wrote $REQ_FILE" >&2

if [ "$NO_POLL" -eq 1 ]; then
  printf '{"request_id":"%s","request_file":"%s","polled":false}\n' "$REQ_ID" "$REQ_FILE"
  exit 0
fi

# Locate garelier-core (for dock_merge.ts): --core, else relative to this script.
if [ -z "$CORE" ]; then
  CORE="$(cd "$(dirname "$0")/.." && pwd)"
fi
exec bun "$CORE/driver/src/dispatch/dock_merge.ts" poll --pm-id "$PM" --project "$PROJECT"
