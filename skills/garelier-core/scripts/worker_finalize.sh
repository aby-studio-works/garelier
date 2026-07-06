#!/usr/bin/env bash
#
# worker_finalize.sh — mechanize a Worker's "implementation done" finish (W-069).
#
# The recurring live failure this fixes: a Worker runs its quality gate, sees it
# green, and then goes idle WITHOUT committing / flipping STATE to REPORTING /
# notifying Dock — the completion-contract gap. This one command turns the
# manual "gate -> commit -> REPORTING -> report -> register" sequence into a
# single deterministic step so the commit can no longer be forgotten:
#
#   (a) run the SCOPED quality gate (context.json quality_gate.fast, i.e. the
#       per-package check/test for what you touched; the FULL-workspace gate is
#       the merge gate's job — DEC-091). Green/red decision.
#   (b) green + a dirty tree -> `git add -A` (this worktree only) + commit using
#       the context.json commit_template's `Garelier:` trailer VERBATIM (drift 0,
#       W-051), with the Worker-supplied --subject as the subject line.
#   (c) flip STATE.md -> REPORTING.
#   (d) append a finalize register block to report.md (SHA / gate result / branch
#       / "PM review 待ち").
#   (e) print ONE compact register line to stdout the Worker copies into its Dock
#       message (Inter-agent compressed register, W-042).
#
#   red -> NO commit, print the failed gate command + its output tail, leave
#          STATE at WORKING (nothing changes but the log), exit non-zero.
#   already committed (clean tree) -> idempotent: no new commit, STATE flip only,
#          register refreshed. A second finalize call is a safe no-op.
#
# SAFETY: finalize only ever commits the CURRENT worktree's Worker branch. It
# refuses to run on an integration branch (`*/studio`) or a detached HEAD, so it
# can never land a commit on studio (no overlap with the W-055 studio guard).
#
# NON-DESTRUCTIVE: this is the RECOMMENDED path, not the only one. The manual
# gate/commit/report flow still works for special cases (see garelier-worker
# references/working-and-reporting.md §6–§7).
#
# Usage:
#   worker_finalize.sh [--container <dir>] [--checkout <dir>] [--context <path>]
#                      [--subject '<type>(<scope>): <summary>  [#<id>]']
#                      [--message '<full commit message>']
#                      [--gate fast|full] [--gate-cmd '<cmd>']... [-h|--help]
#
#   --container   Worker/dispatch container holding STATE.md, report.md,
#                 context.json (default: parent of the resolved checkout).
#   --checkout    the git worktree to commit in (default: <container>/checkout,
#                 else `git rev-parse --show-toplevel` from the cwd).
#   --context     context.json path (default: <container>/context.json).
#   --subject     the commit subject line you write (required to create a commit;
#                 the Garelier trailer is appended VERBATIM from context.json).
#   --message     full commit message override (verbatim; a missing Garelier
#                 trailer is appended from context.json).
#   --gate        which command set to run: fast=scoped (default), full=workspace.
#   --gate-cmd    explicit gate command (repeatable) — overrides context.json.
#
# Exit codes: 0 finalized (or idempotent no-op); 1 gate red (STATE stays WORKING);
# 2 usage/precondition error (nothing changed).
set -uo pipefail

CONTAINER="" CHECKOUT="" CONTEXT="" SUBJECT="" MESSAGE="" GATE_KIND="fast"
GATE_CMDS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --container) CONTAINER="${2:?}"; shift 2 ;;
    --checkout)  CHECKOUT="${2:?}"; shift 2 ;;
    --context)   CONTEXT="${2:?}"; shift 2 ;;
    --subject)   SUBJECT="${2:?}"; shift 2 ;;
    --message)   MESSAGE="${2:?}"; shift 2 ;;
    --gate)      GATE_KIND="${2:?}"; shift 2 ;;
    --gate-cmd)  GATE_CMDS+=("${2:?}"); shift 2 ;;
    -h|--help)   sed -n '2,55p' "$0"; exit 0 ;;
    *) echo "worker_finalize: unknown arg: $1" >&2
       echo "worker_finalize: valid flags: --container --checkout --context --subject --message --gate --gate-cmd -h/--help" >&2
       exit 2 ;;
  esac
done
case "$GATE_KIND" in fast|full) ;; *) echo "worker_finalize: --gate must be fast|full (got '$GATE_KIND')" >&2; exit 2 ;; esac

