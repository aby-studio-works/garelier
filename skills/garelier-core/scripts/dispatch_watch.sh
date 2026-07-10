#!/usr/bin/env bash
#
# dispatch_watch.sh — reactive stall backstop for a heavy producer dispatch
# (DEC-091, defense-in-depth behind the preventive measures). A sub-agent is
# run-to-completion: a build it detaches does NOT re-invoke it, so a producer that
# detaches a long compile and goes idle STALLS silently. The preventive fix is a
# warm cache + crate-scoped foreground gate (DEC-091); this is the backstop for
# when a producer stalls anyway.
#
# Two modes, ONE home (W-071 — no third watchdog implementation):
#   single  (default) — watch ONE producer (--id or --branch); detailed RUNAWAY
#                       compensation (hard ceiling + output-bloat).
#   --fleet           — watch EVERY live dispatch under a pm-id in one process
#                       (WORKING / REWORK, plus ungated REPORTING — the W-086
#                       blind spot). Loud, durable dormancy sweep + drain.
#
# The OPERATOR (main session — stall-immune) runs this in the background right
# after dispatching a heavy producer (single mode) or once per pm-id to watch the
# whole fleet (--fleet). It polls git-observable progress and the host's compile
# activity, then EXITS (re-invoking the operator) with a clear RESULT line. The
# verdict vocabulary is the SINGLE anomaly taxonomy defined in
# role_subagent_dispatch.md §6 (PROGRESS / ADVANCING / BUILDING / STALLED /
# RUNAWAY / REVIVE-NEEDED / IDLE-NO-REGISTER) — dispatch_watch and contract_check
# --stall-scan speak the same terms:
#   PROGRESS      — a NEW commit landed on the branch since the watch started (the
#                   producer is finishing; check for REPORTING)
#   ADVANCING     — no new commit and no live compile at the timeout, but STATE.md/
#                   report.md advanced during the window (uncommitted forward
#                   progress — NOT a detach-and-idle stall; re-run the watch)
#   BUILDING      — still compiling at timeout (re-run the watch for another window)
#   STALLED       — no new commit, no STATE/report change, no live compile after the
#                   timeout (warm-resume or re-dispatch the producer; cache is warm)
#   RUNAWAY       — a runaway safety trip (W-077). Because budget-read + message-wake
#                   lets a job outlive the bash-timeout ceiling that normally caps a
#                   runaway, the operator compensates with cheap runaway checks here:
#                   (a) HARD CEILING — BUILDING for --max-building-windows consecutive
#                       windows (default 3; a healthy cold build should have committed
#                       by then) — do NOT wait forever on infinite BUILDING; and
#                   (b) OUTPUT BLOAT — an opt-in --output-file grew past --max-output-mb
#                       with no STATE/report progress (a job writing without advancing;
#                       the log-fills-the-SSD precedent). On RUNAWAY the operator kills
#                       the producer's process group, marks the job FAILED, and checks
#                       for orphaned build procs (compile_procs in the poll lines)
#                       before re-dispatch — never masks it as success.
#   REVIVE-NEEDED — (--fleet) sustained dormancy: no git-observable progress (HEAD +
#                   STATE/report hash unchanged) for >= the stall threshold AND no
#                   build/verify process anywhere. A STALLED that stayed flat is a
#                   DORMANT producer — respawn it FRESH from its worktree (a /resume
#                   does NOT restore an in-process teammate — official). Distinct from
#                   STALLED (one flat window) so a truly dead producer is not merely
#                   nudged forever.
#   IDLE-NO-REGISTER — (single mode, needs --id) the watched producer reached REPORTING
#                   but the PM never processed its completion register (no
#                   register_received marker). It is DONE-but-unregistered — a WAKE, not
#                   a respawn: wake it to send the final register (a gate role: its
#                   verdict register), or process the register and touch the marker. It
#                   overrides the window verdict so a finished producer is not read as a
#                   PROGRESS/STALLED to re-arm on. The detective twin is contract_check
#                   --stall-scan's idle_no_register (W-018, same marker convention).
#
# Progress is judged by GIT-OBSERVABLE forward movement only — a new commit
# beyond the branch tip captured at the FIRST observation (baseline), or a change
# in the content hash of the dispatch's STATE.md/report.md (fleet mode combines the
# two into a per-dispatch fingerprint: HEAD sha | hash(STATE.md + report.md)). It
# is NEVER reset by a bare liveness ping or a file mtime: a ping does not prove
# progress and letting it reset the clock would defeat the watchdog (a producer
# that only pings while dormant would never trip). The window is fixed; the signals
# classify only the terminal verdict.
#
# WINDOWS (single mode, --windows N, default 3, W-094). One invocation runs up to N
# watch windows back-to-back so the OPERATOR (who re-invokes on every exit) is woken
# once per RUN, not once per window — cutting the re-arm notification storm (~8/day
# → 1/3 of that). The two "still clearly working" verdicts, PROGRESS (a commit
# landed) and BUILDING (still compiling), re-arm INTERNALLY to the next window,
# leaving a one-line `window i/N … re-arming` record but NO `RESULT:` line; every
# other verdict (ADVANCING / STALLED / RUNAWAY) is terminal and surfaces at once,
# as does the last window's verdict once N is consumed. Exactly ONE `RESULT:` line
# is printed per invocation — the final verdict — so the operator still reads a
# single RESULT line. Each internal window re-baselines like a fresh invocation, so
# --windows N is N back-to-back single windows minus the operator round-trip; the
# BUILDING hard-ceiling counter is file-persisted and accrues across them (N
# consecutive BUILDING windows trip RUNAWAY just as across invocations). The W-085
# heartbeat is refreshed the whole time. --windows 1 reproduces the pre-W-094
# single-shot behavior (its window verdict is always the final verdict).
#
# Usage:
#   single: dispatch_watch.sh --project <root> --pm-id <id> (--id <N> | --branch <ref>)
#                     [--target-root <git-root>] [--windows N] [--timeout-min N]
#                     [--interval-sec N] [--proc-regex <ERE>] [--max-building-windows N]
#                     [--output-file <path>] [--max-output-mb N]
#                     [--timeout-sec N]   (precise/test override of --timeout-min)
#   fleet:  dispatch_watch.sh --fleet --project <root> --pm-id <id>
#                     [--target-root <git-root>] [--stall-min N] [--interval-sec N]
#                     [--max-run-min N] [--proc-regex <ERE>]
#                     [--stall-sec N] [--max-run-sec N]   (precise/test overrides)
# Defaults (single): --windows 3  --timeout-min 20  --interval-sec 90
#           --max-building-windows 3  --max-output-mb 100 (only checked when
#           --output-file is given). One window = --timeout-min minutes (or
#           --timeout-sec seconds when given, for tests) of --interval-sec polls.
# Defaults (fleet):  --stall-min 30  --interval-sec 90  --max-run-min 60
#           (--max-run-min MUST exceed --stall-min so a dormancy can accrue inside
#           one window; the *-sec flags override the derived seconds for tests).
# Always exits 0; read the RESULT line. Fleet drains (RESULT: DRAIN) to exit 0 when
# no dispatch is left to watch.
# --proc-regex overrides the compile/build process-name pattern (default covers
# common cargo/rustc/cc/tsc/gradle/etc. toolchains); pass the project's build and
# run process names to keep the script project-agnostic (pm_id is already a param).
# --max-building-windows is the runaway HARD CEILING: a persisted per-branch
# counter (runtime/dispatch/watch/, transient) increments on each BUILDING verdict
# and resets on any other, so N consecutive BUILDING windows across operator
# re-invocations trip RUNAWAY. --output-file + --max-output-mb arm the opt-in
# output-bloat runaway check. Both are cheap; state writes are best-effort
# (fail-open to the pre-W-077 behavior when runtime/ is unwritable).
set -euo pipefail

