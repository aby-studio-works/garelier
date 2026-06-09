import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  roleContainer,
  roleCheckout,
  legacyRoleContainer,
  workspacePointerPath,
  _resetWorkspaceCache,
} from "./workspace.ts";

function freshProj(): string {
  const root = mkdtempSync(join(tmpdir(), "symph-ws-"));
  mkdirSync(join(root, "__garelier", "pm1", "runtime"), { recursive: true });
  return root.replace(/\\/g, "/");
}

test("no pointer -> legacy in-proj container (worktree role + artisan)", () => {
  _resetWorkspaceCache();
  const root = freshProj();
  expect(roleContainer(root, "pm1", "worker", "worker-01")).toBe(
    `${root}/__garelier/pm1/_workers/worker-01`,
  );
  expect(roleContainer(root, "pm1", "artisan", "")).toBe(
    `${root}/__garelier/pm1/_artisan`,
  );
  expect(roleCheckout(root, "pm1", "worker", "worker-01")).toBe(
    `${root}/__garelier/pm1/_workers/worker-01/checkout`,
  );
});

test("pointer -> exile container; artisan singleton; fallback for unlisted id", () => {
  _resetWorkspaceCache();
  const root = freshProj();
  const home = mkdtempSync(join(tmpdir(), "symph-home-")).replace(/\\/g, "/");
  writeFileSync(
    workspacePointerPath(root, "pm1"),
    [
      "# DEC-035 workspace pointer",
      `worker.worker-01=${home}/_workers/worker-01`,
      `artisan=${home}/_artisan`,
      "",
    ].join("\n"),
  );
  _resetWorkspaceCache();
  expect(roleContainer(root, "pm1", "worker", "worker-01")).toBe(
    `${home}/_workers/worker-01`,
  );
  expect(roleContainer(root, "pm1", "artisan", "")).toBe(`${home}/_artisan`);
  expect(roleCheckout(root, "pm1", "worker", "worker-01")).toBe(
    `${home}/_workers/worker-01/checkout`,
  );
  // An id not listed in the pointer falls back to the legacy in-proj path
  // (handles partially-migrated / mixed installs).
  expect(roleContainer(root, "pm1", "worker", "worker-02")).toBe(
    `${root}/__garelier/pm1/_workers/worker-02`,
  );
});

test("legacyRoleContainer maps role kinds to plural dirs; artisan has no id", () => {
  expect(legacyRoleContainer("/p", "x", "smith", "s1")).toBe(
    "/p/__garelier/x/_smiths/s1",
  );
  expect(legacyRoleContainer("/p", "x", "concierge", "c1")).toBe(
    "/p/__garelier/x/_concierges/c1",
  );
  expect(legacyRoleContainer("/p", "x", "artisan", "")).toBe(
    "/p/__garelier/x/_artisan",
  );
});
