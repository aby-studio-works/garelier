#!/usr/bin/env bash
#
# Dispatch a NON-Claude producer (Codex) as a RUN-TO-COMPLETION subprocess for
# the DEC-057/DEC-058 dispatch Dock. The Claude Agent/Workflow tool can
# only spawn Claude subagents; this is how the interactive Dock/PM
# gives a role to Codex instead: it runs `codex exec` SYNCHRONOUSLY in the role's
# worktree, waits for completion, and prints the producer's final message so the
# Dock can integrate the returned branch via the normal merge gate.
#
# Sets the codex-cli flags (sandbox / approval_policy / model / reasoning effort)
# so a Codex seat behaves like its claude-code peers under dispatch.
#
# Usage:
#   dispatch_codex_producer.sh \
#     --worktree <dir>        # role worktree (cwd; already on its branch off studio)
#     --project  <dir>        # project/control root (granted via --add-dir)
#     --prompt   <file>       # the role prompt (assignment) on stdin to codex
#     --result   <file>       # where to capture codex's final message
#     [--sandbox read-only|workspace-write]   # default workspace-write (commit-bearing roles)
#     [--model <name>] [--effort <low|medium|high|xhigh|ultra>]   # ultra = gpt-5.6-sol subagent fan-out mode (high cost; pair with a token budget)
#     [--skill-root <dir>]    # extra read dir (Garelier skill root), optional
#     [--target-root <dir>]   # Plant-Crust target checkout, optional
#     [--add-dir <dir>]       # repeatable extra grant for workspace-write
#
# Exit code = codex exec's exit code. The final message is also echoed to stdout
# between sentinels so it is easy to extract from a background-task log.

set -u

WORKTREE="" PROJECT="" PROMPT="" RESULT="" SANDBOX="workspace-write" MODEL="" EFFORT="" SKILLROOT="" TARGETROOT=""
EXTRA_ADD_DIRS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --worktree) WORKTREE="$2"; shift 2 ;;
    --project)  PROJECT="$2"; shift 2 ;;
    --prompt)   PROMPT="$2"; shift 2 ;;
    --result)   RESULT="$2"; shift 2 ;;
    --sandbox)  SANDBOX="$2"; shift 2 ;;
    --model)    MODEL="$2"; shift 2 ;;
    --effort)   EFFORT="$2"; shift 2 ;;
    --skill-root) SKILLROOT="$2"; shift 2 ;;
    --target-root) TARGETROOT="$2"; shift 2 ;;
    --add-dir) EXTRA_ADD_DIRS+=("$2"); shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
for req in WORKTREE PROJECT PROMPT RESULT; do
  if [ -z "${!req}" ]; then echo "missing --${req,,}" >&2; exit 2; fi
done
case "$SANDBOX" in
  read-only|workspace-write) ;;
  danger-full-access)
    echo "dispatch_codex_producer: danger-full-access is not allowed; use workspace-write plus --add-dir grants" >&2
    exit 2
    ;;
  *)
    echo "dispatch_codex_producer: unsupported --sandbox '$SANDBOX' (expected read-only or workspace-write)" >&2
    exit 2
    ;;
esac
if ! command -v codex >/dev/null 2>&1; then echo "codex CLI not on PATH" >&2; exit 3; fi

resolve_dir_native() {
  local input="$1" posix="" abs=""
  [ -n "$input" ] || return 1
  if [ -d "$input" ]; then
    posix="$input"
  elif command -v cygpath >/dev/null 2>&1; then
    posix="$(cygpath -u "$input" 2>/dev/null || true)"
    [ -n "$posix" ] && [ -d "$posix" ] || return 1
  else
    return 1
  fi
  abs="$(cd "$posix" 2>/dev/null && pwd -P)" || return 1
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$abs"
  else
    printf '%s\n' "$abs"
  fi
}

resolve_dir_posix() {
  local input="$1" posix=""
  [ -n "$input" ] || return 1
  if [ -d "$input" ]; then
    posix="$input"
  elif command -v cygpath >/dev/null 2>&1; then
    posix="$(cygpath -u "$input" 2>/dev/null || true)"
    [ -n "$posix" ] && [ -d "$posix" ] || return 1
  else
    return 1
  fi
  (cd "$posix" 2>/dev/null && pwd -P)
}

resolve_file_posix() {
  local input="$1" posix=""
  [ -n "$input" ] || return 1
  if [ -f "$input" ]; then
    posix="$input"
  elif command -v cygpath >/dev/null 2>&1; then
    posix="$(cygpath -u "$input" 2>/dev/null || true)"
    [ -n "$posix" ] && [ -f "$posix" ] || return 1
  else
    return 1
  fi
  local dir base
  dir="$(cd "$(dirname "$posix")" 2>/dev/null && pwd -P)" || return 1
  base="$(basename "$posix")"
  printf '%s/%s\n' "$dir" "$base"
}

