import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, unlinkSync, writeFileSync } from "./guard/path_guard.ts";
import {
  acknowledgeLongJob, armLongJob, coalesceCompletionWake, dequeueArmedJobs, drainLongJobs,
  brokerLockPath, claimBrokerLock, failLongJob, finishLongJob, inspectBrokerLock, readLongJob, rearmWholeCommand,
  claimWakeLock, inspectWakeLock, recoverLongJobs, releaseBrokerLock, releaseWakeLock, startLongJob, wakeLockPath,
} from "./long_jobs.ts";
import { brokerLaunchDirective, runLongJobBroker } from "./scripts/long_job_runner.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = mkdtempSync(join(tmpdir(), "garelier-long-jobs-")); roots.push(value); return value; }
function arm(base: string, id: string, provider = "codex-exec") {
  const command = "cargo test --workspace";
  const commandRef = join(base, `${id}.command`);
  writeFileSync(commandRef, command);
  return armLongJob({ root: base, jobId: id, command, commandRef, cwd: base, dispatchId: "42", agentId: "worker-42", provider, wake: { armed: true, capability: "monitor", source: "operator-monitor" } });
}

describe("durable long-job ledger", () => {
  test("blocks launch without reliable wake and stores only a command digest", () => {
    const base = root();
    const commandRef = join(base, "no-wake.command");
    writeFileSync(commandRef, "secret command");
    expect(() => armLongJob({ root: base, jobId: "no-wake", command: "secret command", commandRef, cwd: base, dispatchId: "1", agentId: "a", provider: "codex-exec" })).toThrow("BLOCK");
    const record = arm(base, "armed");
    expect(record.command_digest).toMatch(/^sha256:/);
    expect(JSON.stringify(record)).not.toContain("cargo test");
    expect(() => armLongJob({ root: base, jobId: "bogus-wake", command: "secret command", commandRef, cwd: base, dispatchId: "1", agentId: "a", provider: "codex-exec", wake: { armed: true, capability: "invented" as any, source: "untrusted" } })).toThrow("reliable completion wake");
  });

  test("record reads reject tampered derived paths, cwd, and command_ref trust boundary", () => {
    const base = root();
    const record = arm(base, "tamper");
    const raw = JSON.parse(readFileSync(record.paths.record, "utf8"));
    raw.paths.log = join(base, "other.log");
    writeFileSync(record.paths.record, JSON.stringify(raw));
    expect(() => readLongJob(base, "tamper")).toThrow("corrupt log path");

    raw.paths.log = record.paths.log;
    raw.cwd = join(base, "missing-worktree");
    writeFileSync(record.paths.record, JSON.stringify(raw));
    expect(() => readLongJob(base, "tamper")).toThrow("cwd/worktree is unavailable");

    raw.cwd = base;
    raw.command_ref = join(base, "..", "outside.command");
    writeFileSync(record.paths.record, JSON.stringify(raw));
    expect(() => readLongJob(base, "tamper")).toThrow("durable ledger root");
  });

  test("ledger root, job entry, and command_ref reparse escapes fail closed", () => {
    const base = root();
    const outside = root();
    const linkType = process.platform === "win32" ? "junction" : "dir";
    const rootLink = join(base, "root-link");
    const jobLink = join(base, "linked-job");
    const refLink = join(base, "linked-refs");
    symlinkSync(outside, rootLink, linkType);
    symlinkSync(outside, jobLink, linkType);
    symlinkSync(outside, refLink, linkType);
    writeFileSync(join(outside, "escape.command"), "cargo test --workspace");
    try {
      expect(() => armLongJob({ root: rootLink, jobId: "root-escape", command: "cargo test --workspace", commandRef: join(rootLink, "escape.command"), cwd: base, dispatchId: "1", agentId: "a", provider: "codex-exec", wake: { armed: true, capability: "monitor", source: "test" } })).toThrow("ledger root");
      expect(() => armLongJob({ root: base, jobId: "ref-escape", command: "cargo test --workspace", commandRef: join(refLink, "escape.command"), cwd: base, dispatchId: "1", agentId: "a", provider: "codex-exec", wake: { armed: true, capability: "monitor", source: "test" } })).toThrow("symlink/reparse");
      expect(recoverLongJobs(base)).toContainEqual(expect.objectContaining({ job_id: "linked-job", action: "BLOCK_LEDGER_PATH" }));
    } finally {
      for (const link of [rootLink, jobLink, refLink]) if (existsSync(link)) unlinkSync(link);
    }
  });

  test("job directory creation is exclusive even without a record file", () => {
    const base = root();
    mkdirSync(join(base, "reserved"));
    const command = "cargo test --workspace";
    const commandRef = join(base, "reserved.command");
    writeFileSync(commandRef, command);
    expect(() => armLongJob({ root: base, jobId: "reserved", command, commandRef, cwd: base, dispatchId: "1", agentId: "a", provider: "codex-exec", wake: { armed: true, capability: "monitor", source: "test" } })).toThrow("exclusively");
  });

  test("five completions coalesce to one wake, drain five, and ACK exact attempts", () => {
    const base = root();
    for (let i = 1; i <= 5; i++) { arm(base, `job-${i}`); startLongJob(base, `job-${i}`); finishLongJob(base, `job-${i}`, 1, { ok: i }); }
    expect(coalesceCompletionWake(base)).toMatchObject({ emitted: true, pending: 5 });
    expect(coalesceCompletionWake(base)).toMatchObject({ emitted: false, pending: 5 });
    const consumed: string[] = [];
    expect(drainLongJobs(base, (record) => consumed.push(record.job_id))).toEqual({ acked: 5, passes: 1 });
    expect(consumed).toEqual(["job-1", "job-2", "job-3", "job-4", "job-5"]);
    expect(readLongJob(base, "job-3").state).toBe("ACKED");
    expect(acknowledgeLongJob(base, "job-3", 1).state).toBe("ACKED");
  });

  test("completion during drain is consumed in a second deterministic pass", () => {
    const base = root();
    arm(base, "first"); startLongJob(base, "first"); finishLongJob(base, "first", 1, { ok: 1 });
    arm(base, "second"); startLongJob(base, "second");
    const seen: string[] = [];
    const drained = drainLongJobs(base, (record) => seen.push(record.job_id), (pass) => {
      if (pass === 1) finishLongJob(base, "second", 1, { ok: 2 });
    });
    expect(drained).toEqual({ acked: 2, passes: 2 });
    expect(seen).toEqual(["first", "second"]);
  });

  test("coalesce/drain latch preserves a completion after final scan and before payload write", async () => {
    const base = root();
    arm(base, "first"); startLongJob(base, "first"); finishLongJob(base, "first", 1, { ok: 1 });
    arm(base, "late"); startLongJob(base, "late");
    expect(coalesceCompletionWake(base, "2026-01-01T00:00:00.000Z", 60_000).emitted).toBe(true);
    expect(coalesceCompletionWake(base, "2026-01-01T00:00:00.100Z", 60_000).emitted).toBe(false);
    let waiter: ReturnType<typeof Bun.spawn> | undefined;
    expect(drainLongJobs(base, () => {}, undefined, undefined, () => {
      finishLongJob(base, "late", 1, { ok: 2 });
      const moduleUrl = new URL("./long_jobs.ts", import.meta.url).href;
      waiter = Bun.spawn([process.execPath, "-e", `import { coalesceCompletionWake } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(coalesceCompletionWake(${JSON.stringify(base)}, "2026-01-01T00:00:00.200Z", 60000)));`], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
      const latch = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 2_000;
      while (!existsSync(join(base, ".wake.handoff")) && Date.now() < deadline) Atomics.wait(latch, 0, 0, 10);
      expect(existsSync(join(base, ".wake.handoff"))).toBe(true);
    })).toEqual({ acked: 1, passes: 1 });
    const waiterOutput = await new Response(waiter!.stdout as ReadableStream<Uint8Array>).text();
    expect(await waiter!.exited, await new Response(waiter!.stderr as ReadableStream<Uint8Array>).text()).toBe(0);
    expect(JSON.parse(waiterOutput)).toMatchObject({ emitted: true, pending: 1 });
    expect(JSON.parse(readFileSync(join(base, "wake-pending.json"), "utf8"))).toMatchObject({ pending: 1, recovery: [expect.objectContaining({ job_id: "late", action: "DRAIN" })] });
    expect(coalesceCompletionWake(base, "2026-01-01T00:00:00.300Z", 60_000)).toMatchObject({ emitted: false, pending: 1 });
  });

  test("recovers result written before FINISHED without rerun", () => {
    const base = root();
    const record = arm(base, "crash"); startLongJob(base, "crash");
    writeFileSync(record.paths.result, JSON.stringify({ job_id: "crash", attempt: 1, result: { ok: true } }));
    expect(recoverLongJobs(base)).toEqual([{ job_id: "crash", attempt: 1, action: "DRAIN", reason: "result-written-before-state-crash" }]);
    expect(readLongJob(base, "crash").state).toBe("FINISHED");
  });

  test("stale/failed attempts rerun the whole command once while normal finish never reruns", () => {
    const base = root();
    arm(base, "stale"); startLongJob(base, "stale", "2020-01-01T00:00:00.000Z");
    arm(base, "failed"); startLongJob(base, "failed"); failLongJob(base, "failed", 1, "timeout");
    arm(base, "done"); startLongJob(base, "done"); finishLongJob(base, "done", 1, { ok: true });
    const actions = recoverLongJobs(base, Date.parse("2020-01-01T01:00:00.000Z"), 1_000);
    expect(actions).toContainEqual({ job_id: "stale", attempt: 1, action: "RERUN_WHOLE_COMMAND", reason: "stale-running-no-result" });
    expect(actions).toContainEqual({ job_id: "failed", attempt: 1, action: "RERUN_WHOLE_COMMAND", reason: "failed" });
    expect(actions).toContainEqual({ job_id: "done", attempt: 1, action: "DRAIN", reason: "finished" });
    expect(rearmWholeCommand(base, "failed", undefined, () => false).attempt).toBe(2);
    expect(() => rearmWholeCommand(base, "done")).toThrow("recovery rearm");
  });

  test("FAILED rearm blocks missing or modified exit/done/log artifacts", () => {
    const base = root();
    const missing = arm(base, "missing-exit"); startLongJob(base, "missing-exit"); failLongJob(base, "missing-exit", 1, "failed", 7);
    unlinkSync(missing.paths.exit);
    expect(() => rearmWholeCommand(base, "missing-exit", undefined, () => false)).toThrow("missing exit/done");

    const missingDone = arm(base, "missing-done"); startLongJob(base, "missing-done"); failLongJob(base, "missing-done", 1, "failed", 7);
    unlinkSync(missingDone.paths.done);
    expect(() => rearmWholeCommand(base, "missing-done", undefined, () => false)).toThrow("missing exit/done");

    const exit = arm(base, "modified-exit"); startLongJob(base, "modified-exit"); failLongJob(base, "modified-exit", 1, "failed", 7);
    writeFileSync(exit.paths.exit, JSON.stringify({ job_id: "modified-exit", attempt: 1, exit_code: 7, reason: "changed" }));
    expect(() => rearmWholeCommand(base, "modified-exit", undefined, () => false)).toThrow("digest mismatch");

    const done = arm(base, "modified-done"); startLongJob(base, "modified-done"); failLongJob(base, "modified-done", 1, "failed", 8);
    writeFileSync(done.paths.done, JSON.stringify({ job_id: "modified-done", attempt: 1, state: "FAILED", extra: true }));
    expect(() => rearmWholeCommand(base, "modified-done", undefined, () => false)).toThrow("digest mismatch");

    const log = arm(base, "modified-log"); startLongJob(base, "modified-log"); failLongJob(base, "modified-log", 1, "failed", 9);
    writeFileSync(log.paths.log, "changed after terminal record\n");
    expect(() => rearmWholeCommand(base, "modified-log", undefined, () => false)).toThrow("digest mismatch");
  });

  test("stale RUNNING rearm archives missing terminal observations before attempt increment", () => {
    const base = root();
    const original = arm(base, "stale-audit");
    startLongJob(base, "stale-audit", "2020-01-01T00:00:00.000Z", 4567);
    const next = rearmWholeCommand(base, "stale-audit", "2020-01-01T01:00:00.000Z", () => false);
    const audit = join(base, "stale-audit", "attempt-audits", "attempt-000001");
    const manifest = JSON.parse(readFileSync(join(audit, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      job_id: "stale-audit", attempt: 1, state: "RUNNING", command_digest: original.command_digest,
      record_updated_at: "2020-01-01T00:00:00.000Z",
      processes: { runner_pid: { pid: 4567, status: "dead observed" }, child_pid: { pid: null, status: "unknown/missing observed" } },
      files: { log: { status: "present" }, exit: { status: "unknown/missing observed" }, done: { status: "unknown/missing observed" } },
    });
    expect(existsSync(join(audit, "job.log"))).toBe(true);
    expect(next).toMatchObject({ attempt: 2, state: "ARMED", command_digest: original.command_digest, cwd_identity: original.cwd_identity });
    expect(next.timestamps.armed_at).toBe("2020-01-01T01:00:00.000Z");
  });

  test("cwd canonical identity stays stable across the Windows attempt lifecycle", () => {
    const base = root();
    const armed = arm(base, "cwd-stability");
    expect(readLongJob(base, "cwd-stability").cwd_identity).toBe(armed.cwd_identity);
    startLongJob(base, "cwd-stability");
    expect(readLongJob(base, "cwd-stability").cwd_identity).toBe(armed.cwd_identity);
    failLongJob(base, "cwd-stability", 1, "failed");
    expect(readLongJob(base, "cwd-stability").cwd_identity).toBe(armed.cwd_identity);
    expect(rearmWholeCommand(base, "cwd-stability", undefined, () => false).cwd_identity).toBe(armed.cwd_identity);
  });

  test("attempt audit publish is retry-idempotent and survives the next attempt overwrite", () => {
    const base = root();
    const first = arm(base, "durable-audit"); startLongJob(base, "durable-audit");
    writeFileSync(first.paths.log, "attempt one\n");
    failLongJob(base, "durable-audit", 1, "first failure", 17);
    let audit = "";
    expect(() => rearmWholeCommand(base, "durable-audit", undefined, () => false, (path) => { audit = path; throw new Error("crash-after-audit"); })).toThrow("crash-after-audit");
    expect(readLongJob(base, "durable-audit")).toMatchObject({ state: "FAILED", attempt: 1 });
    const archivedLog = readFileSync(join(audit, "job.log"), "utf8");
    const second = rearmWholeCommand(base, "durable-audit", undefined, () => false);
    expect(second).toMatchObject({ state: "ARMED", attempt: 2, command_digest: first.command_digest, cwd_identity: first.cwd_identity });
    startLongJob(base, "durable-audit");
    writeFileSync(first.paths.log, "attempt two\n");
    failLongJob(base, "durable-audit", 2, "second failure", 18);
    expect(readFileSync(join(audit, "job.log"), "utf8")).toBe(archivedLog);
    expect(archivedLog).toBe("attempt one\n");
  });

  test("an existing attempt audit must match exactly and temp residue blocks recovery", () => {
    const base = root();
    const mismatched = arm(base, "mismatched-audit"); startLongJob(base, "mismatched-audit"); failLongJob(base, "mismatched-audit", 1, "failed");
    let audit = "";
    expect(() => rearmWholeCommand(base, "mismatched-audit", undefined, () => false, (path) => { audit = path; throw new Error("stop"); })).toThrow("stop");
    writeFileSync(join(audit, "job.log"), "tampered archive\n");
    expect(() => rearmWholeCommand(base, "mismatched-audit", undefined, () => false)).toThrow("existing attempt audit differs");

    const residue = arm(base, "temp-residue"); startLongJob(base, "temp-residue"); failLongJob(base, "temp-residue", 1, "failed");
    mkdirSync(join(base, "temp-residue", "attempt-audits"));
    mkdirSync(join(base, "temp-residue", "attempt-audits", ".attempt-000001.tmp-crash"));
    expect(() => rearmWholeCommand(base, "temp-residue", undefined, () => false)).toThrow("temp residue");
    expect(residue.command_digest).toBe(readLongJob(base, "temp-residue").command_digest);
  });

  test("cwd identity swap, reparse artifact, and legacy v1 ledger fail closed", () => {
    const base = root();
    const other = root();
    const swapped = arm(base, "cwd-swapped"); startLongJob(base, "cwd-swapped"); failLongJob(base, "cwd-swapped", 1, "failed");
    const raw = JSON.parse(readFileSync(swapped.paths.record, "utf8"));
    raw.cwd = other;
    writeFileSync(swapped.paths.record, JSON.stringify(raw));
    expect(() => rearmWholeCommand(base, "cwd-swapped", undefined, () => false)).toThrow("canonical identity mismatch");

    const cwdLinked = arm(base, "cwd-linked"); startLongJob(base, "cwd-linked"); failLongJob(base, "cwd-linked", 1, "failed");
    const cwdLink = join(base, "cwd-reparse");
    symlinkSync(other, cwdLink, process.platform === "win32" ? "junction" : "dir");
    const cwdRaw = JSON.parse(readFileSync(cwdLinked.paths.record, "utf8"));
    cwdRaw.cwd = cwdLink;
    writeFileSync(cwdLinked.paths.record, JSON.stringify(cwdRaw));
    try { expect(() => rearmWholeCommand(base, "cwd-linked", undefined, () => false)).toThrow("normal directory"); }
    finally { if (existsSync(cwdLink)) unlinkSync(cwdLink); }

    const linked = arm(base, "linked-log"); startLongJob(base, "linked-log"); failLongJob(base, "linked-log", 1, "failed");
    unlinkSync(linked.paths.log);
    symlinkSync(other, linked.paths.log, process.platform === "win32" ? "junction" : "dir");
    try { expect(() => rearmWholeCommand(base, "linked-log", undefined, () => false)).toThrow("symlink/reparse"); }
    finally { if (existsSync(linked.paths.log)) unlinkSync(linked.paths.log); }

    const legacy = arm(base, "legacy-v1");
    const legacyRaw = JSON.parse(readFileSync(legacy.paths.record, "utf8"));
    legacyRaw.version = 1;
    delete legacyRaw.cwd_identity;
    writeFileSync(legacy.paths.record, JSON.stringify(legacyRaw));
    expect(recoverLongJobs(base)).toContainEqual(expect.objectContaining({ job_id: "legacy-v1", action: "BLOCK_LEDGER_PATH", reason: expect.stringContaining("owner-reviewed migration") }));
  });

  test("failure ledger preserves the exact child exit code", () => {
    const base = root();
    const record = arm(base, "exit-127"); startLongJob(base, "exit-127");
    expect(failLongJob(base, "exit-127", 1, "missing executable", 127)).toMatchObject({ failure: { exit_code: 127 } });
    expect(JSON.parse(readFileSync(record.paths.exit, "utf8"))).toMatchObject({ attempt: 1, exit_code: 127 });
  });

  test("session-resume scan makes an ARMED-only job actionable instead of abandoning it", () => {
    const base = root();
    arm(base, "forgotten-broker");
    expect(recoverLongJobs(base)).toEqual([{
      job_id: "forgotten-broker",
      attempt: 1,
      action: "START_BROKER",
      reason: "armed-without-broker-confirmation",
    }]);
  });

  test("a live broker owns ARMED queue work while a second lock claimant fails safely", () => {
    const base = root();
    arm(base, "queued");
    const owner = claimBrokerLock(base);
    expect(recoverLongJobs(base)).toEqual([]);
    expect(brokerLaunchDirective(base, "runner.ts")).toMatchObject({ broker_already_live: true, do_not_launch: true, broker_cmd: "" });
    expect(() => claimBrokerLock(base, (pid) => pid === owner.pid)).toThrow("already running");
    releaseBrokerLock(base, owner);
    expect(recoverLongJobs(base)).toContainEqual(expect.objectContaining({ job_id: "queued", action: "START_BROKER" }));
  });

  test("broker owner unlink followed by lock release is observed as absent, not stable corruption", async () => {
    const base = root();
    const owner = claimBrokerLock(base);
    const pathGuardUrl = new URL("./guard/path_guard.ts", import.meta.url).href;
    const ownerPath = join(brokerLockPath(base), "owner.json");
    const releaser = Bun.spawn([
      process.execPath,
      "-e",
      `import { unlinkSync, rmdirSync } from ${JSON.stringify(pathGuardUrl)}; unlinkSync(${JSON.stringify(ownerPath)}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); rmdirSync(${JSON.stringify(brokerLockPath(base))});`,
    ], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    expect(owner.nonce).toBeTruthy();
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 2_000;
    while (existsSync(ownerPath) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 1);
    expect(existsSync(ownerPath)).toBe(false);
    expect(inspectBrokerLock(base)).toEqual({ state: "absent" });
    expect(await releaser.exited, await new Response(releaser.stderr as ReadableStream<Uint8Array>).text()).toBe(0);
    const successor = claimBrokerLock(base);
    releaseBrokerLock(base, successor);
  });

  test("wake owner publish has no mkdir-owner crash gap and stale reclaim is exact", () => {
    const base = root();
    expect(() => claimWakeLock(base, () => false, undefined, () => { throw new Error("crash-after-temp-mkdir"); })).toThrow();
    expect(inspectWakeLock(base)).toEqual({ state: "absent" });
    expect(existsSync(wakeLockPath(base))).toBe(false);

    const first = claimWakeLock(base);
    writeFileSync(join(wakeLockPath(base), "owner.json"), JSON.stringify({ ...first, pid: 2_000_000_000 }));
    const second = claimWakeLock(base, () => false);
    expect(second.nonce).not.toBe(first.nonce);
    releaseWakeLock(base, second);
  });

  test("invalid wake lock is a recovery BLOCK and is never guessed stale", () => {
    const base = root();
    mkdirSync(wakeLockPath(base));
    expect(recoverLongJobs(base)).toContainEqual(expect.objectContaining({ job_id: ".wake.lock", action: "BLOCK_WAKE_LOCK" }));
    expect(() => claimWakeLock(base, () => false)).toThrow("blocked");
  });

  test("owner unlink followed by lock release is observed as absent, not stable corruption", async () => {
    const base = root();
    const owner = claimWakeLock(base);
    const pathGuardUrl = new URL("./guard/path_guard.ts", import.meta.url).href;
    const releaser = Bun.spawn([
      process.execPath,
      "-e",
      `import { unlinkSync, rmdirSync } from ${JSON.stringify(pathGuardUrl)}; unlinkSync(${JSON.stringify(join(wakeLockPath(base), "owner.json"))}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2); rmdirSync(${JSON.stringify(wakeLockPath(base))});`,
    ], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
    expect(owner.nonce).toBeTruthy();
    const ownerPath = join(wakeLockPath(base), "owner.json");
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 2_000;
    while (existsSync(ownerPath) && Date.now() < deadline) Atomics.wait(pause, 0, 0, 1);
    expect(existsSync(ownerPath)).toBe(false);
    expect(inspectWakeLock(base)).toEqual({ state: "absent" });
    expect(await releaser.exited, await new Response(releaser.stderr as ReadableStream<Uint8Array>).text()).toBe(0);
    const successor = claimWakeLock(base);
    releaseWakeLock(base, successor);
  });

  test("broker reclaims an exact stale dead-PID owner record and completes queued work", async () => {
    const base = root();
    arm(base, "stale-owner-job");
    const owner = claimBrokerLock(base);
    const ownerPath = join(brokerLockPath(base), "owner.json");
    writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 999999 }));
    expect(recoverLongJobs(base)).toContainEqual(expect.objectContaining({ job_id: "stale-owner-job", action: "START_BROKER", reason: "stale-broker-owner" }));
    const result = await runLongJobBroker({
      root: base,
      isAlive: () => false,
      notify: () => {},
      execute: async (jobId) => {
        const running = startLongJob(base, jobId, undefined, 999999);
        finishLongJob(base, jobId, running.attempt, { ok: true });
        return 0;
      },
    });
    expect(result).toEqual({ completed: 1, wake_count: 1 });
    expect(readLongJob(base, "stale-owner-job").state).toBe("FINISHED");
  });

  test("provider caps queue excess work and later scans make it eligible", () => {
    const base = root();
    arm(base, "a"); arm(base, "b"); arm(base, "c", "claude-headless");
    startLongJob(base, "a");
    expect(dequeueArmedJobs(base, { "codex-exec": 1, "claude-headless": 1 }).map((record) => record.job_id)).toEqual(["c"]);
    finishLongJob(base, "a", 1, { ok: true });
    expect(dequeueArmedJobs(base, { "codex-exec": 1, "claude-headless": 1 }).map((record) => record.job_id)).toEqual(["b", "c"]);
  });

  test("single-flight broker transports five completions as one wake", async () => {
    const base = root();
    for (let i = 1; i <= 5; i++) arm(base, `broker-${i}`);
    let transportCalls = 0;
    const result = await runLongJobBroker({
      root: base,
      notify: () => { transportCalls++; },
      execute: async (jobId) => {
        const running = startLongJob(base, jobId, undefined, 999999);
        finishLongJob(base, jobId, running.attempt, { ok: true });
        return 0;
      },
    });
    expect(result).toEqual({ completed: 5, wake_count: 1 });
    expect(transportCalls).toBe(1);
    expect(drainLongJobs(base, () => {})).toEqual({ acked: 5, passes: 1 });
  });

  test("broker drains four finishes, then recovers and ACKs the failed whole command on attempt two", async () => {
    const base = root();
    for (let i = 1; i <= 5; i++) arm(base, `settled-${i}`);
    let transportCalls = 0;
    const result = await runLongJobBroker({
      root: base,
      notify: () => { transportCalls++; },
      execute: async (jobId) => {
        if (jobId === "settled-3") throw new Error("synthetic spawn failure");
        const running = startLongJob(base, jobId, undefined, 999999);
        finishLongJob(base, jobId, running.attempt, { ok: true });
        return 0;
      },
    });
    expect(result).toEqual({ completed: 5, wake_count: 1 });
    expect(transportCalls).toBe(1);
    expect(readLongJob(base, "settled-3").state).toBe("FAILED");
    expect([1, 2, 4, 5].map((i) => readLongJob(base, `settled-${i}`).state)).toEqual(["FINISHED", "FINISHED", "FINISHED", "FINISHED"]);
    expect(drainLongJobs(base, () => {})).toEqual({ acked: 4, passes: 1 });
    expect(readLongJob(base, "settled-3").state).toBe("FAILED");
    expect(JSON.parse(readFileSync(join(base, "wake-pending.json"), "utf8"))).toMatchObject({
      pending: 1,
      recovery: [{ job_id: "settled-3", attempt: 1, action: "RERUN_WHOLE_COMMAND", reason: "failed" }],
    });
    expect(recoverLongJobs(base)).toContainEqual({ job_id: "settled-3", attempt: 1, action: "RERUN_WHOLE_COMMAND", reason: "failed" });
    expect(() => acknowledgeLongJob(base, "settled-3", 1)).toThrow("FINISHED");
    expect(rearmWholeCommand(base, "settled-3", undefined, () => false)).toMatchObject({ state: "ARMED", attempt: 2 });

    const retry = await runLongJobBroker({
      root: base,
      notify: () => {},
      execute: async (jobId) => {
        const running = startLongJob(base, jobId, undefined, 999999);
        finishLongJob(base, jobId, running.attempt, { ok: true });
        return 0;
      },
    });
    expect(retry).toEqual({ completed: 1, wake_count: 1 });
    expect(readLongJob(base, "settled-3")).toMatchObject({ state: "FINISHED", attempt: 2 });
    expect(drainLongJobs(base, () => {})).toEqual({ acked: 1, passes: 1 });
    expect(readLongJob(base, "settled-3")).toMatchObject({ state: "ACKED", attempt: 2 });
    expect(JSON.parse(readFileSync(join(base, "wake-pending.json"), "utf8"))).toMatchObject({ pending: 0, recovery: [] });
  }, 15_000);

  test("broker fails an execute callback that returns without a terminal state", async () => {
    const base = root(); arm(base, "nonterminal");
    const result = await runLongJobBroker({ root: base, execute: async () => 0, notify: () => {} });
    expect(result).toEqual({ completed: 1, wake_count: 1 });
    expect(readLongJob(base, "nonterminal")).toMatchObject({ state: "FAILED", failure: { reason: "runner returned without a terminal ledger state" } });
  });

  test("broker double-scan picks a job armed at its close boundary", async () => {
    const base = root(); arm(base, "early");
    let lateArmed = false;
    let lateDirective: Record<string, unknown> = {};
    let transportCalls = 0;
    const result = await runLongJobBroker({
      root: base,
      closeDebounceMs: 1,
      beforeClose: () => { if (!lateArmed) { arm(base, "late"); lateDirective = brokerLaunchDirective(base); lateArmed = true; } },
      execute: async (jobId) => {
        const running = startLongJob(base, jobId, undefined, 999999);
        finishLongJob(base, jobId, running.attempt, { ok: true });
        return 0;
      },
      notify: () => { transportCalls++; },
    });
    expect(result).toEqual({ completed: 2, wake_count: 1 });
    expect(readLongJob(base, "late").state).toBe("FINISHED");
    expect(lateDirective).toMatchObject({ broker_already_live: true, do_not_launch: true, broker_cmd: "" });
    expect(transportCalls).toBe(1);
  });

  test("an arm after the final scan hands off to one successor without waiting for startup scan", async () => {
    const base = root(); arm(base, "old-owner-job");
    let successor: Promise<{ completed: number; wake_count: number }> | undefined;
    let directive: Record<string, unknown> = {};
    let duplicateDirective: Record<string, unknown> = {};
    let transportCalls = 0;
    const execute = async (jobId: string) => {
      const running = startLongJob(base, jobId, undefined, 999999);
      finishLongJob(base, jobId, running.attempt, { ok: true });
      return 0;
    };
    const first = await runLongJobBroker({
      root: base,
      closeDebounceMs: 1,
      execute,
      notify: () => { transportCalls++; },
      afterFinalScan: () => {
        arm(base, "handoff-job");
        directive = brokerLaunchDirective(base);
        duplicateDirective = brokerLaunchDirective(base);
        successor = runLongJobBroker({ root: base, execute, notify: () => { transportCalls++; }, handoffWaitMs: 2_000 });
      },
    });
    expect(first).toEqual({ completed: 1, wake_count: 1 });
    expect(directive).toMatchObject({ broker_closing: true, handoff_requested: true, do_not_launch: false });
    expect(duplicateDirective).toMatchObject({ broker_closing: true, handoff_requested: false, do_not_launch: true });
    expect(await successor!).toEqual({ completed: 1, wake_count: 1 });
    expect(readLongJob(base, "handoff-job").state).toBe("FINISHED");
    expect(transportCalls).toBe(2);
  });

  test("lost wake lease re-emits and malformed wake-unarmed records block startup", () => {
    const base = root();
    const record = arm(base, "lease"); startLongJob(base, "lease"); finishLongJob(base, "lease", 1, { ok: true });
    expect(coalesceCompletionWake(base, "2026-01-01T00:00:00.000Z", 1_000).emitted).toBe(true);
    expect(coalesceCompletionWake(base, "2026-01-01T00:00:00.500Z", 1_000).emitted).toBe(false);
    expect(coalesceCompletionWake(base, "2026-01-01T00:00:02.000Z", 1_000).emitted).toBe(true);
    const raw = JSON.parse(readFileSync(record.paths.record, "utf8"));
    raw.wake.armed = false;
    writeFileSync(record.paths.record, JSON.stringify(raw));
    expect(recoverLongJobs(base)).toContainEqual(expect.objectContaining({ job_id: "lease", action: "BLOCK_WAKE_UNARMED" }));
  });

  test("live orphan blocks recovery; dead/lost process permits one new attempt", () => {
    const base = root();
    arm(base, "orphan"); startLongJob(base, "orphan", "2020-01-01T00:00:00.000Z", 4567);
    expect(() => rearmWholeCommand(base, "orphan", undefined, (pid) => pid === 4567)).toThrow("live orphan");
    expect(rearmWholeCommand(base, "orphan", undefined, () => false).attempt).toBe(2);
  });
});
