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

# ── W-075: proxy-seat progress signal ─────────────────────────────────────────
# PROXY commit_mode producers (codex seats) never commit, so a watch that judges
# progress by `commits` alone reads a healthy, actively-edited worktree as
# STALLED/RUNAWAY (field #319/#328, 2026-07-14 — a healthy producer was nearly
# killed). --id resolves a CONTAINER (context.json + checkout/), which the fixtures
# above never used (--branch only), so these tests build one on top of $REPO/$SPR.
# ONE template checkout (git init + baseline commit), copied per dispatch below
# instead of re-running `git init`/`commit` each time — on this host each git
# subprocess costs real wall time, and building 4 fresh repos serially dominated
# this section's runtime; a filesystem copy is far cheaper than 5 more git spawns.
W075_TEMPLATE="$TMP/w075_template_checkout"
mkdir -p "$W075_TEMPLATE"
git -C "$W075_TEMPLATE" init -q
git -C "$W075_TEMPLATE" config user.email t@t; git -C "$W075_TEMPLATE" config user.name t
echo a > "$W075_TEMPLATE/f.txt"
git -C "$W075_TEMPLATE" add -A; git -C "$W075_TEMPLATE" commit -qm init >/dev/null

mkctx() {  # mkctx <id> <commit_mode> [model] — a dispatch container with a real
           # git checkout (so wt_progress_sig has something to probe) + context.json.
  local id="$1" mode="$2" model="${3:-claude}" d
  d="$SPR/_dispatch$id"
  mkdir -p "$d"
  cp -r "$W075_TEMPLATE" "$d/checkout"
  printf '{"routing": {"commit_mode": "%s", "model": "%s"}}\n' "$mode" "$model" > "$d/context.json"
  : > "$d/STATE.md"; : > "$d/report.md"
}
# run_single_id <id> <extra-args...> -> sets OUT/RC. Watches branch wb via --id N
# (so CONTAINER resolves), same fast poll cadence as run_single above.
run_single_id() {
  local id="$1"; shift
  set +e
  OUT="$(bash "$WATCH" --project "$REPO" --pm-id "$PM" --id "$id" --branch wb \
    --interval-sec 1 --timeout-sec 1 "$@" 2>&1)"
  RC=$?
  set -e
}

(
  set -e

  # === P1. proxy seat, worktree actively edited, no compile process =============
  # A continuous background touch keeps the checkout's newest mtime advancing
  # throughout the window regardless of exact scheduling (no race with the
  # baseline capture) — the real-world shape (5 files under active edit, W-075 row).
  mkctx 20 proxy gpt-5.6-sol
  ( i=0; while [ $i -lt 15 ]; do date >> "$SPR/_dispatch20/checkout/f.txt" 2>/dev/null; sleep 0.15; i=$((i+1)); done ) &
  PERT1=$!
  run_single_id 20 --windows 1 --proc-regex 'ZZZ_NO_MATCH'
  kill "$PERT1" 2>/dev/null || true; wait "$PERT1" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "P1 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: ADVANCING" \
    || fail "P1 proxy seat with worktree edits should ADVANCE (not STALL/RUNAWAY on commits=0): $OUT"
  echo "$OUT" | grep -qi "proxy seat" || fail "P1 ADVANCING message missing the proxy-seat note: $OUT"

  # === P2. proxy seat, worktree edited AND a live compile process ===============
  # The W-075 row's exact false-RUNAWAY shape: commits=0 forever + BUILDING windows.
  # A live build alongside real worktree progress must still read ADVANCING, not
  # BUILDING/RUNAWAY — a codex build running while files are under active edit is
  # healthy, not stuck.
  mkctx 21 proxy gpt-5.6-sol
  sleep 8 & BPID2=$!
  ( i=0; while [ $i -lt 15 ]; do date >> "$SPR/_dispatch21/checkout/f.txt" 2>/dev/null; sleep 0.15; i=$((i+1)); done ) &
  PERT2=$!
  run_single_id 21 --windows 1 --proc-regex 'sleep'
  kill "$PERT2" 2>/dev/null || true; wait "$PERT2" 2>/dev/null || true
  kill "$BPID2" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "P2 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: ADVANCING" \
    || fail "P2 proxy seat with worktree edits + live build should ADVANCE, not BUILD/RUNAWAY: $OUT"

  # === P3. proxy seat, genuinely nothing moving + a live compile process =========
  # No worktree edits, no STATE/report change: RUNAWAY still must fire at the hard
  # ceiling (a proxy seat is not immune to real stalls) — but its message MUST say
  # not to judge by commits, per the row's requirement.
  mkctx 22 proxy gpt-5.6-sol
  sleep 8 & BPID3=$!
  run_single_id 22 --windows 1 --max-building-windows 1 --proc-regex 'sleep'
  kill "$BPID3" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "P3 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: RUNAWAY" \
    || fail "P3 proxy seat with zero signal + live build should still RUNAWAY at the hard ceiling: $OUT"
  echo "$OUT" | grep -qi "do NOT judge by commits" \
    || fail "P3 RUNAWAY message missing the required 'do NOT judge by commits' caveat: $OUT"
  echo "$OUT" | grep -qi "proxy seat" || fail "P3 RUNAWAY message missing the proxy-seat note: $OUT"

  # === S5. self mode via --id: worktree edits are IGNORED (byte-identical gate) ==
  # Same worktree-edit fixture as P1, but commit_mode=self — proves wt_progress_sig
  # is truly gated on IS_PROXY, not merely coincidentally unused in the S1-S4 tests
  # above (which never resolved a CONTAINER at all, via bare --branch).
  mkctx 23 self claude
  ( i=0; while [ $i -lt 15 ]; do date >> "$SPR/_dispatch23/checkout/f.txt" 2>/dev/null; sleep 0.15; i=$((i+1)); done ) &
  PERT5=$!
  run_single_id 23 --windows 1 --proc-regex 'ZZZ_NO_MATCH'
  kill "$PERT5" 2>/dev/null || true; wait "$PERT5" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "S5 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: STALLED" \
    || fail "S5 self-mode worktree edits must NOT be read as progress (pre-W-075 behavior unchanged): $OUT"
) || exit 1

