#!/usr/bin/env bash
#
# workspace_isolate.sh — lightweight producer isolation for control-only repos
# (W-028). dispatch_prepare.sh/dispatch_cleanup.sh assume a target project's
# __garelier/<pm_id>/_dispatch<N>/ scaffolding; a control-only repo (e.g. this
# framework repo, dispatch-native not configured) has none of that, so an
# attended PM dispatching 2+ producer subagents in parallel has them share the
# ONE working tree and collide on the git index/HEAD. This gives the same
# "isolate -> producer works alone -> collect" shape with just `git worktree`
# and no __garelier/ dependency, usable in ANY git repo.
#
# Modes:
#   workspace_isolate.sh --repo <path> --slug <kebab> [--base <branch>]
#       Cut a lightweight branch garelier/isolate/<slug> off <branch>
#       (default: repo's current branch) and create a worktree at
#       <repo>/.garelier-work/<slug>/. Prints one JSON line:
#         {"worktree":"...","branch":"...","base_sha":"..."}
#       The producer does all its work (edits + commits) inside that worktree.
#
#   workspace_isolate.sh --collect --repo <path> --slug <kebab> [--base <branch>] [--force-collect]
#       Integrate the isolate branch's commits back into its base branch
#       (<repo> must be checked out ON that base branch, clean working tree):
#       fast-forward when possible, else cherry-pick commit by commit. Refuses
#       (exit 2) if the isolate WORKTREE itself has uncommitted changes — a
#       producer may still be mid-edit there, and the old behavior removed the
#       worktree unconditionally, silently destroying that work (W-080; real
#       incident 2026-07-05). Pass --force-collect to discard the uncommitted
#       changes anyway. On a cherry-pick conflict, prints manual-resolution
#       steps and exits 3 WITHOUT touching the worktree/branch (no
#       auto-resolve — DEC-001 style: a conflict is a human/producer
#       decision). On success, removes the worktree + isolate branch and
#       prints:
#         {"collected":true,"mode":"ff"|"cherry-pick","branch":"...","commits":N}
#
#   workspace_isolate.sh --abort --repo <path> --slug <kebab>
#       Discard the isolate branch's commits (never merged) and remove the
#       worktree + branch. Prints {"aborted":true,"branch":"..."}.
#
# Exit codes: 0 ok; 2 usage/precondition error (includes: isolate worktree has
# uncommitted changes and --force-collect was not given); 3 cherry-pick
# conflict (collect only — resolve by hand, then re-run --abort to clean up,
# or finish the cherry-pick sequence in <repo> yourself and re-run --collect).
set -uo pipefail

MODE="isolate"
REPO="" SLUG="" BASE=""
FORCE_COLLECT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --collect) MODE="collect"; shift ;;
    --abort)   MODE="abort"; shift ;;
    --repo)    REPO="${2:?}"; shift 2 ;;
    --slug)    SLUG="${2:?}"; shift 2 ;;
    --base)    BASE="${2:?}"; shift 2 ;;
    --force-collect) FORCE_COLLECT=1; shift ;;
    -h|--help) sed -n '2,42p' "$0"; exit 0 ;;
    *) echo "workspace_isolate: unknown arg: $1" >&2
       echo "workspace_isolate: valid flags: --collect --abort --repo --slug --base --force-collect -h/--help" >&2
       exit 2 ;;
  esac
done
[ -n "$REPO" ] && [ -n "$SLUG" ] || {
  echo "workspace_isolate: --repo and --slug are required" >&2; exit 2; }
case "$SLUG" in (*[!a-z0-9-]*) echo "workspace_isolate: --slug must be kebab-case [a-z0-9-]" >&2; exit 2 ;; esac
git -C "$REPO" rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo "workspace_isolate: --repo is not a git repository: $REPO" >&2; exit 2; }

WORKTREE="$REPO/.garelier-work/$SLUG"
BRANCH="garelier/isolate/$SLUG"
META_DIR="$REPO/.garelier-work/.meta"
META="$META_DIR/$SLUG.json"

