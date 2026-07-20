import { rmSync } from "../guard/path_guard.ts";
import { readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pidAlive, resolveBashLaunch } from "./_lib.ts";

export function removeStaleShellOracles(testPath: string, isAlive: (pid: number) => boolean = (pid) => pidAlive(pid)): string[] {
  const dir = dirname(testPath);
  const prefix = `${basename(testPath)}.`;
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".bash")) continue;
    const pidText = name.slice(prefix.length).split(".", 1)[0] ?? "";
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) continue;
    const path = join(dir, name);
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}

/** Run a migrated shell parity oracle without Windows command-line quoting or
 * length limits. The temporary `.bash` file lives beside the Bun test so legacy
 * `$0`-relative fixtures keep resolving exactly as before, and is always removed.
 */
export function runShellOracle(
  shellScript: string,
  testPath: string,
  args: string[] = [],
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof Bun.spawnSync> {
  removeStaleShellOracles(testPath);
  const oraclePath = `${testPath}.${process.pid}.${crypto.randomUUID()}.bash`;
  writeFileSync(oraclePath, shellScript, "utf8");
  try {
    const shell = resolveBashLaunch({ env });
    if (!shell) throw new Error("Git Bash not found (checked PATH, GARELIER_BASH, and standard Git for Windows locations)");
    return Bun.spawnSync([shell.executable, oraclePath, ...args], { windowsHide: true,
      cwd: dirname(testPath),
      env: shell.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 600_000,
      killSignal: "SIGKILL",
    });
  } finally {
    rmSync(oraclePath, { force: true });
  }
}
