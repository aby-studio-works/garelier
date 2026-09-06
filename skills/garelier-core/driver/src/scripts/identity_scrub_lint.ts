#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { requireRuntimeExecutable, PRIVATE_IDENTIFIER_DENY_PATTERN } from "./_lib.ts";

// W-310: skills/ is the PUBLISHED surface — it is read directly on GitHub, not
// only through make-public-export.ts's publish-time gate (that gate only runs
// when a maintainer actually cuts an export; a dev-repo reader sees skills/
// as-is, unscrubbed, long before that). This lint reruns make-public-export.ts's
// built-in private-identifier deny (developer handle + private project name,
// case-insensitive SUBSTRING match — see that file's section 4 comment for why
// substring beats whole-word: it closes the underscore-joined-identifier
// evasion hole) against the tracked skills/ tree on every CI pass, so a
// reintroduced developer-specific proper noun fails fast instead of waiting
// for the next publish.
//
// The pattern itself is shared with make-public-export.ts via _lib.ts's
// PRIVATE_IDENTIFIER_DENY_PATTERN (W-310 rework, Guardian/Observer note 1) —
// see that constant's doc comment for why its own source text is safe to
// leave unexcluded.
const DENY_PATTERN = PRIVATE_IDENTIFIER_DENY_PATTERN;

// This lint and make-public-export.ts are excluded: both necessarily spell the
// deny term as code (mirrors make-public-export.ts's own $SELF exclusion).
const SELF_EXCLUDE = [
  "skills/garelier-core/driver/src/scripts/identity_scrub_lint.ts",
  "skills/garelier-core/driver/src/scripts/make-public-export.ts",
];

/** Pure parser: `git grep -nIiE <DENY_PATTERN> -- skills` output lines, minus
 * the files that legitimately spell the deny term as code. Kept separate from
 * the git invocation below so this filtering logic is unit-testable without a
 * real repo (mirrors showcase_tracked_lint.ts's trackedShowcaseFiles split). */
export function filterIdentityScrubHits(grepOutput: string): string[] {
  return grepOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !SELF_EXCLUDE.some((self) => line.replace(/\\/g, "/").startsWith(`${self}:`)));
}

export function lintIdentityScrub(root: string): string[] {
  const result = spawnSync(requireRuntimeExecutable("git"), ["-C", root, "grep", "-nIiE", DENY_PATTERN, "--", "skills"], {
    windowsHide: true,
    encoding: "utf8",
  });
  // status 0 = matched, 1 = no match (not an error), anything else = a git/repo
  // problem — fail open (nothing to lint) rather than block CI on infra noise.
  if (result.status !== 0 && result.status !== 1) return [];
  if (typeof result.stdout !== "string") return [];
  return filterIdentityScrubHits(result.stdout);
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? resolve(import.meta.dir, "..", "..", "..", "..", ".."));
  const hits = lintIdentityScrub(root);
  if (hits.length) {
    process.stderr.write(
      `identity scrub lint: ${hits.length} line(s) in skills/ (the published surface) still spell a\n` +
        `developer-private identifier (project name / dev handle) — see W-310. skills/ is read directly\n` +
        `on GitHub; it does not wait for make-public-export.ts's publish-time gate. Replace with a neutral\n` +
        `term, or, if this genuinely is the export gate itself spelling its own deny-list as code, add the\n` +
        `file to SELF_EXCLUDE in identity_scrub_lint.ts.\n` +
        hits.map((l) => `  ${l}`).join("\n") + "\n",
    );
    process.exit(1);
  }
  process.stdout.write("identity scrub lint: OK\n");
}
