#!/usr/bin/env bash
#
# runtime_recovery_hook.test.sh — pins the W-035 runtime recovery hook.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SELF_DIR/runtime_recovery_hook.ts"
[ -f "$HOOK" ] || { echo "runtime_recovery_hook.test: hook missing" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "runtime_recovery_hook.test: bun not on PATH" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $*" >&2; exit 1; }

OUT="" RC=0
fire() {
  set +e
  OUT="$(printf '%s' "$1" | bun "$HOOK" 2>&1)"
  RC=$?
  set -e
}

incident_file() { printf '%s/.claude/runtime/garelier/incidents.jsonl' "$1"; }
state_file() { printf '%s/.claude/runtime/garelier/state.json' "$1"; }
hook_cwd() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s' "$1"
  fi
}

case_dir() { mkdir -p "$TMP/$1"; printf '%s/%s' "$TMP" "$1"; }

# 1. PostToolUseFailure creates an incident and injects recovery context.
D1="$(case_dir failure)"
C1="$(hook_cwd "$D1")"
fire '{"hook_event_name":"PostToolUseFailure","session_id":"s1","cwd":"'"$C1"'","agent_id":"a1","agent_type":"worker","tool_name":"Bash","tool_input":{"command":"bun test"},"exit_code":124,"error_message":"Command timed out after 120000ms"}'
[ "$RC" -eq 0 ] || fail "failure: expected exit 0, got $RC"
printf '%s' "$OUT" | grep -q 'GARELIER_RUNTIME_INCIDENT' || fail "failure: missing recovery context: $OUT"
[ -f "$(incident_file "$D1")" ] || fail "failure: incidents.jsonl not written"
grep -q '"kind":"bash_command_timeout"' "$(incident_file "$D1")" || fail "failure: timeout kind not recorded"
grep -q '"exit_code":124' "$(incident_file "$D1")" || fail "failure: exit_code not recorded"
grep -q '"error_message":"Command timed out after 120000ms"' "$(incident_file "$D1")" || fail "failure: error_message not recorded"
grep -q '"a1"' "$(state_file "$D1")" || fail "failure: state missing agent_id key"

# 2. PostToolUse output spill is detected but framed as not a command failure.
D2="$(case_dir spill)"
C2="$(hook_cwd "$D2")"
fire '{"hook_event_name":"PostToolUse","session_id":"s2","cwd":"'"$C2"'","agent_id":"a2","agent_type":"worker","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":{"text":"Output was truncated because it exceeded maximum output; full log saved to /tmp/build.log"}}'
[ "$RC" -eq 0 ] || fail "spill: expected exit 0, got $RC"
printf '%s' "$OUT" | grep -q 'not a command failure' || fail "spill: missing non-failure context: $OUT"
grep -q '"kind":"bash_output_spilled"' "$(incident_file "$D2")" || fail "spill: incident not recorded"

# 3. SubagentStop blocks first and second time for an open incident without ok marker.
D3="$(case_dir stop)"
C3="$(hook_cwd "$D3")"
fire '{"hook_event_name":"PostToolUseFailure","session_id":"s3","cwd":"'"$C3"'","agent_id":"a3","agent_type":"worker","tool_name":"PowerShell","tool_input":{"command":"bun test"},"exit_code":1,"error_message":"failed"}'
fire '{"hook_event_name":"SubagentStop","session_id":"s3","cwd":"'"$C3"'","agent_id":"a3","agent_type":"worker","last_assistant_message":"done but no marker"}'
printf '%s' "$OUT" | grep -q '"decision":"block"' || fail "stop #1: expected block: $OUT"
printf '%s' "$OUT" | grep -q 'GARELIER_RUNTIME_STATUS' || fail "stop #1: missing marker instruction"
fire '{"hook_event_name":"SubagentStop","session_id":"s3","cwd":"'"$C3"'","agent_id":"a3","agent_type":"worker","last_assistant_message":"still no marker"}'
printf '%s' "$OUT" | grep -q '"decision":"block"' || fail "stop #2: expected block: $OUT"

# 4. Third SubagentStop escalates to PM instead of blocking again.
fire '{"hook_event_name":"SubagentStop","session_id":"s3","cwd":"'"$C3"'","agent_id":"a3","agent_type":"worker","last_assistant_message":"still no marker"}'
printf '%s' "$OUT" | grep -q 'GARELIER_PM_ESCALATION' || fail "stop #3: missing PM escalation: $OUT"
printf '%s' "$OUT" | grep -vq '"decision":"block"' || fail "stop #3: must not block: $OUT"

# 5. ok marker clears the open incident and passes silently.
D5="$(case_dir okmarker)"
C5="$(hook_cwd "$D5")"
fire '{"hook_event_name":"PostToolUseFailure","session_id":"s5","cwd":"'"$C5"'","agent_id":"a5","agent_type":"worker","tool_name":"Bash","tool_input":{"command":"cargo check"},"exit_code":1,"error_message":"failed"}'
fire '{"hook_event_name":"SubagentStop","session_id":"s5","cwd":"'"$C5"'","agent_id":"a5","agent_type":"worker","last_assistant_message":"recovered\nGARELIER_RUNTIME_STATUS: {\"runtime_ok\": true, \"incident_id\": \"x\"}"}'
[ -z "$OUT" ] || fail "ok marker: expected silent pass, got: $OUT"
grep -q '"open_by_agent_id": {}' "$(state_file "$D5")" || fail "ok marker: state not cleared"

