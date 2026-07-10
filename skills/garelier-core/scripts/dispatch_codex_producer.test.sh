#!/usr/bin/env bash
#
# dispatch_codex_producer.test.sh — pins the Codex subprocess sandbox contract:
#
#   1. Garelier never launches Codex with danger-full-access.
#   2. workspace-write launches get mechanical --add-dir grants for the project,
#      dispatch checkout, dispatch container, result directory, Garelier skills
#      root, Plant-Crust target root, context.json project roots, and explicit
#      --add-dir entries.
#
# Self-contained: run directly (`bash dispatch_codex_producer.test.sh`) or from
# ci.sh. Uses a fake `codex` on PATH; does not require the real Codex CLI.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd -P)"
PRODUCER="$SELF_DIR/dispatch_codex_producer.sh"
[ -f "$PRODUCER" ] || { echo "dispatch_codex_producer.test: cannot find helper next to me" >&2; exit 1; }

fail() { echo "  FAIL: $*" >&2; exit 1; }
native_path() {
  local p="$1" abs=""
  abs="$(cd "$p" 2>/dev/null && pwd -P)" || return 1
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$abs"
  else
    printf '%s\n' "$abs"
  fi
}
contains_line() {
  local file="$1" want="$2"
  grep -Fx -- "$want" "$file" >/dev/null 2>&1
}

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP" 2>/dev/null || true; }
trap cleanup EXIT

FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
cat > "$FAKEBIN/codex" <<'SH'
#!/usr/bin/env bash
set -u
printf '%s\n' "$@" > "$CODEX_ARGS_FILE"
cat > "$CODEX_STDIN_FILE"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; break; fi
  prev="$arg"
done
[ -n "$out" ] && { mkdir -p "$(dirname "$out")"; printf 'fake final message\n' > "$out"; }
exit "${CODEX_EXIT:-0}"
SH
chmod +x "$FAKEBIN/codex"

PROJECT="$TMP/project"
CONTAINER="$PROJECT/__garelier/tpm/_dispatch1"
WORKTREE="$CONTAINER/checkout"
TARGET="$TMP/target-root"
CONTEXT_TARGET="$TMP/context-target-root"
EXTRA="$TMP/extra-grant"
RESULT_DIR="$TMP/result-dir"
mkdir -p "$WORKTREE" "$TARGET" "$CONTEXT_TARGET" "$EXTRA" "$RESULT_DIR"
PROMPT="$CONTAINER/codex_prompt.md"
RESULT="$RESULT_DIR/codex_result.md"
printf 'do the assigned work\n' > "$PROMPT"
printf '{"project":{"project_root":"%s","control_root":"%s","target_root":"%s"}}\n' \
  "$CONTEXT_TARGET" "$PROJECT" "$CONTEXT_TARGET" > "$CONTAINER/context.json"

export CODEX_ARGS_FILE="$TMP/codex_args.txt"
export CODEX_STDIN_FILE="$TMP/codex_stdin.txt"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"
if ! PATH="$FAKEBIN:$PATH" bash "$PRODUCER" \
    --worktree "$WORKTREE" \
    --project "$PROJECT" \
    --prompt "$PROMPT" \
    --result "$RESULT" \
    --target-root "$TARGET" \
    --add-dir "$EXTRA" \
    --model gpt-test \
    --effort high \
    >"$OUT" 2>"$ERR"; then
  fail "workspace-write launch failed. stderr=$(cat "$ERR")"
fi

contains_line "$CODEX_ARGS_FILE" "exec" || fail "codex args missing exec"
contains_line "$CODEX_ARGS_FILE" "--cd" || fail "codex args missing --cd"
contains_line "$CODEX_ARGS_FILE" "$(native_path "$WORKTREE")" || fail "codex args missing worktree path"
contains_line "$CODEX_ARGS_FILE" "--sandbox" || fail "codex args missing --sandbox"
contains_line "$CODEX_ARGS_FILE" "workspace-write" || fail "codex args missing workspace-write"
contains_line "$CODEX_ARGS_FILE" "approval_policy=never" || fail "codex args missing approval_policy=never"
contains_line "$CODEX_ARGS_FILE" "--json" || fail "codex args missing --json"
contains_line "$CODEX_ARGS_FILE" "gpt-test" || fail "codex args missing model"
contains_line "$CODEX_ARGS_FILE" 'model_reasoning_effort="high"' || fail "codex args missing reasoning effort"

for granted in "$PROJECT" "$WORKTREE" "$CONTAINER" "$RESULT_DIR" "$TARGET" "$CONTEXT_TARGET" "$EXTRA" "$(cd "$SELF_DIR/../.." && pwd -P)"; do
  contains_line "$CODEX_ARGS_FILE" "$(native_path "$granted")" || fail "missing --add-dir grant for $granted"
done
! grep -q 'danger-full-access' "$CODEX_ARGS_FILE" || fail "danger-full-access leaked into codex args"
grep -q 'fake final message' "$OUT" || fail "helper did not echo captured final message"
grep -q 'do the assigned work' "$CODEX_STDIN_FILE" || fail "prompt was not sent on stdin"

if command -v cygpath >/dev/null 2>&1; then
  rm -f "$CODEX_ARGS_FILE" "$CODEX_STDIN_FILE" "$OUT" "$ERR" "$RESULT"
  WIN_WORKTREE="$(cygpath -m "$WORKTREE")"
  WIN_PROJECT="$(cygpath -m "$PROJECT")"
  WIN_PROMPT="$(cygpath -m "$PROMPT")"
  WIN_RESULT="$(cygpath -m "$RESULT")"
  if ! PATH="$FAKEBIN:$PATH" bash "$PRODUCER" \
      --worktree "$WIN_WORKTREE" \
      --project "$WIN_PROJECT" \
      --prompt "$WIN_PROMPT" \
      --result "$WIN_RESULT" \
      --sandbox read-only \
      >"$OUT" 2>"$ERR"; then
    fail "Windows-style path launch failed. stderr=$(cat "$ERR")"
  fi
  contains_line "$CODEX_ARGS_FILE" "read-only" || fail "Windows-style path launch missing read-only sandbox"
  contains_line "$CODEX_ARGS_FILE" "$(native_path "$WORKTREE")" || fail "Windows-style path launch did not normalize worktree"
  grep -q 'fake final message' "$OUT" || fail "Windows-style path launch did not echo final message"
  grep -q 'do the assigned work' "$CODEX_STDIN_FILE" || fail "Windows-style prompt was not sent on stdin"
fi

rm -f "$CODEX_ARGS_FILE" "$CODEX_STDIN_FILE" "$OUT" "$ERR"
if PATH="$FAKEBIN:$PATH" bash "$PRODUCER" \
    --worktree "$WORKTREE" --project "$PROJECT" --prompt "$PROMPT" --result "$RESULT" \
    --sandbox danger-full-access >"$OUT" 2>"$ERR"; then
  fail "danger-full-access launch unexpectedly succeeded"
fi
grep -q 'danger-full-access is not allowed' "$ERR" || fail "danger-full-access rejection message missing"
[ ! -f "$CODEX_ARGS_FILE" ] || fail "fake codex was invoked after danger-full-access rejection"

echo "dispatch_codex_producer.test: OK"
