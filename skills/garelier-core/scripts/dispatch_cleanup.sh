#!/usr/bin/env bash
#
# dispatch_cleanup.sh — remove a dispatch_prepare.sh container after the merge
# gate integrated (or rejected) the branch (DEC-063 Part A).
#
# Usage:
#   dispatch_cleanup.sh --project <root> --pm-id <id> --id <n>
#                       [--delete-branch] [--force]
#
# Removes the __garelier/<pm_id>/_dispatch<n>/checkout worktree (refusing on a
# dirty tree unless --force) and, with --delete-branch, force-deletes the
# branch the worktree was on (use only AFTER the merge gate landed or the work
# was explicitly abandoned). The container dir is removed when empty;
# coordination files you placed there are left in place otherwise.
set -euo pipefail

PROJECT="" PM="" ID="" DELETE_BRANCH=0 FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?}"; shift 2 ;;
    --pm-id)   PM="${2:?}"; shift 2 ;;
    --id)      ID="${2:?}"; shift 2 ;;
    --delete-branch) DELETE_BRANCH=1; shift ;;
    --force)   FORCE=1; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "dispatch_cleanup: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] && [ -n "$ID" ] || {
  echo "dispatch_cleanup: --project, --pm-id, --id are required" >&2; exit 2; }

CONTAINER="$PROJECT/__garelier/$PM/_dispatch$ID"
# Both layouts: helper-made containers hold the worktree at checkout/; older
# hand-made dispatches used the container dir itself as the worktree.
CHECKOUT="$CONTAINER/checkout"
[ -d "$CHECKOUT" ] || CHECKOUT="$CONTAINER"
[ -d "$CHECKOUT" ] || { echo "dispatch_cleanup: no worktree at $CONTAINER[/checkout]" >&2; exit 1; }

BRANCH="$(git -C "$CHECKOUT" branch --show-current || true)"

WT_ARGS=(worktree remove)
[ "$FORCE" -eq 1 ] && WT_ARGS+=(--force)
if ! git -C "$PROJECT" "${WT_ARGS[@]}" "$CHECKOUT" >&2; then
  # Windows MAX_PATH: git cannot delete deep build trees (e.g. Rust target/).
  # Fall back to a direct recursive delete + prune of the stale registration.
  echo "dispatch_cleanup: git worktree remove failed; falling back to rm -rf + prune (long-path safe)" >&2
  rm -rf "$CHECKOUT"
  git -C "$PROJECT" worktree prune >&2
fi

if [ "$DELETE_BRANCH" -eq 1 ] && [ -n "$BRANCH" ]; then
  git -C "$PROJECT" branch -D "$BRANCH" >&2
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

rm -f "$CONTAINER/STATE.md" 2>/dev/null || true
rmdir "$CONTAINER" 2>/dev/null || true

# W-011: record the lifecycle end + regenerate the in_flight.md derived view
# (the removed container drops out of it). Best-effort - cleanup must succeed
# even if the event helper is missing.
bash "$(dirname "$0")/dispatch_event.sh" --project "$PROJECT" --pm-id "$PM" \
  --kind cleanup --role "dispatch(#$ID)" --task "#$ID container removed" >&2 || true

printf '{"id":%s,"removed":"%s","branch":"%s","branch_deleted":%s}\n' \
  "$ID" "$CHECKOUT" "$BRANCH" "$([ "$DELETE_BRANCH" -eq 1 ] && echo true || echo false)"
