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
#   preflight       ← --preflight flags (optional, repeatable; W-023). Lightweight
#                     checks the merge gate runs right after the merge and BEFORE
#                     the (potentially expensive) quality gate, so a cheap,
#                     deterministic problem fails in seconds instead of at the end
#                     of a multi-minute compile/test run. Example for a Rust
#                     project: `--preflight 'cargo metadata --locked --offline'`
#                     catches a stale Cargo.lock without compiling anything.
#                     No --preflight flag falls back to [merge_gate]
#                     preflight_commands (single-line array) in setup_config
#                     (W-033 — this is how the jig merge paths opt in). Absent in
#                     both places → no preflight step (behavior identical to before).
# Writes runtime/merge_gate/requests/<id>.json and (unless --no-poll) runs the
# zero-LLM dock_merge.ts poll so the gate subprocess starts immediately.
#
# --notify (W-079): the merge gate is async and in ATTENDED mode nothing watches
# results/, so a finished (or conflict-failed) gate goes unnoticed. With --notify
# this prints the exact `gate_result_waiter.sh` command for THIS request on stderr
# — the PM runs it via run_in_background and gets pushed the outcome when the gate
# terminates (the harness re-wakes on background completion). Default (no flag) is
# unchanged: driver mode's poll loop already drives the result, so no waiter is
# needed there.
#
# Usage:
#   merge_request.sh --project <control-root> --pm-id <id> --branch <workbench-branch>
#                    --guardian <PASS|PASS_WITH_NOTES> [--observer <verdict>]
#                    [--task <label>] [--message <msg>] [--studio <branch>]
#                    [--preflight <cmd>]... [--quality-gate <cmd>]...
#                    [--target-root <git-root>] [--core <garelier-core-dir>]
#                    [--refuter-verdict <UPHELD|REFUTED>] [--refuter-report <path>] [--high-stakes]
#                    [--notify] [--no-poll]
#
# Refuter (W-066): the opt-in adversarial-verify layer on top of the Observer
# verdict, for HIGH-STAKES merges only. --refuter-verdict carries an independent
# refuter agent's UPHELD/REFUTED (a REFUTED holds the merge for PM escalation;
# see merge-gate.sh). --high-stakes marks a merge high-stakes for a semantic
# trigger the gate cannot see from the diff (migration / public API / auth) so
# the gate warns (advisory) if it lands without a refuter verdict. Both are
# optional and default-off — a merge with neither behaves exactly as before.
set -euo pipefail

PROJECT="" TARGET_ROOT="" PM="" BRANCH="" TASK="" GUARDIAN="" OBSERVER="" MESSAGE="" STUDIO="" CORE="" NO_POLL=0 NOTIFY=0
GUARDIAN_REPORT="" OBSERVER_REPORT="" GUARDIAN_REVIEW_SHA="" OBSERVER_REVIEW_SHA=""
REFUTER_VERDICT="" REFUTER_REPORT="" HIGH_STAKES=0
QG_CMDS=()
PREFLIGHT_CMDS=()
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
    --observer-review-sha) OBSERVER_REVIEW_SHA="${2:?}"; shift 2 ;;
    --message)  MESSAGE="${2:?}"; shift 2 ;;
    --studio)   STUDIO="${2:?}"; shift 2 ;;
    --core)     CORE="${2:?}"; shift 2 ;;
    --quality-gate) QG_CMDS+=("${2:?}"); shift 2 ;;
    --preflight) PREFLIGHT_CMDS+=("${2:?}"); shift 2 ;;
    --refuter-verdict) REFUTER_VERDICT="${2:?}"; shift 2 ;;
    --refuter-report)  REFUTER_REPORT="${2:?}"; shift 2 ;;
    --high-stakes) HIGH_STAKES=1; shift ;;
    --notify)   NOTIFY=1; shift ;;
    --no-poll)  NO_POLL=1; shift ;;
    -h|--help)  sed -n '2,49p' "$0"; exit 0 ;;
    *) echo "merge_request: unknown arg: $1" >&2
       echo "merge_request: valid flags: --project --target-root --pm-id --branch --task --guardian --observer --guardian-report --observer-report --guardian-review-sha --observer-review-sha --message --studio --core --quality-gate --preflight --refuter-verdict --refuter-report --high-stakes --notify --no-poll -h/--help" >&2
       exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] && [ -n "$BRANCH" ] || {
  echo "merge_request: --project, --pm-id, --branch are required" >&2; exit 2; }
GIT_ROOT="${TARGET_ROOT:-$PROJECT}"
[ -n "$GUARDIAN" ] || {
  echo "merge_request: --guardian <verdict> is required ([guardian_policy] require_for_all_merges rejects requests without it)" >&2; exit 2; }

