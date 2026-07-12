#!/usr/bin/env bash
#
# dispatch_cleanup.sh — remove a dispatch_prepare.sh container after the merge
# gate integrated (or rejected) the branch (DEC-063 Part A).
# Robust on Windows (DEC-073 Part C): when a lingering build/compiler handle
# (or OS handle lag) holds a file under the worktree's deep build-output dir, the dir
# cannot be deleted even though git deregistered the worktree. Instead of leaking
# a stale `_dispatch<N>/`, this script retries with backoff, then DEFERS the dir
# to `runtime/backlog/failed_cleanups.jsonl` and exits 0 (git is already pruned).
# Re-runnable in --sweep mode (retries every recorded stale dir) — the self-heal
# hook that dispatch_prepare calls on every new dispatch.
#
# Usage:
#   dispatch_cleanup.sh --project <control-root> --pm-id <id> --id <n> [--delete-branch] [--force] [--target-root <git-root>] [--report-from-file <path>]
#   dispatch_cleanup.sh --project <control-root> --pm-id <id> --sweep [--target-root <git-root>]  # retry deferred stale dirs
#   dispatch_cleanup.sh --project <control-root> --pm-id <id> --id <n> --record-touches [--target-root <git-root>]  # W-021: record measured touches, remove nothing
#
# --record-touches (W-021): does NOT clean up. It records the dispatch's MEASURED
# path set (base_sha..HEAD) into context.json task.touches_actual so a gate /
# Guardian reads the actual diff instead of the dispatch-time `touches` prediction
# (which goes stale). Run it at REPORTING (before the gate); delegates to
# driver/src/dispatch/record_touches.ts. Best-effort — a git/read failure leaves
# context.json unchanged and exits non-zero without touching the container.
#
# --report-from-file <path> (W-019): report/register single-ledger. When the
# harness prevented the producer from writing report.md (a common live condition —
# the compact REGISTER message is then the canonical record), the PM saves that
# register text to a file and passes it here; cleanup transcribes it into the
# container's report.md BEFORE archiving, so the archived report carries the real
# outcome instead of the untouched dispatch scaffold. Best-effort: a missing
# source file is a no-op (the existing report.md is archived as-is).
set -uo pipefail

PROJECT="" TARGET_ROOT="" PM="" ID="" DELETE_BRANCH=0 FORCE=0 SWEEP=0 REPORT_FROM_FILE="" RECORD_TOUCHES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:?}"; shift 2 ;;
    --target-root) TARGET_ROOT="${2:?}"; shift 2 ;;
    --pm-id)   PM="${2:?}"; shift 2 ;;
    --id)      ID="${2:?}"; shift 2 ;;
    --delete-branch) DELETE_BRANCH=1; shift ;;
    --force)   FORCE=1; shift ;;
    --sweep)   SWEEP=1; shift ;;
    --report-from-file) REPORT_FROM_FILE="${2:?}"; shift 2 ;;
    --record-touches) RECORD_TOUCHES=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) echo "dispatch_cleanup: unknown arg: $1" >&2
       echo "dispatch_cleanup: valid flags: --project --target-root --pm-id --id --delete-branch --force --sweep --report-from-file --record-touches -h/--help" >&2
       exit 2 ;;
  esac
done
[ -n "$PROJECT" ] && [ -n "$PM" ] || {
  echo "dispatch_cleanup: --project, --pm-id are required" >&2; exit 2; }
