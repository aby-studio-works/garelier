#!/usr/bin/env bash
#
# dispatch_watch.test.sh — pins dispatch_watch.sh --fleet mode branches (W-071).
#
# Fakes a pm-id's _dispatch<N> containers and asserts the fleet-mode verdicts:
#   1. no dispatch                       -> RESULT: DRAIN, exit 0.
#   2. only a GATED REPORTING            -> excluded -> RESULT: DRAIN (drain-on-gate).
#   3. WORKING + REWORK + ungated REPORT -> all three watched; gated REPORTING
#                                           excluded; HEALTHY summary lists 3.
#   4. dormant past --stall-sec, no build -> RESULT: REVIVE-NEEDED per dispatch.
#   5. session-resume gap is contract_check.ts's job (its own test) — here we only
#      pin the fleet watcher.
#
# Progress is the git-fingerprint (HEAD | hash(STATE+report)); the fixtures keep
# those static so a dormancy accrues deterministically. --proc-regex 'ZZZ_NO_MATCH'
# neutralizes the host process probe so REVIVE is not masked by an unrelated build
# on the test machine (this box runs other cargo builds).
#
# Self-contained: run directly (`bash dispatch_watch.test.sh`) or from ci.sh.
# Exits 0 only if every branch holds.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
WATCH="$SELF_DIR/dispatch_watch.sh"
[ -f "$WATCH" ] || { echo "dispatch_watch.test: cannot find dispatch_watch.sh next to me" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }

PM="demo"
PR="$TMP/__garelier/$PM"
mkdir -p "$PR/_pm"

# mk <n> <status> <slug>: a minimal _dispatch<n> container.
mk() {
  local n="$1" status="$2" slug="$3" d="$PR/_dispatch$1"
  mkdir -p "$d/checkout"
  printf '# Dispatch #%s\n\n## Status\n\n%s\n\n## Current task\n\n#%s %s (br)\n' "$n" "$status" "$n" "$slug" > "$d/STATE.md"
  printf '# Report - #%s %s\n' "$n" "$slug" > "$d/report.md"
}
gate() {  # gate <slug> <role>: publish a verdict marker so a REPORTING is "gated".
  local slug="$1" role="$2" dir="$PR/runtime/$2/results"
  mkdir -p "$dir"
  printf '## Verdict\n\nPASS\n' > "$dir/$slug-$role.md"
}
# run_fleet <extra-args...> -> sets OUT/RC
run_fleet() {
  set +e
  OUT="$(bash "$WATCH" --fleet --project "$TMP" --pm-id "$PM" --interval-sec 1 "$@" 2>&1)"
  RC=$?
  set -e
}

