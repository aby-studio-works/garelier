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

# add_dispatch <slug> <id> — add ANOTHER workbench branch + _dispatch<id> to the
# CURRENT $TMP repo (created by mk_fixture), so one fixture can host several
# dispatches for a batch-land test.
add_dispatch() {
  local slug="$1" id="$2"
  (
    cd "$TMP"
    git worktree add -q -b "garelier/main/tpm/workbench/#$id/$slug" "wb$id" "garelier/main/tpm/studio"
    ( cd "wb$id" && echo feat > "$slug.txt" && git add -A && git commit -q -m "feat $slug" )
    git worktree remove "wb$id"
    git worktree add -q "__garelier/tpm/_dispatch$id/checkout" "garelier/main/tpm/workbench/#$id/$slug"
    printf '# Report - #%s %s\n' "$id" "$slug" > "__garelier/tpm/_dispatch$id/report.md"
  )
}

# mk_fixture_lock <slug> <id> <relpath> — like mk_fixture, but the workbench adds
# <relpath> (to drive the merge gate's data-only classification) and the config
# declares the W-031 data-only fast path + the heavy_compile lock, so the W-024
# gate_mode→lock-skip behavior can be observed end to end.
mk_fixture_lock() {
  local slug="$1" id="$2" rel="$3"
  TMP="$(mktemp -d)"; DT="$(cygpath -m "$TMP" 2>/dev/null || printf '%s' "$TMP")"
  (
    cd "$TMP"
    git init -q -b main; git config user.email ci@ci; git config user.name t
    echo base > base.txt; git add -A; git commit -q -m init
    git branch "garelier/main/tpm/studio" main
    git worktree add -q -b "garelier/main/tpm/workbench/#$id/$slug" "wb" "garelier/main/tpm/studio"
    ( cd wb && mkdir -p "$(dirname "$rel")" && echo feat > "$rel" && git add -A && git commit -q -m "feat $slug" )
    git worktree remove wb
    mkdir -p "__garelier/tpm/_pm"
    printf '[project]\nname = "test"\n\n[branches]\ntarget = "main"\nintegration = "garelier/main/tpm/studio"\n\n[heavy_compile]\nenabled = true\nmax_concurrent = 1\n\n[merge_gate]\ndata_only_paths = ["docs/**"]\ndata_only_commands = ["true"]\n' \
      > "__garelier/tpm/_pm/setup_config.toml"
    git worktree add -q "__garelier/tpm/_dispatch$id/checkout" "garelier/main/tpm/workbench/#$id/$slug"
    printf '# Report - #%s %s\n' "$id" "$slug" > "__garelier/tpm/_dispatch$id/report.md"
  )
}
HEAVY_LOCK_REL="__garelier/tpm/runtime/locks/heavy_compile"

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

# ── W-017 argument-UX cases ─────────────────────────────────────────────────────

# ── 7. --dispatch-id resolves branch + Guardian verdict auto-read (no --branch,
#      no --guardian) → still lands end-to-end ────────────────────────────────────
# Proves both (a) branch resolution from the dispatch container's checkout HEAD and
# (c) verdict auto-read from the `## Verdict` marker: the merge could ONLY reach the
# gate (and land) if pre-validation resolved a branch AND a passing Guardian verdict
# from files alone. A guardian marker is planted at the dispatch_prepare-convention
# path; --id is the alias (the exact flag the PM tried in the live failure).
mk_fixture land-autoid 8
mkdir -p "$TMP/$GREL/tpm/runtime/guardian/results"
printf '## Verdict\n\nPASS\n' > "$TMP/$GREL/tpm/runtime/guardian/results/land-autoid-guardian.md"
ERRF="$(mktemp)"
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --id 8 --quality-gate 'true' --no-pull --max-wait 90 --poll-interval 2 2>"$ERRF")"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "autoid case exit was $RC (expected 0). summary=$OUT stderr=$(cat "$ERRF")"
echo "$OUT" | grep -q '"status":"success"' || fail "autoid summary lacks status=success: $OUT"
echo "$OUT" | grep -q '"branch_deleted":true' || fail "autoid summary lacks branch_deleted=true: $OUT"
grep -qF 'resolved --branch garelier/main/tpm/workbench/#8/land-autoid from dispatch #8' "$ERRF" \
  || fail "autoid case did not log branch resolution from --dispatch-id: $(cat "$ERRF")"
