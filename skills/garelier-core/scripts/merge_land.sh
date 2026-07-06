#!/usr/bin/env bash
#
# merge_land.sh — one background command for the whole PM merge ritual (W-088).
#
# The attended merge landing was FOUR separate touches the PM had to remember and
# sequence by hand: submit (merge_request.sh) -> arm the result waiter
# (gate_result_waiter.sh) -> on success clean up the dispatch (dispatch_cleanup.sh)
# -> pull. A missed waiter left the aftercare stalled (W-086); a mis-ordered
# cleanup raced the gate (W-055/W-044 guards). This macro collapses the four into
# ONE call the PM runs with run_in_background: it submits, BLOCK-waits for the gate
# result itself (blocking is fine — the PM backgrounded it), and only on a landed
# merge does it clean up + pull. On a failed/aborted/timed-out gate it cleans up
# NOTHING (the branch's work must survive) and returns the failure.
#
# It is a thin composition of the existing, individually-tested scripts — it adds
# no merge/gate logic of its own and never touches the backlog (PM-owned) or the
# merge-gate lock/queue (the gate self-drains, W-039). The gate spawn is the
# W-087-detached path, so the submit returns in seconds and the gate runs
# independently even if THIS process is later killed.
#
# Usage:
#   merge_land.sh --project <control-root> --pm-id <id> --branch <workbench-branch>
#                 --guardian <PASS|PASS_WITH_NOTES> [--observer <verdict>]
#                 [--dispatch-id <N>] [--no-pull]
#                 [--close-row <item-id> …] [--backlog-path <path>] [--close-trailer <line>]
#                 [--max-wait <seconds>] [--poll-interval <seconds>]
#                 [ …any other merge_request.sh flag… ]
#
# Every flag this script does not consume itself is forwarded VERBATIM to
# merge_request.sh (--task, --message, --studio, --guardian-report, --quality-gate,
# --preflight, --refuter-verdict, --high-stakes, --core, --target-root, …), so the
# macro tracks merge_request's surface without re-declaring it. --dispatch-id names
# the dispatch container to clean up on success; omitted, it is derived from the
# branch's `#<N>/` segment. --no-pull skips the final `git pull --ff-only` (for
# local-only setups with no upstream). --max-wait / --poll-interval tune the result
# wait (defaults come from gate_result_waiter.sh: gate ceiling + margin / 30s).
#
# --close-row <item-id> (repeatable, W-093): on a LANDED merge, after cleanup+pull,
# strike the matching `| <item-id> |` row(s) from the project backlog and commit
# `chore(dashboard): <ids> close (merged <studio_commit>)`. This folds the PM's last
# manual touch — closing the row — into the same background command, without the
# lock-race stash dance. It is a SUCCESS-only step (a failed/aborted/timed-out gate
# never reaches it, so a failure never edits the backlog). Guarded by the merge-gate
# lock: if a NEXT gate has self-drained and is active, the row close is DEFERRED
# (the merge already landed — deferring costs the PM one manual strike, never data).
# --backlog-path overrides the default backlog location
# (<project>/__garelier/<pm_id>/control/project_dashboard/backlog.md). --close-trailer
# appends a verbatim git trailer line to the close commit (e.g. a project-specific
# `Garelier: <pm_id> pm-direct <epic>`); omitted, the commit carries no trailer.
#
# Output (stdout, one JSON line):
#   success  -> {"request_id","status":"success","studio_commit",
#                "dispatch_id","branch_deleted","cleanup_status","pulled"
#                [,"row_close":"closed|not-found|deferred (gate active)|…"]}  exit 0
#   failure  -> {"request_id","status":"<failed|conflict|aborted|timeout>",
#                "failure_reason","cleaned_up":false}                       exit 1|124
# Progress + each sub-step's own stderr stream through to stderr.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

# Minimal JSON string escaping (backslash + double-quote) — paths / reasons may
# carry `C:\…` or quotes; mirrors merge_request.sh / dispatch_cleanup.sh.
json_escape() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

