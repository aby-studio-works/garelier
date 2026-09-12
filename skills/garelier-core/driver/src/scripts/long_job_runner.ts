#!/usr/bin/env bun
import { closeSync, openSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { rmdirSync } from "../guard/path_guard.ts";
import {
  acknowledgeLongJob,
  armLongJob,
  coalesceCompletionWake,
  drainLongJobs,
  finishLongJob,
  loadVerifiedLongJobCommand,
  dequeueArmedJobs,
  listLongJobs,
  recordLongJobChildPid,
  readLongJob,
  rearmWholeCommand,
  recoverLongJobs,
  startLongJob,
  failLongJob,
  claimBrokerLock,
  heartbeatBrokerLock,
  inspectBrokerLock,
  releaseBrokerLock,
  requestBrokerHandoff,
  setBrokerPhase,
  type WakeCapability,
} from "../long_jobs.ts";
import { resolveBashExecutable } from "./_lib.ts";
import { assertOperatorResidentStart, ResidentProcessEnvironmentError } from "./resident_process_health.ts";
import { matchesOwnedChild, ownedChildBinding, ownedChildIdentity, publishedLongJobProcessIdentity, type LongJobProcessIdentity, type OwnedChildBinding } from "../long_job_process_identity.ts";

// Reuse the native observation's existing five-second bound, not a new larger
// execution allowance. No timer authorizes a command or a second spawn.
const HANDSHAKE_MS = 5_000;

/** Internal-only entry: the inherited Bun IPC endpoint is required BEFORE any
 * record/command loading. CLI arguments cannot construct this capability.
 *
 * W-788: ONE entry point. The previous `runOwnedChild` / `runOwnedChildWithState`
 * split existed only to carry `authorized` out of the promise through a mutable
 * object, and left a second `main --owned-child` route that always terminated
 * through `process.exit` and never the post-ACK disconnect path. `authorized` is
 * now returned with the code. It is invocation-private, reports only that the
 * exact ACK was accepted for THIS invocation, and controls CLI termination ONLY
 * — never command authorization. */
export async function runOwnedChild(): Promise<{ code: number; authorized: boolean }> {
  if (typeof process.send !== "function" || process.connected !== true) return { code: 2, authorized: false };
  let authorized = false;
  return new Promise<{ code: number; authorized: boolean }>((resolveExit) => {
    let binding: OwnedChildBinding | undefined;
    let selfIdentity: LongJobProcessIdentity | undefined;
    let phase: "init" | "ack" | "accepted" | "closed" = "init";
    const deadline = Date.now() + HANDSHAKE_MS;
    let transportLost = false;
    const finish = (code: number) => {
      phase = "closed";
      clearTimeout(timer);
      process.off("message", message);
      process.off("disconnect", disconnected);
      process.off("error", transportFailed);
      resolveExit({ code, authorized });
    };
    const transportFailed = () => {
      if (phase === "accepted") { transportLost = true; return; }
      if (phase !== "closed") finish(2);
    };
    const disconnected = () => {
      if (phase !== "accepted") finish(2);
      // ACK acceptance may already have authorized a spawn. Keep waiting for
      // that one command; never manufacture the absent parent's receipt.
    };
    const timer = setTimeout(() => { if (phase !== "accepted") finish(2); }, HANDSHAKE_MS);
    const execute = async (b: OwnedChildBinding) => {
      try {
        const record = readLongJob(b.root, b.job);
        if (record.state !== "RUNNING" || record.attempt !== b.attempt || record.command_digest !== b.digest
          || record.runtime?.child_pid !== process.pid || !selfIdentity
          || record.runtime.child_identity?.pid !== selfIdentity.pid
          || record.runtime.child_identity.host !== selfIdentity.host
          || record.runtime.child_identity.creation !== selfIdentity.creation)
          throw new Error("owned child: command authority changed after ACK");
        const command = loadVerifiedLongJobCommand(record);
        const bash = resolveBashExecutable();
        if (!bash) throw new Error("Git Bash not found");
        const commandChild = Bun.spawn([bash, "-lc", command], {
          windowsHide: true, cwd: record.cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit",
        });
        const exitCode = await commandChild.exited;
        // Best effort on a still-private channel. Loss after ACK is explicitly
        // ambiguous to the parent, never evidence that the command did not run.
        try { if (process.connected && !transportLost) process.send?.({ type: "terminal", binding: b, exitCode }); }
        catch { /* Preserve actual command exit even when IPC closes here. */ }
        finish(exitCode);
      } catch { finish(2); }
    };
    const message = (raw: unknown) => {
      if (phase === "closed" || phase === "accepted") return; // single launch
      const m = raw as { type?: string; binding?: unknown } | null;
      if (Date.now() >= deadline || !process.connected || !m) { finish(2); return; }
      if (phase === "init") {
        if (m.type !== "init" || !ownedChildBinding(m.binding) || m.binding.pid !== process.pid) { finish(2); return; }
        binding = m.binding;
        const identity = publishedLongJobProcessIdentity(process.pid);
        if (!identity || Date.now() >= deadline || !process.connected) { finish(2); return; }
        selfIdentity = identity;
        phase = "ack";
        try { process.send?.({ type: "ready", binding, identity }); }
        catch { finish(2); }
        return;
      }
      if (m.type !== "ack" || !binding || !matchesOwnedChild(m.binding, binding)) { finish(2); return; }
      // Linearization point: no await, loader, or spawn precedes this state.
      phase = "accepted";
      authorized = true; // exact ACK accepted; monotonic for this invocation
      clearTimeout(timer);
      try { process.send?.({ type: "accepted", binding }); } catch { /* post-ACK loss */ }
      void execute(binding);
    };
    process.on("message", message);
    process.on("error", transportFailed);
    process.on("disconnect", disconnected);
    // One fixed transport probe, AFTER listeners. Neither a boolean return nor
    // a null callback error authorizes init, identity publication or execution.
    try {
      if (typeof process.send !== "function") { transportFailed(); return; }
      process.send({ type: "probe", version: 1 }, (error: Error | null) => {
        if (error) transportFailed();
      });
    } catch { transportFailed(); }
  });
}

/** The settlement seam `launchOwnedLongJob` awaits. Its default is the real
 * bounded wait below; a caller may substitute one only for deterministic edge
 * coverage of the completion path, the same way `classifyRunningLongJob` takes
 * an `observe`. Substituting it introduces no timeout value and grants no
 * execution authority. */
export type TransportSettlement = (disconnected: Promise<void>) => Promise<"settled" | "unknown">;

/** Bounded settlement of the private IPC channel AFTER the wrapper has exited.
 * Reuses the existing handshake bound rather than introducing a new timeout
 * setting. "unknown" means the transport did not settle inside that bound; it is
 * never evidence about the command and never authorizes a rerun. */
export async function awaitTransportSettlement(
  disconnected: Promise<void>,
  deadlineMs = HANDSHAKE_MS,
): Promise<"settled" | "unknown"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      disconnected.then(() => "settled" as const),
      new Promise<"unknown">((done) => { timer = setTimeout(() => done("unknown"), deadlineMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Real publisher-to-wrapper route, also used by the qualification oracle.
 * Publication resolves false on rejection; completion alone owns terminal writes. */
export function launchOwnedLongJob(root: string, jobId: string, settle: TransportSettlement = awaitTransportSettlement) {
  let record = readLongJob(root, jobId);
  if (record.state !== "ARMED") throw new Error(`run requires ARMED; got ${record.state} (use explicit recovery rearm for a failed/stale attempt)`);
  loadVerifiedLongJobCommand(record);
  if (!resolveBashExecutable()) throw new Error("Git Bash not found");
  record = startLongJob(root, jobId);
  // Declared optional and checked in the callback: Bun cannot deliver an IPC
  // message before spawn returns, but an unbound callback must take the typed
  // reject path rather than throw an uncaught reference error.
  let binding: OwnedChildBinding | undefined;
  const state: { phase: "probe" | "ready" | "ack-sent" | "accepted" | "terminal" | "rejected" } = { phase: "probe" };
  let problem = "";
  let terminalCode: number | undefined;
  let published!: (ok: boolean) => void;
  const publication = new Promise<boolean>((done) => { published = done; });
  let closed!: () => void;
  const disconnected = new Promise<void>((done) => { closed = done; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  // startLongJob already initialized the log. Both streams share one append
  // descriptor; do not reopen/truncate the path independently for each stream.
  const logFd = openSync(record.paths.log, "a");
  const logClose: { attempted: boolean; failure?: { error: unknown } } = { attempted: false };
  const closeLog = () => {
    if (logClose.attempted) return; // never retry a possibly reused descriptor
    logClose.attempted = true;
    try { closeSync(logFd); }
    catch (error) { logClose.failure = { error }; } // onExit must not throw
  };
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([process.execPath, resolve(import.meta.dir, "long_job_runner.ts"), "--owned-child"], {
      windowsHide: true, cwd: record.cwd, stdin: "ignore",
      stdout: logFd, stderr: logFd,
      ipc(raw, endpoint) {
        const m = raw as { type?: string; version?: unknown; binding?: unknown; identity?: unknown; exitCode?: unknown } | null;
        const reject = () => {
          problem = state.phase === "probe" || state.phase === "ready" ? "owned child unconfirmed before ACK" : "owned child execution unknown after ACK sent";
          state.phase = "rejected";
          clearTimeout(timer);
          published(false);
          try { endpoint.disconnect(); } catch { /* exact child may have exited */ }
        };
        const bound = binding;
        if (!bound) { reject(); return; } // no message can precede the binding
        if (state.phase === "probe") {
          if (!m || m.type !== "probe" || m.version !== 1 || Object.keys(m).length !== 2 || endpoint.pid !== bound.pid) { reject(); return; }
          state.phase = "ready"; // one probe only; advance BEFORE sending init
          try { endpoint.send({ type: "init", binding: bound }); }
          catch { reject(); }
          return;
        }
        if (!m || !matchesOwnedChild(m.binding, bound) || endpoint.pid !== bound.pid) { reject(); return; }
        if (state.phase === "ready" && m.type === "ready" && ownedChildIdentity(m.identity, endpoint.pid)) {
          try {
            record = recordLongJobChildPid(root, jobId, record.attempt, endpoint.pid, m.identity, bound.digest);
            state.phase = "ack-sent"; // send may reach the child even if it throws
            endpoint.send({ type: "ack", binding: bound });
            clearTimeout(timer);
            published(true);
          } catch { reject(); }
        } else if (state.phase === "ack-sent" && m.type === "accepted") {
          state.phase = "accepted";
        } else if (state.phase === "accepted" && m.type === "terminal" && Number.isInteger(m.exitCode) && Number(m.exitCode) >= 0 && Number(m.exitCode) <= 255) {
          terminalCode = Number(m.exitCode);
          state.phase = "terminal";
        } else reject();
      },
      onDisconnect() { clearTimeout(timer); published(false); closed(); },
      onExit() { closeLog(); },
    });
  } catch (error) {
    closeLog();
    if (logClose.failure) throw new AggregateError([error, logClose.failure.error], "spawn and log close failed");
    throw error;
  }
  binding = { version: 1, root: resolve(root), job: jobId, attempt: record.attempt, digest: record.command_digest,
    nonce: randomBytes(32).toString("hex"), pid: child.pid };
  timer = setTimeout(() => {
    if (state.phase !== "probe" && state.phase !== "ready") return;
    problem = "owned child unconfirmed before ACK: handshake deadline";
    state.phase = "rejected";
    published(false);
    try { child.disconnect(); } catch { /* no command authorized */ }
  }, HANDSHAKE_MS);
  const completion = (async () => {
    const exitCode = await child.exited;
    // W-788: the private channel is settled under a BOUNDED wait reusing the
    // existing five-second handshake bound. `disconnected` resolves from Bun's
    // onDisconnect; if that ever fails to fire after the wrapper exited, the old
    // unbounded `Promise.all` never settled and the job stayed RUNNING forever.
    // Expiry is TYPED UNKNOWN transport settlement — it is not a new execution
    // allowance, authorizes no rerun or second spawn, and says nothing about
    // whether the command ran.
    if (await settle(disconnected) === "unknown" && !problem) {
      problem = "owned child transport settlement unknown: disconnect deadline";
    }
    closeLog(); // output completed before parent terminal/audit publication
    if (logClose.failure) throw logClose.failure.error;
    clearTimeout(timer);
    published(false);
    if (state.phase === "terminal" && terminalCode === exitCode && !problem) {
      if (exitCode === 0) finishLongJob(root, jobId, record.attempt, { exit_code: 0, log: record.paths.log });
      else failLongJob(root, jobId, record.attempt, `whole command exited ${exitCode}`, exitCode);
    } else {
      const failureCode = exitCode || 2;
      failLongJob(root, jobId, record.attempt,
        `${problem || "owned child execution unconfirmed; no matching terminal IPC"}; wrapper exit ${exitCode}; verify before any audited rearm`, failureCode);
      return failureCode;
    }
    return exitCode;
  })();
  return { child, publication, completion };
}

function value(argv: string[], name: string): string {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? "" : "";
}
function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function fail(message: string, code = 2): never { process.stderr.write(`long_job_runner: ${message}\n`); process.exit(code); }

function quoted(value: string): string { return `"${value.replace(/"/g, '\\"')}"`; }

export function brokerLaunchDirective(root: string, self = resolve(import.meta.dir, "long_job_runner.ts")): Record<string, unknown> {
  const status = inspectBrokerLock(root);
  if (status.state === "live") {
    if (status.owner.phase === "closing") {
      const requested = requestBrokerHandoff(root, status.owner);
      return requested ? {
        broker_already_live: true,
        broker_closing: true,
        handoff_requested: true,
        do_not_launch: false,
        broker_cmd: `${quoted(process.execPath)} ${quoted(self)} broker --root ${quoted(resolve(root))}`,
        directive: "launch ONE successor broker; it waits for the exact closing owner to release, then drains the durable queue",
      } : {
        broker_already_live: true,
        broker_closing: true,
        handoff_requested: false,
        do_not_launch: true,
        broker_cmd: "",
        directive: "a successor handoff is already durable; do not launch another broker",
      };
    }
    return {
      broker_already_live: true,
      do_not_launch: true,
      broker_cmd: "",
      directive: "the live single-flight broker owns this ARMED queue; do not launch another tracked broker",
    };
  }
  try { rmdirSync(resolve(root, ".broker.handoff")); } catch { /* stale handoff without an owner */ }
  return {
    broker_already_live: false,
    do_not_launch: false,
    broker_cmd: `${quoted(process.execPath)} ${quoted(self)} broker --root ${quoted(resolve(root))}`,
    directive: "launch ONE broker_cmd under the operator-owned tracked background facility; never launch one tracked waiter per job",
  };
}

function arm(argv: string[]): number {
  const root = value(argv, "--root");
  const jobId = value(argv, "--job");
  const commandRef = value(argv, "--command-ref");
  if (!root || !jobId || !commandRef) fail("arm requires --root, --job, and --command-ref");
  const command = readFileSync(commandRef, "utf8");
  const record = armLongJob({
    root,
    jobId,
    command,
    commandRef,
    cwd: value(argv, "--cwd"),
    dispatchId: value(argv, "--dispatch"),
    agentId: value(argv, "--agent"),
    provider: value(argv, "--provider") || "operator-background",
    wake: {
      armed: true,
      capability: value(argv, "--wake-capability") as WakeCapability,
      source: value(argv, "--wake-source"),
    },
  });
  const self = resolve(import.meta.dir, "long_job_runner.ts");
  emit({
    armed: true,
    job_id: record.job_id,
    attempt: record.attempt,
    command_digest: record.command_digest,
    ...brokerLaunchDirective(root, self),
  });
  return 0;
}

async function executeJob(root: string, jobId: string): Promise<number> {
  let record = readLongJob(root, jobId);
  if (record.state === "FINISHED" || record.state === "ACKED") {
    return 0;
  }
  if (record.state !== "ARMED") throw new Error(`run requires ARMED; got ${record.state} (use explicit recovery rearm for a failed/stale attempt)`);
  return launchOwnedLongJob(root, jobId).completion;
}

export interface BrokerOptions {
  root: string;
  providerCaps?: Record<string, number>;
  execute?: (jobId: string) => Promise<number>;
  notify?: (payload: unknown) => void;
  beforeClose?: () => void;
  afterFinalScan?: () => void;
  closeDebounceMs?: number;
  isAlive?: (pid: number) => boolean;
  handoffWaitMs?: number;
}

async function claimBrokerWithHandoff(root: string, options: BrokerOptions) {
  const deadline = Date.now() + (options.handoffWaitMs ?? 5_000);
  for (;;) {
    try { return claimBrokerLock(root, options.isAlive); }
    catch (error) {
      if (!(error as Error).message.includes("broker closing") || Date.now() >= deadline) throw error;
      await new Promise((done) => setTimeout(done, 10));
    }
  }
}

export async function runLongJobBroker(options: BrokerOptions): Promise<{ completed: number; wake_count: number }> {
  assertOperatorResidentStart("long_job_broker");
  const root = resolve(options.root);
  const owner = await claimBrokerWithHandoff(root, options);
  let completed = 0;
  let closeHookCalled = false;
  let ownerReleased = false;
  try {
    for (;;) {
      heartbeatBrokerLock(root, owner);
      const caps = options.providerCaps ?? {};
      const batch = dequeueArmedJobs(root, caps);
      if (batch.length === 0) {
        if (!closeHookCalled) { options.beforeClose?.(); closeHookCalled = true; }
        await new Promise((done) => setTimeout(done, options.closeDebounceMs ?? 50));
        setBrokerPhase(root, owner, "closing");
        if (dequeueArmedJobs(root, caps).length > 0) { setBrokerPhase(root, owner, "running"); continue; }
        options.afterFinalScan?.();
        break;
      }
      await Promise.allSettled(batch.map(async (record) => {
        let anomaly = "runner returned without a terminal ledger state";
        try {
          await (options.execute ? options.execute(record.job_id) : executeJob(root, record.job_id));
        } catch (error) {
          anomaly = `runner failure: ${(error as Error).message}`;
        } finally {
          let current = readLongJob(root, record.job_id);
          if (current.state === "ARMED") current = startLongJob(root, record.job_id);
          if (current.state === "RUNNING") failLongJob(root, record.job_id, current.attempt, anomaly);
          completed++;
        }
      }));
    }
    const wake = coalesceCompletionWake(root);
    const payload = { kind: "LONG-JOBS-PENDING", pending: wake.pending, completed, wake };
    releaseBrokerLock(root, owner);
    ownerReleased = true;
    if (wake.emitted) (options.notify ?? emit)(payload);
    return { completed, wake_count: wake.emitted ? 1 : 0 };
  } finally {
    if (!ownerReleased) releaseBrokerLock(root, owner);
  }
}

async function broker(argv: string[]): Promise<number> {
  const root = value(argv, "--root");
  if (!root) fail("broker requires --root");
  let result: { completed: number; wake_count: number };
  try { result = await runLongJobBroker({ root }); }
  catch (error) {
    if ((error as Error).message.includes("already running")) {
      emit({ attached: true, reason: "single-flight broker already owns this ledger and will double-scan before exit" });
      return 0;
    }
    throw error;
  }
  if (result.completed > 0) process.stdout.write(`RESULT: LONG-JOBS-PENDING completed=${result.completed} wake_count=${result.wake_count}\n`);
  return 0;
}

function scan(argv: string[]): number {
  const root = value(argv, "--root");
  if (!root) fail("startup-scan requires --root");
  const staleMs = Number(value(argv, "--stale-ms") || 15 * 60_000);
  const actions = recoverLongJobs(root, Date.now(), staleMs);
  const wake = coalesceCompletionWake(root);
  if (actions.length > 0) process.stdout.write(`RESULT: LONG-JOBS-PENDING pending=${actions.length}\n`);
  emit({ actions, wake });
  return actions.some((item) => item.action !== "DRAIN") ? 4 : 0;
}

function rearm(argv: string[]): number {
  const root = value(argv, "--root");
  const jobId = value(argv, "--job");
  if (!root || !jobId) fail("rearm requires --root and --job");
  const record = rearmWholeCommand(root, jobId);
  emit({ job_id: record.job_id, attempt: record.attempt, state: record.state, command_digest: record.command_digest });
  return 0;
}

function drain(argv: string[]): number {
  const root = value(argv, "--root");
  if (!root) fail("drain requires --root");
  const consumed: Array<{ job_id: string; attempt: number; result: unknown }> = [];
  const summary = drainLongJobs(root, (record, result) => consumed.push({ job_id: record.job_id, attempt: record.attempt, result }));
  emit({ ...summary, consumed, recovery: recoverLongJobs(root) });
  // A blocked record is unresolved work, not a clean drain. Before the per-job
  // change (W-788) the first such record threw out of the pass and this CLI
  // exited 2; now the pass continues past it, so a caller that reads only the
  // exit code would have seen 0. Keep it non-zero: 3 is the same
  // "completed, with items still unresolved" code `incident resolve` uses for
  // unmatched entries / orphaned tallies (`guard/incident_log.ts`).
  return summary.blocked.length > 0 ? 3 : 0;
}

// W-788: `main` has NO `--owned-child` route. The owned wrapper is entered only
// from `import.meta.main` below, which owns the post-ACK disconnect termination
// that a `main()` return value cannot express. The deleted branch was
// unreachable in production and would have terminated an authorized invocation
// through the wrong path.
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "arm") return arm(rest);
  if (command === "broker") return broker(rest);
  if (command === "startup-scan") return scan(rest);
  if (command === "rearm") return rearm(rest);
  if (command === "drain") return drain(rest);
  if (command === "ack") {
    const record = acknowledgeLongJob(value(rest, "--root"), value(rest, "--job"), Number(value(rest, "--attempt")));
    emit(record); return 0;
  }
  fail("usage: long_job_runner.ts arm|broker|startup-scan|rearm|drain|ack ...");
}

if (import.meta.main) {
  // An unauthorized owned invocation and every non-owned command terminate
  // immediately; only a post-ACK invocation sets `exitCode` and lets the private
  // channel close, so a command that already ran is never cut short. A throw from
  // `disconnect` propagates to the shared catch below — the previous
  // `catch (error) { throw error; }` was an exact no-op reading as handling.
  const completion = process.argv[2] === "--owned-child"
    ? runOwnedChild().then(({ code, authorized }) => {
      if (!authorized) process.exit(code);
      process.exitCode = code;
      if (process.connected) process.disconnect?.();
    })
    : main().then((code) => process.exit(code));
  completion.catch((error) =>
    fail((error as Error).message, error instanceof ResidentProcessEnvironmentError ? error.exitCode : 2));
}