# Default compile/build process-name pattern. Project-agnostic and generic (many
# toolchains, no project-specific binary name); override with --proc-regex to add
# a project's own build/run process names.
PROC_REGEX='cargo|rustc|cc1|gcc|g\+\+|clang|tsc|esbuild|webpack|javac|kotlinc|gradle|\bgo\b|ninja|\bmake\b|bazel|msbuild|swiftc|link\.exe'
PROJECT="" TARGET_ROOT="" PM="" ID="" BRANCH="" TIMEOUT_MIN=20 INTERVAL_SEC=90
MAX_BUILDING=3 OUTPUT_FILE="" MAX_OUTPUT_MB=100 WINDOWS=3 TIMEOUT_SEC=""
FLEET=0 STALL_MIN=30 STALL_SEC="" MAX_RUN_MIN=60 MAX_RUN_SEC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fleet)                FLEET=1; shift ;;
    --project)              PROJECT="${2:?}"; shift 2 ;;
    --target-root)          TARGET_ROOT="${2:?}"; shift 2 ;;
    --pm-id)                PM="${2:?}"; shift 2 ;;
    --id)                   ID="${2:?}"; shift 2 ;;
    --branch)               BRANCH="${2:?}"; shift 2 ;;
    --windows)              WINDOWS="${2:?}"; shift 2 ;;
    --timeout-min)          TIMEOUT_MIN="${2:?}"; shift 2 ;;
    --timeout-sec)          TIMEOUT_SEC="${2:?}"; shift 2 ;;
    --interval-sec)         INTERVAL_SEC="${2:?}"; shift 2 ;;
    --proc-regex)           PROC_REGEX="${2:?}"; shift 2 ;;
    --max-building-windows) MAX_BUILDING="${2:?}"; shift 2 ;;
    --output-file)          OUTPUT_FILE="${2:?}"; shift 2 ;;
    --max-output-mb)        MAX_OUTPUT_MB="${2:?}"; shift 2 ;;
    --stall-min)            STALL_MIN="${2:?}"; shift 2 ;;
    --stall-sec)            STALL_SEC="${2:?}"; shift 2 ;;
    --max-run-min)          MAX_RUN_MIN="${2:?}"; shift 2 ;;
    --max-run-sec)          MAX_RUN_SEC="${2:?}"; shift 2 ;;
    -h|--help)              sed -n '2,113p' "$0"; exit 0 ;;
    *) echo "dispatch_watch: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] || { echo "dispatch_watch: --project and --pm-id are required" >&2; exit 2; }
