import { rmSync } from "./path_guard.ts";
// install_hook.ts — idempotently register the command_guard PreToolUse hook in
// a Claude Code settings file, PRESERVING every other key (W-050).
//
// Two settings files matter, because Claude Code applies hooks differently by
// how a role is launched (see references/command_guard.md):
//   - the role checkout's .claude/settings.local.json  (independent sessions),
//     written fresh by the wizard's write_role_settings;
//   - the TARGET PROJECT ROOT's .claude/settings.local.json (attended subagents
//     spawned by a PM session read the PARENT session's project-root settings,
//     NOT the checkout's) — this installer does that MERGE so a user's existing
//     settings are never clobbered.
//
// settings.local.json (local, gitignored by convention) is used, not the tracked
// settings.json, to keep Garelier's project-root footprint local-only (DEC-051).

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const GUARD_MATCHER = "Bash|PowerShell|Shell";

export function guardCommand(guardPath: string): string {
  return `bun "${guardPath}"`;
}

interface HookCmd {
  type?: string;
  command?: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCmd[];
}

const isGuardCmd = (c: unknown): boolean => typeof c === "string" && c.includes("command_guard");

/** True if `settings` already registers a command_guard PreToolUse hook. */
export function hasGuardHook(settings: unknown): boolean {
  const s = settings as { hooks?: { PreToolUse?: HookEntry[] } };
  const list = s?.hooks?.PreToolUse;
  if (!Array.isArray(list)) return false;
  return list.some((e) => Array.isArray(e?.hooks) && e.hooks!.some((h) => isGuardCmd(h?.command)));
}

/** Idempotently ensure a command_guard PreToolUse hook is present, refreshing
 *  the path if it already exists. Mutates and returns the same object so all
 *  other keys are preserved. */
export function mergeGuardHook(settings: unknown, guardPath: string): Record<string, unknown> {
  const out = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const hooks = (out.hooks && typeof out.hooks === "object" ? out.hooks : {}) as Record<string, unknown>;
  const list: HookEntry[] = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [];
  const cmd = guardCommand(guardPath);
  let found = false;
  for (const e of list) {
    if (!Array.isArray(e?.hooks)) continue;
    for (const h of e.hooks!) {
      if (isGuardCmd(h?.command)) {
        h.command = cmd; // refresh the guard path
        if (e.matcher === undefined) e.matcher = GUARD_MATCHER;
        found = true;
      }
    }
  }
  if (!found) {
    list.push({ matcher: GUARD_MATCHER, hooks: [{ type: "command", command: cmd }] });
  }
  hooks.PreToolUse = list;
  out.hooks = hooks;
  return out;
}

/** Merge the guard hook into a settings file on disk. Returns whether it wrote.
 *  A malformed existing file is treated as empty (never silently discarded when
 *  it already parses). */
export function installGuardHookFile(
  settingsPath: string,
  guardPath: string,
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
  if (existed && hasGuardHook(current)) {
    // refresh path in place; only write if the serialized form actually changes
    const before = JSON.stringify(current);
    mergeGuardHook(current, guardPath);
    if (JSON.stringify(current) === before) return { changed: false, created: false };
  } else {
    mergeGuardHook(current, guardPath);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n");
  return { changed: true, created: !existed };
}

/** Remove only the command_guard PreToolUse hook, preserving every other key
 *  and any other hooks. Prunes now-empty PreToolUse / hooks containers so the
 *  file is left clean. Returns the object and whether anything was removed. */
export function removeGuardHook(settings: unknown): { settings: Record<string, unknown>; removed: boolean } {
  const out = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const hooks = out.hooks as Record<string, unknown> | undefined;
  const list = hooks?.PreToolUse as HookEntry[] | undefined;
  if (!Array.isArray(list)) return { settings: out, removed: false };
  let removed = false;
  const kept = list.filter((e) => {
    const isGuard = Array.isArray(e?.hooks) && e.hooks!.some((h) => isGuardCmd(h?.command));
    if (isGuard) removed = true;
    return !isGuard;
  });
  if (!removed) return { settings: out, removed: false };
  if (kept.length > 0) {
    (hooks as Record<string, unknown>).PreToolUse = kept;
  } else {
    delete (hooks as Record<string, unknown>).PreToolUse;
    if (Object.keys(hooks as Record<string, unknown>).length === 0) delete out.hooks;
  }
  return { settings: out, removed: true };
}

/** Strip the guard hook from a settings file. Deletes the file if it becomes an
 *  empty object (so teardown leaves no residue), else rewrites it preserving the
 *  remaining keys. */
export function uninstallGuardHookFile(settingsPath: string): { removed: boolean; deletedFile: boolean } {
  if (!existsSync(settingsPath)) return { removed: false, deletedFile: false };
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { removed: false, deletedFile: false };
  }
  const { settings, removed } = removeGuardHook(current);
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
      console.error("usage: install_hook.ts --uninstall <settings.json path>");
      process.exit(2);
    }
    const r = uninstallGuardHookFile(settingsPath);
    console.log(
      r.removed
        ? `command_guard hook removed from ${settingsPath}${r.deletedFile ? " (empty file deleted)" : ""}`
        : `no command_guard hook in ${settingsPath}`,
    );
  } else {
    const [settingsPath, guardPath] = args;
    if (!settingsPath || !guardPath) {
      console.error(
        "usage: install_hook.ts <settings.json path> <command_guard.ts path>\n" +
          "       install_hook.ts --uninstall <settings.json path>",
      );
      process.exit(2);
    }
    const r = installGuardHookFile(settingsPath, guardPath);
    console.log(
      r.changed
        ? `command_guard hook ${r.created ? "written to new" : "merged into"} ${settingsPath}`
        : `command_guard hook already present in ${settingsPath}`,
    );
  }
}
