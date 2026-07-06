#!/usr/bin/env bash
#
# merge_land.test.sh — pins the merge_land.sh macro (W-088).
#
# Uses the W-087 dummy-gate rig: a REAL merge gate run, but with a trivial
# quality-gate command (`true` / `false`) standing in for a multi-minute build, so
# the whole submit → wait → cleanup → pull chain is exercised end to end in seconds.
#
#   1. SUCCESS  — gate passes → merge lands, dispatch cleaned up (worktree removed,
#                 branch deleted, report archived), summary status=success, exit 0.
#   2. FAILURE  — gate fails → NOTHING is cleaned up (dispatch + branch survive),
#                 summary status=failed, exit non-zero.
#   3. W-055 guard non-interference — a merged dispatch is cleaned even while a
#      FOREIGN gate (a different slug) holds active.lock; the same cleanup is still
#      REFUSED when the lock names THIS slug (the guard is slug-specific, so
#      merge_land's post-success cleanup is not blocked by a concurrent gate).
#
# Self-contained: run directly (`bash merge_land.test.sh`) or from ci.sh. Needs
# bun + git + a POSIX shell. Exits 0 only if every case holds.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
ML="$SELF_DIR/merge_land.sh"
CLEANUP="$SELF_DIR/dispatch_cleanup.sh"
[ -f "$ML" ] || { echo "merge_land.test: cannot find merge_land.sh next to me" >&2; exit 1; }

fail() { echo "  FAIL: $*" >&2; exit 1; }
GREL="__garelier"

# mk_fixture <slug> <id> -> sets TMP (posix) + DT (windows-usable path). A git repo
# with studio + a workbench branch (one commit) + setup_config + a _dispatch<id>
# worktree, ready for a merge gate run.
mk_fixture() {
  local slug="$1" id="$2"
  TMP="$(mktemp -d)"; DT="$(cygpath -m "$TMP" 2>/dev/null || printf '%s' "$TMP")"
  (
    cd "$TMP"
    git init -q -b main; git config user.email ci@ci; git config user.name t
    echo base > base.txt; git add -A; git commit -q -m init
    git branch "garelier/main/tpm/studio" main
    git worktree add -q -b "garelier/main/tpm/workbench/#$id/$slug" "wb" "garelier/main/tpm/studio"
    ( cd wb && echo feat > "$slug.txt" && git add -A && git commit -q -m "feat $slug" )
    git worktree remove wb
    mkdir -p "__garelier/tpm/_pm"
    printf '[project]\nname = "test"\n\n[branches]\ntarget = "main"\nintegration = "garelier/main/tpm/studio"\n' \
      > "__garelier/tpm/_pm/setup_config.toml"
    git worktree add -q "__garelier/tpm/_dispatch$id/checkout" "garelier/main/tpm/workbench/#$id/$slug"
    printf '# Report - #%s %s\n' "$id" "$slug" > "__garelier/tpm/_dispatch$id/report.md"
  )
}
cleanup_fixture() { cd /; rm -rf "$TMP" 2>/dev/null || true; }

# ── 1. SUCCESS ────────────────────────────────────────────────────────────────
mk_fixture land-ok 1
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --branch "garelier/main/tpm/workbench/#1/land-ok" --guardian PASS \
  --quality-gate 'true' --no-pull --max-wait 90 --poll-interval 2 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "success case exit was $RC (expected 0). summary=$OUT"
echo "$OUT" | grep -q '"status":"success"' || fail "success summary lacks status=success: $OUT"
echo "$OUT" | grep -q '"cleanup_status":"success"' || fail "success summary lacks cleanup_status=success: $OUT"
echo "$OUT" | grep -q '"branch_deleted":true' || fail "success summary lacks branch_deleted=true: $OUT"
[ ! -e "$TMP/__garelier/tpm/_dispatch1" ] || fail "success case did not remove the dispatch container"
[ -z "$(git -C "$TMP" branch --list '*workbench*')" ] || fail "success case did not delete the workbench branch"
git -C "$TMP" cat-file -e garelier/main/tpm/studio:land-ok.txt 2>/dev/null || fail "success case did not land the merge onto studio"
cleanup_fixture

