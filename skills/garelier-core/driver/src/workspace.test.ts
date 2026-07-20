import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  roleContainer,
  roleCheckout,
  legacyRoleContainer,
  crewRoleContainer,
  crewSubdir,
  dispatchContainer,
  isCrewLayout,
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

// === W-086 layout v2 (_crew) three-tier resolution ===

function crewProj(): string {
  const root = mkdtempSync(join(tmpdir(), "symph-crew-")).replace(/\\/g, "/");
  // v2 marker: the _crew/ base directory exists.
  mkdirSync(join(root, "__garelier", "pm1", "_crew"), { recursive: true });
  mkdirSync(join(root, "__garelier", "pm1", "runtime"), { recursive: true });
  return root;
}

test("crewRoleContainer maps worktree roles under _crew/, artisan singleton", () => {
  expect(crewRoleContainer("/p", "x", "worker", "w1")).toBe(
    "/p/__garelier/x/_crew/workers/w1",
  );
  expect(crewRoleContainer("/p", "x", "smith", "s1")).toBe(
    "/p/__garelier/x/_crew/smiths/s1",
  );
  expect(crewRoleContainer("/p", "x", "artisan", "")).toBe(
    "/p/__garelier/x/_crew/artisan",
  );
});

test("crew layout (no pointer) -> _crew container is the default", () => {
  _resetWorkspaceCache();
  const root = crewProj();
  expect(isCrewLayout(root, "pm1")).toBe(true);
  expect(roleContainer(root, "pm1", "worker", "worker-01")).toBe(
    `${root}/__garelier/pm1/_crew/workers/worker-01`,
  );
  expect(roleContainer(root, "pm1", "artisan", "")).toBe(
    `${root}/__garelier/pm1/_crew/artisan`,
  );
});

test("legacy layout (no _crew dir) -> flat container, unchanged (regression 0)", () => {
  _resetWorkspaceCache();
  const root = freshProj(); // no _crew/ dir
  expect(isCrewLayout(root, "pm1")).toBe(false);
  expect(roleContainer(root, "pm1", "worker", "worker-01")).toBe(
    `${root}/__garelier/pm1/_workers/worker-01`,
  );
});

test("pointer wins over _crew default (exile in a crew-layout project)", () => {
  _resetWorkspaceCache();
  const root = crewProj();
  const home = mkdtempSync(join(tmpdir(), "symph-home-")).replace(/\\/g, "/");
  writeFileSync(
    workspacePointerPath(root, "pm1"),
    `worker.worker-01=${home}/_workers/worker-01\n`,
  );
  _resetWorkspaceCache();
  expect(roleContainer(root, "pm1", "worker", "worker-01")).toBe(
    `${home}/_workers/worker-01`,
  );
});

test("existing on-disk flat container wins even in a crew-layout project (mid-migrate safety)", () => {
  _resetWorkspaceCache();
  const root = crewProj();
  // A stray legacy container physically present -> resolve to it, not the crew
  // default, so an interrupted migrate never orphans live work.
  mkdirSync(join(root, "__garelier", "pm1", "_workers", "worker-09"), {
    recursive: true,
  });
  expect(roleContainer(root, "pm1", "worker", "worker-09")).toBe(
    `${root}/__garelier/pm1/_workers/worker-09`,
  );
});

test("crewSubdir resolves _pm/_dock/_dispatch under both layouts", () => {
  _resetWorkspaceCache();
  const crew = crewProj();
  expect(crewSubdir(crew, "pm1", "_pm")).toBe(`${crew}/__garelier/pm1/_crew/pm`);
  expect(crewSubdir(crew, "pm1", "_dispatch3")).toBe(
    `${crew}/__garelier/pm1/_crew/dispatch3`,
  );
  expect(dispatchContainer(crew, "pm1", 3)).toBe(
    `${crew}/__garelier/pm1/_crew/dispatch3`,
  );
  const flat = freshProj();
  expect(crewSubdir(flat, "pm1", "_pm")).toBe(`${flat}/__garelier/pm1/_pm`);
  expect(dispatchContainer(flat, "pm1", "dispatch3")).toBe(
    `${flat}/__garelier/pm1/_dispatch3`,
  );
  // An on-disk legacy _dock wins over the crew default in a crew project.
  mkdirSync(join(crew, "__garelier", "pm1", "_dock"), { recursive: true });
  expect(crewSubdir(crew, "pm1", "_dock")).toBe(`${crew}/__garelier/pm1/_dock`);
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
