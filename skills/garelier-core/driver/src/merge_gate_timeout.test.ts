import { rmSync } from "./guard/path_guard.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reportedExit, runGateCommand } from "./scripts/gate_command.ts";
import { requireRuntimeExecutable, resolveBashLaunch } from "./scripts/_lib.ts";

// W-094: verify the executable TypeScript helper directly. The old oracle sed-
// extracted dead Bash from merge-gate.ts after its exec, forcing duplicate code.

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

function files(): { out: string; err: string } {
  temp = mkdtempSync(join(tmpdir(), "garelier-gate-timeout-"));
  return { out: join(temp, "stdout"), err: join(temp, "stderr") };
}

// Windows-only test witness, prestarted before the production timeout clock.
// Toolhelp supplies ancestry, never kill authority. Only validated retained
// handles may be terminated, and only after the observation phase has ended.
const WINDOWS_WITNESS = String.raw`
using System;
using System.IO;
using System.Text;
using System.Net.Sockets;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class W775Witness {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry {
    public uint size, usage, pid; public UIntPtr heap;
    public uint module, threads, parent; public int priority; public uint flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string image;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint GetProcessId(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)] static extern bool QueryFullProcessImageNameW(IntPtr handle, uint flags, StringBuilder image, ref uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  sealed class Held { public uint pid; public IntPtr handle; public long created; }
  static long Now() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
  static Exception Error(string text) { return new Exception(text + ": win32=" + Marshal.GetLastWin32Error()); }
  static Dictionary<uint,uint> Parents() {
    var snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) throw Error("snapshot");
    try {
      var result = new Dictionary<uint,uint>();
      var entry = new Entry(); entry.size = (uint)Marshal.SizeOf(typeof(Entry));
      if (!Process32FirstW(snapshot, ref entry)) throw Error("first process");
      do { result[entry.pid] = entry.parent; } while (Process32NextW(snapshot, ref entry));
      if (Marshal.GetLastWin32Error() != 18) throw Error("next process");
      return result;
    } finally { CloseHandle(snapshot); }
  }
  static bool Dead(Held process) {
    var state = WaitForSingleObject(process.handle, 0);
    if (state != 0 && state != 258) throw Error("wait");
    return state == 0;
  }
  static long ExitAt(Held process) {
    if (!Dead(process)) return 0;
    long creation, exit, kernel, user;
    if (!GetProcessTimes(process.handle, out creation, out exit, out kernel, out user)) throw Error("exit time");
    return (exit - 116444736000000000L) / 10000L;
  }
  static Held Hold(uint pid, string image, bool cleanup, List<Held> opened, string pairedImage = null) {
    var h = OpenProcess(0x100000U | 0x1000U | (cleanup ? 1U : 0U), false, pid);
    if (h == IntPtr.Zero) throw Error("open process " + pid);
    var held = new Held { pid=pid, handle=h }; opened.Add(held);
    long exit, kernel, user;
    uint size = 32768; var actual = new StringBuilder((int)size);
    string handlePid = "unobserved", actualImage = "unobserved", creation = "unobserved", waitState = "unobserved";
    Func<string,int?,Exception> reject = (reason, win32) => new Exception(
      "identity " + reason + ": expectedPID=" + pid + "; handlePID=" + handlePid
      + "; expectedImage=" + image + "; pairedImage=" + (pairedImage ?? "none") + "; actualImage=" + actualImage
      + "; creation=" + creation + "; waitState=" + waitState
      + (win32.HasValue ? "; win32=" + win32.Value : ""));
    var observedPid = GetProcessId(h);
    int? pidError = observedPid == 0 ? (int?)Marshal.GetLastWin32Error() : null;
    handlePid = observedPid.ToString();
    if (observedPid != pid) throw reject("pid_mismatch", pidError);
    if (!GetProcessTimes(h, out held.created, out exit, out kernel, out user)) {
      var error = Marshal.GetLastWin32Error();
      throw reject("times_api_failed", error);
    }
    creation = held.created.ToString();
    if (!QueryFullProcessImageNameW(h, 0, actual, ref size)) {
      var error = Marshal.GetLastWin32Error();
      throw reject("image_api_failed", error);
    }
    actualImage = actual.ToString();
    if (!String.Equals(Path.GetFullPath(actual.ToString()), Path.GetFullPath(image), StringComparison.OrdinalIgnoreCase)
        && (pairedImage == null || !String.Equals(Path.GetFullPath(actual.ToString()), pairedImage, StringComparison.OrdinalIgnoreCase)))
      throw reject("image_mismatch", null);
    var state = WaitForSingleObject(h, 0);
    int? waitError = state == UInt32.MaxValue ? (int?)Marshal.GetLastWin32Error() : null;
    waitState = state.ToString();
    if (state != 0 && state != 258) throw reject(state == UInt32.MaxValue ? "wait_api_failed" : "wait_state_invalid", waitError);
    if (state == 0) throw reject("already_exited", null);
    return held;
  }
  public static void Run(int port, string token, string bun, string bash, uint ownerPid, long deadline) {
    var opened = new List<Held>(); var cleanup = new List<Held>();
    bool prepared = false, validated = false, cleaned = false;
    using (var client = new TcpClient("127.0.0.1", port)) {
      client.NoDelay = true;
      var stream = client.GetStream(); stream.ReadTimeout = 250; stream.WriteTimeout = 250;
      var writer = new StreamWriter(stream, new UTF8Encoding(false)); writer.AutoFlush = true;
      writer.NewLine = "\n";
      writer.WriteLine(token + ":observer:" + System.Diagnostics.Process.GetCurrentProcess().Id);
      string input = ""; Held parent = null, child = null, other = null;
      try {
        // Derive the known Git launcher/native pair before any target observation.
        var bashFull = Path.GetFullPath(bash);
        const string launcherSuffix = @"\bin\bash.exe";
        if (!Path.IsPathRooted(bash)
            || !String.Equals(bashFull, bash.Replace('/', '\\'), StringComparison.OrdinalIgnoreCase)
            || !bashFull.EndsWith(launcherSuffix, StringComparison.OrdinalIgnoreCase))
          throw new Exception("Git image layout unconfirmed: resolver=" + bash);
        // resolveBashExecutable scans PATH before the Git roots, so it returns
        // whichever of the pair PATH exposes first: the launcher <root>\bin\bash.exe
        // or the native <root>\usr\bin\bash.exe. Both end in \bin\bash.exe, so the
        // grandparent is <root> for one and <root>\usr for the other. Strip that
        // trailing usr to get <root>, then pair with the OTHER real image; appending
        // usr unconditionally produced <root>\usr\usr\bin\bash.exe, which never exists.
        var imageParent = Path.GetDirectoryName(Path.GetDirectoryName(bashFull));
        var nativeImage = String.Equals(Path.GetFileName(imageParent), "usr", StringComparison.OrdinalIgnoreCase);
        var gitRoot = nativeImage ? Path.GetDirectoryName(imageParent) : imageParent;
        if (String.IsNullOrEmpty(gitRoot)) throw new Exception("Git image layout unconfirmed: resolver=" + bash);
        var pairedBash = Path.GetFullPath(nativeImage
          ? Path.Combine(gitRoot, "bin", "bash.exe")
          : Path.Combine(gitRoot, "usr", "bin", "bash.exe"));
        if (!File.Exists(bashFull) || !File.Exists(pairedBash))
          throw new Exception("Git image files unconfirmed: expectedImage=" + bashFull + "; pairedImage=" + pairedBash);
        var owner = Hold(ownerPid, bun, false, opened);
        var initial = Parents();
        if (!initial.ContainsKey(ownerPid) || Dead(owner)) throw Error("owner initialization");
        writer.WriteLine("ready|" + Now());
        while (Now() < deadline) {
          while (stream.DataAvailable) {
            int b = stream.ReadByte(); if (b < 0) throw Error("observer disconnect");
            if (b != 10) { input += (char)b; continue; }
            var command = input.TrimEnd('\r').Split('|'); input = "";
            if (command[0] == "cleanup") { cleaned = true; break; }
            if (command.Length == 2 && command[0] == "prepare" && !prepared && !validated) {
              uint unrelatedPid = UInt32.Parse(command[1]);
              if (unrelatedPid == ownerPid) throw Error("distinct prepared identities");
              var preparing = Parents();
              other = Hold(unrelatedPid, bun, true, opened);
              if (Dead(owner) || preparing[other.pid] != ownerPid || other.created < owner.created) throw Error("unrelated ownership");
              var preparedAfter = Parents();
              if (Dead(other) || !preparedAfter.ContainsKey(other.pid) || preparedAfter[other.pid] != preparing[other.pid]) throw Error("prepared ancestry changed");
              prepared = true;
              writer.WriteLine("prepared|" + Now() + "|" + other.pid);
              continue;
            }
            if (command.Length != 3 || command[0] != "bind" || !prepared || validated) throw Error("observer command");
            writer.WriteLine("binding|" + Now());
            uint childPid = UInt32.Parse(command[1]), otherPid = UInt32.Parse(command[2]);
            if (childPid == otherPid || childPid == ownerPid || otherPid == ownerPid || otherPid != other.pid) throw Error("distinct identities");
            var before = Parents();
            if (!before.ContainsKey(ownerPid) || Dead(owner) || Dead(other)) throw Error("prepared handles exited before bind");
            child = Hold(childPid, bun, true, opened);
            if (before[otherPid] != ownerPid || other.created < owner.created) throw Error("unrelated ownership");
            cleanup.Add(child); cleanup.Add(other);
            Held lower = child;
            for (int depth = 0; depth < 8; depth++) {
              uint ancestor = before[lower.pid];
              if (ancestor == ownerPid) { parent = lower; break; }
              if (ancestor == otherPid || cleanup.Exists(p => p.pid == ancestor)) throw Error("ancestry cycle");
              var upper = Hold(ancestor, bashFull, true, opened, pairedBash);
              if (upper.created > lower.created || upper.created < owner.created) throw Error("ancestry creation order");
              cleanup.Add(upper); lower = upper;
            }
            if (parent == null || parent == child) throw Error("native shell root missing");
            var after = Parents();
            foreach (var held in cleanup) {
              if (Dead(held) || !after.ContainsKey(held.pid) || after[held.pid] != before[held.pid]) throw Error("ancestry changed");
            }
            validated = true;
            writer.WriteLine("bound|" + Now() + "|" + parent.pid + "|" + child.pid + "|" + other.pid);
          }
          if (cleaned) break;
          if (validated) writer.WriteLine("sample|" + Now() + "|" + (Dead(parent) ? 1 : 0) + "|" + (Dead(child) ? 1 : 0) + "|" + (Dead(other) ? 1 : 0) + "|" + ExitAt(parent) + "|" + ExitAt(child));
          System.Threading.Thread.Sleep(10);
        }
        if (!cleaned) throw Error("observation budget exhausted");
      } catch (Exception error) {
        writer.WriteLine("unconfirmed|" + error.Message.Replace('\n', ' ').Replace('\r', ' '));
      } finally {
        bool ok = validated;
        var authorizedCleanup = validated ? cleanup : (prepared ? new List<Held> { other } : new List<Held>());
        foreach (var held in authorizedCleanup) {
          // No acquisition here: only a fully validated binding or the
          // independently validated prepared unrelated handle is authorized.
          try {
            if (WaitForSingleObject(held.handle, 100) != 0) {
              if (!TerminateProcess(held.handle, 93) && !Dead(held)) ok = false;
              if (WaitForSingleObject(held.handle, 250) != 0) ok = false;
            }
          } catch { ok = false; }
        }
        foreach (var held in opened) CloseHandle(held.handle);
        writer.WriteLine(ok ? "cleanup|confirmed" : "cleanup|unconfirmed");
      }
    }
  }
}
`;

