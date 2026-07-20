import { closeSync, openSync } from "node:fs";
import { requireRuntimeExecutable, resolveBashLaunch, resolveCommand, type NativeExecutableOptions, type RuntimeToolName } from "./_lib.ts";

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

function killTree(pid: number, hard: boolean): boolean {
  if (process.platform === "win32") {
    // Bun invokes native taskkill directly, so use native `/` switches. The
    // former `//PID` spelling was only needed when MSYS bash translated argv.
    const args = hard ? ["/PID", String(pid), "/T", "/F"] : ["/PID", String(pid), "/T"];
    return Bun.spawnSync([requireRuntimeExecutable("taskkill"), ...args], { windowsHide: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  } else {
    try { process.kill(pid, hard ? "SIGKILL" : "SIGTERM"); return true; } catch { return false; }
  }
}

/** Run one shell gate step with TERM then KILL escalation and captured output.
 * `env` (W-123) is the explicit child env; the merge gate passes gateEnv() so the
 * quality-gate compile runs with RUSTC_WRAPPER unset (a top-level `delete
 * process.env.RUSTC_WRAPPER` does not reach a Windows Bun child). Omitted = the
 * child inherits the parent env, preserving the standalone timeout tests. */
export async function runGateCommand(
  cmd: string,
  outFile: string,
  errFile: string,
  limitSecs: number,
  killGraceSecs = gateKillGraceSecs(),
  env?: Record<string, string | undefined>,
): Promise<number> {
  const outFd = openSync(outFile, "w");
  const errFd = openSync(errFile, "w");
  let proc: Bun.Subprocess;
  try {
    const shell = resolveBashLaunch({ env: env ?? (process.env as Record<string, string | undefined>), runtimeTools: CONFIGURED_GATE_TOOLS });
    if (!shell) throw new Error("Git Bash not found");
    const resolvedCmd = resolveGateCommand(cmd, { env: shell.env });
    if (!resolvedCmd) throw new Error("configured gate executable not found");
    proc = Bun.spawn([shell.executable, "-c", resolvedCmd], { windowsHide: true, env: shell.env, stdin: "ignore", stdout: outFd, stderr: errFd });
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
