// W-734: seed a fixture repository's ITEM AUTHORITY into a commit.
//
// `issueRoleAuthorization` reads the work item's authority source out of `HEAD`
// (`git show HEAD:<rel>`), deliberately: the role owns its worktree, so a file
// that exists only in the working tree proves nothing about what was authorized.
// A fixture that merely WRITES its assignment is therefore refused with
// `item authority source is not committed at HEAD: …`.
//
// Ten unit cases across five files hit that refusal at once when the read moved
// to HEAD, because each of them wrote its assignment and went straight to
// `issueRoleAuthorization`. They are one defect, not ten, so this is one helper
// rather than ten repairs — the same shape as `commit_fixture_control` in
// ci.ts's smokes (W-731).
//
// It must be called BEFORE the test captures its immutable branch seed. Those
// suites keep a `studioBase` SHA and `git reset --hard` back to it between
// cases; seeding after the capture would put the authority on a commit that
// every `beforeEach` throws away.
//
// This changes only the FIXTURE. Production authorization is untouched, and a
// case that deliberately asserts the refusal keeps it by simply not seeding.

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { requireRuntimeExecutable } from "../scripts/_lib.ts";

export interface FixtureAuthorityFile {
  /** Path to write. Relative to `repo`, or already absolute — both resolve. */
  rel: string;
  content: string;
}

function git(repo: string, args: readonly string[]): { status: number; output: string } {
  const result = spawnSync(requireRuntimeExecutable("git"), [...args], {
    cwd: repo, encoding: "utf8", windowsHide: true,
  });
  return { status: result.status ?? 1, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/**
 * Write each file into `repo` and commit them, so `git show HEAD:<rel>` resolves.
 * Throws with git's own message on failure — a silently unseeded fixture would
 * resurface as the confusing `not committed at HEAD` refusal this exists to fix.
 */
export function seedFixtureItemAuthority(
  repo: string,
  files: readonly FixtureAuthorityFile[],
  message = "fixture: item authority",
): void {
  for (const file of files) {
    const absolute = resolve(repo, file.rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, file.content);
  }
  const add = git(repo, ["add", "-A"]);
  if (add.status !== 0) throw new Error(`seedFixtureItemAuthority: git add failed: ${add.output}`);
  const commit = git(repo, ["-c", "user.email=ci@ci", "-c", "user.name=ci", "-c", "commit.gpgsign=false",
    "commit", "-q", "-m", message]);
  // An empty commit means the files were already committed with identical bytes,
  // which is the desired end state, so only a real failure is an error.
  if (commit.status !== 0 && !/nothing to commit/i.test(commit.output)) {
    throw new Error(`seedFixtureItemAuthority: git commit failed: ${commit.output}`);
  }
}
