#!/usr/bin/env bash
#
# gate_result_waiter.test.sh — pins gate_result_waiter.sh's branches (W-079).
#
# Fakes a merge_gate results/ tree and asserts:
#   1. success result already present -> MERGE_RESULT: success + studio_commit, exit 0.
#   2. failed result                  -> MERGE_RESULT: failed + failure_reason, exit 1.
#   3. conflict result                -> exit 1 (any non-success terminal is exit 1).
#   4. result appears DURING the wait -> the poll loop catches it, exit 0.
#   5. no result within --max-wait    -> MERGE_TIMEOUT, exit 124.
#   6. bad args (missing --request-id)-> exit 2.
#
# Self-contained: run directly (`bash gate_result_waiter.test.sh`) or from ci.sh.
# Exits 0 only if every branch holds.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
WAITER="$SELF_DIR/gate_result_waiter.sh"
[ -f "$WAITER" ] || { echo "gate_result_waiter.test: cannot find gate_result_waiter.sh next to me" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }

PM="tpm"
RES="$TMP/__garelier/$PM/runtime/merge_gate/results"
mkdir -p "$RES"

# Write a realistic result file (subset of merge-gate.sh write_result output) for
# <request_id>, atomic like the gate (.tmp + mv), so json_str_field is exercised
# against the real pretty-printed shape.
write_result() {  # request_id status studio_commit failure_reason
  local rid="$1" status="$2" commit="$3" reason="$4"
  local f="$RES/$rid.json"
  {
    printf '{\n'
    printf '  "request_id": "%s",\n' "$rid"
    printf '  "status": "%s",\n' "$status"
    if [ -n "$commit" ]; then printf '  "studio_commit": "%s",\n' "$commit"; else printf '  "studio_commit": null,\n'; fi
    printf '  "started_at": "2026-07-05T00:00:00Z",\n'
    printf '  "ended_at": "2026-07-05T00:01:00Z",\n'
    if [ -n "$reason" ]; then printf '  "failure_reason": "%s",\n' "$reason"; else printf '  "failure_reason": null,\n'; fi
    printf '  "conflict_files": null,\n'
    printf '  "pre_merge_target_advanced": false\n'
    printf '}\n'
  } > "$f.tmp"
  mv -f "$f.tmp" "$f"
}

run() {  # request_id extra-args... -> sets OUT/RC
  set +e
  OUT="$(bash "$WAITER" --project "$TMP" --pm-id "$PM" --request-id "$1" "${@:2}")"
  RC=$?
  set -e
}

(
  set -e

  # === 1. success present -> MERGE_RESULT success + commit, exit 0 ============
  write_result "20260705-000000-s" success "abc1234" ""
  run "20260705-000000-s" --max-wait 5 --poll-interval 1
  [ "$RC" -eq 0 ] || fail "success exit was $RC (expected 0)"
  echo "$OUT" | grep -qx "MERGE_RESULT: success 20260705-000000-s abc1234" \
    || fail "success line wrong: $OUT"

  # === 2. failed present -> MERGE_RESULT failed + reason, exit 1 ==============
  write_result "20260705-000000-f" failed "" "git merge failed (no conflict markers); see log"
  run "20260705-000000-f" --max-wait 5 --poll-interval 1
  [ "$RC" -eq 1 ] || fail "failed exit was $RC (expected 1)"
  echo "$OUT" | grep -q "^MERGE_RESULT: failed 20260705-000000-f " || fail "failed line wrong: $OUT"
  echo "$OUT" | grep -q "no conflict markers" || fail "failed line dropped failure_reason: $OUT"

  # === 3. conflict present -> exit 1 (non-success terminal) ===================
  write_result "20260705-000000-c" conflict "" "merge produced 2 conflicted files"
  run "20260705-000000-c" --max-wait 5 --poll-interval 1
  [ "$RC" -eq 1 ] || fail "conflict exit was $RC (expected 1)"
  echo "$OUT" | grep -q "^MERGE_RESULT: conflict 20260705-000000-c " || fail "conflict line wrong: $OUT"

  # === 4. result appears DURING the wait -> poll loop catches it, exit 0 =====
  ( sleep 1; write_result "20260705-000000-race" success "def5678" "" ) &
  WRITER=$!
  run "20260705-000000-race" --max-wait 10 --poll-interval 1
  wait "$WRITER" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "mid-wait exit was $RC (expected 0)"
  echo "$OUT" | grep -qx "MERGE_RESULT: success 20260705-000000-race def5678" \
    || fail "mid-wait line wrong: $OUT"

  # === 5. no result within --max-wait -> MERGE_TIMEOUT, exit 124 =============
  run "20260705-000000-never" --max-wait 1 --poll-interval 1
  [ "$RC" -eq 124 ] || fail "timeout exit was $RC (expected 124)"
  echo "$OUT" | grep -q "^MERGE_TIMEOUT: 20260705-000000-never waited 1s" \
    || fail "timeout line wrong: $OUT"

  # === 6. bad args (missing --request-id) -> exit 2 ==========================
  set +e
  bash "$WAITER" --project "$TMP" --pm-id "$PM" >/dev/null 2>"$TMP/err6"
  RC6=$?
  set -e
  [ "$RC6" -eq 2 ] || fail "missing --request-id exit was $RC6 (expected 2)"
  grep -q "required" "$TMP/err6" || fail "missing-arg message absent"
) || exit 1

echo "gate_result_waiter.test: all branches pass (success / failed / conflict / mid-wait / timeout / bad-args)"
