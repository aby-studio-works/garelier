#!/usr/bin/env bash
#
# task_mirror_hook.test.sh — pins task_mirror_hook.sh, the framework-owned
# PostToolUse Task-mirror delta hook (workshop W-030).
#
# Builds a throwaway __garelier control tree with a real backlog, feeds the hook
# PostToolUse JSON on stdin (the exact shape Claude Code emits), and asserts the
# four contract branches:
#   a. OUT-OF-SCOPE  -> a command that is not a land/dispatch script: no output,
#      exit 0, no state file (pure-bash reject, no subprocess).
#   b. PARSE + BASELINE -> a land/dispatch command carrying --project/--pm-id:
#      parsed correctly, first run is SILENT (records the baseline, no dump), and
#      the state file appears at the derived runtime/driver path.
#   c. NO-DELTA -> an identical second run prints nothing (zero tokens injected).
#   d. DELTA -> a backlog row added between runs -> one compact `TASK-MIRROR diff:`
#      line naming the new key.
# Plus the 誤爆ゼロ guard: a matching script name but NO --pm-id/--project is
# silent (never guesses).
#
# Self-contained: run directly (`bash task_mirror_hook.test.sh`) or from ci.sh.
# Needs `bun` (the hook runs task_mirror.ts + parses JSON with bun). Exits 0 only
# if every branch holds.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SELF_DIR/task_mirror_hook.sh"
[ -f "$HOOK" ] || { echo "task_mirror_hook.test: cannot find task_mirror_hook.sh next to me" >&2; exit 1; }
command -v bun >/dev/null 2>&1 || { echo "task_mirror_hook.test: 'bun' not on PATH — cannot run the mirror" >&2; exit 1; }

# Git-Bash `/tmp` and native Bun's `/tmp` can name different Windows trees.
# Keep the fixture beside this test in an ignored `*.tmp` scratch directory;
# both runtimes then resolve the same physical worktree path on every platform.
TMP_ROOT="$(mktemp -d --suffix=.tmp "$SELF_DIR/task_mirror_hook.XXXXXX")"
TMP="$TMP_ROOT/case"
mkdir -p "$TMP"
trap 'rm -rf "$TMP_ROOT"' EXIT
fail() { echo "  FAIL: $*" >&2; exit 1; }

PM="demo"
BL="$TMP/__garelier/$PM/control/project_dashboard"
STATE="$TMP/__garelier/$PM/runtime/driver/task_mirror_hook_state.json"
mkdir -p "$BL"

# A minimal 9-column backlog table (the shape task_mirror.ts::parseBacklog reads).
cat > "$BL/backlog.md" <<'EOF'
# Backlog

| ID | Type | Prio | Status | Owner | Milestone | Desc | Accept | Blueprint |
| -- | ---- | ---- | ------ | ----- | --------- | ---- | ------ | --------- |
| W-001 | feature | high | ready | - | m1 | **First task** | done | — |
| W-002 | bug | normal | triage | - | m1 | **Second task** | done | — |
EOF

# fire <command-string> -> sets OUT/RC by feeding PostToolUse JSON to the hook.
fire() {
  set +e
  OUT="$(printf '{"tool_input":{"command":"%s"}}' "$1" | bash "$HOOK" 2>&1)"
  RC=$?
  set -e
}

DISPATCH_CMD="bash dispatch_prepare.sh --project $TMP --pm-id $PM --role worker"

# a. OUT-OF-SCOPE: a plain command is rejected with no output and no state file.
fire "ls -la"
[ "$RC" -eq 0 ] || fail "out-of-scope: expected exit 0, got $RC"
[ -z "$OUT" ]   || fail "out-of-scope: expected no output, got: $OUT"
[ ! -f "$STATE" ] || fail "out-of-scope: no state file should be written"

# 誤爆ゼロ: a matching script name but missing --pm-id/--project is silent.
fire "bash merge_land.sh --id 7"
[ "$RC" -eq 0 ] || fail "no-flags: expected exit 0, got $RC"
[ -z "$OUT" ]   || fail "no-flags: expected no output, got: $OUT"
[ ! -f "$STATE" ] || fail "no-flags: no state file without parsed pm-id/project"

# b. PARSE + BASELINE: first real run is silent and records the baseline.
fire "$DISPATCH_CMD"
[ "$RC" -eq 0 ] || fail "baseline: expected exit 0, got $RC"
[ -z "$OUT" ]   || fail "baseline: first run must be silent (no dump), got: $OUT"
[ -f "$STATE" ] || fail "baseline: state file not written at $STATE"
grep -q 'W-001' "$STATE" || fail "baseline: state missing W-001 ($(cat "$STATE"))"
grep -q 'W-002' "$STATE" || fail "baseline: state missing W-002 ($(cat "$STATE"))"

# c. NO-DELTA: an identical second run injects nothing.
fire "$DISPATCH_CMD"
[ "$RC" -eq 0 ] || fail "no-delta: expected exit 0, got $RC"
[ -z "$OUT" ]   || fail "no-delta: unchanged mirror must be silent, got: $OUT"

# d. DELTA: a new backlog row surfaces as one compact diff line naming the key.
cat >> "$BL/backlog.md" <<'EOF'
| W-003 | feature | high | ready | - | m2 | **Third task** | done | — |
EOF
fire "$DISPATCH_CMD"
[ "$RC" -eq 0 ] || fail "delta: expected exit 0, got $RC"
printf '%s' "$OUT" | grep -q 'TASK-MIRROR diff:' || fail "delta: expected a TASK-MIRROR diff line, got: $OUT"
printf '%s' "$OUT" | grep -q 'W-003'             || fail "delta: diff should name the new key W-003, got: $OUT"

# and the delta is one-shot: re-firing with no further change is silent again.
fire "$DISPATCH_CMD"
[ -z "$OUT" ] || fail "delta: should be one-shot; re-run must be silent, got: $OUT"

# W-091 class b: a RESOLVABLE --project but an UNRESOLVED --pm-id (no dispatch
# tree under it) writes nothing and never mkdir's an __garelier/<id>/ stray —
# fail-quiet, so the observed `__garelier/tpm/…` `{}` stray can't recur.
fire "bash dispatch_prepare.sh --project $TMP --pm-id ghost --role worker"
[ "$RC" -eq 0 ] || fail "unresolved-pm: expected exit 0, got $RC"
[ -z "$OUT" ]   || fail "unresolved-pm: expected no output, got: $OUT"
[ ! -e "$TMP/__garelier/ghost" ] || fail "unresolved-pm: must not create an __garelier/ghost stray"

echo "task_mirror_hook.test: OK (out-of-scope / no-flags guard / baseline / no-delta / delta / one-shot / unresolved-pm fail-quiet)"
