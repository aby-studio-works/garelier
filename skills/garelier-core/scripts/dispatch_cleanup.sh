#!/usr/bin/env bash
#
# dispatch_cleanup.sh — remove a dispatch_prepare.sh container after the merge
# gate integrated (or rejected) the branch (DEC-063 Part A).
# Bash twin of dispatch_cleanup.ps1 — keep behavior at parity.
#
# Robust on Windows (DEC-073 Part C): when a lingering rustc/sccache/cargo handle
# (or OS handle lag) holds a file under the worktree's deep `target/`, the dir
# cannot be deleted even though git deregistered the worktree. Instead of leaking
# a stale `_dispatch<N>/`, this script retries with backoff, then DEFERS the dir
# to `runtime/backlog/failed_cleanups.jsonl` and exits 0 (git is already pruned).
# Re-runnable in --sweep mode (retries every recorded stale dir) — the self-heal
# hook that dispatch_prepare calls on every new dispatch.
#
# Usage:
#   dispatch_cleanup.sh --project <root> --pm-id <id> --id <n> [--delete-branch] [--force]
#   dispatch_cleanup.sh --project <root> --pm-id <id> --sweep   # retry deferred stale dirs
set -uo pipefail

PROJECT="" PM="" ID="" DELETE_BRANCH=0 FORCE=0 SWEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?}"; shift 2 ;;
    --pm-id)   PM="${2:?}"; shift 2 ;;
    --id)      ID="${2:?}"; shift 2 ;;
    --delete-branch) DELETE_BRANCH=1; shift ;;
    --force)   FORCE=1; shift ;;
    --sweep)   SWEEP=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "dispatch_cleanup: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] || {
  echo "dispatch_cleanup: --project, --pm-id are required" >&2; exit 2; }

FAILED_FILE="$PROJECT/__garelier/$PM/runtime/backlog/failed_cleanups.jsonl"

# Retry-with-backoff removal of a worktree checkout dir. Returns 0 if the dir is
# gone (or never existed). Always prunes stale git registrations.
remove_checkout_dir() {
  local proj="$1" checkout="$2" force="$3" attempt
  for attempt in 1 2 3 4; do
    [ -e "$checkout" ] || return 0
    if [ "$force" -eq 1 ]; then git -C "$proj" worktree remove --force "$checkout" >&2 2>/dev/null
    else git -C "$proj" worktree remove "$checkout" >&2 2>/dev/null; fi
    if [ ! -e "$checkout" ]; then git -C "$proj" worktree prune >&2 2>/dev/null; return 0; fi
    rm -rf "$checkout" 2>/dev/null
    git -C "$proj" worktree prune >&2 2>/dev/null
    [ -e "$checkout" ] || return 0
    [ "$attempt" -lt 4 ] && sleep "$(awk "BEGIN{print 0.5*2^($attempt-1)}")"
  done
  [ -e "$checkout" ] && return 1 || return 0
}

append_failed_cleanup() {
  local id="$1" container="$2" reason="$3"
  mkdir -p "$(dirname "$FAILED_FILE")" 2>/dev/null
  printf '{"ts":"%s","dispatch_id":%s,"container":"%s","reason":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$id" "$container" "${reason//\"/\'}" >> "$FAILED_FILE" 2>/dev/null || true
}

