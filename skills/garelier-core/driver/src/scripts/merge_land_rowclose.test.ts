import { rmSync } from "../guard/path_guard.ts";
// W-147: merge_land row-close must commit ONLY the struck rows, never a PM's parallel
// uncommitted backlog edits (the 5095f4a18 incident: a chore close commit silently
// carried a W-547 起票 + W-542 修正). commitRowClose isolates the strike; these pin it
// against a REAL git repo (the isolation is a git-plumbing behaviour, not pure logic).
import { afterEach, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRowClose, countDiffHunks, strikeRow } from "./merge_land.ts";

const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true }); });

function git(repo: string, args: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? 1, stdout: r.stdout?.toString() ?? "" };
}

// A repo with a committed backlog holding W-093 (to strike) + W-100 (to keep).
function seedRepo(): { repo: string; backlogPath: string; committed: string } {
  const repo = mkdtempSync(join(tmpdir(), "garelier-ml-rowclose-"));
  tmps.push(repo);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "t@t"]);
  git(repo, ["config", "user.name", "t"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  const dir = join(repo, "control", "project_dashboard");
  mkdirSync(dir, { recursive: true });
  const backlogPath = join(dir, "backlog.md");
  const committed = [
    "# Backlog", "",
    "| ID | Type | Status | Detail |",
    "| --- | --- | --- | --- |",
    "| W-093 | feature | ready | close me |",
    "| W-100 | bug | ready | keep me |",
    "",
  ].join("\n");
  writeFileSync(backlogPath, committed);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "seed backlog"]);
  return { repo, backlogPath, committed };
}

test("W-147: a PM parallel edit is PRESERVED — the close commit contains only the struck row", () => {
  const { repo, backlogPath, committed } = seedRepo();
  // PM adds a NEW row W-999 to the working tree (uncommitted), parallel to the close.
  const workingRaw = committed.replace(
    "| W-100 | bug | ready | keep me |\n",
    "| W-100 | bug | ready | keep me |\n| W-999 | bug | ready | PM parallel new row (uncommitted) |\n",
  );
  writeFileSync(backlogPath, workingRaw);
  const struck = strikeRow(workingRaw, "W-093").text; // PM edit + W-100, minus W-093
  const commitArgs = ["git", "-C", repo, "commit", "-q", "-m", "chore(dashboard): W-093 close", "--", backlogPath];
  const res = commitRowClose({ backlogPath, blGit: repo, closed: ["W-093"], workingRaw, struckContent: struck, commitArgs, tmpDir: repo });

  expect(res.rowClose).toBe("closed");
  expect(res.isolated).toBe(true);
  expect(res.preservedHunks).toBeGreaterThanOrEqual(1);

  // The close COMMIT deletes ONLY W-093 — the PM's W-999 is NOT in it.
  const show = git(repo, ["show", "HEAD", "--", backlogPath]).stdout;
  expect(show).toContain("-| W-093 | feature | ready | close me |");
  expect(show).not.toContain("W-999");

  // The committed backlog (HEAD) has W-093 gone and W-999 NOT swept in.
  const headBacklog = git(repo, ["show", "HEAD:control/project_dashboard/backlog.md"]).stdout;
  expect(headBacklog).not.toContain("W-093");
  expect(headBacklog).not.toContain("W-999");
  expect(headBacklog).toContain("W-100");

  // The PM's W-999 survives as an UNCOMMITTED working-tree change.
  expect(readFileSync(backlogPath, "utf8")).toContain("W-999");
  expect(git(repo, ["status", "--porcelain", "--", backlogPath]).stdout.trim()).not.toBe("");
});

test("W-147: no PM edit -> plain whole-file commit path (isolated=false), row struck & committed", () => {
  const { repo, backlogPath, committed } = seedRepo();
  const workingRaw = committed; // clean = identical to HEAD
  writeFileSync(backlogPath, strikeRow(workingRaw, "W-093").text);
  const struck = strikeRow(workingRaw, "W-093").text;
  const commitArgs = ["git", "-C", repo, "commit", "-q", "-m", "chore(dashboard): W-093 close", "--", backlogPath];
  const res = commitRowClose({ backlogPath, blGit: repo, closed: ["W-093"], workingRaw, struckContent: struck, commitArgs, tmpDir: repo });
  expect(res.rowClose).toBe("closed");
  expect(res.isolated).toBe(false);
  const headBacklog = git(repo, ["show", "HEAD:control/project_dashboard/backlog.md"]).stdout;
  expect(headBacklog).not.toContain("W-093");
  expect(headBacklog).toContain("W-100");
  expect(git(repo, ["status", "--porcelain", "--", backlogPath]).stdout.trim()).toBe(""); // clean after commit
});

test("W-147: countDiffHunks counts contiguous change regions (advisory preserved-hunk count)", () => {
  const repo = mkdtempSync(join(tmpdir(), "garelier-ml-hunks-"));
  tmps.push(repo);
  const a = ["l1", "l2", "l3", "l4", "l5", "l6"].join("\n");
  const b = ["l1", "CHANGED2", "l3", "l4", "INSERTED", "l5", "l6"].join("\n"); // two separate regions
  expect(countDiffHunks(a, b, repo)).toBe(2);
  expect(countDiffHunks(a, a, repo)).toBe(0); // identical -> no hunks
});
