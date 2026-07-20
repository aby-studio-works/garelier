// record_paths.ts — the single resolver shared by the guard's record WRITER
// (attended_record.ts) and READER (command_guard.ts), so a record that is written
// is always found where the reader scans (W-150).
//
// The bug this fixes: a garelier lane / dispatch worktree is a LINKED git worktree
// that is itself a full checkout, so it carries a COMMITTED `__garelier/` copy. A
// naive nearest-first walk-up from the worktree finds that INNER `__garelier`
// first — the writer put the dispatch record under `<worktree>/__garelier/...`, a
// nested tree that holds no live record and that the reader never scans, so every
// command fell to the baseline-destructive seat and asked. Both sides now resolve
// the canonical control root through resolveControlRoot(), so their notions of
// "where the record lives" cannot drift apart.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";

/** The directory name of the garelier control tree. */
export const GARELIER_DIRNAME = "__garelier";

/** Every ancestor directory (including `from`) that has a `__garelier` child,
 * nearest → farthest. A producer working inside a FULL-REPO checkout worktree
 * sits under a committed inner `__garelier` tree, so more than one root can lie
 * along the path; the innermost one need not hold the live dispatch record
 * (#348, W-126). Shared here so the writer and reader walk identically (W-150). */
export function ancestorGareilerRoots(from: string): string[] {
  const roots: string[] = [];
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, GARELIER_DIRNAME))) roots.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

/** The repo MAIN-worktree root that owns the canonical `__garelier` control tree.
 *
 * A linked worktree (a garelier lane / dispatch checkout) carries its own
 * committed `__garelier`, so neither its own toplevel nor a nearest-first walk-up
 * is the canonical control root. `git rev-parse --git-common-dir` resolves the
 * SHARED `.git` even from a linked worktree; its parent is the main-worktree root.
 * That is authoritative whenever `from` is inside a real repo, and is why
 * `--show-toplevel` (which returns the linked worktree's OWN top) is not used.
 *
 * Fallback (not a git repo — synthesized fixtures / a detached path, or git
 * missing/slow): the FARTHEST ancestor that owns `__garelier`. Farthest rather
 * than nearest is deliberate — it skips the inner committed copy a full checkout
 * carries and lands on the outer (main) tree, matching what git reports. Returns
 * `from` resolved unchanged when nothing owns `__garelier`, so a caller that then
 * joins `__garelier` still surfaces the same not-found error as before. */
export function resolveControlRoot(from: string): string {
  const start = resolve(from);
  try {
    const commonDir = execFileSync(
      requireRuntimeExecutable("git"),
      ["-C", start, "rev-parse", "--git-common-dir"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000, windowsHide: true },
    ).trim();
    if (commonDir) {
      // `--git-common-dir` is returned relative to `start`; resolve it, then take
      // the gitdir's parent as the main-worktree root (standard `.git`-in-worktree
      // layout). Trust it only when it actually owns `__garelier`, otherwise fall
      // through to the filesystem walk (an exotic separate-gitdir layout).
      const gitDir = resolve(start, commonDir);
      const root = basename(gitDir) === ".git" ? dirname(gitDir) : gitDir;
      if (existsSync(join(root, GARELIER_DIRNAME))) return root;
    }
  } catch {
    // Not a git repo / git unavailable — fall through to the filesystem walk.
  }
  const roots = ancestorGareilerRoots(start);
  return roots.length ? roots[roots.length - 1] : start;
}