# --- Resolve checkout / container / context ---------------------------------
if [ -z "$CHECKOUT" ]; then
  if [ -n "$CONTAINER" ]; then
    CHECKOUT="$CONTAINER/checkout"
  else
    CHECKOUT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$CHECKOUT" ] || { echo "worker_finalize: not inside a git worktree and no --checkout/--container given" >&2; exit 2; }
  fi
fi
git -C "$CHECKOUT" rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo "worker_finalize: --checkout is not a git worktree: $CHECKOUT" >&2; exit 2; }
# The container is one level up from the checkout (DEC-020: <container>/checkout/).
[ -n "$CONTAINER" ] || CONTAINER="$(cd "$CHECKOUT/.." && pwd)"
[ -n "$CONTEXT" ]   || CONTEXT="$CONTAINER/context.json"
STATE_MD="$CONTAINER/STATE.md"
REPORT_MD="$CONTAINER/report.md"

# --- Safety guard: never commit studio / a detached HEAD (W-055 no-overlap) --
CUR_BRANCH="$(git -C "$CHECKOUT" branch --show-current 2>/dev/null || true)"
case "$CUR_BRANCH" in
  */studio) echo "worker_finalize: refuse — checkout is on the integration branch '$CUR_BRANCH'. finalize only commits Worker branches (workbench/anvil/shelf/satchel). Switch to your Worker branch first." >&2; exit 2 ;;
  "")       echo "worker_finalize: refuse — detached HEAD in $CHECKOUT. Check out your Worker branch before finalizing." >&2; exit 2 ;;
esac

# --- Read commit_template + gate commands from context.json (best-effort) ----
# context.json's commit_template embeds real newlines once parsed; write it to a
# file so the trailer survives verbatim. Gate commands are a JSON array -> one
# per line. bun is the Garelier runtime's parser; if it is unavailable, the
# manual --gate-cmd / --message / --subject overrides still drive finalize.
WORK="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/worker_finalize.$$")"
mkdir -p "$WORK" 2>/dev/null || true
trap 'rm -rf "$WORK" 2>/dev/null || true' EXIT
CTX_CMDS_FILE="$WORK/gate_cmds"
CTX_TMPL_FILE="$WORK/commit_tmpl"
: > "$CTX_CMDS_FILE"; : > "$CTX_TMPL_FILE"
CTX_CMD_COUNT=0
BASE_SHA=""
if [ -f "$CONTEXT" ]; then
  # base_sha is a plain string field (no newlines) — a simple sed is robust.
  BASE_SHA="$(sed -n 's/.*"base_sha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$CONTEXT" | head -1)"
  if command -v bun >/dev/null 2>&1; then
    # argv[1]=context  [2]=gate-kind  [3]=out-cmds  [4]=out-tmpl (bun -e arg base, see ci.sh)
    if CTX_CMD_COUNT="$(bun -e '
      const ctxPath = process.argv[1], kind = process.argv[2];
      const outCmds = process.argv[3], outTmpl = process.argv[4];
      let ctx = {};
      try { ctx = JSON.parse(await Bun.file(ctxPath).text()); } catch (e) { process.exit(3); }
      const qg = (ctx && ctx.quality_gate) || {};
      let cmds = kind === "full" ? qg.full : qg.fast;
      if (!Array.isArray(cmds) || cmds.length === 0) cmds = qg.full || qg.fast || qg.commands || [];
      cmds = (Array.isArray(cmds) ? cmds : []).map((c) => String(c)).filter((c) => c.trim().length > 0);
      await Bun.write(outCmds, cmds.join("\n") + (cmds.length ? "\n" : ""));
      await Bun.write(outTmpl, (ctx && typeof ctx.commit_template === "string") ? ctx.commit_template : "");
      process.stdout.write(String(cmds.length));
    ' "$CONTEXT" "$GATE_KIND" "$CTX_CMDS_FILE" "$CTX_TMPL_FILE" 2>/dev/null)"; then
      :
    else
      CTX_CMD_COUNT=0
      echo "worker_finalize: could not parse $CONTEXT (bun); relying on --gate-cmd / --message overrides" >&2
    fi
  else
    echo "worker_finalize: bun not found; cannot read context.json — pass --gate-cmd and --subject/--message explicitly" >&2
  fi
fi

# Resolve the effective gate command set: explicit --gate-cmd wins, else context.
if [ "${#GATE_CMDS[@]}" -eq 0 ] && [ "${CTX_CMD_COUNT:-0}" -gt 0 ]; then
  while IFS= read -r _c; do
    [ -n "$_c" ] && GATE_CMDS+=("$_c")
  done < "$CTX_CMDS_FILE"