# W-066: the refuter verdict is a two-value enum. Reject a typo at the tool so a
# malformed --refuter-verdict never reaches the gate (which would treat an
# unknown token as "absent" and silently drop the REFUTED hold).
if [ -n "$REFUTER_VERDICT" ]; then
  case "$REFUTER_VERDICT" in
    UPHELD|REFUTED) ;;
    *) echo "merge_request: --refuter-verdict must be UPHELD or REFUTED (got '$REFUTER_VERDICT')" >&2; exit 2 ;;
  esac
fi

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

# waiter_cmd (W-086): a ready-to-run gate_result_waiter one-liner for THIS request,
# emitted in the JSON output REGARDLESS of --notify so the PM/jig arms the waiter
# verbatim right after submitting — the recurring omission that let post-merge
# aftercare (cleanup / next-merge drain / follow-up) stall until a user prod
# (2026-07-06, 4 merges backed up). Same shape as dispatch_prepare's watch_cmd; the
# --notify stderr hint below stays, but this field is canonical. Paths are double-
# quoted (spaces survive) and JSON-escaped for the emitted string. The detective twin
# is contract_check --stall-scan UNPROCESSED-RESULT.
WAITER_SCRIPT="$(cd "$(dirname "$0")" && pwd)/gate_result_waiter.sh"
WAITER_CMD="bash \"$WAITER_SCRIPT\" --project \"$PROJECT\" --pm-id $PM --request-id $REQ_ID"
WAITER_CMD_JSON="${WAITER_CMD//\"/\\\"}"

if [ -z "$MESSAGE" ]; then
  # commit_convention.md § Garelier marker: every Garelier-produced commit ends
  # with a `Garelier:` trailer. The studio merge commit keeps its `merge <task>
  # into studio` subject and adds `Garelier: <pm_id> merge <branch-tail>` (the
  # merged branch's `<family>/#<id>/<slug>` tail as the bound item). Blank line
  # before it so git parses it as a trailer, not body prose.
  BRANCH_TAIL="$(printf '%s' "$BRANCH" | awk -F/ 'NF>=3{print $(NF-2)"/"$(NF-1)"/"$NF; next}{print}')"
  MESSAGE="merge $TASK into studio"$'\n\n'"Guardian $GUARDIAN${OBSERVER:+; Observer $OBSERVER}."$'\n\n'"Garelier: $PM merge $BRANCH_TAIL"
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