# ── W-078(c): IDLE-DONE early-exit verdict ────────────────────────────────────
# The producer's OWN background job finished but nothing re-woke it (harness gap,
# field #334/#336/#338) — it never reaches REPORTING at all, so it never goes
# through IDLE-NO-REGISTER either. STATE.md stays WORKING with procs=0 and a
# perfectly static worktree for two consecutive polls. --timeout-sec 3
# --interval-sec 1 gives one window three ~1s polls, so IDLE-DONE (which needs 2
# consecutive matches) must fire mid-window and never reach poll 3 — the "EARLY
# EXIT" the row requires, not merely "eventually STALLED".
mkidle() {  # mkidle <id> <status> [register: yes|no, default no]
  local id="$1" status="$2" reg="${3:-no}" d
  d="$SPR/_dispatch$id"
  mkdir -p "$d"
  cp -r "$W075_TEMPLATE" "$d/checkout"
  printf '{"routing": {"commit_mode": "self", "model": "claude"}}\n' > "$d/context.json"
  printf '## Status\n\n%s\n' "$status" > "$d/STATE.md"
  : > "$d/report.md"
  [ "$reg" = "yes" ] && : > "$d/register_received"
}

(
  set -e

  # === D1. STATE=WORKING, procs=0, worktree ACTIVE for the first ~2-3s then goes
  #         perfectly static -> IDLE-DONE fires once armed, EARLY EXIT (does not
  #         consume the full 8-poll window budget). =============================
  # W-082 (field #339): IDLE-DONE now requires an observed activity signal (the
  # fingerprint differing from the window's OWN t=0 baseline) before it will even
  # start counting consecutive-static polls — a producer that has done NOTHING at
  # all since the watch started is read as "still reading", not "stalled" (see F1
  # below). This fixture now has to earn its IDLE-DONE the same way a real stalled
  # producer would: a background loop touches the checkout every 0.2s for ~3s (a
  # stand-in for "the producer's background job was actually doing something"),
  # then stops dead — a generous 8-poll/8s budget gives several full poll
  # intervals of guaranteed staticness after the loop quits, so 2 consecutive
  # matches (and the early exit) are reached well before the window runs out
  # regardless of exactly which poll the activity/staticness boundary lands on.
  mkidle 30 WORKING no
  ( i=0; while [ $i -lt 15 ]; do date >> "$SPR/_dispatch30/checkout/f.txt" 2>/dev/null; sleep 0.2; i=$((i+1)); done ) &
  PERT30=$!
  run_single_id 30 --windows 1 --timeout-sec 8 --proc-regex 'ZZZ_NO_MATCH'
  kill "$PERT30" 2>/dev/null || true; wait "$PERT30" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "D1 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: IDLE-DONE" || fail "D1 did not report IDLE-DONE once activity was observed then stopped: $OUT"
  echo "$OUT" | grep -qF "poll 8 (" && fail "D1 IDLE-DONE did not exit early (consumed the full 8-poll window): $OUT"
  echo "$OUT" | grep -q "Wake it" || fail "D1 IDLE-DONE message missing the wake instruction: $OUT"
  echo "$OUT" | grep -qi "do NOT kill or re-dispatch" \
    || fail "D1 IDLE-DONE message missing the do-not-kill/re-dispatch caveat: $OUT"

  # === D2. Same fixture but a live compile process -> stays BUILDING, no IDLE-DONE.
  # sleep 30 (not 8, like the W-075 single-poll tests above) — this window runs 3
  # polls and each poll now does an extra git-status+find for the IDLE-DONE check,
  # so it needs enough headroom to outlast Windows Git Bash's subprocess overhead.
  mkidle 31 WORKING no
  sleep 30 & BPID31=$!
  run_single_id 31 --windows 1 --timeout-sec 3 --proc-regex 'sleep' --max-building-windows 10
  kill "$BPID31" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "D2 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: BUILDING" \
    || fail "D2 a live compile process must keep this BUILDING, not IDLE-DONE: $OUT"
  echo "$OUT" | grep -q "IDLE-DONE" && fail "D2 IDLE-DONE must not fire while compile_procs > 0: $OUT"

  # === D3. Same fixture but register_received already exists -> no IDLE-DONE
  #         (already processed; falls through to the ordinary STALLED verdict). ==
  mkidle 32 WORKING yes
  run_single_id 32 --windows 1 --timeout-sec 3 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 0 ] || fail "D3 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: STALLED" \
    || fail "D3 with register_received present should fall through to STALLED, not IDLE-DONE: $OUT"
  echo "$OUT" | grep -q "IDLE-DONE" && fail "D3 IDLE-DONE must not fire once register_received exists: $OUT"

  # === D4. REPORTING + no register: IDLE-DONE's early internal exit must NOT
  #         change the final printed verdict — the windows driver's existing W-018
  #         overlay still wins, so the operator keeps seeing IDLE-NO-REGISTER
  #         byte-identical to pre-W-078c (only the internal detection got faster). =
  mkidle 33 REPORTING no
  run_single_id 33 --windows 1 --timeout-sec 3 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 0 ] || fail "D4 exit was $RC (expected 0): $OUT"
  # NOTE: the "grep && fail" (negative-assertion) form must never be the LAST
  # statement of a "(set -e ...) || exit 1" block — when grep correctly finds no
  # match (the passing case), that statement's own exit status is 1, which the
  # subshell then reports as ITS exit status, and the outer "|| exit 1" wrongly
  # treats a passing block as failed (silently, no fail() message). Keep the
  # "grep || fail" (positive-assertion) form last, as every other block here does.
  echo "$OUT" | grep -qF "RESULT: IDLE-DONE" \
    && fail "D4 the printed RESULT must be IDLE-NO-REGISTER, not IDLE-DONE, for a REPORTING producer: $OUT"
  echo "$OUT" | grep -q "^RESULT: IDLE-NO-REGISTER" \
    || fail "D4 REPORTING+no-register must still surface as IDLE-NO-REGISTER (unchanged verdict): $OUT"
) || exit 1