[ -n "$TARGET_ROOT" ] || TARGET_ROOT="$PROJECT"
PM_ROOT="$PROJECT/__garelier/$PM"

# Best-effort compile-activity probe (Git Bash/MSYS `ps -W`, else POSIX `ps`).
# Snapshots the process table ONCE per call and greps it in-memory (never a
# per-name loop). Pattern is --proc-regex (default: common toolchains). Shared by
# both modes. A test / a concurrency-safe project can pass a --proc-regex that
# matches nothing to disable the probe deterministically.
compile_procs() {
  # grep -c always prints a count (0 included), so `|| true` (not `|| echo 0`)
  # keeps the output a SINGLE integer — a second `echo 0` on the no-match path
  # would emit "0\n0" and feed a malformed value into the `-gt` comparison.
  { ps -W 2>/dev/null || ps -e 2>/dev/null || ps aux 2>/dev/null; } \
    | grep -ciE "$PROC_REGEX" 2>/dev/null || true
}

# Liveness heartbeat (W-085). A small, PERSISTENT per-watch marker so the detective
# twin — contract_check.ts --stall-scan — can tell a WORKING dispatch that HAS a
# live watch from one that was never armed (reported as UNWATCHED). Written at start
# and refreshed each poll in both modes; NEVER deleted on exit, so a marker with an
# OLD ts_epoch reads as "the watch died / was not re-armed" rather than "never
# watched" — the overnight failure that motivated this (a forgotten watch, 2026-07-06).
# Best-effort / fail-open: runtime/ may be unwritable, and a write failure must never
# break the watch itself (its job is watching, not bookkeeping).
HEARTBEAT_DIR="$PM_ROOT/runtime/dispatch/watch/heartbeats"
write_heartbeat() {  # <file-basename> <json-body>
  mkdir -p "$HEARTBEAT_DIR" 2>/dev/null || true
  printf '%s\n' "$2" > "$HEARTBEAT_DIR/$1" 2>/dev/null || true
}

# ── fleet mode (W-071) ────────────────────────────────────────────────────────
# Watch every live dispatch under one pm-id in a single process. Progress is the
# per-branch baseline method (single mode) extended per-dispatch: a git-fingerprint
# = HEAD sha (commit progress) | hash(STATE.md + report.md) (uncommitted progress).
# The fingerprint moves -> that dispatch's dormancy clock resets; it stays flat ->
# dormancy accrues. Ported from the durable prototype (fleet_watchdog.sh) into this
# single home so there is no third watchdog. Lean I/O: per cycle = one HEAD read +
# two small-file reads per dispatch, and ONE process snapshot only when something
# already looks dormant.

