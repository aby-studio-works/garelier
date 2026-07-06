#!/usr/bin/env bash
#
# workspace_isolate.test.sh — pins workspace_isolate.sh's --collect
# dirty-worktree guard (W-080).
#
# Real incident (2026-07-05): `--collect` removed the isolate worktree
# unconditionally (`git worktree remove --force`) once its branch merged
# cleanly, so a producer's uncommitted mid-task edit sitting in that worktree
# was silently destroyed when the PM collected early (read 3 unanswered
# messages as "abandoned" while the worker was still editing). This test
# builds a throwaway repo + isolate worktree and pins:
#   1. dirty worktree, no --force-collect -> refuse (exit 2), message lists
#      the file and points at --force-collect, worktree/branch left intact,
#      the uncommitted change survives.
#   2. same dirty worktree + --force-collect -> collects anyway (worktree +
#      branch removed as before).
#   3. clean worktree (regression)        -> collects exactly as before,
#      no --force-collect required.
#
# Self-contained: run directly (`bash workspace_isolate.test.sh`) or from
# ci.sh. Exits 0 only if every branch holds.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
WI="$SELF_DIR/workspace_isolate.sh"
[ -f "$WI" ] || { echo "workspace_isolate.test: cannot find workspace_isolate.sh next to me" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "  FAIL: $*" >&2; exit 1; }

(
  set -e
  cd "$TMP"
  git init -q -b main .
  git config user.email ci@ci; git config user.name ci
  echo base > file.txt
  git add -A
  git -c commit.gpgsign=false commit -qm init

  # === 1. dirty isolate worktree, no --force-collect -> refuse ==============
  OUT1="$(bash "$WI" --repo "$TMP" --slug dirty-refuse)" || fail "isolate (dirty-refuse) failed"
  WT1="$(echo "$OUT1" | sed -n 's/.*"worktree":"\([^"]*\)".*/\1/p')"
  [ -d "$WT1" ] || fail "isolate did not create worktree: $OUT1"
  echo "wip edit" >> "$WT1/file.txt"   # uncommitted change inside the isolate worktree

  set +e
  ERR1="$(bash "$WI" --collect --repo "$TMP" --slug dirty-refuse 2>&1 1>/dev/null)"
  RC1=$?
  set -e
  [ "$RC1" -eq 2 ] || fail "dirty collect (no force) exit was $RC1 (expected 2): $ERR1"
  echo "$ERR1" | grep -q "uncommitted changes" || fail "refuse message missing 'uncommitted changes': $ERR1"
  echo "$ERR1" | grep -q "file.txt" || fail "refuse message did not list the dirty file: $ERR1"
  echo "$ERR1" | grep -q -- "--force-collect" || fail "refuse message did not mention --force-collect: $ERR1"
  [ -d "$WT1" ] || fail "refuse must NOT remove the worktree"
  git show-ref --verify --quiet "refs/heads/garelier/isolate/dirty-refuse" \
    || fail "refuse must NOT remove the isolate branch"
  [ -n "$(git -C "$WT1" status --porcelain)" ] || fail "refuse must leave the uncommitted change intact"

  # === 2. same dirty worktree + --force-collect -> collects anyway ==========
  OUT2="$(bash "$WI" --collect --repo "$TMP" --slug dirty-refuse --force-collect)" \
    || fail "force-collect exited non-zero"
  echo "$OUT2" | grep -q '"collected":true' || fail "force-collect did not report collected:true: $OUT2"
  [ ! -d "$WT1" ] || fail "force-collect left the worktree behind"
  git show-ref --verify --quiet "refs/heads/garelier/isolate/dirty-refuse" \
    && fail "force-collect left the isolate branch behind"
  true

  # === 3. clean worktree (regression) -> collects without --force-collect ===
  OUT3="$(bash "$WI" --repo "$TMP" --slug clean-ok)" || fail "isolate (clean-ok) failed"
  WT3="$(echo "$OUT3" | sed -n 's/.*"worktree":"\([^"]*\)".*/\1/p')"
  echo "clean work" >> "$WT3/file.txt"
  git -C "$WT3" add -A
  git -C "$WT3" -c commit.gpgsign=false commit -qm "clean work"
  OUT4="$(bash "$WI" --collect --repo "$TMP" --slug clean-ok)" || fail "clean collect (no force) failed"
  echo "$OUT4" | grep -q '"collected":true' || fail "clean collect did not report collected:true: $OUT4"
  [ ! -d "$WT3" ] || fail "clean collect left the worktree behind"
  grep -q "clean work" file.txt || fail "clean collect did not land the commit onto base"
) || exit 1

echo "workspace_isolate.test: all branches pass (dirty-refuse / force-collect / clean-regression)"