# ── 2. FAILURE ────────────────────────────────────────────────────────────────
mk_fixture land-fail 2
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --branch "garelier/main/tpm/workbench/#2/land-fail" --guardian PASS \
  --quality-gate 'false' --no-pull --max-wait 90 --poll-interval 2 2>/dev/null)"
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "failure case exit was 0 (expected non-zero). summary=$OUT"
echo "$OUT" | grep -q '"status":"failed"' || fail "failure summary lacks status=failed: $OUT"
echo "$OUT" | grep -q '"cleaned_up":false' || fail "failure summary lacks cleaned_up=false: $OUT"
[ -e "$TMP/__garelier/tpm/_dispatch2" ] || fail "failure case WRONGLY removed the dispatch container"
[ -n "$(git -C "$TMP" branch --list '*workbench*')" ] || fail "failure case WRONGLY deleted the workbench branch"
cleanup_fixture

# ── 3. W-055 guard non-interference ───────────────────────────────────────────
# A dispatch whose branch is already merged (FF into studio). A FOREIGN active.lock
# (different slug) must NOT block its cleanup; the SAME-slug lock still must.
mk_fixture guard-ok 3
# Fast-forward the workbench into studio so the branch is a confirmed ancestor
# (merge_status=merged) without running the gate.
git -C "$TMP" branch -f "garelier/main/tpm/studio" "garelier/main/tpm/workbench/#3/guard-ok"
LOCK_DIR="$TMP/__garelier/tpm/runtime/merge_gate/locks"
mkdir -p "$LOCK_DIR"
# (a) FOREIGN lock: names a DIFFERENT slug → guard must not fire → cleanup succeeds.
printf '{"pid":999999,"request_id":"other","request_file":"other.json","started_at":"x","target_root":"%s"}\n' "$DT" \
  > "$LOCK_DIR/active.lock"
set +e
COUT="$(bash "$CLEANUP" --project "$DT" --target-root "$DT" --pm-id tpm --id 3 --delete-branch 2>/dev/null)"
CRC=$?
set -e
[ "$CRC" -eq 0 ] || fail "guard case: cleanup refused with a FOREIGN active.lock (exit $CRC) — W-055 guard wrongly interfered. out=$COUT"
[ -z "$(git -C "$TMP" branch --list '*workbench*')" ] || fail "guard case: branch not deleted despite merged + foreign lock"
cleanup_fixture

# (b) Negative control: a SAME-slug lock must still REFUSE (guard is real, only
# slug-specific). Fresh fixture (the previous one is cleaned).
mk_fixture guard-block 4
git -C "$TMP" branch -f "garelier/main/tpm/studio" "garelier/main/tpm/workbench/#4/guard-block"
LOCK_DIR="$TMP/__garelier/tpm/runtime/merge_gate/locks"
mkdir -p "$LOCK_DIR"
printf '{"pid":999999,"request_id":"x-guard-block","request_file":"x-guard-block.json","started_at":"x","target_root":"%s"}\n' "$DT" \
  > "$LOCK_DIR/active.lock"
set +e
COUT="$(bash "$CLEANUP" --project "$DT" --target-root "$DT" --pm-id tpm --id 4 --delete-branch 2>/dev/null)"
CRC=$?
set -e
[ "$CRC" -eq 3 ] || fail "guard case (negative): cleanup with a SAME-slug lock exited $CRC (expected 3 REFUSE) — the W-055 guard is not firing. out=$COUT"
[ -n "$(git -C "$TMP" branch --list '*workbench*')" ] || fail "guard case (negative): branch was deleted despite the same-slug lock"
cleanup_fixture

# ── W-093 --close-row cases ─────────────────────────────────────────────────────
# The gate leaves the primary checkout ON studio (it merges there), so the backlog
# the close step strikes must live on studio. Seed it there, then return to main so
# the gate's own `checkout studio` starts from a clean tree. The W-100 decoy row
# MENTIONS W-093 in a later column — it must survive (first-cell match only).
BL_REL="$GREL/tpm/control/project_dashboard/backlog.md"
seed_backlog() {
  git -C "$TMP" checkout -q "garelier/main/tpm/studio"
  mkdir -p "$TMP/$GREL/tpm/control/project_dashboard"
  cat > "$TMP/$GREL/tpm/control/project_dashboard/backlog.md" <<'BL'
# Backlog

| ID | Type | Status | Detail |
| --- | --- | --- | --- |
| W-093 | feature | ready | merge_land --close-row <id> |
| W-100 | bug | ready | follow-up mentioning W-093 in a later column |
BL
  # Stage ONLY the backlog — `add -A` would try to embed the _dispatch worktree.
  git -C "$TMP" add -- "$BL_REL"
  git -C "$TMP" commit -q -m "seed backlog"
  git -C "$TMP" checkout -q main
}