type NativeSample = { at: number; parentDead: number; childDead: number; otherDead: number; parentExit: number; childExit: number };

async function assertParentFirstTimeout(oracleDeadline: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "garelier-w775-timeout-tree-"));
  const token = randomUUID();
  const peers = new Map<string, { socket: Socket; closed: boolean; lastBeat: number; pid: number; beats: number[] }>();
  const native: { preparedAt: number; boundAt: number; samples: NativeSample[]; error: string; cleanup: string } = { preparedAt: 0, boundAt: 0, samples: [], error: "", cleanup: "" };
  const observerTiming = { spawnAt: 0, readyAt: 0, cutoffAt: oracleDeadline - 6500, gateRemainingMs: 0, gateCallAt: 0, ownedAuthAt: 0, bindSentAt: 0, bindReceivedAt: 0 };
  let bindingAllowed = false;
  const connections = new Set<Socket>();
  const server = createServer((socket) => {
    connections.add(socket);
    let buffer = "";
    let peer: { socket: Socket; closed: boolean; lastBeat: number; pid: number; beats: number[] } | undefined;
    let observerPeer = false;
    socket.on("error", () => { /* close is checked as cleanup evidence below */ });
    socket.on("close", () => { if (peer) peer.closed = true; connections.delete(socket); });
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!peer) {
          const match = new RegExp(`^${token}:(owned|unrelated|observer):([0-9]+)$`).exec(line);
          const role = match?.[1] ?? "";
          if (!role || peers.has(role)) { socket.destroy(); return; }
          const pid = Number(match![2]);
          if (!Number.isSafeInteger(pid) || pid <= 0) { socket.destroy(); return; }
          observerPeer = role === "observer";
          peer = { socket, closed: false, lastBeat: Date.now(), pid, beats: [] };
          peers.set(role, peer);
          if (role === "owned") {
            observerTiming.ownedAuthAt = Date.now();
            if (bindingAllowed) {
              const witness = peers.get("observer"), other = peers.get("unrelated");
              if (!native.preparedAt || !witness || witness.closed || !other || other.closed
                  || observerTiming.ownedAuthAt >= observerTiming.gateCallAt + 2000) native.error = "owned authentication outside prepared binding phase";
              else {
                observerTiming.bindSentAt = Date.now();
                witness.socket.write(`bind|${pid}|${other.pid}\n`);
              }
            }
          }
        } else if (!observerPeer && line === "beat") {
          peer.lastBeat = Date.now(); peer.beats.push(peer.lastBeat);
        } else if (observerPeer) {
          const fields = line.split("|");
          if (fields[0] === "ready" && fields.length === 2) {
            const at = Number(fields[1]);
            if (!Number.isSafeInteger(at) || at <= 0 || observerTiming.readyAt) native.error = "invalid native ready";
            else observerTiming.readyAt = Date.now();
          }
          else if (fields[0] === "prepared" && fields.length === 3) {
            const at = Number(fields[1]);
            if (!Number.isSafeInteger(at) || at <= 0 || !observerTiming.readyAt || native.preparedAt
                || Number(fields[2]) !== peers.get("unrelated")?.pid) native.error = "invalid native preparation";
            else native.preparedAt = at;
          }
          else if (fields[0] === "binding" && fields.length === 2) {
            const at = Number(fields[1]);
            if (!Number.isSafeInteger(at) || at <= 0 || !observerTiming.bindSentAt || observerTiming.bindReceivedAt) native.error = "invalid native bind receipt";
            else observerTiming.bindReceivedAt = at;
          }
          else if (fields[0] === "bound" && fields.length === 5) {
            const at = Number(fields[1]);
            if (!Number.isSafeInteger(at) || at <= 0 || !observerTiming.bindReceivedAt || native.boundAt || Number(fields[3]) !== peers.get("owned")?.pid
                || Number(fields[4]) !== peers.get("unrelated")?.pid || Number(fields[2]) === process.pid) native.error = "invalid native binding";
            else native.boundAt = at;
          }
          else if (fields[0] === "unconfirmed") native.error = line;
          else if (fields[0] === "cleanup") native.cleanup = fields[1] ?? "unconfirmed";
          else if (fields[0] === "sample" && fields.length === 7) {
            const numbers = fields.slice(1).map(Number);
            if (!numbers.every(Number.isSafeInteger) || numbers[0]! <= 0
                || numbers.slice(1, 4).some(state => state !== 0 && state !== 1)
                || numbers.slice(4).some(at => at < 0)) { native.error = "invalid native sample"; continue; }
            const [at, parentDead, childDead, otherDead, parentExit, childExit] = numbers as [number, number, number, number, number, number];
            native.samples.push({ at, parentDead, childDead, otherDead, parentExit, childExit });
          } else native.error = "invalid observer protocol";
        }
      }
    });
  });
  let unrelated: Bun.Subprocess | undefined;
  let gate: Promise<number> | undefined;
  let gateCaller: Bun.Subprocess | undefined;
  let callerExitedAt = 0;
  let callerEvidence: { pid: number; calledAt: number; settledAt: number; code: number } | undefined;
  let observer: Bun.Subprocess | undefined;
  let observerOutput: Promise<string> | undefined;
  let observerTimer: ReturnType<typeof setTimeout> | undefined;
  let fixtureStartedAt = 0;
  const script = join(root, "descendant.ts");
  const parentReady = join(root, "parent-ready");
  const term = join(root, "parent-term");
  const quote = (value: string) => `'${value.replace(/\\/g, "/").replace(/'/g, `'"'"'`)}'`;
  const diagnosticState = () => ({
    native: { error: native.error, preparedAt: native.preparedAt, boundAt: native.boundAt, sampleCount: native.samples.length, latestSample: native.samples.at(-1) ?? null, cleanup: native.cleanup },
    observer: { exitCode: observer?.exitCode ?? null, signalCode: observer?.signalCode ?? null, ...observerTiming, remainingMs: oracleDeadline - Date.now() },
    peers: ["observer", "owned", "unrelated"].map(role => ({
      role, registered: peers.has(role), pid: peers.get(role)?.pid ?? null, closed: peers.get(role)?.closed ?? null,
    })),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("W775_FIXTURE_OWNERSHIP_UNCONFIRMED: no listener");
    if (process.platform === "win32") {
      const shell = resolveBashLaunch();
      if (!shell) throw new Error("W775_FIXTURE_STARTUP_UNCONFIRMED: no native shell");
      const psQuote = (text: string) => `'${text.replace(/'/g, "''")}'`;
      const observerPath = join(root, "observer.ps1");
      writeFileSync(observerPath, `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${WINDOWS_WITNESS}\n'@\n[W775Witness]::Run(${address.port}, ${psQuote(token)}, ${psQuote(process.execPath)}, ${psQuote(shell.executable)}, ${process.pid}, ${oracleDeadline - 1500})\n`);
      observerTiming.spawnAt = Date.now();
      const nativeObserver = Bun.spawn([requireRuntimeExecutable("powershell"), "-NoProfile", "-NonInteractive", "-File", observerPath], {
        stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true,
      });
      observer = nativeObserver;
      observerOutput = Promise.all([new Response(nativeObserver.stdout).text(), new Response(nativeObserver.stderr).text()]).then(parts => parts.join("\n"));
      const heldObserver = observer;
      observerTimer = setTimeout(() => { try { heldObserver.kill("SIGKILL"); } catch { /* already exited */ } }, Math.max(1, oracleDeadline - Date.now() - 100));
      // Leave room for unchanged timeout/grace and independent cleanup. Failure
      // to prewarm within the existing oracle budget never qualifies as RED.
      while (!observerTiming.readyAt && !native.error && observer.exitCode === null && Date.now() < observerTiming.cutoffAt) await Bun.sleep(10);
      if (!observerTiming.readyAt || native.error) throw new Error(`W775_FIXTURE_STARTUP_UNCONFIRMED: ${native.error || "native witness not ready within existing budget"}`);
    }
    // Cleanup authority is an authenticated, retained connection to this exact
    // fixture process, independent of the disappearing shell/PID. No PID kill.
    // A self-expiry also bounds cleanup if the test runner itself is killed.
    writeFileSync(script, `
import { connect } from "node:net";
import { writeFileSync } from "node:fs";
const role = process.argv[2];
const finish = (code: number, reason: string) => {
  writeFileSync(${JSON.stringify(join(root, "child-end-"))} + role, reason);
  process.exit(code);
};
setTimeout(() => finish(91, "expiry"), Math.max(1, Math.min(7000, ${oracleDeadline - 1500} - Date.now())));
process.on("SIGTERM", () => {});
const socket = connect(${address.port}, "127.0.0.1", () => {
  socket.write(${JSON.stringify(token)} + ":" + role + ":" + process.pid + "\\n");
  writeFileSync(${JSON.stringify(join(root, "child-ready-"))} + role, "ready");
});
socket.on("error", () => finish(92, "socket-error"));
socket.on("close", () => finish(0, "socket-close"));
let input = "";
socket.on("data", chunk => {
  input += chunk.toString();
  if (input.includes("stop\\n")) finish(0, "cooperative-stop");
});
setInterval(() => socket.write("beat\\n"), 20);
`);
    observerTiming.gateRemainingMs = oracleDeadline - Date.now();
    if (observerTiming.gateRemainingMs <= 2000 + 1000 + (observer ? 0 : 1000) + 2500) throw new Error("W775_FIXTURE_STARTUP_UNCONFIRMED: insufficient remaining timeout/grace/observation/cleanup budget before fixture spawn");
    fixtureStartedAt = Date.now();
    unrelated = Bun.spawn([process.execPath, script, "unrelated"], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true,
    });
    if (observer) {
      while (!peers.has("unrelated") && !native.error && unrelated.exitCode === null && Date.now() < observerTiming.cutoffAt) await Bun.sleep(10);
      const other = peers.get("unrelated");
      if (!other || other.closed || other.pid !== unrelated.pid || native.error || Date.now() >= observerTiming.cutoffAt)
        throw new Error(`W775_FIXTURE_STARTUP_UNCONFIRMED: ${native.error || "unrelated child not authenticated within prewarm budget"}`);
      peers.get("observer")!.socket.write(`prepare|${other.pid}\n`);
      while (!native.preparedAt && !native.error && Date.now() < observerTiming.cutoffAt) await Bun.sleep(10);
      if (!native.preparedAt || native.error || Date.now() >= observerTiming.cutoffAt)
        throw new Error(`W775_FIXTURE_OWNERSHIP_UNCONFIRMED: ${native.error || "unrelated preparation incomplete within prewarm budget"}`);
    }
    const command = `trap ${quote(`printf term > ${quote(term)}; exit 0`)} TERM; `
      + `${quote(process.execPath)} ${quote(script)} owned & child=$!; `
      + `while [ ! -f ${quote(join(root, "child-ready-owned"))} ]; do sleep 0.01; done; `
      + `printf ready > ${quote(parentReady)}; wait "$child"`;
    const started = Date.now();
    observerTiming.gateRemainingMs = oracleDeadline - started;
    if (observerTiming.gateRemainingMs <= 2000 + 1000 + (observer ? 0 : 1000) + 2500) throw new Error("W775_FIXTURE_STARTUP_UNCONFIRMED: insufficient remaining timeout/grace/observation/cleanup budget before production gate spawn");
    observerTiming.gateCallAt = started;
    bindingAllowed = Boolean(observer);
    if (observer) gate = runGateCommand(command, join(root, "stdout"), join(root, "stderr"), 2, 1);
    else {
      // A Promise settlement cannot prove the calling Bun can exit naturally.
      // Exercise the SAME production function in an authored caller with no
      // process.exit(), forced kill or IPC reference supplied by this fixture.
      const callerPath = join(root, "caller.ts"), evidencePath = join(root, "caller-result.json");
      writeFileSync(callerPath, `import { writeFileSync } from "node:fs";
import { runGateCommand } from ${JSON.stringify(new URL("./scripts/gate_command.ts", import.meta.url).href)};
const calledAt = Date.now();
const code = await runGateCommand(${JSON.stringify(command)}, ${JSON.stringify(join(root, "stdout"))}, ${JSON.stringify(join(root, "stderr"))}, 2, 1);
writeFileSync(${JSON.stringify(evidencePath)}, JSON.stringify({ pid: process.pid, calledAt, settledAt: Date.now(), code }));
process.exitCode = code;
`);
      gateCaller = Bun.spawn([process.execPath, callerPath], { stdin: "ignore", stdout: "ignore", stderr: "inherit" });
      const heldCaller = gateCaller;
      void heldCaller.exited.then(() => { callerExitedAt = Date.now(); });
      gate = (async () => {
        // Conservative outer bound includes caller startup; it never grants a
        // fresh production allowance. Scheduling overrun is unconfirmed.
        while (!callerExitedAt && Date.now() < started + 4000) await Bun.sleep(10);
        if (!callerExitedAt || callerExitedAt > started + 4000) {
          heldCaller.unref(); // not termination; retain scratch/ownership evidence
          return 125;
        }
        if (existsSync(evidencePath)) callerEvidence = JSON.parse(readFileSync(evidencePath, "utf8"));
        return heldCaller.exitCode ?? 125;
      })();
    }
    const armedBy = Date.now();
    if (observer) {
      while ((!peers.has("owned") || !peers.has("unrelated")) && Date.now() < started + 2000) await Bun.sleep(10);
      const owned = peers.get("owned"), other = peers.get("unrelated");
      if (!owned || !other) throw new Error("W775_FIXTURE_STARTUP_UNCONFIRMED: missing authenticated peers before timeout");
      while (!native.boundAt && !native.error && Date.now() < started + 2000) await Bun.sleep(10);
      if (native.error || !native.boundAt || native.boundAt >= started + 2000) throw new Error(`W775_FIXTURE_OWNERSHIP_UNCONFIRMED: ${native.error || "handles not validated before deadline"}`);
      let terminal: number | undefined;
      const completed = gate.then(code => { terminal = code; return code; });
      const observationEnd = Math.min(fixtureStartedAt + 6500, oracleDeadline - 2500);
      let boundary: NativeSample | undefined;
      while (Date.now() < observationEnd && !native.error && !native.cleanup) {
        const firstExit = native.samples.find(sample => sample.parentDead === 1);
        const latest = native.samples.at(-1);
        if (firstExit && latest && terminal !== undefined && latest.at >= firstExit.at + 1000) { boundary = { ...latest }; break; }
        await Bun.sleep(10);
      }
      // Everything below observes immutable pre-cleanup evidence. Neither the
      // finally block, witness watchdog nor the child's bounded expiry may make GREEN.
      if (!boundary || native.error || native.cleanup || Date.now() >= observationEnd) throw new Error(`W775_FIXTURE_BUDGET_UNCONFIRMED: ${native.error || "no pre-cleanup boundary"}`);
      if (existsSync(join(root, "child-end-owned")) || existsSync(join(root, "child-end-unrelated"))) throw new Error("W775_FIXTURE_EXIT_UNCONFIRMED: voluntary exit, socket failure or self-expiry preceded acceptance");
      const firstExit = native.samples.find(sample => sample.parentDead === 1)!;
      const before = native.samples.filter(sample => sample.at < started + 2000);
      if (!before.length || before.some(sample => sample.parentDead || sample.childDead || sample.otherDead)
          || firstExit.parentExit < armedBy + 2000) throw new Error("W775_FIXTURE_TIMING_UNCONFIRMED: parent not proven alive before and exited after actual deadline");
      const grace = native.samples.filter(sample => sample.at >= firstExit.at && sample.at <= boundary.at);
      const beats = owned.beats.filter(at => at >= firstExit.at && at <= boundary.at);
      if (boundary.childDead === 0 && (grace.some(sample => sample.childDead)
          || beats.length < 2 || beats[0]! > firstExit.at + 250 || beats.at(-1)! < boundary.at - 250
          || beats.some((at, i) => i > 0 && at - beats[i - 1]! > 250))) throw new Error("W775_FIXTURE_LIVENESS_UNCONFIRMED: survival not continuous through grace");
      if (grace.some((sample, i) => i > 0 && sample.at - grace[i - 1]!.at > 250)
          || (boundary.childDead === 1 && boundary.childExit < armedBy + 2000)) throw new Error("W775_FIXTURE_TIMING_UNCONFIRMED: observation gap or early child exit");
      console.log(`W775 native pre_cleanup=${JSON.stringify({ started, armedBy, ...observerTiming, boundAt: native.boundAt, firstExit, boundary, heartbeatCount: beats.length, code: terminal })}`);
      expect(boundary.otherDead, "W775_UNRELATED_PROCESS_TERMINATED").toBe(0);
      expect(grace.every(sample => sample.otherDead === 0), "W775_UNRELATED_PROCESS_TERMINATED").toBe(true);
      expect([124, 137], "W775_FIXTURE_TIMEOUT_UNCONFIRMED").toContain(await completed);
      expect(boundary.childDead, "W775_OWNED_DESCENDANT_SURVIVED_GRACE: qualified native pre-cleanup observation").toBe(1);
      return;
    }
    let observedTermAt = 0;
    const until = started + 4000;
    while (Date.now() < until && !existsSync(term)) await Bun.sleep(10);
    if (existsSync(term)) observedTermAt = Date.now();
    const code = await gate;
    while (observedTermAt && Date.now() < observedTermAt + 1100 && Date.now() < until) await Bun.sleep(10);
    if (observedTermAt && Date.now() < observedTermAt + 1000)
      throw new Error("W775_FIXTURE_BUDGET_UNCONFIRMED: full observed TERM grace unavailable within settlement policy");
    const owned = peers.get("owned");
    const other = peers.get("unrelated");
    console.log(`W775 tree platform=${process.platform} code=${code} parent_ready=${existsSync(parentReady)} term=${observedTermAt > 0} owned_closed=${owned?.closed} owned_last_beat=${owned?.lastBeat} unrelated_closed=${other?.closed} caller=${JSON.stringify({ pid: gateCaller?.pid, callerExitedAt, signal: gateCaller?.signalCode, evidence: callerEvidence, policyDeadline: started + 4000 })}`);
    if (!callerEvidence || callerEvidence.pid !== gateCaller?.pid || callerEvidence.code !== code ||
        callerEvidence.calledAt < started || callerEvidence.settledAt < callerEvidence.calledAt ||
        callerEvidence.settledAt > callerEvidence.calledAt + 4000 || !callerExitedAt ||
        callerExitedAt > started + 4000 || gateCaller?.signalCode)
      throw new Error("W775_FIXTURE_PARENT_SETTLEMENT_UNCONFIRMED: actual natural caller exit/settlement missing or late; cleanup is separate");
    expect(existsSync(parentReady), "W775_FIXTURE_STARTUP_UNCONFIRMED").toBe(true);
    expect(observedTermAt, "W775_FIXTURE_TERM_UNCONFIRMED: native termination did not execute the TERM trap; not defect RED evidence").toBeGreaterThan(0);
    expect(owned, "W775_FIXTURE_OWNERSHIP_UNCONFIRMED").toBeDefined();
    expect(other?.closed, "W775_UNRELATED_PROCESS_TERMINATED").toBe(false);
    expect([124, 137]).toContain(code);
    expect(owned?.closed, "W775_OWNED_DESCENDANT_SURVIVED_GRACE").toBe(true);
  } catch (error) {
    console.error(`W775 observation_error=${JSON.stringify({
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
      ...diagnosticState(),
    })}`);
    throw error;
  } finally {
    bindingAllowed = false;
    // Connection identity cannot be reused like a PID. An unknown owner never
    // authorizes a kill: await bounded self-expiry and fail cleanup explicitly.
    for (const [role, peer] of peers) if (role !== "observer" && !peer.closed) peer.socket.write("stop\n");
    if (observer) {
      peers.get("observer")?.socket.write("cleanup\n");
      await observer.exited;
      if (observerTimer) clearTimeout(observerTimer);
      const diagnostic = await observerOutput;
      console.log(`W775 native cleanup=${native.cleanup || "unconfirmed"} ${diagnostic?.trim() || ""}`);
    }
    if (gate) await gate;
    if (unrelated) await unrelated.exited;
    if (gate && !peers.has("owned")) {
      const expiry = observer ? Math.min(fixtureStartedAt + 7500, oracleDeadline - 100) : fixtureStartedAt + 7500;
      while (Date.now() < expiry) await Bun.sleep(10);
    }
    const cleanupDeadline = observer ? Math.min(Date.now() + 7500, oracleDeadline - 100) : Date.now() + 7500;
    while ([...peers.values()].some(peer => !peer.closed) && Date.now() < cleanupDeadline) await Bun.sleep(10);
    const unconfirmed = [...peers.values()].some(peer => !peer.closed);
    for (const socket of connections) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    const callerUnconfirmed = Boolean(gateCaller && (!callerExitedAt || gateCaller.exitCode === null));
    if (callerUnconfirmed) gateCaller!.unref();
    if (!unconfirmed && !callerUnconfirmed) rmSync(root, { recursive: true, force: true });
    console.error(`W775 cleanup_state=${JSON.stringify({
      ...diagnosticState(),
      rejection: { unconfirmed, callerUnconfirmed, missingOwnedPeer: Boolean(gate && !peers.has("owned")), nativeCleanupUnconfirmed: Boolean(observer && gate && native.cleanup !== "confirmed") },
    })}`);
    if (unconfirmed || callerUnconfirmed || (gate && !peers.has("owned")) || (observer && gate && native.cleanup !== "confirmed")) throw new Error("W775_FIXTURE_CLEANUP_UNCONFIRMED: retained handle/connection missing or did not close; no PID kill authorized");
  }
}

