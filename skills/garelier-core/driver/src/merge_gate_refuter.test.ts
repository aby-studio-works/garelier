import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

// End-to-end integration test for the W-066 refuter gate in merge-gate.sh: the
// opt-in adversarial-verify layer on top of the Observer verdict. Drives the
// actual merge-gate.sh against a real temp git repo (like
// merge_gate_empty_merge.test.ts) and reads the result JSON, pinning the four
// behaviors the deliverable calls out:
//   - refuter UPHELD           → merge proceeds, no advisory warning
//   - refuter REFUTED          → merge HELD (status failed), studio unchanged
//   - refuter absent + high-stakes → merge proceeds + advisory warning recorded
//   - refuter absent + low-stakes  → merge proceeds, behavior unchanged (no warn)

const MERGE_GATE = join(import.meta.dir, "..", "..", "scripts", "merge-gate.sh");
const PM = "tpm";
const STUDIO = `garelier/t/${PM}/studio`;
const WB = `garelier/t/${PM}/workbench/#1/x`;
// merge-gate.sh spawns bun (parse/prune + the high-stakes read); generous budget.
const T = 90_000;

type Run = { code: number; stdout: string; stderr: string };
function run(cwd: string, cmd: string): Run {
  const r = spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", env: process.env });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let repo: string;
afterEach(() => { try { rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } }, T);

function writeIn(rel: string, content: string) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

// A real (non-empty) workbench→studio merge with a passing quality gate. Extra
// request fields (refuter_verdict / high_stakes / …) are merged into the JSON.
function setup(extra: Record<string, unknown>) {
  repo = mkdtempSync(join(tmpdir(), "garelier-mg-refuter-"));
  run(repo, "git init -q");
  run(repo, "git config user.email ci@ci && git config user.name ci && git config commit.gpgsign false");
  run(repo, `git checkout -q -b ${STUDIO}`);
  writeIn("base.txt", "base\n");
  run(repo, "git add -A && git commit -q -m base");
  run(repo, `git checkout -q -b ${WB}`);
  writeIn("feature.txt", "feature\n");
  run(repo, "git add -A && git commit -q -m feature");
  run(repo, `git checkout -q ${STUDIO}`);
  const reqDir = `__garelier/${PM}/runtime/merge_gate/requests`;
  const req = {
    request_id: "req1",
    workbench_branch: WB,
    studio_branch: STUDIO,
    target_root: repo,
    quality_gate_commands: ["true"], // passing gate
    merge_message: "merge x into studio",
    ...extra,
  };
  writeIn(join(reqDir, "req1.json"), JSON.stringify(req, null, 2));
  return join(repo, reqDir, "req1.json");
}

function result(): Record<string, unknown> {
  const p = join(repo, `__garelier/${PM}/runtime/merge_gate/results/req1.json`);
  expect(existsSync(p)).toBe(true);
  return JSON.parse(readFileSync(p, "utf8"));
}

describe("merge-gate.sh refuter gate (W-066)", () => {
  test("refuter UPHELD → merge proceeds, no advisory warning", () => {
    const reqPath = setup({ refuter_verdict: "UPHELD" });
    const r = run(repo, `bash '${MERGE_GATE}' '${reqPath}'`);
    expect(r.code).toBe(0);
    const res = result();
    expect(res.status).toBe("success");
    expect(res.refuter_warning).toBeNull();
  }, T);

  test("refuter REFUTED → merge HELD (failed), studio not advanced", () => {
    const reqPath = setup({ refuter_verdict: "REFUTED" });
    const studioBefore = run(repo, `git rev-parse ${STUDIO}`).stdout.trim();
    run(repo, `bash '${MERGE_GATE}' '${reqPath}'`);
    const res = result();
    expect(res.status).toBe("failed");
    expect(String(res.failure_reason)).toContain("REFUTED");
    // The gate exits before step 1 — studio must not have advanced.
    expect(run(repo, `git rev-parse ${STUDIO}`).stdout.trim()).toBe(studioBefore);
  }, T);

  test("refuter absent + high-stakes flag → merge proceeds + advisory warning recorded", () => {
    const reqPath = setup({ high_stakes: true }); // no refuter_verdict
    const r = run(repo, `bash '${MERGE_GATE}' '${reqPath}'`);
    expect(r.code).toBe(0);
    const res = result();
    expect(res.status).toBe("success"); // advisory is NON-blocking
    expect(String(res.refuter_warning)).toContain("without a refuter verdict");
  }, T);

  test("refuter absent + low-stakes → merge proceeds, behavior unchanged (no warn)", () => {
    const reqPath = setup({}); // no refuter_verdict, no high_stakes
    const r = run(repo, `bash '${MERGE_GATE}' '${reqPath}'`);
    expect(r.code).toBe(0);
    const res = result();
    expect(res.status).toBe("success");
    expect(res.refuter_warning).toBeNull();
  }, T);
});