MR_ARGS=()
PROJECT="" PM="" BRANCH="" TARGET_ROOT="" DISPATCH_ID="" NO_PULL=0 MAX_WAIT="" POLL_INTERVAL=""
CLOSE_ROWS=() BACKLOG_PATH_OVERRIDE="" CLOSE_TRAILER=""
while [ $# -gt 0 ]; do
  case "$1" in
    # Flags this macro needs AND merge_request also takes: capture + forward.
    --project)      PROJECT="${2:?}";     MR_ARGS+=("$1" "$2"); shift 2 ;;
    --pm-id)        PM="${2:?}";          MR_ARGS+=("$1" "$2"); shift 2 ;;
    --branch)       BRANCH="${2:?}";      MR_ARGS+=("$1" "$2"); shift 2 ;;
    --target-root)  TARGET_ROOT="${2:?}"; MR_ARGS+=("$1" "$2"); shift 2 ;;
    # Macro-only flags: consume, do NOT forward.
    --dispatch-id)  DISPATCH_ID="${2:?}"; shift 2 ;;
    --no-pull)      NO_PULL=1; shift ;;
    --close-row)    CLOSE_ROWS+=("${2:?}"); shift 2 ;;
    --backlog-path) BACKLOG_PATH_OVERRIDE="${2:?}"; shift 2 ;;
    --close-trailer) CLOSE_TRAILER="${2:?}"; shift 2 ;;
    --max-wait)     MAX_WAIT="${2:?}"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="${2:?}"; shift 2 ;;
    -h|--help)      sed -n '2,57p' "$0"; exit 0 ;;
    # Everything else (verdicts, quality-gate, message, …) forwards verbatim.
    *)              MR_ARGS+=("$1"); shift ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] && [ -n "$BRANCH" ] || {
  echo "merge_land: --project, --pm-id, --branch are required" >&2; exit 2; }
GIT_ROOT="${TARGET_ROOT:-$PROJECT}"

# Dispatch id for cleanup: explicit --dispatch-id, else the branch's `#<N>/` segment.
# NB: `|` (not `#`) is the sed delimiter — the branch itself contains `#<N>/`.
if [ -z "$DISPATCH_ID" ]; then
  DISPATCH_ID="$(printf '%s' "$BRANCH" | sed -n 's|.*#\([0-9][0-9]*\)/.*|\1|p')"
fi

# --- 1. Submit WITHOUT poll. merge_request then emits its OWN clean one-line JSON
# ({request_id, request_file, polled:false, waiter_cmd}); the poll path instead
# prints dock_merge's output, which prepends a log line to the JSON and so cannot
# be parsed for our request_id. We take the clean request_id here and spawn the
# gate ourselves in step 2. -------------------------------------------------------
MR_ERR="$(mktemp)"; trap 'rm -f "$MR_ERR"' EXIT
set +e
MR_OUT="$(bash "$SELF_DIR/merge_request.sh" --no-poll "${MR_ARGS[@]}" 2>"$MR_ERR")"
MR_RC=$?
set -e
cat "$MR_ERR" >&2
REQ_ID="$(printf '%s' "$MR_OUT" | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.request_id||"");}catch{}})' 2>/dev/null || true)"
if [ -z "$REQ_ID" ]; then
  echo "merge_land: submit produced no request_id (merge_request rc=$MR_RC); no request was created — aborting." >&2
  exit 1
fi

# --- 2. Spawn the gate via a poll (W-087-detached: it runs independently even if
# THIS process is later killed). dock_merge mixes a log line into its stdout, so we
# IGNORE its output — the request_id from step 1 is authoritative. Best-effort: if a
# driver poll loop already spawned the gate, the single active.lock serializes and
# this is a harmless no-op; a queued request self-drains (W-039). ------------------
DOCK_MERGE_TS="$(cd "$SELF_DIR/../driver/src/dispatch" 2>/dev/null && pwd -P)/dock_merge.ts"
if [ -f "$DOCK_MERGE_TS" ]; then
  bun "$DOCK_MERGE_TS" poll --pm-id "$PM" --project "$PROJECT" >/dev/null 2>&1 || true
else
  echo "merge_land: dock_merge.ts not found at $DOCK_MERGE_TS; relying on an external poller to spawn the gate for $REQ_ID." >&2
fi
echo "merge_land: submitted $REQ_ID; waiting for the gate result…" >&2

# --- 2. Block-wait for the gate result (this process was backgrounded by the PM, so
# blocking here is intended). gate_result_waiter watches ONLY this request_id and
# never touches the gate queue/lock (self-drain safe, W-039). ---------------------
WAIT_ARGS=(--project "$PROJECT" --pm-id "$PM" --request-id "$REQ_ID")
[ -n "$MAX_WAIT" ]      && WAIT_ARGS+=(--max-wait "$MAX_WAIT")
[ -n "$POLL_INTERVAL" ] && WAIT_ARGS+=(--poll-interval "$POLL_INTERVAL")
set +e
WAIT_OUT="$(bash "$SELF_DIR/gate_result_waiter.sh" "${WAIT_ARGS[@]}")"
WAIT_RC=$?
set -e
echo "$WAIT_OUT" >&2

