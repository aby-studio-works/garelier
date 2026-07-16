// W-083 ts-first: setup_wizard teardown mode (W-050 "easy in, easy out").
//
// Faithful port of the teardown block (setup_wizard.sh lines 553-604). Strips
// only the Garelier hook wiring from settings.local.json files (merge-aware, via
// the driver installers' --uninstall) and INVENTORIES remaining worktrees —
// never auto-deletes. Exits before GIT_ROOT resolution and tool setup, so it is
// self-contained.

import { existsSync } from "node:fs";
import { git, run } from "../_lib.ts";
import { commandExists } from "./env.ts";
import { trimClaudeRuntimeIgnore } from "./ignores.ts";

export interface TeardownCtx {
  projectRoot: string;
  pmId: string;
  skillsDir: string;
  driverDir: string;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

// `${path#"$PROJECT_ROOT"/}` — strip the leading "<projectRoot>/" prefix.
function stripProjectPrefix(p: string, projectRoot: string): string {
  const prefix = `${projectRoot}/`;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function uninstall(installer: string, settings: string): boolean {
  return run(["bun", installer, "--uninstall", settings], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
}

export function runTeardown(ctx: TeardownCtx): number {
  const { projectRoot, pmId, skillsDir, driverDir } = ctx;
  out(`==> Garelier teardown for PM '${pmId}' — removing hook wiring (worktrees are only listed, never deleted)`);
  const installer = `${driverDir}/src/guard/install_hook.ts`;
  let removed = 0;
  if (!commandExists("bun")) {
    err(`  ! bun not found — cannot merge-aware clean settings; remove command_guard/runtime hook entries by hand.`);
  } else {
    const mirrorInstaller = `${driverDir}/src/dispatch/install_task_mirror_hook.ts`;
    const runtimeInstaller = `${driverDir}/src/dispatch/install_runtime_recovery_hook.ts`;
    const rootSettings = `${projectRoot}/.claude/settings.local.json`;
    if (existsSync(rootSettings)) {
      if (uninstall(installer, rootSettings)) {
        out(`  - project-root command_guard hook removed: ${rootSettings}`);
        removed++;
      }
      if (existsSync(rootSettings) && uninstall(mirrorInstaller, rootSettings)) {
        out(`  - project-root task_mirror hook removed: ${rootSettings}`);
        removed++;
      }
      if (existsSync(rootSettings) && uninstall(runtimeInstaller, rootSettings)) {
        out(`  - project-root runtime_recovery hook removed: ${rootSettings}`);
        removed++;
      }
    }
    const found = run([
      "find",
      `${projectRoot}/__garelier/${pmId}`,
      "-type",
      "f",
      "-path",
      "*/.claude/settings.local.json",
    ]);
    const checkouts = found.exitCode === 0 ? found.stdout.split("\n") : [];
    for (const s of checkouts) {
      if (s === "") continue;
      if (!existsSync(s)) continue;
      if (uninstall(installer, s)) {
        out(`  - checkout hook removed: ${stripProjectPrefix(s, projectRoot)}`);
        removed++;
      }
    }
  }
  if (removed === 0) out(`  = no command_guard hook wiring found (already clean)`);
  trimClaudeRuntimeIgnore(projectRoot);
  out("");
  out(`==> Remaining Garelier worktrees for PM '${pmId}' (NOT deleted — follow the two-stage rule):`);
  let n = 0;
  const wl = git(projectRoot, ["worktree", "list", "--porcelain"]);
  const worktrees =
    wl.exitCode === 0
      ? wl.stdout
          .split("\n")
          .filter((l) => /^worktree /.test(l))
          .map((l) => l.trim().split(/\s+/)[1] ?? "")
          .filter((p) => p.includes(`__garelier/${pmId}/`))
      : [];
  for (const w of worktrees) {
    if (w === "") continue;
    out(`    - ${stripProjectPrefix(w, projectRoot)}`);
    n++;
  }
  out(`  (${n} worktree(s); plus the container tree at __garelier/${pmId}/).`);
  out(`  Deletion follows garelier-core/references/deletion_and_forcewrite_safety.md:`);
  out(`    1. inventory (paths + count + size)   2. get approval   3. then remove`);
  out(`       (e.g. 'git worktree remove <path>' per approved entry, then remove __garelier/${pmId}/).`);
  out("");
  out(`==> Verify no wiring residue:`);
  out(`    bash "${skillsDir}/garelier-core/scripts/doctor.sh" --pm-id "${pmId}" --project "${projectRoot}"`);
  return 0;
}
