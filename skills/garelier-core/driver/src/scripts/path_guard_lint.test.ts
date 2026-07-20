import { expect, test } from "bun:test";
import { lintRawDestructiveFs } from "./path_guard_lint.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSync } from "../guard/path_guard.ts";

test("driver has no raw destructive node:fs imports", () => {
  expect(lintRawDestructiveFs(resolve(import.meta.dir, ".."))).toEqual([]);
});

test("raw destructive node:fs imports make the lint red", () => {
  const root = mkdtempSync(join(tmpdir(), "path-guard-lint-"));
  try {
    const moduleName = `node:${"fs"}`;
    writeFileSync(join(root, "bad.ts"), `import { rmSync } from "${moduleName}";\nrmSync("x");\n`);
    expect(lintRawDestructiveFs(root)).toEqual(["bad.ts: raw node:fs rmSync import bypasses path_guard"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
