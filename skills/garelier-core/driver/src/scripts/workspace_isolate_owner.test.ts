import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W-095 (d) — owner lock. Drives workspace_isolate.ts against a REAL throwaway
// repo and pins: an --owner isolate records owner+timestamp in the lane meta;
// --owner-of reports held/free with the right exit code; a second isolate for a
// held slug is refused AND names the recorded owner (the d1/d2 near-miss the
// lock exists to prevent). The pre-existing workspace_isolate.test.sh (the
// dirty-collect guard) is left untouched — this only adds the owner surface.

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "workspace_isolate.ts");

function git(repo: string, args: string[]): string {
  return Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" }).stdout?.toString() ?? "";
}

function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "wi-owner-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ci@ci"]);
  git(repo, ["config", "user.name", "ci"]);
  mkdirSync(join(repo, "__garelier", "_workshop"), { recursive: true });
  writeFileSync(join(repo, "f.txt"), "base\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  return repo;
}

function wi(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", SCRIPT, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

test("W-095(d): owner-of reports FREE (exit 0) before any lane exists", () => {
  const repo = mkRepo();
  try {
    const r = wi(["--owner-of", "--repo", repo, "--slug", "demo"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.held).toBe(false);
    expect(j.owner).toBe("");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(d): --owner records owner+timestamp in lane meta", () => {
  const repo = mkRepo();
  try {
    const iso = wi(["--repo", repo, "--slug", "demo", "--owner", "ga-worker-alice"]);
    expect(iso.code).toBe(0);
    const meta = JSON.parse(readFileSync(join(repo, "__garelier", "_workshop", "_crew", "lanes", ".meta", "demo.json"), "utf8"));
    expect(meta.base).toBe("main"); // stays FIRST so collect's regex is unaffected
    expect(meta.owner).toBe("ga-worker-alice");
    expect(meta.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(d): owner-of reports HELD (exit 2) once the lane exists", () => {
  const repo = mkRepo();
  try {
    wi(["--repo", repo, "--slug", "demo", "--owner", "ga-worker-alice"]);
    const r = wi(["--owner-of", "--repo", repo, "--slug", "demo"]);
    expect(r.code).toBe(2);
    const j = JSON.parse(r.stdout);
    expect(j.held).toBe(true);
    expect(j.owner).toBe("ga-worker-alice");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(d): a second isolate on a held slug is refused AND names the owner", () => {
  const repo = mkRepo();
  try {
    wi(["--repo", repo, "--slug", "demo", "--owner", "ga-worker-alice"]);
    const second = wi(["--repo", repo, "--slug", "demo", "--owner", "ga-worker-bob"]);
    expect(second.code).toBe(2);
    expect(second.stderr).toContain("already exists");
    expect(second.stderr).toContain("ga-worker-alice"); // the collision names the culprit
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(d): meta with NO --owner keeps collect working (owner is empty, no false lock)", () => {
  const repo = mkRepo();
  try {
    const iso = wi(["--repo", repo, "--slug", "demo"]);
    expect(iso.code).toBe(0);
    const meta = JSON.parse(readFileSync(join(repo, "__garelier", "_workshop", "_crew", "lanes", ".meta", "demo.json"), "utf8"));
    expect(meta.owner).toBe("");
    // owner-of on an ownerless-but-held lane still reports held with empty owner.
    const own = wi(["--owner-of", "--repo", repo, "--slug", "demo"]);
    expect(own.code).toBe(2);
    expect(JSON.parse(own.stdout).owner).toBe("");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-102: one PM namespace is auto-detected and the contained path is excluded", () => {
  const repo = mkRepo();
  try {
    const iso = wi(["--repo", repo, "--slug", "auto-pm"]);
    expect(iso.code).toBe(0);
    expect(JSON.parse(iso.stdout).worktree.replace(/\\/g, "/"))
      .toEndWith("/__garelier/_workshop/_crew/lanes/auto-pm");
    const exclude = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("__garelier/*/_crew/lanes/");
    expect(exclude).not.toContain(".garelier-work/");

    writeFileSync(join(repo, ".git", "info", "exclude"), `${exclude}.garelier-work/\n`);
    expect(wi(["--repo", repo, "--slug", "preserve-legacy"]).code).toBe(0);
    expect(readFileSync(join(repo, ".git", "info", "exclude"), "utf8")).toContain(".garelier-work/");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-102: zero or multiple PM candidates require explicit --pm-id", () => {
  const none = mkRepo();
  const many = mkRepo();
  try {
    rmSync(join(none, "__garelier"), { recursive: true, force: true });
    const zero = wi(["--repo", none, "--slug", "needs-pm"]);
    expect(zero.code).toBe(2);
    expect(zero.stderr).toContain("--pm-id is required");
    const explicit = wi(["--repo", none, "--slug", "explicit-pm", "--pm-id", "alice"]);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.stdout).worktree.replace(/\\/g, "/"))
      .toEndWith("/__garelier/alice/_crew/lanes/explicit-pm");

    mkdirSync(join(many, "__garelier", "alice"), { recursive: true });
    const multiple = wi(["--repo", many, "--slug", "needs-pm"]);
    expect(multiple.code).toBe(2);
    expect(multiple.stderr).toContain("_workshop, alice");
  } finally {
    rmSync(none, { recursive: true, force: true });
    rmSync(many, { recursive: true, force: true });
  }
});
