#!/usr/bin/env bun
// TS-first port of hooks/task_mirror_hook.sh (workshop W-030 / W-083). Frozen:
// stdin shape, the pure-substring fast reject, pm-id/project parse, the state
// file path, and the compact TASK-MIRROR delta output all match the shell 1:1.
//
// After a Garelier land/dispatch Bash command runs, refresh the Task-list mirror
// (task_mirror.ts) and inject ONLY the delta since the last emit into the PM
// (Claude) session. No delta = no output = zero tokens injected. A tool call
// whose command is not one of the land/dispatch scripts is rejected by a pure
// substring test with no subprocess, so the common case is ~free.
//
// GENERIC BY DESIGN: framework-owned, hardcodes no pm_id / project. It reads both
// from the intercepted command itself; if either cannot be parsed it exits
// silently (誤爆ゼロ優先). task_mirror.ts is resolved from this file's own
// location, so it works through the install junction or a real path alike. The
// hook must never fail the session: any error path exits 0 with no output.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { shellQuote } from "../driver/src/scripts/_lib.ts";

// Shell out a single word-splitting-safe command through bash, exactly as the
// original hook did. bash.exe applies MSYS argv path translation (e.g. an MSYS
// /tmp project path -> the real Windows path) so task_mirror.ts resolves the
// project the same way it did under the pure-shell hook. `q` single-quotes each
// argument (any embedded single quote is escaped) so paths with spaces survive.
function bashCapture(parts: string[]): string {
  const r = spawnSync("bash", ["-c", parts.map((part) => shellQuote(part)).join(" ")], { encoding: "utf8" });
  return (r.stdout ?? "").toString();
}

function main(): void {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch { return; }

  // Fast pure-substring reject: no land/dispatch script mentioned -> nothing to
  // mirror, exit before spawning any subprocess.
  if (!input.includes("merge_land.sh") && !input.includes("dispatch_prepare.sh") && !input.includes("dispatch_cleanup.sh")) {
    return;
  }

  // Confirm tool_input.command really is a land/dispatch script (guards against
  // the names only appearing in captured output) and extract --pm-id/--project.
  let pmId = "";
  let project = "";
  try {
    const d = JSON.parse(input) as { tool_input?: { command?: unknown } };
    const cmd = (d.tool_input && typeof d.tool_input.command === "string") ? d.tool_input.command : "";
    if (!/(merge_land|dispatch_prepare|dispatch_cleanup)\.sh/.test(cmd)) return;
    pmId = (cmd.match(/--pm-id[= ]+"?([^"\s]+)/) || [])[1] || "";
    project = (cmd.match(/--project[= ]+"?([^"\s]+)/) || [])[1] || "";
  } catch { return; }
  if (!pmId || !project) return;

  // W-091: canonicalize --project through the shell before ANY filesystem write.
  // The command is parsed from stdin, so no MSYS argv path translation ran on it
  // (unlike the mirror argv below): a POSIX/MSYS --project (/tmp/…, /c/…) or a
  // relative `.` resolves under node to a DIFFERENT location than the shell —
  // node maps /tmp -> C:\tmp — so writing `${project}/…` verbatim drops the
  // state file as a stray instead of under the real dispatch tree (class b —
  // the observed `__garelier/tpm/…` with a `{}` body). `cd && pwd -W` returns the
  // Windows path on Git-Bash and the POSIX path on Linux (where node already
  // agrees). A non-existent --project fails `cd` -> "" -> skip (fail-quiet: a
  // bogus --project must never create a stray).
  const projectRoot = bashCapture(["bash", "-c", 'cd -- "$1" 2>/dev/null && { pwd -W 2>/dev/null || pwd; }', "_", project]).trim();
  if (!projectRoot) return;
  // The dispatch tree must really exist under the resolved root; otherwise a
  // wrong --pm-id (the observed `tpm`) would still mkdir __garelier/<id>/… for a
  // `{}` baseline. Fail-quiet when it isn't there (W-091 class b).
  if (!existsSync(join(projectRoot, "__garelier", pmId))) return;

  const selfDir = dirname(fileURLToPath(import.meta.url));
  const mirror = join(selfDir, "../driver/src/dispatch/task_mirror.ts");
  if (!existsSync(mirror)) return;
  const statePath = join(projectRoot, "__garelier", pmId, "runtime", "driver", "task_mirror_hook_state.json");

  // Compute the desired mirror; diff against the last recorded baseline; print
  // only the delta. The baseline is recorded on every run, so the first run is
  // silent (records the baseline) and only subsequent CHANGES are surfaced.
  const mirrorOut = bashCapture(["bun", mirror, "--pm-id", pmId, "--project", projectRoot, "--format", "ops"]);
  let d: { desired?: Array<{ key?: string; status?: string }> };
  try { d = JSON.parse(mirrorOut); } catch { return; }

  const cur: Record<string, string> = {};
  for (const it of (d.desired || [])) {
    if (it && typeof it.key === "string") cur[it.key] = it.status ?? "?";
  }

  let prev: Record<string, string> | null = null;
  try { prev = JSON.parse(readFileSync(statePath, "utf8")); } catch { prev = null; }

  if (prev !== null) {
    const p = prev;
    const added = Object.keys(cur).filter((k) => !(k in p));
    const removed = Object.keys(p).filter((k) => !(k in cur));
    const changed = Object.keys(cur).filter((k) => k in p && p[k] !== cur[k]).map((k) => `${k}:${p[k]}->${cur[k]}`);
    if (!added.length && !removed.length && !changed.length) return; // 差分なし = 無出力
    const parts: string[] = [];
    if (added.length) parts.push("追加 " + added.slice(0, 8).map((k) => `${k}(${cur[k]})`).join(", ") + (added.length > 8 ? "…" : ""));
    if (removed.length) parts.push("削除 " + removed.slice(0, 8).join(", ") + (removed.length > 8 ? "…" : ""));
    if (changed.length) parts.push("変化 " + changed.slice(0, 8).join(", ") + (changed.length > 8 ? "…" : ""));
    console.log("TASK-MIRROR diff: " + parts.join(" | "));
    console.log("  → harness tasks へ反映 (TaskCreate/TaskUpdate、dispatch 紐付きは owner 設定)。");
  }
  // First-ever run with an empty mirror = the project/pm resolved to no tasks;
  // do not lay down a `{}` baseline stray (W-091 class b). A real prior baseline
  // is still updated below (it records genuine removals).
  if (prev === null && Object.keys(cur).length === 0) return;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(cur));
  } catch { /* best effort */ }
}

try { main(); } catch { /* fail-shut: never fail the session */ }
process.exit(0);
