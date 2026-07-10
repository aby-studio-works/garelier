#!/usr/bin/env bash
#
# dispatch_cleanup.test.sh — pins the dispatch_cleanup.sh options this bundle adds:
#
#   1. W-019 --report-from-file — cleanup transcribes a register-derived text file
#      into report.md BEFORE archiving, so the archived done/<id>-<slug>.md carries
#      the real outcome (with the "transcribed from the producer register" marker)
#      instead of the untouched dispatch scaffold; the result JSON reports
#      report_source. A missing source file is a non-fatal no-op.
#   2. DEC-063 completion retention — archives assignment/report/report.json and
#      removes the whole ephemeral container, including generated pickup/checkpoint
#      files that otherwise leave stale `_dispatch<N>/` directories.
#   3. W-021 --record-touches — records the MEASURED base_sha..HEAD path set into
#      context.json task.touches_actual (removing nothing), so a gate/Guardian reads
#      the actual diff instead of the stale dispatch-time `touches` prediction.
#
# Self-contained: run directly (`bash dispatch_cleanup.test.sh`) or from ci.sh.
# Needs bun + git + a POSIX shell. Exits 0 only if every case holds.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
CLEANUP="$SELF_DIR/dispatch_cleanup.sh"
[ -f "$CLEANUP" ] || { echo "dispatch_cleanup.test: cannot find dispatch_cleanup.sh next to me" >&2; exit 1; }

fail() { echo "  FAIL: $*" >&2; exit 1; }

# mk_fixture <slug> <id> -> sets TMP (posix) + DT (windows-usable path). A git repo
# with studio + a workbench branch merged into studio (so cleanup's W-044 guard sees
# merge_status=merged) + setup_config + a _dispatch<id> worktree with a scaffold
# report.md and a context.json carrying the base_sha.
mk_fixture() {
  local slug="$1" id="$2"
  TMP="$(mktemp -d)"; DT="$(cygpath -m "$TMP" 2>/dev/null || printf '%s' "$TMP")"
  (
    cd "$TMP"
    git init -q -b main; git config user.email ci@ci; git config user.name t
    echo base > base.txt; git add -A; git commit -q -m init
    BASE_SHA="$(git rev-parse --short HEAD)"
    git branch "garelier/main/tpm/studio" main
    git worktree add -q -b "garelier/main/tpm/workbench/#$id/$slug" "wb" "garelier/main/tpm/studio"
    ( cd wb && echo feat > "$slug.txt" && git add -A && git commit -q -m "feat $slug" )
    git worktree remove wb
    # Fast-forward the workbench into studio so the branch is a confirmed ancestor
    # (merge_status=merged) — lets --delete-branch pass the W-044 guard.
    git branch -f "garelier/main/tpm/studio" "garelier/main/tpm/workbench/#$id/$slug"
    mkdir -p "__garelier/tpm/_pm"
    printf '[project]\nname = "test"\n\n[branches]\ntarget = "main"\nintegration = "garelier/main/tpm/studio"\n' \
      > "__garelier/tpm/_pm/setup_config.toml"
    git worktree add -q "__garelier/tpm/_dispatch$id/checkout" "garelier/main/tpm/workbench/#$id/$slug"
    local dc="__garelier/tpm/_dispatch$id"
    # The untouched dispatch scaffold report.md (what W-019 replaces).
    printf '# Assignment - #%s %s\n\nGoal: fixture\n' "$id" "$slug" > "$dc/assignment.md"
    printf '# Report - #%s %s\n\n## Status\n\n(REPORTING | BLOCKED)\n' "$id" "$slug" > "$dc/report.md"
    printf '{"schema_version":1,"task_id":"#%s","status":"done"}\n' "$id" > "$dc/report.json"
    printf '{"task":{"id":%s,"slug":"%s","base_sha":"%s"}}\n' "$id" "$slug" "$BASE_SHA" > "$dc/context.json"
    printf '{"schema_version":1,"task":{"id":%s}}\n' "$id" > "$dc/pickup_pack.json"
    printf '# Dispatch #%s\n\n## Status\n\nREPORTING\n' "$id" > "$dc/STATE.md"
    mkdir -p "$dc/checkpoints"
    printf '# Checkpoint\n' > "$dc/checkpoints/0001-work.md"
  )
}
cleanup_fixture() { cd /; rm -rf "$TMP" 2>/dev/null || true; }

