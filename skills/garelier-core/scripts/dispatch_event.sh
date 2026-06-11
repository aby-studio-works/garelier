#!/usr/bin/env bash
#
# Garelier dispatch event (bash) — W-011 (DEC-064 §3): single-source runtime
# execution state.
#
#   1. Appends ONE event line to runtime/dispatch/events.jsonl — the
#      append-only record of dispatch execution ({ts, role, kind, task, ref};
#      proper JSON escaping, so callers never hand-write JSON).
#   2. Regenerates the derived view runtime/backlog/in_flight.md from the
#      live _dispatch<N>/STATE.md containers (the structural truth). The view
#      is GENERATED — never hand-edited.
#
# Orchestrators and the jig RECORD phase call this instead of hand-appending
# JSON or maintaining in_flight.md ("code enforces order; the model judges
# content"). dispatch_prepare/dispatch_cleanup call it for start/cleanup.
#
# Usage:
#   dispatch_event.sh --project <root> --pm-id <id> \
#     --kind <start|complete|blocked|rework|cleanup|note> \
#     --role "<role(#id)>" --task "<text>" [--ref <path>]
#   dispatch_event.sh --project <root> --pm-id <id> --regen-only
set -euo pipefail

PROJECT="" PM="" KIND="" ROLE="" TASK="" REF="" REGEN_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --project)    PROJECT="${2:?}"; shift 2 ;;
    --pm-id)      PM="${2:?}"; shift 2 ;;
    --kind)       KIND="${2:?}"; shift 2 ;;
    --role)       ROLE="${2:?}"; shift 2 ;;
    --task)       TASK="${2:?}"; shift 2 ;;
    --ref)        REF="${2:?}"; shift 2 ;;
    --regen-only) REGEN_ONLY=1; shift ;;
    *) echo "dispatch_event: unknown arg $1" >&2; exit 1 ;;
  esac
done
if [ -z "$PROJECT" ] || [ -z "$PM" ]; then
  echo "usage: dispatch_event.sh --project <root> --pm-id <id> --kind <k> --role <r> --task <t> [--ref <p>] | --regen-only" >&2
  exit 1
fi

BASE="$PROJECT/__garelier/$PM"
[ -d "$BASE" ] || { echo "dispatch_event: no PM at $BASE" >&2; exit 1; }

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\r'; }

if [ "$REGEN_ONLY" -eq 0 ]; then
  if [ -z "$KIND" ] || [ -z "$ROLE" ] || [ -z "$TASK" ]; then
    echo "dispatch_event: --kind/--role/--task required (or pass --regen-only)" >&2
    exit 1
  fi
  EV_DIR="$BASE/runtime/dispatch"
  mkdir -p "$EV_DIR"
  REF_JSON="null"
  [ -n "$REF" ] && REF_JSON="\"$(json_escape "$REF")\""
  printf '{"ts":"%s","role":"%s","kind":"%s","task":"%s","ref":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(json_escape "$ROLE")" "$(json_escape "$KIND")" \
    "$(json_escape "$TASK")" "$REF_JSON" >> "$EV_DIR/events.jsonl"
fi

# Derived view: the live producers. Structural truth = _dispatch<N>/STATE.md
# (created by dispatch_prepare, removed by dispatch_cleanup), so the view can
# never disagree with what is actually executing.
VIEW="$BASE/runtime/backlog/in_flight.md"
mkdir -p "$(dirname "$VIEW")"
{
  echo "# In flight — GENERATED VIEW (DEC-064 W-011)"
  echo ""
  echo "Derived from the live \`_dispatch<N>/STATE.md\` containers by"
  echo "\`scripts/dispatch_event.{sh,ps1}\`. Do not edit — rewritten on every"
  echo "dispatch event. The append-only record is \`runtime/dispatch/events.jsonl\`."
  echo ""
  echo "| Task | Agent | Branch |"
  echo "| ---- | ----- | ------ |"
  for d in "$BASE"/_dispatch*/; do
    [ -f "${d}STATE.md" ] || continue
    n="$(basename "$d")"; n="${n#_dispatch}"
    role="$(sed -n 's/^#[[:space:]]*Dispatch[[:space:]]*#[0-9]*[[:space:]]*-[[:space:]]*\([A-Za-z]*\).*/\1/p' "${d}STATE.md" | head -1)"
    task="$(awk '/^##[[:space:]]*Current task/{f=1;next} f && NF {print; exit}' "${d}STATE.md")"
    branch="$(printf '%s' "$task" | sed -n 's/.*(\([^()]*\))[[:space:]]*$/\1/p')"
    taskname="$(printf '%s' "$task" | sed 's/[[:space:]]*([^()]*)[[:space:]]*$//')"
    echo "| ${taskname:-#$n} | dispatch$n (${role:-?}) | ${branch:-} |"
  done
  # Legacy/parked: any non-IDLE persistent role container also carries live
  # work (same truth status.{sh,ps1} shows as PARKED).
  for d in "$BASE"/_workers/*/ "$BASE"/_scouts/*/ "$BASE"/_smiths/*/ "$BASE"/_librarians/*/ \
           "$BASE"/_observers/*/ "$BASE"/_guardians/*/ "$BASE"/_concierges/*/ "$BASE"/_artisan/; do
    [ -f "${d}STATE.md" ] || continue
    st="$(awk '/^##[[:space:]]*Status/{f=1;next} f && NF {gsub(/[[:space:]]/,""); print; exit}' "${d}STATE.md")"
    case "$st" in IDLE|idle|"") continue ;; esac
    rel="${d#"$BASE"/}"; rel="${rel%/}"
    roledir="${rel%%/*}"; roledir="${roledir#_}"; roledir="${roledir%s}"   # _workers -> worker
    id="${rel##*/}"; [ "$rel" = "_artisan" ] && { id="artisan"; roledir="artisan"; }
    task="$(awk '/^##[[:space:]]*Current task/{f=1;next} f && NF {print; exit}' "${d}STATE.md" | cut -c1-100)"
    echo "| ${task:-($st)} | $id ($roledir) | |"
  done
} > "$VIEW"
