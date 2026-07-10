#!/usr/bin/env bash
#
# fleet_watch.test.sh — pins fleet_watch.sh, the STANDING fleet stall watch (W-028).
#
# Fakes a pm-id's _dispatch<N> containers + runtime tree (its own throwaway
# __garelier), then asserts the loop's contract:
#   a. ACTIONABLE (a REPORTING dispatch with no register) -> one RESULT:
#      FLEET-ATTENTION line + detection JSON carrying the wake_cmd, exit 0, on the
#      FIRST scan (before any sleep).
#   b. CLEAN (empty pm) -> the loop keeps polling (does NOT exit immediately) and
#      exits RESULT: FLEET-CLEAR only when the --max-sec safety cap is reached.
#   c. MULTI-LAUNCH GUARD -> a live-owner lock makes a second launch refuse (exit 3).
#   d. STALE-LOCK RECLAIM -> a dead-owner lock is reclaimed and the watch proceeds.
#   e. SCAN-DELEGATED SUPPRESSION -> a register_received marker removes the idle
#      dispatch from the actionable set (misfire suppression is the scan's job).
#   f. DRIVER STOP FILE -> RESULT: FLEET-STOP, exit 0 (cooperates with self-stop).
#   g. USAGE -> missing --project / --pm-id is an arg error (exit 2).
# Plus the W-029 confirm/suppression race fixtures (via a fake contract_check):
#   - STABLE: 2 scans actionable + fingerprint unchanged -> FLEET-ATTENTION.
#   - FINGERPRINT MOVED between scans (editing / new commit) -> no fire.
#   - VANISHED off the confirm scan (procs=0 build-wait race) -> no fire.
#   - SUPPRESSION WINDOW: a fresh fire stamp -> the key is not re-flagged.
#
# Self-contained: run directly (`bash fleet_watch.test.sh`) or from ci.sh. Needs
# `bun` (the loop runs contract_check.ts --stall-scan). Exits 0 only if every
# branch holds. The clean/reclaim branches use --interval-sec 1 --max-sec 1 so the
# safety cap trips after the first poll (fast + deterministic).
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
FW="$SELF_DIR/fleet_watch.sh"
[ -f "$FW" ] || { echo "fleet_watch.test: cannot find fleet_watch.sh next to me" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "fleet_watch.test: 'bun' not on PATH — cannot run --stall-scan loop" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "  FAIL: $*" >&2; exit 1; }

PM="demo"
PR="$TMP/__garelier/$PM"
mkdir -p "$PR/_pm" "$PR/runtime/driver"

# mk <n> <status> <slug>: a minimal _dispatch<n> container (same shape as
# dispatch_watch.test.sh's fixtures).
mk() {
  local n="$1" status="$2" slug="$3" d="$PR/_dispatch$1"
  mkdir -p "$d/checkout"
  printf '# Dispatch #%s\n\n## Status\n\n%s\n\n## Current task\n\n#%s %s (br)\n' "$n" "$status" "$n" "$slug" > "$d/STATE.md"
  printf '# Report - #%s %s\n' "$n" "$slug" > "$d/report.md"
}
run() {  # run <extra-args...> -> sets OUT/RC
  set +e
  OUT="$(bash "$FW" --project "$TMP" --pm-id "$PM" "$@" 2>&1)"
  RC=$?
  set -e
}