native_path_for_cli() {
  local input="$1"
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$input"
  else
    printf '%s\n' "$input"
  fi
}

ADD_DIRS=()
add_dir_unique() {
  local dir="$1" native="" existing=""
  native="$(resolve_dir_native "$dir" 2>/dev/null || true)"
  [ -n "$native" ] || return 0
  for existing in "${ADD_DIRS[@]}"; do
    [ "$existing" = "$native" ] && return 0
  done
  ADD_DIRS+=("$native")
}

add_context_dirs() {
  local ctx="$1"
  [ -f "$ctx" ] || return 0
  command -v bun >/dev/null 2>&1 || return 0
  local line
  while IFS= read -r line; do
    add_dir_unique "$line"
  done < <(bun -e '
    const path = process.argv[1];
    try {
      const j = JSON.parse(await Bun.file(path).text());
      const values = [
        j?.project?.project_root,
        j?.project?.control_root,
        j?.project?.target_root,
        j?.control_root,
        j?.target_root,
      ];
      for (const v of values) if (typeof v === "string" && v.length) console.log(v);
    } catch {}
  ' "$ctx" 2>/dev/null)
}

WORKTREE_NATIVE="$(resolve_dir_native "$WORKTREE" 2>/dev/null || true)"
PROJECT_NATIVE="$(resolve_dir_native "$PROJECT" 2>/dev/null || true)"
PROMPT_POSIX="$(resolve_file_posix "$PROMPT" 2>/dev/null || true)"
RESULT_POSIX="$(command -v cygpath >/dev/null 2>&1 && cygpath -u "$RESULT" 2>/dev/null || printf '%s' "$RESULT")"
RESULT_NATIVE="$(native_path_for_cli "$RESULT_POSIX")"
[ -n "$WORKTREE_NATIVE" ] || { echo "dispatch_codex_producer: --worktree is not an existing directory: $WORKTREE" >&2; exit 2; }
[ -n "$PROJECT_NATIVE" ] || { echo "dispatch_codex_producer: --project is not an existing directory: $PROJECT" >&2; exit 2; }
[ -n "$PROMPT_POSIX" ] || { echo "dispatch_codex_producer: --prompt is not a file: $PROMPT" >&2; exit 2; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd -P)"
SKILLS_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
WORKTREE_POSIX="$(resolve_dir_posix "$WORKTREE" 2>/dev/null || true)"
CONTAINER_POSIX=""
if [ -n "$WORKTREE_POSIX" ]; then
  CONTAINER_POSIX="$(dirname "$WORKTREE_POSIX")"
fi

add_dir_unique "$PROJECT_NATIVE"
add_dir_unique "$WORKTREE_NATIVE"
[ -n "$CONTAINER_POSIX" ] && add_dir_unique "$CONTAINER_POSIX"
add_dir_unique "$(dirname "$RESULT_POSIX")"
[ -n "$TARGETROOT" ] && add_dir_unique "$TARGETROOT"
add_dir_unique "${SKILLROOT:-$SKILLS_ROOT}"
# Codex CLI now treats a skill-load stat failure as fatal (was a warning),
# so the dispatched thread dies instantly unless it can read its own
# ~/.codex/skills tree (e.g. .system/{imagegen,openai-docs,...}). Grant it
# read access by default; add_dir_unique silently no-ops when the dir is
# absent (resolve_dir_native requires -d), so this is a no-op on hosts
# without a Codex skills tree.
add_dir_unique "${CODEX_HOME:-$HOME/.codex}/skills"
[ -n "$CONTAINER_POSIX" ] && add_context_dirs "$CONTAINER_POSIX/context.json"
for extra in "${EXTRA_ADD_DIRS[@]}"; do
  add_dir_unique "$extra"
done

args=( exec --cd "$WORKTREE_NATIVE" --sandbox "$SANDBOX"
       -c approval_policy="never" --output-last-message "$RESULT_NATIVE" --json )
for dir in "${ADD_DIRS[@]}"; do
  args+=( --add-dir "$dir" )
done
[ -n "$MODEL" ] && args+=( --model "$MODEL" )
[ -n "$EFFORT" ] && args+=( -c "model_reasoning_effort=\"$EFFORT\"" )
args+=( - )

echo "[dispatch_codex_producer] codex exec (sandbox=$SANDBOX cwd=$WORKTREE_NATIVE add_dirs=${#ADD_DIRS[@]}) — SYNCHRONOUS, waiting..." >&2
codex "${args[@]}" < "$PROMPT_POSIX"
rc=$?
echo "__CODEX_RESULT_BEGIN__"
[ -f "$RESULT_POSIX" ] && cat "$RESULT_POSIX" || echo "(no result file written)"
echo "__CODEX_RESULT_END__"
echo "__CODEX_EXIT__:$rc"
exit $rc
