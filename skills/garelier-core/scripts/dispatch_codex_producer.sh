#!/usr/bin/env bash
#
# Dispatch a NON-Claude producer (Codex) as a RUN-TO-COMPLETION subprocess for
# the DEC-057/DEC-058 dispatch orchestrator. The Claude Agent/Workflow tool can
# only spawn Claude subagents; this is how the interactive orchestrator (Dock/PM)
# gives a role to Codex instead: it runs `codex exec` SYNCHRONOUSLY in the role's
# worktree, waits for completion, and prints the producer's final message so the
# orchestrator can integrate the returned branch via the normal merge gate.
#
# Mirrors the driver's codex-cli adapter (providers/codex_cli.ts) flags so the
# behaviour matches `[execution] backend = codex`.
#
# Usage:
#   dispatch_codex_producer.sh \
#     --worktree <dir>        # role worktree (cwd; already on its branch off studio)
#     --project  <dir>        # project root (granted via --add-dir)
#     --prompt   <file>       # the role prompt (assignment) on stdin to codex
#     --result   <file>       # where to capture codex's final message
#     [--sandbox read-only|workspace-write]   # default workspace-write (commit-bearing roles)
#     [--model <name>] [--effort <low|medium|high|xhigh>]
#     [--skill-root <dir>]    # extra read dir (Garelier skill root), optional
#
# Exit code = codex exec's exit code. The final message is also echoed to stdout
# between sentinels so it is easy to extract from a background-task log.

set -u

WORKTREE="" PROJECT="" PROMPT="" RESULT="" SANDBOX="workspace-write" MODEL="" EFFORT="" SKILLROOT=""
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
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
for req in WORKTREE PROJECT PROMPT RESULT; do
  if [ -z "${!req}" ]; then echo "missing --${req,,}" >&2; exit 2; fi
done
if ! command -v codex >/dev/null 2>&1; then echo "codex CLI not on PATH" >&2; exit 3; fi

args=( exec --cd "$WORKTREE" --add-dir "$PROJECT" --sandbox "$SANDBOX"
       -c approval_policy="never" --output-last-message "$RESULT" --json )
[ -n "$SKILLROOT" ] && args+=( --add-dir "$SKILLROOT" )
[ -n "$MODEL" ] && args+=( --model "$MODEL" )
[ -n "$EFFORT" ] && args+=( -c "model_reasoning_effort=\"$EFFORT\"" )
args+=( - )

echo "[dispatch_codex_producer] codex exec (sandbox=$SANDBOX cwd=$WORKTREE) — SYNCHRONOUS, waiting..." >&2
codex "${args[@]}" < "$PROMPT"
rc=$?
echo "__CODEX_RESULT_BEGIN__"
[ -f "$RESULT" ] && cat "$RESULT" || echo "(no result file written)"
echo "__CODEX_RESULT_END__"
echo "__CODEX_EXIT__:$rc"
exit $rc
