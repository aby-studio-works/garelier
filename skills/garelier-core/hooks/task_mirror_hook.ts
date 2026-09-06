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
import { resolveBashLaunch, shellQuote } from "../driver/src/scripts/_lib.ts";

const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9._-]+$/;

// Shell out a single word-splitting-safe command through bash, exactly as the
// original hook did. bash.exe applies MSYS argv path translation (e.g. an MSYS
// /tmp project path -> the real Windows path) so task_mirror.ts resolves the
// project the same way it did under the pure-shell hook. `q` single-quotes each
// argument (any embedded single quote is escaped) so paths with spaces survive.
function bashCapture(parts: string[]): string {
  const shell = resolveBashLaunch();
  if (!shell) return "";
  const r = spawnSync(shell.executable, ["-c", parts.map((part) => shellQuote(part)).join(" ")], {
    windowsHide: true,
    env: shell.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.error || r.status !== 0) return "";
  return (r.stdout ?? "").toString();
}

function dockIntegratedRequestIds(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      try { visit(JSON.parse(candidate)); return; } catch { /* inspect JSON lines below */ }
      for (const line of candidate.split(/\r?\n/)) {
        try { visit(JSON.parse(line)); } catch { /* non-JSON output */ }
      }
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    const object = candidate as Record<string, unknown>;
    if (Array.isArray(object.integrated)) {
      for (const item of object.integrated) {
        if (!item || typeof item !== "object") continue;
        const requestId = (item as Record<string, unknown>).requestId;
        if (typeof requestId === "string" && requestId.length > 0) found.add(requestId);
      }
    }
    for (const key of ["stdout", "output", "content", "tool_response", "tool_result"]) {
      if (key in object) visit(object[key]);
    }
  };
  visit(value);
  return [...found];
}

function main(): void {
  let input = "";
  try { input = readFileSync(0, "utf8"); } catch { return; }

  // Fast pure-substring reject: no land/dispatch script mentioned -> nothing to
  // mirror, exit before spawning any subprocess.
  if (!input.includes("merge_land.ts") && !input.includes("dispatch_prepare.ts") && !input.includes("dispatch_cleanup.ts") && !input.includes("dock_integrate.ts")) {
    return;
  }

  // Confirm tool_input.command really is a land/dispatch script (guards against
  // the names only appearing in captured output) and extract --pm-id/--project.
  let pmId = "";
  let project = "";
  let requestIds: string[] = [];
  let isAftercare = false;
  try {
    const d = JSON.parse(input) as { tool_input?: { command?: unknown }; tool_response?: unknown; tool_result?: unknown };
    const cmd = (d.tool_input && typeof d.tool_input.command === "string") ? d.tool_input.command : "";
    if (!/(merge_land|dispatch_prepare|dispatch_cleanup|dock_integrate)\.ts/.test(cmd)) return;
    isAftercare = /(?:merge_land|dock_integrate)\.ts/.test(cmd) || /dispatch_cleanup\.ts/.test(cmd) && /--request-id(?:=|\s)/.test(cmd);
    pmId = (cmd.match(/--pm-id[= ]+"?([^"\s]+)/) || [])[1] || "";
    project = (cmd.match(/--project[= ]+"?([^"\s]+)/) || [])[1] || "";
    const directRequestId = (cmd.match(/--request-id[= ]+"?([^"\s]+)/) || [])[1] || "";
    if (directRequestId) requestIds.push(directRequestId);
    if (requestIds.length === 0 && /merge_land\.ts/.test(cmd)) {
      const response = JSON.stringify(d.tool_response ?? d.tool_result ?? "");
      const requestId = (response.match(/(?:\\?"request_id\\?"\s*:\s*\\?")([^"\\]+)/) || [])[1] || "";
      if (requestId) requestIds.push(requestId);
    }
    if (/dock_integrate\.ts/.test(cmd)) requestIds.push(...dockIntegratedRequestIds(d.tool_response ?? d.tool_result ?? ""));
    // The request id is passed to core's canonical journal verifier. Apply the
    // same grammar before that call; malformed Dock items are
    // ignored independently and cannot suppress a later valid item.
    requestIds = [...new Set(requestIds)].filter((requestId) => SAFE_REQUEST_ID_RE.test(requestId));
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
  const aftercare = join(selfDir, "../driver/src/dispatch/land_aftercare.ts");
  if (!existsSync(mirror) || !existsSync(aftercare)) return;
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
    if (added.length || removed.length || changed.length) {
      const parts: string[] = [];
      if (added.length) parts.push("追加 " + added.slice(0, 8).map((k) => `${k}(${cur[k]})`).join(", ") + (added.length > 8 ? "…" : ""));
      if (removed.length) parts.push("削除 " + removed.slice(0, 8).join(", ") + (removed.length > 8 ? "…" : ""));
      if (changed.length) parts.push("変化 " + changed.slice(0, 8).join(", ") + (changed.length > 8 ? "…" : ""));
      console.log("TASK-MIRROR diff: " + parts.join(" | "));
      console.log("  → harness tasks へ反映 (TaskCreate/TaskUpdate、dispatch 紐付きは owner 設定)。");
    }
  }
  // Provider application and acknowledgement are deliberately outside core
  // aftercare. This hook asks core to verify the canonical merge pair plus the
  // append-only terminal journal, then emits that authenticated operation. It never
  // claims that an external Task provider applied it. A provider/harness callback
  // may invoke `land_aftercare.ts ack-provider` only after observing successful
  // mutation with this exact idempotency key and payload hash.
  if (isAftercare && requestIds.length > 0) {
    for (const requestId of requestIds) {
      try {
        const verified = JSON.parse(bashCapture([
          "bun", aftercare, "verify-provider-operation",
          "--project", projectRoot, "--pm-id", pmId, "--request-id", requestId,
        ])) as {
          kind?: unknown;
          journal?: unknown;
          request_id?: unknown;
          idempotency_key?: unknown;
          payload_hash?: unknown;
          payload?: unknown;
        };
        if (verified.kind !== "garelier_land_aftercare_verified_provider_operation"
          || verified.request_id !== requestId
          || typeof verified.journal !== "string"
          || typeof verified.idempotency_key !== "string"
          || typeof verified.payload_hash !== "string") continue;
        console.log(`GARELIER_AFTERCARE_TASK_OP: ${JSON.stringify(verified)}`);
      } catch { continue; /* fail-quiet per item: later pending operations remain visible */ }
    }
  }

  // First-ever run with an empty mirror = the project/pm resolved to no tasks;
  // do not lay down a `{}` baseline stray (W-091 class b). The aftercare
  // authenticated journal operation above is independent of mirror cardinality and must still emit.
  if (prev === null && Object.keys(cur).length === 0) return;
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(cur));
  } catch { /* best effort */ }
}

try { main(); } catch { /* fail-shut: never fail the session */ }
process.exit(0);
