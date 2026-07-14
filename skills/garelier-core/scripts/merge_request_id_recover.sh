#!/usr/bin/env bash
#
# merge_request_id_recover.sh — W-064: recover a merge-gate request_id from
# EVIDENCE when the submitter's stdout JSON could not be parsed.
#
# Why: merge_land.sh extracts request_id from merge_request.sh's one-line JSON
# stdout. In the field (target project #287, 2026-07-13) merge_request created a
# VALID request file and returned rc=0, but the stdout parse yielded nothing and
# merge_land false-aborted ("no request was created") while the request sat in
# the gate queue. The request FILE is the truth; stdout is only a convenience.
# This helper recovers the id from (in order):
#   1. the submitter's stderr log line  "merge_request: wrote <path>.json"
#   2. the newest *.json in the requests dir NOT OLDER than --since (epoch)
# and prints the request_id (from the file's "request_id" field, falling back
# to the basename minus .json — the two are the same by construction in
# merge_request.sh). Prints nothing and exits 1 when no evidence is found.
#
# Usage:
#   merge_request_id_recover.sh --stderr-file <file> \
#       [--requests-dir <dir>] [--since <epoch-seconds>]
#
set -euo pipefail

STDERR_FILE="" REQ_DIR="" SINCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --stderr-file)  STDERR_FILE="${2:?}"; shift 2 ;;
    --requests-dir) REQ_DIR="${2:?}"; shift 2 ;;
    --since)        SINCE="${2:?}"; shift 2 ;;
    *) echo "merge_request_id_recover: unknown arg: $1" >&2; exit 2 ;;
  esac
done

req_file=""

# 1. Deterministic evidence: the submitter logs the exact path it wrote.
if [ -n "$STDERR_FILE" ] && [ -f "$STDERR_FILE" ]; then
  req_file="$(grep -oE 'wrote [^[:space:]]+\.json' "$STDERR_FILE" 2>/dev/null \
    | tail -1 | sed 's/^wrote //' || true)"
  # The logged path may be relative to the submitter's cwd; keep it only if it
  # resolves. Otherwise retry against the requests dir by basename.
  if [ -n "$req_file" ] && [ ! -f "$req_file" ] && [ -n "$REQ_DIR" ]; then
    base="$(basename "$req_file")"
    [ -f "$REQ_DIR/$base" ] && req_file="$REQ_DIR/$base" || req_file=""
  fi
  [ -n "$req_file" ] && [ ! -f "$req_file" ] && req_file=""
fi

# 2. Newest request file in the gate dir, guarded by --since so a stale request
#    from an EARLIER land can never be picked up.
if [ -z "$req_file" ] && [ -n "$REQ_DIR" ] && [ -d "$REQ_DIR" ]; then
  newest=""
  for f in "$REQ_DIR"/*.json; do
    [ -f "$f" ] || continue
    mtime="$(date -r "$f" +%s 2>/dev/null || stat -c %Y "$f" 2>/dev/null || echo 0)"
    if [ "$mtime" -ge "$SINCE" ]; then
      if [ -z "$newest" ] || [ "$mtime" -gt "$newest_mtime" ]; then
        newest="$f"; newest_mtime="$mtime"
      fi
    fi
  done
  req_file="$newest"
fi

[ -n "$req_file" ] && [ -f "$req_file" ] || exit 1

# Extract the id: prefer the JSON field, fall back to the basename convention.
rid=""
if command -v bun >/dev/null 2>&1; then
  rid="$(bun -e 'const fs=require("fs");try{const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(j.request_id||"");}catch{}' "$req_file" 2>/dev/null || true)"
fi
[ -z "$rid" ] && rid="$(basename "$req_file" .json)"
[ -n "$rid" ] || exit 1
printf '%s\n' "$rid"