# ── W-079 / W-080 compile_procs guards, made HERMETIC (W-081) ────────────────
# compile_procs() strips every ps token to its basename, matches each token
# ANCHORED (^(?:PROC_REGEX)$), and drops any sccache row — so W-079's path-substring
# false positive (sccache under .cargo/bin, the ".cargo" dir matching a bare "cargo"
# on a RAW-line grep, field #338) and W-080's basename-substring false positive
# ("gcc" inside Intel's OneApp.IGCC.WinService.exe) are both structurally impossible
# now. E1-E4 GUARD those mechanisms against regression.
#
# W-081 HERMETICITY (2026-07-16): the earlier revision named the REAL toolchain
# regexes ('cargo|rustc', 'gcc', and the bare DEFAULT) in the compile_procs==0
# branches. On this box a merge gate's real cargo/rustc/gcc (gcc = the MinGW linker)
# running concurrently was then counted, flipped the expected STALLED to BUILDING,
# and the block fail()ed — which a caller piping the suite to `tail` (dropping
# ${PIPESTATUS[0]}) read as GREEN (silent abort). The fix: every compile_procs==0
# branch now uses a regex that CANNOT match a live toolchain — `sccache(\.exe)?`
# (always dropped, so a real sccache never pollutes) for the drop guard, and unique
# unreal tokens (w081sib / w081sub) for the basename/boundary guards; the default-
# regex sanity (E5) is INVERTED to assert the default regex CATCHES a real toolchain
# name (>=1 -> BUILDING), a direction a concurrent real compile can only reinforce.
# The W-080 IGCC-boundary property that E5 used to pin is now pinned hermetically by
# E3 (unique token, same substring shape). A long-lived fake `rustc.exe` is kept
# running across E1-E4 to PROVE the compile_procs==0 guards stay green under a
# concurrent compile (the AC's "並走を模す fixture").
#
# NOTE for CALLERS: run this suite reading ${PIPESTATUS[0]}, never a bare `| tail` —
# fail() prints to stderr but a swallowed pipe exit reads a failed suite as green
# (the exact W-081 miss).
#
# We fake a real OS process rather than fake ps text: copy the real `sleep` binary
# (a genuine Windows PE executable already on PATH) to a custom path/name so ps -W
# actually reports that path — the exact shape of the real bug.
SLEEP_BIN="$(command -v sleep)"
mkfakeproc() {  # mkfakeproc <dest-dir> <basename> -> prints the copied binary's path
  local dir="$1" name="$2"
  mkdir -p "$dir"
  cp "$SLEEP_BIN" "$dir/$name"
  printf '%s' "$dir/$name"
}

