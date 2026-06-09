// Ephemeral-branch garbage collection (DEC-021 / DEC-024).
//
// gavel / monocle / spyglass branches are COMMIT-FREE: a Guardian/Observer/Scout
// cuts one from the review-target tip at pickup and is supposed to delete it on
// return to IDLE. The deletion is an LLM step that fails in practice — the role
// often leaves its checkout worktree still ON the branch (so `git branch -D`
// reports "checked out"), or builds a compound `cd … && git …` command the
// headless allowlist won't auto-approve. Either way the branch lingers and a
// fresh one accrues every gate, so local branches pile up without bound.
//
// This closes it deterministically in the driver: once every role of a given
// kind is IDLE (no live gate/investigation can own a branch), delete each of its
// leftover ephemeral branches — detaching the owning worktree first when needed.
// Commit-free by design, so detaching + deleting loses nothing (the branch only
// named a snapshot of a commit that studio already holds).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./log.ts";
import type { SetupConfig } from "./config.ts";
import { roleContainer } from "./workspace.ts";

export interface GitRunResult { code: number; stdout: string; stderr: string; }
export type GitRunner = (args: string[], cwd: string) => GitRunResult;

const defaultGitRunner: GitRunner = (args, cwd) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return {
    code: r.exitCode ?? 1,
    stdout: r.stdout ? r.stdout.toString() : "",
    stderr: r.stderr ? r.stderr.toString() : "",
  };
};

interface WorktreeEntry { path: string; branch: string | null; }

/** Parse `git worktree list --porcelain` into (path, checked-out branch) pairs. */
export function parseWorktreePorcelain(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: { path?: string; branch: string | null } = { branch: null };
  const flush = () => { if (cur.path) out.push({ path: cur.path, branch: cur.branch }); };
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) { flush(); cur = { path: line.slice("worktree ".length).trim(), branch: null }; }
    else if (line.startsWith("branch ")) { cur.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, ""); }
  }
  flush();
  return out;
}

// Ephemeral (commit-free) branch kinds and the role that owns them.
const EPHEMERAL_KINDS: ReadonlyArray<{ word: string; role: "guardian" | "observer" | "scout" }> = [
  { word: "gavel", role: "guardian" },
  { word: "monocle", role: "observer" },
  { word: "spyglass", role: "scout" },
];

function containerStatus(container: string): string | null {
  try {
    const m = readFileSync(join(container, "STATE.md"), "utf8").match(/##\s*Status\s*\r?\n\s*([A-Za-z_]+)/);
    return m ? m[1]!.toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Delete orphaned commit-free ephemeral branches. Best-effort; never throws.
 * Returns the branch names actually deleted.
 *
 * Injectable `git` / `statusOf` for tests.
 */
export function gcEphemeralBranches(
  projectRoot: string,
  config: SetupConfig,
  log: Logger,
  opts: { git?: GitRunner; statusOf?: (container: string) => string | null } = {},
): string[] {
  const git = opts.git ?? defaultGitRunner;
  const statusOf = opts.statusOf ?? containerStatus;
  const deleted: string[] = [];

  // base = "garelier/<target-slug>/<pm_id>/" derived from the studio branch.
  const integ = config.branches.integration; // garelier/<slug>/<pm_id>/studio
  const base = integ.replace(/studio\/?$/, "");
  if (base === integ || !base.endsWith("/")) return deleted; // unexpected shape — bail safely

  const rolesByType: Record<string, ReadonlyArray<{ id: string }>> = {
    guardian: config.guardians,
    observer: config.observers,
    scout: config.scouts,
  };

  let worktrees: WorktreeEntry[] | null = null;
  const loadWorktrees = (): WorktreeEntry[] => {
    if (worktrees) return worktrees;
    const r = git(["worktree", "list", "--porcelain"], projectRoot);
    worktrees = r.code === 0 ? parseWorktreePorcelain(r.stdout) : [];
    return worktrees;
  };

  for (const { word, role } of EPHEMERAL_KINDS) {
    const roles = rolesByType[role] ?? [];
    // If ANY role of this kind is still busy, a live gate/investigation may own
    // a branch — skip this kind entirely (conservative).
    const anyBusy = roles.some((r) => {
      const st = statusOf(roleContainer(projectRoot, config.pmId, role, r.id));
      return st !== null && st !== "IDLE" && st !== "NO_STATE";
    });
    if (anyBusy) continue;

    const prefix = `${base}${word}/`;
    const listed = git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}`], projectRoot);
    if (listed.code !== 0) continue;
    const branches = listed.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (branches.length === 0) continue;

    for (const branch of branches) {
      const wt = loadWorktrees().find((w) => w.branch === branch);
      if (wt) {
        // Detach the worktree off the branch so it can be deleted. Commit-free
        // role → no tracked changes; the worktree's .claude/settings.local.json
        // is git-excluded so it does not block the detach.
        git(["checkout", "--detach"], wt.path);
      }
      const del = git(["branch", "-D", branch], projectRoot);
      if (del.code === 0) {
        deleted.push(branch);
        log.info("ephemeral_branch_gc", { branch, kind: word, detached_worktree: wt ? wt.path : null });
      } else {
        log.warn("ephemeral_branch_gc_failed", { branch, stderr: del.stderr.trim().slice(0, 200) });
      }
    }
  }
  return deleted;
}