# gate_result_waiter prints `MERGE_RESULT: <status> <req_id> <detail>` (exit 0
# success / 1 non-success / 124 timeout) or `MERGE_TIMEOUT: …` on 124.
STATUS="$(printf '%s' "$WAIT_OUT" | sed -n 's/^MERGE_RESULT: \([^ ][^ ]*\) .*/\1/p')"
DETAIL="$(printf '%s' "$WAIT_OUT" | sed -n 's/^MERGE_RESULT: [^ ][^ ]* [^ ][^ ]* \(.*\)$/\1/p')"

# --- 3. NON-success: clean up NOTHING (the branch's work must survive), report. ---
if [ "$WAIT_RC" -ne 0 ]; then
  [ -n "$STATUS" ] || STATUS="$([ "$WAIT_RC" -eq 124 ] && echo timeout || echo failed)"
  [ -n "$DETAIL" ] || DETAIL="$(printf '%s' "$WAIT_OUT" | sed -n 's/^MERGE_TIMEOUT: \(.*\)$/\1/p')"
  printf '{"request_id":"%s","status":"%s","failure_reason":"%s","cleaned_up":false}\n' \
    "$(json_escape "$REQ_ID")" "$(json_escape "${STATUS:-failed}")" "$(json_escape "$DETAIL")"
  exit "$WAIT_RC"
fi

# The gate writes its success RESULT just BEFORE it releases active.lock
# (clear_lock_if_mine runs after write_result), so the waiter can observe success
# while OUR OWN lock is still held for a few ms. Cleanup's W-055 guard would then
# refuse (it sees active.lock referencing our slug) and cleanup would be skipped
# even though the merge landed — the exact race under load. Briefly wait for OUR
# lock to clear before cleanup + row close. Bounded + best-effort: a FOREIGN lock
# (a next gate that self-drained — different request_id) does NOT hold us here, and
# if our lock somehow lingers we fall through (cleanup's guard still protects
# correctness). This also gives the row-close step the true post-gate lock state.
LOCK_ACTIVE="$PROJECT/__garelier/$PM/runtime/merge_gate/locks/active.lock"
for _w in $(seq 1 50); do
  [ -f "$LOCK_ACTIVE" ] || break
  grep -qF -- "$REQ_ID" "$LOCK_ACTIVE" 2>/dev/null || break
  sleep 0.1
done