# W-081 concurrency fixture: a long-lived fake `rustc.exe` standing in for a real
# merge-gate compile running alongside the suite. E1-E4's regexes are chosen so this
# is NEVER counted by them, so E1/E3 must still read compile_procs=0 with it alive —
# that is the hermeticity proof. Retired before the inverted E5.
AMBIENT_RUSTC="$(mkfakeproc "$TMP/w081_ambient" rustc.exe)"
"$AMBIENT_RUSTC" 120 & AMBIENT_PID=$!

(
  set -e

  # === E1. sccache-drop guard (W-079), hermetic. A resident sccache must read
  #         compile_procs=0 even under a regex that WOULD match its basename — the
  #         drop is by ps-line ("sccache" anywhere on the row), so `sccache(\.exe)?`
  #         never counts. A real host sccache is dropped by the same rule and cannot
  #         pollute this (nor can the ambient fake rustc — different name). Static
  #         worktree -> never-armed IDLE-DONE -> STALLED (W-082); the compile_procs=0
  #         poll-line is the load-bearing assertion. ==============================
  mkidle 40 WORKING no
  FAKE_SCCACHE="$(mkfakeproc "$TMP/w079_fakebin1/.cargo/bin" sccache.exe)"
  "$FAKE_SCCACHE" 10 &
  SCPID40=$!
  run_single_id 40 --windows 1 --timeout-sec 3 --proc-regex 'sccache(\.exe)?'
  kill "$SCPID40" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "E1 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "IDLE-DONE" \
    && fail "E1 must not report IDLE-DONE from a never-armed static fixture (W-082): $OUT"
  echo "$OUT" | grep -qF "compile_procs=0" \
    || fail "E1 a resident sccache must be DROPPED (compile_procs=0), not matched by its own basename (W-079): $OUT"
  echo "$OUT" | grep -q "^RESULT: STALLED" \
    || fail "E1 with compile_procs correctly 0 and no activity ever, expected STALLED: $OUT"

  # === E2. sibling-still-caught guard (W-079), hermetic. The sccache drop is
  #         ps-LINE-scoped, not a blanket "ignore this regex" — a sibling toolchain
  #         proc in the same dir (a UNIQUE token, so the ambient real rustc cannot
  #         stand in for it) is still counted -> BUILDING. ========================
  mkidle 41 WORKING no
  FAKE_SCCACHE2="$(mkfakeproc "$TMP/w079_fakebin2/.cargo/bin" sccache.exe)"
  FAKE_SIB="$(mkfakeproc "$TMP/w079_fakebin2/.cargo/bin" w081sib.exe)"
  "$FAKE_SCCACHE2" 10 & SCPID41=$!
  "$FAKE_SIB" 10 & SIBPID41=$!
  run_single_id 41 --windows 1 --timeout-sec 3 --proc-regex 'sccache(\.exe)?|w081sib(\.exe)?' --max-building-windows 10
  kill "$SCPID41" "$SIBPID41" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "E2 exit was $RC (expected 0): $OUT"
  # (see the D4 NOTE above: keep the "grep || fail" positive-assertion form LAST.)
  echo "$OUT" | grep -q "IDLE-DONE" && fail "E2 IDLE-DONE must not fire while an actual toolchain process runs: $OUT"
  echo "$OUT" | grep -q "^RESULT: BUILDING" \
    || fail "E2 a sibling toolchain proc alongside a dropped sccache must still read BUILDING: $OUT"
) || exit 1

