// W-083 ts-first: setup_wizard hook registration helpers.
//
// Faithful port of register_task_mirror_hook / register_runtime_recovery_hook
// from garelier-pm/scripts/setup_wizard.sh (lines 128-198). Both merge a
// framework hook into the TARGET PROJECT ROOT's .claude/settings.local.json via
// the driver installers, and both are no-ops (with an advisory line) when bun is
// unavailable.

import { commandExists, cygpathMixed, type GarelierDirs } from "./env.ts";
import { writeClaudeRuntimeIgnore } from "./ignores.ts";
import { run } from "../_lib.ts";

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

// register_task_mirror_hook <project-root>
export function registerTaskMirrorHook(projRoot: string, dirs: GarelierDirs): void {
  if (!commandExists("bun")) {
    out("  = bun not found; skipped task_mirror PostToolUse hook (install bun, then re-run the wizard)");
    return;
  }
  let hook = `${dirs.skillsDir}/garelier-core/hooks/task_mirror_hook.sh`;
  const installer = `${dirs.driverDir}/src/dispatch/install_task_mirror_hook.ts`;
  if (commandExists("cygpath")) hook = cygpathMixed(hook);
  const r = run(["bun", installer, `${projRoot}/.claude/settings.local.json`, hook], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (r.exitCode === 0) {
    out(
      `  + task_mirror PostToolUse hook registered at ${projRoot}/.claude/settings.local.json (Task-mirror delta injection)`,
    );
  }
}

// register_runtime_recovery_hook <project-root>
export function registerRuntimeRecoveryHook(projRoot: string, dirs: GarelierDirs): void {
  writeClaudeRuntimeIgnore(projRoot);
  if (!commandExists("bun")) {
    out("  = bun not found; skipped runtime_recovery hook (install bun, then re-run the wizard)");
    return;
  }
  let hook = `${dirs.skillsDir}/garelier-core/hooks/runtime_recovery_hook.ts`;
  const installer = `${dirs.driverDir}/src/dispatch/install_runtime_recovery_hook.ts`;
  if (commandExists("cygpath")) hook = cygpathMixed(hook);
  const r = run(["bun", installer, `${projRoot}/.claude/settings.local.json`, hook], {
    stdout: "ignore",
    stderr: "inherit",
  });
  if (r.exitCode === 0) {
    out(
      `  + runtime_recovery hooks registered at ${projRoot}/.claude/settings.local.json (runtime incident recovery)`,
    );
  }
}
