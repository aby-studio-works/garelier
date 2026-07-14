import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasRuntimeRecoveryHook,
  installRuntimeRecoveryHookFile,
  mergeRuntimeRecoveryHook,
  PRECOMPACT_MATCHER,
  removeRuntimeRecoveryHook,
  runtimeRecoveryCommand,
  SESSION_START_MATCHER,
  SHELL_MATCHER,
  SUBAGENT_MATCHER,
  uninstallRuntimeRecoveryHookFile,
} from "./install_runtime_recovery_hook.ts";

const HOOK = "/skills/garelier-core/hooks/runtime_recovery_hook.ts";

test("mergeRuntimeRecoveryHook adds the six event entries with correct matchers", () => {
  const out = mergeRuntimeRecoveryHook({}, HOOK) as any;
  expect(hasRuntimeRecoveryHook(out)).toBe(true);
  expect(out.hooks.PostToolUseFailure[0].matcher).toBe(SHELL_MATCHER);
  expect(out.hooks.PostToolUse[0].matcher).toBe(SHELL_MATCHER);
  expect(out.hooks.SubagentStart[0].matcher).toBe(SUBAGENT_MATCHER);
  expect(out.hooks.SubagentStop[0].matcher).toBe(SUBAGENT_MATCHER);
  // W-063: SessionStart(compact|resume) + PreCompact(manual|auto).
  expect(out.hooks.SessionStart[0].matcher).toBe(SESSION_START_MATCHER);
  expect(out.hooks.PreCompact[0].matcher).toBe(PRECOMPACT_MATCHER);
  expect(out.hooks.PostToolUseFailure[0].hooks[0].command).toBe(runtimeRecoveryCommand(HOOK));
  expect(out.hooks.SessionStart[0].hooks[0].command).toBe(runtimeRecoveryCommand(HOOK));
  expect(out.hooks.PreCompact[0].hooks[0].command).toBe(runtimeRecoveryCommand(HOOK));
});

test("mergeRuntimeRecoveryHook adds the W-063 events to a settings file that only has the legacy four", () => {
  // An install from before W-063 carried only the original four events. A re-run
  // must add SessionStart + PreCompact (missing-event top-up) without disturbing
  // the existing four, and the result must be idempotent.
  const legacyFour = {
    hooks: {
      PostToolUseFailure: [{ matcher: SHELL_MATCHER, hooks: [{ type: "command", command: runtimeRecoveryCommand(HOOK) }] }],
      PostToolUse: [{ matcher: SHELL_MATCHER, hooks: [{ type: "command", command: runtimeRecoveryCommand(HOOK) }] }],
      SubagentStart: [{ matcher: SUBAGENT_MATCHER, hooks: [{ type: "command", command: runtimeRecoveryCommand(HOOK) }] }],
      SubagentStop: [{ matcher: SUBAGENT_MATCHER, hooks: [{ type: "command", command: runtimeRecoveryCommand(HOOK) }] }],
    },
  };
  expect(hasRuntimeRecoveryHook(legacyFour)).toBe(false); // missing the two new events
  const out = mergeRuntimeRecoveryHook(legacyFour, HOOK) as any;
  expect(hasRuntimeRecoveryHook(out)).toBe(true);
  expect(out.hooks.SessionStart[0].matcher).toBe(SESSION_START_MATCHER);
  expect(out.hooks.PreCompact[0].matcher).toBe(PRECOMPACT_MATCHER);
  // Existing four untouched (still one entry each).
  for (const ev of ["PostToolUseFailure", "PostToolUse", "SubagentStart", "SubagentStop"]) {
    expect(out.hooks[ev].length).toBe(1);
  }
  // Idempotent second run adds no duplicates.
  mergeRuntimeRecoveryHook(out, HOOK);
  expect(out.hooks.SessionStart.length).toBe(1);
  expect(out.hooks.PreCompact.length).toBe(1);
});

test("mergeRuntimeRecoveryHook preserves unrelated keys and hooks", () => {
  const existing = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: 'bun "command_guard.ts"' }] }],
      PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "fmt.sh" }] }],
    },
  };
  const out = mergeRuntimeRecoveryHook(existing, HOOK) as any;
  expect(out.permissions.allow).toEqual(["Bash(ls:*)"]);
  expect(out.hooks.PreToolUse[0].hooks[0].command).toBe('bun "command_guard.ts"');
  expect(out.hooks.PostToolUse.length).toBe(2);
  expect(out.hooks.PostToolUse[0].matcher).toBe("Write");
});

test("mergeRuntimeRecoveryHook is idempotent and refreshes the path", () => {
  const s = mergeRuntimeRecoveryHook({}, "/old/runtime_recovery_hook.ts") as any;
  mergeRuntimeRecoveryHook(s, "/new/runtime_recovery_hook.ts");
  expect(s.hooks.PostToolUseFailure.length).toBe(1);
  expect(s.hooks.PostToolUse.length).toBe(1);
  expect(s.hooks.SubagentStart.length).toBe(1);
  expect(s.hooks.SubagentStop.length).toBe(1);
  expect(s.hooks.SubagentStop[0].hooks[0].command).toBe(runtimeRecoveryCommand("/new/runtime_recovery_hook.ts"));
});

