#!/usr/bin/env bash
#
# merge_land.sh — one background command for the whole PM merge ritual (W-088).
#
# The attended merge landing was FOUR separate touches the PM had to remember and
# sequence by hand: submit (merge_request.sh) -> arm the result waiter
# (gate_result_waiter.sh) -> on success clean up the dispatch (dispatch_cleanup.sh)
# -> pull. A missed waiter left the aftercare stalled (W-086); a mis-ordered
# cleanup raced the gate (W-055/W-044 guards). This macro collapses the four into
# ONE call the PM runs with run_in_background: it submits, BLOCK-waits for the gate
# result itself (blocking is fine — the PM backgrounded it), and only on a landed
# merge does it clean up + pull. On a failed/aborted/timed-out gate it cleans up
# NOTHING (the branch's work must survive) and returns the failure.
#
# It is a thin composition of the existing, individually-tested scripts — it adds
# no merge/gate logic of its own and never touches the backlog (PM-owned) or the
# merge-gate lock/queue (the gate self-drains, W-039). The gate spawn is the
# W-087-detached path, so the submit returns in seconds and the gate runs
# independently even if THIS process is later killed.
#
# Usage:
#   merge_land.sh --project <control-root> --pm-id <id>
#                 (--branch <workbench-branch> | --dispatch-id <N>)
#                 [--guardian <PASS|PASS_WITH_NOTES>] [--observer <verdict>]
#                 [--seat-trailer <checked|skip>]  (guardian round-3 N1 override)
#                 [--no-pull]
#                 [--close-row <item-id> …] [--backlog-path <path>] [--close-trailer <line>]
#                 [--max-wait <seconds>] [--poll-interval <seconds>]
#                 [ …any other merge_request.sh flag… ]
#
# Batch mode (W-022 — land several dispatches serially in ONE command, so the PM
# no longer hand-writes a `&& merge_land … && merge_land …` chain):
#   merge_land.sh --project <root> --pm-id <id> --id <N1> --id <N2> [--id <N3> …] <shared flags>
#   merge_land.sh --project <root> --pm-id <id> --batch <file>       <shared flags>
# Triggered when --id/--dispatch-id (or --branch) is given more than once, or when
# --batch <file> is passed. Each item is landed by RE-INVOKING this same single-land
# path (below) — the single path is untouched. Items run STRICTLY IN SEQUENCE (the
# merge gate stages a shared index, so parallel lands would race). On the FIRST
# failure the batch ABORTS: the remaining items are NOT attempted (a bad merge never
# drags the rest in), and the macro exits with that item's non-zero code. Progress
# is one line per item on stderr; each item's own single-land JSON streams to stdout,
# then a final `{"batch":true,…}` summary line. Flags OTHER than the per-item id/branch
# (--project, --pm-id, --guardian, --quality-gate, …) are SHARED across every item.
# Per-item --close-row (and any other per-item flag) goes in the --batch file, one
# item's full flag set per line (lines starting with `#` are comments); repeated --id
# is the quick form for the common "shared flags, differing ids" case.
#
# Every flag this script does not consume itself is forwarded VERBATIM to
# merge_request.sh (--task, --message, --studio, --guardian-report, --quality-gate,
# --preflight, --refuter-verdict, --high-stakes, --core, --target-root, …), so the
# macro tracks merge_request's surface without re-declaring it.
#
# Argument UX (W-017 — the merge ritual now takes the id the PM already has):
#   * --dispatch-id <N> (alias --id, the same id dispatch_prepare/dispatch_cleanup
#     use) resolves --branch from the dispatch container's checkout HEAD
#     (__garelier/<pm>/_dispatch<N>/checkout) when --branch is omitted. It also
#     names the container to clean up on success; with --branch given it is derived
#     from the branch's `#<N>/` segment as before. An explicit --branch always wins.
#   * --guardian / --observer are OPTIONAL: when omitted, the verdict is read from
#     the dispatch verdict marker (runtime/<role>/results/<slug>-<role>.md, the
#     `## Verdict` section) via the canonical fail-closed parser. A missing /
#     placeholder / malformed marker yields NO verdict (never an assumed PASS) — so
#     an absent Guardian verdict is a clear pre-submit error, not a rubber stamp. An
#     explicit flag always overrides the marker.
#   * All required inputs are validated ONCE up front: every missing/invalid arg is
#     reported together with usage, instead of the old submit-time one-at-a-time
#     "--branch required", then "--guardian required" dance.
#   * --seat-trailer <checked|skip> (guardian round-3 N1) is the explicit override
#     for the Garelier-Seat provenance preflight (below the Guardian/Observer
#     read): FAIL-CLOSED when the dispatch #<N>'s container/context.json is
#     unresolvable (the producer itself can delete/strip it — see the seam's own
#     comment), and a hard error on a real missing/malformed trailer finding when
#     the dispatch was commit_mode=proxy (or its model looked like a codex seat).
#     Pass `checked` when you have manually verified, or `skip` when this dispatch
#     needs no check at all; omit it and the preflight runs automatically.
#
# --no-pull skips the final `git pull --ff-only` (for local-only setups with no
# upstream). --max-wait / --poll-interval tune the result wait (defaults come from
# gate_result_waiter.sh: gate ceiling + margin / 30s).
#
# --close-row <item-id> (repeatable, W-093): on a LANDED merge, after cleanup+pull,
# strike the matching `| <item-id> |` row(s) from the project backlog and commit
# `chore(dashboard): <ids> close (merged <studio_commit>)`. This folds the PM's last
# manual touch — closing the row — into the same background command, without the
# lock-race stash dance. It is a SUCCESS-only step (a failed/aborted/timed-out gate
# never reaches it, so a failure never edits the backlog). Guarded by the merge-gate
# lock: if a NEXT gate has self-drained and is active, the row close is DEFERRED
# (the merge already landed — deferring costs the PM one manual strike, never data).
# --backlog-path overrides the default backlog location
# (<project>/__garelier/<pm_id>/control/project_dashboard/backlog.md). --close-trailer
# appends a verbatim git trailer line to the close commit (e.g. a project-specific
# `Garelier: <pm_id> pm-direct <epic>`); omitted, the commit carries no trailer.
#
# Output (stdout, one JSON line):
#   success  -> {"request_id","status":"success","studio_commit",
#                "dispatch_id","branch_deleted","cleanup_status","pulled"
#                [,"row_close":"closed|not-found|deferred (gate active)|…"]}  exit 0
#   failure  -> {"request_id","status":"<failed|conflict|aborted|timeout>",
#                "failure_reason","cleaned_up":false}                       exit 1|124
# Progress + each sub-step's own stderr stream through to stderr.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
# The merge-gate verdict parser (reused for the W-017 verdict auto-read below), so
# merge_land reads a `## Verdict` marker EXACTLY as the gate does — no second,
# drift-prone verdict regex. Resolved once; empty if the driver tree is absent.
PARSER_DIR="$(cd "$SELF_DIR/../driver/src" 2>/dev/null && pwd || true)"

