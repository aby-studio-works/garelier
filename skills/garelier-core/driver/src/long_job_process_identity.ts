import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolveRuntimeExecutable } from "./scripts/_lib.ts";

/** Native creation tokens are opaque: never round them or accept PID existence
 * as generation proof. Missing legacy tokens must not be backfilled. */
export interface LongJobProcessIdentity {
  pid: number;
  host: string;
  creation: string;
}

export type LongJobProcessObservation =
  | { state: "present"; identity: LongJobProcessIdentity }
  | { state: "absent" }
  | { state: "unknown"; reason: string };

/** Read-only, bounded native observation. Reuses the runtime executable resolver
 * and integration_closure's procfs field parsing, but retains exact creation
 * tokens instead of its tolerance-based epoch approximation. */
export function observeLongJobProcess(pid: number): LongJobProcessObservation {
  const unknown = (reason: string): LongJobProcessObservation => ({ state: "unknown", reason });
  if (!Number.isSafeInteger(pid) || pid < 1) return unknown("invalid-pid");
  try {
    if (process.platform === "win32") {
      const executable = resolveRuntimeExecutable("powershell") ?? resolveRuntimeExecutable("pwsh");
      if (!executable) return unknown("native-probe-unavailable");
      // One Process object binds Id, StartTime and exit observation to the same
      // native process. A failed query is NOT evidence of absence.
      const script = `try {
        $p = Get-Process -Id ${pid} -ErrorAction Stop
        $creation = $p.StartTime.ToFileTimeUtc().ToString([cultureinfo]::InvariantCulture)
        $p.Refresh()
        if ($p.HasExited) { 'absent' }
        elseif ($p.Id -eq ${pid} -and $creation -eq $p.StartTime.ToFileTimeUtc().ToString([cultureinfo]::InvariantCulture)) { "$($p.Id):$creation" }
        else { 'unknown' }
      } catch {
        if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId,*') { 'absent' } else { 'unknown' }
      }`;
      const result = spawnSync(executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, timeout: 5_000, maxBuffer: 4096, encoding: "utf8",
      });
      if (result.error || result.status !== 0) return unknown("native-probe-failed");
      const output = result.stdout.trim();
      if (output === "absent") return { state: "absent" };
      const match = /^(\d+):([1-9]\d*)$/.exec(output);
      if (!match || Number(match[1]) !== pid) return unknown("native-identity-unconfirmed");
      return { state: "present", identity: { pid, host: hostname(), creation: `win32-filetime:${match[2]}` } };
    }
    if (process.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      if (!/^[0-9a-f-]{36}$/.test(boot)) return unknown("native-boot-unconfirmed");
      const readIdentity = (): string | null => {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        if (!stat.startsWith(`${pid} (`) || !/^[0-9]+$/.test(fields[19] ?? "")) return null;
        return `${fields[0]}:${fields[19]}`;
      };
      const first = readIdentity();
      let second: string | null;
      try { second = readIdentity(); }
      catch { return unknown("native-identity-unstable"); }
      if (!first || !second || first.split(":")[1] !== second.split(":")[1]) return unknown("native-identity-unstable");
      const [state, ticks] = second.split(":");
      if (state === "Z" || state === "X") return first === second ? { state: "absent" } : unknown("native-identity-unstable");
      if (!/^[RSDTtWI]$/.test(state ?? "")) return unknown("native-state-unconfirmed");
      return { state: "present", identity: { pid, host: hostname(), creation: `linux-startticks:${boot}:${ticks}` } };
    }
    return unknown("native-platform-unsupported");
  } catch (error) {
    // ENOENT from the per-PID proc record is positive absence; unreadable
    // procfs/boot identity and all other failures remain unknown.
    if (process.platform === "linux" && (error as NodeJS.ErrnoException).code === "ENOENT"
      && (error as NodeJS.ErrnoException).path === `/proc/${pid}/stat`) return { state: "absent" };
    return unknown("native-probe-failed");
  }
}

export function publishedLongJobProcessIdentity(pid: number): LongJobProcessIdentity | undefined {
  if (pid !== process.pid) return undefined;
  if (process.platform === "win32" && process.arch === "x64") {
    try {
      // Load only after the self guard. Missing FFI is unavailable, never a
      // reason to reacquire a numeric PID or fall back to a late observation.
      const { dlopen } = require("bun:ffi") as typeof import("bun:ffi");
      const native = dlopen("kernel32.dll", {
        // HANDLE is an opaque 64-bit value, not a JS-number address (ptr).
        GetCurrentProcess: { args: [], returns: "u64" },
        GetProcessId: { args: ["u64"], returns: "u32" },
        GetProcessTimes: { args: ["u64", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
      });
      try {
        const self = native.symbols.GetCurrentProcess();
        if (self === 0n || native.symbols.GetProcessId(self) !== pid) return undefined;
        const creation = new Uint8Array(8);
        const exit = new Uint8Array(8);
        const kernel = new Uint8Array(8);
        const user = new Uint8Array(8);
        if (native.symbols.GetProcessTimes(self, creation, exit, kernel, user) === 0) return undefined;
        // FILETIME is two little-endian DWORDs. Read all 64 bits directly;
        // never convert through Date, milliseconds or a rounded Number.
        const ticks = new DataView(creation.buffer).getBigUint64(0, true);
        if (ticks === 0n) return undefined;
        return { pid, host: hostname(), creation: `win32-filetime:${ticks.toString(10)}` };
      } finally {
        native.close(); // unload the library only; NEVER close the pseudo handle
      }
    } catch { return undefined; }
  }
  const observed = observeLongJobProcess(pid);
  return observed.state === "present" ? observed.identity : undefined;
}

/** Sent only on the private channel inherited by this particular Bun spawn.
 * A nonce supplied on the command line is never an execution capability. */
export interface OwnedChildBinding {
  version: 1;
  root: string;
  job: string;
  attempt: number;
  digest: string;
  nonce: string;
  pid: number;
}

export function ownedChildBinding(value: unknown): value is OwnedChildBinding {
  if (!value || typeof value !== "object") return false;
  const b = value as OwnedChildBinding;
  return b.version === 1 && typeof b.root === "string" && b.root.length > 0
    && typeof b.job === "string" && b.job.length > 0
    && Number.isSafeInteger(b.attempt) && b.attempt > 0
    && typeof b.digest === "string" && /^sha256:[a-f0-9]{64}$/.test(b.digest)
    && typeof b.nonce === "string" && /^[a-f0-9]{64}$/.test(b.nonce)
    && Number.isSafeInteger(b.pid) && b.pid > 0;
}

export function matchesOwnedChild(value: unknown, expected: OwnedChildBinding): boolean {
  return ownedChildBinding(value) && value.version === expected.version
    && value.root === expected.root && value.job === expected.job
    && value.attempt === expected.attempt && value.digest === expected.digest
    && value.nonce === expected.nonce && value.pid === expected.pid;
}

/** Validates an attestation received from the expected private IPC endpoint;
 * this shape check alone is NOT provenance and must not admit public input. */
export function ownedChildIdentity(value: unknown, pid: number): value is LongJobProcessIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as LongJobProcessIdentity;
  return identity.pid === pid && identity.host === hostname()
    && typeof identity.creation === "string"
    && /^(win32-filetime:[1-9][0-9]*|linux-startticks:[0-9a-f-]{36}:[0-9]+)$/.test(identity.creation);
}