# .garelier-work/ never pollutes the outer repo's status/diff (info/exclude,
# not .gitignore, so it stays local-only and off-history like the other
# garelier/* worktree conventions).
add_exclude() {
  local common_dir exclude_file
  common_dir="$(git -C "$REPO" rev-parse --git-common-dir 2>/dev/null)" || return 0
  case "$common_dir" in /*) ;; *) common_dir="$REPO/$common_dir" ;; esac
  exclude_file="$common_dir/info/exclude"
  mkdir -p "$(dirname "$exclude_file")" 2>/dev/null || return 0
  grep -qxF '.garelier-work/' "$exclude_file" 2>/dev/null || printf '.garelier-work/\n' >> "$exclude_file"
}

cleanup_worktree_branch() {
  git -C "$REPO" worktree remove --force "$WORKTREE" >&2 2>/dev/null || rm -rf "$WORKTREE"
  git -C "$REPO" worktree prune >&2 2>/dev/null || true
  git -C "$REPO" branch -D "$BRANCH" >&2 2>/dev/null || true
  rm -f "$META" 2>/dev/null || true
}

case "$MODE" in
isolate)
  [ ! -e "$WORKTREE" ] || { echo "workspace_isolate: worktree already exists for slug '$SLUG': $WORKTREE (collect or --abort it first)" >&2; exit 2; }
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH" && {
    echo "workspace_isolate: branch already exists for slug '$SLUG': $BRANCH (collect or --abort it first)" >&2; exit 2; }
  if [ -z "$BASE" ]; then
    BASE="$(git -C "$REPO" branch --show-current)"
    [ -n "$BASE" ] || { echo "workspace_isolate: --repo is on a detached HEAD; pass --base explicitly" >&2; exit 2; }
  fi
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$BASE" || {
    echo "workspace_isolate: --base branch not found: $BASE" >&2; exit 2; }

  add_exclude
  mkdir -p "$META_DIR"
  if ! git -C "$REPO" worktree add "$WORKTREE" -b "$BRANCH" "$BASE" >&2; then
    echo "workspace_isolate: git worktree add failed" >&2; exit 1
  fi
  BASE_SHA="$(git -C "$REPO" rev-parse --short "$BASE")"
  printf '{"base":"%s"}\n' "$BASE" > "$META"
  # commit_template (W-051): the ready-to-copy commit skeleton for work in this
  # isolate worktree. The `Garelier:` marker trailer's actor is fully filled
  # (`isolate/<slug>`, the part producers drift on); pm_id + item-id stay
  # placeholders the producer fills (this script has neither). `\n` are literal
  # JSON escapes. See commit_convention.md § Garelier marker.
  COMMIT_TEMPLATE="$(printf '<type>(<scope>): <summary>  [<item-id>]\\n\\nGarelier: <pm_id> isolate/%s <item-id>' "$SLUG")"
  printf '{"worktree":"%s","branch":"%s","base_sha":"%s","commit_template":"%s"}\n' "$WORKTREE" "$BRANCH" "$BASE_SHA" "$COMMIT_TEMPLATE"
  ;;

collect)
  [ -d "$WORKTREE" ] || { echo "workspace_isolate: no worktree for slug '$SLUG': $WORKTREE" >&2; exit 2; }
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH" || {
    echo "workspace_isolate: no isolate branch for slug '$SLUG': $BRANCH" >&2; exit 2; }

  # W-080: the isolate WORKTREE (not just <repo>) can hold uncommitted
  # producer edits — a worker mid-task when the PM decides to collect.
  # cleanup_worktree_branch below does `git worktree remove --force`, which
  # used to discard those edits with no warning (real incident 2026-07-05,
  # W-077 follow-up C: the PM read 3 unanswered messages as "abandoned" and
  # collected while the worker was still editing). Refuse unless clean or
  # the caller opts in with --force-collect.
  if [ "$FORCE_COLLECT" -ne 1 ]; then
    DIRTY="$(git -C "$WORKTREE" status --porcelain)"
    if [ -n "$DIRTY" ]; then
      echo "workspace_isolate: isolate worktree for slug '$SLUG' has uncommitted changes ($WORKTREE) — refusing to collect. Files:" >&2
      echo "$DIRTY" | head -5 | sed 's/^/  /' >&2
      echo "workspace_isolate: have the producer commit its work, or re-run with --force-collect to discard the uncommitted changes." >&2
      exit 2
    fi
  fi

  if [ -z "$BASE" ] && [ -f "$META" ]; then
    BASE="$(sed -n 's/.*"base":"\([^"]*\)".*/\1/p' "$META")"
  fi
  [ -n "$BASE" ] || { echo "workspace_isolate: no --base given and no meta at $META; pass --base explicitly" >&2; exit 2; }

  CURRENT="$(git -C "$REPO" branch --show-current)"
  [ "$CURRENT" = "$BASE" ] || {
    echo "workspace_isolate: <repo> must be checked out on base branch '$BASE' to collect (currently '$CURRENT'). Run: git -C $REPO checkout $BASE" >&2; exit 2; }
  [ -z "$(git -C "$REPO" status --porcelain)" ] || {
    echo "workspace_isolate: <repo> working tree is not clean; commit or stash before collect" >&2; exit 2; }

  COMMIT_COUNT="$(git -C "$REPO" rev-list --count "$BASE..$BRANCH")"
  if git -C "$REPO" merge --ff-only "$BRANCH" >&2 2>/dev/null; then
    cleanup_worktree_branch
    printf '{"collected":true,"mode":"ff","branch":"%s","commits":%s}\n' "$BRANCH" "$COMMIT_COUNT"
    exit 0
  fi

  COMMITS="$(git -C "$REPO" log --reverse --format=%H "$BASE..$BRANCH")"
  PICKED=0
  while IFS= read -r sha; do
    [ -n "$sha" ] || continue
    if ! git -C "$REPO" cherry-pick "$sha" >&2; then
      echo "workspace_isolate: cherry-pick conflict at $sha collecting '$SLUG' into '$BASE' ($PICKED/$COMMIT_COUNT already applied). Resolve manually:" >&2
      echo "  1. cd $REPO && git status                 # inspect the conflict" >&2
      echo "  2. fix conflicts, then: git add <files>" >&2
      echo "  3. git cherry-pick --continue               # repeat if more commits remain" >&2
      echo "     (or: git cherry-pick --abort              # give up this collect attempt)" >&2
      echo "  4. Once done, clean up by hand: git -C $REPO worktree remove --force $WORKTREE && git -C $REPO branch -D $BRANCH && rm -f $META" >&2
      echo "     (or re-run: workspace_isolate.sh --abort --repo $REPO --slug $SLUG   -- only if you aborted the cherry-pick in step 3)" >&2
      exit 3
    fi
    PICKED=$((PICKED + 1))
  done <<<"$COMMITS"
  cleanup_worktree_branch
  printf '{"collected":true,"mode":"cherry-pick","branch":"%s","commits":%s}\n' "$BRANCH" "$PICKED"
  ;;

abort)
  [ -d "$WORKTREE" ] || [ -f "$META" ] || git -C "$REPO" show-ref --verify --quiet "refs/heads/$BRANCH" || {
    echo "workspace_isolate: nothing to abort for slug '$SLUG'" >&2; exit 2; }
  cleanup_worktree_branch
  printf '{"aborted":true,"branch":"%s"}\n' "$BRANCH"
  ;;
esac
