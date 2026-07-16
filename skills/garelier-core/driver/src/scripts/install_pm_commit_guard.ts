#!/usr/bin/env bun
// Install the Garelier MAIN-worktree git-hook bundle (DEC-075 + DEC-088) into a
// TARGET project's main worktree hooks dir — TS port of install_pm_commit_guard.sh
// (W-083). Three hooks, each mechanical and reversible:
//   pre-commit  — main-worktree-only misplace guard + merge-gate race guard.
//   pre-rebase  — refuse rebasing studio / garelier/*.
//   pre-push    — never push garelier/*; no force push; opt-in promote guard.
//
// Per-clone, commits nothing, reversible (rm the hook). A pre-existing
// non-Garelier hook is PRESERVED as <hook>.local and chained first. Idempotent.
//
// Usage: install_pm_commit_guard [<project-root>]    (default: git toplevel)
import { existsSync, mkdirSync, readFileSync, copyFileSync, renameSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);

function git(argv: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", argv, { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}

const top = args[0] && args[0].length > 0 ? args[0] : (() => {
  const r = git(["rev-parse", "--show-toplevel"]);
  if (r.status !== 0) process.exit(r.status || 1);
  return r.stdout.trimEnd();
})();
const ROOT = top;
// The .sh's SCRIPT_DIR is garelier-core/scripts (where hooks/ lives). This TS
// sits at garelier-core/driver/src/scripts, so hooks/ is ../../../scripts/hooks.
const SCRIPT_DIR = resolve(import.meta.dir, "../../../scripts");

// Resolve the active hooks dir for the MAIN worktree (honor core.hooksPath).
const hp = git(["-C", ROOT, "config", "--get", "core.hooksPath"]);
const HP = hp.status === 0 ? hp.stdout.trimEnd() : "";
let HOOKS: string;
if (HP.length > 0) {
  HOOKS = HP.startsWith("/") ? HP : `${ROOT}/${HP}`;
  process.stderr.write(`install_pm_commit_guard: NOTE core.hooksPath is set (${HP}); installing the bundle there.\n`);
} else {
  const gcd = git(["-C", ROOT, "rev-parse", "--git-common-dir"]);
  if (gcd.status !== 0) process.exit(gcd.status || 1);
  HOOKS = `${gcd.stdout.trimEnd()}/hooks`;
}
mkdirSync(HOOKS, { recursive: true });

function installOne(name: string, mark: string): void {
  const src = `${SCRIPT_DIR}/hooks/${name}`;
  const dest = `${HOOKS}/${name}`;
  if (!existsSync(src)) {
    process.stderr.write(`install_pm_commit_guard: source hook missing at ${src}\n`);
    process.exit(1);
  }
  if (existsSync(dest)) {
    let body = "";
    try { body = readFileSync(dest, "utf8"); } catch {}
    if (!body.includes(mark)) {
      if (existsSync(`${HOOKS}/${name}.local`)) {
        process.stderr.write(`install_pm_commit_guard: ${HOOKS}/${name}.local already exists; refusing to clobber it. Resolve manually.\n`);
        process.exit(1);
      }
      renameSync(dest, `${HOOKS}/${name}.local`);
      try { chmodSync(`${HOOKS}/${name}.local`, 0o755); } catch {}
      console.log(`  + preserved the existing ${name} hook as ${name}.local (the guard chains it first)`);
    }
  }
  copyFileSync(src, dest);
  try { chmodSync(dest, 0o755); } catch {}
  console.log(`Installed Garelier ${name} guard -> ${dest}`);
}

installOne("pre-commit", "Garelier PM commit guard");
installOne("pre-rebase", "Garelier pre-rebase guard");
installOne("pre-push", "Garelier mechanical push guard");

console.log(`  per-clone, local only; main-worktree commit/rebase/push guards (DEC-075 + DEC-088).`);
console.log(`  overrides: GARELIER_ALLOW_NONSTUDIO_COMMIT=1 | GARELIER_ALLOW_REBASE=1 | GARELIER_ALLOW_TARGET_PUSH=1`);
console.log(`  disable a guard: rm "${HOOKS}/<hook>"`);