(
  set -e

  # === 1. no dispatch -> DRAIN, exit 0 =======================================
  run_fleet --stall-sec 2 --max-run-sec 30
  [ "$RC" -eq 0 ] || fail "drain exit was $RC (expected 0)"
  echo "$OUT" | grep -q "^RESULT: DRAIN" || fail "empty pm did not DRAIN: $OUT"

  # === 2. only a GATED REPORTING -> excluded -> DRAIN ========================
  mk 9 REPORTING gated-only
  gate gated-only guardian
  run_fleet --stall-sec 2 --max-run-sec 30
  [ "$RC" -eq 0 ] || fail "gated-only exit was $RC (expected 0)"
  echo "$OUT" | grep -q "^RESULT: DRAIN" \
    || fail "a gated REPORTING was not excluded from the fleet: $OUT"
  rm -rf "$PR/_dispatch9" "$PR/runtime"

  # === 3. WORKING + REWORK + ungated REPORTING watched; gated excluded =======
  mk 1 WORKING feat-a
  mk 2 REWORK feat-b
  mk 3 REPORTING feat-c          # ungated -> included
  mk 4 REPORTING feat-d          # gated   -> excluded
  gate feat-d guardian
  # Long stall + short window -> no REVIVE, exits with a HEALTHY summary listing
  # exactly the three watched dispatches (not the gated #4).
  run_fleet --stall-sec 120 --max-run-sec 2 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 0 ] || fail "healthy exit was $RC (expected 0)"
  echo "$OUT" | grep -q "^RESULT: HEALTHY" || fail "no HEALTHY summary: $OUT"
  for expect in "#1 (WORKING)" "#2 (REWORK)" "#3 (REPORTING(ungated))"; do
    echo "$OUT" | grep -qF "$expect" || fail "health summary missing $expect: $OUT"
  done
  echo "$OUT" | grep -qF "feat-d" && fail "gated REPORTING #4 leaked into the fleet: $OUT"
  echo "$OUT" | grep -qE "#4 \(REPORTING" && fail "gated REPORTING #4 was watched: $OUT"

  # W-085: the fleet watch wrote a liveness heartbeat that contract_check reads for
  # its UNWATCHED check. Only mode=fleet is asserted here (single-mode markers need a
  # real repo; contract_check.test.ts pins the detection logic directly).
  ls "$PR"/runtime/dispatch/watch/heartbeats/fleet-*.json >/dev/null 2>&1 \
    || fail "fleet mode did not write a liveness heartbeat (W-085)"
  grep -q '"mode":"fleet"' "$PR"/runtime/dispatch/watch/heartbeats/fleet-*.json \
    || fail "fleet heartbeat missing the mode=fleet marker (W-085)"

  # === 4. dormant past --stall-sec, no build -> REVIVE-NEEDED per dispatch ====
  # Same fixtures; a 1s stall threshold + neutralized process probe -> the flat
  # fingerprints cross the threshold on the second poll and REVIVE fires.
  run_fleet --stall-sec 1 --max-run-sec 30 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 0 ] || fail "revive exit was $RC (expected 0, always-exit-0 contract)"
  echo "$OUT" | grep -q "RESULT: REVIVE-NEEDED — dispatch #1 (WORKING)" \
    || fail "no REVIVE-NEEDED for WORKING #1: $OUT"
  echo "$OUT" | grep -q "RESULT: REVIVE-NEEDED — dispatch #3 (REPORTING(ungated))" \
    || fail "ungated REPORTING #3 was not escalated to REVIVE-NEEDED: $OUT"
  echo "$OUT" | grep -q "contract_check.ts --stall-scan --handoff 1" \
    || fail "REVIVE line missing the respawn-handoff pointer: $OUT"
  echo "$OUT" | grep -q "RESULT: REVIVE-NEEDED — 3 dormant dispatch(es)" \
    || fail "no fleet REVIVE tally: $OUT"

  # === 5. usage: --id with --fleet is not required; single mode still guards ==
  set +e
  bash "$WATCH" --project "$TMP" --pm-id "$PM" >/dev/null 2>"$TMP/err5"
  RC5=$?
  set -e
  [ "$RC5" -eq 2 ] || fail "single mode without --id/--branch/--fleet exit was $RC5 (expected 2)"
  grep -q "or pass --fleet" "$TMP/err5" || fail "single-mode usage hint missing --fleet: $(cat "$TMP/err5")"
) || exit 1

# ── single-mode --windows (W-094) ─────────────────────────────────────────────
# One invocation runs up to N windows back-to-back: PROGRESS/BUILDING re-arm
# internally (no RESULT line), any terminal verdict (or the last window) surfaces
# a single RESULT line. Uses a REAL git repo (studio + a workbench branch at studio
# tip) plus setup_config.toml, since single mode resolves the integration branch and
# counts commits. --timeout-sec 1 + --interval-sec 1 make each window one ~1s poll so
# the multi-window loop is fast and deterministic.
REPO="$TMP/repo"
SPR="$REPO/__garelier/$PM"          # single-mode PM root (distinct from the fleet $PR)
mkdir -p "$SPR/_pm"
git -C "$REPO" init -q
git -C "$REPO" symbolic-ref HEAD refs/heads/studio 2>/dev/null || true
git -C "$REPO" config user.email t@t; git -C "$REPO" config user.name t
echo x > "$REPO/f"; git -C "$REPO" add -A; git -C "$REPO" commit -qm init >/dev/null
git -C "$REPO" branch wb            # workbench branch at studio tip (0 commits ahead)
printf 'integration = "studio"\n' > "$SPR/_pm/setup_config.toml"