GIT_ROOT="${TARGET_ROOT:-$PROJECT}"
# W-053(b): --target-root is an untrusted CLI arg (a broken caller, hand-edit, or
# a malformed unexpanded-$VAR string could reach it) that flows straight into
# every `git -C "$GIT_ROOT" ...` call below -- this script had NO validation on
# it, unlike merge-gate.sh's JSON-sourced target_root (W-045 guarded: absolute +
# no literal "$" + names an existing directory, else fall back to the safe
# default untouched). Apply the identical guard here so a malformed --target-root
# can never become a real cwd this script `git -C`'s into. See
# references/stray-var-dir-leak.md.
case "$GIT_ROOT" in
  /*|[A-Za-z]:[/\\]*) ;;                # looks absolute (POSIX or Windows drive-letter)
  *) GIT_ROOT="$PROJECT" ;;
esac
case "$GIT_ROOT" in
  *'$'*) GIT_ROOT="$PROJECT" ;;         # literal, unexpanded "$VAR" -- never trust it
esac
[ -d "$GIT_ROOT" ] || GIT_ROOT="$PROJECT"

FAILED_FILE="$PROJECT/__garelier/$PM/runtime/backlog/failed_cleanups.jsonl"

# Minimal JSON string escaping (backslash + double-quote). The final result line
# embeds paths (checkout, and W-076's task_mirror_hint which carries --project);
# a Windows-style `C:\...` path has backslashes that make the line invalid JSON
# without this. The driver consumer (dock_integrate) only regex-tests the output,
# so escaping is transparent to it while letting any strict parser read the line.
json_escape() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

# W-019: transcribe a producer's register text (saved by the PM to a file) into the
# container's report.md, replacing the dispatch scaffold, so the archived report.md
# is the canonical record when the harness blocked the producer from writing it.
# Returns 0 on a successful transcription, 1 on a write failure, 2 when there was
# nothing to do (no source, or the source file is missing — both non-fatal).
transcribe_report_from_file() {
  local src="$1" dst="$2"
  [ -n "$src" ] || return 2
  [ -f "$src" ] || { echo "dispatch_cleanup: --report-from-file '$src' not found; leaving report.md as-is" >&2; return 2; }
  {
    printf '<!-- transcribed from the producer register by dispatch_cleanup --report-from-file (W-019):\n'
    printf '     the compact register message is the canonical record when the harness blocked\n'
    printf '     report.md writes. Source: %s -->\n\n' "$src"
    cat "$src"
  } > "$dst" 2>/dev/null || { echo "dispatch_cleanup: could not write $dst from --report-from-file '$src'" >&2; return 1; }
  return 0
}

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

# Merge-status of a branch, for the unmerged-branch-deletion guard (W-044). The
# ground truth for "safely merged" is: the branch tip is an ANCESTOR of studio
# (the merge gate committed it, or it was already integrated). A conflicted or
# failed merge leaves the branch tip OUTSIDE studio with its commits reachable
# only from the branch — deleting it there loses work (observed live: a blind
# cleanup deleted a branch whose merge had conflicted; only a stray SHA in the
# chat let it be recovered). As a secondary accept signal we honor a
# status=success result in runtime/merge_gate/results/ whose stem contains the
# branch slug (same stem shape pruneMergeGateResults uses — W-030); otherwise we
# report the most relevant non-success result status (failed/conflict/aborted)
# or "none" for the always-on merge_status output field. Echoes exactly one of:
# merged | success | failed | conflict | aborted | none.
merge_status_for_branch() {
  local git_root="$1" branch="$2" studio="$3" results_dir="$4"
  if [ -n "$branch" ] && [ -n "$studio" ] \
     && git -C "$git_root" rev-parse --verify -q "$branch" >/dev/null 2>&1 \
     && git -C "$git_root" rev-parse --verify -q "$studio" >/dev/null 2>&1 \
     && git -C "$git_root" merge-base --is-ancestor "$branch" "$studio" 2>/dev/null; then
    echo "merged"; return 0
  fi
  local slug="${branch##*/}" f stem st best="none"
  if [ -n "$slug" ] && [ -d "$results_dir" ]; then
    for f in "$results_dir"/*.json; do
      [ -e "$f" ] || continue
      stem="$(basename "$f")"; stem="${stem%.json}"; stem="${stem%.summary}"
      case "$stem" in *"$slug"*) ;; *) continue ;; esac
      st="$(sed -n 's/.*"status"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" | head -1)"
      [ -n "$st" ] || continue
      if [ "$st" = "success" ]; then echo "success"; return 0; fi
      best="$st"
    done
  fi
  echo "$best"
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
    if remove_checkout_dir "$GIT_ROOT" "$checkout" 1; then
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

# --record-touches (W-021): record the measured base_sha..HEAD path set into
# context.json task.touches_actual and STOP — this mode removes nothing. Delegates
# to record_touches.ts (robust JSON patch). Run at REPORTING, before the gate.
if [ "$RECORD_TOUCHES" -eq 1 ]; then
  CONTEXT_JSON="$CONTAINER/context.json"
  [ -f "$CONTEXT_JSON" ] || { echo "dispatch_cleanup: --record-touches: no context.json at $CONTEXT_JSON" >&2; exit 1; }
  RT_TS="$(cd "$(dirname "$0")/../driver/src/dispatch" 2>/dev/null && pwd -P)/record_touches.ts"
  [ -f "$RT_TS" ] || { echo "dispatch_cleanup: --record-touches: record_touches.ts not found at $RT_TS" >&2; exit 1; }
  bun "$RT_TS" --context "$CONTEXT_JSON" --checkout "$CHECKOUT"
  exit $?
fi

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
  _mh="$(git -C "$GIT_ROOT" rev-parse --verify -q MERGE_HEAD 2>/dev/null || true)"
  _tip="$(git -C "$GIT_ROOT" rev-parse --verify -q "$BRANCH" 2>/dev/null || true)"
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

# Merge status of this branch, computed unconditionally so it can be surfaced in
# the output JSON on every run (W-044). The in-progress guard above covers a
# merge that is STILL running; this covers a merge that has FINISHED but did NOT
# succeed (conflict/failed leaves the lock released and MERGE_HEAD gone, so the
# guard above no longer fires) yet the branch is being deleted.
STUDIO_BRANCH=""
CLEANUP_CONFIG="$PROJECT/__garelier/$PM/_pm/setup_config.toml"
if [ -f "$CLEANUP_CONFIG" ]; then
  STUDIO_BRANCH="$(sed -n 's/^[[:space:]]*integration[[:space:]]*=[[:space:]]*"\(.*\)".*$/\1/p' "$CLEANUP_CONFIG" | head -1)"
fi
MERGE_STATUS="$(merge_status_for_branch "$GIT_ROOT" "$BRANCH" "$STUDIO_BRANCH" "$PROJECT/__garelier/$PM/runtime/merge_gate/results")"

# W-044: refuse to delete a branch that is not confirmed merged. Default-deny so a
# blind "cleanup + delete branch" run cannot silently discard a branch whose
# merge conflicted/failed. Worktree-only cleanup (no --delete-branch) is
# unaffected — it keeps the branch, so its commits survive. --force overrides.
if [ "$DELETE_BRANCH" -eq 1 ] && [ "$FORCE" -ne 1 ] \
   && [ "$MERGE_STATUS" != "merged" ] && [ "$MERGE_STATUS" != "success" ]; then
  echo "dispatch_cleanup: REFUSING to delete branch '$BRANCH' — it is not confirmed merged (merge_status=$MERGE_STATUS: its tip is not an ancestor of studio and no status=success merge result matches its slug). A conflicted/failed merge leaves those commits reachable only from the branch, so deleting now loses that work. Verify the merge landed, or re-run with --force to delete anyway." >&2
  exit 3
fi

# Remove the worktree (retry + backoff). On persistent handle-lock, DEFER instead
# of leaking a stale dir — git is pruned; the physical dir is swept later.
CLEANUP_STATUS="success"
if ! remove_checkout_dir "$GIT_ROOT" "$CHECKOUT" "$FORCE"; then
  echo "dispatch_cleanup: worktree dir still locked after retries; deferring to failed_cleanups.jsonl (git pruned)" >&2
  append_failed_cleanup "$ID" "$CONTAINER" "worktree dir locked after retries"
  CLEANUP_STATUS="deferred"
fi

if [ "$DELETE_BRANCH" -eq 1 ] && [ -n "$BRANCH" ]; then
  git -C "$GIT_ROOT" branch -D "$BRANCH" >&2 2>/dev/null || true
fi

# W-019: transcribe the register-derived text into report.md BEFORE archiving, so
# the archived report is the canonical outcome rather than the untouched scaffold.
REPORT_SOURCE="none"
if [ -n "$REPORT_FROM_FILE" ] && transcribe_report_from_file "$REPORT_FROM_FILE" "$CONTAINER/report.md"; then
  REPORT_SOURCE="$REPORT_FROM_FILE"
fi

# Archive the coordination files to runtime/backlog/done/ before removing the
# container (the protocol's completed assignment+report archive — mechanical,
# nothing to remember). Slug derived from the branch family path.
SLUG="${BRANCH##*/}"; [ -n "$SLUG" ] || SLUG="dispatch"
DONE_DIR="$PROJECT/__garelier/$PM/runtime/backlog/done"
if [ -f "$CONTAINER/assignment.md" ] || [ -f "$CONTAINER/report.md" ] || [ -f "$CONTAINER/questions.md" ] || [ -f "$CONTAINER/answers.md" ] || [ -f "$CONTAINER/instructions.md" ]; then
  mkdir -p "$DONE_DIR"
  {
    printf '# #%s %s - archived by dispatch_cleanup (%s)\n\n' "$ID" "$SLUG" "${BRANCH:-no-branch}"
    if [ -f "$CONTAINER/assignment.md" ]; then
      cat "$CONTAINER/assignment.md"
      [ -f "$CONTAINER/report.md" ] && printf '\n---\n\n'
    fi
    [ -f "$CONTAINER/report.md" ] && cat "$CONTAINER/report.md"
    # W-092: preserve the instruction ledger (its consumed-refs trail) alongside the report.
    for f in questions answers instructions; do
      if [ -f "$CONTAINER/$f.md" ]; then printf '\n---\n\n'; cat "$CONTAINER/$f.md"; fi
    done
  } > "$DONE_DIR/$ID-$SLUG.md"
  [ -f "$CONTAINER/report.json" ] && cp "$CONTAINER/report.json" "$DONE_DIR/$ID-$SLUG.json"
