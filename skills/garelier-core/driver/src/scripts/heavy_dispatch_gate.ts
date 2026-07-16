#!/usr/bin/env bun
// Garelier dispatch (W-087) — the heavy-dispatch scheduler gate.
//
// A `resource_class = heavy` dispatch is a full-workspace compile-grade job. On
// the RAM-bound box (31.7 GB) only ONE may run at a time, or two parallel heavy
// dispatches OOM and corrupt target dirs. The compile-side heavy_compile_lock
// already serializes live compiles machine-wide via a shared file lock; this gate
// routes a heavy DISPATCH through THAT SAME lock BEFORE it is launched — so a heavy
// dispatch and a heavy compile (and a second heavy dispatch) mutually exclude.
//
// It REUSES heavy_compile_lock (never a second lock): acquire spawns
// `heavy_compile_lock --mode acquire`, then reinterprets its output for a dispatch.
// heavy_compile_lock fail-opens to "OPEN" on timeout so a live compile is never
// deadlocked; a DISPATCH must instead be DEFERRED when the machine is busy, so an
// OPEN that came from a busy-timeout is reported as QUEUED (exit 10), while an OPEN
// from a disabled/free lock is a genuine ADMITTED. A non-heavy class never touches
// the lock (NOT-HEAVY).
//
// Usage:
//   acquire: heavy_dispatch_gate.ts --project <root> --pm-id <id>
//               --resource-class <heavy|light|data|review> [--slug <s>]
//               [--timeout-sec <n>] [--poll-sec <n>]
//            -> prints one of:
//                 NOT-HEAVY                (non-heavy class; lock untouched)
//                 ADMITTED <token>         (heavy slot held; <token> for release)
//                 QUEUED                   (machine busy; defer — exit 10)
//   release: heavy_dispatch_gate.ts --project <root> --pm-id <id>
//               --resource-class <c> --mode release --token <t>
//            -> releases the heavy slot the token names (no-op for non-heavy).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeResourceClass, classifyHeavyAcquire } from "../dispatch/engine_aware.ts";

const CORE_SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts");
const HEAVY_LOCK = resolve(CORE_SCRIPTS, "heavy_compile_lock.ts");

// Exit code a QUEUED heavy dispatch returns — distinct from a usage error (2) so a
// scheduler/operator can branch on "defer, retry later" vs "the invocation was
// wrong". 0 = admitted / not-heavy / released.
export const EXIT_QUEUED = 10;

function flag(argv: string[], name: string, def = ""): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}

// Spawn heavy_compile_lock and return its stdout token + whether it fail-opened on
// a busy timeout (the "acquire timed out" stderr banner). Injectable for tests.
export type LockRunner = (args: string[]) => { stdout: string; stderr: string; code: number };

const defaultLockRunner: LockRunner = (args) => {
  const r = Bun.spawnSync(["bun", HEAVY_LOCK, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: r.stdout ? r.stdout.toString() : "",
    stderr: r.stderr ? r.stderr.toString() : "",
    code: r.exitCode ?? 0,
  };
};

export interface GateResult {
  line: string; // the stdout line
  code: number; // the process exit code
}

// Pure gate decision from the lock runner's result — the testable core.
export function runHeavyGate(
  argv: string[],
  runLock: LockRunner = defaultLockRunner,
  warn: (s: string) => void = (s) => process.stderr.write(s + "\n"),
): GateResult {
  const project = flag(argv, "project");
  const pm = flag(argv, "pm-id");
  const mode = flag(argv, "mode", "acquire");
  if (!project || !pm) {
    warn("heavy_dispatch_gate: --project and --pm-id are required");
    return { line: "", code: 2 };
  }

  const rc = normalizeResourceClass(flag(argv, "resource-class"));
  if (rc.warning) warn(`heavy_dispatch_gate: ${rc.warning}`);

  // A non-heavy class never serializes — the lock is left entirely untouched.
  if (rc.value !== "heavy") {
    return { line: "NOT-HEAVY", code: 0 };
  }

  const slug = flag(argv, "slug");
  const label = slug ? `heavy-dispatch:${slug}` : "heavy-dispatch";

  if (mode === "release") {
    const token = flag(argv, "token");
    const r = runLock(["--project", project, "--pm-id", pm, "--mode", "release", "--token", token]);
    if (r.stderr) warn(r.stderr.trimEnd());
    return { line: r.stdout.trim() || "released", code: r.code };
  }
  if (mode !== "acquire") {
    warn(`heavy_dispatch_gate: unknown --mode "${mode}" (acquire|release)`);
    return { line: "", code: 2 };
  }

  const timeoutSec = flag(argv, "timeout-sec", "60");
  const pollSec = flag(argv, "poll-sec", "5");
  const r = runLock([
    "--project", project, "--pm-id", pm, "--mode", "acquire",
    "--label", label, "--timeout-sec", timeoutSec, "--poll-sec", pollSec,
  ]);
  if (r.stderr) warn(r.stderr.trimEnd());
  const timedOut = /acquire timed out/.test(r.stderr);
  const decision = classifyHeavyAcquire(r.stdout, timedOut);
  if (decision.state === "queued") {
    warn(`heavy_dispatch_gate: ${decision.reason}`);
    return { line: "QUEUED", code: EXIT_QUEUED };
  }
  // admitted: echo the token (a slot path, or OPEN when serialization is disabled)
  // so the caller can release exactly what it holds.
  return { line: `ADMITTED ${r.stdout.trim() || "OPEN"}`, code: 0 };
}

function main(): void {
  const res = runHeavyGate(process.argv.slice(2));
  if (res.line) process.stdout.write(res.line + "\n");
  process.exit(res.code);
}

if (import.meta.main) main();
