import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeMirrorHook,
  hasMirrorHook,
  installMirrorHookFile,
  mirrorCommand,
  removeMirrorHook,
  uninstallMirrorHookFile,
  MIRROR_MATCHER,
} from "./install_task_mirror_hook.ts";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";

const HOOK = "/skills/garelier-core/hooks/task_mirror_hook.sh";

test("mergeMirrorHook adds a PostToolUse entry to empty settings", () => {
  const out = mergeMirrorHook({}, HOOK);
  expect(hasMirrorHook(out)).toBe(true);
  const entry = (out as any).hooks.PostToolUse[0];
  expect(entry.matcher).toBe(MIRROR_MATCHER);
  expect(entry.hooks[0].command).toBe(mirrorCommand(HOOK));
});

test("mirrorCommand emits the self-guarding form (W-037)", () => {
  // Probe-then-exec: silent exit 0 when the hook file is gone, exec otherwise so
  // stdin + exit code pass through to the hook.
  const bash = requireRuntimeExecutable("bash").replace(/\\/g, "/");
  expect(mirrorCommand(HOOK)).toBe(`"${bash}" -c '[ -f "${HOOK}" ] && exec "${bash}" "${HOOK}" || exit 0'`);
});

test("mergeMirrorHook upgrades a legacy direct-write entry in place", () => {
  // Pre-W-037 settings carried a bare `bash "<hook>"` command. A re-run must
  // rewrite it to the guarded form without adding a duplicate entry.
  const legacy = {
    hooks: {
      PostToolUse: [{ matcher: MIRROR_MATCHER, hooks: [{ type: "command", command: `bash "${HOOK}"` }] }],
    },
  };
  const out = mergeMirrorHook(legacy, HOOK) as any;
  expect(out.hooks.PostToolUse.length).toBe(1);
  expect(out.hooks.PostToolUse[0].hooks[0].command).toBe(mirrorCommand(HOOK));
});

test("mergeMirrorHook preserves unrelated keys and existing hooks", () => {
  const existing = {
    claudeMdExcludes: ["/proj/CLAUDE.md"],
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bun "cmd_guard.ts"' }] }],
      PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "fmt.ts" }] }],
    },
  };
  const out = mergeMirrorHook(existing, HOOK) as any;
  expect(out.claudeMdExcludes).toEqual(["/proj/CLAUDE.md"]);
  // the command_guard PreToolUse hook is untouched
  expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('bun "cmd_guard.ts"');
  // the pre-existing Write PostToolUse hook is kept, and the mirror entry appended
  expect(out.hooks.PostToolUse.length).toBe(2);
  expect(out.hooks.PostToolUse[0].matcher).toBe("Write");
  expect(hasMirrorHook(out)).toBe(true);
});

test("mergeMirrorHook is idempotent (no duplicate on second run)", () => {
  const s = mergeMirrorHook({}, HOOK);
  mergeMirrorHook(s, HOOK);
  expect((s as any).hooks.PostToolUse.length).toBe(1);
});

test("mergeMirrorHook refreshes the hook path if it moved", () => {
  const s = mergeMirrorHook({}, "/old/task_mirror_hook.sh");
  mergeMirrorHook(s, "/new/task_mirror_hook.sh");
  expect((s as any).hooks.PostToolUse.length).toBe(1);
  expect((s as any).hooks.PostToolUse[0].hooks[0].command).toBe(mirrorCommand("/new/task_mirror_hook.sh"));
});

test("hasMirrorHook is false for settings without the hook", () => {
  expect(hasMirrorHook({})).toBe(false);
  expect(hasMirrorHook({ hooks: { PostToolUse: [{ hooks: [{ command: "other.ts" }] }] } })).toBe(false);
});

test("installMirrorHookFile creates, is idempotent, and preserves a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "mirrorhook-"));
  const path = join(dir, ".claude", "settings.local.json");

  const r1 = installMirrorHookFile(path, HOOK);
  expect(r1.changed).toBe(true);
  expect(r1.created).toBe(true);
  expect(existsSync(path)).toBe(true);
  expect(hasMirrorHook(JSON.parse(readFileSync(path, "utf8")))).toBe(true);

  const r2 = installMirrorHookFile(path, HOOK);
  expect(r2.changed).toBe(false);

  // a user file with their own keys is preserved on merge
  writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  const r3 = installMirrorHookFile(path, HOOK);
  expect(r3.changed).toBe(true);
  const merged = JSON.parse(readFileSync(path, "utf8"));
  expect(merged.permissions.allow).toEqual(["Bash(ls:*)"]);
  expect(hasMirrorHook(merged)).toBe(true);
});

test("removeMirrorHook strips only the mirror entry, keeping other hooks + keys", () => {
  const s = {
    claudeMdExcludes: ["/p/CLAUDE.md"],
    hooks: {
      PostToolUse: [
        { matcher: "Write", hooks: [{ command: "fmt.ts" }] },
        { matcher: MIRROR_MATCHER, hooks: [{ command: `bash "${HOOK}"` }] },
      ],
    },
  };
  const { removed } = removeMirrorHook(s);
  expect(removed).toBe(true);
  expect(hasMirrorHook(s)).toBe(false);
  expect((s as any).claudeMdExcludes).toEqual(["/p/CLAUDE.md"]);
  expect((s as any).hooks.PostToolUse.length).toBe(1);
  expect((s as any).hooks.PostToolUse[0].matcher).toBe("Write");
});

test("removeMirrorHook prunes empty PostToolUse / hooks containers", () => {
  const s = mergeMirrorHook({}, HOOK);
  const { removed } = removeMirrorHook(s);
  expect(removed).toBe(true);
  expect((s as any).hooks).toBeUndefined();
});

test("uninstallMirrorHookFile deletes a file that becomes empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "mirrorhook-"));
  const path = join(dir, ".claude", "settings.local.json");
  installMirrorHookFile(path, HOOK);
  const r = uninstallMirrorHookFile(path);
  expect(r.removed).toBe(true);
  expect(r.deletedFile).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test("uninstallMirrorHookFile keeps a file that still has user keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "mirrorhook-"));
  const path = join(dir, "settings.local.json");
  writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  installMirrorHookFile(path, HOOK);
  const r = uninstallMirrorHookFile(path);
  expect(r.removed).toBe(true);
  expect(r.deletedFile).toBe(false);
  const left = JSON.parse(readFileSync(path, "utf8"));
  expect(left.permissions.allow).toEqual(["Bash(ls:*)"]);
  expect(hasMirrorHook(left)).toBe(false);
});

test("installMirrorHookFile treats a malformed file as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "mirrorhook-"));
  const path = join(dir, "settings.local.json");
  writeFileSync(path, "{ not valid json");
  const r = installMirrorHookFile(path, HOOK);
  expect(r.changed).toBe(true);
  expect(hasMirrorHook(JSON.parse(readFileSync(path, "utf8")))).toBe(true);
});