# 6. Non-target event/tool exits silently.
D6="$(case_dir silent)"
C6="$(hook_cwd "$D6")"
fire '{"hook_event_name":"PostToolUseFailure","session_id":"s6","cwd":"'"$C6"'","agent_id":"a6","tool_name":"Write","tool_input":{"file_path":"x"},"exit_code":1,"error_message":"failed"}'
[ "$RC" -eq 0 ] || fail "silent: expected exit 0"
[ -z "$OUT" ] || fail "silent: expected no output, got: $OUT"
[ ! -e "$(incident_file "$D6")" ] || fail "silent: should not write incident"

# 7. Broken state is swallowed/reset, not fatal.
D7="$(case_dir broken)"
mkdir -p "$D7/.claude/runtime/garelier"
printf '{ broken json' > "$(state_file "$D7")"
C7="$(hook_cwd "$D7")"
fire '{"hook_event_name":"PostToolUseFailure","session_id":"s7","cwd":"'"$C7"'","agent_id":"a7","agent_type":"worker","tool_name":"Bash","tool_input":{"command":"make test"},"exit_code":1,"error_message":"failed"}'
[ "$RC" -eq 0 ] || fail "broken: expected exit 0"
printf '%s' "$OUT" | grep -q 'GARELIER_RUNTIME_INCIDENT' || fail "broken: missing context"
grep -q '"a7"' "$(state_file "$D7")" || fail "broken: state was not reset/recreated"

# 8. SubagentStop with no open incident still blocks when the
#    GARELIER_RUNTIME_STATUS marker is missing (W-038), then escalates on the 3rd call.
D8="$(case_dir marker_missing)"
C8="$(hook_cwd "$D8")"
fire '{"hook_event_name":"SubagentStop","session_id":"s8","cwd":"'"$C8"'","agent_id":"a8","agent_type":"worker","last_assistant_message":"all done, no status line"}'
printf '%s' "$OUT" | grep -q '"decision":"block"' || fail "marker missing #1: expected block: $OUT"
printf '%s' "$OUT" | grep -q 'GARELIER_RUNTIME_STATUS' || fail "marker missing #1: missing marker instruction"
fire '{"hook_event_name":"SubagentStop","session_id":"s8","cwd":"'"$C8"'","agent_id":"a8","agent_type":"worker","last_assistant_message":"still no status line"}'
printf '%s' "$OUT" | grep -q '"decision":"block"' || fail "marker missing #2: expected block: $OUT"
fire '{"hook_event_name":"SubagentStop","session_id":"s8","cwd":"'"$C8"'","agent_id":"a8","agent_type":"worker","last_assistant_message":"still no status line"}'
printf '%s' "$OUT" | grep -q 'GARELIER_PM_ESCALATION' || fail "marker missing #3: missing PM escalation: $OUT"
printf '%s' "$OUT" | grep -vq '"decision":"block"' || fail "marker missing #3: must not block: $OUT"

# 9. SubagentStop with no open incident and a present marker passes silently,
#    regardless of the runtime_ok boolean value (presence-only check).
D9="$(case_dir marker_present)"
C9="$(hook_cwd "$D9")"
fire '{"hook_event_name":"SubagentStop","session_id":"s9","cwd":"'"$C9"'","agent_id":"a9","agent_type":"worker","last_assistant_message":"finished\nGARELIER_RUNTIME_STATUS: {\"runtime_ok\": false}"}'
[ -z "$OUT" ] || fail "marker present: expected silent pass, got: $OUT"
[ ! -e "$(state_file "$D9")" ] || fail "marker present: should not create a state entry"

# 10. W-047: a cwd nested under __garelier/<pm_id>/... redirects the incident
#     write to the already-gitignored __garelier/<pm_id>/runtime/hooks/ tree
#     instead of dropping an untracked .claude/runtime/garelier/ under the
#     dispatch checkout itself.
D10="$(case_dir proj10)"
DISPATCH_CWD="$D10/__garelier/acme/_dispatch7/checkout"
mkdir -p "$D10/__garelier/acme" "$DISPATCH_CWD"
C10="$(hook_cwd "$DISPATCH_CWD")"
fire '{"hook_event_name":"PostToolUseFailure","session_id":"s10","cwd":"'"$C10"'","agent_id":"a10","agent_type":"worker","tool_name":"Bash","tool_input":{"command":"bun test"},"exit_code":1,"error_message":"failed"}'
[ "$RC" -eq 0 ] || fail "redirect: expected exit 0, got $RC"
[ -f "$D10/__garelier/acme/runtime/hooks/incidents.jsonl" ] || fail "redirect: incidents.jsonl not written under __garelier/<pm_id>/runtime/hooks/"
[ ! -e "$DISPATCH_CWD/.claude/runtime/garelier/incidents.jsonl" ] || fail "redirect: legacy .claude/runtime/garelier/ still written under the dispatch checkout"
printf '%s' "$OUT" | grep -q "hooks" || fail "redirect: recovery context does not mention the redirected runtime/hooks dir: $OUT"
printf '%s' "$OUT" | grep -q "incidents.jsonl" || fail "redirect: recovery context does not point at incidents.jsonl: $OUT"

echo "runtime_recovery_hook.test: OK (failure incident / spill / stop blocks / escalation / ok marker / silent / broken state / marker-missing block / marker-present pass / __garelier redirect)"
