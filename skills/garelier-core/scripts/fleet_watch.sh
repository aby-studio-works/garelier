#!/usr/bin/env bash
#
# fleet_watch.sh — the STANDING fleet stall watch (W-028). A permanent loop that
# closes the three STRUCTURAL causes of an unattended stall (the "stalled 5×/day"
# root-cause analysis, user 2026-07-07):
#   1. a sub-agent is run-to-completion — after its turn ends it is NOT re-invoked
#      until an external message arrives (no self-continuation), so a producer that
#      went idle/REPORTING-without-register waits silently until someone asks;
#   2. dispatch_watch.sh is a SINGLE finite run — after its --windows expire (or
#      its --fleet --max-run window ends) it EXITS and, unless re-armed, nothing
#      watches the fleet at all (the overnight failure, 2026-07-06); and
#   3. the scan → wake step was a MANUAL PM chore no timer enforced.
#
# The fix is one standing loop per pm-id that periodically runs the detective
# (`contract_check.ts --stall-scan`) and, the moment it finds ACTIONABLE work,
# prints a single `RESULT: FLEET-ATTENTION` line + the detection JSON (wake_cmd
# included) and EXITS 0 — which re-invokes the operator (the PM is woken by the
# run_in_background completion notification). The PM runs the wake_cmd(s), then
# re-arms this watch. When nothing is actionable it sleeps and loops again, so it
# NEVER becomes unmonitored by expiry (cause #2): the ONLY exits are an actionable
# finding, the driver stop file, or a `--max-hours` safety cap (re-arm after each).
#
# RELATION TO dispatch_watch.sh (W-071 --fleet). No third watchdog — different job:
#   - dispatch_watch --fleet is a FINITE dormancy sweep with its OWN git-fingerprint
#     progress logic + a --max-run window; it EXITS HEALTHY after the window even
#     with nothing wrong, and must be re-armed to keep watching (cause #2 for it).
#   - fleet_watch is a PERMANENT loop that owns NO stall logic of its own: it
#     delegates 100% of the classification (build-wait vs genuine stall, ungated
#     REPORTING, idle-no-register, unprocessed result, unwatched) to the single
#     anomaly taxonomy in contract_check.ts --stall-scan. Misfire suppression is
#     therefore fully the scan's job — build-wait / unknown NEVER reach the
#     actionable set (they are excluded upstream, W-018 / W-053), so this loop
#     cannot false-wake a healthy cold build. The two compose: arm a per-producer
#     dispatch_watch (single mode) for a HEAVY producer's close RUNAWAY-compensated
#     window; keep ONE fleet_watch standing as the net that catches a watch that
#     was forgotten or expired (surfaced here as `unwatched`).
#
# ACTIONABLE = any of the three --stall-scan arrays is non-empty:
#   - idle_no_register  (W-018) — an idle dispatch with no processed register:
#       REPORTING-done-but-unregistered, a genuinely stalled WORKING, or a gate
#       role whose verdict never arrived. Each carries a ready-to-send wake_cmd.
#   - unprocessed_results (W-086) — a landed merge whose workbench branch was never
#       cleaned up (a forgotten result waiter left the aftercare stalled).
#   - unwatched (W-085) — a WORKING dispatch with NO live dispatch_watch heartbeat
#       (never armed, or its single watch EXPIRED and went stale — exactly cause #2).
# Advisory detectives only — this loop never invents a verdict; it relays the
# scan's. session_resume / unconsumed_instructions are reported by --stall-scan in
# its own output but are not part of THIS loop's exit trigger (kept to the three
# the wake protocol acts on).
#
# WAKE-SPAM SUPPRESSION (W-029). A single --stall-scan is a point-in-time probe, so
# it flaps against two producer races (day-one field data: of 5 wakes only 1 was a
# real stall): (a) a heavy producer whose build process is momentarily between
# invocations reads as procs=0 → a build-wait misfires as a stall; (b) a producer
# actively editing (its dirty tree still growing) reads as an idle stall-suspect.
# Three guards close them, ALL owned by THIS loop (contract_check stays a stateless
# single-shot detective — the temporal "compare two scans" belongs here):
#   1. CONFIRM (--confirm-delay-sec, default 60). An actionable finding does NOT
#      fire immediately; the loop waits the delay, RE-scans, and fires only for the
#      dispatches STILL actionable AND whose fingerprint is unchanged. A build-wait
#      that flickered procs=0 is gone from the confirm scan (procs>0 again → not in
#      idle_no_register) so it drops — the "2 回とも procs=0 の時だけ" rule.
#   2. FINGERPRINT = the scan's own items[].tip_sha + dirty_hash (+ dirty) for the
#      dispatch. If it MOVED between the two scans the producer made progress (a new
#      commit, or the dirty tree grew = still editing) → NOT a stall → dropped. This
#      is the "dirty 増加は進行中扱い" rule, keyed on data --stall-scan already emits.
#   3. SUPPRESSION WINDOW (--suppress-min, default 15). After a dispatch fires, its
#      key is stamped in runtime/driver/fleet_watch_state.json; for the next window
#      the loop will not re-flag it (the manual "I already woke that one" judgement,
#      mechanized). Keys are pruned once past the window so the file stays small.
# unprocessed_results carry no checkout fingerprint (a landed-merge structural fact,
# not a flapping probe); they confirm on presence-in-both-scans + the window alone.
#
# MULTI-LAUNCH GUARD. runtime/driver/fleet_watch.lock holds the owner pid; a second
# launch refuses (exit 3) while the owner is alive, and RECLAIMS a stale lock whose
# owner pid is dead (W-024 liveness rule). The pid stored is the WINDOWS-checkable
# winpid (Git-Bash `/proc/$$/winpid`, falling back to `$$` on native Linux/macOS)
# so the liveness probe works on Windows too.
#
# Usage:
#   fleet_watch.sh --project <root> --pm-id <id>
#                  [--interval-sec N] [--max-hours H] [--unwatched-after MIN]
#                  [--confirm-delay-sec D] [--suppress-min M]
#                  [--max-sec S]   (precise/test override of --max-hours)
# Defaults: --interval-sec 300  --max-hours 12  --confirm-delay-sec 60
#           --suppress-min 15. --unwatched-after is passed through to contract_check
# (its default 60 min applies when omitted). Always exits 0 on a RESULT line
# (FLEET-ATTENTION / FLEET-CLEAR / FLEET-STOP); exit 2 = arg error;
# exit 3 = a live fleet_watch already owns the lock.
set -euo pipefail

