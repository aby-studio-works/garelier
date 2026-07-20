import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "../../guard/path_guard.ts";
import { resolveGarelierDirs } from "./env.ts";
import { registerCommandGuardHook } from "./hooks.ts";

test("diff/fresh hook helper installs command_guard at the target project root", () => {
  const root = mkdtempSync(join(tmpdir(), "wizard-command-guard-"));
  try {
    registerCommandGuardHook(root, resolveGarelierDirs());
    const settings = readFileSync(join(root, ".claude", "settings.local.json"), "utf8");
    expect(settings).toContain("PreToolUse");
    expect(settings).toContain("command_guard.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
