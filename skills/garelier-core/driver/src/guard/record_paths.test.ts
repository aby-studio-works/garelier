import { afterEach, test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rmSync } from "./path_guard.ts";
import { ancestorGareilerRoots, resolveControlRoot, GARELIER_DIRNAME } from "./record_paths.ts";

const tempRoots: string[] = [];
afterEach(() => { for (const r of tempRoots.splice(0)) rmSync(r, { recursive: true, force: true }); });

let hasGit = false;
try { execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true }); hasGit = true; } catch { /* skip git branch */ }
const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
};

test("ancestorGareilerRoots returns nearest → farthest, including an inner committed tree", () => {
  const root = mkdtempSync(join(tmpdir(), "record-paths-anc-"));
  tempRoots.push(root);
  // A full-repo checkout worktree carries its own committed __garelier under the
  // outer one, so two roots lie along the path.
  const inner = join(root, "__garelier", "pm", "_crew", "lanes", "lane");
  mkdirSync(join(inner, "__garelier", "pm"), { recursive: true });
  const roots = ancestorGareilerRoots(inner);
  expect(roots[0]).toBe(resolve(inner));                 // nearest = the inner checkout
  expect(roots[roots.length - 1]).toBe(resolve(root));   // farthest = the main tree
});

test("resolveControlRoot FALLBACK (not a git repo) picks the FARTHEST __garelier, skipping the inner committed copy", () => {
  const root = mkdtempSync(join(tmpdir(), "record-paths-fallback-"));
  tempRoots.push(root);
  // A fake, invalid `.git` makes `git rev-parse` fail (exit 128) and NOT traverse
  // above it, so this deterministically exercises the walk-up fallback.
  mkdirSync(join(root, ".git"), { recursive: true });
  const lane = join(root, "__garelier", "_workshop", "_crew", "lanes", "lane");
  mkdirSync(join(lane, "__garelier", "_workshop"), { recursive: true }); // inner committed copy
  // Nearest-first (the OLD writer behavior) would return the inner copy; the fix
  // lands on the outer main tree.
  expect(resolveControlRoot(lane)).toBe(resolve(root));
  expect(resolveControlRoot(lane)).not.toBe(resolve(lane));
});

test("resolveControlRoot returns the input unchanged when nothing owns __garelier (caller then errors on the missing dir)", () => {
  const root = mkdtempSync(join(tmpdir(), "record-paths-none-"));
  tempRoots.push(root);
  mkdirSync(join(root, ".git"), { recursive: true }); // git fails → fallback → no __garelier anywhere
  const bare = join(root, "sub", "dir");
  mkdirSync(bare, { recursive: true });
  expect(resolveControlRoot(bare)).toBe(resolve(bare));
});

// The production path: a REAL linked worktree. git-common-dir must resolve to the
// MAIN worktree root even though the linked checkout carries a committed inner
// __garelier — the exact shape of the W-150 incident.
test.skipIf(!hasGit)("resolveControlRoot GIT branch resolves a linked worktree to its MAIN root, not the inner committed __garelier", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "record-paths-git-"));
  tempRoots.push(baseDir);
  const main = join(baseDir, "main");
  const lane = join(baseDir, "lane");
  mkdirSync(join(main, GARELIER_DIRNAME), { recursive: true });
  writeFileSync(join(main, GARELIER_DIRNAME, ".keep"), ""); // a file so git tracks __garelier/
  git(main, ["init", "-q"]);
  git(main, ["add", "-A"]);
  git(main, ["-c", "user.email=t@example.com", "-c", "user.name=test", "commit", "-q", "-m", "init"]);
  git(main, ["worktree", "add", "-q", "--detach", lane, "HEAD"]);

  expect(existsSync(join(lane, GARELIER_DIRNAME))).toBe(true);            // inner committed copy present
  expect(realpathSync(resolveControlRoot(lane))).toBe(realpathSync(main)); // resolves to MAIN via git-common-dir
  expect(resolveControlRoot(lane)).not.toBe(resolve(lane));               // NOT the inner (fallback would give this)
});