PROJECT="" PM="" INTERVAL_SEC=300 MAX_HOURS=12 MAX_SEC="" UNWATCHED_AFTER=""
CONFIRM_DELAY_SEC=60 SUPPRESS_MIN=15
while [ $# -gt 0 ]; do
  case "$1" in
    --project)          PROJECT="${2:?}"; shift 2 ;;
    --pm-id)            PM="${2:?}"; shift 2 ;;
    --interval-sec)     INTERVAL_SEC="${2:?}"; shift 2 ;;
    --max-hours)        MAX_HOURS="${2:?}"; shift 2 ;;
    --max-sec)          MAX_SEC="${2:?}"; shift 2 ;;
    --unwatched-after)  UNWATCHED_AFTER="${2:?}"; shift 2 ;;
    --confirm-delay-sec) CONFIRM_DELAY_SEC="${2:?}"; shift 2 ;;
    --suppress-min)     SUPPRESS_MIN="${2:?}"; shift 2 ;;
    -h|--help)          sed -n '2,89p' "$0"; exit 0 ;;
    *) echo "fleet_watch: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] || { echo "fleet_watch: --project and --pm-id are required" >&2; exit 2; }
case "$INTERVAL_SEC" in (''|*[!0-9]*) echo "fleet_watch: --interval-sec must be a positive integer" >&2; exit 2 ;; esac
[ "$INTERVAL_SEC" -ge 1 ] || { echo "fleet_watch: --interval-sec must be >= 1" >&2; exit 2; }
case "$CONFIRM_DELAY_SEC" in (''|*[!0-9]*) echo "fleet_watch: --confirm-delay-sec must be a non-negative integer" >&2; exit 2 ;; esac
case "$SUPPRESS_MIN" in (''|*[!0-9]*) echo "fleet_watch: --suppress-min must be a non-negative integer" >&2; exit 2 ;; esac
case "$MAX_SEC" in
  '') ;;
  *[!0-9]*) echo "fleet_watch: --max-sec must be a positive integer" >&2; exit 2 ;;
  *) [ "$MAX_SEC" -ge 1 ] || { echo "fleet_watch: --max-sec must be >= 1" >&2; exit 2; } ;;
