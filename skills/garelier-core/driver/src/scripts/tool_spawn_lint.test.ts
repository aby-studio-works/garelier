import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireRuntimeExecutable } from "./_lib.ts";
import { lintSpawnWindowsHide } from "./spawn_windows_hide_lint.ts";
import { lintBareToolSpawns } from "./tool_spawn_lint.ts";

test("rejects source violations while ignoring Git-ignored generated directories", () => {
  const root = mkdtempSync(join(tmpdir(), "tool-spawn-lint-"));
  expect(Bun.spawnSync([requireRuntimeExecutable("git"), "init", "--quiet", root], { windowsHide: true }).exitCode).toBe(0);
  writeFileSync(join(root, ".gitignore"), ".generated-deps/\n");
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
  const windowRoot = join(root, "window-fixture");
  mkdirSync(windowRoot);
  writeFileSync(join(windowRoot, "source.ts"), 'Bun.spawnSync(["node", "script.ts"]);\n');
  mkdirSync(join(windowRoot, ".generated-deps"));
  writeFileSync(join(windowRoot, ".generated-deps", "cache.ts"), 'Bun.spawnSync(["git", "status"]);\n');
  expect(lintSpawnWindowsHide(windowRoot)).toEqual([
    "source.ts:1:1: child-process call omits windowsHide: true",
  ]);
});
