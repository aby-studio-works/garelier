import { rmSync } from "./guard/path_guard.ts";
import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// W-076: anchor auto-fire. A completed merge (merge-gate.ts) and a completed
// dispatch_cleanup are task_mirror refresh anchors (DEC-092), so each emits a
// copyable `task_mirror --format ops` command in its result — the PM applies it
// instead of hand-crafting the session Task list. These integration tests pin
// that the hint rides the gate SUCCESS result + the cleanup JSON, and that a
// non-success gate does NOT carry it (success-only). A companion doc-pin asserts
// the unified anchor protocol in pm_playbook §11.

const SCRIPTS = join(import.meta.dir, "scripts");
const MERGE_GATE = join(SCRIPTS, "merge-gate.ts");
const CLEANUP = join(SCRIPTS, "dispatch_cleanup.ts");
const PLAYBOOK = join(import.meta.dir, "..", "..", "references", "pm_playbook.md");
const PM = "tpm";
const STUDIO = `garelier/t/${PM}/studio`;
const WB = `garelier/t/${PM}/workbench/#1/x`;
// The scripts spawn bun (parse/prune/heavy_compile_lock); give a generous budget.
const T = 90_000;

type Run = { code: number; stdout: string; stderr: string };
function run(cwd: string, cmd: string): Run {
  const r = spawnSync("bash", ["-c", cmd], { windowsHide: true, cwd, encoding: "utf8", env: process.env });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let repo: string;
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } }, T);

function writeIn(rel: string, content: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// A minimal project + git repo with a studio and a distinct workbench branch.
function baseRepo() {
  repo = mkdtempSync(join(tmpdir(), "garelier-anchor-"));
  run(repo, "git init -q");
  run(repo, "git config user.email ci@ci && git config user.name ci && git config commit.gpgsign false");
  run(repo, `git checkout -q -b ${STUDIO}`);
  writeIn("base.txt", "base\n");
  run(repo, "git add -A && git commit -q -m base");
  run(repo, `git checkout -q -b ${WB}`);
  writeIn("feature.txt", "feature\n");
  run(repo, "git add -A && git commit -q -m feature");
  run(repo, `git checkout -q ${STUDIO}`);
}

function mergeRequest(gateCmd: string): string {
  const reqDir = `__garelier/${PM}/runtime/merge_gate/requests`;
  const req = {
    request_id: "req1",
    workbench_branch: WB,
    studio_branch: STUDIO,
    target_root: repo,
    quality_gate_commands: [gateCmd],
    merge_message: `merge x into studio`,
  };
  writeIn(join(reqDir, "req1.json"), JSON.stringify(req, null, 2));
  return join(repo, reqDir, "req1.json");
}

function mergeResult(): Record<string, unknown> {
  const p = join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.json`);
  expect(existsSync(p)).toBe(true);
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("merge-gate.ts task_mirror anchor hint (W-076)", () => {
  test("a SUCCESS result carries a copyable task_mirror ops command", () => {
    baseRepo();
    const reqPath = mergeRequest("true"); // gate passes -> real merge succeeds
    const r = run(repo, `bun '${MERGE_GATE}' '${reqPath}'`);
    expect(r.code).toBe(0);
    const res = mergeResult();
    expect(res.status).toBe("success");
    const hint = res.task_mirror_hint as string;
    expect(typeof hint).toBe("string");
    expect(hint).toContain("task_mirror.ts");
    expect(hint).toContain(`--pm-id ${PM}`);
    expect(hint).toContain("--project");
    expect(hint).toContain("--format ops");
    // The summary JSON carries it too (same success-only rule).
    const sum = JSON.parse(readFileSync(
      join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.summary.json`), "utf8"));
    expect(sum.task_mirror_hint).toBe(hint);
  }, T);

  test("a FAILED result does NOT carry the hint (success-only)", () => {
    baseRepo();
    const reqPath = mergeRequest("exit 1"); // gate fails -> merge fails
    run(repo, `bun '${MERGE_GATE}' '${reqPath}'`);
    const res = mergeResult();
    expect(res.status).toBe("failed");
    expect(res.task_mirror_hint).toBeUndefined();
  }, T);
});

describe("dispatch_cleanup.ts task_mirror anchor hint (W-076)", () => {
  test("the cleanup JSON carries a copyable task_mirror ops command", () => {
    baseRepo();
    // Stand up a _dispatch1 container worktree on the workbench branch, then
    // clean it up (worktree-only — no --delete-branch, so the merged-guard is inert).
    const container = `__garelier/${PM}/_dispatch1`;
    mkdirSync(join(repo, container), { recursive: true });
    expect(run(repo, `git worktree add '${container}/checkout' ${WB}`).code).toBe(0);
    const r = run(repo, `bun '${CLEANUP}' --project '${repo}' --pm-id ${PM} --id 1`);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    const hint = out.task_mirror_hint as string;
    expect(typeof hint).toBe("string");
    expect(hint).toContain("task_mirror.ts");
    expect(hint).toContain(`--pm-id ${PM}`);
    expect(hint).toContain(`--project ${repo}`);
    expect(hint).toContain("--format ops");
  }, T);
});

describe("pm_playbook §11 unified anchor protocol (W-076 doc pin)", () => {
  test("§11 defines the single anchor bundle + the hand-craft hot-rule", () => {
    const doc = readFileSync(PLAYBOOK, "utf8");
    // Retitled to the unified anchor protocol.
    expect(doc).toContain("## 11. anchor protocol");
    // All four anchors are rows of ONE table.
    expect(doc).toContain("| merge 完了 |");
    expect(doc).toContain("| cleanup 完了 |");
    // The bundle names its two scans.
    expect(doc).toContain("task_mirror --format ops");
    expect(doc).toContain("contract_check --stall-scan");
    // The hand-craft-forbidden hot-rule (DEC-092).
    expect(doc).toContain("hand-craft 禁止、DEC-092");
    // The result/cleanup JSON hint is referenced as the copyable command.
    expect(doc).toContain("task_mirror_hint");
  });
});