# ── 1. W-019 --report-from-file: transcribe register text into the archived report ─
mk_fixture rf-ok 1
REG="$TMP/register.txt"
printf 'STATE=REPORTING branch=...#1/rf-ok sha=deadbeef gate=GREEN ledger 0/0\nresult: the real register outcome text\n' > "$REG"
set +e
OUT="$(bash "$CLEANUP" --project "$DT" --target-root "$DT" --pm-id tpm --id 1 \
  --report-from-file "$REG" 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "W-019 case exit was $RC (expected 0). out=$OUT"
echo "$OUT" | grep -q '"report_source":' || fail "W-019 result lacks report_source key: $OUT"
echo "$OUT" | grep -q 'register.txt' || fail "W-019 result report_source not the passed file: $OUT"
DONE="$TMP/__garelier/tpm/runtime/backlog/done/1-rf-ok.md"
[ -f "$DONE" ] || fail "W-019 archived report not found at $DONE"
grep -q 'transcribed from the producer register' "$DONE" || fail "W-019 archive missing the transcription marker: $(cat "$DONE")"
grep -q 'the real register outcome text' "$DONE" || fail "W-019 archive missing the register body: $(cat "$DONE")"
grep -q '(REPORTING | BLOCKED)' "$DONE" && fail "W-019 archive still holds the scaffold placeholder (transcription did not replace it)"
grep -q 'Goal: fixture' "$DONE" || fail "DEC-063 archive missing assignment body: $(cat "$DONE")"
SIDECAR="$TMP/__garelier/tpm/runtime/backlog/done/1-rf-ok.json"
[ -f "$SIDECAR" ] || fail "DEC-063 archived report sidecar not found at $SIDECAR"
[ ! -e "$TMP/__garelier/tpm/_dispatch1" ] || fail "DEC-063 cleanup left stale dispatch container"
cleanup_fixture

# ── 2. W-019 missing source file is a non-fatal no-op ─────────────────────────
mk_fixture rf-missing 2
set +e
OUT="$(bash "$CLEANUP" --project "$DT" --target-root "$DT" --pm-id tpm --id 2 \
  --report-from-file "$TMP/does-not-exist.txt" 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "W-019 missing-source exit was $RC (expected 0). out=$OUT"
echo "$OUT" | grep -q '"report_source":"none"' || fail "W-019 missing-source should report report_source=none: $OUT"
DONE="$TMP/__garelier/tpm/runtime/backlog/done/2-rf-missing.md"
[ -f "$DONE" ] || fail "W-019 missing-source did not archive the scaffold report"
[ ! -e "$TMP/__garelier/tpm/_dispatch2" ] || fail "DEC-063 missing-source cleanup left stale dispatch container"
cleanup_fixture

# ── 3. W-021 --record-touches: measured base..HEAD paths into context.json ────
mk_fixture rt-ok 3
CTX="$TMP/__garelier/tpm/_dispatch3/context.json"
set +e
OUT="$(bash "$CLEANUP" --project "$DT" --target-root "$DT" --pm-id tpm --id 3 --record-touches 2>/dev/null)"
RC=$?
set -e
[ "$RC" -eq 0 ] || fail "W-021 --record-touches exit was $RC (expected 0). out=$OUT"
echo "$OUT" | grep -q '"ok":true' || fail "W-021 result not ok: $OUT"
# The fixture's workbench added rt-ok.txt on top of the base commit → touches_actual.
grep -q '"touches_actual"' "$CTX" || fail "W-021 context.json missing touches_actual: $(cat "$CTX")"
grep -q 'rt-ok.txt' "$CTX" || fail "W-021 touches_actual did not record the changed file: $(cat "$CTX")"
# The container must NOT have been removed (record-touches cleans up nothing).
[ -d "$TMP/__garelier/tpm/_dispatch3" ] || fail "W-021 --record-touches WRONGLY removed the container"
cleanup_fixture

echo "dispatch_cleanup.test: OK"
