#!/usr/bin/env bash
#
# blueprint_ship.test.sh — pins blueprint_ship.sh's ship/abandon bookkeeping.
#
# Builds a throwaway repo with a __garelier/<pm>/ tree (two history entries, one
# matching the shipped slug and one not) and pins:
#   1. shipped: blueprint moved to archive/ with Status: shipped, the MATCHING
#      history entry Outcome flips in-progress -> shipped and its "-" Notes gets
#      a date stamp, the OTHER entry is untouched, script never commits.
#   2. --dry-run touches nothing on disk.
#   3. abandoned: Status: archived.
#   4. slug with no in-progress history entry: archive still happens, a note is
#      printed, exit stays 0.
#
# Self-contained: run directly (`bash blueprint_ship.test.sh`) or from ci.sh.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
BS="$SELF_DIR/blueprint_ship.sh"
[ -f "$BS" ] || { echo "blueprint_ship.test: cannot find blueprint_ship.sh next to me" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
GREL="__garelier"

fail() { echo "  FAIL: $*" >&2; exit 1; }

# Write a fresh __garelier/<pm>/ fixture into $1 (project root).
seed() {
  local root="$1" pm="acme"
  local bp="$root/$GREL/$pm/control/blueprints"
  local hist="$root/$GREL/$pm/_pm"
  mkdir -p "$bp" "$hist"
  cat > "$bp/my-slug.md" <<'EOF'
# Blueprint: my thing

- Status: active
- Owner: PM
EOF
  cat > "$bp/other-slug.md" <<'EOF'
# Blueprint: other thing

- Status: active
EOF
  cat > "$hist/history.md" <<EOF
# History

## #001 — 2026-01-01T00:00:00Z — other thing
- Blueprint: $GREL/acme/control/blueprints/other-slug.md
- Milestone: -
- Outcome: in-progress
- Reason: user-request — x
- Decision: -
- Escalation: none
- Commits: -
- Follow-up: -
- Notes: -

## #002 — 2026-01-02T00:00:00Z — my thing
- Blueprint: $GREL/acme/control/blueprints/my-slug.md
- Milestone: -
- Outcome: in-progress
- Reason: user-request — y
- Decision: -
- Escalation: none
- Commits: 3
- Follow-up: -
- Notes: -

Next entry number: 3
EOF
}

# A fresh throwaway repo (own dir + git init + seeded fixture + init commit).
# Each case gets its own so staged git-mv state never leaks between cases.
fresh_repo() {
  local root="$TMP/$1"
  mkdir -p "$root"
  git init -q -b main "$root"
  git -C "$root" config user.email ci@ci; git -C "$root" config user.name ci
  seed "$root"
  git -C "$root" add -A
  git -C "$root" -c commit.gpgsign=false commit -qm init
  printf '%s' "$root"
}

(
  set -e

  # === 1. shipped ===========================================================
  R="$(fresh_repo case1)"
  OUT="$(bash "$BS" --project "$R" --pm-id acme --slug my-slug --outcome shipped --date 2026-07-05)" \
    || fail "shipped run exited non-zero: $OUT"
  BP="$R/$GREL/acme/control/blueprints"
  H="$R/$GREL/acme/_pm/history.md"
  [ -f "$BP/archive/my-slug.md" ] || fail "blueprint not moved to archive/"
  [ ! -e "$BP/my-slug.md" ] || fail "original blueprint still present"
  grep -qE '^- Status: shipped$' "$BP/archive/my-slug.md" || fail "archived blueprint Status not flipped to shipped"
  grep -q "shipped 2026-07-05" "$H" || fail "Notes date stamp missing"
  # #002 Outcome must be shipped, #001 must remain in-progress
  n_ship="$(grep -c '^- Outcome: shipped$' "$H")"
  [ "$n_ship" = "1" ] || fail "expected exactly one 'Outcome: shipped', got $n_ship"
  n_prog="$(grep -c '^- Outcome: in-progress$' "$H")"
  [ "$n_prog" = "1" ] || fail "other entry Outcome changed (expected 1 in-progress left, got $n_prog)"
  # never commits: the move + edits are unstaged/uncommitted
  git -C "$R" diff --quiet && fail "working tree unexpectedly clean — script must not commit"
  echo "  ok: shipped flips Status + history Outcome/Notes, moves to archive, no commit"

  # === 2. dry-run touches nothing ===========================================
  R2="$(fresh_repo case2)"
  bash "$BS" --project "$R2" --pm-id acme --slug my-slug --outcome shipped --dry-run >/dev/null \
    || fail "dry-run exited non-zero"
  git -C "$R2" diff --quiet || fail "dry-run modified tracked files"
  [ -f "$R2/$GREL/acme/control/blueprints/my-slug.md" ] || fail "dry-run moved the blueprint"
  echo "  ok: --dry-run changes nothing on disk"

  # === 3. abandoned -> Status archived ======================================
  R3="$(fresh_repo case3)"
  bash "$BS" --project "$R3" --pm-id acme --slug my-slug --outcome abandoned --date 2026-07-05 >/dev/null \
    || fail "abandoned run exited non-zero"
  grep -qE '^- Status: archived$' "$R3/$GREL/acme/control/blueprints/archive/my-slug.md" \
    || fail "abandoned Status not flipped to archived"
  echo "  ok: abandoned sets Status: archived"

  # === 4. slug with no in-progress history entry -> note, still exit 0 ======
  R4="$(fresh_repo case4)"
  H4="$R4/$GREL/acme/_pm/history.md"
  # flip both entries already-terminal so no in-progress entry matches my-slug
  sed -i 's/^- Outcome: in-progress$/- Outcome: shipped/' "$H4"
  OUT4="$(bash "$BS" --project "$R4" --pm-id acme --slug my-slug --outcome shipped)" \
    || fail "run with no in-progress entry should still exit 0"
  echo "$OUT4" | grep -q "note:" || fail "expected a note about the missing history flip"
  [ -f "$R4/$GREL/acme/control/blueprints/archive/my-slug.md" ] \
    || fail "blueprint should still be archived even without a history flip"
  echo "  ok: missing in-progress entry -> note, archive still happens, exit 0"
) || exit 1

echo "blueprint_ship.test: PASS"
