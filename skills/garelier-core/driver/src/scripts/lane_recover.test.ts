import { rmSync } from "../guard/path_guard.ts";
import { test, expect, setDefaultTimeout } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// W-095 (e) — read-only state summary for an idle-without-register lane. Pins the
// disposition heuristic across the three states the PM otherwise hand-diagnoses.

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const RECOVER = join(SCRIPTS, "lane_recover.ts");
const DISPATCH = join(SCRIPTS, "lane_dispatch.ts");
setDefaultTimeout(60_000);

function git(repo: string, args: string[]): void {
  Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
}

function bun(script: string, args: string[]): { code: number; stdout: string } {
  const r = Bun.spawnSync(["bun", script, ...args], { windowsHide: true, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout?.toString() ?? "" };
}

function mkLane(): { repo: string; wt: string } {
  const repo = mkdtempSync(join(tmpdir(), "lane-rc-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "ci@ci"]);
  git(repo, ["config", "user.name", "ci"]);
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, ["add", "-A"]);
  git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
  bun(DISPATCH, ["--repo", repo, "--slug", "lane", "--row", "W-9", "--pm-id", "_workshop", "--owner", "bob"]);
  return { repo, wt: join(repo, "__garelier", "_workshop", "_crew", "lanes", "lane") };
}

function recover(repo: string): any {
  const r = bun(RECOVER, ["--repo", repo, "--slug", "lane", "--json"]);
  const line = r.stdout.trim().split("\n").find((l) => l.startsWith("{"));
  return { code: r.code, stdout: r.stdout, json: line ? JSON.parse(line) : undefined };
}

test("W-095(e): EMPTY lane (fresh, no commits) -> disposition EMPTY, owner/row surfaced", () => {
  const { repo } = mkLane();
  try {
    const r = recover(repo);
    expect(r.code).toBe(0);
    expect(r.json.owner).toBe("bob");
    expect(r.json.row).toBe("W-9");
    expect(r.json.ahead).toBe(0);
    expect(r.json.disposition).toContain("EMPTY");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(e): committed + clean -> COMMITTED-IDLE", () => {
  const { repo, wt } = mkLane();
  try {
    writeFileSync(join(wt, "a.txt"), "a\n");
    git(wt, ["add", "-A"]);
    git(wt, ["-c", "commit.gpgsign=false", "commit", "-qm", "feat: a [W-9]"]);
    const r = recover(repo);
    expect(r.json.ahead).toBe(1);
    expect(r.json.dirty).toBe(0);
    expect(r.json.disposition).toContain("COMMITTED-IDLE");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(e): uncommitted edits -> MID-EDIT (do not collect)", () => {
  const { repo, wt } = mkLane();
  try {
    writeFileSync(join(wt, "wip.txt"), "wip\n");
    const r = recover(repo);
    expect(r.json.dirty).toBe(1);
    expect(r.json.disposition).toContain("MID-EDIT");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-095(e): no lane at all -> exit 2 (nothing to recover)", () => {
  const repo = mkdtempSync(join(tmpdir(), "lane-rc0-"));
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "ci@ci"]);
    git(repo, ["config", "user.name", "ci"]);
    writeFileSync(join(repo, "seed.txt"), "seed\n");
    git(repo, ["add", "-A"]);
    git(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
    const r = bun(RECOVER, ["--repo", repo, "--slug", "lane"]);
    expect(r.code).toBe(2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