# ── 4. SUCCESS + --close-row ────────────────────────────────────────────────────
# Gate passes → merge lands → the W-093 row is struck and committed with the
# supplied trailer; the W-100 decoy (mentions W-093) is untouched.
mk_fixture land-close 5
seed_backlog
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --branch "garelier/main/tpm/workbench/#5/land-close" --guardian PASS \
  --quality-gate 'true' --no-pull --max-wait 90 --poll-interval 2 \
  --close-row W-093 --close-trailer 'Garelier: tpm pm-direct W-082' 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "close case exit was $RC (expected 0). summary=$OUT"
echo "$OUT" | grep -q '"status":"success"' || fail "close summary lacks status=success: $OUT"
echo "$OUT" | grep -qF '"row_close":"closed"' || fail "close summary lacks row_close=closed: $OUT"
if grep -qE '^\| W-093 \|' "$TMP/$BL_REL"; then fail "close case did NOT strike the W-093 row"; fi
grep -qE '^\| W-100 \|' "$TMP/$BL_REL" || fail "close case WRONGLY struck the W-100 decoy (matched a later-column mention)"
CLOG="$(git -C "$TMP" log -1 --format='%s%n%b')"
echo "$CLOG" | grep -qF 'chore(dashboard): W-093 close (merged' || fail "close commit subject wrong: $CLOG"
echo "$CLOG" | grep -qF 'Garelier: tpm pm-direct W-082' || fail "close commit lacks the --close-trailer line: $CLOG"
cleanup_fixture

# ── 5. GATE ACTIVE → row close DEFERRED ─────────────────────────────────────────
# The merge still lands, but a foreign active.lock (a NEXT self-drained gate) is
# present at close time, so the row is left untouched and reported deferred. The
# quality-gate command plants the foreign lock DURING the gate: the gate's own
# clear_lock_if_mine only removes a lock matching ITS request_id, so a foreign one
# survives past success. The lock MUST reference a LIVE pid — self_drain_queue runs
# a dock_merge poll that aborts+releases a DEAD-pid lock (isPidAlive via
# process.kill(pid,0)), which a real next-gate lock never is. We use THIS test
# process's Windows pid ($$'s /proc winpid), alive through the whole close step.
mk_fixture land-defer 6
seed_backlog
LOCKDIR="$DT/__garelier/tpm/runtime/merge_gate/locks"
MYWIN="$(cat /proc/$$/winpid 2>/dev/null || echo $$)"
cat > "$TMP/plant_lock.sh" <<EOF
#!/usr/bin/env bash
mkdir -p "$LOCKDIR"
printf '{"pid":$MYWIN,"request_id":"FOREIGN-NEXT-GATE","request_file":"FOREIGN-NEXT-GATE.json","started_at":"%s","target_root":"$DT"}' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCKDIR/active.lock"
exit 0
EOF
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --branch "garelier/main/tpm/workbench/#6/land-defer" --guardian PASS \
  --quality-gate "bash '$TMP/plant_lock.sh'" --no-pull --max-wait 90 --poll-interval 2 \
  --close-row W-093 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "deferred case exit was $RC (expected 0 — merge still lands). summary=$OUT"
echo "$OUT" | grep -qF '"row_close":"deferred (gate active)"' || fail "deferred summary lacks row_close=deferred: $OUT"
grep -qE '^\| W-093 \|' "$TMP/$BL_REL" || fail "deferred case WRONGLY struck the W-093 row (must defer, not touch backlog)"
cleanup_fixture

# ── 6. NOT FOUND → no commit, reported not-found ────────────────────────────────
# Gate passes, but the requested id is absent from the backlog: nothing struck,
# nothing committed, row_close=not-found (never a failure).
mk_fixture land-nf 7
seed_backlog
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --branch "garelier/main/tpm/workbench/#7/land-nf" --guardian PASS \
  --quality-gate 'true' --no-pull --max-wait 90 --poll-interval 2 \
  --close-row W-777 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "not-found case exit was $RC (expected 0). summary=$OUT"
echo "$OUT" | grep -qF '"row_close":"not-found"' || fail "not-found summary lacks row_close=not-found: $OUT"
grep -qE '^\| W-093 \|' "$TMP/$BL_REL" || fail "not-found case WRONGLY modified the backlog"
if git -C "$TMP" log -1 --format='%s' | grep -q 'chore(dashboard)'; then fail "not-found case WRONGLY made a close commit"; fi
cleanup_fixture

echo "merge_land.test: all cases pass (success / failure / guard non-interference + negative control / close-row success+deferred+not-found)"
