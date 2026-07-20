import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBacklogRowClaim } from "./lint_commits";

// Pins the W-054 ci.ts lint (workshop backlog): a commit message that CLAIMS
// 起票/close of a W-<id> row must actually touch a matching `| W-<id> |`
// backlog table row in its diff — the same "bookkeeping claims vs reality"
// failure class as the false-abort bug this row shipped alongside (a prior
// session's commit message said 起票 but the row was never written, producing
// a phantom W-054 that a LATER session had to file again).
//
// Uses node:fs writeFileSync (synchronous), not Bun.write (a Promise) — an
// earlier draft of this file called Bun.write without awaiting it inside a
// sync test callback, which raced `git add -A` against the still-in-flight
// write and made `git commit -q` intermittently fail with an empty stderr
// ("nothing to commit", swallowed by -q) under `bun test`'s scheduler,
// though not under a plain `bun run` of the same steps. writeFileSync avoids
// the whole class of bug.
function sh(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(r.stderr)}`);
  }
}

let root: string;
afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mkRepo(): string {
  root = mkdtempSync(join(tmpdir(), "garelier-lintcommits-"));
  sh(root, "init", "-q");
  sh(root, "config", "user.email", "ci@ci");
  sh(root, "config", "user.name", "t");
  return root;
}

describe("checkBacklogRowClaim", () => {
  test("no warning when the claimed row IS in the diff (real close pattern)", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "backlog.md"), "| ID | Status |\n| --- | --- |\n| W-100 | ready |\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "chore(dashboard): W-100 close (merged abc1234)");
    writeFileSync(join(dir, "backlog.md"), "| ID | Status |\n| --- | --- |\n");
    sh(dir, "add", "-A");
    const msg = "chore(dashboard): W-100 close (merged abc1234)";
    sh(dir, "commit", "-q", "-m", msg);
    const warnings = checkBacklogRowClaim(dir, "HEAD", msg);
    expect(warnings).toEqual([]);
  });

  test("warns when the message claims 起票 for a W-id but the diff never touches that row (the phantom W-054 pattern)", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "unrelated.md"), "hello\n");
    sh(dir, "add", "-A");
    const msg = "docs(workshop): W-054 起票 (merge gate false-abort)";
    sh(dir, "commit", "-q", "-m", msg);
    const warnings = checkBacklogRowClaim(dir, "HEAD", msg);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("W-054");
  });

  test("warns when the diff touches a DIFFERENT row than the one claimed", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "backlog.md"), "| ID | Status |\n| --- | --- |\n| W-200 | ready |\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "init");
    writeFileSync(join(dir, "backlog.md"), "| ID | Status |\n| --- | --- |\n");
    sh(dir, "add", "-A");
    const msg = "chore(dashboard): W-054 close (merged def5678)"; // claims W-054, diff struck W-200
    sh(dir, "commit", "-q", "-m", msg);
    const warnings = checkBacklogRowClaim(dir, "HEAD", msg);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("W-054");
  });

  test("no warning when the id and the claim verb are on DIFFERENT lines (range-reference false positive)", () => {
    // Real false positive hit rolling this lint out: a commit's SUBJECT line
    // claims 起票 for one id, and an unrelated BODY line range-references a
    // different id ("out of this release's W-054..057 scope") with no claim
    // verb anywhere near it — whole-message matching wrongly flagged W-054.
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "x\n");
    sh(dir, "add", "-A");
    const msg = "docs(workshop): W-058 起票 (some new row)\n\nFiling only; out of this release's W-054..057 scope.\n";
    sh(dir, "commit", "-q", "-m", msg);
    const warnings = checkBacklogRowClaim(dir, "HEAD", msg);
    // W-058 IS claimed (id + verb share the subject line) and its row was
    // never touched, so exactly one warning for W-058 — never one for W-054.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("W-058");
    expect(warnings[0]).not.toContain("W-054");
  });

  test("no warning for a commit with no claim verb at all", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "x\n");
    sh(dir, "add", "-A");
    const msg = "feat(core): implement W-054 handling";
    sh(dir, "commit", "-q", "-m", msg);
    const warnings = checkBacklogRowClaim(dir, "HEAD", msg);
    expect(warnings).toEqual([]);
  });

  test("no warning for a commit with a claim verb but no W-id at all", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "f.txt"), "x\n");
    sh(dir, "add", "-A");
    const msg = "chore: close out the stale branch";
    sh(dir, "commit", "-q", "-m", msg);
    const warnings = checkBacklogRowClaim(dir, "HEAD", msg);
    expect(warnings).toEqual([]);
  });

  test("a prose mention of the id on a changed line (not a `| W-id |` row cell) still warns", () => {
    const dir = mkRepo();
    writeFileSync(join(dir, "notes.md"), "old note\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "init");
    writeFileSync(join(dir, "notes.md"), "old note\nsee W-054 for background\n");
    sh(dir, "add", "-A");
    const msg = "docs(workshop): W-054 起票 (background note)";
    sh(dir, "commit", "-q", "-m", msg);
    const warnings = checkBacklogRowClaim(dir, "HEAD", msg);
    expect(warnings.length).toBe(1);
  });
});
