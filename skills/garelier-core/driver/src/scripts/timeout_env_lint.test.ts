import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { REPOSITORY_WALK_TEST_TIMEOUT_MS } from "./ci_test_timeout.ts";

test("repository has no Garelier timeout mutation or raise suggestion", () => {
  const script = resolve(import.meta.dir, "timeout_env_lint.ts");
  const core = resolve(import.meta.dir, "../../..");
  const result = Bun.spawnSync([process.execPath, script, core], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
}, REPOSITORY_WALK_TEST_TIMEOUT_MS); // W-148: spawns a subprocess over the whole core tree; exceeds 5000ms under load