esac
command -v bun >/dev/null 2>&1 || { echo "fleet_watch: 'bun' not found on PATH" >&2; exit 2; }

PM_ROOT="$PROJECT/__garelier/$PM"
# contract_check.ts entry (DEC-053-style override for tests / plugin cache).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CC="${GARELIER_CONTRACT_CHECK_TS:-$SCRIPT_DIR/../driver/src/dispatch/contract_check.ts}"
MAX_SEC="${MAX_SEC:-$(( MAX_HOURS * 3600 ))}"
SUPPRESS_SEC=$(( SUPPRESS_MIN * 60 ))
STOP_FILE="$PM_ROOT/runtime/driver/stop"
# W-029 per-fire suppression state: dispatch/result key -> last-fire epoch seconds.
STATE_FILE="$PM_ROOT/runtime/driver/fleet_watch_state.json"

# ── liveness (W-024) ──────────────────────────────────────────────────────────
# Store a Windows-checkable winpid so a waiter on Windows can verify it (MSYS `$$`
# is invisible to tasklist); fall back to `$$` on native Linux/macOS where the two
# pid spaces coincide. Mirrors merge-gate.sh's MG_OWNER_PID idiom.
OWNER_PID="$(cat "/proc/$$/winpid" 2>/dev/null || echo $$)"
is_windows() { case "$(uname -s 2>/dev/null)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac; }
pid_alive() {  # <pid> — mirrors start_status.sh: tasklist on Windows, kill -0 elsewhere.
  [ -n "$1" ] || return 1
  if is_windows; then tasklist //FI "PID eq $1" 2>/dev/null | grep -qw "$1"
  else kill -0 "$1" 2>/dev/null; fi
}

LOCK_DIR="$PM_ROOT/runtime/driver"
LOCK="$LOCK_DIR/fleet_watch.lock"
write_lock() {  # (re)write our ownership + a last-poll ts. Best-effort.
  mkdir -p "$LOCK_DIR" 2>/dev/null || true
  printf '{"pid":%s,"host_pid":%s,"started":%s,"last_poll":%s,"interval_sec":%s}\n' \
    "$OWNER_PID" "$$" "$START" "$(date +%s)" "$INTERVAL_SEC" > "$LOCK" 2>/dev/null || true
}
# Release ONLY if the lock is still ours (never yank a lock a reclaimer took).
release_lock() {
  local held
  held="$(grep -oE '"pid":[[:space:]]*[0-9]+' "$LOCK" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  [ -n "$held" ] && [ "$held" = "$OWNER_PID" ] && rm -f "$LOCK" 2>/dev/null || true
}

START="$(date +%s)"

# Multi-launch guard: refuse while a live owner holds the lock; reclaim a stale one.
if [ -f "$LOCK" ]; then
  EXISTING="$(grep -oE '"pid":[[:space:]]*[0-9]+' "$LOCK" 2>/dev/null | grep -oE '[0-9]+' | head -1)"
  if [ -n "$EXISTING" ] && pid_alive "$EXISTING"; then
    echo "fleet_watch: already running for pm '$PM' (owner pid $EXISTING). Stop it first, or wait for its RESULT." >&2
    exit 3
  fi
  echo "fleet_watch: reclaiming stale lock (owner pid ${EXISTING:-?} not alive)" >&2
  rm -f "$LOCK" 2>/dev/null || true
fi
write_lock
trap 'release_lock' EXIT INT TERM

# ── actionable decision + confirm/suppression helper (W-028 + W-029) ───────────
# One embedded bun program with three ops (FW_OP), so the shell stays dumb and the
# set/fingerprint/suppression logic lives in one testable place. Single-quoted so
# bash performs no expansion — the backticks/${…} are the program's own template
# literals.
#   keys   — env FW_SCAN: print the actionable keys of a --stall-scan JSON, one per
#            line (idle:<d> / unwatched:<d> / unproc:<request_id>). exit 0 any, 1
#            none, 2 unreadable.
#   filter — stdin candidate keys: print those NOT inside their post-fire
#            suppression window (still worth confirming). exit 0; empty = all
#            suppressed. env FW_STATE_FILE / FW_NOW / FW_SUPPRESS_SEC.
#   decide — env FW_SCAN1 (initial) + FW_SCAN2 (confirm) + FW_ALLOWED (candidate
#            keys) + state: survivors = still actionable on the confirm scan AND
#            fingerprint (items[].tip_sha|dirty_hash|dirty) unchanged AND not
#            suppressed. Stamps each survivor's fire time, prunes the window, and
#            renders the RESULT line + filtered JSON. exit 0 fire, 1 nothing.
FW_JS='
const fs = require("fs");
const op = process.env.FW_OP;
const arr = (x) => (Array.isArray(x) ? x : []);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
// Actionable keys. idle_no_register + unwatched are dispatch-keyed (they carry an
// items[] fingerprint); unprocessed_results is request-keyed (a structural fact
// with no per-scan fingerprint — it confirms on presence + the window alone).
function keysOf(d) {
  const ks = [];
  for (const it of arr(d.idle_no_register)) ks.push("idle:" + it.dispatch);
  for (const u of arr(d.unwatched)) ks.push("unwatched:" + String(u));
  for (const u of arr(d.unprocessed_results)) ks.push("unproc:" + u.request_id);
  return ks;
}
// dispatch -> "tip|dirtyHash|dirty" from items[] — the fingerprint gate 2 keys on:
// a moved tip = a new commit landed, a moved dirty_hash = the tree changed (still
// editing). Both are progress, so a moved fingerprint is NOT a stall.
function fpMap(d) {
  const m = {};
  for (const it of arr(d.items)) m[String(it.dispatch)] = `${it.tip_sha ?? ""}|${it.dirty_hash ?? ""}|${it.dirty ?? ""}`;
  return m;
}
function fpOf(key, m) {
  const mm = /^(?:idle|unwatched):(.+)$/.exec(key);
  return mm ? (m[mm[1]] ?? "") : "";   // request-keyed key -> "" (no fingerprint)
}
function loadState() {
  const p = process.env.FW_STATE_FILE;
  if (!p || !fs.existsSync(p)) return {};
  try { const s = JSON.parse(fs.readFileSync(p, "utf8")); return (s && typeof s === "object") ? s : {}; } catch { return {}; }
}
const now = Number(process.env.FW_NOW || 0);
const supp = Number(process.env.FW_SUPPRESS_SEC || 0);
const suppressed = (state, k) => supp > 0 && typeof state[k] === "number" && (now - state[k]) < supp;

if (op === "keys") {
  const d = readJson(process.env.FW_SCAN);
  if (d === null) process.exit(2);
  const ks = keysOf(d);
  if (ks.length === 0) process.exit(1);
  console.log(ks.join("\n"));
  process.exit(0);
}

if (op === "filter") {
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch {}
  const state = loadState();
  const out = input.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).filter((k) => !suppressed(state, k));
  if (out.length) console.log(out.join("\n"));
  process.exit(0);
}