# Minimal JSON string escaping (backslash + double-quote) — paths / reasons may
# carry `C:\…` or quotes; mirrors merge_request.sh / dispatch_cleanup.sh.
json_escape() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '%s' "$s"; }

# read_marker_verdict <marker-path> — emit the single canonical verdict token a
# gate role wrote into its `## Verdict` marker, or NOTHING when the file carries no
# such token. It delegates to merge_gate_parse.extractVerdict (fail-closed, W-057:
# `{{PASS | …}}` menus and typos like `PASSED` resolve to no verdict), so merge_land
# NEVER assumes a PASS the marker does not actually contain. Callers gate on the file
# EXISTING first (the `[ -f ]` guards below), so an empty return here means the file
# is present but MALFORMED — surfaced on stderr, distinct from an absent marker.
#
# W-027: the marker CONTENTS are read by `cat` HERE, in the caller's cwd (POSIX/MSYS
# aware), and piped to bun over stdin — the path never crosses the `cd "$PARSER_DIR"`
# below. Previously the path was passed INTO that cd, so a RELATIVE marker path (from
# `--project .`) resolved against PARSER_DIR, silently ENOENT'd (the error swallowed
# by 2>/dev/null), and read as "no verdict": a fail-closed misfire that reported a
# missing Guardian verdict when the marker was right there (2026-07-07, three
# consecutive land failures). The cd stays only so merge_gate_parse is a `./` require;
# bun reads stdin, so no path (and no MSYS→Windows translation) reaches it.
read_marker_verdict() {
  [ -n "$PARSER_DIR" ] && [ -f "$PARSER_DIR/merge_gate_parse.ts" ] || return 0
  local v
  v="$(cat -- "$1" 2>/dev/null | ( cd "$PARSER_DIR" || exit 0
    bun -e '
      const fs = require("node:fs");
      let text;
      try { text = fs.readFileSync(0, "utf8"); } catch { process.exit(0); }
      const { extractVerdict } = require("./merge_gate_parse.ts");
      const v = extractVerdict(text);
      if (v) process.stdout.write(v);
    ' 2>/dev/null ) )"
  if [ -n "$v" ]; then
    printf '%s' "$v"
  else
    echo "merge_land: verdict marker $1 is present but MALFORMED — no bare canonical token under '## Verdict' (a prose sentence, an unfilled {{…}} menu, bold like **PASS**, or a typo like PASSED all read as no-verdict; fix per templates/gate_verdict.md)" >&2
  fi
}

# ── W-022 batch pre-scan ────────────────────────────────────────────────────────
# Land SEVERAL dispatches in ONE command, serially. Triggered by --batch <file> OR
# by --id/--dispatch-id given more than once OR --branch given more than once. In
# batch mode we RE-INVOKE this same script once per item (so the single-land path
# below runs unchanged, per item); on the first failure we abort the rest. When NOT
# in batch mode we do nothing here and fall through to the untouched single path
# with "$@" intact — so a single land carrying BOTH --branch and --id (branch
# explicit + id for cleanup) is not mistaken for two items (each flag appears once).
_scan_shared=() _scan_items=() _scan_batch_file=""
_n_id=0 _n_branch=0
if [ $# -gt 0 ]; then
  _sa=("$@"); _si=0
  while [ $_si -lt ${#_sa[@]} ]; do
    case "${_sa[$_si]}" in
      --batch)             _scan_batch_file="${_sa[$((_si+1))]:-}"; _si=$((_si+2)) ;;
      --id|--dispatch-id)  _n_id=$((_n_id+1));     _scan_items+=("--id ${_sa[$((_si+1))]:-}");     _si=$((_si+2)) ;;
      --branch)            _n_branch=$((_n_branch+1)); _scan_items+=("--branch ${_sa[$((_si+1))]:-}"); _si=$((_si+2)) ;;
      *)                   _scan_shared+=("${_sa[$_si]}"); _si=$((_si+1)) ;;
    esac
  done
fi
_batch_mode=0
if [ -n "$_scan_batch_file" ]; then _batch_mode=1
elif [ "$_n_id" -ge 2 ] || [ "$_n_branch" -ge 2 ]; then _batch_mode=1; fi

