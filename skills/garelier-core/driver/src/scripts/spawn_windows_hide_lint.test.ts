import { expect, test } from "bun:test";
import { lintText, maskLiteralsAndComments } from "./spawn_windows_hide_lint.ts";

test("masking preserves offsets and hides examples", () => {
  const source = `// Bun.spawn(["bad"])\nconst s = "spawnSync('bad')";\nBun.spawn(["ok"], { windowsHide: true });\n`;
  const masked = maskLiteralsAndComments(source);
  expect(masked.length).toBe(source.length);
  expect(masked.split("\n").length).toBe(source.split("\n").length);
  expect(lintText(source)).toEqual([]);
});

test("lint covers Bun and aliased or namespaced node child-process calls", () => {
  const source = `
import { spawnSync as run, execFile } from "node:child_process";
import * as cp from "child_process";
Bun.spawn(["a"]);
run("b", [], { windowsHide: true });
execFile("c", [], { windowsHide: false });
cp.fork("d", [], { windowsHide: true });
`;
  const failures = lintText(source, "fixture.ts");
  expect(failures).toHaveLength(2);
  expect(failures[0]).toContain("fixture.ts:4:");
  expect(failures[1]).toContain("fixture.ts:6:");
});
