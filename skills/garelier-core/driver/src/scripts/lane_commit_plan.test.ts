import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTrailer, parseCommitPlans } from "./lane_commit_plan.ts";

// W-095 (f) — parse a codex COMMIT PLAN and proxy-commit it in the lane worktree
// with the trailer taken from the dispatch record. Pure-function units + a real
// end-to-end proxy-commit against a throwaway isolate lane.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const COMMIT_PLAN = join(SCRIPTS, "lane_commit_plan.ts");
const DISPATCH = join(SCRIPTS, "lane_dispatch.ts");

function git(repo: string, args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "") };
}

function bun(script: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lane-cp-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ci@ci"]);
  git(repo, ["config", "user.name", "ci"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  return repo;
}

test("W-095(f): parseCommitPlans extracts files + message from one block", () => {
  const plans = parseCommitPlans([
    "prose before",
    "=== COMMIT PLAN ===",
    "files:",
    "- a/one.ts",
    "- a/two.ts",
    "message:",
    "feat(x): do it [W-1]",
    "",
    "why",
    "=== END COMMIT PLAN ===",
    "prose after",
  ].join("\n"));
  expect(plans.length).toBe(1);
  expect(plans[0].files).toEqual(["a/one.ts", "a/two.ts"]);
  expect(plans[0].message).toBe("feat(x): do it [W-1]\n\nwhy");
});

test("W-095(f): parseCommitPlans handles MULTIPLE blocks in order", () => {
  const plans = parseCommitPlans([
    "=== COMMIT PLAN ===", "files:", "- p1", "message:", "first [W-1]", "=== END COMMIT PLAN ===",
    "=== COMMIT PLAN ===", "files:", "- p2", "message:", "second [W-1]", "=== END COMMIT PLAN ===",
  ].join("\n"));
  expect(plans.map((p) => p.files[0])).toEqual(["p1", "p2"]);
  expect(plans.map((p) => p.message)).toEqual(["first [W-1]", "second [W-1]"]);
});

test("W-095(f): ensureTrailer appends the record trailer, but not twice", () => {
  const t = "Garelier: _workshop isolate/x W-1";
  expect(ensureTrailer("feat: x [W-1]\n\nbody", t)).toBe(`feat: x [W-1]\n\nbody\n\n${t}`);
  // already present -> unchanged
  expect(ensureTrailer(`feat: x [W-1]\n\nbody\n\n${t}`, t)).toBe(`feat: x [W-1]\n\nbody\n\n${t}`);
});

test("W-095(f): end-to-end proxy-commit lands the plan with the record trailer", () => {
  const repo = mkRepo();
  try {
    bun(DISPATCH, ["--repo", repo, "--slug", "cx", "--row", "W-77", "--pm-id", "_workshop", "--owner", "seat", "--producer", "codex"]);
    const wt = join(repo, "__garelier", "_workshop", "_crew", "lanes", "cx");
    writeFileSync(join(wt, "new.txt"), "content\n");
    const resultPath = join(repo, "__garelier", "_workshop", "_crew", "lanes", ".meta", "cx.result.md");
    writeFileSync(resultPath, [
      "=== COMMIT PLAN ===",
      "files:",
      "- new.txt",
      "message:",
      "feat(cx): add new file [W-77]",
      "",
      "adds a file",
      "=== END COMMIT PLAN ===",
    ].join("\n"));
    const r = bun(COMMIT_PLAN, ["--repo", repo, "--slug", "cx"]);
    expect(r.code).toBe(0);
    const msg = git(wt, ["log", "-1", "--format=%B"]).out;
    expect(msg).toContain("feat(cx): add new file [W-77]");
    expect(msg).toContain("Garelier: _workshop isolate/cx W-77"); // trailer from the dispatch record
    // the file is actually committed (clean tree now)
    expect(git(wt, ["status", "--porcelain"]).out.trim()).toBe("");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(f): fail-closed when the result has no COMMIT PLAN (exit 2, nothing committed)", () => {
  const repo = mkRepo();
  try {
    bun(DISPATCH, ["--repo", repo, "--slug", "cx", "--row", "W-77", "--pm-id", "_workshop", "--owner", "seat", "--producer", "codex"]);
    const resultPath = join(repo, "__garelier", "_workshop", "_crew", "lanes", ".meta", "cx.result.md");
    writeFileSync(resultPath, "I did the work but forgot the plan block.\n");
    const r = bun(COMMIT_PLAN, ["--repo", repo, "--slug", "cx"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no COMMIT PLAN");
    const wt = join(repo, "__garelier", "_workshop", "_crew", "lanes", "cx");
    // HEAD unchanged (still the lane's base commit — no stray commit)
    expect(git(wt, ["log", "--oneline"]).out.trim().split("\n").length).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