if [ "$_batch_mode" -eq 1 ]; then
  # Build the per-item flag lists.
  _items=()
  if [ -n "$_scan_batch_file" ]; then
    # --batch takes the whole per-item flag set from each line; combining it with a
    # top-level --id/--branch is ambiguous, so refuse.
    if [ "$_n_id" -gt 0 ] || [ "$_n_branch" -gt 0 ]; then
      echo "merge_land: --batch <file> cannot be combined with top-level --id/--branch (put each item's flags on its own line in the file)" >&2
      exit 2
    fi
    [ -f "$_scan_batch_file" ] || { echo "merge_land: --batch file not found: $_scan_batch_file" >&2; exit 2; }
    while IFS= read -r _line || [ -n "$_line" ]; do
      # Trim; skip blank + whole-line comments. Do NOT strip inline '#': a branch
      # name contains '#<N>/', so an inline-comment strip would corrupt items.
      _line="${_line#"${_line%%[![:space:]]*}"}"     # ltrim
      _line="${_line%"${_line##*[![:space:]]}"}"     # rtrim
      [ -n "$_line" ] || continue
      case "$_line" in \#*) continue ;; esac
      _items+=("$_line")
    done < "$_scan_batch_file"
    [ "${#_items[@]}" -gt 0 ] || { echo "merge_land: --batch file $_scan_batch_file has no item lines" >&2; exit 2; }
  else
    _items=("${_scan_items[@]}")
  fi

  _total="${#_items[@]}" _n=0 _landed=0
  echo "merge_land: batch of $_total item(s) — landing serially, aborting the rest on the first failure." >&2
  for _it in "${_items[@]}"; do
    _n=$((_n+1))
    # Whitespace-split the per-item flag string into argv (ids/branches carry no spaces).
    read -ra _iargs <<< "$_it"
    echo "merge_land: [batch $_n/$_total] landing: ${_iargs[*]}" >&2
    set +e
    _out="$(bash "$0" "${_scan_shared[@]}" "${_iargs[@]}")"
    _rc=$?
    set -e
    [ -n "$_out" ] && printf '%s\n' "$_out"   # stream this item's own single-land JSON
    if [ "$_rc" -ne 0 ]; then
      echo "merge_land: [batch $_n/$_total] FAILED (rc=$_rc) — aborting; $((_total-_n)) remaining item(s) NOT attempted." >&2
      printf '{"batch":true,"total":%d,"attempted":%d,"landed":%d,"status":"failed","failed_item":"%s"}\n' \
        "$_total" "$_n" "$_landed" "$(json_escape "$_it")"
      exit "$_rc"
    fi
    _landed=$((_landed+1))
    echo "merge_land: [batch $_n/$_total] landed." >&2
  done
  echo "merge_land: batch complete — all $_total item(s) landed." >&2
  printf '{"batch":true,"total":%d,"attempted":%d,"landed":%d,"status":"success"}\n' \
    "$_total" "$_total" "$_landed"
  exit 0
fi

MR_ARGS=()
PROJECT="" PM="" BRANCH="" TARGET_ROOT="" DISPATCH_ID="" NO_PULL=0 MAX_WAIT="" POLL_INTERVAL=""
GUARDIAN="" OBSERVER="" IN_SEAT_TRAILER=""
CLOSE_ROWS=() BACKLOG_PATH_OVERRIDE="" CLOSE_TRAILER=""
while [ $# -gt 0 ]; do
  case "$1" in
    # Flags this macro needs AND merge_request also takes: capture + forward.
    --project)      PROJECT="${2:?}";     MR_ARGS+=("$1" "$2"); shift 2 ;;
    --pm-id)        PM="${2:?}";          MR_ARGS+=("$1" "$2"); shift 2 ;;
    --target-root)  TARGET_ROOT="${2:?}"; MR_ARGS+=("$1" "$2"); shift 2 ;;
    # Captured for pre-validation / auto-resolution, then forwarded AFTER (below),
    # so a --dispatch-id-resolved branch and an auto-read verdict reach merge_request
    # too — not just this macro's own bookkeeping (W-017).
    --branch)       BRANCH="${2:?}";   shift 2 ;;
    --guardian)     GUARDIAN="${2:?}"; shift 2 ;;
    --observer)     OBSERVER="${2:?}"; shift 2 ;;
    # (guardian round-3 finding 1b) explicit override for the seat-trailer
    # preflight below — macro-only, consumed, never forwarded (merge_request has
    # no concept of it). checked = operator manually verified the trailer;
    # skip = this dispatch needs no seat-trailer check. Either value bypasses
    # BOTH the fail-closed unresolvable-container error and (if the container IS
    # resolvable) a real lint finding — same trust level as an explicit
    # --guardian overriding a bad/missing verdict marker.
    --seat-trailer) IN_SEAT_TRAILER="${2:?}"; shift 2 ;;
    # Macro-only flags: consume, do NOT forward. --id is an accepted alias for
    # --dispatch-id — the id the PM already has from dispatch_prepare/dispatch_cleanup
    # (passing it as --id was one of the three live failures this UX fix targets).
    --dispatch-id|--id)  DISPATCH_ID="${2:?}"; shift 2 ;;
    --no-pull)      NO_PULL=1; shift ;;
    --close-row)    CLOSE_ROWS+=("${2:?}"); shift 2 ;;
    --backlog-path) BACKLOG_PATH_OVERRIDE="${2:?}"; shift 2 ;;
    --close-trailer) CLOSE_TRAILER="${2:?}"; shift 2 ;;
    --max-wait)     MAX_WAIT="${2:?}"; shift 2 ;;
    --poll-interval) POLL_INTERVAL="${2:?}"; shift 2 ;;
    -h|--help)      sed -n '2,90p' "$0"; exit 0 ;;
    # Everything else (quality-gate, message, preflight, …) forwards verbatim.
    *)              MR_ARGS+=("$1"); shift ;;
  esac
done
case "$IN_SEAT_TRAILER" in
  ""|checked|skip) ;;
  *) echo "merge_land: --seat-trailer must be 'checked' or 'skip' (got '$IN_SEAT_TRAILER')" >&2; exit 2 ;;
esac
# --project / --pm-id are needed to even locate the dispatch container and verdict
# markers below, so they are the one hard up-front requirement; everything else
# (branch, verdict) is resolved then reported together (W-017).
[ -n "$PROJECT" ] && [ -n "$PM" ] || {
  echo "merge_land: --project and --pm-id are required" >&2; exit 2; }
GIT_ROOT="${TARGET_ROOT:-$PROJECT}"
PM_ROOT="$PROJECT/__garelier/$PM"

