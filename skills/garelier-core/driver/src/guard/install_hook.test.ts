import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeGuardHook,
  hasGuardHook,
  installGuardHookFile,
  removeGuardHook,
  uninstallGuardHookFile,
  GUARD_MATCHER,
} from "./install_hook.ts";

const GUARD = "/skills/garelier-core/driver/src/guard/command_guard.ts";

test("mergeGuardHook adds a PreToolUse entry to empty settings", () => {
  const out = mergeGuardHook({}, GUARD);
  expect(hasGuardHook(out)).toBe(true);
  const entry = (out as any).hooks.PreToolUse[0];
  expect(entry.matcher).toBe(GUARD_MATCHER);
  expect(entry.hooks[0].command).toBe(`bun "${GUARD}"`);
});

test("mergeGuardHook preserves unrelated keys and existing hooks", () => {
  const existing = {
    claudeMdExcludes: ["/proj/CLAUDE.md"],
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo hi" }] }],
      PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "lint.ts" }] }],
    },
  };
  const out = mergeGuardHook(existing, GUARD) as any;
  expect(out.claudeMdExcludes).toEqual(["/proj/CLAUDE.md"]);
  expect(out.hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
  // the pre-existing Write hook is kept, and the guard entry is appended
  expect(out.hooks.PreToolUse.length).toBe(2);
  expect(out.hooks.PreToolUse[0].matcher).toBe("Write");
  expect(hasGuardHook(out)).toBe(true);
});

test("mergeGuardHook is idempotent (no duplicate on second run)", () => {
  const s = mergeGuardHook({}, GUARD);
  mergeGuardHook(s, GUARD);
  expect((s as any).hooks.PreToolUse.length).toBe(1);
});

test("mergeGuardHook refreshes the guard path if it moved", () => {
  const s = mergeGuardHook({}, "/old/command_guard.ts");
  mergeGuardHook(s, "/new/command_guard.ts");
  expect((s as any).hooks.PreToolUse.length).toBe(1);
  expect((s as any).hooks.PreToolUse[0].hooks[0].command).toBe(`bun "/new/command_guard.ts"`);
});

test("hasGuardHook is false for settings without the guard", () => {
  expect(hasGuardHook({})).toBe(false);
  expect(hasGuardHook({ hooks: { PreToolUse: [{ hooks: [{ command: "other.ts" }] }] } })).toBe(false);
});

test("installGuardHookFile creates, is idempotent, and preserves a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardhook-"));
  const path = join(dir, ".claude", "settings.local.json");

  const r1 = installGuardHookFile(path, GUARD);
  expect(r1.changed).toBe(true);
  expect(r1.created).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(hasGuardHook(JSON.parse(readFileSync(path, "utf8")))).toBe(true);

  // second run: already present -> no change
  const r2 = installGuardHookFile(path, GUARD);
  expect(r2.changed).toBe(false);

  // a user file with their own keys is preserved on merge
  writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  const r3 = installGuardHookFile(path, GUARD);
  expect(r3.changed).toBe(true);
  const merged = JSON.parse(readFileSync(path, "utf8"));
  expect(merged.permissions.allow).toEqual(["Bash(ls:*)"]);
  expect(hasGuardHook(merged)).toBe(true);
});

// --- teardown / uninstall ---------------------------------------------------

test("removeGuardHook strips only the guard entry, keeping other hooks + keys", () => {
  const s = {
    claudeMdExcludes: ["/p/CLAUDE.md"],
    hooks: {
      SessionStart: [{ hooks: [{ command: "echo hi" }] }],
      PreToolUse: [
        { matcher: "Write", hooks: [{ command: "lint.ts" }] },
        { matcher: GUARD_MATCHER, hooks: [{ command: `bun "${GUARD}"` }] },
      ],
    },
  };
  const { removed } = removeGuardHook(s);
  expect(removed).toBe(true);
  expect(hasGuardHook(s)).toBe(false);
  expect((s as any).claudeMdExcludes).toEqual(["/p/CLAUDE.md"]);
  expect((s as any).hooks.SessionStart[0].hooks[0].command).toBe("echo hi");
  // the non-guard Write hook survives
  expect((s as any).hooks.PreToolUse.length).toBe(1);
  expect((s as any).hooks.PreToolUse[0].matcher).toBe("Write");
});

test("removeGuardHook prunes empty PreToolUse / hooks containers", () => {
  const s = mergeGuardHook({}, GUARD);
  const { removed } = removeGuardHook(s);
  expect(removed).toBe(true);
  expect((s as any).hooks).toBeUndefined();
});

test("removeGuardHook reports false when there is nothing to remove", () => {
  expect(removeGuardHook({ permissions: {} }).removed).toBe(false);
});

test("uninstallGuardHookFile deletes a file that becomes empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardhook-"));
  const path = join(dir, ".claude", "settings.local.json");
  installGuardHookFile(path, GUARD);
  const r = uninstallGuardHookFile(path);
  expect(r.removed).toBe(true);
  expect(r.deletedFile).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test("uninstallGuardHookFile keeps a file that still has user keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardhook-"));
  const path = join(dir, "settings.local.json");
  writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  installGuardHookFile(path, GUARD);
  const r = uninstallGuardHookFile(path);
  expect(r.removed).toBe(true);
  expect(r.deletedFile).toBe(false);
  const left = JSON.parse(readFileSync(path, "utf8"));
  expect(left.permissions.allow).toEqual(["Bash(ls:*)"]);
  expect(hasGuardHook(left)).toBe(false);
});

test("uninstallGuardHookFile on a file without the hook is a no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardhook-"));
  const path = join(dir, "settings.local.json");
  writeFileSync(path, JSON.stringify({ permissions: {} }));
  expect(uninstallGuardHookFile(path).removed).toBe(false);
});

test("installGuardHookFile treats a malformed file as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "guardhook-"));
  const path = join(dir, "settings.local.json");
  writeFileSync(path, "{ not valid json");
  const r = installGuardHookFile(path, GUARD);
  expect(r.changed).toBe(true);
  expect(hasGuardHook(JSON.parse(readFileSync(path, "utf8")))).toBe(true);
});