# slug of a dispatch (for the ungated-REPORTING gate-result lookup): the second
# token of the STATE.md "## Current task" line (`#<id> <slug> (<branch>)`, as
# dispatch_prepare writes it), else task.slug from context.json.
fleet_slug() {  # STATE.md-path container-dir
  local st="$1" d="$2" slug
  slug="$(awk '/^##[[:space:]]*Current task/{f=1;next} f&&NF{print $2; exit}' "$st" 2>/dev/null)"
  if [ -z "$slug" ] && [ -f "$d/context.json" ]; then
    slug="$(grep -o '"slug":"[^"]*"' "$d/context.json" 2>/dev/null | head -1 | sed 's/.*"slug":"//; s/"$//')"
  fi
  printf '%s' "$slug"
}

# A REPORTING dispatch is a monitor target only while it is UNGATED — no Guardian
# or Observer verdict has been published yet (the W-086 blind spot: a finished-but-
# forgotten REPORTING that no gate ever picked up). Once any gate result exists the
# dispatch is in the merge pipeline and out of the dormancy sweep. An unknown slug
# (cannot confirm gated) errs toward flagging it.
fleet_reporting_ungated() {  # slug -> 0 if ungated (watch it), 1 if gated (skip)
  local slug="$1"
  [ -n "$slug" ] || return 0
  [ -f "$PM_ROOT/runtime/guardian/results/$slug-guardian.md" ] && return 1
  [ -f "$PM_ROOT/runtime/observer/results/$slug-observer.md" ] && return 1
  return 0
}

run_fleet() {
  local stall_sec max_run_sec
  stall_sec="${STALL_SEC:-$(( STALL_MIN * 60 ))}"
  max_run_sec="${MAX_RUN_SEC:-$(( MAX_RUN_MIN * 60 ))}"
  local start now cycle=0
  start="$(date +%s)"
  # Persistent per-dispatch clocks (survive the whole invocation); seeded at first
  # sight so a brand-new dispatch never reads as instant PROGRESS.
  declare -A last_fp last_head last_prog last_kind tgt_label
  echo "dispatch_watch[fleet]: pm=$PM stall=${stall_sec}s interval=${INTERVAL_SEC}s max_run=${max_run_sec}s (targets: WORKING/REWORK + ungated REPORTING)"
  while :; do
    now="$(date +%s)"
    cycle=$(( cycle + 1 ))
    local active_ids="" dormant_ids="" st d id status slug head fh fp
    tgt_label=()
    for st in "$PM_ROOT"/_dispatch*/STATE.md; do
      [ -f "$st" ] || continue
      d="$(dirname "$st")"
      id="$(basename "$d" | tr -cd '0-9')"
      [ -n "$id" ] || continue
      status="$(awk '/^##[[:space:]]*Status/{f=1;next} f&&NF{gsub(/[[:space:]]/,"");print;exit}' "$st" 2>/dev/null)"
      case "$status" in
        WORKING|REWORK) tgt_label[$id]="$status" ;;
        REPORTING)
          slug="$(fleet_slug "$st" "$d")"
          fleet_reporting_ungated "$slug" || continue
          tgt_label[$id]="REPORTING(ungated)"
          ;;
        *) continue ;;
      esac
      active_ids="$active_ids $id"
      head="$(git -C "$d/checkout" rev-parse HEAD 2>/dev/null || echo none)"
      fh="$(cat "$st" "$d/report.md" 2>/dev/null | git hash-object --stdin 2>/dev/null || echo none)"
      fp="$head|$fh"
      if [ "${last_fp[$id]:-__new__}" != "$fp" ]; then
        # WHY it moved: HEAD advanced = a new commit (PROGRESS); else only the
        # STATE/report hash moved (ADVANCING). First sighting is seeded silently.
        if [ -z "${last_fp[$id]:-}" ]; then last_kind[$id]="SEEDED"
        elif [ "${last_head[$id]:-}" != "$head" ]; then last_kind[$id]="PROGRESS"
        else last_kind[$id]="ADVANCING"; fi
        last_fp[$id]="$fp"; last_head[$id]="$head"; last_prog[$id]="$now"
      fi
    done

    # Drain: nothing left to watch.
    if [ -z "$active_ids" ]; then
      echo "RESULT: DRAIN — no active WORKING/REWORK/ungated-REPORTING dispatch under $PM (nothing to watch)"
      return 0
    fi

    for id in $active_ids; do
      [ $(( now - ${last_prog[$id]:-$now} )) -ge "$stall_sec" ] && dormant_ids="$dormant_ids $id"
    done

    # One process snapshot, only when something already looks dormant (lean I/O).
    local build_procs=0
    [ -n "$dormant_ids" ] && build_procs="$(compile_procs)"

    local vis=""
    for id in $active_ids; do
      vis="$vis #$id(${tgt_label[$id]},$(( now - ${last_prog[$id]:-$now} ))s)"
    done
    echo "poll $cycle (~$(( now - start ))s): active=$vis${dormant_ids:+ dormant=$dormant_ids build_procs=$build_procs}"

    # Fleet heartbeat (W-085): one marker per fleet process, refreshed each cycle.
    # mode=fleet means contract_check treats it as covering EVERY working dispatch
    # under this pm (the fleet watches them all), so a live fleet watch clears the
    # UNWATCHED flag without a per-dispatch marker. Only reached with active
    # dispatches (an empty fleet DRAINs above), i.e. when there is something to watch.
    write_heartbeat "fleet-$$.json" \
      "$(printf '{"pid":%s,"mode":"fleet","ts_epoch":%s,"active_ids":"%s"}' "$$" "$(date +%s)" "$(echo $active_ids)")"

    # REVIVE-NEEDED: dormant past the stall threshold AND no build/verify process
    # anywhere. The global process check is deliberately conservative — never
    # declare a producer dead (and trigger a respawn) while ANY build is live; the
    # per-checkout-scoped precision lives in contract_check --stall-scan. The cost
    # is a bounded masking window (a sibling's cold build), self-corrected on the
    # operator's next re-arm.
    if [ -n "$dormant_ids" ] && [ "${build_procs:-0}" -eq 0 ]; then
      local n_revive=0
      for id in $dormant_ids; do
        n_revive=$(( n_revive + 1 ))
        echo "RESULT: REVIVE-NEEDED — dispatch #$id (${tgt_label[$id]}) had no git-observable progress (HEAD + STATE/report hash unchanged) for >= ${stall_sec}s and no build/verify process is running: the producer is DORMANT, not building. Respawn it FRESH from its worktree — a /resume does NOT restore an in-process teammate (official). Recovery: inspect ${PM_ROOT}/_dispatch$id/checkout (git status / git log --oneline) + STATE.md, then re-dispatch preserving that worktree (contract_check.ts --stall-scan --handoff $id emits the respawn-handoff prompt). Do NOT wake it."
      done
      echo "RESULT: REVIVE-NEEDED — $n_revive dormant dispatch(es) need a fresh respawn (per-dispatch lines above)"
      return 0
    fi

    # Window elapsed with nothing dormant enough: emit a per-dispatch health summary
    # and exit so the operator re-arms (a live build is healthy — keep watching).
    if [ $(( now - start )) -ge "$max_run_sec" ]; then
      local build_now summary=""
      build_now="$(compile_procs)"
      for id in $active_ids; do
        local dorm=$(( now - ${last_prog[$id]:-$now} )) verdict
        if [ "$dorm" -lt "$INTERVAL_SEC" ] && [ "${last_kind[$id]:-SEEDED}" = "PROGRESS" ]; then verdict="PROGRESS"
        elif [ "$dorm" -lt "$INTERVAL_SEC" ] && [ "${last_kind[$id]:-SEEDED}" = "ADVANCING" ]; then verdict="ADVANCING"
        elif [ "${build_now:-0}" -gt 0 ]; then verdict="BUILDING"
        elif [ "$dorm" -ge "$stall_sec" ]; then verdict="REVIVE-NEEDED"
        else verdict="STALLED"; fi
        echo "  #$id (${tgt_label[$id]}): dormancy=${dorm}s verdict=$verdict"
        summary="$summary #$id=$verdict"
      done
      echo "RESULT: HEALTHY — watched $(( now - start ))s, no dispatch crossed the ${stall_sec}s dormancy threshold;$summary; re-run the fleet watch to keep watching"
      return 0
    fi

    sleep "$INTERVAL_SEC"
  done
}

