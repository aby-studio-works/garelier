import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmSync, assertPathMutation } from "../guard/path_guard.ts";
import { git } from "./_lib.ts";
import { removeStaleTrackedFiles, syncTreeViaTar, assertSyncMaterialized } from "./release.ts";

const temps: string[] = [];
afterEach(() => { for (const t of temps.splice(0)) { try { rmSync(t, { recursive: true, force: true }); } catch { /* best effort */ } } });

function scratch(prefix: string): string {
  const t = mkdtempSync(join(tmpdir(), prefix));
  temps.push(t);
  return t;
}

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.invalid"]);
  git(dir, ["config", "user.name", "Garelier Fixture"]);
}

function commitFile(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  git(dir, ["add", rel]);
  git(dir, ["commit", "-q", "-m", `add ${rel}`]);
}

// --- W-114: the publish clone is a SIBLING of the dev repo, so path_guard's
// default fence roots (cwd / nearest repo root / tmp) do not cover it and the
// release's own stale-file cleanup self-denied. The fix registers the resolved
// publish repo as a stable trusted root, scope-limited to that one root, while
// keeping the .git and shallow/traversal protections. ---

test("removeStaleTrackedFiles deletes a publish-repo stale tracked file and keeps exported ones", () => {
  const root = scratch("release-fn-");
  const exportRepo = join(root, "export");
  const publishRepo = join(root, "publish");
  initGitRepo(exportRepo);
  initGitRepo(publishRepo);

  // export = the desired public tree: keeps README, drops the retired ci.sh.
  commitFile(exportRepo, "README.md", "public\n");
  // publish clone carries a stale tracked file (ci.sh = the W-111 retired shim
  // from the real incident) plus a file the export still has.
  commitFile(publishRepo, "README.md", "public\n");
  commitFile(publishRepo, "ci.sh", "#!/usr/bin/env bash\n");

  expect(existsSync(join(publishRepo, "ci.sh"))).toBe(true);
  removeStaleTrackedFiles(publishRepo, exportRepo);

  expect(existsSync(join(publishRepo, "ci.sh"))).toBe(false); // stale removed, no self-deny
  expect(existsSync(join(publishRepo, "README.md"))).toBe(true); // still-exported kept
  expect(existsSync(join(publishRepo, ".git"))).toBe(true); // the clone's history is untouched
});

test("supplying the publish repo as a fence root flips the delete from deny to allow", () => {
  // A publish path OUTSIDE any default fence root (a sibling of an unrelated repo).
  const publishRepo = join(tmpdir(), "garelier-publish-fixture", "clone");
  const stale = join(publishRepo, "ci.sh");
  const elsewhere = join(tmpdir(), "garelier-publish-fixture", "other-root");

  // Without the publish repo among the roots, the delete is denied — the exact
  // W-114 failure (a sibling clone is outside cwd / repo / tmp-anchored roots).
  expect(() => assertPathMutation(stale, "delete", { fenceRoots: [elsewhere] }))
    .toThrow(/outside fence roots/);

  // Registering the publish repo as a trusted root allows it — the fix.
  expect(() => assertPathMutation(stale, "delete", { fenceRoots: [publishRepo] }))
    .not.toThrow();
});

test("the publish-repo root does not weaken .git or out-of-tree protection", () => {
  const publishRepo = join(tmpdir(), "garelier-publish-fixture", "clone");

  // .git under the publish repo stays denied even with the publish root supplied.
  expect(() => assertPathMutation(join(publishRepo, ".git", "config"), "delete", { fenceRoots: [publishRepo] }))
    .toThrow(/\.git/);

  // A path outside the publish repo is still denied — the added root is scoped to
  // the publish clone, it does not loosen anything else.
  const outside = join(tmpdir(), "garelier-publish-fixture", "not-the-clone", "secret");
  expect(() => assertPathMutation(outside, "delete", { fenceRoots: [publishRepo] }))
    .toThrow(/outside fence roots/);
});

// --- W-114 (tar portability): GNU tar treats a `-f C:\…` argument as a remote
// `host:file` (the drive letter is the host), and it swallows the backslashes of
// a `-C C:\…` argument so the chdir silently fails and extract writes nothing. An
// argv pin cannot catch that second failure — only a filesystem round-trip can, so
// these tests run the REAL resolved tar end to end. ---

test("syncTreeViaTar round-trips the export tree into the publish clone (real tar)", () => {
  const root = scratch("release-sync-");
  const exportDir = join(root, "export");
  const publishRepo = join(root, "publish");
  mkdirSync(join(exportDir, "sub"), { recursive: true });
  mkdirSync(publishRepo, { recursive: true });
  writeFileSync(join(exportDir, "README.md"), "public\n");
  writeFileSync(join(exportDir, "sub", "b.txt"), "nested\n");
  // .git must be excluded from the stream.
  mkdirSync(join(exportDir, ".git"), { recursive: true });
  writeFileSync(join(exportDir, ".git", "HEAD"), "ref: refs/heads/main\n");

  syncTreeViaTar(exportDir, publishRepo);

  // The files were actually materialized in the publish clone, with content intact.
  expect(existsSync(join(publishRepo, "README.md"))).toBe(true);
  expect(readFileSync(join(publishRepo, "README.md"), "utf8")).toBe("public\n");
  expect(readFileSync(join(publishRepo, "sub", "b.txt"), "utf8")).toBe("nested\n");
  expect(existsSync(join(publishRepo, ".git"))).toBe(false); // excluded
  // And the post-sync sanity agrees the tree was materialized.
  expect(() => assertSyncMaterialized(exportDir, publishRepo)).not.toThrow();
});

test("assertSyncMaterialized aborts on a deletions-only sync (extract wrote nothing)", () => {
  const root = scratch("release-gut-");
  const exportDir = join(root, "export");
  const publishRepo = join(root, "publish");
  mkdirSync(exportDir, { recursive: true });
  mkdirSync(publishRepo, { recursive: true });
  writeFileSync(join(exportDir, "README.md"), "public\n");
  writeFileSync(join(exportDir, "VERSION"), "9.9.9\n");
  // Simulate the W-114 failure: removeStale deleted the stale files, the extract
  // wrote NOTHING, so the publish clone is missing every export entry.
  expect(() => assertSyncMaterialized(exportDir, publishRepo)).toThrow(/did not materialize|deletions-only/);

  // Once the tree is really synced, the guard passes — no false positive.
  syncTreeViaTar(exportDir, publishRepo);
  expect(() => assertSyncMaterialized(exportDir, publishRepo)).not.toThrow();
});
