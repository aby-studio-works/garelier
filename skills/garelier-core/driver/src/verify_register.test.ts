import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  parseRegister,
  verifyCommit,
  verifyTag,
  verifyBranch,
  verifyWorktreeClean,
  verifyGate,
  parseArgs,
  runVerification,
  summarize,
} from "../../scripts/verify_register.ts";

// W-059: the register claim verifier. The 2026-07-13 incident (v2.11.3 + #277)
// had a producer report 3 FABRICATED commit SHAs, a non-existent tag, and a gate
// PASS the verdict file did not support. These pin that a fabricated register
// FAILs mechanically while a truthful one passes.

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "verify_register.ts");
const tmps: string[] = [];
afterEach(() => { for (const d of tmps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } });

// A real repo with 2 commits on main and an annotated tag on HEAD.
function mkRepo(): { repo: string; c1: string; head: string; tag: string } {
  const repo = mkdtempSync(join(tmpdir(), "garelier-vr-"));
  tmps.push(repo);
  const g = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  g("init", "-q");
  g("config", "user.email", "ci@ci");
  g("config", "user.name", "ci");
  g("symbolic-ref", "HEAD", "refs/heads/main");
  writeFileSync(join(repo, "a.txt"), "one\n");
  g("add", "-A"); g("commit", "-qm", "c1");
  const c1 = g("rev-parse", "HEAD");
  writeFileSync(join(repo, "b.txt"), "two\n");
  g("add", "-A"); g("commit", "-qm", "c2");
  const head = g("rev-parse", "HEAD");
  g("tag", "-a", "v1.0.0", "-m", "release v1.0.0");
  return { repo, c1, head, tag: "v1.0.0" };
}

const BOGUS = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // 40 hex, never a real object

describe("verifyCommit", () => {
  test("a real commit passes; a fabricated SHA fails", () => {
    const { repo, c1 } = mkRepo();
    expect(verifyCommit(repo, c1, "cli").severity).toBe("pass");
    expect(verifyCommit(repo, BOGUS, "cli").severity).toBe("fail");
  });
  test("a short prefix of a real commit still resolves (pass)", () => {
    const { repo, head } = mkRepo();
    expect(verifyCommit(repo, head.slice(0, 8), "cli").severity).toBe("pass");
  });
});

describe("verifyTag", () => {
  test("an existing tag passes; a non-existent one fails", () => {
    const { repo } = mkRepo();
    expect(verifyTag(repo, "v1.0.0", null, "cli").severity).toBe("pass");
    expect(verifyTag(repo, "v9.9.9", null, "cli").severity).toBe("fail");
  });
  test("a tag with the correct target commit passes; a wrong target fails", () => {
    const { repo, head, c1 } = mkRepo();
    expect(verifyTag(repo, "v1.0.0", head, "cli").severity).toBe("pass"); // annotated tag peels to HEAD
    expect(verifyTag(repo, "v1.0.0", c1, "cli").severity).toBe("fail");   // claims wrong commit
    expect(verifyTag(repo, "v1.0.0", BOGUS, "cli").severity).toBe("fail");
  });
});

describe("verifyBranch", () => {
  test("the branch tip matching the claimed SHA passes; a wrong SHA fails", () => {
    const { repo, head, c1 } = mkRepo();
    expect(verifyBranch(repo, "main", head, "cli").severity).toBe("pass");
    expect(verifyBranch(repo, "main", c1, "cli").severity).toBe("fail");
  });
  test("a missing branch is a hard FAIL from the CLI, a soft WARN from a register", () => {
    const { repo } = mkRepo();
    expect(verifyBranch(repo, "garelier/x/y/workbench/#1/gone", null, "cli").severity).toBe("fail");
    // merged workbench branches are legitimately deleted -> register absence warns.
    expect(verifyBranch(repo, "garelier/x/y/workbench/#1/gone", null, "register").severity).toBe("warn");
  });
});

describe("verifyWorktreeClean", () => {
  test("a clean repo passes; an untracked file makes it fail", () => {
    const { repo } = mkRepo();
    expect(verifyWorktreeClean(repo, "cli").severity).toBe("pass");
    writeFileSync(join(repo, "untracked.txt"), "x\n");
    expect(verifyWorktreeClean(repo, "cli").severity).toBe("fail");
  });
  test("a non-existent path fails", () => {
    expect(verifyWorktreeClean(join(tmpdir(), "garelier-vr-does-not-exist-xyz"), "cli").severity).toBe("fail");
  });
});

describe("verifyGate", () => {
  test("a verdict file containing the claimed verdict passes; a mismatch or missing file fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "garelier-vr-gate-"));
    tmps.push(dir);
    const f = join(dir, "guardian_report.md");
    writeFileSync(f, "# Gate verdict\n\nverdict: PASS\n\nno leaks found.\n");
    expect(verifyGate(f, "PASS", "cli").severity).toBe("pass");
    // the incident class: register claims PASS but the file says BLOCK.
    writeFileSync(f, "# Gate verdict\n\nverdict: BLOCK\n\nsecret leaked.\n");
    expect(verifyGate(f, "PASS", "cli").severity).toBe("fail");
    expect(verifyGate(join(dir, "never_written.md"), "PASS", "cli").severity).toBe("fail");
  });
});

