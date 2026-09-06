import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { runFileBackedProcess } from "./file_backed_process.ts";
import { removeStaleShellOracles, runShellOracle } from "./shell_oracle_test_runner.ts";
import { pidAlive, resolveBashExecutable, resolveBashLaunch } from "./_lib.ts";

let temp = "";
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = "";
});

test("shell oracle startup removes only dead-PID artifacts left by a hard-killed test", () => {
  temp = mkdtempSync(join(tmpdir(), "garelier-shell-oracle-cleanup-"));
  const testPath = join(temp, "parity.test.ts");
  const stale = `${testPath}.12164.dead.bash`;
  const live = `${testPath}.99999.live.bash`;
  const unrelated = join(temp, "other.test.ts.12164.dead.bash");
  for (const path of [stale, live, unrelated]) writeFileSync(path, "#!/usr/bin/env bash\n");

  expect(removeStaleShellOracles(testPath, (pid) => pid === 99999)).toEqual([stale]);
  expect(existsSync(stale)).toBe(false);
  expect(existsSync(live)).toBe(true);
  expect(existsSync(unrelated)).toBe(true);
});

test("shell oracle resolves a sanitized PATH and file capture ignores grandchild pipe EOF", async () => {
  temp = mkdtempSync(join(tmpdir(), "garelier-shell-oracle-path-"));
  const testPath = join(temp, "sanitized.test.ts");
  writeFileSync(testPath, "fixture\n");
  if (process.platform === "win32") {
    const bash = resolveBashExecutable();
    expect(bash).not.toBeNull();
    const env: Record<string, string | undefined> = {
      GARELIER_BASH: bash!,
      PATH: `${process.env.SystemRoot ?? "C:\\Windows"}\\System32`,
      SystemRoot: process.env.SystemRoot,
      USERPROFILE: process.env.USERPROFILE,
    };
    const result = runShellOracle("#!/usr/bin/env bash\nbun --version >/dev/null\nprintf ok\n", testPath, [], env);
    expect(result.exitCode, result.stderr?.toString() ?? "").toBe(0);
    expect(result.stdout?.toString() ?? "").toBe("ok");
  }

  const shell = resolveBashLaunch();
  if (!shell) throw new Error("Git Bash not found");
  const grandchildPidFile = join(temp, "grandchild.pid");
  const body = [
    `bun -e "require('node:fs').writeFileSync('grandchild.pid', String(process.pid)); setTimeout(() => process.exit(0), 4000)" &`,
    "while [ ! -s grandchild.pid ]; do sleep 0.01; done",
    "printf VISIBLE_STDOUT",
    "printf VISIBLE_STDERR >&2",
  ].join("\n");
  const captureRoot = join(temp, "captures");
  const started = performance.now();
  const captured = await runFileBackedProcess(
    {
      command: [shell.executable, "-s"],
      captureRoot,
      capturePrefix: ".oracle-",
      cwd: temp,
      env: shell.env,
      stdin: new TextEncoder().encode(body),
    },
    async (proc) => proc.exited,
  );
  const elapsedMs = performance.now() - started;
  const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
  const grandchildAliveAtReturn = pidAlive(grandchildPid);
  const grandchildExitDeadline = performance.now() + 5_000;
  while (pidAlive(grandchildPid) && performance.now() < grandchildExitDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  expect(captured.result).toBe(0);
  expect(captured.stdout).toBe("VISIBLE_STDOUT");
  expect(captured.stderr).toBe("VISIBLE_STDERR");
  expect(grandchildAliveAtReturn).toBeTrue();
  expect(elapsedMs).toBeLessThan(3_000);
  expect(pidAlive(grandchildPid)).toBeFalse();
  expect(readdirSync(captureRoot)).toEqual([]);
}, 15_000);