# --sweep: retry every recorded stale dir; drop the ones now gone. Self-heal hook.
if [ "$SWEEP" -eq 1 ]; then
  [ -f "$FAILED_FILE" ] || { echo "swept=0 remaining=0"; exit 0; }
  swept=0; tmp="$(mktemp)"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    container="$(printf '%s' "$line" | sed -n 's/.*"container":"\([^"]*\)".*/\1/p')"
    checkout="$container/checkout"; [ -e "$checkout" ] || checkout="$container"
    if [ ! -e "$checkout" ] && [ ! -e "$container" ]; then swept=$((swept+1)); continue; fi
    if remove_checkout_dir "$PROJECT" "$checkout" 1; then
      rmdir "$container" 2>/dev/null || rm -rf "$container" 2>/dev/null || true
      [ -e "$container" ] || { swept=$((swept+1)); continue; }
    fi
    printf '%s\n' "$line" >> "$tmp"
  done < "$FAILED_FILE"
  remaining=$(wc -l < "$tmp" | tr -d ' ')
  if [ "$remaining" -gt 0 ]; then mv "$tmp" "$FAILED_FILE"; else rm -f "$tmp" "$FAILED_FILE"; fi
  echo "swept=$swept remaining=$remaining"
  exit 0
fi

[ -n "$ID" ] || { echo "dispatch_cleanup: --id <n> is required (or use --sweep)" >&2; exit 2; }

CONTAINER="$PROJECT/__garelier/$PM/_dispatch$ID"
# Both layouts: helper-made containers hold the worktree at checkout/; older
# hand-made dispatches used the container dir itself as the worktree.
CHECKOUT="$CONTAINER/checkout"
[ -d "$CHECKOUT" ] || CHECKOUT="$CONTAINER"
[ -d "$CHECKOUT" ] || { echo "dispatch_cleanup: no worktree at $CONTAINER[/checkout]" >&2; exit 1; }

BRANCH="$(git -C "$CHECKOUT" branch --show-current 2>/dev/null || true)"

# Premature-cleanup guard (DEC-063 Part A safety): refuse to clean a dispatch
# whose branch is STILL being merged. A jig tick that reports a producer
# "ENQUEUED" only means the merge REQUEST was posted; the merge gate then runs
# ASYNC in a separate process (acquire lock -> git merge --no-commit -> quality
# gate compile -> commit -> release lock). "enqueued" != "merged" — when the gate
# compile outlives the merge_request poll window, the worktree/branch can still be
# mid-merge. Deleting them now races the in-flight merge. Wait until the gate
# finishes (active.lock released / studio advanced); --force overrides.
if [ "$FORCE" -ne 1 ] && [ -n "$BRANCH" ]; then
  _mh="$(git -C "$PROJECT" rev-parse --verify -q MERGE_HEAD 2>/dev/null || true)"
  _tip="$(git -C "$PROJECT" rev-parse --verify -q "$BRANCH" 2>/dev/null || true)"
  if [ -n "$_mh" ] && [ -n "$_tip" ] && [ "$_mh" = "$_tip" ]; then
    echo "dispatch_cleanup: REFUSING — a merge of '$BRANCH' is in progress (.git/MERGE_HEAD == branch tip). The merge gate is still integrating it; cleaning now races the merge. Wait until it finishes (lock released / studio advanced), then re-run. Use --force to override." >&2
    exit 3
  fi
  _lock="$PROJECT/__garelier/$PM/runtime/merge_gate/locks/active.lock"
  _slug="${BRANCH##*/}"
  if [ -f "$_lock" ] && [ -n "$_slug" ] && grep -q -F -- "$_slug" "$_lock" 2>/dev/null; then
    echo "dispatch_cleanup: REFUSING — the merge gate is processing '$_slug' (active.lock present and references it). Cleaning now races the in-flight merge. Wait until it finishes (lock released), then re-run. Use --force to override." >&2
    exit 3
  fi
fi

# Remove the worktree (retry + backoff). On persistent handle-lock, DEFER instead
# of leaking a stale dir — git is pruned; the physical dir is swept later.
CLEANUP_STATUS="success"
if ! remove_checkout_dir "$PROJECT" "$CHECKOUT" "$FORCE"; then
  echo "dispatch_cleanup: worktree dir still locked after retries; deferring to failed_cleanups.jsonl (git pruned)" >&2
  append_failed_cleanup "$ID" "$CONTAINER" "worktree dir locked after retries"
  CLEANUP_STATUS="deferred"
fi

if [ "$DELETE_BRANCH" -eq 1 ] && [ -n "$BRANCH" ]; then
  git -C "$PROJECT" branch -D "$BRANCH" >&2 2>/dev/null || true
fi

# Archive the coordination files to runtime/backlog/done/ before removing the
# container (the protocol's completed assignment+report archive — mechanical,
# nothing to remember). Slug derived from the branch family path.
SLUG="${BRANCH##*/}"; [ -n "$SLUG" ] || SLUG="dispatch"
DONE_DIR="$PROJECT/__garelier/$PM/runtime/backlog/done"
if [ -f "$CONTAINER/report.md" ] || [ -f "$CONTAINER/questions.md" ] || [ -f "$CONTAINER/answers.md" ]; then
  mkdir -p "$DONE_DIR"
  {
    printf '# #%s %s - archived by dispatch_cleanup (%s)\n\n' "$ID" "$SLUG" "${BRANCH:-no-branch}"
    [ -f "$CONTAINER/report.md" ] && cat "$CONTAINER/report.md"
    for f in questions answers; do
      if [ -f "$CONTAINER/$f.md" ]; then printf '\n---\n\n'; cat "$CONTAINER/$f.md"; fi
    done
  } > "$DONE_DIR/$ID-$SLUG.md"
  rm -f "$CONTAINER/report.md" "$CONTAINER/questions.md" "$CONTAINER/answers.md" 2>/dev/null || true
fi

# STATE.md + the forward-supply fact-pack (DEC-081) are transient and regenerable
# — drop them so the container can be removed (they are never archived).
rm -f "$CONTAINER/STATE.md" "$CONTAINER/context.json" 2>/dev/null || true
rmdir "$CONTAINER" 2>/dev/null || true
# If the container could not be removed (checkout still locked) and we have not
# already deferred it, record it so a later --sweep converges it.
if [ -e "$CONTAINER" ] && [ "$CLEANUP_STATUS" = "success" ]; then
  append_failed_cleanup "$ID" "$CONTAINER" "container dir not empty / locked"
  CLEANUP_STATUS="deferred"
fi

# W-011: record the lifecycle end + regenerate the in_flight.md derived view
# (the removed container drops out of it). Best-effort - cleanup must succeed
# even if the event helper is missing.
bash "$(dirname "$0")/dispatch_event.sh" --project "$PROJECT" --pm-id "$PM" \
  --kind cleanup --role "dispatch(#$ID)" --task "#$ID container removed" >&2 2>/dev/null || true

printf '{"id":%s,"removed":"%s","branch":"%s","branch_deleted":%s,"cleanup_status":"%s"}\n' \
  "$ID" "$CHECKOUT" "$BRANCH" "$([ "$DELETE_BRANCH" -eq 1 ] && echo true || echo false)" "$CLEANUP_STATUS"
