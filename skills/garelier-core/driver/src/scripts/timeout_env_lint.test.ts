import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("repository has no Garelier timeout mutation or raise suggestion", () => {
  const script = resolve(import.meta.dir, "timeout_env_lint.ts");
  const core = resolve(import.meta.dir, "../../..");
  const result = Bun.spawnSync([process.execPath, script, core], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
});