# (W-017 a) Resolve --branch from --dispatch-id when the branch was not given
# explicitly: read the HEAD branch of the dispatch container's checkout worktree
# (__garelier/<pm>/_dispatch<N>/checkout, as dispatch_prepare lays it out). An
# explicit --branch always wins. A named-but-absent container is a clear error
# (collected below), never a silent skip.
BRANCH_ERR=""
if [ -z "$BRANCH" ] && [ -n "$DISPATCH_ID" ]; then
  CHECKOUT="$PM_ROOT/_dispatch$DISPATCH_ID/checkout"
  if [ ! -d "$CHECKOUT" ]; then
    BRANCH_ERR="--dispatch-id $DISPATCH_ID given but no dispatch checkout at $CHECKOUT (prepare it first, or it was already cleaned up) — or pass --branch explicitly"
  else
    BRANCH="$(git -C "$CHECKOUT" symbolic-ref --short HEAD 2>/dev/null || true)"
    if [ -n "$BRANCH" ]; then
      echo "merge_land: resolved --branch $BRANCH from dispatch #$DISPATCH_ID checkout" >&2
    else
      BRANCH_ERR="dispatch #$DISPATCH_ID checkout at $CHECKOUT is not on a branch (detached HEAD?) — pass --branch explicitly"
    fi
  fi
fi

# Dispatch id for cleanup: explicit --dispatch-id/--id, else the branch's `#<N>/`
# segment. NB: `|` (not `#`) is the sed delimiter — the branch itself contains `#<N>/`.
if [ -z "$DISPATCH_ID" ] && [ -n "$BRANCH" ]; then
  DISPATCH_ID="$(printf '%s' "$BRANCH" | sed -n 's|.*#\([0-9][0-9]*\)/.*|\1|p')"
fi

