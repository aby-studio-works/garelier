import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertPathMutation, canonicalPath, removeEmptyProbeGitDirSync, rmSync } from "./path_guard.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("allows a deep path inside an explicit fence", () => {
  const root = mkdtempSync(join(tmpdir(), "garelier-path-guard-"));
  cleanup.push(root);
  const target = join(root, "runtime", "scratchpad", "entry");
  expect(assertPathMutation(target, "create", { fenceRoots: [root] })).toBe(canonicalPath(target));
});

test("rejects empty, drive-root, shallow, home, other-drive, traversal, ancestor, and .git paths", () => {
  const fence = "C:/env/project/repo";
  const denied: Array<string | undefined> = [
    undefined,
    "",
    "C:/",
    "C:/temp",
    "C:/Users/example",
    "D:/env/project/repo/file",
    "C:/env/project/repo/../../Windows/file",
    "C:/env",
    "C:/env/project/repo/.git",
    "C:/env/project/repo/.git/objects/aa",
  ];
  for (const path of denied) {
    expect(() => assertPathMutation(path, "delete", { cwd: "C:/env/project/repo", fenceRoots: [fence] })).toThrow();
  }
});

test("rejects a symlink escape after canonicalization", () => {
  const base = mkdtempSync(join(tmpdir(), "garelier-path-guard-"));
  cleanup.push(base);
  const fence = join(base, "fence");
  const outside = join(base, "outside");
  mkdirSync(fence, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "victim.txt"), "x");
  const link = join(fence, "escape");
  symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  expect(() => assertPathMutation(join(link, "victim.txt"), "delete", { fenceRoots: [fence] })).toThrow(/outside fence/);
});

test("never permits .git even when it is inside the fence", () => {
  const base = resolve(tmpdir(), "garelier", "deep", "repo");
  expect(() => assertPathMutation(join(base, ".git", "config"), "write", { fenceRoots: [base] })).toThrow(/\.git/);
});

test("probe exception removes only an exact empty .git directory", () => {
  const root = mkdtempSync(join(tmpdir(), "garelier-probe-git-"));
  cleanup.push(root);
  const empty = join(root, "empty", "anchor");
  const nonempty = join(root, "nonempty", "anchor");
  const gitFile = join(root, "file", "anchor");
  mkdirSync(join(empty, ".git"), { recursive: true });
  mkdirSync(join(nonempty, ".git"), { recursive: true });
  mkdirSync(gitFile, { recursive: true });
  writeFileSync(join(nonempty, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(gitFile, ".git"), "gitdir: elsewhere\n");

  expect(removeEmptyProbeGitDirSync(join(empty, ".git"), { cleanupRoots: [empty] }).removed).toBe(true);
  expect(existsSync(join(empty, ".git"))).toBe(false);
  expect(removeEmptyProbeGitDirSync(join(nonempty, ".git"), { cleanupRoots: [nonempty] }).removed).toBe(false);
  expect(existsSync(join(nonempty, ".git", "HEAD"))).toBe(true);
  expect(removeEmptyProbeGitDirSync(join(gitFile, ".git"), { cleanupRoots: [gitFile] }).removed).toBe(false);
  expect(existsSync(join(gitFile, ".git"))).toBe(true);
});

test("probe exception rejects protected, outside-allowlist, and reparse .git paths", () => {
  const root = mkdtempSync(join(tmpdir(), "garelier-probe-guards-"));
  cleanup.push(root);
  const protectedRoot = join(root, "protected", "anchor");
  const allowedRoot = join(root, "allowed", "anchor");
  const outsideRoot = join(root, "outside", "anchor");
  const linkRoot = join(root, "link", "anchor");
  const linkTarget = join(root, "link-target");
  for (const anchor of [protectedRoot, allowedRoot, outsideRoot, linkRoot, linkTarget]) mkdirSync(anchor, { recursive: true });
  mkdirSync(join(protectedRoot, ".git"));
  mkdirSync(join(outsideRoot, ".git"));
  symlinkSync(linkTarget, join(linkRoot, ".git"), process.platform === "win32" ? "junction" : "dir");

  expect(removeEmptyProbeGitDirSync(join(protectedRoot, ".git"), {
    cleanupRoots: [protectedRoot], protectedGitPaths: [join(protectedRoot, ".git")],
  }).reason).toContain("protected");
  expect(existsSync(join(protectedRoot, ".git"))).toBe(true);
  expect(removeEmptyProbeGitDirSync(join(outsideRoot, ".git"), { cleanupRoots: [allowedRoot] }).reason).toContain("outside");
  expect(existsSync(join(outsideRoot, ".git"))).toBe(true);
  expect(removeEmptyProbeGitDirSync(join(linkRoot, ".git"), { cleanupRoots: [linkRoot] }).removed).toBe(false);
  expect(existsSync(join(linkRoot, ".git"))).toBe(true);
});

test("probe exception fails closed when .git becomes non-empty at rmdir", () => {
  const root = mkdtempSync(join(tmpdir(), "garelier-probe-race-"));
  cleanup.push(root);
  const anchor = join(root, "race", "anchor");
  const candidate = join(anchor, ".git");
  mkdirSync(candidate, { recursive: true });
  const result = removeEmptyProbeGitDirSync(candidate, {
    cleanupRoots: [anchor],
    operations: {
      rmdirSync: (path) => {
        writeFileSync(join(String(path), "late-entry"), "race\n");
        throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" });
      },
    },
  });
  expect(result.removed).toBe(false);
  expect(result.reason).toContain("ENOTEMPTY");
  expect(existsSync(join(candidate, "late-entry"))).toBe(true);
});
