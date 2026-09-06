#!/usr/bin/env bun
import { requireRuntimeExecutable } from "./_lib.ts";
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
// heavy_compile_lock queue-waits while the machine is busy or RAM-bound. OPEN is
// reserved for unusable lock infrastructure and is reported as ABORTED (exit 11),
// never as permission to launch lockless. A non-heavy class never touches the lock
// (NOT-HEAVY).
//
// Usage:
//   acquire: heavy_dispatch_gate.ts --project <root> --pm-id <id>
//               --resource-class <heavy|light|data|review> [--slug <s>]
//               [--heavy-tier <check|codegen>] [--owner-pid <long-lived-pid>]
//               [--timeout-sec <heartbeat-n>] [--poll-sec <n>]
//            `heavy-tier` (W-348) sizes the reclaim budgets this acquire hands the
//            lock: a check-tier job runs ~7m, a codegen-tier job runs HOURS, and one
//            shared threshold cannot serve both. UNDECLARED => no budgets forwarded,
//            so heavy_compile_lock keeps its own configured ones (W-362: silence must
//            not widen a shared slot). A declared-but-unknown token => codegen.
//            -> prints one of:
//                 NOT-HEAVY                (non-heavy class; lock untouched)
//                 ADMITTED <token>         (heavy slot held; <token> for release)
//                 QUEUED                   (legacy scheduler outcome — exit 10)
//                 ABORTED                  (lock infrastructure unavailable — exit 11)
//   release: heavy_dispatch_gate.ts --project <root> --pm-id <id>
//               --resource-class <c> --mode release --token <t>
//            -> releases the heavy slot the token names (no-op for non-heavy).
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeResourceClass, classifyHeavyAcquire, declaredHeavyTierToken, heavyTierBudget } from "../dispatch/engine_aware.ts";

const CORE_SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts");
const HEAVY_LOCK = resolve(CORE_SCRIPTS, "heavy_compile_lock.ts");

// Exit code a QUEUED heavy dispatch returns — distinct from a usage error (2) so a
// scheduler/operator can branch on "defer, retry later" vs "the invocation was
// wrong". 0 = admitted / not-heavy / released.
export const EXIT_QUEUED = 10;
export const EXIT_ABORTED = 11;

function flag(argv: string[], name: string, def = ""): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}

// Spawn heavy_compile_lock and return its stdout token + diagnostics. Injectable
// for tests; OPEN is classified as infra-abort, never lockless permission.
export type LockRunner = (args: string[]) => { stdout: string; stderr: string; code: number };

const defaultLockRunner: LockRunner = (args) => {
  const r = Bun.spawnSync([requireRuntimeExecutable("bun"), HEAVY_LOCK, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
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

  // W-348: the tier decides how long this heavy job is expected to hold the slot,
  // so the reclaim budgets travel with the acquire instead of the lock applying
  // one check-grade threshold to every heavy job.
  //
  // W-362 (N2): budgets are forwarded ONLY when a tier was actually DECLARED.
  // W-348 resolved an absent flag to codegen and forwarded it unconditionally,
  // which silently moved EVERY pre-existing flag-less heavy acquire from
  // stale 30 -> 90m and lease 240 -> 480m. On a maxConcurrent:1 machine-wide slot
  // that is not a harmless over-estimate: a DEAD check-tier holder wedges the only
  // heavy slot 3x longer, blocking every other heavy dispatch — the cost is paid
  // by third parties, not by the over-estimating job. Forwarding nothing leaves
  // heavy_compile_lock on its own configured defaults, i.e. byte-identical to
  // pre-W-348 behaviour for every caller that does not participate in the tier
  // protocol. The conservative codegen default is NOT weakened where W-348 earned
  // it — a declared-but-unrecognised token still resolves to codegen and warns;
  // it simply no longer fires on silence. Now that dispatch_prepare threads the
  // declared tier through (W-362 AC1), the standard path declares it explicitly.
  const tier = declaredHeavyTierToken(flag(argv, "heavy-tier"));
  if (tier.warning) warn(`heavy_dispatch_gate: ${tier.warning}`);
  const budget = tier.tier ? heavyTierBudget(tier.tier) : null;

  const timeoutSec = flag(argv, "timeout-sec", "60");
  const pollSec = flag(argv, "poll-sec", "5");
  const ownerPid = flag(argv, "owner-pid");
  const lockArgs = [
    "--project", project, "--pm-id", pm, "--mode", "acquire",
    // The tier suffix is part of the declaration too: an untiered acquire keeps the
    // pre-W-348 label shape, so an operator reading lock state can tell at a glance
    // which holders are running on declared budgets and which on config defaults.
    "--label", budget ? `${label}:${budget.tier}` : label, "--timeout-sec", timeoutSec, "--poll-sec", pollSec,
  ];
  if (budget) {
    lockArgs.push("--stale-minutes", String(budget.staleMinutes));
    lockArgs.push("--lease-minutes", String(budget.leaseMinutes));
  }
  // This one-shot gate cannot infer which ancestor will hold the lease through
  // the dispatched role's lifetime. Forward an explicit long-lived pid when
  // supplied; otherwise heavy_compile_lock records `unknown` conservatively.
  if (ownerPid) lockArgs.push("--owner-pid", ownerPid);
  const r = runLock(lockArgs);
  if (r.stderr) warn(r.stderr.trimEnd());
  const timedOut = /acquire timed out/.test(r.stderr);
  const decision = classifyHeavyAcquire(r.stdout, timedOut);
  if (decision.state === "queued") {
    warn(`heavy_dispatch_gate: ${decision.reason}`);
    return { line: "QUEUED", code: EXIT_QUEUED };
  }
  if (decision.state === "aborted") {
    warn(`heavy_dispatch_gate: ${decision.reason}`);
    return { line: "ABORTED", code: EXIT_ABORTED };
  }
  // admitted: echo the token (a slot path, or DISABLED when explicitly configured)
  // so the caller can release exactly what it holds. The tier's occupancy estimate
  // goes to stderr, not into this line — a waiting scheduler needs the figure, but
  // the stdout contract stays exactly `ADMITTED <token>` for existing parsers.
  warn(budget
    ? `heavy_dispatch_gate: admitted as ${budget.tier}-tier — expect the slot held ~${budget.lockOccupancyMinutes}m (reclaim budgets: stale ${budget.staleMinutes}m, lease ${budget.leaseMinutes}m)`
    : "heavy_dispatch_gate: admitted with NO declared heavy_tier — heavy_compile_lock keeps its configured reclaim budgets (W-362: an undeclared tier no longer widens them). Pass --heavy-tier check|codegen to schedule this acquire on its measured duration.");
  return { line: `ADMITTED ${r.stdout.trim() || "OPEN"}`, code: 0 };
}

function main(): void {
  const res = runHeavyGate(process.argv.slice(2));
  if (res.line) process.stdout.write(res.line + "\n");
  process.exit(res.code);
}

if (import.meta.main) main();
