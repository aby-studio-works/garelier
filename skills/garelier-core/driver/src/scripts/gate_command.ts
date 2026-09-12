import { appendFileSync, closeSync, openSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { resolveBashLaunch, resolveCommand, type NativeExecutableOptions, type RuntimeToolName } from "./_lib.ts";

const SHELL_BUILTINS = new Set([".", ":", "break", "cd", "continue", "eval", "exec", "exit", "export", "false", "if", "printf", "pwd", "read", "readonly", "return", "set", "shift", "source", "test", "true", "trap", "unset"]);
const CONFIGURED_GATE_TOOLS: RuntimeToolName[] = ["cargo", "uv", "go", "node", "ruby", "pandoc", "drawio", "rg", "pwsh", "bun", "git", "gitleaks"];

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Resolve a simple configured gate's leading executable without evaluating the
 * command. Shell builtins and compound shell programs stay with Git Bash. */
export function resolveGateCommand(cmd: string, options: NativeExecutableOptions = {}): string | null {
  const match = /^(\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]*))\s+)*)(?:"([^"]+)"|'([^']+)'|([^\s;&|()<>]+))/.exec(cmd);
  if (!match) return cmd;
  const executable = match[2] ?? match[3] ?? match[4] ?? "";
  if (SHELL_BUILTINS.has(executable)) return cmd;
  const resolved = resolveCommand([executable], options);
  if (!resolved) return null;
  return `${match[1]}${shellSingleQuote(resolved[0])}${cmd.slice(match[0].length)}`;
}

export function gateKillGraceSecs(): number {
  return parseInt(process.env.GARELIER_GATE_KILL_GRACE_SECS ?? "15", 10) || 15;
}

/** Return a terminal gate code after attempting its diagnostic exactly once.
 * merge-gate.ts selects a transient retry from the integer alone (it excludes
 * 125 and admits 127), so reporting must never be able to replace that
 * integer: an unguarded console/append sink that throws would escape into the
 * enclosing catch, downgrade a cleanup-unconfirmed 125 into the retryable 127
 * and relaunch the command while cleanup is still unconfirmed. Losing the
 * message is strictly better than losing the refusal, so a failing report is
 * dropped here on purpose — the code, not the text, is the contract. Build the
 * message INSIDE `report` so its construction is covered too. */
export function reportedExit(code: number, report: () => void): number {
  try { report(); }
  catch { /* a lost diagnostic never downgrades a terminal code */ }
  return code;
}

const POSIX_SUPERVISOR = "--garelier-private-gate-supervisor";
const POSIX_TERMINAL_OBSERVATION_MS = 1000;

type PosixStart = {
  kind: "start"; executable: string; command: string;
  env: Record<string, string | undefined>; deadline: number; graceMs: number;
};

/** Internal entry only. argv selects this entry; ONLY the inherited Bun IPC
 * endpoint authorizes a command. No command or group identity comes from argv.
 * detached:true establishes a session, and native calls verify it before spawn.
 * Ordinary descendants inherit this group; deliberate setsid/setpgid escapes
 * are not contained. The caller never signals a stored PID/PGID.
 * https://bun.com/reference/bun/spawn
 * https://man7.org/linux/man-pages/man2/kill.2.html */