(
  set -e

  # === a. ACTIONABLE: REPORTING with no register -> FLEET-ATTENTION after confirm ==
  # W-029: firing now takes a confirm scan (--confirm-delay-sec) — an unchanged
  # REPORTING dispatch survives it (2 scans actionable + fingerprint stable) and
  # fires. --confirm-delay-sec 1 keeps the test fast.
  mk 3 REPORTING feat-x
  run --confirm-delay-sec 1 --interval-sec 30 --max-sec 300
  [ "$RC" -eq 0 ] || fail "actionable exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-ATTENTION" || fail "no FLEET-ATTENTION on an idle-no-register dispatch: $OUT"
  echo "$OUT" | grep -q '"kind": "reporting-no-register"' || fail "detection JSON missing the idle_no_register item: $OUT"
  echo "$OUT" | grep -q '"wake_cmd"' || fail "detection JSON missing the wake_cmd (the PM's ready-to-send body): $OUT"
  echo "$OUT" | grep -q "idle_no_register=1" || fail "RESULT line missing the idle_no_register count: $OUT"
  # Confirm-then-fire exit: it fires in the confirm path, never after a clean poll.
  echo "$OUT" | grep -q "^poll " && fail "actionable case should fire in the confirm path, not after a poll-clear log: $OUT"
  rm -rf "$PR/_dispatch3"
  rm -f "$PR/runtime/driver/fleet_watch_state.json"   # the fire stamped a suppression entry

  # === c. MULTI-LAUNCH GUARD: a LIVE-owner lock -> refuse (exit 3) ================
  # A genuinely-live winpid (this box's tasklist / POSIX kill -0 both see it).
  sleep 30 & LIVE=$!; LWIN="$(cat "/proc/$LIVE/winpid" 2>/dev/null || echo "$LIVE")"
  printf '{"pid":%s,"host_pid":%s,"started":0,"last_poll":0,"interval_sec":300}\n' "$LWIN" "$LIVE" \
    > "$PR/runtime/driver/fleet_watch.lock"
  run --interval-sec 1 --max-sec 1
  kill "$LIVE" 2>/dev/null || true
  [ "$RC" -eq 3 ] || fail "live-lock second launch exit was $RC (expected 3): $OUT"
  echo "$OUT" | grep -q "already running" || fail "live-lock refusal missing the 'already running' message: $OUT"

  # === d. STALE-LOCK RECLAIM: a DEAD-owner lock -> reclaim + proceed to FLEET-CLEAR
  printf '{"pid":999999,"host_pid":999999,"started":0,"last_poll":0,"interval_sec":300}\n' \
    > "$PR/runtime/driver/fleet_watch.lock"
  run --interval-sec 1 --max-sec 1
  [ "$RC" -eq 0 ] || fail "stale-reclaim exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "reclaiming stale lock" || fail "stale lock was not reclaimed: $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-CLEAR" || fail "reclaim did not proceed to a clean watch: $OUT"

  # === b. CLEAN: the loop POLLS then caps (does not exit immediately) =============
  # Empty pm, tiny cap. It must log at least one poll-clear line and end FLEET-CLEAR
  # (proving it is a loop, not a one-shot). Lock is free again after (d) exited.
  run --interval-sec 1 --max-sec 1
  [ "$RC" -eq 0 ] || fail "clean exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^poll 1 " || fail "clean watch did not log a poll cycle (not looping?): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-CLEAR" || fail "clean watch did not end FLEET-CLEAR at the cap: $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-ATTENTION" && fail "clean watch must not raise FLEET-ATTENTION: $OUT"

  # === e. SCAN-DELEGATED SUPPRESSION: register_received removes the idle dispatch ==
  mk 4 REPORTING feat-y
  touch "$PR/_dispatch4/register_received"      # PM already processed the register
  run --interval-sec 1 --max-sec 1
  [ "$RC" -eq 0 ] || fail "suppressed exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-CLEAR" \
    || fail "a register_received-marked REPORTING was not suppressed (scan delegation broken): $OUT"
  rm -rf "$PR/_dispatch4"

  # === f. DRIVER STOP FILE -> FLEET-STOP =========================================
  touch "$PR/runtime/driver/stop"
  run --interval-sec 1 --max-sec 30
  rm -f "$PR/runtime/driver/stop"
  [ "$RC" -eq 0 ] || fail "stop-file exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-STOP" || fail "driver stop file did not stop the watch: $OUT"

  # === g. USAGE: missing required args -> exit 2 =================================
  set +e
  bash "$FW" --pm-id "$PM" >/dev/null 2>"$TMP/err"; RCM=$?
  set -e
  [ "$RCM" -eq 2 ] || fail "missing --project exit was $RCM (expected 2)"
  grep -q "required" "$TMP/err" || fail "missing-arg usage hint absent: $(cat "$TMP/err")"

  # === W-029: CONFIRM + SUPPRESSION race fixtures ================================
  # Drive scan1 != scan2 deterministically via a FAKE contract_check
  # (GARELIER_CONTRACT_CHECK_TS) returning canned --stall-scan JSON keyed on an
  # invocation counter — no git, no process table, no timing flake. The fake reports
  # one idle_no_register dispatch (#7); the scenario controls whether the confirm
  # scan still sees it and whether its items[] fingerprint moved.
  FAKE="$TMP/fake_cc.js"
  cat > "$FAKE" <<'JS'
const fs = require("fs");
const cf = process.env.FAKE_CC_COUNT_FILE;
let n = 0; try { n = parseInt(fs.readFileSync(cf, "utf8").trim(), 10) || 0; } catch {}
n += 1; try { fs.writeFileSync(cf, String(n)); } catch {}
const scenario = process.env.FAKE_CC_SCENARIO || "stable";
const idleItem = { dispatch: "7", state: "REPORTING", role: null, kind: "reporting-no-register", wake_cmd: { to: "ga-produce-feat-z", message: "wake #7" } };
const mk = (idlePresent, tip) => ({
  ok: false, mode: "stall-scan",
  items: [{ dispatch: "7", state: "REPORTING", commits: null, dirty: false, dirty_hash: "DH", tip_sha: tip, background: "none", judgement: "ungated-reporting", watch: "watched" }],
  unwatched: [], unprocessed_results: [], idle_no_register: idlePresent ? [idleItem] : [],
});
let out;
if (scenario === "vanish") out = mk(n === 1, "T1");                      // idle only on the FIRST scan (build-wait reappeared)
else if (scenario === "fpchange") out = mk(true, n === 1 ? "T1" : "T2"); // fingerprint MOVES between the two scans
else out = mk(true, "T1");                                              // stable: same idle + fingerprint on both scans
process.stdout.write(JSON.stringify(out));
JS
  runf() {  # runf <scenario> <count-file> <extra-args...> -> sets OUT/RC
    local scen="$1" cfile="$2"; shift 2
    set +e
    OUT="$(GARELIER_CONTRACT_CHECK_TS="$FAKE" FAKE_CC_SCENARIO="$scen" FAKE_CC_COUNT_FILE="$cfile" \
      bash "$FW" --project "$TMP" --pm-id "$PM" "$@" 2>&1)"
    RC=$?
    set -e
  }
  SFILE="$PR/runtime/driver/fleet_watch_state.json"

  # (b) STABLE: two scans actionable + fingerprint unchanged -> FIRE.
  rm -f "$SFILE"
  runf stable "$TMP/c_stable" --confirm-delay-sec 1 --interval-sec 5 --max-sec 5
  [ "$RC" -eq 0 ] || fail "W-029 stable exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-ATTENTION" || fail "W-029 stable did not fire on a confirmed-stable dispatch: $OUT"
  echo "$OUT" | grep -q "confirm 済" || fail "W-029 stable RESULT missing the confirm marker: $OUT"

  # (a) FINGERPRINT MOVED between the two scans (still editing / a new commit) -> NO fire.
  rm -f "$SFILE"
  runf fpchange "$TMP/c_fp" --confirm-delay-sec 1 --interval-sec 1 --max-sec 1
  [ "$RC" -eq 0 ] || fail "W-029 fpchange exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-ATTENTION" && fail "W-029 fpchange fired despite a moved fingerprint (progress): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-CLEAR" || fail "W-029 fpchange did not fall through to a clean cap: $OUT"

  # (d) VANISHED off the confirm scan (the procs=0 build-wait race) -> NO fire.
  rm -f "$SFILE"
  runf vanish "$TMP/c_van" --confirm-delay-sec 1 --interval-sec 1 --max-sec 1
  [ "$RC" -eq 0 ] || fail "W-029 vanish exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-ATTENTION" && fail "W-029 vanish fired despite dropping off the confirm scan (build-wait race): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-CLEAR" || fail "W-029 vanish did not fall through to a clean cap: $OUT"

  # (c) SUPPRESSION WINDOW: a fresh fire stamp for the same key -> NOT re-flagged.
  printf '{"idle:7":%s}\n' "$(date +%s)" > "$SFILE"
  runf stable "$TMP/c_supp" --confirm-delay-sec 1 --suppress-min 15 --interval-sec 1 --max-sec 1
  [ "$RC" -eq 0 ] || fail "W-029 suppression exit was $RC (expected 0): $OUT"
  echo "$OUT" | grep -q "^RESULT: FLEET-ATTENTION" && fail "W-029 suppression re-flagged a key inside its window: $OUT"
  echo "$OUT" | grep -q "suppression window" || fail "W-029 suppression did not log the window skip: $OUT"
  rm -f "$SFILE"
) || exit 1

echo "fleet_watch.test: all branches pass (actionable / clean-cap / lock-guard / stale-reclaim / scan-suppression / stop-file / usage / W-029 confirm+fingerprint+suppression)"
