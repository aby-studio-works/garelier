import { rmSync } from "../guard/path_guard.ts";
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { w054LandedOutcome } from "./merge_gate_landed.ts";

// Drive the W-054 landed-check against REAL git repos, the same three states the
// merge_gate_landed_check.test.ts parity oracle pins.
function mkRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mg-landed-"));
  const g = (args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  g(["init", "-q", "-b", "studio"]);
  g(["config", "user.email", "ci@ci"]);
  g(["config", "user.name", "t"]);
  writeFileSync(join(repo, "base.txt"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "init"]);
  return repo;
}

function gitAt(repo: string) {
  return (args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...args], { windowsHide: true, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode, stdout: r.stdout?.toString() ?? "" };
  };
}

test("W-054: merge already landed -> success + landed commit", () => {
  const repo = mkRepo();
  try {
    const g = gitAt(repo);
    g(["checkout", "-q", "-b", "workbench/land-ok"]);
    writeFileSync(join(repo, "feat.txt"), "feat\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: land-ok"]);
    g(["checkout", "-q", "studio"]);
    g(["merge", "--no-ff", "-m", "merge workbench/land-ok", "workbench/land-ok", "-q"]);
    const head = g(["rev-parse", "HEAD"]).stdout.trim();
    const o = w054LandedOutcome("workbench/land-ok", g);
    expect(o.status).toBe("success");
    expect(o.commit).toBe(head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-054: merge not landed -> aborted (negative control)", () => {
  const repo = mkRepo();
  try {
    const g = gitAt(repo);
    g(["checkout", "-q", "-b", "workbench/not-landed"]);
    writeFileSync(join(repo, "feat.txt"), "feat\n");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "feat: not-landed"]);
    g(["checkout", "-q", "studio"]);
    const o = w054LandedOutcome("workbench/not-landed", g);
    expect(o.status).toBe("aborted");
    expect(o.commit).toBe("");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("W-054: no workbench branch resolved -> aborted (fail closed)", () => {
  const repo = mkRepo();
  try {
    const o = w054LandedOutcome("", gitAt(repo));
    expect(o.status).toBe("aborted");
    expect(o.commit).toBe("");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
