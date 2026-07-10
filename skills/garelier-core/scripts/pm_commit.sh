#!/usr/bin/env bash
#
# pm_commit.sh — a thin `git commit` wrapper that refuses to commit while a merge
# gate is running (W-023). It mechanizes pm_field_manual §9: "studio commit は merge
# gate idle 時のみ." A commit made while the gate holds its staged merge is absorbed
# by git into a 2-parent merge commit and the gate aborts (W-055) — a race the PM
# otherwise had to avoid by hand ("gate 中は studio commit を保留").
#
# This is an EXPLICIT wrapper the PM calls in place of `git commit`. It is NOT a git
# hook: a repo-wide pre-commit hook would misfire on every producer worktree commit
# (the W-158 problem), so the guard is opt-in per invocation, not ambient.
#
# Usage:
#   pm_commit.sh --project <root> --pm-id <id> [--wait]
#                [--max-wait <seconds>] [--poll-interval <seconds>]
#                [--] <git commit args…>
#
#   --project / --pm-id  locate the merge-gate state
#                        (__garelier/<pm_id>/runtime/merge_gate/). Required.
#   --wait               instead of refusing, BLOCK-poll until the gate goes idle,
#                        then commit. Bounded by --max-wait (default 1800s); a
#                        timeout exits 124 without committing.
#   --poll-interval      seconds between idle checks under --wait (default 15).
#   --                   end pm_commit's own flags; everything after is git commit's.
#                        (Also implicit: the first token pm_commit does not recognize
#                        starts the git commit args, so `-m`, `-a`, paths, … pass
#                        through without needing `--`.)
#
# "Gate busy" = an active.lock is present (a gate is mid-merge) OR a submitted
# request has no result yet (a gate is queued and about to stage a merge). Either
# way a commit now risks the W-055 absorption, so both count as not-idle. When idle,
# pm_commit runs `git commit` in the CURRENT directory (the PM's studio worktree)
# and forwards every remaining arg verbatim, so it is transparent apart from the
# guard.
#
# Exit codes:
#   0    committed (git commit's own exit forwarded on success/its failure)
#   2    usage error (missing --project/--pm-id)
#   3    gate busy, default (no --wait) — nothing committed
#   124  --wait timed out before the gate went idle — nothing committed
set -uo pipefail

PROJECT="" PM="" WAIT=0 MAX_WAIT=1800 POLL_INTERVAL=15
GIT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --project)       PROJECT="${2:?}"; shift 2 ;;
    --pm-id)         PM="${2:?}";      shift 2 ;;
    --wait)          WAIT=1; shift ;;
    --max-wait)      MAX_WAIT="${2:?}"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="${2:?}"; shift 2 ;;
    -h|--help)       sed -n '2,44p' "$0"; exit 0 ;;
    --)              shift; GIT_ARGS+=("$@"); break ;;
    # First unrecognized token: it and everything after belong to git commit.
    *)               GIT_ARGS+=("$@"); break ;;
  esac
done

[ -n "$PROJECT" ] && [ -n "$PM" ] || {
  echo "pm_commit: --project and --pm-id are required" >&2
  sed -n '2,44p' "$0" >&2
  exit 2
}

GATE_DIR="$PROJECT/__garelier/$PM/runtime/merge_gate"
LOCK_ACTIVE="$GATE_DIR/locks/active.lock"
REQ_DIR="$GATE_DIR/requests"
RES_DIR="$GATE_DIR/results"

# gate_busy — echo a human reason on stderr and return 0 when a gate is active or
# queued, else return 1 (idle). Active = active.lock present. Queued = a
# requests/<id>.json with no matching results/<id>.json (submitted, gate not yet
# terminal), mirroring gate_result_waiter's request↔result id convention.
gate_busy() {
  if [ -f "$LOCK_ACTIVE" ]; then
    echo "pm_commit: merge gate is ACTIVE (mid-merge) — $LOCK_ACTIVE present." >&2
    return 0
  fi
  if [ -d "$REQ_DIR" ]; then
    local req base
    for req in "$REQ_DIR"/*.json; do
      [ -e "$req" ] || continue          # no requests at all (glob unmatched)
      base="$(basename "$req" .json)"
      if [ ! -f "$RES_DIR/$base.json" ]; then
        echo "pm_commit: a merge gate request is QUEUED with no result yet ($base) — a merge is imminent." >&2
        return 0
      fi
    done
  fi
  return 1
}

if gate_busy; then
  if [ "$WAIT" -eq 0 ]; then
    echo "pm_commit: REFUSING to commit while the merge gate is running — a commit now would be absorbed into the gate's staged merge and abort it (W-055). Wait for the gate to finish, or re-run with --wait to block until it is idle." >&2
    exit 3
  fi
  echo "pm_commit: --wait: polling until the merge gate is idle (max ${MAX_WAIT}s, every ${POLL_INTERVAL}s)…" >&2
  _waited=0
  while gate_busy >/dev/null 2>&1; do
    if [ "$_waited" -ge "$MAX_WAIT" ]; then
      echo "pm_commit: --wait timed out after ${MAX_WAIT}s; the merge gate is still running. Nothing committed." >&2
      exit 124
    fi
    sleep "$POLL_INTERVAL"
    _waited=$((_waited + POLL_INTERVAL))
  done
  echo "pm_commit: merge gate is now idle after ${_waited}s — committing." >&2
fi

# Idle (or waited to idle): commit transparently in the caller's cwd, forwarding
# every remaining arg to git commit. Its exit code is ours.
git commit "${GIT_ARGS[@]}"
