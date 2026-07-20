#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { requireRuntimeExecutable } from "./_lib.ts";

// W-165 detective: `__garelier/<pm_id>/showcase/` is a gitignored, transient
// deliverable drop-zone (retention.md § Showcase deliverables, W-085). A file
// COMMITTED there is a convention breach — a raw dump / task scratch that should
// have become an inspection summary + source path, not repo history. `gallery/`
// is the TRACKED sibling (curated keepers) and is exempt. This lint fails
// fast on any tracked showcase file so the drop-zone stays ephemeral.
export function trackedShowcaseFiles(lsFilesOutput: string): string[] {
  return lsFilesOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => /(?:^|\/)__garelier\/[^/]+\/showcase\//.test(path.replace(/\\/g, "/")));
}

export function lintTrackedShowcase(root: string): string[] {
  // git ls-files is the authority on what is tracked; an untracked showcase file
  // (the normal case) never appears here. Not-a-repo / git-missing => nothing to lint.
  const result = spawnSync(requireRuntimeExecutable("git"), ["-C", root, "ls-files"], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0 || typeof result.stdout !== "string") return [];
  return trackedShowcaseFiles(result.stdout);
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "..", "..", "..", "..", ".."));
  const tracked = lintTrackedShowcase(root);
  if (tracked.length) {
    process.stderr.write(
      `tracked showcase lint: ${tracked.length} file(s) committed under a gitignored showcase/ drop-zone.\n` +
        `showcase/ is transient (retention.md § Showcase, W-085): never git-add/commit it — untrack via\n` +
        `\`git rm --cached <path>\` and, for durable output, leave a summary + source path in an inspection.\n` +
        tracked.map((f) => `  ${f}`).join("\n") + "\n",
    );
    process.exit(1);
  }
  process.stdout.write("tracked showcase lint: OK\n");
}
