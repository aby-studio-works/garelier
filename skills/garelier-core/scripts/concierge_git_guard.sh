#!/usr/bin/env bash
# Garelier Concierge git guard (DEC-030) — the sanctioned path for any git
# operation the Concierge runs that could touch a remote. It MECHANICALLY refuses
# the operations the Concierge SKILL forbids, instead of relying on the prompt.
# The pre-push hook (hooks/pre-push) is the unconditional backstop for pushes.
#
# Modes:
#   concierge_git_guard.sh <git-subcommand> [args...]
#       Run a git command with the universal bans enforced:
#         - `pull`                        => REFUSED (use fetch + a named merge)
#         - `push --force|-f|--force-with-lease`  => REFUSED (no history rewrite)
#         - push of a garelier/* ref     => REFUSED (local-only branches)
#       Read-only commands (fetch/status/log/diff/ls-remote/...) pass through.
#
#   concierge_git_guard.sh preflight-target-push \
#       --remote <remote> --ref <target-branch> \
#       --expected-sha <sha> --verdict <guardian_report.md> --head <sha>
#       Verify BEFORE a promote/push to <target>:
#         - the live remote tip equals <expected-sha>  (no drift / no clobber)
#         - <verdict> is a PASS / PASS_WITH_NOTES whose review_sha == <head>
#           (a passing Guardian gate bound to exactly what is being pushed)
#       Exit 0 only when both hold. The Concierge MUST pass this before pushing.
#
# Exit codes: 0 ok; 2 refused/blocked; 3 verification failed; 4 usage.

set -u

die_refuse() { echo "concierge_git_guard: REFUSED — $*" >&2; exit 2; }
die_verify() { echo "concierge_git_guard: VERIFY FAILED — $*" >&2; exit 3; }
die_usage()  { echo "concierge_git_guard: usage error — $*" >&2; exit 4; }

[ "$#" -ge 1 ] || die_usage "no command"

mode="$1"

if [ "$mode" = "preflight-target-push" ]; then
  shift
  remote=""; ref=""; expected=""; verdict=""; head=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --remote) remote="${2:-}"; shift 2 ;;
      --ref) ref="${2:-}"; shift 2 ;;
      --expected-sha) expected="${2:-}"; shift 2 ;;
      --verdict) verdict="${2:-}"; shift 2 ;;
      --head) head="${2:-}"; shift 2 ;;
      *) die_usage "unknown preflight arg '$1'" ;;
    esac
  done
  [ -n "$remote" ] && [ -n "$ref" ] && [ -n "$expected" ] && [ -n "$verdict" ] && [ -n "$head" ] \
    || die_usage "preflight-target-push needs --remote --ref --expected-sha --verdict --head"

  case "$ref" in garelier/*|*/garelier/*) die_refuse "target ref '$ref' is a local-only garelier/* branch" ;; esac

  # Drift guard: the live remote tip must equal the expected sha the PM approved.
  live="$(git ls-remote "$remote" "refs/heads/$ref" 2>/dev/null | awk 'NR==1{print $1}')"
  if [ -z "$live" ]; then
    echo "concierge_git_guard: remote '$remote' has no refs/heads/$ref yet (new branch); skipping drift check." >&2
  elif [ "$live" != "$expected" ]; then
    die_verify "remote $ref tip $live != expected $expected (drift — refuse to clobber)"
  fi

  # Gate guard: a PASS/PASS_WITH_NOTES verdict bound to exactly this head.
  [ -f "$verdict" ] || die_verify "guardian verdict file not found: $verdict"
  if ! grep -Eiq '^[[:space:]]*verdict[[:space:]]*:?[[:space:]]*(PASS|PASS_WITH_NOTES)\b' "$verdict"; then
    die_verify "guardian verdict in $verdict is not PASS / PASS_WITH_NOTES"
  fi
  # Capture only the leading hex run after review_sha: a quoted or commented
  # value yields no match.
  vsha="$(grep -Ei '^[[:space:]]*review_sha[[:space:]]*:?[[:space:]]*' "$verdict" | head -1 | sed -nE 's/^[[:space:]]*review_sha[[:space:]]*:?[[:space:]]*([0-9a-fA-F]+).*/\1/Ip')"
  if [ -z "$vsha" ]; then
    die_verify "guardian verdict in $verdict has no review_sha (cannot bind the gate to the push)"
  fi
  if [ "$vsha" != "$head" ]; then
    die_verify "guardian review_sha $vsha != head $head (stale verdict — re-gate before pushing)"
  fi
  echo "concierge_git_guard: preflight OK — remote $ref at $expected, PASS verdict bound to $head."
  exit 0
fi

# ---- git passthrough mode with universal bans ----
sub="$mode"

if [ "$sub" = "pull" ]; then
  die_refuse "'git pull' is forbidden for the Concierge — use 'fetch' + an explicit, assignment-named merge"
fi

if [ "$sub" = "push" ]; then
  for a in "$@"; do
    case "$a" in
      -f|--force|--force-with-lease|--force-with-lease=*) die_refuse "force push ('$a') is forbidden (no history rewrite)" ;;
      *garelier/*) die_refuse "pushing a garelier/* ref ('$a') is forbidden (local-only branches)" ;;
    esac
  done
fi

# Everything else (fetch / status / log / diff / ls-remote / a vetted push) runs.
# The pre-push hook is the unconditional backstop for pushes.
exec git "$@"