test("runtimeRecoveryCommand emits the self-guarding form (W-037)", () => {
  // exec bun keeps stdin (event JSON) + exit code / stdout passthrough for the
  // SubagentStop block decision; missing hook file exits 0 silently.
  expect(runtimeRecoveryCommand(HOOK)).toBe(
    `bash -c '[ -f "${HOOK}" ] && exec bun "${HOOK}" || exit 0'`,
  );
});

test("mergeRuntimeRecoveryHook upgrades legacy direct-write entries in place", () => {
  // Pre-W-037 settings carried bare `bun "<hook>"` commands across the four
  // events. A re-run rewrites each to the guarded form without duplicating.
  const legacy = {
    hooks: {
      PostToolUseFailure: [{ matcher: SHELL_MATCHER, hooks: [{ type: "command", command: `bun "${HOOK}"` }] }],
      PostToolUse: [{ matcher: SHELL_MATCHER, hooks: [{ type: "command", command: `bun "${HOOK}"` }] }],
      SubagentStart: [{ matcher: SUBAGENT_MATCHER, hooks: [{ type: "command", command: `bun "${HOOK}"` }] }],
      SubagentStop: [{ matcher: SUBAGENT_MATCHER, hooks: [{ type: "command", command: `bun "${HOOK}"` }] }],
    },
  };
  const out = mergeRuntimeRecoveryHook(legacy, HOOK) as any;
  for (const ev of ["PostToolUseFailure", "PostToolUse", "SubagentStart", "SubagentStop"]) {
    expect(out.hooks[ev].length).toBe(1);
    expect(out.hooks[ev][0].hooks[0].command).toBe(runtimeRecoveryCommand(HOOK));
  }
});

test("installRuntimeRecoveryHookFile creates and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtimehook-"));
  const path = join(dir, ".claude", "settings.local.json");
  const r1 = installRuntimeRecoveryHookFile(path, HOOK);
  expect(r1.changed).toBe(true);
  expect(r1.created).toBe(true);
  expect(hasRuntimeRecoveryHook(JSON.parse(readFileSync(path, "utf8")))).toBe(true);
  const r2 = installRuntimeRecoveryHookFile(path, HOOK);
  expect(r2.changed).toBe(false);
});

test("installRuntimeRecoveryHookFile preserves user keys and treats malformed as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtimehook-"));
  const path = join(dir, "settings.local.json");
  writeFileSync(path, JSON.stringify({ claudeMdExcludes: ["/p/CLAUDE.md"] }));
  installRuntimeRecoveryHookFile(path, HOOK);
  let merged = JSON.parse(readFileSync(path, "utf8"));
  expect(merged.claudeMdExcludes).toEqual(["/p/CLAUDE.md"]);
  expect(hasRuntimeRecoveryHook(merged)).toBe(true);

  writeFileSync(path, "{ invalid");
  installRuntimeRecoveryHookFile(path, HOOK);
  merged = JSON.parse(readFileSync(path, "utf8"));
  expect(hasRuntimeRecoveryHook(merged)).toBe(true);
});

test("removeRuntimeRecoveryHook strips only runtime recovery entries", () => {
  const s = {
    hooks: {
      PostToolUse: [
        { matcher: "Write", hooks: [{ command: "fmt.sh" }] },
        { matcher: SHELL_MATCHER, hooks: [{ command: runtimeRecoveryCommand(HOOK) }] },
      ],
      SubagentStop: [{ matcher: SUBAGENT_MATCHER, hooks: [{ command: runtimeRecoveryCommand(HOOK) }] }],
    },
    permissions: { ask: ["Bash(git push:*)"] },
  };
  const { settings, removed } = removeRuntimeRecoveryHook(s) as any;
  expect(removed).toBe(true);
  expect(settings.permissions.ask).toEqual(["Bash(git push:*)"]);
  expect(settings.hooks.PostToolUse.length).toBe(1);
  expect(settings.hooks.PostToolUse[0].matcher).toBe("Write");
  expect(settings.hooks.SubagentStop).toBeUndefined();
});

test("uninstallRuntimeRecoveryHookFile deletes empty file and keeps files with user keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "runtimehook-"));
  const emptyPath = join(dir, "empty.json");
  installRuntimeRecoveryHookFile(emptyPath, HOOK);
  const r1 = uninstallRuntimeRecoveryHookFile(emptyPath);
  expect(r1.removed).toBe(true);
  expect(r1.deletedFile).toBe(true);
  expect(existsSync(emptyPath)).toBe(false);

  const keptPath = join(dir, "kept.json");
  writeFileSync(keptPath, JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  installRuntimeRecoveryHookFile(keptPath, HOOK);
  const r2 = uninstallRuntimeRecoveryHookFile(keptPath);
  expect(r2.removed).toBe(true);
  expect(r2.deletedFile).toBe(false);
  const kept = JSON.parse(readFileSync(keptPath, "utf8"));
  expect(kept.permissions.allow).toEqual(["Bash(ls:*)"]);
  expect(hasRuntimeRecoveryHook(kept)).toBe(false);
});