# ── W-080: PROC_REGEX basename SUBSTRING collision, hermetic (W-081) ─────────
# W-079 closed the PATH-substring collision; this closes the adjacent BASENAME-
# substring one: Intel's real, always-on `OneApp.IGCC.WinService.exe` contains "gcc"
# inside "IGCC". compile_procs() matches each basename token ANCHORED (^(?:regex)$),
# so a substring can never satisfy it while an exact basename still does. E3 pins
# the reject with a UNIQUE token in the same substring shape (hermetic — no real proc
# stands in), E4 pins that an exact-token basename is still caught.
(
  set -e

  # === E3. basename anchor/boundary guard (W-080), hermetic. A basename that
  #         CONTAINS the token as a SUBSTRING but is not the token itself (the IGCC
  #         shape) must read compile_procs=0. Unique token `w081sub`, so neither a
  #         real toolchain proc nor the ambient fake rustc can pollute it. =========
  mkidle 42 WORKING no
  FAKE_SUBSTR="$(mkfakeproc "$TMP/w080_fakebin1" pre.w081sub.suffix.exe)"
  "$FAKE_SUBSTR" 10 &
  ICPID42=$!
  run_single_id 42 --windows 1 --timeout-sec 3 --proc-regex 'w081sub'
  kill "$ICPID42" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "E3 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "IDLE-DONE" \
    && fail "E3 must not report IDLE-DONE from a never-armed static fixture (W-082): $OUT"
  echo "$OUT" | grep -qF "compile_procs=0" \
    || fail "E3 a token-as-substring basename must read compile_procs=0, not a substring false-positive (W-080): $OUT"
  echo "$OUT" | grep -q "^RESULT: STALLED" \
    || fail "E3 with compile_procs correctly 0 and no activity ever, expected STALLED: $OUT"

  # === E4. exact-token still caught (W-080), hermetic. The anchor did not become a
  #         blanket "ignore anything containing the token" hole — a proc whose WHOLE
  #         basename IS the token is still counted -> BUILDING. ===================
  mkidle 43 WORKING no
  FAKE_EXACT="$(mkfakeproc "$TMP/w080_fakebin2" w081sub.exe)"
  "$FAKE_EXACT" 10 &
  GCPID43=$!
  run_single_id 43 --windows 1 --timeout-sec 3 --proc-regex 'w081sub(\.exe)?' --max-building-windows 10
  kill "$GCPID43" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "E4 exit was $RC (expected 0): $OUT"
  # (see the D4 NOTE above: keep the "grep || fail" positive-assertion form LAST.)
  echo "$OUT" | grep -q "IDLE-DONE" && fail "E4 IDLE-DONE must not fire while a token-named process runs: $OUT"
  echo "$OUT" | grep -q "^RESULT: BUILDING" \
    || fail "E4 an exact-token basename must still read BUILDING: $OUT"
) || exit 1

# The concurrency fixture did its job across E1-E4 (the compile_procs=0 guards held
# with a live fake rustc running); retire it before the inverted default-regex test.
kill "$AMBIENT_PID" 2>/dev/null || true; wait "$AMBIENT_PID" 2>/dev/null || true