# Preflight commands (W-023) fall back to [merge_gate] preflight_commands (single-
# line array) in setup_config, mirroring the quality-gate fallback above. This is
# how the JIG merge paths pick up preflight without threading the flag per call:
# the main tick merges via dock_integrate.ts (which calls THIS script) and the
# Smith window merges it directly — both source the same config key here (W-033).
# Explicit --preflight flags win. Empty → the "preflight" field is omitted → the
# merge gate runs no preflight step (identical to before this fallback existed).
if [ ${#PREFLIGHT_CMDS[@]} -eq 0 ]; then
  PF_CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
  if [ -f "$PF_CONFIG" ]; then
    PF_LINE="$(sed -n 's/^[[:space:]]*preflight_commands[[:space:]]*=[[:space:]]*\[\(.*\)\].*$/\1/p' "$PF_CONFIG" | head -1)"
    if [ -n "$PF_LINE" ]; then
      while IFS= read -r _c; do
        [ -n "$_c" ] && PREFLIGHT_CMDS+=("$_c")
      done < <(printf '%s' "$PF_LINE" | grep -oE '"[^"]*"' | sed -e 's/^"//' -e 's/"$//' || true)
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

# Default each bound review_sha to the workbench tip (the stale-verdict guard
# then enforces the reviewer saw THIS code, not an older commit). Guardian: G-15
# (W-035); Observer: the symmetric W-062 guard.
if [ -n "$GUARDIAN_REPORT" ] && [ -z "$GUARDIAN_REVIEW_SHA" ]; then
  GUARDIAN_REVIEW_SHA="$(git -C "$GIT_ROOT" rev-parse --short "$BRANCH" 2>/dev/null || true)"
fi
if [ -n "$OBSERVER_REPORT" ] && [ -z "$OBSERVER_REVIEW_SHA" ]; then
  OBSERVER_REVIEW_SHA="$(git -C "$GIT_ROOT" rev-parse --short "$BRANCH" 2>/dev/null || true)"
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
      [ -n "$OBSERVER_REVIEW_SHA" ] && printf '  "observer_review_sha": "%s",\n' "$(esc "$OBSERVER_REVIEW_SHA")"
    fi
    [ "$OBSERVER_REQUIRE_REPORT" = "true" ] && printf '  "observer_require_report": true,\n'
  fi
  # W-066 refuter fields. All optional and independent: refuter_report_path can be
  # given without a --refuter-verdict string (the gate reads the verdict from the
  # report), and --high-stakes stands alone (marks the merge high-stakes so the
  # gate warns if it lands without a refuter verdict). Emitted only when set, so a
  # request with none of the three is byte-identical to a pre-W-066 request.
  [ -n "$REFUTER_VERDICT" ] && printf '  "refuter_verdict": "%s",\n' "$(esc "$REFUTER_VERDICT")"
  [ -n "$REFUTER_REPORT" ] && printf '  "refuter_report_path": "%s",\n' "$(esc "$REFUTER_REPORT")"
  [ "$HIGH_STAKES" -eq 1 ] && printf '  "high_stakes": true,\n'
  if [ ${#PREFLIGHT_CMDS[@]} -gt 0 ]; then
    printf '  "preflight": ['
    for _i in "${!PREFLIGHT_CMDS[@]}"; do
      [ "$_i" -gt 0 ] && printf ', '
      printf '"%s"' "$(esc "${PREFLIGHT_CMDS[$_i]}")"
    done
    printf '],\n'
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

# Attended push notification (W-079). Print the exact waiter command for THIS
# request so the PM can run it via run_in_background and be woken when the gate
# terminates. gate_result_waiter.sh is a sibling of this script; emit before any
# early exit so --notify works with --no-poll too. Default (no --notify) prints
# nothing — driver mode already drives the result via its poll loop.
if [ "$NOTIFY" -eq 1 ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  echo "merge_request: --notify — run this in the background to be pushed the gate result:" >&2
  echo "  bash $SCRIPT_DIR/gate_result_waiter.sh --project $PROJECT --pm-id $PM --request-id $REQ_ID" >&2
fi

if [ "$NO_POLL" -eq 1 ]; then
  printf '{"request_id":"%s","request_file":"%s","polled":false,"waiter_cmd":"%s"}\n' "$REQ_ID" "$REQ_FILE" "$WAITER_CMD_JSON"
  exit 0
fi

# Locate garelier-core (for dock_merge.ts): --core, else relative to this script.
if [ -z "$CORE" ]; then
  CORE="$(cd "$(dirname "$0")/.." && pwd)"
fi

# Run the zero-LLM poll. If the single gate slot is free it spawns THIS request's
# gate immediately; if another gate is already active, poll spawns nothing and
# this request stays queued. Capture (rather than exec) so we can print an
# accurate disposition on stderr AFTER poll — the machine-readable poll JSON is
# still emitted on stdout unchanged for any caller that parses it.
set +e
POLL_OUT="$(bun "$CORE/driver/src/dispatch/dock_merge.ts" poll --pm-id "$PM" --project "$PROJECT")"
POLL_RC=$?
set -e

# Disposition hint. The merge gate self-drains its queue on completion (W-039),
# so a request left queued behind an active gate IS processed automatically once
# that gate finishes — state that plainly instead of leaving the operator to
# guess whether a manual poll is still needed. `spawned` / `active.request_id`
# come straight from the poll JSON.
DISPO="$(printf '%s' "$POLL_OUT" | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write((j.spawned??"")+"\t"+((j.active&&j.active.request_id)||""))}catch{}})' 2>/dev/null || true)"
SPAWNED="${DISPO%%$'\t'*}"
ACTIVE_ID="${DISPO#*$'\t'}"
[ "$ACTIVE_ID" = "$DISPO" ] && ACTIVE_ID=""   # no tab -> parse failed, no active id
if [ -n "$SPAWNED" ] && [ "$SPAWNED" = "$REQ_ID" ]; then
  echo "merge_request: gate started immediately for $REQ_ID." >&2
elif [ -n "$SPAWNED" ]; then
  echo "merge_request: gate started for $SPAWNED; $REQ_ID is queued and will be processed automatically when the active gate completes (self-drain, W-039)." >&2
elif [ -n "$ACTIVE_ID" ]; then
  echo "merge_request: $REQ_ID queued behind active gate $ACTIVE_ID; it will be processed automatically when that gate completes (self-drain, W-039)." >&2
else
  echo "merge_request: $REQ_ID submitted; no gate spawned (already resolved or queue empty). Run 'dock_merge.ts poll' if this is unexpected." >&2
fi
# W-086: splice waiter_cmd into the poll JSON so the field is present on the default
# (poll) path too, not only --no-poll. Best-effort: an unparseable POLL_OUT (bun
# absent / not a JSON object) falls back to emitting it unchanged (the --notify hint
# still carries the waiter command in that case).
POLL_OUT_WITH_WAITER="$(printf '%s' "$POLL_OUT" | GARELIER_WAITER_CMD="$WAITER_CMD" bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);o.waiter_cmd=process.env.GARELIER_WAITER_CMD;process.stdout.write(JSON.stringify(o));}catch{process.stdout.write("");}})' 2>/dev/null || true)"
if [ -n "$POLL_OUT_WITH_WAITER" ]; then
  printf '%s\n' "$POLL_OUT_WITH_WAITER"
else
  printf '%s\n' "$POLL_OUT"
fi
exit "$POLL_RC"