# run_single <extra-args...> -> sets OUT/RC. Watches branch wb; each window is one
# ~1s poll (--timeout-sec 1 --interval-sec 1).
run_single() {
  set +e
  OUT="$(bash "$WATCH" --project "$REPO" --pm-id "$PM" --branch wb \
    --interval-sec 1 --timeout-sec 1 "$@" 2>&1)"
  RC=$?
  set -e
}

(
  set -e

  # === S1. --windows 1 == the pre-W-094 single shot: one window, RESULT: STALLED
  #         (no commit / no build / no sig change), no re-arm record. ===========
  run_single --windows 1 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 0 ] || fail "single --windows 1 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: STALLED" || fail "single --windows 1 did not STALL: $OUT"
  [ "$(echo "$OUT" | grep -c '^RESULT:')" -eq 1 ] || fail "single --windows 1 expected exactly one RESULT line: $OUT"
  echo "$OUT" | grep -q "re-arming" && fail "single --windows 1 must not re-arm: $OUT"
  echo "$OUT" | grep -qF "[window 1/1]" || fail "single --windows 1 missing window tag: $OUT"
  # W-085: single-mode liveness heartbeat written (mode=single) under the repo's PM root.
  ls "$SPR"/runtime/dispatch/watch/heartbeats/branch-*.json >/dev/null 2>&1 \
    || fail "single mode did not write a liveness heartbeat (W-085): $OUT"
  grep -q '"mode":"single"' "$SPR"/runtime/dispatch/watch/heartbeats/branch-*.json \
    || fail "single heartbeat missing mode=single (W-085)"

  # === S2. a terminal verdict stops EARLY: --windows 3 on a stalled branch exits
  #         at window 1 (STALLED is terminal), never reaching window 2. =========
  run_single --windows 3 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 0 ] || fail "stalled --windows 3 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: STALLED" || fail "stalled --windows 3 did not STALL: $OUT"
  echo "$OUT" | grep -qF "[window 1/3]" || fail "no window 1/3 start line: $OUT"
  echo "$OUT" | grep -qF "[window 2/3]" && fail "STALLED (terminal) must not reach window 2/3: $OUT"
  echo "$OUT" | grep -q "re-arming" && fail "STALLED must not re-arm: $OUT"

  # === S3. BUILDING re-arms INTERNALLY: --windows 3 with a live build process runs
  #         all 3 windows and ends with a SINGLE RESULT: BUILDING, leaving 2 re-arm
  #         records. --max-building-windows 10 keeps the hard ceiling from tripping
  #         RUNAWAY before N windows are consumed. ==============================
  sleep 60 & BPID=$!                 # a process the probe counts as a live build
  run_single --windows 3 --proc-regex 'sleep' --max-building-windows 10
  kill "$BPID" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "building --windows 3 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: BUILDING" || fail "live build did not end BUILDING: $OUT"
  [ "$(echo "$OUT" | grep -c '^RESULT:')" -eq 1 ] || fail "building run expected exactly one RESULT line across 3 windows: $OUT"
  for w in "[window 1/3]" "[window 2/3]" "[window 3/3]"; do
    echo "$OUT" | grep -qF "$w" || fail "3-window build run missing $w: $OUT"
  done
  [ "$(echo "$OUT" | grep -c 'verdict=BUILDING')" -eq 2 ] \
    || fail "expected 2 internal re-arm records across 3 BUILDING windows: $OUT"

  # === S4. --windows validation: 0 and non-numeric are rejected (exit 2). ======
  run_single --windows 0 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 2 ] || fail "--windows 0 exit was $RC (expected 2): $OUT"
  run_single --windows x --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 2 ] || fail "--windows x exit was $RC (expected 2): $OUT"
) || exit 1

echo "dispatch_watch.test: all fleet branches pass (drain / gated-exclude / multi-watch / revive / usage)"
echo "dispatch_watch.test: all single-mode --windows branches pass (windows-1 single-shot / terminal-stops-early / building-re-arm / validation)"