async function posixSupervisor(): Promise<never> {
  if (process.platform === "win32" || !process.send || !process.connected) process.exit(125);
  const send = (message: object) => {
    if (!process.connected || !process.send) throw new Error("private IPC disconnected");
    process.send(message);
  };
  const { dlopen } = await import("bun:ffi");
  const libc = process.platform === "linux" ? "libc.so.6" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : null;
  if (!libc) throw new Error("unsupported POSIX gate native library");
  const library = dlopen(libc, {
    getpid: { args: [], returns: "i32" },
    getpgrp: { args: [], returns: "i32" },
    getsid: { args: ["i32"], returns: "i32" },
    kill: { args: ["i32", "i32"], returns: "i32" },
  });
  const api = library.symbols;
  const owned = () => {
    const pid = api.getpid();
    const pgid = api.getpgrp(), sid = api.getsid(0);
    if (pid <= 1 || pid !== process.pid || pgid !== pid || sid !== pid)
      throw new Error("current PID=PGID=SID unconfirmed");
    return { pid, pgid, sid };
  };
  owned();
  let spawned = false, timedOut = false, terminal = false, killing = false;
  let normalCode: number | undefined;
  let hardDeadline = 0, planAcknowledged = false;
  let timeoutFailure = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const at = (deadline: number, action: () => void) => {
    timer = setTimeout(() => {
      if (Date.now() < deadline) at(deadline, action);
      else action();
    }, Math.max(0, deadline - Date.now()));
  };
  const selfKill = () => {
    if (killing) return;
    owned();
    killing = true;
    // Zero means our CURRENT group, whose leader is still this live process.
    if (api.kill(0, 9) !== 0) throw new Error("self-group KILL failed");
  };
  const fail = (error: unknown) => {
    if (timedOut && timeoutFailure) return; // one bounded failure diagnostic
    if (timedOut) timeoutFailure = true;
    console.error(`GARELIER_GATE_POSIX_UNCONFIRMED: ${error instanceof Error ? error.message : String(error)}`);
    try { send({ kind: "failure" }); } catch { /* parent independently observes channel loss */ }
    if (timedOut) {
      return; // never cancel/shorten self-cleanup after timeout has started
    }
    if (timer) clearTimeout(timer);
    if (spawned && normalCode === undefined) {
      try { selfKill(); } catch (cleanup) { console.error(`GARELIER_GATE_POSIX_CLEANUP_UNCONFIRMED: ${String(cleanup)}`); }
    }
    process.exit(125);
  };
  // A caught disposition is reset by exec in Bash; only the supervisor stays
  // alive on group TERM. Do not use SIG_IGN, which children could inherit.
  process.on("SIGTERM", () => { if (!timedOut) fail(new Error("unexpected supervisor TERM")); });
  process.on("disconnect", () => { if (!terminal) fail(new Error("private IPC lost")); });
  process.on("uncaughtException", fail);
  process.on("unhandledRejection", fail);
  process.on("message", (message: unknown) => {
    try {
      if (!message || typeof message !== "object" || !("kind" in message)) throw new Error("invalid private message");
      if (message.kind === "start" && !spawned) {
        const start = message as PosixStart;
        if (typeof start.executable !== "string" || typeof start.command !== "string" ||
            !start.env || typeof start.env !== "object" || !Number.isFinite(start.deadline) ||
            !Number.isFinite(start.graceMs) || start.graceMs < 0 || Date.now() >= start.deadline)
          throw new Error("startup budget/configuration unconfirmed");
        owned();
        const root = Bun.spawn([start.executable, "-c", start.command], {
          env: start.env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
          windowsHide: true,
        });
        spawned = true;
        at(start.deadline, () => {
          timedOut = true;
          try {
            owned();
            if (api.kill(0, 15) !== 0) throw new Error("self-group TERM failed");
          } catch (error) { fail(error); }
          hardDeadline = Date.now() + start.graceMs;
          // Arm BEFORE notification. Parent loss/failed send/missing ACK may
          // invalidate evidence, but cannot invalidate our owned cleanup timer.
          at(hardDeadline, () => {
            if (!planAcknowledged) fail(new Error("timeout plan not acknowledged"));
            if (!timeoutFailure) {
              try { owned(); send({ kind: "killing" }); }
              catch (error) { fail(error); }
            }
            try { selfKill(); }
            catch (error) { fail(error); process.exit(125); }
          });
          try { send({ kind: "timeout", hardDeadline }); }
          catch (error) { fail(error); }
        });
        void root.exited.then(code => {
          if (timedOut) return; // root exit cannot cancel an active grace
          clearTimeout(timer);
          normalCode = code;
          send({ kind: "result", code });
          // The existing deadline also bounds delivery/ack; no new allowance.
          timer = setTimeout(() => fail(new Error("normal result not acknowledged")), Math.max(0, start.deadline - Date.now()));
        }).catch(fail);
      } else if (message.kind === "timeout-ack" && timedOut && !planAcknowledged) {
        planAcknowledged = true;
      } else if (message.kind === "result-ack" && normalCode !== undefined && !timedOut) {
        clearTimeout(timer);
        library.close();
        send({ kind: "finished" });
        terminal = true;
        process.exit(normalCode); // no group signal on natural zero/nonzero exit
      } else throw new Error("unexpected private protocol phase");
    } catch (error) { fail(error); }
  });
  send({ kind: "ready", ...owned() });
  // IPC is the liveness reference; no public entry can launch without start.
  return await new Promise<never>(() => {});
}

