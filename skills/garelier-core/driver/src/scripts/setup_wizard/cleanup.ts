// W-083 ts-first: fresh-mode partial-install cleanup.
//
// Faithful port of resolve_cleanup_target / cleanup_partial_install from
// setup_wizard.sh (lines 1318-1418). Used only by the FRESH state machine when a
// prior interrupted install is detected (SETUP_STATE=partial). cwd-relative;
// git operations target GIT_ROOT.

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { git, type RunResult } from "../_lib.ts";
import { crewSubdirFromPmRoot } from "./paths.ts";
import { readTomlValue } from "./toml.ts";
import { trimLegacyRootBlock } from "./ignores.ts";

export interface CleanupCtx {
  pmId: string;
  gitRoot: string;
  target: string; // TARGET (may be empty)
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
function err(line: string): void {
  process.stderr.write(`${line}\n`);
}
function gt(ctx: CleanupCtx, args: string[]): RunResult {
  return git(ctx.gitRoot, args);
}
function verifyRef(ctx: CleanupCtx, ref: string): boolean {
  return gt(ctx, ["rev-parse", "--verify", ref]).exitCode === 0;
}
function currentBranch(ctx: CleanupCtx): string {
  const r = gt(ctx, ["symbolic-ref", "--short", "HEAD"]);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}
function worktreePaths(ctx: CleanupCtx): string[] {
  const r = gt(ctx, ["worktree", "list", "--porcelain"]);
  if (r.exitCode !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length));
}

// resolve_cleanup_target: the real (non-garelier) branch to switch onto.
export function resolveCleanupTarget(ctx: CleanupCtx): string {
  let candidate = "";
  if (ctx.target !== "" && !ctx.target.startsWith("garelier/")) candidate = ctx.target;
  if (candidate === "" && existsSync(`${crewSubdirFromPmRoot(`__garelier/${ctx.pmId}`, "_pm")}/setup_config.toml`)) {
    candidate = readTomlValue(ctx.pmId, "branches", "target");
    if (candidate.startsWith("garelier/")) candidate = "";
  }
  if (candidate === "") {
    const cur = currentBranch(ctx);
    if (cur !== "" && !cur.startsWith("garelier/")) candidate = cur;
  }
  if (candidate === "") {
    for (const cand of ["main", "develop"]) {
      if (verifyRef(ctx, cand)) {
        candidate = cand;
        break;
      }
    }
  }
  if (candidate === "") {
    const r = gt(ctx, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    if (r.exitCode === 0) {
      const first = r.stdout.split("\n").find((l) => l !== "" && !l.startsWith("garelier/"));
      candidate = first ?? "";
    }
  }
  return candidate;
}

// cleanup_partial_install <target-for-switch> <studio-to-delete>: false on error.
export function cleanupPartialInstall(ctx: CleanupCtx, targetForSwitch: string, studioToDelete: string): boolean {
  const pmRoot = `__garelier/${ctx.pmId}`;
  if (targetForSwitch === "" || targetForSwitch.startsWith("garelier/")) {
    err(`Error: cleanup target '${targetForSwitch}' is not a valid user target.`);
    err("       Pass --target <branch> explicitly to recover.");
    return false;
  }

  if (gt(ctx, ["worktree", "list", "--porcelain"]).exitCode === 0) {
    for (const wtpath of worktreePaths(ctx)) {
      if (
        wtpath.includes(`/${pmRoot}/_workers/`) ||
        wtpath.includes(`/${pmRoot}/_scouts/`) ||
        wtpath.includes(`/${pmRoot}/_smiths/`)
      ) {
        gt(ctx, ["worktree", "remove", "--force", wtpath]);
        out(`  - removed worktree ${wtpath}`);
        // DEC-020: drop the container (coordination files) too.
        if (wtpath.endsWith("/checkout")) rmSync(wtpath.slice(0, -"/checkout".length), { recursive: true, force: true });
      }
    }
  }

  const cur = currentBranch(ctx);
  if (cur.startsWith("garelier/")) {
    if (verifyRef(ctx, targetForSwitch)) {
      gt(ctx, ["checkout", targetForSwitch]);
      out(`  - primary worktree switched back to ${targetForSwitch}`);
    } else {
      err(`Error: target '${targetForSwitch}' does not exist; cannot switch off ${cur}.`);
      return false;
    }
  }

  if (studioToDelete !== "" && verifyRef(ctx, studioToDelete)) {
    gt(ctx, ["branch", "-D", studioToDelete]);
    out(`  - deleted branch ${studioToDelete}`);
  }

  if (existsSync(pmRoot)) {
    rmSync(pmRoot, { recursive: true, force: true });
    out(`  - removed ${pmRoot}/`);
  }

  trimLegacyRootBlock(".gitignore", "Garelier runtime");
  trimLegacyRootBlock(".ignore", "Garelier search-ignore");
  if (existsSync("__garelier") && !readdirSync("__garelier").some((e) => statSync(`__garelier/${e}`).isDirectory())) {
    rmSync("__garelier/.gitignore", { force: true });
    rmSync("__garelier/.ignore", { force: true });
    out("  - removed orphaned __garelier/.gitignore + .ignore (no PMs left)");
  }
  return true;
}