grep -qF "auto-read Guardian verdict 'PASS'" "$ERRF" \
  || fail "autoid case did not log Guardian verdict auto-read: $(cat "$ERRF")"
git -C "$TMP" cat-file -e garelier/main/tpm/studio:land-autoid.txt 2>/dev/null \
  || fail "autoid case did not land the merge onto studio"
rm -f "$ERRF"
cleanup_fixture

# ── 8. Pre-validation reports EVERY missing required input at once + usage ───────
# No --branch/--dispatch-id AND no --guardian: the old flow failed one arg at a time
# only at submit; now both are reported together with usage, before any submit.
mk_fixture land-preval 9
set +e
ERR="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm 2>&1 1>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 2 ] || fail "pre-validation missing-all exit was $RC (expected 2). out=$ERR"
echo "$ERR" | grep -qF 'cannot submit' || fail "pre-validation lacks the batch header: $ERR"
echo "$ERR" | grep -qi 'branch' || fail "pre-validation did not report the missing branch: $ERR"
echo "$ERR" | grep -qF 'Guardian verdict required' || fail "pre-validation did not report the missing Guardian verdict: $ERR"
echo "$ERR" | grep -qF 'Usage:' || fail "pre-validation did not print usage: $ERR"
cleanup_fixture

# ── 9. --id to a nonexistent container fails clearly (before submit), and --id is
#      an accepted alias (a provided --guardian is NOT spuriously flagged) ─────────
mk_fixture land-badid 10
set +e
ERR="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm --id 999 --guardian PASS 2>&1 1>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 2 ] || fail "--id nonexistent exit was $RC (expected 2). out=$ERR"
echo "$ERR" | grep -qF 'no dispatch checkout' || fail "--id nonexistent lacks the checkout-not-found error: $ERR"
echo "$ERR" | grep -qF 'Guardian verdict required' && fail "--id nonexistent WRONGLY flagged the provided --guardian: $ERR"
cleanup_fixture

# ── 10. Non-passing AUTO-READ Guardian verdict is refused before submit (never a
#       silent land); an explicit --guardian overrides the same marker ────────────
mk_fixture land-block 11
mkdir -p "$TMP/$GREL/tpm/runtime/guardian/results"
printf '## Verdict\n\nBLOCK\n' > "$TMP/$GREL/tpm/runtime/guardian/results/land-block-guardian.md"
set +e
ERR="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm --id 11 \
  --quality-gate 'true' --no-pull 2>&1 1>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 2 ] || fail "auto-read BLOCK exit was $RC (expected 2 — must not land on a BLOCK). out=$ERR"
echo "$ERR" | grep -qF 'auto-read Guardian verdict is BLOCK' || fail "auto-read BLOCK case lacks the refusal message: $ERR"
cleanup_fixture

# ── W-027 verdict auto-read path/diagnostic cases ───────────────────────────────

# ── 13. Relative --project ('.') auto-reads the verdict marker ──────────────────
# The marker path is built from --project; with a RELATIVE --project (the PM's
# `--project .`) read_marker_verdict used to cd into the parser dir and read the
# relative path from the WRONG cwd → silent ENOENT → a fail-closed "Guardian
# verdict required" misfire (2026-07-07, three consecutive land failures). Run
# from INSIDE the project with --project . and prove the Guardian PASS is auto-read
# and the merge still lands end-to-end.
mk_fixture land-relauto 14
mkdir -p "$TMP/$GREL/tpm/runtime/guardian/results"
printf '## Verdict\n\nPASS\n' > "$TMP/$GREL/tpm/runtime/guardian/results/land-relauto-guardian.md"
ERRF="$(mktemp)"
set +e
OUT="$(cd "$TMP" && bash "$ML" --project . --target-root "$DT" --pm-id tpm \
  --id 14 --quality-gate 'true' --no-pull --max-wait 90 --poll-interval 2 2>"$ERRF")"
RC=$?
set -e
grep -qF "auto-read Guardian verdict 'PASS'" "$ERRF" \
  || fail "relative --project did NOT auto-read the Guardian verdict (W-027 regression): $(cat "$ERRF")"