async function runPosixGate(start: PosixStart, outFd: number, errFd: number): Promise<number> {
  const settlementDeadline = start.deadline + start.graceMs + POSIX_TERMINAL_OBSERVATION_MS;
  // Reserve the final 250ms of the existing bound for caller return/natural exit.
  // This is fixed at launch, never extended by messages or delayed child grace.
  const evidenceDeadline = settlementDeadline - 250;
  let settled = false;
  let ready = false, failed = false, killIntent = false, result: number | undefined, hardDeadline = 0;
  let normalFinished = false;
  let ownership: { pid: number; pgid: number; sid: number } | undefined;
  let disconnectedAt = 0;
  let disconnected!: () => void;
  const channelClosed = new Promise<void>(resolve => { disconnected = resolve; });
  const proc = Bun.spawn([process.execPath, import.meta.path, POSIX_SUPERVISOR], {
    detached: true, env: start.env, stdin: "ignore", stdout: outFd, stderr: errFd,
    windowsHide: true,
    ipc(message: unknown, child) {
      try {
        if (!message || typeof message !== "object" || !("kind" in message)) throw new Error("invalid supervisor message");
        if (message.kind === "ready" && !ready) {
          if (!("pid" in message) || !("pgid" in message) || !("sid" in message) ||
              message.pid !== child.pid || message.pgid !== child.pid || message.sid !== child.pid)
            throw new Error("supervisor native ownership unconfirmed");
          ownership = { pid: child.pid, pgid: child.pid, sid: child.pid };
          ready = true;
          child.send(start);
        } else if (message.kind === "result" && ready && !hardDeadline && result === undefined &&
                   "code" in message && Number.isInteger(message.code) && Number(message.code) >= 0 && Number(message.code) <= 255) {
          result = Number(message.code);
          child.send({ kind: "result-ack" });
        } else if (message.kind === "timeout" && ready && result === undefined && !hardDeadline &&
                   "hardDeadline" in message && typeof message.hardDeadline === "number" &&
                   Number.isFinite(message.hardDeadline) && message.hardDeadline >= start.deadline + start.graceMs) {
          hardDeadline = message.hardDeadline;
          child.send({ kind: "timeout-ack" });
        } else if (message.kind === "killing" && hardDeadline && !killIntent && Date.now() >= hardDeadline) {
          killIntent = Date.now() < evidenceDeadline;
        } else if (message.kind === "finished" && result !== undefined && !normalFinished && !hardDeadline) {
          normalFinished = Date.now() < evidenceDeadline;
        } else throw new Error("supervisor phase unconfirmed");
      } catch (error) {
        failed = true;
        if (!settled) {
          console.error(`GARELIER_GATE_POSIX_UNCONFIRMED: ${String(error)}`);
          child.disconnect(); // protocol failure, not budget settlement
        }
      }
    },
    onDisconnect() { disconnectedAt = Date.now(); disconnected(); },
  });
  const startup = setTimeout(() => {
    if (!ready) { failed = true; proc.disconnect(); }
  }, Math.max(0, start.deadline - Date.now()));
  // Bun does not order onExit versus onDisconnect. Drain the private messages
  // AND observe exit within ONE launch-fixed budget, never a new per-wait grace.
  // Settlement does not disconnect: a delayed child must retain its full grace.
  let budgetTimer: ReturnType<typeof setTimeout>;
  const budget = new Promise<null>(resolve => {
    const check = () => {
      const remaining = evidenceDeadline - Date.now();
      if (remaining <= 0) resolve(null);
      else budgetTimer = setTimeout(check, remaining);
    };
    check();
  });
  const completion = Promise.all([proc.exited, channelClosed]).then(
    ([code]) => Date.now() < evidenceDeadline ? code : null,
    () => null,
  );
  const code = await Promise.race([completion, budget]);
  settled = true; // late exit/IPC cannot promote an already settled refusal
  clearTimeout(startup);
  clearTimeout(budgetTimer!);
  if (code !== null && !failed && normalFinished && result !== undefined && code === result && !proc.signalCode) return result;
  if (code !== null && !failed && killIntent && hardDeadline && Date.now() >= hardDeadline &&
      (!disconnectedAt || disconnectedAt >= hardDeadline) && proc.signalCode === "SIGKILL") return 137;
  // Bun.Subprocess.unref removes the subprocess liveness reference; it does
  // not terminate it or prove IPC no longer holds the caller alive. The oracle
  // measures actual caller exit separately. Never disconnect to meet a budget.
  let unrefError: string | null = null;
  try { proc.unref(); }
  catch (error) { unrefError = error instanceof Error ? error.message : String(error); }
  // Same contract as the Windows sites: this refusal is terminal even if the
  // evidence line cannot be serialized or written.
  return reportedExit(125, () => console.error(`GARELIER_GATE_POSIX_UNCONFIRMED: ${JSON.stringify({
    supervisorPid: proc.pid, executable: start.executable,
    commandSha256: createHash("sha256").update(start.command).digest("hex"),
    deadline: start.deadline, graceMs: start.graceMs, settlementDeadline, evidenceDeadline, hardDeadline,
    ownership: ownership ?? null, withinBound: code !== null, protocolFailed: failed,
    killIntent, actualSIGKILL: proc.signalCode === "SIGKILL", exitCode: proc.exitCode,
    channelClosed: disconnectedAt !== 0, normalFinished,
    unrefError, cleanup: "unconfirmed", operatorAttention: true,
  })}`));
}

