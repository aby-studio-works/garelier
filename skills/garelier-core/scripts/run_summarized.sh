#!/usr/bin/env bash
#
# run_summarized.sh — inbound output discipline (W-043b; rtk concept
# https://github.com/rtk-ai/rtk generalized — no external binary, bash only).
# Runs a command, keeps its FULL output in a log file, and prints only a
# compact structured summary to stdout: exit code, a recognized-pattern
# digest (cargo test `test result:` lines / build-style error+warning counts
# / fmt-diff presence / generic line-count+tail fallback), the log path, and
# — never omitted — the first 20 failure/error lines reproduced VERBATIM, so
# gate-relevant detail is never hidden from the caller. This is the inbound
# counterpart to the outbound "Inter-agent compressed register"
# (garelier-core/output_control.md).
#
# Usage:
#   run_summarized.sh --log-dir <dir> --slug <slug> -- <command...>
set -uo pipefail

LOG_DIR="" SLUG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --log-dir) LOG_DIR="${2:?}"; shift 2 ;;
    --slug)    SLUG="${2:?}"; shift 2 ;;
    --)        shift; break ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "run_summarized: unknown arg: $1" >&2
       echo "run_summarized: valid flags: --log-dir --slug -- <command...> (-h/--help)" >&2
       exit 2 ;;
  esac
done
[ -n "$LOG_DIR" ] && [ -n "$SLUG" ] || {
  echo "run_summarized: --log-dir and --slug are required" >&2; exit 2; }
[ $# -gt 0 ] || {
  echo "run_summarized: no command given (put it after --)" >&2; exit 2; }

mkdir -p "$LOG_DIR" 2>/dev/null || {
  echo "run_summarized: cannot create log dir: $LOG_DIR" >&2; exit 2; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="$LOG_DIR/$TS-$SLUG.log"

"$@" >"$LOG_FILE" 2>&1
EXIT_CODE=$?

LINES="$(wc -l < "$LOG_FILE" | tr -d ' ')"
echo "run_summarized: exit=$EXIT_CODE lines=$LINES log=$LOG_FILE"

# --- recognized-pattern summary (each independent; more than one may fire) --
matched=0

if grep -q '^test result:' "$LOG_FILE" 2>/dev/null; then
  matched=1
  echo "-- test result --"
  grep '^test result:' "$LOG_FILE"
fi

err_n="$(grep -cE '^error(\[|:| )?' "$LOG_FILE" 2>/dev/null)"; err_n="${err_n:-0}"
warn_n="$(grep -cE '^warning(:|\[)' "$LOG_FILE" 2>/dev/null)"; warn_n="${warn_n:-0}"
if [ "$err_n" -gt 0 ] || [ "$warn_n" -gt 0 ]; then
  matched=1
  echo "-- build diagnostics -- errors=$err_n warnings=$warn_n"
fi

if grep -qE '^Diff in |^\+\+\+ |^--- ' "$LOG_FILE" 2>/dev/null; then
  matched=1
  echo "-- fmt/diff -- formatting differences present"
fi

if [ "$matched" -eq 0 ]; then
  echo "-- summary -- $LINES lines; last 5:"
  tail -n 5 "$LOG_FILE"
fi

# --- failure/error lines, VERBATIM, first 20 (gate-relevant detail; never
# summarized away — this is the deliberate rtk-vs-here difference) ---------
FAIL_LINES="$(grep -E 'error|FAILED|panicked|Error:' "$LOG_FILE" 2>/dev/null | head -20)"
if [ -n "$FAIL_LINES" ]; then
  echo "-- failure/error lines (first 20, verbatim) --"
  printf '%s\n' "$FAIL_LINES"
fi

exit "$EXIT_CODE"