if [ "$FLEET" -eq 1 ]; then
  run_fleet
  exit 0
fi

# ── single mode (default) ─────────────────────────────────────────────────────
[ -n "$ID" ] || [ -n "$BRANCH" ] || { echo "dispatch_watch: one of --id or --branch is required (or pass --fleet)" >&2; exit 2; }
case "$WINDOWS" in (''|*[!0-9]*) echo "dispatch_watch: --windows must be a positive integer" >&2; exit 2 ;; esac
[ "$WINDOWS" -ge 1 ] || { echo "dispatch_watch: --windows must be >= 1" >&2; exit 2; }
# --timeout-sec is optional (empty = derive from --timeout-min); when set it must be
# a positive integer (a precise/test override of the per-window duration).
case "$TIMEOUT_SEC" in
  '') ;;
  *[!0-9]*) echo "dispatch_watch: --timeout-sec must be a positive integer" >&2; exit 2 ;;
  *) [ "$TIMEOUT_SEC" -ge 1 ] || { echo "dispatch_watch: --timeout-sec must be >= 1" >&2; exit 2; } ;;
esac
CONFIG="$PM_ROOT/_pm/setup_config.toml"

# Resolve the studio (integration) branch from setup_config.
STUDIO="$(awk -F'"' '/^integration[ \t]*=/{print $2; exit}' "$CONFIG" 2>/dev/null)"
[ -n "$STUDIO" ] || { echo "dispatch_watch: cannot resolve integration branch from $CONFIG" >&2; exit 2; }