# === E5. default-regex sanity, INVERTED for hermeticity (W-081). The original E5
#         asserted the DEFAULT regex reads compile_procs=0 against an IGCC-shaped
#         fake — but the default regex also matches every real toolchain basename,
#         so a concurrent cargo/rustc/gcc flipped it to BUILDING and fail()ed (the
#         W-081 miss). The IGCC-boundary property is now pinned hermetically by E3;
#         E5 instead pins the complementary, pollution-proof direction: the
#         unmodified DEFAULT regex CATCHES a real toolchain basename (a fake
#         rustc.exe) -> compile_procs>=1 -> BUILDING. A concurrent real compile can
#         only reinforce this, never break it. ====================================
(
  set -e
  mkidle 44 WORKING no
  FAKE_RUSTC5="$(mkfakeproc "$TMP/w081_e5" rustc.exe)"
  "$FAKE_RUSTC5" 10 &
  RCPID44=$!
  run_single_id 44 --windows 1 --timeout-sec 3 --max-building-windows 10
  kill "$RCPID44" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "E5 exit was $RC (expected 0): $OUT"
  # (see the D4 NOTE above: keep the "grep || fail" positive-assertion form LAST.)
  echo "$OUT" | grep -q "IDLE-DONE" && fail "E5 IDLE-DONE must not fire while a real toolchain process runs: $OUT"
  echo "$OUT" | grep -q "^RESULT: BUILDING" \
    || fail "E5 the DEFAULT PROC_REGEX must CATCH a real rustc.exe basename (>=1 -> BUILDING) (W-081 inverted): $OUT"
) || exit 1

# ── W-082: IDLE-DONE start-of-dispatch grace (arm-on-first-activity) ─────────
# field #339, IDLE-DONE's own day-one field bug: a producer fresh off dispatch
# that is still legitimately READING (premise-checking before its first edit —
# entirely normal, and can take a while for a design-heavy row) looks IDENTICAL
# to a genuinely-stalled one to a fingerprint-only rule: static, procs=0,
# STATE=WORKING. IDLE-DONE now only starts counting consecutive-static polls
# once the fingerprint has differed from the window's OWN t=0 baseline at least
# once (real activity observed DURING the watch's own observation) — D1 above
# already re-validates the "arms, then 2 static polls -> fires" path with an
# updated fixture; F1 here is the new, dedicated "never touched at all -> never
# fires" proof.
(
  set -e

  # === F1. STATE=WORKING, procs=0, worktree PERFECTLY static from the very first
  #         observation (the exact "still reading" shape, and the exact shape
  #         field #339's false positive had) -> IDLE-DONE must NOT fire, however
  #         many static polls pass -> falls through to the ordinary STALLED verdict
  #         at window end (full window consumed, no early exit). ================
  mkidle 50 WORKING no
  run_single_id 50 --windows 1 --timeout-sec 3 --proc-regex 'ZZZ_NO_MATCH'
  [ "$RC" -eq 0 ] || fail "F1 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "IDLE-DONE" \
    && fail "F1 a producer that has done NOTHING since dispatch must NOT read as a stall (W-082): $OUT"
  echo "$OUT" | grep -q "^RESULT: STALLED" \
    || fail "F1 with no activity ever observed, expected the ordinary STALLED verdict: $OUT"
  echo "$OUT" | grep -qF "poll 3 (" \
    || fail "F1 with IDLE-DONE correctly suppressed, the full 3-poll window should run (no early exit): $OUT"
) || exit 1

# ── W-090: IDLE-DONE proxy think/read-phase suppression (field #340) ──────────
# The two-static-poll IDLE-DONE trigger false-fired on a codex PROXY seat that was
# ALIVE but sitting between two compiles in a think/read phase: compile_procs was
# momentarily 0 and the checkout momentarily static, so the pre-W-090 fingerprint
# (commits | sig | worktree) went flat for two polls and IDLE-DONE killed a live
# producer (field #340, W-082's residual hole). W-090 folds report.md mtime /
# codex_last_message.md appearance / a COMMIT PLAN in report.md into a PROXY-ONLY
# activity fingerprint (proxyActivityRaw) so a live think phase RE-ARMS the counter
# (reads ADVANCING) instead of tripping IDLE-DONE — while a genuinely idle proxy
# seat (nothing moving, report.md included) STILL fires. The "procs returns > 0"
# recovery half of the row's AC is already pinned by D2/E2/E4 (a live compile keeps
# it BUILDING, never IDLE-DONE); these two branches pin the "report updates"
# recovery half and the still-fires control. Uses the $REPO/$SPR single-mode harness
# with a proxy context.json (commit_mode=proxy) so proxyActivityRaw is engaged.
mkidleproxy() {  # mkidleproxy <id> <status> — proxy container, real checkout, given status.
  local id="$1" status="$2" d
  d="$SPR/_dispatch$id"
  mkdir -p "$d"
  cp -r "$W075_TEMPLATE" "$d/checkout"
  printf '{"routing": {"commit_mode": "proxy", "model": "gpt-5.6-sol"}}\n' > "$d/context.json"
  printf '## Status\n\n%s\n' "$status" > "$d/STATE.md"
  printf '# report\n' > "$d/report.md"
}

