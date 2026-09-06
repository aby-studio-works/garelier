import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertPathMutation,
  canonicalPath,
  configurePathGuardRoots,
  defaultFenceRoots,
  mainWorktreeRootFromGitDir,
  normalizePathFlavor,
  removeEmptyProbeGitDirSync,
  resetPathGuardRoots,
  rmSync,
} from "./path_guard.ts";

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

// W-354: one real path, two spellings, one verdict. `inside()` compares FLAVOR
// before it compares paths, so before normalization the MSYS spelling of an
// IN-FENCE path was denied while the Windows spelling of that same path was
// allowed. Both directions are pinned: the parity, and that normalization did
// not turn the fence into "allow everything" — an out-of-fence path is still
// refused under BOTH spellings.
test("W-354 a path's fence verdict does not depend on its POSIX/Windows spelling", () => {
  const windowsFence = "C:/env/project/repo";
  const posixFence = "/c/env/project/repo";
  const onWindows = process.platform === "win32";

  // The normalizer itself: only a single-letter first segment on a win32 host.
  expect(normalizePathFlavor("/c/env/x", "win32")).toBe("C:/env/x");
  expect(normalizePathFlavor("/cygdrive/c/env/x", "win32")).toBe("C:/env/x");
  expect(normalizePathFlavor("/c", "win32")).toBe("C:/");
  expect(normalizePathFlavor("/tmp/env/x", "win32")).toBe("/tmp/env/x");
  expect(normalizePathFlavor("//server/share/x", "win32")).toBe("//server/share/x");
  expect(normalizePathFlavor("/c/env/x", "linux")).toBe("/c/env/x");

  if (!onWindows) return; // the conversion is a win32-host rule by construction

  // IN-fence, both spellings, both as the CANDIDATE and as the declared ROOT.
  for (const fence of [windowsFence, posixFence]) {
    for (const candidate of [`${windowsFence}/showcase/x.md`, `${posixFence}/showcase/x.md`]) {
      expect(assertPathMutation(candidate, "write", { cwd: windowsFence, fenceRoots: [fence] }))
        .toBe(canonicalPath(`${windowsFence}/showcase/x.md`));
    }
  }
  // OUT-of-fence stays refused under both spellings — the counterfactual that
  // separates "the flavors agree" from "the fence stopped deciding".
  for (const candidate of ["C:/env/project/other/x.md", "/c/env/project/other/x.md"]) {
    expect(() => assertPathMutation(candidate, "write", { cwd: windowsFence, fenceRoots: [windowsFence] }))
      .toThrow(/outside fence roots/);
  }
  // W-545/W-575 (GF-12): the refusal names where the fence came from.
  expect(() => assertPathMutation("C:/env/project/other/x.md", "write", { cwd: windowsFence, fenceRoots: [windowsFence] }))
    .toThrow(/fence origin: caller-supplied fence roots/);
  expect(() => assertPathMutation("C:/env/project/other/x.md", "write", { cwd: windowsFence }))
    .toThrow(/fence origin: session cwd/);
});


// W-467: `configuredRoots` had an `add` and no counterpart, so within one process
// the fence only ever grew. Two consecutive scenarios, the first of which
// legitimately declares a root: WITHOUT the boundary reset the second scenario
// still trusts the first one's root. Asserted on the resolved ROOT SET rather
// than on a throw, because the fixture necessarily lives under `tmpdir()`, which
// `defaultFenceRoots` trusts unconditionally — a throw assertion there would be
// measuring the wrong thing.
// W-545: `mainWorktreeRoot` is what the attended PM control route DECLARES, and
// it is never a default root — so a seat-shaped call (explicit fence roots from
// its record) still cannot reach the parent repository.
test("W-467/W-545 declared fence roots are dropped at the operation boundary and the parent repo is never a default root", () => {
  const base = mkdtempSync(join(tmpdir(), "garelier-fence-lifecycle-"));
  cleanup.push(base);
  const main = join(base, "main");
  const lane = join(main, "lanes", "checkout");
  const sibling = join(base, "sibling", "tree");
  mkdirSync(join(main, ".git", "worktrees", "checkout"), { recursive: true });
  mkdirSync(lane, { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(lane, ".git"), `gitdir: ${join(main, ".git", "worktrees", "checkout")}\n`);
  const key = (path: string) => canonicalPath(path).toLowerCase();
  const roots = () => defaultFenceRoots(lane).map(key);

  resetPathGuardRoots();
  try {
    // Scenario 1 declares the sibling root for its own legitimate reason.
    configurePathGuardRoots([sibling]);
    expect(roots()).toContain(key(sibling));

    // Scenario 2 must not inherit it. Before the reset existed, it did.
    resetPathGuardRoots();
    expect(roots()).not.toContain(key(sibling));

    // W-545: a LINKED worktree .git is a FILE, so nearestRepoRoot answers the
    // lane itself and the parent repo is NOT a default fence root. It becomes one
    // only where a caller DECLARES it, which is how the attended PM control route
    // reaches its own control tree from a lane cwd (transaction_v3.test.ts holds
    // that end of the same rule).
    expect(roots()).not.toContain(key(main));
    configurePathGuardRoots([main]);
    expect(roots()).toContain(key(main));
    // A SEAT supplies explicit fence roots from its record, and a declared root
    // cannot widen those — so a seat inside the checkout still cannot write the
    // parent even while a declaration is live.
    expect(() => assertPathMutation(join(main, "control", "x.md"), "write",
      { cwd: lane, fenceRoots: [lane] })).toThrow(/outside fence roots/);
    // The in-fence direction of the same seat call still passes.
    expect(assertPathMutation(join(lane, "src", "x.ts"), "write", { cwd: lane, fenceRoots: [lane] }))
      .toBe(canonicalPath(join(lane, "src", "x.ts")));
    resetPathGuardRoots();
    expect(roots()).not.toContain(key(main));
    // W-545 r2: the shared common-gitdir rule is ONE function, and these are its
    // two shapes. `<main>/.git` resolves to `<main>`; a relocated or bare gitdir
    // IS the root. The two production call sites (control/cwd_fence.ts and
    // command_guard.ts) both go through it.
    expect(mainWorktreeRootFromGitDir(join(main, ".git"))).toBe(main);
    expect(mainWorktreeRootFromGitDir(join(main, "bare.git"))).toBe(join(main, "bare.git"));
  } finally {
    resetPathGuardRoots();
  }
});
