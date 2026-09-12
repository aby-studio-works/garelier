import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { rmSync, unlinkSync } from "./guard/path_guard.ts";
import { acknowledgeLongJob, armLongJob, classifyRunningLongJob, coalesceCompletionWake, drainLongJobs, finishLongJob, listLongJobs, readLongJob, recoverLongJobs, recordLongJobChildPid, startLongJob, type LongJobRecord } from "./long_jobs.ts";
import { matchesOwnedChild, observeLongJobProcess, ownedChildIdentity, type LongJobProcessObservation, type OwnedChildBinding } from "./long_job_process_identity.ts";
import { awaitTransportSettlement, launchOwnedLongJob, main } from "./scripts/long_job_runner.ts";

const COMMAND = "bun some_whole_gate_command.ts --project .\n";
const scratch: string[] = [];
interface OwnedFixture {
  child: Bun.Subprocess;
  record: LongJobRecord;
  paths: string[];
  commandPidFile?: string;
  noCommand: () => boolean;
  release: () => void;
  confirmed: boolean;
  wrapperExited: boolean;
  commandPid?: number;
  cleanup?: Promise<void>;
}
const owned: OwnedFixture[] = [];
// The per-hook list may be drained while a timed-out test's finally is still
// pending. Its child handle retains this registration and the SAME promise.
const ownership = new WeakMap<Bun.Subprocess, OwnedFixture>();
const qualified = new Set<string>();
const runner = resolve(import.meta.dir, "scripts/long_job_runner.ts");
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const phase = (label: string, event: string) => console.log(`W776_PHASE ts=${Date.now()} case=${label} event=${event}`);
// W-788 (4): the registration count is held at seven by contract, so several
// independent scenarios share one registration name and a failure anywhere in a
// registration used to report under a name describing none of it. `step` names
// the running scenario and prefixes it onto the failure message, so a red run
// localizes in one line. It adds no registration, no assertion and no wait.
async function step<T>(name: string, body: () => T | Promise<T>): Promise<T> {
  phase(name, "step-begin");
  try {
    const value = await body();
    phase(name, "step-ok");
    return value;
  } catch (error) {
    if (error instanceof Error) error.message = `[step ${name}] ${error.message}`;
    phase(name, "step-failed");
    throw error;
  }
}
// Diagnostic only: callback signal is authoritative for that callback; the
// awaited path's signalCode is labelled as a getter sample, never identity proof.
function exitTrace(event: string, child: Bun.Subprocess, exitCode: number | null, signal: string | number | null) {
  try {
    console.log(`W776_EXIT ${JSON.stringify({ ts: Date.now(), event, wrapper_pid: child.pid, exit_code: exitCode, signal })}`);
  } catch { /* diagnostic logging must not throw from onExit */ }
}
// exec removes the shell intermediary; these authored scripts spawn no children.
function fixtureCommand(cwd: string, body: string): string {
  const tracePath = join(cwd, "command-trace.jsonl");
  const trace = `const started=Date.now();const trace=(event,exit_code=null)=>fs.appendFileSync(${JSON.stringify(tracePath)},JSON.stringify({ts:Date.now(),started,event,pid:process.pid,ppid:process.ppid,exit_code})+'\\n');trace('start');process.on('exit',code=>trace('exit-before',code));`;
  const code = `const fs=require('fs');${trace}fs.writeFileSync(${JSON.stringify(join(cwd, "command.pid"))},String(process.pid));trace('pid-write-complete');${body}`;
  const script = join(cwd, "command.cjs");
  writeFileSync(script, `${code}\n`, "utf8");
  return `exec ${quote(process.execPath.replaceAll("\\", "/"))} ${quote(script.replaceAll("\\", "/"))}\n`;
}

