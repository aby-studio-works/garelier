import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W-095 (a) — one-command isolate-lane dispatch. Pins: it cuts the owner-locked
// worktree, synthesizes a prompt carrying the scope fence + verify step + commit
// trailer, creates the instruction ledger, writes a dispatch record, and emits a
// codex launch_cmd (codex) or points at the prompt (claude). Drives the real
// script against throwaway repos.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const DISPATCH = join(SCRIPTS, "lane_dispatch.ts");

function git(repo: string, args: string[]): void {
  Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
}

function bun(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", DISPATCH, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "lane-dp-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ci@ci"]);
  git(repo, ["config", "user.name", "ci"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  return repo;
}

function firstJson(stdout: string): any {
  const line = stdout.trim().split("\n").find((l) => l.startsWith("{"));
  return line ? JSON.parse(line) : undefined;
}

test("W-095(a): claude dispatch synthesizes prompt (scope+verify+trailer), ledger, record", () => {
  const repo = mkRepo();
  try {
    const r = bun(["--repo", repo, "--slug", "feat-a", "--row", "W-3", "--pm-id", "_workshop", "--owner", "alice", "--title", "do a thing", "--scope", "only src/a.ts"]);
    expect(r.code).toBe(0);
    const j = firstJson(r.stdout);
    expect(j.producer).toBe("claude");
    expect(j.launch_cmd).toBeUndefined();
    expect(j.worktree.replace(/\\/g, "/")).toEndWith("/__garelier/_workshop/_crew/lanes/feat-a");
    expect(j.prompt_file.replace(/\\/g, "/")).toContain("/__garelier/_workshop/_crew/lanes/.meta/");
    expect(j.verify_cmd).toContain('--pm-id "_workshop"');
    const prompt = readFileSync(j.prompt_file, "utf8");
    expect(prompt).toContain("only src/a.ts");                        // scope fence
    expect(prompt).toContain("do a thing");                           // task
    expect(prompt).toContain("Garelier: _workshop isolate/feat-a W-3"); // commit trailer
    expect(prompt).toContain("lane_verify");                          // verify step
    expect(existsSync(j.instructions_file)).toBe(true);
    const rec = JSON.parse(readFileSync(j.record_file, "utf8"));
    expect(rec.owner).toBe("alice");
    expect(rec.row).toBe("W-3");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(a): codex dispatch emits a dispatch_codex_producer launch_cmd + COMMIT PLAN format", () => {
  const repo = mkRepo();
  try {
    const r = bun(["--repo", repo, "--slug", "feat-c", "--row", "W-4", "--pm-id", "_workshop", "--owner", "seat", "--producer", "codex"]);
    expect(r.code).toBe(0);
    const j = firstJson(r.stdout);
    expect(j.producer).toBe("codex");
    expect(j.launch_cmd).toContain("dispatch_codex_producer.sh");
    const prompt = readFileSync(j.prompt_file, "utf8");
    expect(prompt).toContain("=== COMMIT PLAN ===");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(a): owner lock — a second dispatch on the same slug is refused, names the owner", () => {
  const repo = mkRepo();
  try {
    expect(bun(["--repo", repo, "--slug", "busy", "--row", "W-5", "--pm-id", "_workshop", "--owner", "alice"]).code).toBe(0);
    const second = bun(["--repo", repo, "--slug", "busy", "--row", "W-5", "--pm-id", "_workshop", "--owner", "bob"]);
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain("alice"); // collision names the current owner (W-095 (d))
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(a): --owner is required (it is the lane lock)", () => {
  const repo = mkRepo();
  try {
    const r = bun(["--repo", repo, "--slug", "no-owner", "--row", "W-6", "--pm-id", "_workshop"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--owner");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