# (guardian round-2 N1, hardened round-3) Machine-checkable Garelier-Seat trailer
# preflight: the --require-seat-trailer lint flag existed with no caller (guardian
# F2 was only half-closed). When the dispatch that produced this branch was
# commit_mode=proxy (context.json's routing.commit_mode, forward-supplied by
# dispatch_prepare), every commit since the dispatch's base_sha must carry a
# well-formed `Garelier-Seat: codex <model> (proxy-commit via dock seat)` trailer —
# a proxy dispatch landing without one means the Dock skipped its authoritative-
# trailer duty (dispatch_prepare.sh COMMIT_RULE duty 2/3).
#
# WHY fail-closed on "can't determine" (round-3 finding 1, was best-effort/silent):
# the codex PRODUCER itself holds --add-dir write access to its own
# `_dispatch<N>/` container (dispatch_codex_producer.sh grants it on the container,
# sibling of checkout/) — so a proxy producer can delete/strip context.json to
# silently disable its OWN provenance check. Treating "can't determine" as
# "nothing to check" would reopen exactly the gap N1 closed, through a side door.
# So: container/context.json unresolvable -> ERROR (same shape as a missing
# Guardian verdict), not a silent skip. An explicit `--seat-trailer checked|skip`
# is the operator's conscious override (checked = manually verified; skip = this
# dispatch needs no check), mirroring an explicit --guardian overriding a bad/
# missing marker — and it ALSO overrides a real lint finding below, same trust
# level as --guardian's explicit-flag-wins rule.
SEAT_TRAILER_ERR=""
if [ -n "$DISPATCH_ID" ]; then
  SEAT_CTX="$PM_ROOT/_dispatch$DISPATCH_ID/context.json"
  SEAT_CHECKOUT="$PM_ROOT/_dispatch$DISPATCH_ID/checkout"
  if [ -f "$SEAT_CTX" ] && [ -d "$SEAT_CHECKOUT" ]; then
    SEAT_COMMIT_MODE="$(sed -n 's/.*"commit_mode": *"\([^"]*\)".*/\1/p' "$SEAT_CTX" | head -1)"
    SEAT_IS_PROXY=0
    SEAT_UNREADABLE=0
    case "$SEAT_COMMIT_MODE" in
      proxy) SEAT_IS_PROXY=1 ;;
      self)  SEAT_IS_PROXY=0 ;;
      *)
        # commit_mode absent/malformed/stripped (round-3 finding 1a): fall back to
        # routing.model — a second, independent signal the producer would also
        # have to scrub, so a single field edit no longer fully disables the check.
        SEAT_MODEL="$(sed -n 's/.*"model": *"\([^"]*\)".*/\1/p' "$SEAT_CTX" | head -1)"
        case "$SEAT_MODEL" in
          *codex*) SEAT_IS_PROXY=1 ;;
          *)
            # (guardian round-3 residual) content-CORRUPTED, not just a stripped
            # field: NEITHER extraction found anything at all (e.g. context.json
            # overwritten with `{}`) — that specific combination (both sed
            # captures empty) is only possible when the file exists but neither
            # key round-trips as a quoted JSON string, i.e. the content itself is
            # unreadable, not a legitimate "resolved to non-proxy" read. Mirror
            # read_marker_verdict's absent-vs-malformed split: this is malformed,
            # not absent-of-signal, so it fails closed the same as an
            # unresolvable container — "found nothing" must never silently mean
            # "found self".
            if [ -z "$SEAT_COMMIT_MODE" ] && [ -z "$SEAT_MODEL" ]; then SEAT_UNREADABLE=1; fi
            ;;
        esac
        ;;
    esac
    if [ "$SEAT_IS_PROXY" -eq 1 ]; then
      if [ -n "$IN_SEAT_TRAILER" ]; then
        echo "merge_land: seat-trailer check skipped for dispatch #$DISPATCH_ID — explicit --seat-trailer $IN_SEAT_TRAILER override" >&2
      else
        SEAT_BASE_SHA="$(sed -n 's/.*"base_sha": *"\([^"]*\)".*/\1/p' "$SEAT_CTX" | head -1)"
        SEAT_LINT_TS="$SELF_DIR/lint_commits.ts"
        SEAT_HANDOVER=0
        if [ -n "$SEAT_BASE_SHA" ] && [ -f "$SEAT_LINT_TS" ]; then
          # Seat-handover auto-detect (workshop W-051, target-project incident): context.json
          # still says commit_mode=proxy (or codex-model-inferred) from the
          # ORIGINAL dispatch, but the producer seat may have handed over to a
          # Claude self-commit mid-flight (e.g. codex quota exhausted) — the
          # later commits then carry ordinary self-mode trailers, not the proxy
          # Garelier-Seat line, and the unconditional --require-seat-trailer
          # check below would false-positive on every one of them (the false
          # ERROR that forced a manual --seat-trailer checked override in #254).
          # Classify EVERY commit in the same range first: switch to self-mode
          # ONLY when the evidence is FULLY consistent (all commits self, zero
          # proxy, zero missing) — a mixed or partial trailer set is an audit
          # anomaly, not evidence of a clean handover, and falls through to the
          # normal proxy check below (hard ERROR, unchanged).
          SEAT_SUMMARY_JSON="$(bun "$SEAT_LINT_TS" --range "$SEAT_BASE_SHA" "$SEAT_CHECKOUT" --seat-summary 2>/dev/null)"
          SEAT_TOTAL="$(printf '%s' "$SEAT_SUMMARY_JSON" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"
          SEAT_SELF="$(printf '%s' "$SEAT_SUMMARY_JSON" | sed -n 's/.*"self":\([0-9]*\).*/\1/p')"
          if [ -n "$SEAT_TOTAL" ] && [ "$SEAT_TOTAL" -gt 0 ] && [ "$SEAT_TOTAL" = "$SEAT_SELF" ]; then
            SEAT_HANDOVER=1
            echo "merge_land: seat handover detected: context.json commit_mode=proxy but branch carries self trailers ($SEAT_TOTAL/$SEAT_TOTAL commits since $SEAT_BASE_SHA) — switching preflight to self-mode (W-051)" >&2
          fi
          if [ "$SEAT_HANDOVER" -ne 1 ]; then
            SEAT_LINT_OUT="$(bun "$SEAT_LINT_TS" --range "$SEAT_BASE_SHA" "$SEAT_CHECKOUT" --require-seat-trailer 2>&1)"
            SEAT_LINT_RC=$?
            if [ "$SEAT_LINT_RC" -ne 0 ]; then
              echo "$SEAT_LINT_OUT" >&2
              SEAT_TRAILER_ERR="dispatch #$DISPATCH_ID is commit_mode=proxy (or codex-model-inferred) but one or more commits on ${BRANCH:-<unresolved>} (since $SEAT_BASE_SHA) fail --require-seat-trailer (missing/malformed Garelier-Seat trailer — see lint output on stderr above); the Dock must inject/fix the trailer per dispatch_prepare.sh's COMMIT_RULE duty 2/3 before landing, or pass --seat-trailer checked if you have manually verified it"
            fi
          fi
        fi
      fi
    elif [ "$SEAT_UNREADABLE" -eq 1 ]; then
      if [ -n "$IN_SEAT_TRAILER" ]; then
        echo "merge_land: seat-trailer check skipped for dispatch #$DISPATCH_ID — context.json content unreadable (neither commit_mode nor model resolved), explicit --seat-trailer $IN_SEAT_TRAILER override given" >&2
      else
        SEAT_TRAILER_ERR="dispatch #$DISPATCH_ID's context.json ($SEAT_CTX) exists but its content is unreadable — neither routing.commit_mode nor routing.model resolved to a value (corrupted/emptied, not merely a stripped field); cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3 residual: fail-closed, same boundary as an unresolvable container); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed"
      fi
    fi
  elif [ -n "$IN_SEAT_TRAILER" ]; then
    echo "merge_land: seat-trailer check skipped for dispatch #$DISPATCH_ID — container unresolvable, explicit --seat-trailer $IN_SEAT_TRAILER override given" >&2
  else
    SEAT_TRAILER_ERR="dispatch #$DISPATCH_ID's container/context.json is unresolvable ($SEAT_CTX / $SEAT_CHECKOUT) — cannot determine whether this was a commit_mode=proxy dispatch needing a Garelier-Seat trailer check (round-3: fail-closed, since the producer itself can delete/strip this file); pass --seat-trailer checked (you manually verified the commits) or --seat-trailer skip (this dispatch needs no check) to proceed"
  fi
fi

# (W-017 c) Auto-read the Guardian/Observer verdict from the dispatch verdict
# markers when the flag is omitted. Path convention = dispatch_prepare's gate_agents
# + attended-gate-dispatch.md § Report contract: runtime/<role>/results/<slug>-<role>.md,
# a `## Verdict` section. <slug> is the branch's last segment. read_marker_verdict
# is fail-closed (no marker / placeholder / typo → NO verdict → surfaced as a missing
# arg below, never an assumed PASS). An explicit flag always overrides the marker.
SLUG="${BRANCH##*/}"
GUARDIAN_SRC="flag"; GMARKER=""; OMARKER=""
if [ -n "$BRANCH" ]; then
  GMARKER="$PM_ROOT/runtime/guardian/results/$SLUG-guardian.md"
  OMARKER="$PM_ROOT/runtime/observer/results/$SLUG-observer.md"
  if [ -z "$GUARDIAN" ] && [ -f "$GMARKER" ]; then
    GUARDIAN="$(read_marker_verdict "$GMARKER")"
    [ -n "$GUARDIAN" ] && { GUARDIAN_SRC="auto"; echo "merge_land: auto-read Guardian verdict '$GUARDIAN' from $GMARKER" >&2; }
  fi
  if [ -z "$OBSERVER" ] && [ -f "$OMARKER" ]; then
    OBSERVER="$(read_marker_verdict "$OMARKER")"
    [ -n "$OBSERVER" ] && echo "merge_land: auto-read Observer verdict '$OBSERVER' from $OMARKER" >&2
  fi
fi

# (W-017 b) One-shot pre-validation: collect EVERY missing/invalid required input
# and report them together with usage, so submit no longer fails one arg at a time
# (--branch, then --guardian, …) only at merge_request time.
ERRORS=()
if [ -z "$BRANCH" ]; then
  ERRORS+=("${BRANCH_ERR:-no merge branch: pass --branch <workbench-branch>, or --dispatch-id <N> (alias --id) to auto-resolve it from the dispatch container}")
fi
[ -n "$SEAT_TRAILER_ERR" ] && ERRORS+=("$SEAT_TRAILER_ERR")
if [ -z "$GUARDIAN" ]; then
  if [ -n "$BRANCH" ] && [ -f "$GMARKER" ]; then
    # Present-but-malformed is a DIFFERENT fix from absent (W-027): the marker is
    # there, so "run Guardian" is misleading — the gate role must fix the token.
    ERRORS+=("Guardian verdict required: the marker at $GMARKER is present but MALFORMED (no bare canonical token under '## Verdict' — see the stderr note above and templates/gate_verdict.md); have the gate role fix it, or pass --guardian <PASS|PASS_WITH_NOTES> to override")
  elif [ -n "$BRANCH" ]; then
    ERRORS+=("Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES>, or run Guardian so a verdict marker exists at $GMARKER ([guardian_policy] require_for_all_merges rejects a merge without one)")
  else
    ERRORS+=("Guardian verdict required: pass --guardian <PASS|PASS_WITH_NOTES> (or resolve --branch/--dispatch-id first so the Guardian marker can be auto-read)")
  fi
elif [ "$GUARDIAN_SRC" = auto ]; then
  # An auto-read verdict is merge_land's own inference — refuse to land on a
  # non-passing one silently. An EXPLICIT --guardian is the PM's stated choice and
  # is forwarded verbatim (exactly as merge_request would accept it).
  case "$GUARDIAN" in
    PASS|PASS_WITH_NOTES) ;;
    *) ERRORS+=("auto-read Guardian verdict is $GUARDIAN (from $GMARKER), not PASS/PASS_WITH_NOTES — nothing to land; re-run Guardian, or pass --guardian explicitly to override") ;;
  esac