# --- 4. SUCCESS: clean up the dispatch (branch is confirmed merged, so
# --delete-branch is safe past the W-044 guard) + pull. The gate has finished AND
# released our lock (waited for above), so the W-055 in-progress guard no longer
# fires for THIS branch; a NEXT queued gate that self-drained is a DIFFERENT slug,
# so its lock/MERGE_HEAD does not match this branch and the guard lets cleanup
# through. ------------------------------------------------------------------------
STUDIO_COMMIT="$DETAIL"
CLEANUP_STATUS="skipped" BRANCH_DELETED="false"
if [ -n "$DISPATCH_ID" ]; then
  CLEAN_ARGS=(--project "$PROJECT" --pm-id "$PM" --id "$DISPATCH_ID" --delete-branch)
  [ -n "$TARGET_ROOT" ] && CLEAN_ARGS+=(--target-root "$TARGET_ROOT")
  set +e
  CLEAN_OUT="$(bash "$SELF_DIR/dispatch_cleanup.sh" "${CLEAN_ARGS[@]}")"
  CLEAN_RC=$?
  set -e
  if [ -n "$CLEAN_OUT" ]; then
    CLEANUP_STATUS="$(printf '%s' "$CLEAN_OUT" | sed -n 's/.*"cleanup_status":"\([^"]*\)".*/\1/p')"
    BRANCH_DELETED="$(printf '%s' "$CLEAN_OUT" | sed -n 's/.*"branch_deleted":\(true\|false\).*/\1/p')"
    echo "$CLEAN_OUT" >&2
  fi
  [ -n "$CLEANUP_STATUS" ] || CLEANUP_STATUS="$([ "$CLEAN_RC" -eq 0 ] && echo success || echo "failed(rc=$CLEAN_RC)")"
else
  echo "merge_land: no --dispatch-id and none derivable from the branch — skipping cleanup." >&2
fi

# Pull (best-effort, non-fatal): the merge already landed + cleaned, so a pull that
# fails (no upstream on a local-only branch) must not fail the whole macro.
PULLED="skipped"
if [ "$NO_PULL" -ne 1 ]; then
  PULL_ERR="$(mktemp)"
  if git -C "$GIT_ROOT" pull --ff-only >/dev/null 2>"$PULL_ERR"; then PULLED="true"
  else PULLED="false"; echo "merge_land: git pull --ff-only skipped/failed: $(head -1 "$PULL_ERR" 2>/dev/null)" >&2; fi
  rm -f "$PULL_ERR"
fi

# --- 5. Row close (W-093): the merge LANDED, so optionally strike the closed
# backlog row(s) and commit — folding the PM's last manual touch into this same
# background command. Reached ONLY on success (the failure path returned at step 3),
# so a failed merge NEVER edits the backlog. `row_close` is added to the summary
# only when --close-row was passed, keeping the default output byte-identical. -----
ROW_CLOSE_FIELD=""
if [ "${#CLOSE_ROWS[@]}" -gt 0 ]; then
  BACKLOG_PATH="${BACKLOG_PATH_OVERRIDE:-$PROJECT/__garelier/$PM/control/project_dashboard/backlog.md}"
  ROW_CLOSE=""
  # Safety: an active.lock that is NOT ours means a NEXT gate self-drained and is
  # running (W-039). Committing now would race it, so DEFER — the merge already
  # landed, so this only leaves the PM one manual strike, never damage. Our OWN
  # gate's residual lock was already waited out before step 4, so a lock still
  # present here is a next gate, not us. LOCK_ACTIVE was set at the wait above.
  if [ -f "$LOCK_ACTIVE" ] && ! grep -qF -- "$REQ_ID" "$LOCK_ACTIVE" 2>/dev/null; then
    ROW_CLOSE="deferred (gate active)"
    echo "merge_land: row close deferred — a foreign merge_gate active.lock is present (a next gate is running); backlog left untouched." >&2
  elif [ ! -f "$BACKLOG_PATH" ]; then
    ROW_CLOSE="not-found"
    echo "merge_land: row close: backlog not found at $BACKLOG_PATH — nothing to close." >&2
  else
    CLOSED=()
    for _row in "${CLOSE_ROWS[@]}"; do
      _tmp="$(mktemp)"
      # Strike a table row whose FIRST cell (between the leading `|` and the next
      # `|`) is EXACTLY this item id — never a mention of it in a later column, and
      # never a longer id that merely starts with it. awk exits 0 iff it struck ≥1.
      if awk -v id="$_row" '
          function trim(s){ gsub(/^[ \t]+|[ \t]+$/,"",s); return s }
          { l=$0; sub(/^[ \t]+/,"",l)
            if (substr(l,1,1)=="|") { n=split(l,c,"|"); if (n>=3 && trim(c[2])==id){ hit=1; next } }
            print }
          END{ exit (hit?0:1) }
        ' "$BACKLOG_PATH" > "$_tmp"; then
        mv -f "$_tmp" "$BACKLOG_PATH"; CLOSED+=("$_row")
      else
        rm -f "$_tmp"
      fi
    done
    if [ "${#CLOSED[@]}" -eq 0 ]; then
      ROW_CLOSE="not-found"
      echo "merge_land: row close: none of [${CLOSE_ROWS[*]}] matched a backlog row in $BACKLOG_PATH — nothing committed." >&2
    else
      _ids=""; for _c in "${CLOSED[@]}"; do _ids="${_ids:+$_ids, }$_c"; done
      _msg="chore(dashboard): $_ids close (merged $STUDIO_COMMIT)"
      BL_GIT="$(git -C "$(dirname "$BACKLOG_PATH")" rev-parse --show-toplevel 2>/dev/null || true)"
      [ -n "$BL_GIT" ] || BL_GIT="$PROJECT"
      set +e
      if [ -n "$CLOSE_TRAILER" ]; then
        git -C "$BL_GIT" commit -q -m "$_msg" -m "$CLOSE_TRAILER" -- "$BACKLOG_PATH"
      else
        git -C "$BL_GIT" commit -q -m "$_msg" -- "$BACKLOG_PATH"
      fi
      _crc=$?
      set -e
      if [ "$_crc" -eq 0 ]; then
        ROW_CLOSE="closed"
        echo "merge_land: row close: struck [$_ids] from backlog and committed to $BL_GIT." >&2
      else
        ROW_CLOSE="commit-failed(rc=$_crc)"
        echo "merge_land: row close: git commit failed (rc=$_crc); the backlog edit is left in the working tree for the PM." >&2
      fi
    fi
  fi
  ROW_CLOSE_FIELD=",\"row_close\":\"$(json_escape "$ROW_CLOSE")\""
fi

printf '{"request_id":"%s","status":"success","studio_commit":"%s","dispatch_id":"%s","branch_deleted":%s,"cleanup_status":"%s","pulled":"%s"%s}\n' \
  "$(json_escape "$REQ_ID")" "$(json_escape "$STUDIO_COMMIT")" "$(json_escape "${DISPATCH_ID:-}")" \
  "${BRANCH_DELETED:-false}" "$(json_escape "${CLEANUP_STATUS:-skipped}")" "$PULLED" "$ROW_CLOSE_FIELD"
exit 0