# Resolve the producer branch from --id (its STATE.md slug) when --branch absent.
if [ -z "$BRANCH" ]; then
  STATE="$PM_ROOT/_dispatch$ID/STATE.md"
  SLUG="$(awk '/^##[[:space:]]*Current task/{f=1;next} f&&NF{print $2; exit}' "$STATE" 2>/dev/null)"
  [ -n "$SLUG" ] || { echo "dispatch_watch: cannot resolve slug from $STATE" >&2; exit 2; }
  # Branch family by role is not encoded in STATE here; the workbench family covers
  # the common worker case. Pass --branch explicitly for anvil/satchel/etc.
  BRANCH="$(git -C "$TARGET_ROOT" for-each-ref --format='%(refname:short)' \
    "refs/heads/*/$PM/workbench/#$ID/$SLUG" 2>/dev/null | head -1)"
  [ -n "$BRANCH" ] || BRANCH="$(git -C "$TARGET_ROOT" for-each-ref --format='%(refname:short)' \
    "refs/heads/**/#$ID/$SLUG" 2>/dev/null | head -1)"
  [ -n "$BRANCH" ] || { echo "dispatch_watch: cannot resolve branch for id $ID slug $SLUG — pass --branch" >&2; exit 2; }
fi

# Non-commit progress signal (lean): the content hash of the dispatch's STATE.md
# + report.md. Lets a producer that is editing / updating STATE before its first
# commit read as ADVANCING instead of a false STALL, WITHOUT a worktree-wide
# `git diff` walk (two known files only). Available only when --id resolves the
# container; with bare --branch the commit count is the sole signal.
CONTAINER=""
[ -n "$ID" ] && CONTAINER="$PM_ROOT/_dispatch$ID"
progress_sig() {
  [ -n "$CONTAINER" ] || return 0
  cat "$CONTAINER/STATE.md" "$CONTAINER/report.md" 2>/dev/null | git hash-object --stdin 2>/dev/null || true
}

# W-018 IDLE-NO-REGISTER: returns 0 when the watched producer reached REPORTING but
# the PM has NOT processed its completion register (no register_received marker) —
# a DONE-but-unregistered producer that needs a WAKE, not a respawn. Needs a
# resolved container (--id); with bare --branch there is no STATE/marker to read, so
# it returns non-zero (the check simply does not apply). Mirrors the marker
# convention of contract_check.ts --stall-scan's idle_no_register detective.
idle_no_register_state() {
  [ -n "$CONTAINER" ] && [ -f "$CONTAINER/STATE.md" ] || return 1
  [ -f "$CONTAINER/register_received" ] && return 1   # PM already processed the register
  local st
  st="$(awk '/^##[[:space:]]*Status/{f=1;next} f&&NF{gsub(/[[:space:]]/,"");print;exit}' "$CONTAINER/STATE.md" 2>/dev/null)"
  [ "$st" = "REPORTING" ]
}

# --- W-077 runaway safety checks (cheap; state writes best-effort / fail-open) ---
# Persisted consecutive-BUILDING counter, keyed by branch so watching a different
# producer never shares the count. runtime/ is transient + gitignored.
WATCH_STATE_DIR="$PM_ROOT/runtime/dispatch/watch"
WATCH_KEY="$(printf '%s' "$BRANCH" | tr -c 'A-Za-z0-9_.-' '_')"
BUILDING_COUNTER="$WATCH_STATE_DIR/$WATCH_KEY.building"
read_building_count() {
  local c; c="$(cat "$BUILDING_COUNTER" 2>/dev/null || echo 0)"
  case "$c" in (''|*[!0-9]*) echo 0 ;; (*) echo "$c" ;; esac
}
reset_building_count() { rm -f "$BUILDING_COUNTER" 2>/dev/null || true; }
bump_building_count() {
  local n; n=$(( $(read_building_count) + 1 ))
  mkdir -p "$WATCH_STATE_DIR" 2>/dev/null || true
  printf '%s\n' "$n" > "$BUILDING_COUNTER" 2>/dev/null || true
  echo "$n"
}
# Cheap output-file size in whole MB (opt-in). Empty when --output-file is unset
# or absent, so the caller only trips on a real, oversized file.
output_mb() {
  [ -n "$OUTPUT_FILE" ] && [ -f "$OUTPUT_FILE" ] || return 0
  local b; b="$(wc -c < "$OUTPUT_FILE" 2>/dev/null || echo 0)"
  case "$b" in (''|*[!0-9]*) b=0 ;; esac
  echo $(( b / 1048576 ))
}