fi
if [ "${#ERRORS[@]}" -gt 0 ]; then
  echo "merge_land: cannot submit — resolve the following first:" >&2
  for _e in "${ERRORS[@]}"; do echo "  - $_e" >&2; done
  echo "" >&2
  sed -n '2,90p' "$0" >&2
  exit 2
fi

# Forward the resolved branch + verdicts to merge_request (they were captured, not
# forwarded, above so the auto-resolved values reach it too). Observer only when set.
MR_ARGS+=(--branch "$BRANCH" --guardian "$GUARDIAN")
[ -n "$OBSERVER" ] && MR_ARGS+=(--observer "$OBSERVER")

# --- 1. Submit WITHOUT poll. merge_request then emits its OWN clean one-line JSON
# ({request_id, request_file, polled:false, waiter_cmd}); the poll path instead
# prints dock_merge's output, which prepends a log line to the JSON and so cannot
# be parsed for our request_id. We take the clean request_id here and spawn the
# gate ourselves in step 2. -------------------------------------------------------
MR_ERR="$(mktemp)"; trap 'rm -f "$MR_ERR"' EXIT
SUBMIT_START="$(date +%s)"
set +e
MR_OUT="$(bash "$SELF_DIR/merge_request.sh" --no-poll "${MR_ARGS[@]}" 2>"$MR_ERR")"
MR_RC=$?
set -e
cat "$MR_ERR" >&2
REQ_ID="$(printf '%s' "$MR_OUT" | bun -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(j.request_id||"");}catch{}})' 2>/dev/null || true)"
# W-064: a failed stdout parse must not abort a REAL request. When the submit
# rc is 0, recover the id from evidence (the submitter's "wrote <path>" stderr
# line, else the newest request file not older than the submit) before giving
# up — the request FILE is the truth, stdout is only a convenience.
if [ -z "$REQ_ID" ] && [ "$MR_RC" -eq 0 ]; then
  REQ_ID="$(bash "$SELF_DIR/merge_request_id_recover.sh" \
    --stderr-file "$MR_ERR" \
    --requests-dir "$PROJECT/__garelier/$PM/runtime/merge_gate/requests" \
    --since "$SUBMIT_START" 2>/dev/null || true)"
  [ -n "$REQ_ID" ] && echo "merge_land: recovered request_id=$REQ_ID from the request file (stdout parse failed — W-064)." >&2
fi
if [ -z "$REQ_ID" ]; then
  echo "merge_land: submit produced no request_id (merge_request rc=$MR_RC); no request was created — aborting." >&2
  exit 1
fi

# --- 2. Spawn the gate via a poll (W-087-detached: it runs independently even if
# THIS process is later killed). dock_merge mixes a log line into its stdout, so we
# IGNORE its output — the request_id from step 1 is authoritative. Best-effort: if a
# driver poll loop already spawned the gate, the single active.lock serializes and
# this is a harmless no-op; a queued request self-drains (W-039).
#
# W-055: `$(cd … && pwd -P)` MUST end in `|| true`. Without it, when the cd target
# doesn't exist, the whole assignment's exit status is the failed cd's — and under
# `set -e` (armed above at "set -e" after the merge_request.sh call) that silently
# KILLS the entire script right here, before it ever reaches gate_result_waiter or
# the cleanup/pull/row-close aftercare below (confirmed: `bash -c 'set -e; X="$(cd
# /nonexistent 2>/dev/null && pwd -P)"; echo reached'` never prints "reached", rc=1,
# no diagnostic). PARSER_DIR above already carries `|| true` for this exact reason;
# this line did not, and is the fix for the observed "aftercare crashed, cleanup +
# --close-row skipped, no error text" incident (target-project #274). The `|| true` makes a
# missing driver dir resolve to a DOCK_MERGE_TS that fails the `-f` check below,
# which was ALREADY handled gracefully by the existing else-branch fallback message.
DOCK_MERGE_TS="$(cd "$SELF_DIR/../driver/src/dispatch" 2>/dev/null && pwd -P || true)/dock_merge.ts"
if [ -f "$DOCK_MERGE_TS" ]; then
  bun "$DOCK_MERGE_TS" poll --pm-id "$PM" --project "$PROJECT" >/dev/null 2>&1 || true
else
  echo "merge_land: dock_merge.ts not found at $DOCK_MERGE_TS; relying on an external poller to spawn the gate for $REQ_ID." >&2