fi

# The dispatch container is framework-owned and ephemeral. Once its worktree is
# removed and the completion ledger above is archived, assignment/context/pickup
# packs, checkpoints, gate briefs, and JSON drafts are all regenerable runtime
# state. Remove the whole container so new artifact kinds cannot leak stale
# `_dispatch<N>/` directories.
rm -rf "$CONTAINER" 2>/dev/null || true
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

# W-076: a completed cleanup is a task_mirror anchor (DEC-092). Emit the copyable
# `task_mirror --format ops` command in the result so the caller (the PM, who is
# this script's invoker) re-derives its session Task list from the canonical
# backlog instead of hand-updating it — event-driven, so the PM never has to
# remember. The mirror re-derives from source, so this only removes the manual
# step; see the anchor protocol in pm_playbook §11. task_mirror.ts is under the
# sibling driver tree (…/driver/src/dispatch/); resolve it to an absolute path so
# the command is copy-runnable regardless of the caller's cwd.
TASK_MIRROR_TS="$(cd "$(dirname "$0")/../driver/src/dispatch" 2>/dev/null && pwd -P)/task_mirror.ts"
TASK_MIRROR_HINT="bun $TASK_MIRROR_TS --pm-id $PM --project $PROJECT --format ops"

printf '{"id":%s,"removed":"%s","branch":"%s","branch_deleted":%s,"cleanup_status":"%s","merge_status":"%s","report_source":"%s","task_mirror_hint":"%s"}\n' \
  "$ID" "$(json_escape "$CHECKOUT")" "$(json_escape "$BRANCH")" "$([ "$DELETE_BRANCH" -eq 1 ] && echo true || echo false)" "$CLEANUP_STATUS" "$MERGE_STATUS" "$(json_escape "$REPORT_SOURCE")" "$(json_escape "$TASK_MIRROR_HINT")"
