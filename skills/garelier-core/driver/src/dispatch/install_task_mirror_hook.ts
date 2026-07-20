import { rmSync } from "../guard/path_guard.ts";
// install_task_mirror_hook.ts — idempotently register the task_mirror PostToolUse
// hook in a Claude Code settings file, PRESERVING every other key (workshop W-030).
//
// The hook (skills/garelier-core/hooks/task_mirror_hook.sh) fires after a
// land/dispatch Bash command and injects only the Task-mirror delta into the PM
// session. It is framework-owned and self-configuring (reads pm_id/project from
// the intercepted command), so the registered command carries NO arguments — one
// installed entry serves every project.
//
// Merges into the TARGET PROJECT ROOT's .claude/settings.local.json (local,
// gitignored by convention, DEC-051) so a user's own settings and any other hooks
// are never clobbered. Structurally parallels src/guard/install_hook.ts (which does
// the same for the PreToolUse command_guard); kept separate because the guard is a
// distinct security concern with its own semantics.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { guardedHookCommand } from "./hook_guard.ts";

export const MIRROR_MATCHER = "Bash";

// Self-guarding (W-037): if the framework hook file is gone (garelier removed
// without teardown), the command exits 0 silently instead of erroring on every
// Bash call. A re-run upgrades any legacy direct-write entry in place because
// isMirrorCmd matches on the script basename, which both forms carry.
export function mirrorCommand(hookPath: string): string {
  return guardedHookCommand("bash", hookPath);
}

interface HookCmd {
  type?: string;
  command?: string;
}
interface HookEntry {
  matcher?: string;
  hooks?: HookCmd[];
}

// Identity is the script basename, independent of the absolute path, so a moved
// install location refreshes the same entry instead of adding a duplicate.
const isMirrorCmd = (c: unknown): boolean => typeof c === "string" && c.includes("task_mirror_hook");

/** True if `settings` already registers the task_mirror PostToolUse hook. */
export function hasMirrorHook(settings: unknown): boolean {
  const s = settings as { hooks?: { PostToolUse?: HookEntry[] } };
  const list = s?.hooks?.PostToolUse;
  if (!Array.isArray(list)) return false;
  return list.some((e) => Array.isArray(e?.hooks) && e.hooks!.some((h) => isMirrorCmd(h?.command)));
}

/** Idempotently ensure the task_mirror PostToolUse hook is present, refreshing the
 *  path if it already exists. Mutates and returns the same object so all other keys
 *  are preserved. */
export function mergeMirrorHook(settings: unknown, hookPath: string): Record<string, unknown> {
  const out = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const hooks = (out.hooks && typeof out.hooks === "object" ? out.hooks : {}) as Record<string, unknown>;
  const list: HookEntry[] = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as HookEntry[]) : [];
  const cmd = mirrorCommand(hookPath);
  let found = false;
  for (const e of list) {
    if (!Array.isArray(e?.hooks)) continue;
    for (const h of e.hooks!) {
      if (isMirrorCmd(h?.command)) {
        h.command = cmd; // refresh the hook path
        if (e.matcher === undefined) e.matcher = MIRROR_MATCHER;
        found = true;
      }
    }
  }
  if (!found) {
    list.push({ matcher: MIRROR_MATCHER, hooks: [{ type: "command", command: cmd }] });
  }
  hooks.PostToolUse = list;
  out.hooks = hooks;
  return out;
}

/** Merge the mirror hook into a settings file on disk. Returns whether it wrote.
 *  A malformed existing file is treated as empty (never silently discarded when it
 *  already parses). */
export function installMirrorHookFile(
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
  if (existed && hasMirrorHook(current)) {
    const before = JSON.stringify(current);
    mergeMirrorHook(current, hookPath);
    if (JSON.stringify(current) === before) return { changed: false, created: false };
  } else {
    mergeMirrorHook(current, hookPath);
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n");
  return { changed: true, created: !existed };
}

/** Remove only the task_mirror PostToolUse hook, preserving every other key and any
 *  other hooks. Prunes now-empty PostToolUse / hooks containers. */
export function removeMirrorHook(settings: unknown): { settings: Record<string, unknown>; removed: boolean } {
  const out = (settings && typeof settings === "object" ? settings : {}) as Record<string, unknown>;
  const hooks = out.hooks as Record<string, unknown> | undefined;
  const list = hooks?.PostToolUse as HookEntry[] | undefined;
  if (!Array.isArray(list)) return { settings: out, removed: false };
  let removed = false;
  const kept = list.filter((e) => {
    const isMirror = Array.isArray(e?.hooks) && e.hooks!.some((h) => isMirrorCmd(h?.command));
    if (isMirror) removed = true;
    return !isMirror;
  });
  if (!removed) return { settings: out, removed: false };
  if (kept.length > 0) {
    (hooks as Record<string, unknown>).PostToolUse = kept;
  } else {
    delete (hooks as Record<string, unknown>).PostToolUse;
    if (Object.keys(hooks as Record<string, unknown>).length === 0) delete out.hooks;
  }
  return { settings: out, removed: true };
}

/** Strip the mirror hook from a settings file. Deletes the file if it becomes an
 *  empty object, else rewrites it preserving the remaining keys. */
export function uninstallMirrorHookFile(settingsPath: string): { removed: boolean; deletedFile: boolean } {
  if (!existsSync(settingsPath)) return { removed: false, deletedFile: false };
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return { removed: false, deletedFile: false };
  }
  const { settings, removed } = removeMirrorHook(current);
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
      console.error("usage: install_task_mirror_hook.ts --uninstall <settings.json path>");
      process.exit(2);
    }
    const r = uninstallMirrorHookFile(settingsPath);
    console.log(
      r.removed
        ? `task_mirror hook removed from ${settingsPath}${r.deletedFile ? " (empty file deleted)" : ""}`
        : `no task_mirror hook in ${settingsPath}`,
    );
  } else {
    const [settingsPath, hookPath] = args;
    if (!settingsPath || !hookPath) {
      console.error(
        "usage: install_task_mirror_hook.ts <settings.json path> <task_mirror_hook.sh path>\n" +
          "       install_task_mirror_hook.ts --uninstall <settings.json path>",
      );
      process.exit(2);
    }
    const r = installMirrorHookFile(settingsPath, hookPath);
    console.log(
      r.changed
        ? `task_mirror hook ${r.created ? "written to new" : "merged into"} ${settingsPath}`
        : `task_mirror hook already present in ${settingsPath}`,
    );
  }
}