fi
echo "merge_land: submitted $REQ_ID; waiting for the gate result…" >&2

# --- 2. Block-wait for the gate result (this process was backgrounded by the PM, so
# blocking here is intended). gate_result_waiter watches ONLY this request_id and
# never touches the gate queue/lock (self-drain safe, W-039). ---------------------
WAIT_ARGS=(--project "$PROJECT" --pm-id "$PM" --request-id "$REQ_ID")
[ -n "$MAX_WAIT" ]      && WAIT_ARGS+=(--max-wait "$MAX_WAIT")
[ -n "$POLL_INTERVAL" ] && WAIT_ARGS+=(--poll-interval "$POLL_INTERVAL")
set +e
WAIT_OUT="$(bash "$SELF_DIR/gate_result_waiter.sh" "${WAIT_ARGS[@]}")"
WAIT_RC=$?
set -e
echo "$WAIT_OUT" >&2

# gate_result_waiter prints `MERGE_RESULT: <status> <req_id> <detail>` (exit 0
# success / 1 non-success / 124 timeout) or `MERGE_TIMEOUT: …` on 124.
STATUS="$(printf '%s' "$WAIT_OUT" | sed -n 's/^MERGE_RESULT: \([^ ][^ ]*\) .*/\1/p')"
DETAIL="$(printf '%s' "$WAIT_OUT" | sed -n 's/^MERGE_RESULT: [^ ][^ ]* [^ ][^ ]* \(.*\)$/\1/p')"

# --- 3. NON-success: clean up NOTHING (the branch's work must survive), report. ---
if [ "$WAIT_RC" -ne 0 ]; then
  [ -n "$STATUS" ] || STATUS="$([ "$WAIT_RC" -eq 124 ] && echo timeout || echo failed)"
  [ -n "$DETAIL" ] || DETAIL="$(printf '%s' "$WAIT_OUT" | sed -n 's/^MERGE_TIMEOUT: \(.*\)$/\1/p')"
  printf '{"request_id":"%s","status":"%s","failure_reason":"%s","cleaned_up":false}\n' \
    "$(json_escape "$REQ_ID")" "$(json_escape "${STATUS:-failed}")" "$(json_escape "$DETAIL")"
  exit "$WAIT_RC"
fi

# The gate writes its success RESULT just BEFORE it releases active.lock
# (clear_lock_if_mine runs after write_result), so the waiter can observe success
# while OUR OWN lock is still held for a few ms. Cleanup's W-055 guard would then
# refuse (it sees active.lock referencing our slug) and cleanup would be skipped
# even though the merge landed — the exact race under load. Briefly wait for OUR
# lock to clear before cleanup + row close. Bounded + best-effort: a FOREIGN lock
# (a next gate that self-drained — different request_id) does NOT hold us here, and
# if our lock somehow lingers we fall through (cleanup's guard still protects
# correctness). This also gives the row-close step the true post-gate lock state.
LOCK_ACTIVE="$PROJECT/__garelier/$PM/runtime/merge_gate/locks/active.lock"
for _w in $(seq 1 50); do
  [ -f "$LOCK_ACTIVE" ] || break
  grep -qF -- "$REQ_ID" "$LOCK_ACTIVE" 2>/dev/null || break
  sleep 0.1
done

# --- 4. SUCCESS: clean up the dispatch (branch is confirmed merged, so
# --delete-branch is safe past the W-044 guard) + pull. The gate has finished AND
# released our lock (waited for above), so the W-055 in-progress guard no longer
# fires for THIS branch; a NEXT queued gate that self-drained is a DIFFERENT slug,
# so its lock/MERGE_HEAD does not match this branch and the guard lets cleanup
# through. ------------------------------------------------------------------------
STUDIO_COMMIT="$DETAIL"

# W-055 hardening: the merge is CONFIRMED LANDED at this point (gate reported
# success above). If anything below (cleanup/pull/row-close) hits an unforeseen
# crash under `set -e` — the exact DOCK_MERGE_TS class of bug fixed above, or any
# future one like it — the PM would otherwise see a dead background job with no
# JSON and no clue the merge itself actually succeeded (the target-project #274 incident:
# cleanup + --close-row silently skipped). This trap fires on ANY non-zero exit
# from here to the end of the script UNLESS AFTERCARE_COMPLETE was set first
# (below, right before the final success printf) — so the normal path is silent
# and only a genuine crash prints the warning. Combined with (not replacing) the
# earlier MR_ERR-cleanup trap.
AFTERCARE_COMPLETE=0
trap '_rc=$?
  rm -f "$MR_ERR" 2>/dev/null || true
  if [ "$_rc" -ne 0 ] && [ "$AFTERCARE_COMPLETE" -ne 1 ]; then
    echo "merge_land: WARNING — the merge LANDED (request_id=$REQ_ID studio_commit=${STUDIO_COMMIT:-unknown}) but aftercare crashed before finishing (rc=$_rc); cleanup/pull/row-close may be INCOMPLETE. Verify manually: dispatch_cleanup.sh --project \"$PROJECT\" --pm-id \"$PM\" --id \"${DISPATCH_ID:-<id>}\" --delete-branch, and strike the backlog row(s) by hand if --close-row was requested." >&2
  fi' EXIT

