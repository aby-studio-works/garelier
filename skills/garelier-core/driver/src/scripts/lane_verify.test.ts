import { rmSync } from "../guard/path_guard.ts";
import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W-095 (b) — exit-safe verification runner. Pins that a step's REAL exit code
// is captured (no pipe masking) so a failing step forces FAIL, and that a
// passing set reports PASS with a verbatim summary. Drives the real script.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const VERIFY = join(SCRIPTS, "lane_verify.ts");
const ISOLATE = join(SCRIPTS, "workspace_isolate.ts");

function git(repo: string, args: string[]): void {
  Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
}

function mkLane(): { repo: string; slug: string } {
  const repo = mkdtempSync(join(tmpdir(), "lane-vf-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ci@ci"]);
  git(repo, ["config", "user.name", "ci"]);
  mkdirSync(join(repo, "__garelier", "_workshop"), { recursive: true });
  writeFileSync(join(repo, "f.txt"), "x\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  Bun.spawnSync(["bun", ISOLATE, "--repo", repo, "--slug", "lane"], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  return { repo, slug: "lane" };
}

function verify(repo: string, slug: string, extra: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync(["bun", VERIFY, "--repo", repo, "--slug", slug, ...extra], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout?.toString() ?? "" };
}

test("W-095(b): all steps pass -> exit 0, verdict PASS", () => {
  const { repo, slug } = mkLane();
  try {
    const r = verify(repo, slug, ["--cmd", "true", "--cmd", "echo ok"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2/2 passed — PASS");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(b): a failing step forces exit 1 (no PIPESTATUS masking) + verbatim tail", () => {
  const { repo, slug } = mkLane();
  try {
    const r = verify(repo, slug, ["--cmd", "true", "--cmd", "echo boom >&2; exit 5"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL (exit 5)");
    expect(r.stdout).toContain("boom"); // verbatim failure output surfaced
    expect(r.stdout).toContain("1/2 passed — FAIL");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(b): --json emits a machine verdict alongside the human summary", () => {
  const { repo, slug } = mkLane();
  try {
    const r = verify(repo, slug, ["--cmd", "exit 3", "--json"]);
    expect(r.code).toBe(1);
    const jsonLine = r.stdout.trim().split("\n").find((l) => l.startsWith("{"));
    expect(jsonLine).toBeDefined();
    const j = JSON.parse(jsonLine!);
    expect(j.verdict).toBe("FAIL");
    expect(j.failed).toBe(1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