# Single-mode heartbeat (W-085): keyed by dispatch id when known (the watch_cmd
# path always passes --id), else by the sanitized branch. Records id AND branch so
# contract_check can match a dispatch either way. Refreshed each poll below.
if [ -n "$ID" ]; then HB_FILE="dispatch-$ID.json"; else HB_FILE="branch-$WATCH_KEY.json"; fi
single_heartbeat() {
  write_heartbeat "$HB_FILE" \
    "$(printf '{"pid":%s,"mode":"single","id":"%s","branch":"%s","ts_epoch":%s}' \
       "$$" "${ID:-}" "$BRANCH" "$(date +%s)")"
}

# One window = total_sec of INTERVAL_SEC-spaced polls. total_sec is --timeout-sec
# when given (a precise/test override), else --timeout-min minutes.
total_sec="${TIMEOUT_SEC:-$(( TIMEOUT_MIN * 60 ))}"
iters=$(( total_sec / INTERVAL_SEC ))
[ "$iters" -ge 1 ] || iters=1

# run_window (W-094) — run ONE watch window and classify its terminal verdict.
# Sets VERDICT (PROGRESS|BUILDING|ADVANCING|STALLED|RUNAWAY) and VERDICT_MSG (the
# RESULT body, WITHOUT the "RESULT: " prefix). It NEVER prints a "RESULT:" line —
# the windows driver below prints exactly one, so a re-armed window leaves only its
# poll lines and the driver's one-line record. Each window re-captures its OWN
# baseline (base_commits/base_sig), so an internal re-arm behaves like a fresh
# invocation: a commit from a previous window does not read as instant PROGRESS in
# the next. The BUILDING hard-ceiling counter is file-persisted, so N consecutive
# BUILDING windows accrue toward RUNAWAY across internal windows exactly as across
# operator re-invocations.
run_window() {  # <window-index> <window-count>
  local win="$1" nwin="$2"
  local base_commits base_sig sig_moved=0 i n sig p mb pfinal bc
  # Baseline captured at THIS window's first observation: progress is measured as
  # ADVANCE from here, so a branch that already had commits at window start (a
  # warm-resume, or a commit from the previous window) does not read as instant
  # PROGRESS.
  base_commits="$(git -C "$TARGET_ROOT" log --oneline "$STUDIO..$BRANCH" 2>/dev/null | wc -l | tr -d ' ')"
  base_sig="$(progress_sig)"
  echo "dispatch_watch[window $win/$nwin]: branch=$BRANCH studio=$STUDIO timeout=${TIMEOUT_MIN}m interval=${INTERVAL_SEC}s base_commits=${base_commits:-0}"
  single_heartbeat  # arm/refresh the marker at window start (before the first sleep)
  for i in $(seq 1 "$iters"); do
    sleep "$INTERVAL_SEC"
    single_heartbeat  # refresh liveness each poll
    n="$(git -C "$TARGET_ROOT" log --oneline "$STUDIO..$BRANCH" 2>/dev/null | wc -l | tr -d ' ')"
    sig="$(progress_sig)"
    p="$(compile_procs)"
    [ -n "$sig" ] && [ "$sig" != "$base_sig" ] && sig_moved=1
    mb="$(output_mb)"
    echo "poll $i (~$((i*INTERVAL_SEC))s): commits=$n (base ${base_commits:-0}) sig_moved=$sig_moved compile_procs=$p${mb:+ output_mb=$mb}"
    if [ "${n:-0}" -gt "${base_commits:-0}" ]; then
      reset_building_count
      VERDICT=PROGRESS
      VERDICT_MSG="PROGRESS — $(( n - base_commits )) new commit(s) on $BRANCH since watch start; the producer is finishing (check for REPORTING, then gate via jig_gate_held)"
      return 0
    fi
    # W-077 output-bloat runaway: an oversized output file with NO STATE/report
    # progress = a job writing without advancing (the SSD-fill precedent). Trip it
    # mid-window so a runaway is killed before it fills the disk.
    if [ -n "$mb" ] && [ "${mb:-0}" -gt "${MAX_OUTPUT_MB:-100}" ] && [ "${sig_moved:-0}" -eq 0 ]; then
      reset_building_count
      VERDICT=RUNAWAY
      VERDICT_MSG="RUNAWAY — $OUTPUT_FILE grew past ${MAX_OUTPUT_MB}MB (now ${mb}MB) with no STATE/report progress: a job writing without advancing (SSD-fill precedent). Kill the producer's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=$p) before re-dispatch — do NOT keep the watch running on it."
      return 0
    fi
  done
  pfinal="$(compile_procs)"
  if [ "${pfinal:-0}" -gt 0 ]; then
    bc="$(bump_building_count)"
    if [ "${bc:-0}" -ge "${MAX_BUILDING:-3}" ]; then
      reset_building_count
      VERDICT=RUNAWAY
      VERDICT_MSG="RUNAWAY — still compiling after ${bc} consecutive BUILDING window(s) (~$(( bc * TIMEOUT_MIN ))m, hard ceiling ${MAX_BUILDING}). A healthy cold build should have committed by now — treat as runaway, not patience: kill the producer's process group, mark the job FAILED, and check for orphaned build procs (compile_procs=$pfinal) before re-dispatch. Do NOT keep waiting on infinite BUILDING."
    else
      VERDICT=BUILDING
      VERDICT_MSG="BUILDING — still compiling at timeout (window ${bc}/${MAX_BUILDING}, no new commit yet); re-run the watch for another window (trips RUNAWAY at the hard ceiling)"
    fi
  elif [ "${sig_moved:-0}" -gt 0 ]; then
    reset_building_count
    VERDICT=ADVANCING
    VERDICT_MSG="ADVANCING — no new commit and no live compile at timeout, but STATE.md/report.md advanced during the window (uncommitted forward progress, NOT a detach-and-idle stall). Re-run the watch for another window; if it goes flat next window with no compile, treat as STALLED."
  else
    reset_building_count
    VERDICT=STALLED
    VERDICT_MSG="STALLED — no new commit, no STATE/report change, and no live compile after ${TIMEOUT_MIN}m. The producer likely detached a build and went idle (DEC-091). Warm-resume it (cache is now warm) or re-dispatch; if uncommitted work survives in _dispatch$ID/checkout, a resume preserves it. If it stays flat across re-arms with no build, --fleet escalates it to REVIVE-NEEDED (respawn)."
  fi
  return 0
}