if (op === "decide") {
  const s1 = readJson(process.env.FW_SCAN1), s2 = readJson(process.env.FW_SCAN2);
  if (s1 === null || s2 === null) process.exit(1);
  const allowed = (process.env.FW_ALLOWED || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const keys2 = new Set(keysOf(s2));
  const fp1 = fpMap(s1), fp2 = fpMap(s2);
  const state = loadState();
  const survivors = allowed.filter((k) => keys2.has(k) && fpOf(k, fp1) === fpOf(k, fp2) && !suppressed(state, k));
  if (survivors.length === 0) process.exit(1);
  const sset = new Set(survivors);
  for (const k of survivors) state[k] = now;                    // stamp this fire (W-029 gate 3)
  for (const k of Object.keys(state)) {                         // drop entries past the window
    if (typeof state[k] !== "number" || (supp > 0 && (now - state[k]) >= supp)) delete state[k];
  }
  try { if (process.env.FW_STATE_FILE) fs.writeFileSync(process.env.FW_STATE_FILE, JSON.stringify(state) + "\n"); } catch {}
  const idle = arr(s2.idle_no_register).filter((it) => sset.has("idle:" + it.dispatch));
  const up = arr(s2.unprocessed_results).filter((u) => sset.has("unproc:" + u.request_id));
  const uw = arr(s2.unwatched).filter((u) => sset.has("unwatched:" + String(u)));
  const n = idle.length + up.length + uw.length;
  console.log(
    `RESULT: FLEET-ATTENTION — idle_no_register=${idle.length} unprocessed_results=${up.length} unwatched=${uw.length} (計 ${n} 件、confirm 済 = 2 scan 連続 actionable + fingerprint 不変)。` +
    `下記 JSON の各 wake_cmd を SendMessage で送り、処理後に該当 _dispatch<N>/register_received を touch。unprocessed_results は dispatch_cleanup.sh、` +
    `unwatched は該当 dispatch に dispatch_watch を arm。その後 fleet watch を再 arm してください。`
  );
  console.log(JSON.stringify({ attention: n, idle_no_register: idle, unprocessed_results: up, unwatched: uw }, null, 2));
  process.exit(0);
}

process.exit(2);
'

SCAN1_FILE="$(mktemp)"
SCAN2_FILE="$(mktemp)"
trap 'release_lock; rm -f "$SCAN1_FILE" "$SCAN2_FILE" 2>/dev/null || true' EXIT INT TERM

# One --stall-scan into $1. Capture regardless of exit code: --stall-scan exits 3
# when a genuine stall is present (advisory), which is NOT a failure — the JSON is
# still valid and the keys/decide ops are the sole judges of readability.
run_scan() {
  set +e
  local out="$1"
  local args=(--pm-id "$PM" --project "$PROJECT" --stall-scan --format json)
  [ -n "$UNWATCHED_AFTER" ] && args+=(--unwatched-after "$UNWATCHED_AFTER")
  bun "$CC" "${args[@]}" > "$out" 2>/dev/null
  set -e
}

# Emitted just before exiting when the driver asked us to stop mid-cycle.
stop_now() {
  echo "RESULT: FLEET-STOP — driver stop file present ($STOP_FILE); fleet watch exiting (re-arm after clearing stop)."
  exit 0
}

echo "fleet_watch: pm=$PM interval=${INTERVAL_SEC}s max=${MAX_SEC}s confirm=${CONFIRM_DELAY_SEC}s suppress=${SUPPRESS_MIN}min (standing stall watch — delegates classification to contract_check --stall-scan)"
# ARM DISCIPLINE (W-032, 2026-07-07 field data). This loop signals FLEET-ATTENTION
# by EXITING; only a harness-tracked launch (run_in_background) turns that exit into
# a completion notification that wakes the PM. A shell '&' background job is NOT
# harness-tracked — its exit reaches no one, so the net goes silent exactly like the
# hole this watch was built to close. We cannot reliably tell from inside which way
# we were launched (a '&' job and a run_in_background job look identical here), so
# this is an unconditional reminder rather than a detector — per pm_field_manual §1.
echo "fleet_watch: launch me under the harness run_in_background, NEVER a shell '&' — a '&' job is untracked so my FLEET-ATTENTION exit never wakes the PM and the watch net goes silent (2026-07-07)." >&2

cycle=0
while :; do
  cycle=$(( cycle + 1 ))

  # Cooperate with the driver stop file: a stop request halts self-driving, so a
  # driver-managed fleet_watch must exit cleanly rather than loop past a stop.
  [ -f "$STOP_FILE" ] && stop_now

  note=""   # poll-tail annotation when a candidate was seen but not fired

  run_scan "$SCAN1_FILE"
  set +e
  KEYS1="$(FW_OP=keys FW_SCAN="$SCAN1_FILE" bun -e "$FW_JS" 2>/dev/null)"
  krc=$?
  set -e

  if [ "$krc" -eq 2 ]; then
    echo "fleet_watch: scan output unreadable this cycle (keys rc=2) — skipping, will retry" >&2
  elif [ "$krc" -eq 0 ]; then
    # Actionable on the initial scan. First drop keys still inside their post-fire
    # suppression window (W-029 gate 3) BEFORE spending a confirm delay on them.
    set +e
    ALLOWED="$(printf '%s\n' "$KEYS1" | FW_OP=filter FW_STATE_FILE="$STATE_FILE" FW_NOW="$(date +%s)" FW_SUPPRESS_SEC="$SUPPRESS_SEC" bun -e "$FW_JS" 2>/dev/null)"
    set -e
    if [ -z "$(printf '%s' "$ALLOWED" | tr -d '[:space:]')" ]; then
      note="actionable だが全 key が suppression window 内 (${SUPPRESS_MIN}min) — skip"
    else
      kcount="$(printf '%s\n' "$ALLOWED" | grep -c . || true)"
      echo "fleet_watch: actionable detected (${kcount} key) — ${CONFIRM_DELAY_SEC}s 後に再確認して発火判定 (W-029 confirm)"
      # Honour the stop file across the confirm delay, not just at cycle top.
      [ -f "$STOP_FILE" ] && stop_now
      if [ "$CONFIRM_DELAY_SEC" -gt 0 ]; then sleep "$CONFIRM_DELAY_SEC"; fi
      [ -f "$STOP_FILE" ] && stop_now
      run_scan "$SCAN2_FILE"
      set +e
      OUT="$(FW_OP=decide FW_SCAN1="$SCAN1_FILE" FW_SCAN2="$SCAN2_FILE" FW_ALLOWED="$ALLOWED" FW_STATE_FILE="$STATE_FILE" FW_NOW="$(date +%s)" FW_SUPPRESS_SEC="$SUPPRESS_SEC" bun -e "$FW_JS" 2>/dev/null)"
      drc=$?
      set -e
      if [ "$drc" -eq 0 ]; then
        printf '%s\n' "$OUT"
        exit 0                       # FIRE — confirmed actionable over two scans
      fi
      note="confirm で settle/変化 (race) — 発火せず継続"
    fi
  fi

  write_lock  # refresh last_poll (liveness observability)
  now="$(date +%s)"
  elapsed=$(( now - START ))
  if [ -n "$note" ]; then
    echo "poll $cycle (~${elapsed}s): $note — next in ${INTERVAL_SEC}s"
  else
    echo "poll $cycle (~${elapsed}s): clear (idle_no_register / unprocessed_results / unwatched すべて 0) — next in ${INTERVAL_SEC}s"
  fi

  if [ "$elapsed" -ge "$MAX_SEC" ]; then
    echo "RESULT: FLEET-CLEAR — watched ${elapsed}s (safety cap ${MAX_SEC}s) with nothing actionable; re-arm the fleet watch to keep watching."
    exit 0
  fi
  sleep "$INTERVAL_SEC"
done