describe("parseRegister", () => {
  test("label-gated extraction of SHAs, tags, and branch refs", () => {
    const text = [
      "# Completion Report",
      "- Last commit: 1111111111111111111111111111111111111111",
      "- Branch: `garelier/main/aby/workbench/#7/thing`",
      "Source: garelier/main/studio (2222222222222222222222222222222222222222)",
      "Final target SHA: 3333333333333333333333333333333333333333",
      '  "commits": ["4444444444444444444444444444444444444444"],',
      "- Tag name (if any): `v2.11.3`",
      "Just prose mentioning deadbeef without a commit label should be ignored.",
      "- Branch: main-without-slash-ignored",
    ].join("\n");
    const p = parseRegister(text);
    expect(p.shas.sort()).toEqual([
      "1111111111111111111111111111111111111111",
      "2222222222222222222222222222222222222222",
      "3333333333333333333333333333333333333333",
      "4444444444444444444444444444444444444444",
    ]);
    expect(p.tags).toContain("v2.11.3");
    expect(p.branches).toContain("garelier/main/aby/workbench/#7/thing");
    // a bare word after "Branch:" (no slash) is not treated as a ref claim.
    expect(p.branches).not.toContain("main-without-slash-ignored");
    // template placeholders and unlabeled prose hex do not become claims.
    expect(p.shas).not.toContain("deadbeef");
  });
  test("ignores {{template}} placeholders", () => {
    const p = parseRegister("- Last commit: {{commit_sha}}\n- Tag name: {{version}}\n");
    expect(p.shas).toEqual([]);
    expect(p.tags).toEqual([]);
  });
});

describe("runVerification — end-to-end register", () => {
  test("a fabricated register (bad SHA + non-existent tag) FAILs", () => {
    const { repo } = mkRepo();
    const dir = mkdtempSync(join(tmpdir(), "garelier-vr-reg-"));
    tmps.push(dir);
    const reg = join(dir, "report.md");
    writeFileSync(reg, [
      "# Completion Report",
      `- Last commit: ${BOGUS}`,
      "- Tag name (if any): `v9.9.9`",
    ].join("\n"));
    const results = runVerification({
      repo, commits: [], tags: [], branches: [], worktrees: [], gates: [], register: reg, format: "text",
    });
    const sum = summarize(results);
    expect(sum.ok).toBe(false);
    expect(sum.fail).toBeGreaterThanOrEqual(2); // bogus commit + bogus tag
  });
  test("a truthful register passes (ok)", () => {
    const { repo, head, tag } = mkRepo();
    const dir = mkdtempSync(join(tmpdir(), "garelier-vr-reg2-"));
    tmps.push(dir);
    const reg = join(dir, "report.md");
    writeFileSync(reg, [
      "# Completion Report",
      `- Last commit: ${head}`,
      `- Tag name (if any): \`${tag}\``,
    ].join("\n"));
    const sum = summarize(runVerification({
      repo, commits: [], tags: [], branches: [], worktrees: [], gates: [], register: reg, format: "text",
    }));
    expect(sum.ok).toBe(true);
    expect(sum.fail).toBe(0);
  });
});

describe("parseArgs", () => {
  test("parses repeatable claim flags and format", () => {
    const a = parseArgs(["--repo", "/r", "--commit", "aaa", "--commit", "bbb",
      "--tag", "v1=ccc", "--branch", "main=ddd", "--worktree-clean", "/w",
      "--gate", "g.md=PASS", "--register", "r.md", "--format", "json"]);
    expect(a.repo).toBe("/r");
    expect(a.commits).toEqual(["aaa", "bbb"]);
    expect(a.tags).toEqual(["v1=ccc"]);
    expect(a.branches).toEqual(["main=ddd"]);
    expect(a.worktrees).toEqual(["/w"]);
    expect(a.gates).toEqual(["g.md=PASS"]);
    expect(a.register).toBe("r.md");
    expect(a.format).toBe("json");
  });
  test("an unknown flag throws (usage error)", () => {
    expect(() => parseArgs(["--nope"])).toThrow();
  });
});

// ── CLI exit codes (the PM's one-command gate) ────────────────────────────────
function runCli(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { windowsHide: true, encoding: "utf8", timeout: 20000 });
}

describe("verify_register CLI exit codes", () => {
  // Each spawns a cold `bun` per run on top of a fresh git repo — generous
  // timeouts so the child-process cold start never flakes the gate.
  test("a real commit -> exit 0; a fabricated commit -> exit 1", () => {
    const { repo, head } = mkRepo();
    expect(runCli(["--repo", repo, "--commit", head]).status).toBe(0);
    const bad = runCli(["--repo", repo, "--commit", BOGUS]);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain("FAIL");
  }, 30000);
  test("no claims -> usage error exit 2", () => {
    const { repo } = mkRepo();
    expect(runCli(["--repo", repo]).status).toBe(2);
  }, 30000);
  test("--format json emits a machine record with ok=false on a fabricated tag", () => {
    const { repo } = mkRepo();
    const r = runCli(["--repo", repo, "--tag", "v9.9.9", "--format", "json"]);
    expect(r.status).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.summary.fail).toBeGreaterThanOrEqual(1);
  }, 30000);
});
