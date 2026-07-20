import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintBareToolSpawns } from "./tool_spawn_lint.ts";

test("rejects direct bare tool spawns and ignores resolved or test-only calls", () => {
  const root = mkdtempSync(join(tmpdir(), "tool-spawn-lint-"));
  mkdirSync(join(root, "nested"));
  writeFileSync(join(root, "nested", "bad.ts"), [
    'Bun.spawnSync(["git", "status"]);',
    'spawnSync("bun", ["x.ts"]);',
    'Bun.spawnSync(["cygpath", "-m", "x"]);',
    'Bun.spawnSync(["npm", "run", "test"]);',
    '// Bun.spawn(["bash", "-c", "true"]);',
    'Bun.spawnSync([requireRuntimeExecutable("git"), "status"]);',
    'const forbidden = ["bun", "x", "tsc"];',
  ].join("\n"));
  writeFileSync(join(root, "nested", "fixture.test.ts"), 'Bun.spawnSync(["bash", "-c", "true"]);\n');
  expect(lintBareToolSpawns(root)).toEqual([
    { file: "nested/bad.ts", line: 1, tool: "git" },
    { file: "nested/bad.ts", line: 2, tool: "bun" },
    { file: "nested/bad.ts", line: 3, tool: "cygpath" },
    { file: "nested/bad.ts", line: 4, tool: "npm" },
    { file: "nested/bad.ts", line: 7, tool: "install-run" },
  ]);
});