if grep -qF 'MALFORMED' "$ERRF"; then fail "relative --project WRONGLY flagged the present marker malformed: $(cat "$ERRF")"; fi
[ "$RC" -eq 0 ] || fail "relative --project auto-read exit was $RC (expected 0). summary=$OUT stderr=$(cat "$ERRF")"
echo "$OUT" | grep -q '"status":"success"' || fail "relative --project case lacks status=success: $OUT"
git -C "$TMP" cat-file -e garelier/main/tpm/studio:land-relauto.txt 2>/dev/null \
  || fail "relative --project case did not land the merge onto studio"
rm -f "$ERRF"
cleanup_fixture

# ── 14. A present-but-malformed marker reports MALFORMED, distinct from absent ───
# A gate role that wrote a PROSE verdict instead of a bare token (the re-failure
# this fix targets): the marker EXISTS but extractVerdict captures no canonical
# token, so the land is refused fail-closed — AND the reason is now visible on
# stderr as "malformed", not conflated with an absent marker.
mk_fixture land-malformed 15
mkdir -p "$TMP/$GREL/tpm/runtime/guardian/results"
printf '## Verdict\n\nGuardian verdict: PASS — no blockers found.\n' \
  > "$TMP/$GREL/tpm/runtime/guardian/results/land-malformed-guardian.md"
set +e
ERR="$(cd "$TMP" && bash "$ML" --project . --target-root "$DT" --pm-id tpm \
  --id 15 --quality-gate 'true' --no-pull 2>&1 1>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 2 ] || fail "malformed-marker exit was $RC (expected 2 — no valid verdict, fail-closed). out=$ERR"
echo "$ERR" | grep -qF 'MALFORMED' || fail "malformed-marker case did not report the marker as malformed: $ERR"
echo "$ERR" | grep -qF 'Guardian verdict required' || fail "malformed-marker case lacks the pre-validation refusal: $ERR"
cleanup_fixture

# ── W-024: merge-gate heavy_compile lock skip on a data-only gate ───────────────

# ── 11. A data-only merge SKIPS the heavy-compile lock ──────────────────────────
# The docs-only diff classifies gate_mode=data_only, so the gate runs the cheap
# data_only_commands and must NOT acquire the heavy_compile lock (the 2026-07-06
# 90-min stall was a docs-only gate queued behind that lock). Proof: the FAILING
# full quality-gate ('false') would fail the merge if it ran, but the merge LANDS
# because the data_only_commands ('true') ran instead; and the lock dir is never
# created, so the acquire was skipped.
mk_fixture_lock land-dataonly 12 "docs/guide.md"
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --branch "garelier/main/tpm/workbench/#12/land-dataonly" --guardian PASS \
  --quality-gate 'false' --no-pull --max-wait 90 --poll-interval 2 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "data-only case exit was $RC (expected 0 — data_only_commands run, not the failing full gate). summary=$OUT"
echo "$OUT" | grep -q '"status":"success"' || fail "data-only summary lacks status=success: $OUT"
[ ! -e "$TMP/$HEAVY_LOCK_REL" ] || fail "data-only gate created the heavy_compile lock dir — the acquire was NOT skipped (W-024)"
cleanup_fixture

# ── 12. A full (non-data-only) merge ENGAGES the lock (contrast / regression) ────
# A src diff classifies gate_mode=full, so the gate acquires the lock (creating
# the lock dir) around its build. Proves the W-024 skip is conditional on
# data_only mode, not a blanket removal of the lock.
mk_fixture_lock land-fullcompile 13 "src/code.txt"
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --branch "garelier/main/tpm/workbench/#13/land-fullcompile" --guardian PASS \
  --quality-gate 'true' --no-pull --max-wait 90 --poll-interval 2 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "full-compile case exit was $RC (expected 0). summary=$OUT"
echo "$OUT" | grep -q '"status":"success"' || fail "full-compile summary lacks status=success: $OUT"
[ -d "$TMP/$HEAVY_LOCK_REL" ] || fail "full merge did NOT engage the heavy_compile lock (lock dir absent) — regression"
cleanup_fixture

# ── W-022 batch-land cases ──────────────────────────────────────────────────────