CLEANUP_STATUS="skipped" BRANCH_DELETED="false"
if [ -n "$DISPATCH_ID" ]; then
  CLEAN_ARGS=(--project "$PROJECT" --pm-id "$PM" --id "$DISPATCH_ID" --delete-branch)
  [ -n "$TARGET_ROOT" ] && CLEAN_ARGS+=(--target-root "$TARGET_ROOT")
  set +e
  CLEAN_OUT="$(bash "$SELF_DIR/dispatch_cleanup.sh" "${CLEAN_ARGS[@]}")"
  CLEAN_RC=$?
  set -e
  if [ -n "$CLEAN_OUT" ]; then
    CLEANUP_STATUS="$(printf '%s' "$CLEAN_OUT" | sed -n 's/.*"cleanup_status":"\([^"]*\)".*/\1/p')"
    BRANCH_DELETED="$(printf '%s' "$CLEAN_OUT" | sed -n 's/.*"branch_deleted":\(true\|false\).*/\1/p')"
    echo "$CLEAN_OUT" >&2
  fi
  [ -n "$CLEANUP_STATUS" ] || CLEANUP_STATUS="$([ "$CLEAN_RC" -eq 0 ] && echo success || echo "failed(rc=$CLEAN_RC)")"
else
  echo "merge_land: no --dispatch-id and none derivable from the branch — skipping cleanup." >&2
fi

# Pull (best-effort, non-fatal): the merge already landed + cleaned, so a pull that
# fails (no upstream on a local-only branch) must not fail the whole macro.
PULLED="skipped"
if [ "$NO_PULL" -ne 1 ]; then
  PULL_ERR="$(mktemp)"
  if git -C "$GIT_ROOT" pull --ff-only >/dev/null 2>"$PULL_ERR"; then PULLED="true"
  else PULLED="false"; echo "merge_land: git pull --ff-only skipped/failed: $(head -1 "$PULL_ERR" 2>/dev/null)" >&2; fi
  rm -f "$PULL_ERR"
fi

# --- 5. Row close (W-093): the merge LANDED, so optionally strike the closed
# backlog row(s) and commit — folding the PM's last manual touch into this same
# background command. Reached ONLY on success (the failure path returned at step 3),
# so a failed merge NEVER edits the backlog. `row_close` is added to the summary
# only when --close-row was passed, keeping the default output byte-identical. -----
ROW_CLOSE_FIELD=""
if [ "${#CLOSE_ROWS[@]}" -gt 0 ]; then
  BACKLOG_PATH="${BACKLOG_PATH_OVERRIDE:-$PROJECT/__garelier/$PM/control/project_dashboard/backlog.md}"
  ROW_CLOSE=""
  # Safety: an active.lock that is NOT ours means a NEXT gate self-drained and is
  # running (W-039). Committing now would race it, so DEFER — the merge already
  # landed, so this only leaves the PM one manual strike, never damage. Our OWN
  # gate's residual lock was already waited out before step 4, so a lock still
  # present here is a next gate, not us. LOCK_ACTIVE was set at the wait above.
  if [ -f "$LOCK_ACTIVE" ] && ! grep -qF -- "$REQ_ID" "$LOCK_ACTIVE" 2>/dev/null; then
    ROW_CLOSE="deferred (gate active)"
    echo "merge_land: row close deferred — a foreign merge_gate active.lock is present (a next gate is running); backlog left untouched." >&2
  elif [ ! -f "$BACKLOG_PATH" ]; then
    ROW_CLOSE="not-found"
    echo "merge_land: row close: backlog not found at $BACKLOG_PATH — nothing to close." >&2
  else
    CLOSED=()
    for _row in "${CLOSE_ROWS[@]}"; do
      _tmp="$(mktemp)"
      # Strike a table row whose FIRST cell (between the leading `|` and the next
      # `|`) is EXACTLY this item id — never a mention of it in a later column, and
      # never a longer id that merely starts with it. awk exits 0 iff it struck ≥1.
      if awk -v id="$_row" '
          function trim(s){ gsub(/^[ \t]+|[ \t]+$/,"",s); return s }
          { l=$0; sub(/^[ \t]+/,"",l)
            if (substr(l,1,1)=="|") { n=split(l,c,"|"); if (n>=3 && trim(c[2])==id){ hit=1; next } }
            print }
          END{ exit (hit?0:1) }
        ' "$BACKLOG_PATH" > "$_tmp"; then
        mv -f "$_tmp" "$BACKLOG_PATH"; CLOSED+=("$_row")
      else
        rm -f "$_tmp"
      fi
    done
    if [ "${#CLOSED[@]}" -eq 0 ]; then
      ROW_CLOSE="not-found"
      echo "merge_land: row close: none of [${CLOSE_ROWS[*]}] matched a backlog row in $BACKLOG_PATH — nothing committed." >&2
    else
      _ids=""; for _c in "${CLOSED[@]}"; do _ids="${_ids:+$_ids, }$_c"; done
      _msg="chore(dashboard): $_ids close (merged $STUDIO_COMMIT)"
      BL_GIT="$(git -C "$(dirname "$BACKLOG_PATH")" rev-parse --show-toplevel 2>/dev/null || true)"
      [ -n "$BL_GIT" ] || BL_GIT="$PROJECT"
      set +e
      if [ -n "$CLOSE_TRAILER" ]; then
        git -C "$BL_GIT" commit -q -m "$_msg" -m "$CLOSE_TRAILER" -- "$BACKLOG_PATH"
      else
        git -C "$BL_GIT" commit -q -m "$_msg" -- "$BACKLOG_PATH"
      fi
      _crc=$?
      set -e
      if [ "$_crc" -eq 0 ]; then
        ROW_CLOSE="closed"
        echo "merge_land: row close: struck [$_ids] from backlog and committed to $BL_GIT." >&2
      else
        ROW_CLOSE="commit-failed(rc=$_crc)"
        echo "merge_land: row close: git commit failed (rc=$_crc); the backlog edit is left in the working tree for the PM." >&2
      fi
    fi
  fi
  ROW_CLOSE_FIELD=",\"row_close\":\"$(json_escape "$ROW_CLOSE")\""
fi

# W-055: reached the normal end of the aftercare zone — disarm the crash-warning
# trap's message (the MR_ERR cleanup in the same trap still always runs on exit).
AFTERCARE_COMPLETE=1
printf '{"request_id":"%s","status":"success","studio_commit":"%s","dispatch_id":"%s","branch_deleted":%s,"cleanup_status":"%s","pulled":"%s"%s}\n' \
  "$(json_escape "$REQ_ID")" "$(json_escape "$STUDIO_COMMIT")" "$(json_escape "${DISPATCH_ID:-}")" \
  "${BRANCH_DELETED:-false}" "$(json_escape "${CLEANUP_STATUS:-skipped}")" "$PULLED" "$ROW_CLOSE_FIELD"
exit 0