function scratchDir(label: string): string {
  const base = join(process.cwd(), "__garelier", "_workshop", "showcase", "w776-owned-identity");
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, `garelier-ledger-${label}-`));
  scratch.push(path);
  return path;
}
function fixture(label: string): { root: string; cwd: string } {
  return { root: join(scratchDir(`${label}-home`), "long_jobs"), cwd: scratchDir(`${label}-cwd`) };
}
function armWithPayloadDirectory(root: string, cwd: string, jobId: string, command = COMMAND): { record: LongJobRecord; commandRef: string } {
  mkdirSync(join(root, "commands"), { recursive: true });
  const commandRef = join(root, "commands", `${jobId}.cmd`);
  writeFileSync(commandRef, command);
  const record = armLongJob({ root, jobId, command, commandRef, dispatchId: "355", agentId: `${jobId}-agent`,
    provider: "operator-background", cwd, wake: { armed: true, capability: "monitor", source: "ledger-denominator-test" } });
  return { record, commandRef };
}
function own(child: Bun.Subprocess, record: LongJobRecord, commandPidFile: string | undefined, noCommand: () => boolean, release = () => {}) {
  if (ownership.has(child)) throw new Error(`W-776 duplicate ownership PID ${child.pid}`);
  const item: OwnedFixture = { child, record, paths: [...scratch], commandPidFile, noCommand, release, confirmed: false, wrapperExited: false };
  ownership.set(child, item);
  owned.push(item);
  // Observe the existing promise; no new wait/deadline or acceptance condition.
  void child.exited.then((code) => exitTrace("owned-exited-promise-signal-getter", child, code, child.signalCode)).catch(() => { /* original awaited promise still propagates failure */ });
}
function cleanup(child: Bun.Subprocess): Promise<void> {
  const item = ownership.get(child);
  if (!item) throw new Error(`W-776 unregistered cleanup PID ${child.pid}`);
  if (item.cleanup) return item.cleanup; // no second deadline/attempt
  item.cleanup = (async () => {
    phase(item.record.job_id, "cleanup-begin");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      item.release();
      if (item.noCommand()) {
        try { child.disconnect(); } catch { /* already disconnected */ }
      }
      await Promise.race([child.exited.then((code) => { exitTrace("cleanup-awaited-exited-signal-getter", child, code, child.signalCode); item.wrapperExited = true; }), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("W-776 owned termination unconfirmed within cleanup deadline")), 1000);
      })]);
      const pidSampleAt = Date.now();
      const pidFileExists = item.commandPidFile ? existsSync(item.commandPidFile) : false;
      console.log(`W776_PID_FILE ${JSON.stringify({ ts: pidSampleAt, sampled_at_end: Date.now(), wrapper_pid: child.pid,
        path: item.commandPidFile ?? null, exists: pidFileExists, command_identity: "unknown" })}`);
      if (item.commandPidFile && pidFileExists) {
        item.commandPid = Number(readFileSync(item.commandPidFile, "utf8"));
        if (!Number.isSafeInteger(item.commandPid) || item.commandPid! < 1) throw new Error("W-776 invalid fixture command PID");
        // These authored commands exec Bun code that spawns no children.
        // Wrapper exit alone is never this proof; unknown/reused PIDs preserve.
        let absent = false;
        const presenceAt = Date.now();
        let presenceError: string | undefined;
        try { process.kill(item.commandPid!, 0); }
        catch (error) { presenceError = (error as NodeJS.ErrnoException).code; absent = presenceError === "ESRCH"; }
        // Reuse this existing OS presence sample; no extra native identity probe.
        console.log(`W776_PID_PRESENCE ${JSON.stringify({ ts: presenceAt, sampled_at_end: Date.now(), wrapper_pid: child.pid,
          command_pid: item.commandPid, error_code: presenceError ?? null, absent, identity: "unknown", diagnostic_only: true })}`);
        if (!absent) throw new Error("W-776 fixture command termination unconfirmed");
      } else if (!item.noCommand()) throw new Error("W-776 missing fixture command termination evidence");
      item.confirmed = true;
      phase(item.record.job_id, "cleanup-confirmed");
    } catch (error) {
      const evidence = { wrapper_pid: child.pid, wrapper_exited: item.wrapperExited, command_pid: item.commandPid ?? null,
        command_pid_file: item.commandPidFile ?? null, job: item.record.job_id, attempt: item.record.attempt,
        cwd: item.record.cwd, command_ref: item.record.command_ref, digest: item.record.command_digest,
        preserved_paths: item.paths, reason: String(error) };
      console.error(`W776_CLEANUP_UNCONFIRMED ${JSON.stringify(evidence)}`);
      writeFileSync(join(item.paths[0]!, `cleanup-unconfirmed-${child.pid}.json`), JSON.stringify(evidence, null, 2));
      throw error;
    } finally { clearTimeout(timer); }
  })();
  return item.cleanup;
}

/** Real inherited IPC negatives. Only the ACK is modelled/corrupted; native
 * identity, wrapper state machine, publisher and command are actual code. */
async function handshakeBoundary(mode: "nonce" | "attempt" | "preloss" | "publication" | "postloss") {
  phase(mode, "begin");
  const { root, cwd } = fixture(mode);
  const marker = join(cwd, "reached");
  const commandPidFile = join(cwd, "command.pid");
  const command = fixtureCommand(cwd, `fs.appendFileSync(${JSON.stringify(marker)},'x');process.stdout.write('OUT\\n');process.stderr.write('ERR\\n');process.exit(7);`);
  const { commandRef } = armWithPayloadDirectory(root, cwd, "boundary", command);
  const started = startLongJob(root, "boundary", undefined, 900_104);
  let binding: OwnedChildBinding;
  let probeReceived = false;
  let ready = false;
  let accepted = false;
  let ackSent = false;
  let publicationFailed = false;
  let callbackError: unknown;
  const logFd = openSync(started.paths.log, "a");
  const logClose: { attempted: boolean; failure?: { error: unknown } } = { attempted: false };
  const closeLog = () => {
    if (logClose.attempted) return; // never retry a possibly reused descriptor
    logClose.attempted = true;
    try { closeSync(logFd); }
    catch (error) { logClose.failure = { error }; } // onExit must not throw
  };
  let child: Bun.Subprocess;
  try {
    child = Bun.spawn([process.execPath, runner, "--owned-child"], {
      cwd, stdin: "ignore", stdout: logFd, stderr: logFd, windowsHide: true,
      ipc(message, endpoint) {
        try {
          if (!probeReceived) {
            expect(message).toEqual({ type: "probe", version: 1 });
            expect(endpoint.pid).toBe(binding.pid);
            probeReceived = true;
            endpoint.send({ type: "init", binding });
            return;
          }
          expect(matchesOwnedChild(message.binding, binding)).toBe(true);
          if (message.type === "ready") {
            phase(mode, "ready");
            expect(ready).toBe(false);
            ready = true;
            expect(ownedChildIdentity(message.identity, child.pid)).toBe(true);
            expect(existsSync(marker)).toBe(false); // no command before permission
            expect(matchesOwnedChild({ ...binding, nonce: "0".repeat(64) }, binding)).toBe(false);
            expect(matchesOwnedChild({ ...binding, attempt: binding.attempt + 1 }, binding)).toBe(false);
            if (mode === "preloss") { endpoint.disconnect(); return; }
            if (mode === "nonce" || mode === "attempt") {
              endpoint.send({ type: "ack", binding: { ...binding, ...(mode === "nonce" ? { nonce: "0".repeat(64) } : { attempt: binding.attempt + 1 }) } });
              return;
            }
            if (mode === "publication") unlinkSync(commandRef);
            try {
              const published = recordLongJobChildPid(root, "boundary", 1, endpoint.pid, message.identity, binding.digest);
              expect(published.runtime?.runner_identity).toEqual(started.runtime?.runner_identity);
            } catch (error) {
              if (mode !== "publication") throw error;
              publicationFailed = true;
              endpoint.disconnect();
              return;
            }
            ackSent = true; // delivery may succeed even if send throws
            endpoint.send({ type: "ack", binding });
          } else if (message.type === "accepted") {
            phase(mode, "accepted");
            accepted = true;
            endpoint.send({ type: "ack", binding }); // never a second spawn
            endpoint.disconnect(); // after wrapper authorization, not before it
          }
        } catch (error) { callbackError = error; endpoint.disconnect(); }
      },
      onExit(endpoint, code, signal) {
        closeLog();
        exitTrace("onExit", endpoint, code, signal);
      },
    });
  } catch (error) {
    closeLog();
    if (logClose.failure) throw new AggregateError([error, logClose.failure.error], "spawn and log close failed");
    throw error;
  }
  binding = { version: 1, root: resolve(root), job: "boundary", attempt: 1, digest: started.command_digest,
    nonce: randomBytes(32).toString("hex"), pid: child.pid };
  own(child, started, commandPidFile, () => !ackSent);
  try {
    const exit = await child.exited;
    exitTrace("handshake-awaited-exited-signal-getter", child, exit, child.signalCode);
    closeLog();
    phase(mode, "exited");
    if (logClose.failure) throw logClose.failure.error;
    if (mode === "publication") writeFileSync(commandRef, command);
    if (callbackError) throw callbackError;
    expect(ready).toBe(true);
    expect(accepted).toBe(mode === "postloss");
    if (mode === "postloss") {
      expect(exit).toBe(7);
      expect(readFileSync(marker, "utf8")).toBe("x");
      const log = readFileSync(started.paths.log, "utf8");
      expect(log).toContain("OUT\n");
      expect(log).toContain("ERR\n");
      expect(readLongJob(root, "boundary").state).toBe("RUNNING");
      expect(existsSync(started.paths.result)).toBe(false); // no parent receipt
    } else {
      expect(exit).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      expect(readLongJob(root, "boundary").runtime?.child_identity).toBeUndefined();
    }
    if (mode === "publication") expect(publicationFailed).toBe(true);
  } finally {
    try { child.disconnect(); } catch { /* already closed */ }
    await cleanup(child);
  }
  qualified.add(mode);
  phase(mode, "qualified");
}

