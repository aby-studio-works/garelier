#!/usr/bin/env bash
# task_mirror_hook.sh — framework-owned PostToolUse hook (workshop W-030).
#
# After a Garelier land/dispatch Bash command runs, refresh the Task-list mirror
# (task_mirror.ts) and inject ONLY the delta since the last emit into the PM
# (Claude) session. No delta = no output = zero tokens injected. A tool call whose
# command is not one of the land/dispatch scripts is rejected by a pure-bash
# substring test with no subprocess, so the common case is ~free.
#
# GENERIC BY DESIGN: this file is framework-owned and hardcodes no pm_id / project.
# It reads both from the INTERCEPTED command itself (the merge_land / dispatch_*
# invocation always carries `--pm-id` and `--project`), so one installed copy
# serves every PM and every project. If either cannot be parsed it exits silently
# (誤爆ゼロ優先 — never guess). task_mirror.ts is resolved from this script's own
# location, so it works through the install junction or a real path alike.
#
# stdin: Claude Code PostToolUse hook JSON ({ tool_input: { command }, ... }).
# stdout: at most a two-line compact TASK-MIRROR diff, or nothing.
set -uo pipefail

INPUT="$(cat)"

# Fast pure-bash reject: if the raw event does not even mention a land/dispatch
# script, there is nothing to mirror — exit before spawning any subprocess.
case "$INPUT" in
  *merge_land.sh*|*dispatch_prepare.sh*|*dispatch_cleanup.sh*) ;;
  *) exit 0 ;;
esac

# One bun pass: parse the JSON, confirm tool_input.command really is a land/dispatch
# script (guards against the names only appearing in captured output), and extract
# --pm-id + --project from that command. Emits "<pm-id>\t<project>" or nothing.
PARSED="$(GARELIER_HOOK_INPUT="$INPUT" bun -e '
  try {
    const d = JSON.parse(process.env.GARELIER_HOOK_INPUT || "{}");
    const cmd = (d.tool_input && d.tool_input.command) || "";
    if (!/(merge_land|dispatch_prepare|dispatch_cleanup)\.sh/.test(cmd)) process.exit(0);
    const pm = (cmd.match(/--pm-id[= ]+"?([^"\s]+)/) || [])[1] || "";
    const pj = (cmd.match(/--project[= ]+"?([^"\s]+)/) || [])[1] || "";
    if (pm && pj) process.stdout.write(pm + "\t" + pj);
  } catch { /* silent */ }
' 2>/dev/null || true)"
[ -n "$PARSED" ] || exit 0
PM_ID="${PARSED%%$'\t'*}"
PROJECT="${PARSED#*$'\t'}"
[ -n "$PM_ID" ] && [ -n "$PROJECT" ] || exit 0

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIRROR="$SELF_DIR/../driver/src/dispatch/task_mirror.ts"
[ -f "$MIRROR" ] || exit 0
STATE="$PROJECT/__garelier/$PM_ID/runtime/driver/task_mirror_hook_state.json"

# Compute the desired mirror, diff it against the last recorded baseline, and print
# only the delta. The baseline is recorded on every run, so the first run is silent
# (records the baseline, no full dump) and only subsequent CHANGES are surfaced.
bun "$MIRROR" --pm-id "$PM_ID" --project "$PROJECT" --format ops 2>/dev/null | \
GARELIER_STATE_FILE="$STATE" bun -e '
  const fs = require("fs");
  const path = require("path");
  const statePath = process.env.GARELIER_STATE_FILE;
  let d;
  try { d = JSON.parse(await Bun.stdin.text()); } catch { process.exit(0); }
  const cur = {};
  for (const it of (d.desired || [])) cur[it.key] = it.status ?? "?";
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* no baseline */ }
  if (prev !== null) {
    const added   = Object.keys(cur).filter((k) => !(k in prev));
    const removed  = Object.keys(prev).filter((k) => !(k in cur));
    const changed = Object.keys(cur).filter((k) => k in prev && prev[k] !== cur[k])
                          .map((k) => `${k}:${prev[k]}->${cur[k]}`);
    if (!added.length && !removed.length && !changed.length) process.exit(0); // 差分なし = 無出力
    const parts = [];
    if (added.length)   parts.push("追加 " + added.slice(0, 8).map((k) => `${k}(${cur[k]})`).join(", ") + (added.length > 8 ? "…" : ""));
    if (removed.length) parts.push("削除 " + removed.slice(0, 8).join(", ") + (removed.length > 8 ? "…" : ""));
    if (changed.length) parts.push("変化 " + changed.slice(0, 8).join(", ") + (changed.length > 8 ? "…" : ""));
    console.log("TASK-MIRROR diff: " + parts.join(" | "));
    console.log("  → harness tasks へ反映 (TaskCreate/TaskUpdate、dispatch 紐付きは owner 設定)。");
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(cur));
' 2>/dev/null || true
exit 0