fi
if [ "${#GATE_CMDS[@]}" -eq 0 ]; then
  echo "worker_finalize: no quality-gate commands (none in $CONTEXT quality_gate.$GATE_KIND, no --gate-cmd)." >&2
  echo "worker_finalize: an undefined quality gate is a MUST-BLOCK for a Worker (garelier-worker SKILL §13) — refusing to finalize. Pass --gate-cmd or fix the dispatch context." >&2
  exit 2
fi

# --- Run the scoped gate -----------------------------------------------------
echo "worker_finalize: running the $GATE_KIND (scoped) quality gate in $CHECKOUT" >&2
echo "worker_finalize: note — the FULL-workspace gate is the merge gate's job (DEC-091); this runs your scoped check/test only." >&2
GATE_LOG="$WORK/gate.log"
gate_i=0
for cmd in "${GATE_CMDS[@]}"; do
  gate_i=$((gate_i + 1))
  echo "worker_finalize: gate[$gate_i/${#GATE_CMDS[@]}]> $cmd" >&2
  if ( cd "$CHECKOUT" && bash -c "$cmd" ) >"$GATE_LOG" 2>&1; then
    echo "worker_finalize: gate[$gate_i] ok" >&2
  else
    rc=$?
    echo "" >&2
    echo "worker_finalize: GATE RED — command failed (exit $rc), NO commit made, STATE stays WORKING:" >&2
    echo "worker_finalize:   failed command: $cmd" >&2
    echo "worker_finalize:   --- output tail (last 30 lines) ---" >&2
    tail -n 30 "$GATE_LOG" | sed 's/^/worker_finalize:   /' >&2
    echo "worker_finalize:   --- end tail --- (full: rerun the command in $CHECKOUT)" >&2
    exit 1
  fi
done
echo "worker_finalize: gate GREEN (${#GATE_CMDS[@]} command(s) passed)" >&2

# --- Commit (only if the tree is dirty) --------------------------------------
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DIRTY=0
[ -n "$(git -C "$CHECKOUT" status --porcelain 2>/dev/null)" ] && DIRTY=1
COMMIT_STATE="already-committed"

if [ "$DIRTY" -eq 1 ]; then
  # Build the commit message: subject (Worker-supplied) + verbatim trailer.
  FINAL_MSG=""
  if [ -n "$MESSAGE" ]; then
    FINAL_MSG="$MESSAGE"
    # Append the Garelier trailer from the template if the message lacks one.
    if ! printf '%s\n' "$MESSAGE" | grep -qE '^Garelier: '; then
      TRAILER="$(tail -n +2 "$CTX_TMPL_FILE" 2>/dev/null | sed '/^[[:space:]]*$/d' | grep -E '^Garelier: ' | head -1)"
      [ -n "$TRAILER" ] && FINAL_MSG="$MESSAGE"$'\n\n'"$TRAILER"
    fi
  elif [ -n "$SUBJECT" ]; then
    FINAL_MSG="$SUBJECT"
    # The template is `<subject placeholder>\n\n<Garelier trailer>`; keep
    # everything from line 2 on (the blank line + trailer) verbatim (W-051).
    if [ -s "$CTX_TMPL_FILE" ]; then
      REST="$(tail -n +2 "$CTX_TMPL_FILE")"
      if printf '%s\n' "$REST" | grep -qE '^Garelier: '; then
        FINAL_MSG="$SUBJECT"$'\n'"$REST"
      else
        echo "worker_finalize: warning — context.json commit_template carried no 'Garelier:' trailer; committing subject only." >&2
      fi
    else
      echo "worker_finalize: warning — no commit_template in context.json; committing subject only (no Garelier trailer)." >&2
    fi
  else
    echo "worker_finalize: the working tree has changes but no --subject/--message was given." >&2
    echo "worker_finalize: pass --subject '<type>(<scope>): <summary>  [#<id>]' — finalize appends the Garelier trailer from context.json verbatim (W-051). Nothing committed; STATE unchanged." >&2
    exit 2
  fi

  git -C "$CHECKOUT" add -A || { echo "worker_finalize: git add -A failed in $CHECKOUT" >&2; exit 2; }
  if [ -z "$(git -C "$CHECKOUT" diff --cached --name-only)" ]; then
    # Everything staged was ignored/empty — treat as already committed.
    DIRTY=0
  else
    if git -C "$CHECKOUT" commit -m "$FINAL_MSG" >&2; then
      COMMIT_STATE="committed"
    else
      echo "worker_finalize: git commit failed; STATE unchanged, nothing flipped." >&2
      exit 2
    fi
  fi