/** STOP-capable fixture: source review by Dock is mandatory before execution.
 * This test process is the independent witness, outside the target session.
 * Linux x86-64 syscall ABI: pidfd_open=434, pidfd_send_signal=424.
 * https://github.com/torvalds/linux/blob/v6.8/arch/x86/entry/syscalls/syscall_64.tbl
 * No numeric process/group signaling fallback, including in finally. */
async function assertRefusalNaturalExit(oracleDeadline: number): Promise<void> {
  const preparationEnd = oracleDeadline - 6500;
  const timing: Record<string, number> = { caseEntry: Date.now(), preparationEnd, oracleDeadline,
    scriptWriteBegin: 0, scriptWriteEnd: 0, unrelatedSpawn: 0, callerSpawn: 0,
    nativeAcquisitionBegin: 0, nativeAcquisitionEnd: 0, contQualifiedAt: 0, ackAt: 0, failure: 0, cleanupEntry: 0 };
  console.log(`W775 refusal preparation=${JSON.stringify(timing)}`);
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("W775_REFUSAL_PLATFORM_UNCONFIRMED: retained Linux x86-64 pidfd witness unavailable");
  if (oracleDeadline - Date.now() <= 7500)
    throw new Error("W775_REFUSAL_BUDGET_UNCONFIRMED: 1000ms preparation plus 4000ms observation plus 2500ms cleanup unavailable");
  const { dlopen } = await import("bun:ffi");
  const native = dlopen("libc.so.6", {
    syscall: { args: ["i64", "i64", "i64", "i64", "i64"], returns: "i64" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  });
  const root = mkdtempSync(join(tmpdir(), "garelier-w775-refusal-"));
  const nonce = randomUUID(), challenge = randomUUID(), executable = realpathSync(process.execPath);
  const entry = resolve(import.meta.dir, "scripts/gate_command.ts");
  const commandFile = join(root, "command.ts"), callerFile = join(root, "caller.ts");
  const resultFile = join(root, "returned.json"), termFile = join(root, "term.json"), diagnosticFile = join(root, "caller.stderr");
  const snapshot = (pid: number) => {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid witness PID");
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (fields.length < 20 || !/^\d+$/.test(fields[19]!)) throw new Error("native creation unavailable");
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]),
      creation: fields[19]!, image: readlinkSync(`/proc/${pid}/exe`),
      argv: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean), state: fields[0]! };
  };
  type Identity = ReturnType<typeof snapshot>;
  const identity = ({ state: _state, ...rest }: Identity) => JSON.stringify(rest);
  const held = new Map<string, { fd: number; identity: Identity; closeAttempted?: boolean; closed?: boolean }>();
  const dead = (fd: number) => {
    const p = Buffer.alloc(8); p.writeInt32LE(fd); p.writeInt16LE(1, 4);
    const count = native.symbols.poll(p, 1n, 0), flags = p.readInt16LE(6);
    if (count < 0 || (flags & ~17)) throw new Error(`pidfd poll unconfirmed count=${count} flags=${flags}`);
    return count > 0 && Boolean(flags & 17); // POLLIN/POLLHUP, never POLLNVAL
  };
  const hold = (role: string, pid: number, argv: string[]) => {
    timing[`${role}AcquisitionBegin`] = Date.now();
    const before = snapshot(pid);
    if (before.image !== executable || JSON.stringify(before.argv) !== JSON.stringify(argv)) throw new Error(`${role} exact image/entry mismatch`);
    const fd = Number(native.symbols.syscall(434n, BigInt(pid), 0n, 0n, 0n));
    if (!Number.isSafeInteger(fd) || fd < 0) throw new Error(`${role} pidfd_open unavailable`);
    held.set(role, { fd, identity: before }); // retained even on later validation failure
    const after = snapshot(pid);
    const fdPid = /^Pid:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
    if (!fdPid || Number(fdPid[1]) !== pid || identity(before) !== identity(after) || dead(fd))
      throw new Error(`${role} post-acquisition identity unconfirmed`);
    timing[`${role}AcquisitionEnd`] = Date.now();
    return after;
  };
  type Peer = { socket: Socket; report: Identity; closed: boolean; beats: number[] };
  const peers = new Map<string, Peer>(), connections = new Set<Socket>();
  let protocolError = "", armed = false, ackAt = 0, stoppedAt = 0, continuedAt = 0;
  let cleaning = false, contQualifiedAt = 0;
  const closedConnections = new Set<Socket>();
  let caller: Bun.Subprocess | undefined, unrelated: Bun.Subprocess | undefined, callerExitAt = 0;
  let primary: unknown, boundary: unknown;
  const server = createServer(socket => {
    connections.add(socket); let buffer = "", role = "";
    socket.on("error", error => { protocolError ||= String(error); });
    socket.on("close", () => { closedConnections.add(socket); const peer = peers.get(role); if (peer) peer.closed = true; });
    if (cleaning) { socket.destroy(); return; } // no late admission, including unauthenticated peers
    socket.on("data", data => {
      if (cleaning) { socket.destroy(); return; }
      buffer += data.toString();
      if (buffer.length > 8192) { protocolError = "oversized witness message"; socket.destroy(); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (!role) {
            if (message.nonce !== nonce || !["owned", "unrelated"].includes(message.role) || peers.has(message.role)) throw new Error("witness authentication rejected");
            role = message.role;
            timing[`${role}PeerArrival`] = Date.now();
            peers.set(role, { socket, report: message.identity, closed: false, beats: [] });
          } else if (message.beat === challenge) peers.get(role)!.beats.push(Date.now());
          else throw new Error("unexpected witness message");
        } catch (error) { protocolError ||= String(error); socket.destroy(); }
      }
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("witness listener unavailable");
    timing.scriptWriteBegin = Date.now();
    writeFileSync(commandFile, `import { connect } from "node:net";
import { writeFileSync } from "node:fs";
import { dlopen } from "bun:ffi";
const lib = dlopen("libc.so.6", { getpid:{args:[],returns:"i32"}, getppid:{args:[],returns:"i32"}, getpgrp:{args:[],returns:"i32"}, getsid:{args:["i32"],returns:"i32"}, kill:{args:["i32","i32"],returns:"i32"} });
const a = lib.symbols, role = process.argv[2];
// Production's launch precedes command entry. This fixed conservative safety
// upper bound is NOT production T; the witness still requires exact diagnostic T.
const enteredAt = Date.now(), observationUpperBound = enteredAt + 4000;
const current = () => ({pid:a.getpid(),ppid:a.getppid(),pgid:a.getpgrp(),sid:a.getsid(0)});
const socket = connect(${address.port}, "127.0.0.1");
let acknowledged = false, disarmed = false, stopAttempted = false, expectedGroup = 0, buffer = "";
const disarm = code => { disarmed=true; acknowledged=false; process.exit(code); };
socket.on("connect", () => socket.write(JSON.stringify({nonce:${JSON.stringify(nonce)},role,identity:current()})+"\\n"));
socket.on("data", data => { buffer += data.toString(); let end; while ((end=buffer.indexOf("\\n"))>=0) {
 const line=buffer.slice(0,end); buffer=buffer.slice(end+1);
 if (line === "stop") disarm(0);
 const m=JSON.parse(line); if(m.challenge!==${JSON.stringify(challenge)}) process.exit(96);
 expectedGroup=m.group; acknowledged=true;
}});
socket.on("error", () => disarm(95));
socket.on("close", () => disarm(95));
setInterval(() => { if(acknowledged) socket.write(JSON.stringify({beat:${JSON.stringify(challenge)}})+"\\n"); }, 25);
process.on("SIGTERM", () => {
 const proof=current(), at=Date.now();
 if(stopAttempted) return;
 const remainingObservation=Math.max(0,observationUpperBound-at);
 if(role!=="owned" || disarmed || !acknowledged || proof.ppid!==expectedGroup || proof.pgid!==expectedGroup || proof.sid!==expectedGroup || ${oracleDeadline}-at<=remainingObservation+2500) disarm(97);
 stopAttempted=true;
 writeFileSync(${JSON.stringify(termFile)},JSON.stringify({at,acknowledged,proof,enteredAt,observationUpperBound,remainingObservation}));
 if(a.kill(0,19)!==0) process.exit(98); // current owned group SIGSTOP, only from real TERM handler
});
`);
    const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
    const command = `:; exec ${quote(process.execPath)} ${quote(commandFile)} owned`;
    writeFileSync(callerFile, `import { writeFileSync } from "node:fs";
import { runGateCommand } from ${JSON.stringify(new URL("./scripts/gate_command.ts", import.meta.url).href)};
const code=await runGateCommand(${JSON.stringify(command)},${JSON.stringify(join(root, "stdout"))},${JSON.stringify(join(root, "stderr"))},2,1);
writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({pid:process.pid,code,returnedAt:Date.now()}));
process.exitCode=code; // natural exit only; no process.exit or forced caller cleanup
`);
    timing.scriptWriteEnd = Date.now();
    timing.unrelatedSpawn = Date.now();
    unrelated = Bun.spawn([process.execPath, commandFile, "unrelated"], { stdin: "ignore", stdout: "ignore", stderr: "inherit", windowsHide: true });
    timing.callerSpawn = Date.now();
    caller = Bun.spawn([process.execPath, callerFile], { stdin: "ignore", stdout: "ignore", stderr: Bun.file(diagnosticFile), windowsHide: true });
    void caller.exited.then(() => { callerExitAt = Date.now(); });
    while (peers.size < 2 && !protocolError && Date.now() < preparationEnd) await Bun.sleep(5);
    if (peers.size !== 2 || protocolError || Date.now() >= preparationEnd) throw new Error(`W775_REFUSAL_STARTUP_UNCONFIRMED: ${protocolError || "acquisition preparation budget exhausted"}`);
    const ownedPeer = peers.get("owned")!, otherPeer = peers.get("unrelated")!;
    timing.nativeAcquisitionBegin = Date.now();
    const c = hold("caller", caller.pid, [process.execPath, callerFile]);
    const s = hold("supervisor", ownedPeer.report.ppid, [process.execPath, entry, "--garelier-private-gate-supervisor"]);
    const o = hold("owned", ownedPeer.report.pid, [process.execPath, commandFile, "owned"]);
    const u = hold("unrelated", unrelated.pid, [process.execPath, commandFile, "unrelated"]);
    const witness = snapshot(process.pid);
    for (const [peer, proof] of [[ownedPeer, o], [otherPeer, u]] as const)
      if (peer.closed || ["pid", "ppid", "pgid", "sid"].some(key => peer.report[key as keyof Identity] !== proof[key as keyof Identity])) throw new Error("authenticated identity/native snapshot mismatch");
    if (s.ppid !== c.pid || c.ppid !== process.pid || o.ppid !== s.pid || s.pid !== s.pgid || s.pid !== s.sid ||
        o.pgid !== s.pid || o.sid !== s.pid || u.ppid !== process.pid || [c.pgid, u.pgid, witness.pgid].includes(s.pid) ||
        BigInt(c.creation) > BigInt(s.creation) || BigInt(s.creation) > BigInt(o.creation)) throw new Error("ancestry/session/creation unconfirmed");
    for (const h of held.values()) if (dead(h.fd) || identity(snapshot(h.identity.pid)) !== identity(h.identity)) throw new Error("before-ACK retained identity changed");
    timing.nativeAcquisitionEnd = Date.now();
    // Actual signal18 permission on this retained identity must be established
    // BEFORE authorizing STOP. SIGCONT on a running target does not stop it.
    const supervisor = held.get("supervisor")!;
    const running = () => {
      const now = snapshot(s.pid);
      if (dead(supervisor.fd) || identity(now) !== identity(s) || !["R", "S"].includes(now.state))
        throw new Error("W775_REFUSAL_CONT_UNCONFIRMED: supervisor not independently live/running");
    };
    running();
    if (native.symbols.syscall(424n, BigInt(supervisor.fd), 18n, 0n, 0n) !== 0n)
      throw new Error("W775_REFUSAL_CONT_UNCONFIRMED: actual retained-fd signal18 rejected; no STOP authorized");
    running(); contQualifiedAt = Date.now(); timing.contQualifiedAt = contQualifiedAt;
    if (Date.now() >= preparationEnd || oracleDeadline - Date.now() <= 6500) throw new Error("W775_REFUSAL_BUDGET_UNCONFIRMED: before STOP authorization");
    armed = true; ackAt = Date.now(); timing.ackAt = ackAt;
    for (const peer of peers.values()) peer.socket.write(JSON.stringify({ challenge, group: s.pid }) + "\n");
    // T comes ONLY from this invocation's production diagnostic, never caller
    // entry, ACK arrival, observed TERM or a copied production timer formula.
    let diagnostic: any, returned: any;
    const samples: { at: number; callerDead: boolean; unrelatedDead: boolean }[] = [];
    while (Date.now() < oracleDeadline - 2500) {
      if (protocolError) throw new Error(protocolError);
      if (!stoppedAt && existsSync(termFile)) {
        let allStopped = true;
        for (const role of ["supervisor", "owned"]) {
          const h = held.get(role)!, now = snapshot(h.identity.pid);
          if (dead(h.fd) || identity(now) !== identity(h.identity)) throw new Error("W775_REFUSAL_STOP_UNCONFIRMED: retained identity lost");
          allStopped &&= now.state === "T";
        }
        if (allStopped) stoppedAt = Date.now(); // marker can precede kernel STOP
      }
      samples.push({ at: Date.now(), callerDead: dead(held.get("caller")!.fd), unrelatedDead: dead(held.get("unrelated")!.fd) });
      if (existsSync(resultFile)) returned = JSON.parse(readFileSync(resultFile, "utf8"));
      if (existsSync(diagnosticFile)) {
        for (const line of readFileSync(diagnosticFile, "utf8").split("\n")) {
          const prefix = "GARELIER_GATE_POSIX_UNCONFIRMED: {";
          if (line.startsWith(prefix)) { try { diagnostic = JSON.parse(line.slice(prefix.length - 1)); } catch { /* incomplete write */ } }
        }
      }
      if (diagnostic && returned && Number.isSafeInteger(diagnostic.settlementDeadline) && Date.now() >= diagnostic.settlementDeadline) break;
      await Bun.sleep(5);
    }
    const term = existsSync(termFile) ? JSON.parse(readFileSync(termFile, "utf8")) : null;
    if (!diagnostic || !Number.isSafeInteger(diagnostic.deadline) || !Number.isSafeInteger(diagnostic.settlementDeadline) ||
        diagnostic.supervisorPid !== s.pid || diagnostic.commandSha256 !== createHash("sha256").update(command).digest("hex") ||
        diagnostic.deadline + diagnostic.graceMs + 1000 !== diagnostic.settlementDeadline || diagnostic.graceMs !== 1000 ||
        diagnostic.ownership?.pid !== s.pid || diagnostic.ownership?.pgid !== s.pid || diagnostic.ownership?.sid !== s.pid ||
        !term || !Number.isSafeInteger(term.at) || term.at < diagnostic.deadline || ackAt >= diagnostic.deadline || !stoppedAt || !term.acknowledged ||
        term.proof?.pid !== o.pid || term.proof?.ppid !== s.pid || term.proof?.pgid !== s.pid || term.proof?.sid !== s.pid ||
        !Number.isSafeInteger(term.enteredAt) || term.at < term.enteredAt || term.observationUpperBound !== term.enteredAt + 4000 ||
        diagnostic.settlementDeadline > term.observationUpperBound || term.remainingObservation !== Math.max(0, term.observationUpperBound - term.at) ||
        oracleDeadline - term.at <= term.remainingObservation + 2500 || !contQualifiedAt || contQualifiedAt > ackAt ||
        !returned || !Number.isSafeInteger(returned.returnedAt))
      throw new Error("W775_REFUSAL_TIMING_UNCONFIRMED: exact production deadline/ownership/actual TERM unavailable");
    const T = diagnostic.settlementDeadline, E = T - 250;
    const boundaryAt = Date.now();
    const observationDeadline = oracleDeadline - 2500;
    const freshSampleAllowed = boundaryAt >= T && boundaryAt < observationDeadline;
    if (freshSampleAllowed)
      samples.push({ at: boundaryAt, callerDead: dead(held.get("caller")!.fd), unrelatedDead: dead(held.get("unrelated")!.fd) });
    const last = samples.at(-1)!;
    const predicates = {
      freshSampleUnavailable: !freshSampleAllowed,
      observationDeadlineExpired: Date.now() >= observationDeadline,
      lastBeforeT: last.at < T, lastUnrelatedDead: last.unrelatedDead, peerClosed: otherPeer.closed,
      anyUnrelatedDead: samples.some(sample => sample.unrelatedDead),
      sampleGapExceeded: samples.some((sample, i) => i > 0 && sample.at - samples[i - 1]!.at > 250),
      insufficientBeats: otherPeer.beats.length < 2, lastBeatTooOld: otherPeer.beats.at(-1)! < T - 100,
      beatGapExceeded: otherPeer.beats.some((at, i) => i > 0 && at - otherPeer.beats[i - 1]! > 250),
    };
    const aliveAfterT = samples.some(sample => sample.at >= T && !sample.callerDead);
    const naturalExit = Boolean(callerExitAt && callerExitAt <= T && caller.exitCode === 125 && !caller.signalCode);
    console.log(`W775 refusal boundary_predicates=${JSON.stringify({ E, T, boundaryAt, observationDeadline, predicates, last,
      maxSampleGap: samples.reduce((max, sample, i) => i ? Math.max(max, sample.at - samples[i - 1]!.at) : max, 0),
      beatCount: otherPeer.beats.length, lastBeatAt: otherPeer.beats.at(-1) ?? null,
      maxBeatGap: otherPeer.beats.reduce((max, at, i) => i ? Math.max(max, at - otherPeer.beats[i - 1]!) : max, 0),
      returned, callerExitAt, callerExitCode: caller.exitCode, callerSignalCode: caller.signalCode, aliveAfterT, naturalExit,
      phase: !returned ? "return-not-observed" : returned.returnedAt > T ? "return-processing-delay" : naturalExit ? "natural-exit-observed" : "postreturn-retention" })}`);
    if (Object.values(predicates).some(Boolean)) throw new Error("W775_REFUSAL_BOUNDARY_UNCONFIRMED: unrelated liveness/boundary unavailable");
    if (!naturalExit && !aliveAfterT && !(returned?.returnedAt > T))
      throw new Error("W775_REFUSAL_EXIT_TIMING_UNCONFIRMED: late observation alone cannot prove caller survived T");
    boundary = { E, T, ackAt, contQualifiedAt, stoppedAt, diagnostic, term, returned: returned ?? null, callerExitAt, last, aliveAfterT,
      phase: !returned ? "return-not-observed" : returned.returnedAt > T ? "return-processing-delay" : naturalExit ? "natural-exit-observed" : "postreturn-retention" };
    console.log(`W775 refusal pre_CONT=${JSON.stringify(boundary)}`);
    writeFileSync(join(root, "boundary.json"), JSON.stringify(boundary));
    expect(returned?.pid, "W775_REFUSAL_RESULT_UNCONFIRMED").toBe(c.pid);
    expect(returned?.code, "W775_REFUSAL_RESULT_UNCONFIRMED").toBe(125);
    expect(naturalExit, "W775_REFUSAL_CALLER_SURVIVED_BOUND: pre-CONT actual natural exit125 missing").toBe(true);
  } catch (error) {
    primary = error; timing.failure = Date.now();
    console.error(`W775 refusal primary=${String(error)} root=${root} preparation=${JSON.stringify({ timing,
      caller: caller ? { pid: caller.pid, exitCode: caller.exitCode, signalCode: caller.signalCode, callerExitAt } : null,
      unrelated: unrelated ? { pid: unrelated.pid, exitCode: unrelated.exitCode, signalCode: unrelated.signalCode } : null,
      peers: [...peers.entries()].map(([role, peer]) => ({ role, report: peer.report, closed: peer.closed })), identities: [...held.entries()] })}`);
    throw error;
  }
  finally {
    timing.cleanupEntry = Date.now();
    const cleanupEnd = Math.min(Date.now() + 2500, oracleDeadline);
    cleaning = true; // freezes admission before closing ANY socket or awaiting
    let cleanupError = "";
    let listenerClosed = false;
    let reparenting: { originalPpid: number; observedPpid: number; callerPidfdDead: boolean; observedAt: number } | undefined;
    // Close known AND unknown sockets now. The generated peer disarms on close;
    // an already executing synchronous TERM/STOP still needs retained T->CONT.
    for (const socket of connections) socket.destroy();
    try { server.close(error => { if (error) cleanupError ||= String(error); else listenerClosed = true; }); }
    catch (error) { cleanupError ||= String(error); }
    try {
      // Abort live authored peers first. If the command is already in its
      // synchronous TERM/STOP handler it cannot process this until resumed;
      // therefore wait for stable STOP/death before CONT, never race the marker.
      if (armed) {
        const supervisor = held.get("supervisor")!;
        const cleanupIdentity = () => {
          const now = snapshot(supervisor.identity.pid);
          if (now.ppid !== supervisor.identity.ppid) {
            const originalCaller = held.get("caller");
            const callerPidfdDead = Boolean(originalCaller && originalCaller.identity.pid === supervisor.identity.ppid && dead(originalCaller.fd));
            reparenting = { originalPpid: supervisor.identity.ppid, observedPpid: now.ppid, callerPidfdDead, observedAt: Date.now() };
            if (!callerPidfdDead) throw new Error("retained supervisor PPID changed without confirmed original caller death");
          }
          // Only cleanup may accept reparenting after retained caller-fd death.
          // Keep the original identity and every other field unchanged.
          if (identity({ ...now, ppid: supervisor.identity.ppid }) !== identity(supervisor.identity))
            throw new Error("retained supervisor identity changed before CONT");
          return now;
        };
        // The sole resume target is the retained fd, never a reacquired PID.
        if (!dead(supervisor.fd)) {
          let stopped = false;
          while (!dead(supervisor.fd) && Date.now() < cleanupEnd) {
            const now = cleanupIdentity();
            if (now.state === "T") { stopped = true; break; }
            await Bun.sleep(Math.min(5, Math.max(1, cleanupEnd - Date.now())));
          }
          if (stopped) {
            if (!dead(supervisor.fd)) {
              const now = cleanupIdentity();
              if (Date.now() >= cleanupEnd || now.state !== "T") throw new Error("STOP/budget unconfirmed immediately before CONT");
              if (!dead(supervisor.fd)) {
                if (native.symbols.syscall(424n, BigInt(supervisor.fd), 18n, 0n, 0n) !== 0n) throw new Error("retained pidfd CONT failed");
                continuedAt = Date.now();
              }
            }
          } else if (!dead(supervisor.fd)) throw new Error("STOP/death unconfirmed; no speculative CONT");
        }
      }
      // Only supervisor was resumed. Stopped command stays stopped until the
      // production group KILL. If hardDeadline was not assigned before STOP,
      // resumed production establishes its full actual grace; never force KILL.
      while (Date.now() < cleanupEnd && ([...held.values()].some(h => !dead(h.fd)) || caller?.exitCode === null || unrelated?.exitCode === null ||
          !listenerClosed || closedConnections.size !== connections.size)) await Bun.sleep(Math.min(5, Math.max(1, cleanupEnd - Date.now())));
      if (Date.now() >= cleanupEnd || [...held.values()].some(h => !dead(h.fd)) || (caller && caller.exitCode === null) || (unrelated && unrelated.exitCode === null) ||
          !listenerClosed || closedConnections.size !== connections.size)
        throw new Error("process/listener/socket closure unconfirmed within shared cleanup allowance");
    } catch (error) { cleanupError = String(error); }
    for (const child of [caller, unrelated]) {
      try { child?.unref(); } catch (error) { cleanupError ||= `unref unconfirmed: ${String(error)}`; }
    }
    if (!cleanupError) {
      for (const h of held.values()) {
        if (Date.now() >= cleanupEnd) { cleanupError ||= "pidfd close budget exhausted"; break; }
        h.closeAttempted = true;
        h.closed = native.symbols.close(h.fd) === 0;
        if (!h.closed) cleanupError ||= "pidfd close unconfirmed";
      }
      if (!cleanupError) {
        try { native.close(); } catch (error) { cleanupError = `native close unconfirmed: ${String(error)}`; }
      }
    }
    if (Date.now() >= cleanupEnd) cleanupError ||= "shared cleanup deadline exceeded";
    console.log(`W775 refusal cleanup=${JSON.stringify({ root, armed, contQualifiedAt, continuedAt, cleanupEnd, cleanupError, listenerClosed, reparenting, timing,
      caller: caller ? { pid: caller.pid, exitCode: caller.exitCode, signalCode: caller.signalCode, callerExitAt } : null,
      unrelated: unrelated ? { pid: unrelated.pid, exitCode: unrelated.exitCode, signalCode: unrelated.signalCode } : null,
      sockets: connections.size, socketsClosed: closedConnections.size, identities: [...held.entries()], boundaryCaptured: Boolean(boundary) })}`);
    // Retain this STOP-capable case's evidence for Dock. Recursive scratch
    // removal is not an additional unbounded cleanup operation after cleanupEnd.
    if (cleanupError) throw new AggregateError(primary ? [primary, new Error(cleanupError)] : [new Error(cleanupError)], `W775_REFUSAL_CLEANUP_UNCONFIRMED: retained scratch/ownership ${root}`);
  }
}

describe("runGateCommand (TypeScript implementation, W-063/W-094)", () => {
  test("bounds a TERM-ignoring command and escalates when needed", async () => {
    const { out, err } = files();
    const started = Date.now();
    const code = await runGateCommand('trap "" TERM; while :; do :; done', out, err, 1, 1);
    const elapsed = Date.now() - started;
    expect([124, 137]).toContain(code);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(8_000);
    if (process.platform !== "win32" && started + 15_000 - Date.now() <= 11500)
      throw new Error("W775_REFUSAL_BUDGET_UNCONFIRMED: preceding137 observation plus remaining125 preparation/observation/cleanup unavailable");
    await assertParentFirstTimeout(started + 15_000);
    if (process.platform !== "win32") await assertRefusalNaturalExit(started + 15_000);
  }, 15_000);

  test("preserves the real exit code of a fast command", async () => {
    const deadline = Date.now() + 4500; // inside the unchanged default test budget
    const root = mkdtempSync(join(tmpdir(), "garelier-w775-natural-exit-"));
    const token = randomUUID(), challenge = randomUUID();
    const ready = join(root, "ready"), ended = join(root, "ended");
    // Read-only native identity/wait handles; cleanup authority is exclusively
    // the authenticated fixture channel, never a PID lookup followed by kill.
    const native = process.platform === "win32" ? (await import("bun:ffi")).dlopen("kernel32.dll", {
      OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
      GetProcessId: { args: ["u64"], returns: "u32" },
      WaitForSingleObject: { args: ["u64", "u32"], returns: "u32" },
      CloseHandle: { args: ["u64"], returns: "i32" },
    }) : undefined;
    let handle = 0n, pid = 0, peer: Socket | undefined;
    let closed = false, alive = false, stopped = false, cleaning = false, ownershipError = "";
    const connections = new Set<Socket>();
    const server = createServer(socket => {
      connections.add(socket);
      let buffer = "", authenticated = false;
      socket.on("error", () => { /* closure/exit are verified below */ });
      socket.on("close", () => { connections.delete(socket); if (socket === peer) closed = true; });
      socket.on("data", data => {
        buffer += data.toString();
        if (buffer.length > 4096) { socket.destroy(); return; }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!authenticated) {
            const match = new RegExp(`^${token}:([0-9]+)$`).exec(line);
            if (!match || peer) { socket.destroy(); return; }
            const observed = Number(match[1]);
            if (!Number.isSafeInteger(observed) || observed <= 0) { socket.destroy(); return; }
            peer = socket; pid = observed; authenticated = true;
            if (native) {
              handle = native.symbols.OpenProcess(0x100000 | 0x1000, 0, pid);
              if (!handle || native.symbols.GetProcessId(handle) !== pid || native.symbols.WaitForSingleObject(handle, 0) !== 258)
                ownershipError = "authenticated child handle not confirmed before root exit";
            }
            if (cleaning) socket.write("stop\n");
          } else if (line === `alive:${challenge}`) alive = true;
          else if (line === "stopped") stopped = true;
        }
      });
    });
    const childDead = () => {
      if (!pid || ownershipError) return false;
      if (native) {
        if (!handle) return false;
        const state = native.symbols.WaitForSingleObject(handle, 0);
        if (state !== 0 && state !== 258) ownershipError = "retained child wait state unconfirmed";
        return state === 0;
      }
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    };
    let gate: Promise<number> | undefined, terminal: number | undefined, primary: unknown;
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("W775_NATURAL_STARTUP_UNCONFIRMED: listener");
      const script = join(root, "child.ts");
      writeFileSync(script, `import { connect } from "node:net";
import { writeFileSync } from "node:fs";
const socket = connect(${address.port}, "127.0.0.1");
let ending = false, buffer = "";
function finish(reason, code) {
  if (ending) return; ending = true;
  writeFileSync(${JSON.stringify(ended)}, reason);
  if (reason === "stop") socket.end("stopped\\n", () => process.exit(code));
  else process.exit(code);
}
socket.on("connect", () => socket.write(${JSON.stringify(token)} + ":" + process.pid + "\\n"));
socket.on("error", () => finish("socket-error", 94));
socket.on("close", () => { if (!ending) finish("socket-close", 94); });
socket.on("data", data => {
  buffer += data.toString(); let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (line === "arm") writeFileSync(${JSON.stringify(ready)}, "ready");
    else if (line === "probe:${challenge}") socket.write("alive:${challenge}\\n");
    else if (line === "stop") finish("stop", 0);
  }
});
setTimeout(() => { writeFileSync(${JSON.stringify(ended)}, "expiry"); process.exit(92); }, Math.max(1, ${deadline - 500} - Date.now()));
`);
      const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
      const command = `${quote(requireRuntimeExecutable("bun"))} ${quote(script)} & deadline=$((SECONDS+2)); while [ ! -f ${quote(ready)} ]; do [ ! -f ${quote(ended)} ] && [ "$SECONDS" -lt "$deadline" ] || exit 96; done; exit 7`;
      gate = runGateCommand(command, join(root, "stdout"), join(root, "stderr"), 30, 1).then(code => { terminal = code; return code; });
      while (!peer && terminal === undefined && Date.now() < deadline - 1000) await Bun.sleep(10);
      if (!peer || closed || ownershipError) throw new Error(`W775_NATURAL_STARTUP_UNCONFIRMED: ${ownershipError || "no live authenticated child"}`);
      peer.write("arm\n"); // retained identity established before shell may exit
      expect(await gate).toBe(7);
      peer.write(`probe:${challenge}\n`); // response must be authored AFTER root completion
      while (!alive && !closed && Date.now() < deadline - 1000) await Bun.sleep(10);
      expect(alive && !closed && !childDead() && !ownershipError && !existsSync(ended), "W775_NATURAL_DESCENDANT_TERMINATED: pre-cleanup survival").toBe(true);
    } catch (error) { primary = error; throw error; }
    finally {
      cleaning = true;
      peer?.write("stop\n");
      if (gate) {
        try { await gate; }
        catch (error) { primary ??= error; }
      }
      while ((!closed || !childDead()) && Date.now() < deadline) await Bun.sleep(10);
      // A killed child on a failing candidate may have no stop ACK; its stable
      // signaled handle still proves cleanup. An ACK alone never proves exit.
      let confirmed = Boolean(peer && closed && childDead());
      if (native && handle && !native.symbols.CloseHandle(handle)) confirmed = false;
      for (const socket of connections) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      native?.close();
      console.log(`W775 natural cleanup=${confirmed ? "confirmed" : "unconfirmed"} stopped=${stopped} root=${root}`);
      if (confirmed) rmSync(root, { recursive: true, force: true });
      else throw new AggregateError(primary ? [primary, new Error("W775_NATURAL_CLEANUP_UNCONFIRMED")] : [new Error("W775_NATURAL_CLEANUP_UNCONFIRMED")], `retained scratch: ${root}`);
    }
  });

  test("captures stdout for a fast success", async () => {
    const { out, err } = files();
    expect(await runGateCommand("printf captured-stdout", out, err, 30, 1)).toBe(0);
    expect(readFileSync(out, "utf8").trim()).toBe("captured-stdout");
    expect(readFileSync(err, "utf8")).toBe("");
    // W-775 G2: merge-gate.ts picks a transient retry from the returned integer
    // alone — it excludes 125 and admits 127 — so a diagnostic sink that throws
    // must never be able to relaunch a command whose cleanup is unconfirmed.
    // Every terminal return in gate_command.ts reports through reportedExit, so
    // this pins the property the escaping append/console call used to break.
    let reports = 0;
    const unavailableSink = () => { reports++; throw new Error("diagnostic sink unavailable"); };
    expect(reportedExit(125, unavailableSink)).toBe(125); // cleanup unconfirmed stays terminal
    expect(reportedExit(127, unavailableSink)).toBe(127); // pre-start failure stays retryable
    expect(reportedExit(0, () => { reports++; })).toBe(0);
    expect(reports).toBe(3); // each report attempted exactly once, never replayed
    // The Windows native-failure site runs that path for real: a command line
    // past the documented 32767-character limit fails before the shell resumes,
    // so it keeps the retryable 127 and still writes its diagnostic.
    if (process.platform === "win32") {
      const overlong = await runGateCommand(`printf ${"x".repeat(40_000)}`, out + ".g2", err + ".g2", 30, 1);
      expect(overlong).toBe(127);
      expect(readFileSync(err + ".g2", "utf8")).toContain("GARELIER_GATE_NATIVE_FAILURE: Windows gate command line too long");
    }
  });
});
