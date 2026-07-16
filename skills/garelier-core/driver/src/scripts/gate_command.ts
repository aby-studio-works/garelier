import { closeSync, openSync } from "node:fs";

export function gateKillGraceSecs(): number {
  return parseInt(process.env.GARELIER_GATE_KILL_GRACE_SECS ?? "15", 10) || 15;
}

function killTree(pid: number, hard: boolean): boolean {
  if (process.platform === "win32") {
    // Bun invokes native taskkill directly, so use native `/` switches. The
    // former `//PID` spelling was only needed when MSYS bash translated argv.
    const args = hard ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    return Bun.spawnSync(["taskkill", ...args], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } else {
    try { process.kill(pid, hard ? "SIGKILL" : "SIGTERM"); return true; } catch { return false; }
  }
}

/** Run one shell gate step with TERM then KILL escalation and captured output. */
export async function runGateCommand(
  cmd: string,
  outFile: string,
  errFile: string,
  limitSecs: number,
  killGraceSecs = gateKillGraceSecs(),
): Promise<number> {
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(["bash", "-c", cmd], { stdin: "ignore", stdout: outFd, stderr: errFd });
  } catch {
    closeSync(outFd); closeSync(errFd);
    return 127;
  }
  let timedOut = false;
  let hardKilled = false;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const termTimer = setTimeout(() => {
    timedOut = true;
    if (typeof proc.pid === "number" && !killTree(proc.pid, false)) {
      try { proc.kill("SIGTERM"); } catch { /* gone */ }
    }
    graceTimer = setTimeout(() => {
      hardKilled = true;
      if (typeof proc.pid === "number" && !killTree(proc.pid, true)) {
        // Restricted sandboxes can deny taskkill even for our own child. Bun
        // retains the child handle, so terminate that process as the fallback.
        try { proc.kill("SIGKILL"); } catch { /* gone */ }
      }
    }, killGraceSecs * 1000);
  }, limitSecs * 1000);
  const code = await proc.exited;
  clearTimeout(termTimer);
  if (graceTimer) clearTimeout(graceTimer);
  closeSync(outFd); closeSync(errFd);
  if (hardKilled) return 137;
  if (timedOut) return 124;
  return code;
}

export function gateTimeoutNote(code: number, limitSecs: number, killGraceSecs = gateKillGraceSecs()): string {
  if (code === 124) return ` (timed out after ${limitSecs}s)`;
  if (code === 137) return ` (SIGKILL after ${limitSecs}s timeout + ${killGraceSecs}s grace)`;
  return "";
}