# ── 15. Batch success via repeated --id — TWO dispatches land in ONE command ─────
# Two dispatches in one repo, landed serially by a single `--id 20 --id 21` call.
# Both merges reach studio, both dispatch containers are cleaned, and the final
# stdout line is the batch summary total=2/landed=2/status=success.
mk_fixture batch-a 20
add_dispatch batch-b 21
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --id 20 --id 21 --guardian PASS --quality-gate 'true' --no-pull --max-wait 90 --poll-interval 2 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "batch success exit was $RC (expected 0). summary=$OUT"
SUMMARY="$(printf '%s\n' "$OUT" | tail -1)"
echo "$SUMMARY" | grep -qF '"batch":true' || fail "batch success: last line is not the batch summary: $SUMMARY"
echo "$SUMMARY" | grep -qF '"total":2' || fail "batch success summary lacks total=2: $SUMMARY"
echo "$SUMMARY" | grep -qF '"landed":2' || fail "batch success summary lacks landed=2: $SUMMARY"
echo "$SUMMARY" | grep -qF '"status":"success"' || fail "batch success summary lacks status=success: $SUMMARY"
git -C "$TMP" cat-file -e garelier/main/tpm/studio:batch-a.txt 2>/dev/null || fail "batch: first item did not land on studio"
git -C "$TMP" cat-file -e garelier/main/tpm/studio:batch-b.txt 2>/dev/null || fail "batch: second item did not land on studio"
[ ! -e "$TMP/__garelier/tpm/_dispatch20" ] || fail "batch: first dispatch container not cleaned"
[ ! -e "$TMP/__garelier/tpm/_dispatch21" ] || fail "batch: second dispatch container not cleaned"
cleanup_fixture

# ── 16. Batch abort via --batch file — first item FAILS, the rest is NOT attempted ─
# A --batch file: item 1 has a failing quality-gate, item 2 a passing one. Item 1's
# merge fails, so the batch ABORTS and item 2 (which WOULD have passed) is never
# attempted: its dispatch + branch survive untouched, nothing of it reaches studio.
# The summary reports status=failed / attempted=1 / landed=0 and names the failed
# item; exit is non-zero. Proves a failure does not drag the remaining items in.
mk_fixture batch-bad 22
add_dispatch batch-skipped 23
cat > "$TMP/batch.txt" <<'BATCH'
# item 1 fails (quality-gate false); item 2 would pass but must NOT be attempted
--id 22 --quality-gate false
--id 23 --quality-gate true
BATCH
set +e
OUT="$(bash "$ML" --project "$DT" --target-root "$DT" --pm-id tpm \
  --guardian PASS --no-pull --max-wait 90 --poll-interval 2 --batch "$TMP/batch.txt" 2>/dev/null)"
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "batch abort exit was 0 (expected non-zero). summary=$OUT"
SUMMARY="$(printf '%s\n' "$OUT" | tail -1)"
echo "$SUMMARY" | grep -qF '"batch":true' || fail "batch abort: last line is not the batch summary: $SUMMARY"
echo "$SUMMARY" | grep -qF '"status":"failed"' || fail "batch abort summary lacks status=failed: $SUMMARY"
echo "$SUMMARY" | grep -qF '"attempted":1' || fail "batch abort summary lacks attempted=1 (must stop after item 1): $SUMMARY"
echo "$SUMMARY" | grep -qF '"landed":0' || fail "batch abort summary lacks landed=0: $SUMMARY"
echo "$SUMMARY" | grep -qF '"failed_item":"--id 22' || fail "batch abort summary does not name the failed item: $SUMMARY"
# The SKIPPED item 2 must be entirely untouched (never attempted).
[ -e "$TMP/__garelier/tpm/_dispatch23" ] || fail "batch abort WRONGLY cleaned the un-attempted item 2 dispatch"
[ -n "$(git -C "$TMP" branch --list 'garelier/main/tpm/workbench/#23/*')" ] || fail "batch abort WRONGLY deleted the un-attempted item 2 branch"
if git -C "$TMP" cat-file -e garelier/main/tpm/studio:batch-skipped.txt 2>/dev/null; then fail "batch abort WRONGLY landed the un-attempted item 2 onto studio"; fi
# The FAILED item 1 also survives (single-land failure cleans nothing).
[ -e "$TMP/__garelier/tpm/_dispatch22" ] || fail "batch abort WRONGLY cleaned the failed item 1 dispatch"
cleanup_fixture

echo "merge_land.test: all cases pass (success / failure / guard non-interference + negative control / close-row success+deferred+not-found / W-017 dispatch-id+verdict auto-read + batch pre-validation + bad-id + auto-BLOCK refusal / W-027 relative-project auto-read + malformed-marker diagnostic / W-024 data-only lock-skip + full-mode lock engage / W-022 batch land 2-item success + abort-on-first-failure)"
