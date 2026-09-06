#!/usr/bin/env bun
// Non-privileged public-tree helpers retained for regression coverage. The
// release engine itself is private to concierge_release.ts, after its canonical
// approval, attended-seat, Guardian, destination, and lock checks.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { configurePathGuardRoots, rmSync } from "../guard/path_guard.ts";
import {
  assertTreeMaterialized,
  die,
  git,
  spawnStreamPipe,
  type RunResult,
} from "./_lib.ts";

function mustGit(label: string, repo: string, args: string[]): RunResult {
  const result = git(repo, args);
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    die(`ABORT: ${label}${detail ? `\n${detail}` : ""}`, result.exitCode || 1);
  }
  return result;
}

export function removeStaleTrackedFiles(publicRepo: string, exportRepo: string): void {
  configurePathGuardRoots([publicRepo]);
  const exported = new Set(
    mustGit("cannot list export files", exportRepo, ["ls-files", "-z"]).stdout
      .split("\0")
      .filter(Boolean),
  );
  const publicFiles = mustGit(
    "cannot list public files",
    publicRepo,
    ["ls-files", "-z"],
  ).stdout
    .split("\0")
    .filter(Boolean);
  for (const path of publicFiles) {
    if (exported.has(path)) continue;
    if (path === ".git" || path.startsWith(".git/") || path.includes("..") || path.startsWith("/")) {
      die(`ABORT: unsafe tracked path while syncing public repo: ${path}`);
    }
    rmSync(join(publicRepo, path), { recursive: true, force: true });
  }
}

export function syncTreeViaTar(exportDir: string, publishRepo: string): void {
  spawnStreamPipe(
    "release",
    { command: ["tar", "-cf", "-", "--exclude=.git", "."], cwd: exportDir },
    { command: ["tar", "-xf", "-"], cwd: publishRepo },
  );
}

export function assertSyncMaterialized(exportDir: string, publishRepo: string): void {
  const expected = readdirSync(exportDir).filter((entry) => entry !== ".git");
  assertTreeMaterialized(publishRepo, expected, "public sync");
}

if (import.meta.main) {
  die(
    "release: direct execution is disabled; the privileged engine is private to concierge_release.ts",
  );
}
