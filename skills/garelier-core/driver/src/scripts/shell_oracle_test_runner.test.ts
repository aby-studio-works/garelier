import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../guard/path_guard.ts";
import { removeStaleShellOracles, runShellOracle } from "./shell_oracle_test_runner.ts";
import { resolveBashExecutable } from "./_lib.ts";

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

test("shell oracle supplies resolved Bash and Bun dirs to a sanitized child PATH", () => {
  if (process.platform !== "win32") return;
  temp = mkdtempSync(join(tmpdir(), "garelier-shell-oracle-path-"));
  const testPath = join(temp, "sanitized.test.ts");
  writeFileSync(testPath, "fixture\n");
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
});
