#!/usr/bin/env bash
#
# dispatch_watch.sh — reactive stall backstop for a heavy producer dispatch
# (DEC-091, defense-in-depth behind the preventive measures). A sub-agent is
# run-to-completion: a build it detaches does NOT re-invoke it, so a producer that
# detaches a long compile and goes idle STALLS silently. The preventive fix is a
# warm cache + crate-scoped foreground gate (DEC-091); this is the backstop for
# when a producer stalls anyway.
#
# The OPERATOR (main session — stall-immune) runs this in the background right
# after dispatching a heavy producer. It polls the producer's workbench branch and
# the host's compile activity, then EXITS (re-invoking the operator) with a clear
# RESULT line:
#   PROGRESS  — the producer committed (it is finishing; check for REPORTING)
#   STALLED   — no commit and no live compile after the timeout (warm-resume or
#               re-dispatch the producer; the cache is now warm)
#   BUILDING  — still compiling at timeout (re-run the watch for another window)
#
# Usage:
#   dispatch_watch.sh --project <root> --pm-id <id> (--id <N> | --branch <ref>)
#                     [--target-root <git-root>] [--timeout-min N] [--interval-sec N]
# Defaults: --timeout-min 20  --interval-sec 90.  Always exits 0; read the RESULT line.
set -euo pipefail

PROJECT="" TARGET_ROOT="" PM="" ID="" BRANCH="" TIMEOUT_MIN=20 INTERVAL_SEC=90
while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="${2:?}"; shift 2 ;;
    --target-root)  TARGET_ROOT="${2:?}"; shift 2 ;;
    --pm-id)        PM="${2:?}"; shift 2 ;;
    --id)           ID="${2:?}"; shift 2 ;;
    --branch)       BRANCH="${2:?}"; shift 2 ;;
    --timeout-min)  TIMEOUT_MIN="${2:?}"; shift 2 ;;
    --interval-sec) INTERVAL_SEC="${2:?}"; shift 2 ;;
    -h|--help)      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "dispatch_watch: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] || { echo "dispatch_watch: --project and --pm-id are required" >&2; exit 2; }
[ -n "$ID" ] || [ -n "$BRANCH" ] || { echo "dispatch_watch: one of --id or --branch is required" >&2; exit 2; }
[ -n "$TARGET_ROOT" ] || TARGET_ROOT="$PROJECT"
CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"

# Resolve the studio (integration) branch from setup_config.
STUDIO="$(awk -F'"' '/^integration[ \t]*=/{print $2; exit}' "$CONFIG" 2>/dev/null)"
[ -n "$STUDIO" ] || { echo "dispatch_watch: cannot resolve integration branch from $CONFIG" >&2; exit 2; }

# Resolve the producer branch from --id (its STATE.md slug) when --branch absent.
if [ -z "$BRANCH" ]; then
  STATE="$PROJECT/__garelier/$PM/_dispatch$ID/STATE.md"
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

# Best-effort compile-activity probe (Git Bash/MSYS `ps -W`, else POSIX `ps`).
compile_procs() {
  { ps -W 2>/dev/null || ps -e 2>/dev/null || ps aux 2>/dev/null; } \
    | grep -ciE 'cargo|rustc|cc1|gcc|g\+\+|clang|tsc|esbuild|webpack|javac|kotlinc|gradle|\bgo\b|ninja|\bmake\b|bazel|msbuild|swiftc|link\.exe' 2>/dev/null || echo 0
}

iters=$(( (TIMEOUT_MIN * 60) / INTERVAL_SEC ))
[ "$iters" -ge 1 ] || iters=1
echo "dispatch_watch: branch=$BRANCH studio=$STUDIO timeout=${TIMEOUT_MIN}m interval=${INTERVAL_SEC}s"
for i in $(seq 1 "$iters"); do
  sleep "$INTERVAL_SEC"
  n="$(git -C "$TARGET_ROOT" log --oneline "$STUDIO..$BRANCH" 2>/dev/null | wc -l | tr -d ' ')"
  p="$(compile_procs)"
  echo "poll $i (~$((i*INTERVAL_SEC))s): commits=$n compile_procs=$p"
  if [ "${n:-0}" -gt 0 ]; then
    echo "RESULT: PROGRESS — $n commit(s) on $BRANCH; the producer is finishing (check for REPORTING, then gate via jig_gate_held)"
    exit 0
  fi
done
pfinal="$(compile_procs)"
if [ "${pfinal:-0}" -gt 0 ]; then
  echo "RESULT: BUILDING — still compiling at timeout (no commit yet); re-run the watch for another window"
else
  echo "RESULT: STALLED — no commit and no live compile after ${TIMEOUT_MIN}m. The producer likely detached a build and went idle (DEC-091). Warm-resume it (cache is now warm) or re-dispatch; if uncommitted work survives in _dispatch$ID/checkout, a resume preserves it."
fi
exit 0
