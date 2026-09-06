#!/usr/bin/env bun
import { readFileSync } from "node:fs";
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
  const command = loadVerifiedLongJobCommand(record);
  const bash = resolveBashExecutable();
  if (!bash) throw new Error("Git Bash not found");
  record = startLongJob(root, jobId);
  const logFile = Bun.file(record.paths.log);
  const child = Bun.spawn([bash, "-lc", command], {
    windowsHide: true,
    cwd: record.cwd,
    stdin: "ignore",
    stdout: logFile,
    stderr: logFile,
  });
  recordLongJobChildPid(root, jobId, record.attempt, child.pid);
  const exitCode = await child.exited;
  if (exitCode === 0) finishLongJob(root, jobId, record.attempt, { exit_code: 0, log: record.paths.log });
  else failLongJob(root, jobId, record.attempt, `whole command exited ${exitCode}`, exitCode);
  return exitCode;
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
  return 0;
}

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
  main().then((code) => process.exit(code)).catch((error) =>
    fail((error as Error).message, error instanceof ResidentProcessEnvironmentError ? error.exitCode : 2));
}