function pathKeyOf(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
}

/** Windows 10+ creates the shell IN this private job, still suspended. The job
 * attribute closes even the create-suspended/assign crash window. No breakaway
 * flags or inheritable job handle: later descendants remain in the same scope.
 * https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812
 * Buffers below use the Windows 64-bit ABI (x64 and ARM64), not CRT file handles. */
async function runWindowsGate(
  executable: string, command: string, childEnv: Record<string, string | undefined>,
  outFile: string, errFile: string, limitSecs: number, graceSecs: number,
): Promise<number> {
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error("unsupported Windows gate ABI");
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen("kernel32.dll", {
    CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" },
    SetInformationJobObject: { args: ["u64", "i32", "ptr", "u32"], returns: "i32" },
    QueryInformationJobObject: { args: ["u64", "i32", "ptr", "u32", "ptr"], returns: "i32" },
    TerminateJobObject: { args: ["u64", "u32"], returns: "i32" },
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    InitializeProcThreadAttributeList: { args: ["ptr", "u32", "u32", "ptr"], returns: "i32" },
    UpdateProcThreadAttribute: { args: ["ptr", "u32", "u64", "ptr", "u64", "ptr", "ptr"], returns: "i32" },
    DeleteProcThreadAttributeList: { args: ["ptr"], returns: "void" },
    CreateProcessW: { args: ["ptr", "ptr", "ptr", "ptr", "i32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    IsProcessInJob: { args: ["u64", "u64", "ptr"], returns: "i32" },
    ResumeThread: { args: ["u64"], returns: "u32" },
    WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
    GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
    TerminateProcess: { args: ["u64", "u32"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
  const api = library.symbols;
  const wide = (value: string) => {
    if (value.includes("\0")) throw new Error("NUL in Windows gate argument");
    return Buffer.from(value + "\0", "utf16le");
  };
  // Same backslash/quote convention as Windows argv construction, not shell
  // escaping. The command remains one argument to the resolved Git Bash -c.
  const quote = (value: string) => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  const check = (ok: number | boolean, operation: string) => {
    // Do not report GetLastError across separate FFI calls: intervening runtime
    // work can clobber it. The failed operation is the reliable evidence.
    if (!ok) throw new Error(`Windows gate ${operation} failed`);
  };
  let job = 0n, processHandle = 0n, threadHandle = 0n;
  const io: bigint[] = [];
  let attributes: Buffer | undefined, inherited: Buffer | undefined, jobs: Buffer | undefined;
  let initialized = false, resumed = false;
  try {
    const application = wide(executable);
    const commandLine = wide([executable, "-c", command].map(quote).join(" "));
    if (commandLine.length / 2 > 32767) throw new Error("Windows gate command line too long");
    const entries = Object.entries(childEnv).filter((entry): entry is [string, string] => entry[1] !== undefined);
    for (const [key, value] of entries) {
      if (!key || (key.includes("=") && !/^=[A-Z]:$/i.test(key)) || key.includes("\0") || value.includes("\0"))
        throw new Error("invalid Windows gate environment entry");
    }
    entries.sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0);
    const environment = Buffer.from(entries.map(([key, value]) => `${key}=${value}`).join("\0") + "\0\0", "utf16le");
    job = api.CreateJobObjectW(null, null);
    check(job !== 0n, "CreateJobObjectW");
    const limits = Buffer.alloc(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    limits.writeUInt32LE(0x2000, 16); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    check(api.SetInformationJobObject(job, 9, limits, limits.length), "SetInformationJobObject");
    const security = Buffer.alloc(24); // SECURITY_ATTRIBUTES, inheritable I/O only
    security.writeUInt32LE(24, 0); security.writeInt32LE(1, 16);
    for (const [file, access] of [["NUL", 0x80000000], [resolve(outFile), 0x40000000], [resolve(errFile), 0x40000000]] as const) {
      const handle = api.CreateFileW(wide(file), access, 7, security, 3, 0x80, 0n); // OPEN_EXISTING; output already truncated by caller
      check(handle !== 0xffffffffffffffffn, "CreateFileW");
      io.push(handle);
    }
    const size = Buffer.alloc(8);
    api.InitializeProcThreadAttributeList(null, 2, 0, size); // sizing call fails by contract
    const bytes = Number(size.readBigUInt64LE());
    check(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 65536, "attribute size");
    attributes = Buffer.alloc(bytes);
    check(api.InitializeProcThreadAttributeList(attributes, 2, 0, size), "InitializeProcThreadAttributeList");
    initialized = true;
    inherited = Buffer.alloc(24); jobs = Buffer.alloc(8);
    io.forEach((handle, index) => inherited!.writeBigUInt64LE(handle, index * 8));
    jobs.writeBigUInt64LE(job);
    check(api.UpdateProcThreadAttribute(attributes, 0, 0x20002n, inherited, 24n, null, null), "HANDLE_LIST");
    check(api.UpdateProcThreadAttribute(attributes, 0, 0x2000dn, jobs, 8n, null, null), "JOB_LIST");
    const startup = Buffer.alloc(112); // STARTUPINFOEXW
    startup.writeUInt32LE(112, 0);
    startup.writeUInt32LE(0x101, 60); // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW, SW_HIDE=0
    io.forEach((handle, index) => startup.writeBigUInt64LE(handle, 80 + index * 8));
    startup.writeBigUInt64LE(BigInt(ptr(attributes)), 104);
    const info = Buffer.alloc(24); // PROCESS_INFORMATION
    // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW
    check(api.CreateProcessW(application, commandLine, null, null, 1, 0x08080404, environment, null, startup, info), "CreateProcessW");
    processHandle = info.readBigUInt64LE(0); threadHandle = info.readBigUInt64LE(8);
    api.DeleteProcThreadAttributeList(attributes); initialized = false;
    inherited.fill(0); jobs.fill(0); // keep attribute values alive until deletion
    const membership = Buffer.alloc(4);
    check(api.IsProcessInJob(processHandle, job, membership) && membership.readInt32LE() !== 0, "IsProcessInJob");
    check(api.ResumeThread(threadHandle) === 1, "ResumeThread");
    resumed = true;
    const deadline = Date.now() + limitSecs * 1000;
    const dead = () => {
      const state = api.WaitForSingleObject(processHandle, 0);
      check(state === 0 || state === 258, "WaitForSingleObject");
      return state === 0;
    };
    while (!dead() && Date.now() < deadline) await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
    if (dead()) {
      const exit = Buffer.alloc(4);
      check(api.GetExitCodeProcess(processHandle, exit), "GetExitCodeProcess");
      const code = exit.readUInt32LE();
      // Natural completion preserves background descendants, for both zero
      // and nonzero exits. Failures/timeouts retain kill-on-close containment.
      limits.writeUInt32LE(0, 16);
      check(api.SetInformationJobObject(job, 9, limits, limits.length), "clear KILL_ON_JOB_CLOSE after natural exit");
      return code;
    }
    // Windows has no POSIX TERM delivery here. End only the retained parent
    // at timeout (the native parent-exit premise); never search a PID tree.
    if (!api.TerminateProcess(processHandle, 143) && !dead()) check(false, "TerminateProcess at timeout");
    await Bun.sleep(graceSecs * 1000); // parent exit cannot cancel this grace
    check(api.TerminateJobObject(job, 137), "TerminateJobObject");
    const accounting = Buffer.alloc(48);
    check(api.QueryInformationJobObject(job, 1, accounting, accounting.length, null), "QueryInformationJobObject");
    check(accounting.readUInt32LE(40) === 0 && dead(), "cleanup unconfirmed at grace boundary");
    return 137;
  } catch (error) {
    // Once the shell is resumed this failure leaves cleanup unconfirmed, so it
    // is terminal 125; before that nothing ran and 127 stays retryable.
    return reportedExit(resumed ? 125 : 127, () => {
      const message = `GARELIER_GATE_NATIVE_FAILURE: ${error instanceof Error ? error.message : String(error)}`;
      console.error(message);
      appendFileSync(errFile, message + "\n");
    });
  } finally {
    // KILL_ON_JOB_CLOSE also covers startup failure and unexpected JS errors.
    // Never reacquire a process by PID, including a partially created shell.
    const closeFailures: string[] = [];
    const close = (name: string, action: () => void) => {
      try { action(); }
      catch { closeFailures.push(name); }
    };
    for (const [name, handle] of [["job", job], ["thread", threadHandle], ["process", processHandle],
      ...io.map(handle => ["stdio", handle] as const)] as const) {
      if (handle) close(name, () => { check(api.CloseHandle(handle), "CloseHandle"); });
    }
    if (initialized && attributes) close("attributes", () => api.DeleteProcThreadAttributeList(attributes!));
    close("inherited values", () => { inherited?.fill(0); });
    close("job values", () => { jobs?.fill(0); }); // retain values through attribute deletion
    close("library", () => library.close());
    if (closeFailures.length) {
      return reportedExit(125, () => {
        const message = `GARELIER_GATE_NATIVE_FAILURE: cleanup unconfirmed (${closeFailures.join(", ")})`;
        console.error(message); appendFileSync(errFile, message + "\n");
      });
    }
  }
}

/** Run one shell gate step with TERM then KILL escalation and captured output.
 * `env` (W-123) is the explicit CHILD env; the merge gate passes gateEnv() /
 * gateCommandEnv() (W-249) so the quality-gate compile runs with RUSTC_WRAPPER
 * unset (a top-level `delete process.env.RUSTC_WRAPPER` does not reach a
 * Windows Bun child) and, for gateCommandEnv(), a minimized env. Omitted = the
 * child inherits the parent env, preserving the standalone timeout tests.
 *
 * W-249 (G N1): tool RESOLUTION (bash / bun / CONFIGURED_GATE_TOOLS / the
 * command's own leading executable) resolves against `{...process.env, ...env}`
 * — the full host env with the caller's `env` overlaid — never the caller's
 * `env` alone. resolveBashExecutable's Windows fallback walks
 * ProgramFiles/ProgramW6432/ProgramFiles(x86)/LOCALAPPDATA, none of which are
 * in gateCommandEnv()'s MINIMAL_ENV_KEYS allowlist, so resolving against a
 * minimized env in isolation would exit 127 on any host where Git Bash isn't
 * already on PATH. The overlay keeps every existing override
 * (GARELIER_BASH/GARELIER_CARGO/a caller-narrowed PATH — see
 * gate_command_windows.test.ts) winning exactly as before; it only ADDS back
 * the full-env fallback vars a minimized `env` omits outright. Same shape as
 * gate_runner.ts's defaultDeps: resolve with the full env, spawn with the
 * (possibly minimized) one. Only the PATH prepend that resolution discovers
 * (the bash/bun/tool directories) is carried onto the actual child env —
 * never the rest of the full env. */
export async function runGateCommand(
  cmd: string,
  outFile: string,
  errFile: string,
  limitSecs: number,
  killGraceSecs = gateKillGraceSecs(),
  env?: Record<string, string | undefined>,
): Promise<number> {
  let outFd: number | undefined, errFd: number | undefined;
  try {
    outFd = openSync(outFile, "w");
    errFd = openSync(errFile, "w");
    const fullEnv = process.env as Record<string, string | undefined>;
    const resolveEnv: Record<string, string | undefined> = { ...fullEnv, ...(env ?? {}) };
    const shell = resolveBashLaunch({ env: resolveEnv, runtimeTools: CONFIGURED_GATE_TOOLS });
    if (!shell) throw new Error("Git Bash not found");
    const resolvedCmd = resolveGateCommand(cmd, { env: resolveEnv });
    if (!resolvedCmd) throw new Error("configured gate executable not found");
    const childEnv: Record<string, string | undefined> = { ...(env ?? fullEnv) };
    childEnv[pathKeyOf(childEnv)] = shell.env[pathKeyOf(shell.env)];
    if (process.platform === "win32") {
      const code = await runWindowsGate(shell.executable, resolvedCmd, childEnv, outFile, errFile, limitSecs, killGraceSecs);
      return code;
    }
    return await runPosixGate({
      kind: "start", executable: shell.executable, command: resolvedCmd, env: childEnv,
      deadline: Date.now() + limitSecs * 1000, graceMs: killGraceSecs * 1000,
    }, outFd, errFd);
  } catch {
    return 127;
  } finally {
    const closeFailures: [string, unknown][] = [];
    // Each acquired descriptor gets exactly one independent close attempt,
    // including when opening stderr or closing stdout failed. Never retry an
    // uncertain close: that numeric descriptor may already have been reused.
    for (const [name, fd] of [["stdout", outFd], ["stderr", errFd]] as const) {
      if (fd !== undefined) {
        try { closeSync(fd); }
        catch (error) { closeFailures.push([name, error]); }
      }
    }
    if (closeFailures.length) {
      return reportedExit(125, () => console.error(`GARELIER_GATE_FD_CLOSE_UNCONFIRMED: ${closeFailures
        .map(([name, error]) => `${name}: ${error instanceof Error ? error.message : String(error)}`).join("; ")}`));
    }
  }
}

export function gateTimeoutNote(code: number, limitSecs: number, killGraceSecs = gateKillGraceSecs()): string {
  if (code === 124) return ` (timed out after ${limitSecs}s)`;
  if (code === 137) return ` (SIGKILL after ${limitSecs}s timeout + ${killGraceSecs}s grace)`;
  return "";
}

if (import.meta.main && process.argv[2] === POSIX_SUPERVISOR) {
  void posixSupervisor().catch(error => {
    console.error(`GARELIER_GATE_POSIX_UNCONFIRMED: ${String(error)}`);
    process.exit(125);
  });
}
