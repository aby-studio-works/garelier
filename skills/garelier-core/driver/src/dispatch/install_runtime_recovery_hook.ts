import { rmSync } from "../guard/path_guard.ts";
// install_runtime_recovery_hook.ts — idempotently register W-035 runtime recovery hooks.
//
// Merges into a target project's .claude/settings.local.json, preserving all other
// settings and hooks. Seven hook events are registered:
//   PreToolUse: Agent (W-434 dispatch_prepare record warning)
//   PostToolUseFailure / PostToolUse: Bash|PowerShell only
//   SubagentStart / SubagentStop: all subagents
//   SessionStart: compact|resume (W-063 compaction stall sweep)
//   PreCompact: manual|auto (W-063 in-flight snapshot)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { failOpenGuardedHookCommand, guardedHookCommand } from "./hook_guard.ts";

export const SHELL_MATCHER = "^(Bash|PowerShell)$";
export const AGENT_MATCHER = "Agent";
export const SUBAGENT_MATCHER = ".*";
// W-063: SessionStart fires for startup/resume/clear/compact — sweep only on the
// two that stop background subagents. PreCompact fires manual|auto.
export const SESSION_START_MATCHER = "compact|resume";
export const PRECOMPACT_MATCHER = "manual|auto";
export const RUNTIME_RECOVERY_EVENTS = [
  "PreToolUse",
  "PostToolUseFailure",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "SessionStart",
  "PreCompact",
] as const;

type RuntimeRecoveryEvent = (typeof RUNTIME_RECOVERY_EVENTS)[number];

interface HookCmd {
  type?: string;
  command?: string;
  timeout?: number;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCmd[];
}

// Self-guarding (W-037): if the framework hook file is gone (garelier removed
// without teardown), the command exits 0 silently instead of erroring on every
// Bash/PowerShell call and subagent boundary. Blocking lifecycle events use
// `exec bun`, preserving a SubagentStop block decision. Agent PreToolUse is an
// advisory-only exception: stdout JSON is preserved, but any hook failure or
// timeout becomes exit 0 (GDN-001/W-434). Re-run upgrades legacy entries.
export function runtimeRecoveryCommand(hookPath: string): string {
  return guardedHookCommand("bun", hookPath);
}

export function agentPreToolUseRuntimeRecoveryCommand(
  hookPath: string,
  executables: { bash?: string; runner?: string } = {},
): string {
  return failOpenGuardedHookCommand("bun", hookPath, executables, 9);
}

const isRuntimeRecoveryCmd = (c: unknown): boolean =>
  typeof c === "string" && c.includes("runtime_recovery_hook");

function matcherFor(event: RuntimeRecoveryEvent): string {
  switch (event) {
    case "PreToolUse":
      return AGENT_MATCHER;
    case "PostToolUseFailure":
    case "PostToolUse":
      return SHELL_MATCHER;
    case "SessionStart":
      return SESSION_START_MATCHER;
    case "PreCompact":
      return PRECOMPACT_MATCHER;
    default:
      return SUBAGENT_MATCHER;
  }
}

export function hasRuntimeRecoveryHook(settings: unknown): boolean {
  const hooks = (settings as { hooks?: Record<string, HookEntry[]> })?.hooks;
  if (!hooks || typeof hooks !== "object") return false;
  return RUNTIME_RECOVERY_EVENTS.every((event) =>
    Array.isArray(hooks[event]) && hooks[event].some((e) =>
      e?.matcher === matcherFor(event)
      && Array.isArray(e?.hooks)
      && e.hooks!.some((h) => isRuntimeRecoveryCmd(h?.command)),
    ),
  );
}

