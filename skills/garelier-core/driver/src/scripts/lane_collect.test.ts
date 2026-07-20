import { rmSync } from "../guard/path_guard.ts";
import { test, expect, setDefaultTimeout } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W-095 (c) — review + collect + row-close proposal. Drives real isolate lanes.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const COLLECT = join(SCRIPTS, "lane_collect.ts");
const DISPATCH = join(SCRIPTS, "lane_dispatch.ts");
const ISOLATE = join(SCRIPTS, "workspace_isolate.ts");
setDefaultTimeout(60_000);

function git(repo: string, args: string[]): string {
  return Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" }).stdout?.toString() ?? "";
}

function bun(script: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", script, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

function mkLaneWithCommit(): { repo: string; wt: string } {
  const repo = mkdtempSync(join(tmpdir(), "lane-cl-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ci@ci"]);
  git(repo, ["config", "user.name", "ci"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  bun(DISPATCH, ["--repo", repo, "--slug", "lane", "--row", "W-5", "--pm-id", "_workshop", "--owner", "alice"]);
  const wt = join(repo, "__garelier", "_workshop", "_crew", "lanes", "lane");
  writeFileSync(join(wt, "added.txt"), "hi\n");
  git(wt, ["add", "-A"]);
  git(wt, ["-c", "commit.gpgsign=false", "commit", "-qm", "feat: added [W-5]"]);
  return { repo, wt };
}

function mkLegacyLaneWithCommit(): { repo: string; wt: string } {
  const repo = mkdtempSync(join(tmpdir(), "lane-cl-legacy-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ci@ci"]);
  git(repo, ["config", "user.name", "ci"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  mkdirSync(join(repo, ".garelier-work", ".meta"), { recursive: true });
  writeFileSync(join(repo, ".git", "info", "exclude"), ".garelier-work/\n");
  const wt = join(repo, ".garelier-work", "legacy");
  git(repo, ["worktree", "add", "-q", wt, "-b", "garelier/isolate/legacy", "main"]);
  writeFileSync(join(repo, ".garelier-work", ".meta", "legacy.json"), '{"base":"main"}\n');
  writeFileSync(join(wt, "legacy.txt"), "rescued\n");
  git(wt, ["add", "-A"]);
  git(wt, ["-c", "commit.gpgsign=false", "commit", "-qm", "fix: rescue legacy lane [W-94]"]);
  return { repo, wt };
}

test("W-095(c): --review-only lists commits + changed paths and does NOT integrate", () => {
  const { repo, wt } = mkLaneWithCommit();
  try {
    const r = bun(COLLECT, ["--repo", repo, "--slug", "lane", "--review-only"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("added.txt");
    expect(r.stdout).toContain("feat: added [W-5]");
    // lane still present (not collected)
    expect(existsSync(wt)).toBe(true);
    expect(git(repo, ["log", "--oneline", "main"]).trim().split("\n").length).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(c): collect fast-forwards into base, removes the lane, emits a close proposal", () => {
  const { repo, wt } = mkLaneWithCommit();
  try {
    const r = bun(COLLECT, ["--repo", repo, "--slug", "lane", "--row", "W-5"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PROPOSAL: mark W-5 DONE");
    // landed on main; lane worktree gone
    expect(git(repo, ["log", "--oneline", "main"])).toContain("feat: added [W-5]");
    expect(existsSync(wt)).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(c): the workspace_isolate clean-tree guard is passed through (dirty base -> non-zero)", () => {
  const { repo } = mkLaneWithCommit();
  try {
    // dirty the primary checkout so workspace_isolate --collect must refuse
    writeFileSync(join(repo, "seed.txt"), "seed dirtied\n");
    const r = bun(COLLECT, ["--repo", repo, "--slug", "lane"]);
    expect(r.code).not.toBe(0);
    // nothing landed
    expect(git(repo, ["log", "--oneline", "main"]).trim().split("\n").length).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-118/W-117: collect forwards every isolate argument and its exit-2 diagnostic", () => {
  const { repo } = mkLaneWithCommit();
  try {
    writeFileSync(join(repo, "seed.txt"), "seed dirtied\n");
    const direct = bun(ISOLATE, ["--collect", "--repo", repo, "--slug", "lane", "--base", "main", "--pm-id", "_workshop"]);
    const wrapped = bun(COLLECT, ["--repo", repo, "--slug", "lane", "--base", "main", "--pm-id", "_workshop"]);
    expect(direct.code).toBe(2);
    expect(wrapped.code).toBe(direct.code);
    expect(direct.stderr).toContain("working tree is not clean");
    expect(wrapped.stderr).toContain("working tree is not clean");
    expect(wrapped.stderr).toContain("workspace_isolate --collect failed (exit 2)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-102: collect rescues a pre-move .garelier-work lane and retires its exclude", () => {
  const { repo, wt } = mkLegacyLaneWithCommit();
  try {
    const r = bun(COLLECT, ["--repo", repo, "--slug", "legacy", "--row", "W-94"]);
    expect(r.code).toBe(0);
    expect(git(repo, ["log", "--oneline", "main"])).toContain("rescue legacy lane");
    expect(existsSync(wt)).toBe(false);
    expect(existsSync(join(repo, ".garelier-work"))).toBe(false);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).not.toContain(".garelier-work/");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