fi

SHA="$(git -C "$CHECKOUT" rev-parse --short HEAD 2>/dev/null || echo "unknown")"

# "nothing to finalize" guard: clean tree with no commits past the dispatch base
# means the Worker made no change. Flip nothing — surface it instead of a bogus
# REPORTING with an empty branch.
if [ "$DIRTY" -eq 0 ] && [ "$COMMIT_STATE" = "already-committed" ] && [ -n "$BASE_SHA" ]; then
  if git -C "$CHECKOUT" rev-parse --verify -q "$BASE_SHA" >/dev/null 2>&1; then
    AHEAD="$(git -C "$CHECKOUT" rev-list --count "$BASE_SHA"..HEAD 2>/dev/null || echo 0)"
    if [ "${AHEAD:-0}" -eq 0 ]; then
      echo "worker_finalize: nothing to finalize — clean tree and no commits past the dispatch base ($BASE_SHA) on '$CUR_BRANCH'. Implement + stage your change first." >&2
      exit 2
    fi
  fi
fi

# --- Flip STATE.md -> REPORTING ---------------------------------------------
if [ -f "$STATE_MD" ]; then
  TMP_STATE="$WORK/STATE.md"
  awk '
    /^##[[:space:]]+Status[[:space:]]*$/ { print; instatus=1; next }
    instatus && /^[[:space:]]*$/         { print; next }
    instatus && NF                       { print "REPORTING"; instatus=0; next }
    { print }
  ' "$STATE_MD" > "$TMP_STATE" && cat "$TMP_STATE" > "$STATE_MD"
  # Refresh Last activity if the canonical section exists (best-effort).
  if grep -qE '^##[[:space:]]+Last activity[[:space:]]*$' "$STATE_MD"; then
    awk -v now="$NOW" -v cs="$COMMIT_STATE" '
      /^##[[:space:]]+Last activity[[:space:]]*$/ { print; inla=1; next }
      inla && /^[[:space:]]*$/ { print; next }
      inla && NF { print now " -- worker_finalize: gate green, " cs ", REPORTING"; inla=0; next }
      { print }
    ' "$STATE_MD" > "$TMP_STATE" 2>/dev/null && cat "$TMP_STATE" > "$STATE_MD" || true
  fi
else
  echo "worker_finalize: warning — no STATE.md at $STATE_MD; skipped STATE flip." >&2
fi

# --- Register block in report.md (idempotent) --------------------------------
REGISTER_HEADER="## Finalize register (worker_finalize.sh)"
if [ -f "$REPORT_MD" ]; then
  TMP_REPORT="$WORK/report.md"
  # Drop any prior finalize-register block so a re-run refreshes rather than stacks.
  awk -v h="$REGISTER_HEADER" '
    $0==h { drop=1; next }
    drop && /^##[[:space:]]/ { drop=0 }
    !drop { print }
  ' "$REPORT_MD" > "$TMP_REPORT" && cat "$TMP_REPORT" > "$REPORT_MD"
  {
    printf '\n%s\n\n' "$REGISTER_HEADER"
    printf -- '- Commit: `%s` (%s)\n' "$SHA" "$COMMIT_STATE"
    printf -- '- Gate: %s scoped PASS (%s command(s)); full-workspace gate = merge gate (DEC-091)\n' "$GATE_KIND" "${#GATE_CMDS[@]}"
    printf -- '- Branch: `%s`\n' "$CUR_BRANCH"
    printf -- '- State: REPORTING — PM review 待ち\n'
    printf -- '- Finalized: %s\n' "$NOW"
  } >> "$REPORT_MD"
else
  echo "worker_finalize: warning — no report.md at $REPORT_MD; skipped register block." >&2
fi

# --- One-line register to stdout (Worker copies into its Dock message) -------
TASK_TAIL="$(printf '%s' "$CUR_BRANCH" | awk -F/ 'NF>=2{print $(NF-1)" "$NF; next}{print}')"
printf 'finalize: %s | REPORTING | commit=%s (%s) | gate=%s PASS(%s) | branch=%s | PM review 待ち\n' \
  "$TASK_TAIL" "$SHA" "$COMMIT_STATE" "$GATE_KIND" "${#GATE_CMDS[@]}" "$CUR_BRANCH"
exit 0