# Windows driver (W-094): run up to $WINDOWS windows back-to-back so the operator is
# woken once per RUN, not once per window. PROGRESS/BUILDING (the "still clearly
# working" verdicts) re-arm INTERNALLY to the next window — a one-line record, no
# "RESULT:" line; every other verdict (ADVANCING/STALLED/RUNAWAY) is terminal and
# surfaces at once, as does the final window's verdict once $WINDOWS is consumed.
# Exactly one "RESULT:" line is printed (the final verdict). --windows 1 reproduces
# the pre-W-094 single-shot behavior: one window, its verdict is the final verdict.
VERDICT="" VERDICT_MSG=""
win=1
while [ "$win" -le "$WINDOWS" ]; do
  run_window "$win" "$WINDOWS"
  # W-018: a REPORTING-without-register producer is DONE-but-unregistered — terminal.
  # Do NOT keep re-arming a PROGRESS/BUILDING window on it (the commit that landed IS
  # its completion); surface the wake now instead of after $WINDOWS windows.
  if idle_no_register_state; then break; fi
  case "$VERDICT" in
    PROGRESS|BUILDING)
      if [ "$win" -lt "$WINDOWS" ]; then
        echo "dispatch_watch: window $win/$WINDOWS verdict=$VERDICT — re-arming to window $(( win + 1 ))/$WINDOWS (still working, no notification)"
        win=$(( win + 1 ))
        continue
      fi
      ;;
  esac
  break
done
# W-018: overlay the IDLE-NO-REGISTER verdict when the watched producer is REPORTING
# with no processed register — a WAKE, not the PROGRESS/STALLED the window computed.
if idle_no_register_state; then
  VERDICT=IDLE-NO-REGISTER
  VERDICT_MSG="IDLE-NO-REGISTER — dispatch #$ID は REPORTING だが完了 register 未処理 (register_received marker 不在)。producer は DONE の可能性が高い — wake して最終 register (最終 STATE / branch+SHA / report path / gate 結果 / 台帳 N/N) を送らせるか、内容を確認して register を処理し $CONTAINER/register_received を touch してください。respawn は不要。contract_check.ts --stall-scan の idle_no_register が同判定 + wake 文面を出します。"
fi
echo "RESULT: $VERDICT_MSG"
exit 0