(
  set -e

  # === G1. proxy seat ARMS via early checkout edits (~2.4s), then enters a
  #         think/read phase: checkout goes static + compile_procs 0, but the codex
  #         keeps re-touching report.md (mtime-only, content flat) — the exact live
  #         think-phase shape. IDLE-DONE must NOT fire; the window reads ADVANCING
  #         (proxy activity advanced). Pre-W-090 (report mtime invisible to the
  #         fingerprint) this false-fired IDLE-DONE around poll 4. ================
  mkidleproxy 60 WORKING
  (
    j=0; while [ $j -lt 12 ]; do date >> "$SPR/_dispatch60/checkout/f.txt" 2>/dev/null; sleep 0.2; j=$((j+1)); done
    j=0; while [ $j -lt 45 ]; do touch "$SPR/_dispatch60/report.md" 2>/dev/null; sleep 0.2; j=$((j+1)); done
  ) &
  PERT60=$!
  run_single_id 60 --windows 1 --timeout-sec 8 --proc-regex 'ZZZ_NO_MATCH'
  kill "$PERT60" 2>/dev/null || true; wait "$PERT60" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "G1 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "IDLE-DONE" \
    && fail "G1 a live proxy think phase (report.md mtime advancing) must NOT trip IDLE-DONE (W-090): $OUT"
  echo "$OUT" | grep -q "^RESULT: ADVANCING" \
    || fail "G1 proxy think phase with report activity should read ADVANCING, not STALLED/IDLE-DONE: $OUT"
  echo "$OUT" | grep -q "pa_moved=1" \
    || fail "G1 the proxy activity signal (pa_moved) never registered the report.md touches: $OUT"

  # === G2. proxy seat ARMS via early checkout edits (~2.4s), then EVERYTHING goes
  #         static (checkout, report.md, no codex_last_message) — a genuinely idle
  #         proxy seat. IDLE-DONE must STILL fire (W-090's signals suppress FALSE
  #         fires, they do not disable legit ones) and EARLY-EXIT (no full window). =
  mkidleproxy 61 WORKING
  ( j=0; while [ $j -lt 12 ]; do date >> "$SPR/_dispatch61/checkout/f.txt" 2>/dev/null; sleep 0.2; j=$((j+1)); done ) &
  PERT61=$!
  run_single_id 61 --windows 1 --timeout-sec 8 --proc-regex 'ZZZ_NO_MATCH'
  kill "$PERT61" 2>/dev/null || true; wait "$PERT61" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "G2 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -qF "poll 8 (" \
    && fail "G2 IDLE-DONE did not exit early (consumed the full 8-poll window): $OUT"
  echo "$OUT" | grep -q "^RESULT: IDLE-DONE" \
    || fail "G2 a genuinely idle proxy seat (report.md static too) must still fire IDLE-DONE (W-090 suppresses false fires only): $OUT"
) || exit 1

# ── W-097: malformed tool-call detection (MALFORMED-CALL verdict) ─────────────
# Opus 4.8 intermittently emits a broken assistant turn — stop_reason=tool_use with
# 0 tool_use blocks — and the turn JAMS. dispatch_watch tail-scans the producer's
# --transcript (JSONL) each poll: a malformed LATEST turn fires MALFORMED-CALL
# IMMEDIATELY (waiting cannot un-jam it) carrying the verbatim resend nudge; a clean
# transcript never fires, so a live proxy think phase (report.md advancing, no
# malformed signature) still reads ADVANCING — the "不検知" branch the AC requires.
# Fixtures use the Claude Code JSONL envelope ({type:assistant,message:{...}}).
MAL_FIX="$TMP/w097_malformed.jsonl"
printf '%s\n' \
  '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"go"}]}}' \
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Let me run the command."}],"stop_reason":"tool_use"}}' \
  > "$MAL_FIX"
CLEAN_FIX="$TMP/w097_clean.jsonl"
printf '%s\n' \
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Bash","input":{}}],"stop_reason":"tool_use"}}' \
  > "$CLEAN_FIX"

(
  set -e

  # === M1. malformed transcript -> MALFORMED-CALL, verbatim nudge, EARLY EXIT.
  #         Uses a proxy seat WITH live report.md activity to prove the malformed
  #         signature wins over an otherwise-ADVANCING think phase (the jam is real
  #         regardless of earlier activity). Fires on poll 1 -> never reaches poll 8. =
  mkidleproxy 70 WORKING
  ( j=0; while [ $j -lt 40 ]; do touch "$SPR/_dispatch70/report.md" 2>/dev/null; sleep 0.2; j=$((j+1)); done ) &
  PERT70=$!
  run_single_id 70 --windows 1 --timeout-sec 8 --proc-regex 'ZZZ_NO_MATCH' --transcript "$MAL_FIX"
  kill "$PERT70" 2>/dev/null || true; wait "$PERT70" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "M1 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -qF "malformed=1" || fail "M1 poll line never flagged malformed=1: $OUT"
  echo "$OUT" | grep -q "^RESULT: MALFORMED-CALL" || fail "M1 malformed transcript did not report MALFORMED-CALL: $OUT"
  echo "$OUT" | grep -qF "tool call 単独で再送" || fail "M1 MALFORMED-CALL missing the verbatim resend nudge: $OUT"
  echo "$OUT" | grep -qF "Opus 4.7" || fail "M1 MALFORMED-CALL missing the downgrade mitigation: $OUT"
  echo "$OUT" | grep -qF "poll 8 (" && fail "M1 MALFORMED-CALL did not exit early (consumed the full 8-poll window): $OUT"

  # === M2. clean transcript + live proxy think phase (report.md advancing) -> NOT
  #         MALFORMED; the window reads ADVANCING. The "think phase で不検知" branch. =
  mkidleproxy 71 WORKING
  (
    j=0; while [ $j -lt 12 ]; do date >> "$SPR/_dispatch71/checkout/f.txt" 2>/dev/null; sleep 0.2; j=$((j+1)); done
    j=0; while [ $j -lt 45 ]; do touch "$SPR/_dispatch71/report.md" 2>/dev/null; sleep 0.2; j=$((j+1)); done
  ) &
  PERT71=$!
  run_single_id 71 --windows 1 --timeout-sec 8 --proc-regex 'ZZZ_NO_MATCH' --transcript "$CLEAN_FIX"
  kill "$PERT71" 2>/dev/null || true; wait "$PERT71" 2>/dev/null || true
  [ "$RC" -eq 0 ] || fail "M2 exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "MALFORMED-CALL" && fail "M2 a clean transcript must NOT fire MALFORMED-CALL: $OUT"
  echo "$OUT" | grep -qF "malformed=0" || fail "M2 poll line should flag malformed=0 for a clean transcript: $OUT"
  echo "$OUT" | grep -q "^RESULT: ADVANCING" \
    || fail "M2 clean transcript + report activity should read ADVANCING, not MALFORMED/STALLED: $OUT"
) || exit 1

echo "dispatch_watch.test: all fleet branches pass (drain / gated-exclude / multi-watch / revive / usage)"
echo "dispatch_watch.test: all single-mode --windows branches pass (windows-1 single-shot / terminal-stops-early / building-re-arm / validation)"
echo "dispatch_watch.test: all W-075 proxy-seat branches pass (worktree-edit ADVANCING / edit+build ADVANCING / zero-signal RUNAWAY with caveat / self-mode unaffected)"
echo "dispatch_watch.test: all W-078(c) IDLE-DONE branches pass (early-exit wake / building-suppresses / register-suppresses / REPORTING overlay unchanged)"
echo "dispatch_watch.test: all W-079 compile_procs branches pass (sccache dropped / sibling toolchain still caught) — hermetic (W-081)"
echo "dispatch_watch.test: all W-080 compile_procs branches pass (token-substring basename rejected / exact-token caught / default-regex catches real toolchain) — hermetic (W-081)"
echo "dispatch_watch.test: all W-082 IDLE-DONE arming branches pass (never-touched never fires / activity-then-static still fires)"
echo "dispatch_watch.test: all W-090 IDLE-DONE proxy think-phase branches pass (report-activity think phase suppresses false fire / genuinely idle still fires)"
echo "dispatch_watch.test: all W-097 malformed tool-call branches pass (malformed transcript -> MALFORMED-CALL with resend nudge / clean transcript think phase -> ADVANCING, not detected)"