afterEach(async () => {
  const outcomes = await Promise.allSettled(owned.map((item) => cleanup(item.child)));
  const preserved = new Set(owned.filter((item) => !item.confirmed).flatMap((item) => item.paths));
  for (const path of scratch.splice(0)) if (!preserved.has(path)) rmSync(path, { recursive: true, force: true });
  owned.splice(0); // ownership survives for late finally; never restart cleanup
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
});

describe("long-job ledger denominator", () => {
  test("a command payload directory accepted by arm does not become a job", async () => {
    const registrationDeadline = Date.now() + 5000;
    phase("registration-1", "begin");
    await step("payload-directory", () => {
      const { root, cwd } = fixture("payload");
      const { record } = armWithPayloadDirectory(root, cwd, "gate-run");
      expect(listLongJobs(root).map((job) => job.job_id)).toEqual(["gate-run"]);
      expect(record.state).toBe("ARMED");
      const actions = recoverLongJobs(root);
      expect(actions.map((action) => action.job_id)).not.toContain("commands");
      expect(actions.filter((action) => action.action.startsWith("BLOCK_"))).toEqual([]);
    });
    // W-788 (3): production completion settles the private channel under a
    // BOUNDED wait instead of an unbounded Promise.all, so a disconnect that
    // never fires can no longer leave the job RUNNING forever. The real-launch
    // registrations exercise the "settled" branch through launchOwnedLongJob;
    // the expiry branch must report typed unknown rather than hang.
    await step("transport-settlement-deadline", async () => {
      // The bound itself: a resolved disconnect settles, a disconnect that never
      // fires expires through the real timer.
      expect(await awaitTransportSettlement(Promise.resolve())).toBe("settled");
      expect(await awaitTransportSettlement(new Promise<void>(() => { /* onDisconnect never fires */ }), 1)).toBe("unknown");
      // The PRODUCTION seam. Proving the helper alone is not enough: restoring
      // the old unbounded `Promise.all` in `launchOwnedLongJob` would leave the
      // two assertions above GREEN while the job hung forever. So the real
      // completion path runs here with a settlement that reports unknown, and
      // must publish a typed unknown terminal instead of waiting. Substituting
      // the settlement is the same deterministic-edge seam as
      // `classifyRunningLongJob`'s `observe`; the default is the production
      // function and no timeout value is introduced.
      const stuck = fixture("settlement-unknown");
      const armed = armWithPayloadDirectory(stuck.root, stuck.cwd, "settlement-unknown",
        fixtureCommand(stuck.cwd, "process.stdout.write('EXACT\\n');process.exit(7);"));
      const run = launchOwnedLongJob(stuck.root, "settlement-unknown", async () => "unknown");
      own(run.child, armed.record, join(stuck.cwd, "command.pid"), () => false);
      try {
        expect(await run.publication).toBe(true);
        expect(await run.completion).toBe(7);
        const failed = readLongJob(stuck.root, "settlement-unknown");
        expect(failed.state).toBe("FAILED"); // never left RUNNING
        expect(failed.failure?.reason).toBe(
          "owned child transport settlement unknown: disconnect deadline; wrapper exit 7; verify before any audited rearm");
        expect(failed.failure?.exit_code).toBe(7);
        expect(readFileSync(armed.record.paths.log, "utf8")).toBe("EXACT\n");
      } finally { await cleanup(run.child); }
    });
    // Real launchOwnedLongJob counterfactual: command starts, private channel
    // closes, then the owned wrapper exits zero without terminal IPC.
    await step("missing-terminal", async () => {
      const actual = fixture("missing-terminal");
      const release = join(actual.cwd, "release");
      const commandPidFile = join(actual.cwd, "command.pid");
      const body = `const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(0)}},10);setTimeout(()=>process.exit(8),10000);`;
      const armed = armWithPayloadDirectory(actual.root, actual.cwd, "missing-terminal", fixtureCommand(actual.cwd, body));
      const run = launchOwnedLongJob(actual.root, "missing-terminal");
      let cleanupStarted = false;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      own(run.child, armed.record, commandPidFile, () => false, () => { cleanupStarted = true; writeFileSync(release, "release"); });
      try {
        expect(await run.publication).toBe(true);
        phase("missing-terminal", "published");
        phase("missing-terminal", "preparation");
        while (!existsSync(commandPidFile) && Date.now() < registrationDeadline) await new Promise((done) => setTimeout(done, 10));
        expect(existsSync(commandPidFile)).toBe(true);
        phase("missing-terminal", "command-reached");
        expect(cleanupStarted).toBe(false);
        expect(Date.now()).toBeLessThan(registrationDeadline);
        // Preparation uses normal ACK/loader/Git Bash. The old 1s allowance now
        // measures failure response, inside the SAME absolute 5s registration.
        const responseDeadline = Math.min(registrationDeadline, Date.now() + 1000);
        phase("missing-terminal", "disconnect");
        run.child.disconnect(); // after command reachability, before release
        writeFileSync(release, "release");
        phase("missing-terminal", "released");
        const returned = await Promise.race([run.completion, new Promise<never>((_, reject) => {
          responseTimer = setTimeout(() => reject(new Error("W-776 terminal response exceeded original 1s/registration deadline")), Math.max(0, responseDeadline - Date.now()));
        })]);
        clearTimeout(responseTimer);
        expect(Date.now()).toBeLessThan(responseDeadline);
        expect(cleanupStarted).toBe(false);
        phase("missing-terminal", "completed");
        expect(await run.child.exited).toBe(0);
        const failed = readLongJob(actual.root, "missing-terminal");
        expect(failed.state).toBe("FAILED");
        const failure = failed.failure;
        if (!failure) throw new Error("W-776 FAILED record missing failure evidence");
        expect(failure.reason).toContain("no matching terminal IPC");
        expect(failure.reason).toBe("owned child execution unconfirmed; no matching terminal IPC; wrapper exit 0; verify before any audited rearm");
        expect(failure.exit_code).toBe(2);
        expect(returned).toBe(failure.exit_code);
        expect(returned).not.toBe(0);
      } finally { clearTimeout(responseTimer); await cleanup(run.child); }
      expect(Date.now()).toBeLessThan(registrationDeadline);
      qualified.add("missing-terminal");
    });
  });

  test("a directory holding job artifacts but no record.json still BLOCKs", async () => {
    const registrationDeadline = Date.now() + 5000;
    phase("registration-2", "begin");
    const { root, cwd } = fixture("corrupt");
    await step("lost-record", () => {
      armWithPayloadDirectory(root, cwd, "gate-run");
      mkdirSync(join(root, "lost-record"), { recursive: true });
      writeFileSync(join(root, "lost-record", "job.log"), "partial output\n");
      const blocked = recoverLongJobs(root).filter((action) => action.job_id === "lost-record");
      expect(blocked.map((action) => action.action)).toEqual(["BLOCK_WAKE_UNARMED"]);
    });
    await step("handshake-nonce", () => handshakeBoundary("nonce"));
    await step("no-ipc", async () => {
      const stderrPath = join(cwd, "no-ipc-stderr.log");
      let cleanupStarted = false;
      let captureExit!: (value: { code: number | null; signal: string | number | null; at: number }) => void;
      const callbackExit = new Promise<{ code: number | null; signal: string | number | null; at: number }>((done) => { captureExit = done; });
      const child = Bun.spawn([process.execPath, runner, "--owned-child", "--root", root, "--job", "gate-run", "--nonce", "0".repeat(64)],
        { cwd, stdin: "ignore", stdout: "ignore", stderr: Bun.file(stderrPath), windowsHide: true,
          onExit(endpoint, code, signal) {
            captureExit({ code, signal, at: Date.now() });
            exitTrace("no-ipc-onExit", endpoint, code, signal);
          },
          env: { ...process.env, GARELIER_OWNED_CHILD_IPC: "true", GARELIER_OWNED_CHILD_NONCE: "0".repeat(64),
            GARELIER_OWNED_CHILD_PID: String(process.pid), GARELIER_OWNED_CHILD_ACK: "accepted",
            NODE_CHANNEL_FD: "999999", NODE_CHANNEL_SERIALIZATION_MODE: "advanced" } });
      own(child, readLongJob(root, "gate-run"), undefined, () => true, () => { cleanupStarted = true; });
      try {
        expect(await child.exited).not.toBe(0);
        const [code, callback] = await Promise.all([child.exited, callbackExit]);
        expect(code).toBe(2);
        expect(callback.code).toBe(2);
        expect(callback.signal).toBeNull();
        expect(callback.at).toBeLessThan(registrationDeadline);
        expect(Date.now()).toBeLessThan(registrationDeadline);
        expect(cleanupStarted).toBe(false);
        // The rejection evidence is these bytes, not the directory holding them.
        // Assert them here and publish them to the run log, so the owned sweep can
        // delete the scratch cwd like every other fixture.
        expect(existsSync(stderrPath)).toBe(true);
        const rejection = readFileSync(stderrPath, "utf8");
        console.log(`W776_NO_IPC_STDERR exit=${code} signal=${callback.signal} bytes=${Buffer.byteLength(rejection)} content=${JSON.stringify(rejection)}`);
        // A forged NODE_CHANNEL_FD must produce a runtime IPC-unavailability
        // notice and nothing that could be read as loading, authorization or
        // command output. Absence of authorization evidence is the assertion;
        // the exact runtime wording is not.
        expect(Buffer.byteLength(rejection)).toBeLessThan(4096);
        expect(rejection).not.toContain("AUTHORIZED");
        expect(rejection).not.toContain("W776_");
        expect(rejection).not.toContain(COMMAND.trim());
      } finally {
        await cleanup(child);
      }
      expect(readLongJob(root, "gate-run").state).toBe("ARMED");
      expect(Date.now()).toBeLessThan(registrationDeadline);
      qualified.add("no-ipc");
    });
  });

  test("an emptied payload directory is not a job", async () => {
    phase("registration-3", "begin");
    await step("drained-payloads", () => {
      const { root, cwd } = fixture("empty");
      armWithPayloadDirectory(root, cwd, "gate-run");
      mkdirSync(join(root, "drained-payloads"), { recursive: true });
      expect(recoverLongJobs(root).map((action) => action.job_id)).not.toContain("drained-payloads");
    });
    await step("drain-per-job-isolation", async () => {
      // W-788 (2): one poisoned FINISHED record must not stop the queue. The
      // poisoned job sorts first, so the old pass-wide throw aborted the drain
      // before the healthy record behind it could ever be consumed.
      const mixed = fixture("drain-isolation");
      const poison = armWithPayloadDirectory(mixed.root, mixed.cwd, "aaa-poisoned");
      const healthy = armWithPayloadDirectory(mixed.root, mixed.cwd, "zzz-healthy");
      for (const [job, pid] of [["aaa-poisoned", 900_109], ["zzz-healthy", 900_110]] as const) {
        startLongJob(mixed.root, job, undefined, pid);
        finishLongJob(mixed.root, job, 1, { ok: true });
      }
      writeFileSync(poison.record.paths.result, "{malformed");
      const consumedJobs: string[] = [];
      const summary = drainLongJobs(mixed.root, (record) => consumedJobs.push(record.job_id));
      expect(consumedJobs).toEqual(["zzz-healthy"]);
      expect(summary.acked).toBe(1);
      expect(summary.blocked.map((item) => [item.job_id, item.action])).toEqual([["aaa-poisoned", "BLOCK_LEDGER_PATH"]]);
      expect(readLongJob(mixed.root, "aaa-poisoned").state).toBe("FINISHED");
      expect(readLongJob(mixed.root, "zzz-healthy").state).toBe("ACKED");
      expect(existsSync(healthy.record.paths.ack)).toBe(true);
      expect(existsSync(poison.record.paths.ack)).toBe(false);
      // The pass no longer throws out of the CLI, so the exit code is the only
      // signal a caller that reads nothing else can see: an unresolved blocked
      // record must not be reported as a clean drain.
      expect(await main(["drain", "--root", mixed.root])).toBe(3);
      const clean = fixture("drain-clean");
      armWithPayloadDirectory(clean.root, clean.cwd, "healthy-only");
      startLongJob(clean.root, "healthy-only", undefined, 900_113);
      finishLongJob(clean.root, "healthy-only", 1, { ok: true });
      expect(await main(["drain", "--root", clean.root])).toBe(0);
      expect(readLongJob(clean.root, "healthy-only").state).toBe("ACKED");
    });
    await step("terminal-priority", () => {
      const terminal = fixture("terminal-priority");
      const armed = armWithPayloadDirectory(terminal.root, terminal.cwd, "terminal");
      const running = startLongJob(terminal.root, "terminal", undefined, 900_108);
      const completed = new Date().toISOString();
      const result = { job_id: "terminal", attempt: 1, completed_at: completed, result: { ok: true } };
      writeFileSync(armed.record.paths.result, "{malformed");
      const noProbe = () => { throw new Error("terminal must take priority over observation"); };
      expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("BLOCK_LEDGER_PATH");
      writeFileSync(armed.record.paths.result, JSON.stringify({ ...result, attempt: 2 }));
      expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("BLOCK_LEDGER_PATH");
      writeFileSync(armed.record.paths.result, JSON.stringify({ ...result, job_id: "foreign" }));
      expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("BLOCK_LEDGER_PATH");
      expect(readLongJob(terminal.root, "terminal").state).toBe(running.state);
      writeFileSync(armed.record.paths.result, JSON.stringify(result));
      writeFileSync(armed.record.paths.exit, JSON.stringify({ job_id: "terminal", attempt: 1, exit_code: 7, at: completed }));
      expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("BLOCK_LEDGER_PATH");
      unlinkSync(armed.record.paths.exit);
      writeFileSync(armed.record.paths.result, JSON.stringify(result));
      const exactAck = { job_id: "terminal", attempt: 1, terminal_state: "FINISHED", acked_at: completed };
      writeFileSync(armed.record.paths.ack, JSON.stringify(exactAck));
      expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("BLOCK_LEDGER_PATH");
      expect(readLongJob(terminal.root, "terminal").state).toBe("RUNNING");
      unlinkSync(armed.record.paths.ack);
      expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("DRAIN");
      expect(readLongJob(terminal.root, "terminal").state).toBe("FINISHED");
      // Modeled exact ACK-write / record-write crash window, not old evidence.
      for (const receipt of ["{malformed", JSON.stringify({ ...exactAck, job_id: "foreign" }),
        JSON.stringify({ ...exactAck, attempt: 2 }), JSON.stringify({ ...exactAck, terminal_state: "FAILED" }),
        JSON.stringify({ ...exactAck, acked_at: "invalid" }),
        JSON.stringify({ ...exactAck, acked_at: new Date(Date.parse(completed) - 1).toISOString() }),
        JSON.stringify({ ...exactAck, acked_at: new Date(Date.now() + 60_000).toISOString() })]) {
        writeFileSync(armed.record.paths.ack, receipt);
        expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("BLOCK_LEDGER_PATH");
        let consumed = false;
        // W-788 (2): unverifiable terminal evidence is now per-job typed
        // attention instead of a pass-wide throw. Nothing is weakened — the
        // record is still never consumed, never acked and stays FINISHED — and
        // the typed action is now named rather than left to a bare throw.
        const poisoned = drainLongJobs(terminal.root, () => { consumed = true; });
        expect(poisoned.acked).toBe(0);
        expect(poisoned.blocked.map((item) => [item.job_id, item.action])).toEqual([["terminal", "BLOCK_LEDGER_PATH"]]);
        expect(consumed).toBe(false);
        expect(readLongJob(terminal.root, "terminal").state).toBe("FINISHED");
      }
      const receipt = JSON.stringify(exactAck);
      writeFileSync(armed.record.paths.ack, receipt);
      expect(recoverLongJobs(terminal.root, Date.now(), 0, noProbe)[0]?.action).toBe("DRAIN");
      let consumed = 0;
      const drained = drainLongJobs(terminal.root, () => { consumed++; });
      expect(drained.acked).toBe(1);
      expect(drained.blocked).toEqual([]);
      expect(consumed).toBe(1);
      expect(readLongJob(terminal.root, "terminal").state).toBe("ACKED");
      expect(readLongJob(terminal.root, "terminal").timestamps.acked_at).toBe(completed);
      expect(readFileSync(armed.record.paths.ack, "utf8")).toBe(receipt);
      acknowledgeLongJob(terminal.root, "terminal", 1);
      expect(recoverLongJobs(terminal.root)).toEqual([]);
    });
    await step("handshake-attempt", () => handshakeBoundary("attempt"));
  });

  test("a live job whose command payload is missing still BLOCKs", async () => {
    phase("registration-4", "begin");
    await step("missing-live-payload", () => {
      const { root, cwd } = fixture("missing-live");
      const { commandRef } = armWithPayloadDirectory(root, cwd, "gate-run");
      unlinkSync(commandRef);
      const blocked = recoverLongJobs(root).filter((action) => action.job_id === "gate-run");
      expect(blocked.map((action) => action.action)).toEqual(["BLOCK_WAKE_UNARMED"]);
      expect(blocked[0]?.reason).toContain("gate-run.cmd");
    });
    await step("w786-wake-block-attention", () => {
      // W-786: an aged RUNNING job with no saved child identity classifies as
      // BLOCK_RUNNING_IDENTITY. `dispatch_prepare` refuses a dispatch on exactly
      // this list, so the completion wake must report the SAME state. Before the
      // fix `wakeRecovery`'s DRAIN|RERUN filter dropped it and the payload said
      // pending 0 / settled while prepare refused the very same ledger.
      const aged = fixture("w786-aged");
      const { record } = armWithPayloadDirectory(aged.root, aged.cwd, "aged-running");
      startLongJob(aged.root, "aged-running", undefined, 900_111);
      // Age the attempt past the default 15-minute staleness bound. No probe is
      // reached: the absent child identity blocks before any observation.
      const backdated = new Date(Date.now() - 30 * 60_000).toISOString();
      const raw = JSON.parse(readFileSync(record.paths.record, "utf8")) as LongJobRecord;
      raw.timestamps = { ...raw.timestamps, created_at: backdated, armed_at: backdated,
        started_at: backdated, updated_at: backdated };
      writeFileSync(record.paths.record, `${JSON.stringify(raw, null, 2)}\n`);
      const before = listLongJobs(aged.root).map((job) => [job.job_id, job.state]);
      const refused = recoverLongJobs(aged.root); // the list dispatch_prepare refuses on
      expect(refused.map((item) => [item.job_id, item.action])).toEqual([["aged-running", "BLOCK_RUNNING_IDENTITY"]]);

      const wake = coalesceCompletionWake(aged.root);
      expect(wake.emitted).toBe(true);
      expect(wake.pending).toBe(1); // the pre-fix filter reported 0 here
      const payload = JSON.parse(readFileSync(wake.payload_file, "utf8")) as { pending: number; recovery: typeof refused };
      expect(payload.pending).toBe(1);
      expect(payload.recovery).toEqual(refused); // wake and prepare agree item for item
      // Attention ONLY: the wake never rewrites a BLOCK into a rerun action and
      // never performs recovery, so every record is byte-identical afterwards.
      expect(payload.recovery.some((item) => item.action === "RERUN_WHOLE_COMMAND")).toBe(false);
      expect(listLongJobs(aged.root).map((job) => [job.job_id, job.state])).toEqual(before);
      expect(readFileSync(record.paths.record, "utf8")).toBe(`${JSON.stringify(raw, null, 2)}\n`);

      // AC-786-2: the DRAIN / RERUN_WHOLE_COMMAND wake behaviour is unchanged.
      const settled = fixture("w786-terminal");
      armWithPayloadDirectory(settled.root, settled.cwd, "finished");
      startLongJob(settled.root, "finished", undefined, 900_112);
      finishLongJob(settled.root, "finished", 1, { ok: true });
      const drainWake = coalesceCompletionWake(settled.root);
      expect(drainWake.emitted).toBe(true);
      expect(drainWake.pending).toBe(1);
      expect((JSON.parse(readFileSync(drainWake.payload_file, "utf8")) as { recovery: typeof refused })
        .recovery.map((item) => item.action)).toEqual(["DRAIN"]);
    });
    await step("handshake-publication", () => handshakeBoundary("publication"));
  });

  test("an ACKED job whose command payload was removed does not stop the scan", async () => {
    phase("registration-5", "begin");
    await step("missing-acked-payload", () => {
      const { root, cwd } = fixture("missing-acked");
      const { commandRef } = armWithPayloadDirectory(root, cwd, "gate-run");
      startLongJob(root, "gate-run", undefined, 900_102);
      finishLongJob(root, "gate-run", 1, { ok: true });
      acknowledgeLongJob(root, "gate-run", 1);
      unlinkSync(commandRef);
      expect(recoverLongJobs(root)).toEqual([]);
      expect(listLongJobs(root).map((job) => job.state)).toEqual(["ACKED"]);
    });
    await step("handshake-preloss", () => handshakeBoundary("preloss"));
    await step("nonzero", async () => {
      const actual = fixture("nonzero");
      const armed = armWithPayloadDirectory(actual.root, actual.cwd, "nonzero", fixtureCommand(actual.cwd, "process.stdout.write('EXACT\\n');process.exit(7);"));
      const run = launchOwnedLongJob(actual.root, "nonzero");
      own(run.child, armed.record, join(actual.cwd, "command.pid"), () => false);
      try {
        expect(await run.publication).toBe(true);
        phase("nonzero", "published");
        expect(await run.completion).toBe(7);
        phase("nonzero", "completed");
        expect(readLongJob(actual.root, "nonzero").failure?.exit_code).toBe(7);
        expect(readFileSync(armed.record.paths.log, "utf8")).toBe("EXACT\n");
      } finally { await cleanup(run.child); }
      qualified.add("nonzero");
    });
  });

  test("an ACKED command_ref pointing outside the ledger root still BLOCKs", async () => {
    phase("registration-6", "begin");
    await step("escaping-acked-command-ref", () => {
      const { root, cwd } = fixture("escape-acked");
      armWithPayloadDirectory(root, cwd, "gate-run");
      startLongJob(root, "gate-run", undefined, 900_103);
      finishLongJob(root, "gate-run", 1, { ok: true });
      acknowledgeLongJob(root, "gate-run", 1);
      const recordPath = join(root, "gate-run", "record.json");
      const raw = JSON.parse(readFileSync(recordPath, "utf8")) as LongJobRecord;
      raw.command_ref = join(cwd, "outside.cmd");
      writeFileSync(recordPath, `${JSON.stringify(raw, null, 2)}\n`);
      const blocked = recoverLongJobs(root).filter((action) => action.job_id === "gate-run");
      expect(blocked.map((action) => action.action)).toEqual(["BLOCK_WAKE_UNARMED"]);
      expect(blocked[0]?.reason).toContain("durable ledger root");
    });
    await step("handshake-postloss", () => handshakeBoundary("postloss"));
  });

  test("W-776 exact-live publisher identity prevents aged RERUN and settled payload recovery stays empty", async () => {
    const registrationDeadline = Date.now() + 5000;
    phase("registration-7", "begin");
    expect([...qualified].sort()).toEqual(["attempt", "missing-terminal", "no-ipc", "nonce", "nonzero", "postloss", "preloss", "publication"]);
    await step("aged-live", async () => {
      const { root, cwd } = fixture("settled");
      const release = join(cwd, "release");
      const recordPath = join(root, "gate-run", "record.json");
      // Command itself verifies publication-before-reachability. It stays alive
      // until released by owned cleanup, with the original ten-second backstop.
      const code = `const r=JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},'utf8'));if(!r.runtime.child_identity)process.exit(9);process.stdout.write('AUTHORIZED\\n');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(t);process.exit(0)}},10);setTimeout(()=>process.exit(8),10000);`;
      const { record } = armWithPayloadDirectory(root, cwd, "gate-run", fixtureCommand(cwd, code));
      const run = launchOwnedLongJob(root, "gate-run");
      const commandPidFile = join(cwd, "command.pid");
      own(run.child, record, commandPidFile, () => false, () => writeFileSync(release, "release"));
      let actions: ReturnType<typeof recoverLongJobs> = [];
      try {
        expect(await run.publication).toBe(true);
        phase("aged-live", "published");
        phase("aged-live", "preparation");
        // Yield so the authorized wrapper/verified Git Bash command can reach
        // its authored PID write before the synchronous foreign observation.
        // This is reachability only, not PID identity or descendant-absence proof.
        let commandPid = 0;
        while (Date.now() < registrationDeadline) {
          if (existsSync(commandPidFile)) commandPid = Number(readFileSync(commandPidFile, "utf8"));
          if (Number.isSafeInteger(commandPid) && commandPid > 0) break;
          await new Promise((done) => setTimeout(done, 10));
        }
        expect(existsSync(commandPidFile)).toBe(true);
        expect(Number.isSafeInteger(commandPid) && commandPid > 0).toBe(true);
        expect(ownership.get(run.child)?.cleanup).toBeUndefined();
        expect(Date.now()).toBeLessThan(registrationDeadline);
        phase("aged-live", "command-reached");
        const published = readLongJob(root, "gate-run");
        expect(published.runtime?.runner_identity?.pid).toBe(process.pid);
        phase("aged-live", "observe-begin");
        const observations = new Map<number, LongJobProcessObservation>();
        actions = recoverLongJobs(root, Date.parse(published.timestamps.started_at!) + 15 * 60_000,
          15 * 60_000, (pid) => {
            const observation = observeLongJobProcess(pid);
            observations.set(pid, observation);
            return observation;
          });
        const observed = observations.get(run.child.pid);
        if (!observed) throw new Error("W-776 production classifier did not observe wrapper");
        phase("aged-live", "observe-end");
        expect(observed.state).toBe("present");
        if (observed.state !== "present") throw new Error("W-776 wrapper native identity unavailable");
        // W-788 (3): the two mechanisms are genuinely independent ONLY on
        // win32 x64 — there the wrapper self-publishes through bun:ffi
        // GetProcessTimes while the parent observes through foreign PowerShell.
        // Everywhere else `publishedLongJobProcessIdentity` falls back to
        // `observeLongJobProcess`, so this comparison is one mechanism against
        // itself. The equality below runs on EVERY platform (skip 0); what is
        // platform-typed is the CLAIM that match supports. Only the win32 x64
        // branch carries a further assertion, because only there is there a
        // second mechanism to pin — the published token must have the FFI
        // publisher's FILETIME shape, which the PowerShell observer alone does
        // not produce. Elsewhere the outcome is the typed
        // `unknown-single-mechanism` recorded below and nothing further is
        // claimed: asserting the branch value back would assert nothing.
        const ffiPublisher = process.platform === "win32" && process.arch === "x64";
        const independence: "ffi-vs-powershell" | "unknown-single-mechanism" =
          ffiPublisher ? "ffi-vs-powershell" : "unknown-single-mechanism";
        console.log(`W776_INDEPENDENCE ${JSON.stringify({ mechanism: independence, platform: process.platform, arch: process.arch })}`);
        expect(published.runtime?.child_identity?.creation).toBe(observed.identity.creation);
        if (ffiPublisher) expect(published.runtime?.child_identity?.creation).toMatch(/^win32-filetime:[1-9][0-9]*$/);
        expect(published.runtime?.child_identity).toEqual(observed.identity);
        // Supplemental modeled edges use the real record's published shape;
        // they never replace the independent native observation above.
        const now = Date.parse(published.timestamps.started_at!) + 15 * 60_000;
        const live = (pid: number): LongJobProcessObservation => ({ state: "present", identity:
          pid === published.runtime!.child_pid ? published.runtime!.child_identity! : published.runtime!.runner_identity! });
        const absent = (): LongJobProcessObservation => ({ state: "absent" });
        expect(classifyRunningLongJob(published, now, 900_000, { state: "absent" }, live)).toBeUndefined();
        const unrelated = { state: "live" as const, owner: { schema: "garelier.long-job-broker" as const,
          version: 1 as const, pid: 900_999, nonce: "modeled", phase: "running" as const,
          started_at: published.timestamps.started_at!, heartbeat_at: published.timestamps.updated_at,
          owner: "operator" as const, provenance: "operator-owned" as const } };
        const dead = classifyRunningLongJob(published, now, 900_000, unrelated, absent);
        expect(dead?.action).toBe("BLOCK_RUNNING_IDENTITY");
        expect(dead?.reason).toContain("unrelated-or-unavailable");
        expect(dead?.reason).toContain("both absent observed; descendants unknown");
        expect(classifyRunningLongJob(published, now, 900_000, { state: "absent" }, absent)?.action).toBe("BLOCK_RUNNING_IDENTITY");
        const runnerOnly = (pid: number): LongJobProcessObservation => pid === published.runtime!.child_pid ? absent() : live(pid);
        expect(classifyRunningLongJob(published, now, 900_000, unrelated, runnerOnly)?.reason).toContain("wrapper=absent; runner=exact-live");
        const reused = (pid: number): LongJobProcessObservation => ({ state: "present", identity: {
          ...(pid === published.runtime!.child_pid ? published.runtime!.child_identity! : published.runtime!.runner_identity!),
          creation: "win32-filetime:1" } });
        expect(classifyRunningLongJob(published, now, 900_000, unrelated, reused)?.reason).toContain("wrapper=unknown");
        expect(classifyRunningLongJob(published, now, 900_000, unrelated,
          () => ({ state: "unknown", reason: "modeled probe failure" }))?.action).toBe("BLOCK_RUNNING_IDENTITY");
        expect(classifyRunningLongJob({ ...published, runtime: undefined }, now, 900_000, unrelated, live)?.action).toBe("BLOCK_RUNNING_IDENTITY");
        expect(classifyRunningLongJob(published, now, 900_000, unrelated,
          () => { throw new Error("modeled unavailable observation"); })?.action).toBe("BLOCK_RUNNING_IDENTITY");
        expect(classifyRunningLongJob(published, now, 900_000, unrelated,
          (pid) => ({ state: "present", identity: { ...published.runtime!.child_identity!, pid: pid + 1 } }))?.reason).toContain("wrapper=unknown");
        expect(classifyRunningLongJob(published, now, 900_000, unrelated,
          (pid) => ({ state: "present", identity: { ...published.runtime!.child_identity!, pid, host: "foreign-host" } }))?.reason).toContain("wrapper=unknown");
        const related = { ...unrelated, owner: { ...unrelated.owner, pid: published.runtime!.runner_pid } };
        expect(classifyRunningLongJob(published, now, 900_000, related, runnerOnly)?.action).toBe("BLOCK_RUNNING_IDENTITY");
        expect(classifyRunningLongJob(published, now, 900_000, related, runnerOnly)?.reason).toContain("owner-time-correlated");
        for (const timestamps of [
          { ...published.timestamps, started_at: "invalid" },
          { ...published.timestamps, updated_at: new Date(now + 1).toISOString() },
          { ...published.timestamps, armed_at: new Date(now).toISOString() },
        ]) expect(classifyRunningLongJob({ ...published, timestamps }, now, 900_000, unrelated, live)?.reason).toBe("unknown-running-timestamps");
        expect(classifyRunningLongJob(published, now - 1, 900_000, unrelated,
          () => { throw new Error("young job must not probe"); })).toBeUndefined();
      } finally {
        phase("aged-live", "release");
        writeFileSync(release, "release");
        phase("aged-live", "cleanup");
        await cleanup(run.child);
        phase("aged-live", "cleanup-completed");
        expect(await run.completion).toBe(0);
      }
      expect(readFileSync(record.paths.log, "utf8")).toBe("AUTHORIZED\n");
      acknowledgeLongJob(root, "gate-run", 1);
      expect(recoverLongJobs(root)).toEqual([]);
      expect(Date.now()).toBeLessThan(registrationDeadline);
      console.log("W776_QUALIFIED_SELF_PUBLISHER native_match=true command_authorized=true cleanup=true");
      // Same qualified RED oracle, now requiring exact-live recovery suppression.
      expect(actions).toEqual([]);
    });
  });
});