export function mergeRuntimeRecoveryHook(settings: unknown, hookPath: string): Record<string, unknown> {
  const out = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const hooks = (out.hooks && typeof out.hooks === "object" ? out.hooks : {}) as Record<string, unknown>;

  for (const event of RUNTIME_RECOVERY_EVENTS) {
    const advisoryAgent = event === "PreToolUse";
    const cmd = advisoryAgent
      ? agentPreToolUseRuntimeRecoveryCommand(hookPath)
      : runtimeRecoveryCommand(hookPath);
    const list: HookEntry[] = Array.isArray(hooks[event]) ? (hooks[event] as HookEntry[]) : [];
    let found = false;
    for (const e of list) {
      if (!Array.isArray(e?.hooks)) continue;
      for (const h of e.hooks!) {
        if (isRuntimeRecoveryCmd(h?.command)) {
          h.type = h.type || "command";
          h.command = cmd;
          if (advisoryAgent) h.timeout = 10;
          e.matcher = matcherFor(event);
          found = true;
        }
      }
    }
    if (!found) {
      list.push({
        matcher: matcherFor(event),
        hooks: [{ type: "command", command: cmd, ...(advisoryAgent ? { timeout: 10 } : {}) }],
      });
    }
    hooks[event] = list;
  }
  out.hooks = hooks;
  return out;
}

export function installRuntimeRecoveryHookFile(
  settingsPath: string,
  hookPath: string,
): { changed: boolean; created: boolean } {
  let current: unknown = {};
  const existed = existsSync(settingsPath);
  if (existed) {
    try {
      current = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      current = {};
    }
  }
  const before = JSON.stringify(current);
  mergeRuntimeRecoveryHook(current, hookPath);
  if (existed && JSON.stringify(current) === before) return { changed: false, created: false };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n");
  return { changed: true, created: !existed };
}

export function removeRuntimeRecoveryHook(settings: unknown): { settings: Record<string, unknown>; removed: boolean } {
  const out = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const hooks = out.hooks as Record<string, unknown> | undefined;
  if (!hooks || typeof hooks !== "object") return { settings: out, removed: false };
  let removed = false;

  for (const event of RUNTIME_RECOVERY_EVENTS) {
    const list = hooks[event] as HookEntry[] | undefined;
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => {
      const isRuntime = Array.isArray(e?.hooks) && e.hooks!.some((h) => isRuntimeRecoveryCmd(h?.command));
      if (isRuntime) removed = true;
      return !isRuntime;
    });
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}

export function uninstallRuntimeRecoveryHookFile(settingsPath: string): { removed: boolean; deletedFile: boolean } {
  if (!existsSync(settingsPath)) return { removed: false, deletedFile: false };
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { removed: false, deletedFile: false };
  }
  const { settings, removed } = removeRuntimeRecoveryHook(current);
  if (!removed) return { removed: false, deletedFile: false };
  if (Object.keys(settings).length === 0) {
    rmSync(settingsPath);
    return { removed: true, deletedFile: true };
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return { removed: true, deletedFile: false };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--uninstall") {
    const settingsPath = args[1];
    if (!settingsPath) {
      console.error("usage: install_runtime_recovery_hook.ts --uninstall <settings.json path>");
      process.exit(2);
    }
    const r = uninstallRuntimeRecoveryHookFile(settingsPath);
    console.log(
      r.removed
        ? `runtime_recovery hook removed from ${settingsPath}${r.deletedFile ? " (empty file deleted)" : ""}`
        : `no runtime_recovery hook in ${settingsPath}`,
    );
  } else {
    const [settingsPath, hookPath] = args;
    if (!settingsPath || !hookPath) {
      console.error(
        "usage: install_runtime_recovery_hook.ts <settings.json path> <runtime_recovery_hook.ts path>\n" +
          "       install_runtime_recovery_hook.ts --uninstall <settings.json path>",
      );
      process.exit(2);
    }
    const r = installRuntimeRecoveryHookFile(settingsPath, hookPath);
    console.log(
      r.changed
        ? `runtime_recovery hook ${r.created ? "written to new" : "merged into"} ${settingsPath}`
        : `runtime_recovery hook already present in ${settingsPath}`,
    );
  }
}
